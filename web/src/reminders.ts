// Alerts on phones and browsers (push.ts), from the server: a Cloudflare
// cron runs this every minute. It does what the desktop app's alert loop
// does (src-tauri/src/alerts.rs, leave.rs), so an alert comes to the phone
// and the Mac alike:
//
// - an event's reminders ("10 minutes before") and exact-time alerts;
// - "before leaving" alerts, from the drive time in traffic (routes.ts, with
//   its caps and cache), starting from the address in Settings.
//
// Each minute fetches the next few days afresh, so a change made a moment
// ago counts. Alerts further ahead (a reminder a week before) come from a
// look every 30 minutes (a cron of its own, so a slow one can't hold up the
// minute's alerts), kept until the next one: the free plan allows about
// 1,000 writes a day, and that's under 50. A run that's missed (rare) means
// its alerts are missed, rather than sent late.
import type { AgendaItem, LeaveQuery } from "../../src/api";
import { isPhysical } from "../../src/routes-budget";
import { load } from "./agenda";
import { decrypt, encrypt } from "./crypto";
import type { Env } from "./env";
import { type PushSubscription, readSubscriptions, sendToAll } from "./push";
import { leaveTimes } from "./routes";
import { addDays, dayOf, midnight } from "./zone";

const MINUTE = 60_000;
/** Fetched every minute: yesterday to this many days ahead. */
const NEAR_DAYS = 3;
/** Looked at every 30 minutes, for alerts long before their events (Google's longest reminder is 4 weeks). */
const FAR_DAYS = 29;
const FAR_EVERY = 30 * MINUTE;
/** "Before leaving" alerts are worked out for events this soon (as on the desktop). */
const LEAVE_HORIZON = 3 * 60 * MINUTE;
const UPCOMING = "pushUpcoming";

/** An alert: when, and what it says (its times in each browser's zone). */
interface Due {
  key: string;
  at: number;
  title: string;
  /** The event's start (ISO, or a day for an all-day one). */
  start: string;
  allDay: boolean;
  location: string | null;
  /** Minutes before the start (0: at it). */
  minutes: number;
  /** A "before leaving" alert: the drive, the time to leave and the buffer. */
  leave?: { drive: number; leaveAt: number; buffer: number; place: string };
}

/** Sends every alert due in the minute up to `now` (the cron's time). */
export async function sendDueAlerts(env: Env, now: number): Promise<void> {
  const subs = await readSubscriptions(env);
  if (subs.length === 0) return;
  // One person's site: the most recent browser's zone decides "today".
  const zone = subs[subs.length - 1].zone;
  const ctx = { env, zone };
  const today = dayOf(new Date(now), zone);
  const from = now - MINUTE;

  const near = await load(ctx, addDays(today, -1), addDays(today, NEAR_DAYS)).catch(() => null);
  const due = new Map<string, Due>();
  for (const item of near?.items ?? []) for (const alert of triggers(item, zone)) if (alert.at > from && alert.at <= now) due.set(alert.key, alert);

  // Further ahead: from the last look (`lookAhead`, every 30 minutes).
  const upcoming = await readUpcoming(env);
  for (const alert of upcoming?.alerts ?? []) if (alert.at > from && alert.at <= now && !due.has(alert.key)) due.set(alert.key, alert);

  for (const alert of await leaveAlerts(env, near?.items ?? [], from, now)) due.set(alert.key, alert);

  for (const alert of due.values()) {
    await sendToAll(env, (sub: PushSubscription) => ({ title: alert.title, body: bodyFor(alert, sub.zone), tag: alert.key }));
  }
}

/**
 * Every 30 minutes: alerts in the next half hour for events further ahead
 * than the minute's look (a reminder a week before), kept for it to send.
 */
export async function lookAhead(env: Env, now: number): Promise<void> {
  const subs = await readSubscriptions(env);
  if (subs.length === 0) return;
  const zone = subs[subs.length - 1].zone;
  const today = dayOf(new Date(now), zone);
  const far = await load({ env, zone }, addDays(today, NEAR_DAYS - 1), addDays(today, FAR_DAYS));
  // A little past the next look, so none falls between two.
  const until = now + FAR_EVERY + 5 * MINUTE;
  const alerts = far.items.flatMap((item) => triggers(item, zone)).filter((a) => a.at > now - MINUTE && a.at <= until);
  await writeUpcoming(env, { checked: now, alerts });
}

/** An event's reminders and exact-time alerts, as alerts.rs `due` finds them. */
export function triggers(item: AgendaItem, zone: string): Due[] {
  if (item.kind !== "event") return [];
  const start = item.allDay ? midnight(item.start.slice(0, 10), zone).getTime() : Date.parse(item.start);
  if (Number.isNaN(start)) return [];
  const base = { title: item.title, start: item.start, allDay: item.allDay, location: item.location };
  const out: Due[] = item.reminders.map((minutes) => ({
    ...base,
    key: `${item.id}|${item.start}|${minutes}`,
    at: start - minutes * MINUTE,
    minutes,
  }));
  for (const at of item.alertAt ?? []) {
    const when = Date.parse(at);
    if (Number.isNaN(when)) continue;
    // One exact time on a series is the same moment for each occurrence: once.
    out.push({ ...base, key: `at|${item.seriesId ?? item.id}|${at}`, at: when, minutes: Math.max(0, Math.round((start - when) / MINUTE)) });
  }
  return out;
}

/** "Before leaving" alerts due in (from, now], for events with them soon. */
async function leaveAlerts(env: Env, items: AgendaItem[], from: number, now: number): Promise<Due[]> {
  const soon = items.filter((item) => {
    const start = Date.parse(item.start);
    return (
      item.kind === "event" &&
      !item.allDay &&
      (item.leaveAlerts?.length ?? 0) > 0 &&
      !!item.location &&
      isPhysical(item.location) &&
      start > now &&
      start - now <= LEAVE_HORIZON
    );
  });
  if (soon.length === 0) return [];
  const queries: LeaveQuery[] = soon.map((item) => ({ id: item.id, start: item.start, location: item.location!, leaveFrom: item.leaveFrom ?? null }));
  const estimates = await leaveTimes(env, queries).catch(() => []);
  const out: Due[] = [];
  for (const item of soon) {
    const estimate = estimates.find((e) => e.id === item.id);
    if (!estimate || estimate.status !== "ok" || estimate.minutes === null || !estimate.leaveAt) continue;
    const leaveAt = Date.parse(estimate.leaveAt);
    for (const buffer of item.leaveAlerts ?? []) {
      const at = leaveAt - buffer * MINUTE;
      if (at > from && at <= now) {
        out.push({
          key: `leave|${item.id}|${item.start}|${buffer}`,
          at,
          title: `Time to leave for ${item.title}`,
          start: item.start,
          allDay: false,
          location: item.location,
          minutes: 0,
          leave: { drive: estimate.minutes, leaveAt, buffer, place: item.location! },
        });
      }
    }
  }
  return out;
}

/** What an alert says, its times in `zone`: as alerts.rs `alert_text` and leave.rs. */
export function bodyFor(alert: Due, zone: string): string {
  const time = (ms: number) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(ms);
  if (alert.leave) {
    const { drive, leaveAt, buffer, place } = alert.leave;
    const spare = buffer === 0 ? "" : ` · ${buffer} min to spare`;
    return `${drive} min drive · leave by ${time(leaveAt)}${spare} · starts ${time(Date.parse(alert.start))} · ${place}`;
  }
  const m = alert.minutes;
  const when = m === 0 ? "Now" : m < 60 ? `In ${m} min` : `In ${hours(m)}`;
  const at = alert.allDay
    ? new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(
        Date.parse(`${alert.start.slice(0, 10)}T12:00:00Z`),
      )
    : time(Date.parse(alert.start));
  return [when, at, alert.location].filter(Boolean).join(" · ");
}

/** "1 week", "2 days", "1 h 30 min", as alerts.rs `format_hours`. */
function hours(minutes: number): string {
  const [week, day] = [7 * 24 * 60, 24 * 60];
  if (minutes >= week && minutes % week === 0) return minutes === week ? "1 week" : `${minutes / week} weeks`;
  if (minutes % day === 0) return minutes === day ? "1 day" : `${minutes / day} days`;
  const [h, rest] = [Math.floor(minutes / 60), minutes % 60];
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

interface Upcoming {
  checked: number;
  alerts: Due[];
}

async function readUpcoming(env: Env): Promise<Upcoming | null> {
  const value = await env.STORE.get(UPCOMING);
  if (!value) return null;
  try {
    return JSON.parse(await decrypt(env, value)) as Upcoming;
  } catch {
    return null;
  }
}

async function writeUpcoming(env: Env, upcoming: Upcoming): Promise<void> {
  // Event names: kept encrypted, like everything else here.
  await env.STORE.put(UPCOMING, await encrypt(env, JSON.stringify(upcoming)));
}
