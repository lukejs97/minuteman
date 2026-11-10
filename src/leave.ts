// Leave-by times on events. The drive is worked out off the page: in the app
// (leave.rs) or, on the website, by the Worker. A missing key, address, or
// place stays quiet on the calendar and is explained in details.
import { isTauri } from "@tauri-apps/api/core";
import { currentLocation, getPreferences, leaveTimes, locationAccess, type AgendaItem, type LeaveEstimate, type LeaveStatus } from "./api";
import { el } from "./dom";
import { spotOrigin } from "./routes-budget";
import { itemStart } from "./time";
import { devicePosition } from "./weather";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

interface Slot {
  item: AgendaItem;
  nodes: HTMLElement[];
}

const slots = new Map<string, Slot>();
let scheduled = false;
let running = false;
let again = false;
let refreshTimer = 0;

function keyOf(item: AgendaItem): string {
  return `${item.id}|${item.start}`;
}

/** A timed event at a place that hasn't started. Virtual calls are filtered later. */
function wantsLeave(item: AgendaItem): boolean {
  return item.kind === "event" && !item.allDay && !!item.location?.trim() && itemStart(item).getTime() > Date.now();
}

/**
 * An element that fills in with "Leave by 8:40 AM" once the drive is known.
 * `null` when this event isn't one you'd travel to.
 */
export function leaveLabel(item: AgendaItem, className: string): HTMLElement | null {
  if (!wantsLeave(item)) return null;
  const node = el("span", className);
  node.hidden = true;
  const key = keyOf(item);
  const slot = slots.get(key) ?? { item, nodes: [] };
  slot.item = item;
  slot.nodes.push(node);
  slots.set(key, slot);
  schedule();
  return node;
}

/** Whether Settings says to start from where you are (read once; refresh reads it again). */
let fromHere: Promise<boolean> | null = null;
/** Where you were last found, and when: asked again after a few minutes. */
let lastSpot: { at: number; spot: string | null } | null = null;
const SPOT_MS = 5 * 60_000;

/** Where you are, as a starting point, if Settings wants that and it's known. */
async function here(): Promise<string | null> {
  fromHere ??= getPreferences().then((prefs) => !!prefs.leaveFromHere, () => false);
  if (!(await fromHere)) return null;
  if (lastSpot && Date.now() - lastSpot.at < SPOT_MS) return lastSpot.spot;
  const spot = await devicePosition().then(
    (at) => spotOrigin(at.latitude, at.longitude),
    () => null, // not allowed or not found: the address in Settings is used
  );
  lastSpot = { at: Date.now(), spot };
  return spot;
}

/**
 * Where you are, if this device is already allowed to say so. Never asks.
 * Used only to tell two streets of the same name apart, not as the start of the drive.
 */
async function quietSpot(): Promise<string | null> {
  if (lastSpot && Date.now() - lastSpot.at < SPOT_MS && lastSpot.spot) return lastSpot.spot;
  try {
    if (isTauri()) {
      if ((await locationAccess().catch(() => null)) !== "granted") return null;
      const at = await currentLocation().catch(() => null);
      if (!at) return null;
      const spot = spotOrigin(at.latitude, at.longitude);
      lastSpot = { at: Date.now(), spot };
      return spot;
    }
    if (!navigator.permissions || !navigator.geolocation) return null;
    const { state } = await navigator.permissions.query({ name: "geolocation" });
    if (state !== "granted") return null;
    const spot = await new Promise<string | null>((resolve) =>
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(spotOrigin(position.coords.latitude, position.coords.longitude)),
        () => resolve(null),
        { maximumAge: SPOT_MS, timeout: 5000 },
      ),
    );
    if (spot) lastSpot = { at: Date.now(), spot };
    return spot;
  } catch {
    return null;
  }
}

/** Asks again for whatever is on screen, e.g. after the address or key changes. */
export function refreshLeaveTimes(): void {
  fromHere = null;
  lastSpot = null;
  void flush();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void flush();
  });
}

async function flush(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await flushOnce();
    } while (again);
  } finally {
    running = false;
  }
}

async function flushOnce(): Promise<void> {
  for (const [key, slot] of slots) {
    slot.nodes = slot.nodes.filter((node) => node.isConnected);
    if (slot.nodes.length === 0) slots.delete(key);
  }
  const pending = [...slots.values()];
  if (pending.length === 0) return;
  let estimates: LeaveEstimate[] = [];
  try {
    estimates = await leaveTimes(
      pending.map((slot) => ({
        id: slot.item.id,
        start: slot.item.start,
        location: slot.item.location ?? "",
        leaveFrom: slot.item.leaveFrom ?? null,
      })),
      await here(),
      await quietSpot(),
    );
  } catch {
    return;
  }
  const byKey = new Map(estimates.map((estimate) => [`${estimate.id}|${estimate.start}`, estimate]));
  for (const slot of pending) {
    const text = formatLeave(byKey.get(keyOf(slot.item)));
    for (const node of slot.nodes) {
      if (!node.isConnected) continue;
      node.hidden = !text;
      node.textContent = text ?? "";
    }
  }
  armRefresh(estimates);
}

function armRefresh(estimates: LeaveEstimate[]): void {
  window.clearTimeout(refreshTimer);
  if ([...slots.values()].every((slot) => slot.nodes.length === 0)) return;
  const soon = estimates.some((estimate) => {
    if (!estimate.leaveAt) return false;
    return new Date(estimate.leaveAt).getTime() - Date.now() < 3 * 60 * 60 * 1000;
  });
  const failed = estimates.some((estimate) => estimate.status === "unavailable");
  // Failures are remembered for ten minutes. A soon event's traffic is
  // checked about once a minute (the answer is saved, so that's rarely a
  // new lookup); a later one can wait.
  const wait = failed ? 10 * 60_000 : soon ? 60_000 : 15 * 60_000;
  if (!failed && !estimates.some((estimate) => estimate.status === "ok")) return;
  refreshTimer = window.setTimeout(() => void flush(), wait);
}

/** "Leave by 8:40 AM", or null when there isn't a time to show. */
export function formatLeave(estimate: LeaveEstimate | undefined): string | null {
  if (!estimate || estimate.minutes == null || !estimate.leaveAt) return null;
  const when = new Date(estimate.leaveAt);
  if (Number.isNaN(when.getTime())) return null;
  const drive = estimate.minutes > 0 ? ` · ${estimate.minutes === 1 ? "1 min" : `${estimate.minutes} min`}` : "";
  return `Leave by ${timeFormat.format(when)}${drive}`;
}

/** "8:40 AM · 25 min drive", for the details popup. */
export function formatLeaveDetail(estimate: LeaveEstimate | undefined): string | null {
  if (!estimate || estimate.minutes == null || !estimate.leaveAt) return null;
  const when = new Date(estimate.leaveAt);
  if (Number.isNaN(when.getTime())) return null;
  const drive = estimate.minutes === 1 ? "1 min drive" : `${estimate.minutes} min drive`;
  const from = estimate.originLabel ? ` · from ${estimate.originLabel}` : "";
  const to = estimate.destinationLabel ? ` · to ${estimate.destinationLabel}` : "";
  const credit = from || to ? " · OpenStreetMap" : "";
  return `${timeFormat.format(when)} · ${drive}${from}${to}${credit}`;
}

/** Why details has no time, when it's something the person can fix or retry. */
export function leaveHint(status: LeaveStatus | undefined): string | null {
  switch (status) {
    case "noKey":
      return "Add a Routes API key in Settings to see when to leave.";
    case "noOrigin":
      return "Set a leave-from address in Settings, or on this event.";
    case "unavailable":
      return "Couldn't check traffic just now.";
    case "noRoute":
      return "Google couldn't find a drive to this place. Give it a full address (with the town) for a leave-by time.";
    case "tooFar":
      return "Travel time shows within two days of the event.";
    case "limited":
      return "Leave-by lookups are paused until the Routes limit resets. A drive already saved is still used.";
    case "vague":
      return "Add the town and ZIP. A street with no town can match one with the same name far away, so no leave-by time is shown.";
    default:
      return null;
  }
}

/** 550 → "9 h 10 min", 45 → "45 min". */
function hoursAndMinutes(minutes: number): string {
  const [h, m] = [Math.floor(minutes / 60), minutes % 60];
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

/** The details line for one event: the time, or a short reason, or nothing. */
export async function leaveDetail(item: AgendaItem): Promise<string | null> {
  if (!wantsLeave(item)) return null;
  try {
    const [estimate] = await leaveTimes(
      [{ id: item.id, start: item.start, location: item.location ?? "", leaveFrom: item.leaveFrom ?? null }],
      await here(),
      await quietSpot(),
    );
    // Too long to be right: Google matched an address in the wrong town.
    if (estimate?.status === "implausible" && estimate.minutes != null) {
      const from = estimate.originLabel ?? (item.leaveFrom?.trim() ? `"${item.leaveFrom.trim()}"` : "the leave-from address");
      const to = estimate.destinationLabel ? ` to ${estimate.destinationLabel}` : "";
      return `Google found a ${hoursAndMinutes(estimate.minutes)} drive from ${from}${to}, so no leave time. Add the town and ZIP. A street alone can match one with the same name far away.`;
    }
    const detail = formatLeaveDetail(estimate);
    if (detail) {
      if (estimate?.originLabel || estimate?.destinationLabel) return detail;
      const from = item.leaveFrom?.trim();
      return from ? `${detail} · from ${from}` : detail;
    }
    return leaveHint(estimate?.status);
  } catch {
    return null;
  }
}
