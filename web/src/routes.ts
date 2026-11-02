// Live travel times for the website. The Routes key stays on the Worker
// (a Cloudflare secret). Every attempt is counted with the same cap as the
// desktop app (src/routes-budget.ts, kept in step with leave.rs) before the
// request is sent, including when Google doesn't answer.
import type { LeaveEstimate, LeaveQuery, LeaveStatus } from "../../src/api";
import {
  charge,
  clampLimits,
  emptyUsage,
  firstDeparture,
  isPhysical,
  judge,
  MAX_PLAUSIBLE_DRIVE_MINUTES,
  pacificDate,
  parseDuration,
  pickOrigin,
  waypoint,
  shouldQuery,
  stillFresh,
  type Usage,
} from "../../src/routes-budget";
import type { Env } from "./env";
import { readLeaveSettings, readRoutesCache, readRoutesUsage, writeRoutesCache, writeRoutesUsage, type RouteCache } from "./store";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

function cacheKey(origin: string, destination: string, arrive: Date): string {
  const norm = (value: string) => value.trim().toLowerCase().split(/\s+/).join(" ");
  return `${norm(origin)}|${norm(destination)}|${Math.floor(arrive.getTime() / 60_000)}`;
}

async function spend(env: Env, usage: Usage, limits: { daily: number; monthly: number }): Promise<{ ok: boolean; usage: Usage }> {
  const next = charge(usage, pacificDate(new Date()), limits);
  // Persist before sending. If the save fails, do not call Google.
  try {
    await writeRoutesUsage(env, next.usage);
  } catch {
    return { ok: false, usage: next.usage };
  }
  return { ok: next.kind === "allowed", usage: next.usage };
}

async function query(key: string, origin: string, destination: string, departure: Date): Promise<number | null> {
  let response: Response;
  try {
    response = await fetch(ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.duration",
      },
      body: JSON.stringify({
        // Where you are goes as coordinates: nothing for Google to mismatch.
        origin: waypoint(origin),
        destination: { address: destination },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        departureTime: departure.toISOString().replace(/\.\d{3}Z$/, "Z"),
        computeAlternativeRoutes: false,
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { routes?: { duration?: string }[] } | null;
  const raw = body?.routes?.[0]?.duration;
  return raw ? parseDuration(raw) : null;
}

/** One drive, counting each attempt. A saved first answer is kept if the refinement is past the cap. */
async function drivingMinutes(
  env: Env,
  key: string,
  origin: string,
  destination: string,
  arrive: Date,
  now: Date,
  usage: Usage,
  limits: { daily: number; monthly: number },
): Promise<{ minutes: number | null; limited: boolean; usage: Usage }> {
  let state = usage;
  let departure = firstDeparture(now, arrive);
  let refined = false;
  let latest: number | null = null;
  for (;;) {
    const spent = await spend(env, state, limits);
    state = spent.usage;
    if (!spent.ok) return { minutes: latest, limited: latest === null, usage: state };
    const minutes = await query(key, origin, destination, departure);
    if (minutes === null) return { minutes: latest, limited: false, usage: state };
    const again = judge(departure, minutes, arrive, now, refined);
    if (again === "done") return { minutes, limited: false, usage: state };
    latest = minutes;
    departure = again;
    refined = true;
  }
}

function estimate(id: string, start: string, minutes: number | null, status: LeaveStatus): LeaveEstimate {
  // Too long to be right (an address matched in the wrong town): say so, no time.
  if (status === "ok" && minutes !== null && minutes > MAX_PLAUSIBLE_DRIVE_MINUTES) {
    return { id, start, minutes, leaveAt: null, status: "implausible" };
  }
  if (minutes === null || status !== "ok") return { id, start, minutes: null, leaveAt: null, status };
  const arrive = new Date(start);
  return { id, start, minutes, leaveAt: new Date(arrive.getTime() - minutes * 60_000).toISOString(), status: "ok" };
}

/** Leave-by times for the events on screen. The key never leaves this function. */
export async function leaveTimes(env: Env, events: LeaveQuery[], here: string | null = null): Promise<LeaveEstimate[]> {
  const settings = await readLeaveSettings(env);
  // Where the browser found you, when Settings says to start from there.
  const from = settings.leaveFromHere ? here : null;
  const limits = clampLimits(settings.routesDailyLimit, settings.routesMonthlyLimit);
  const key = env.MINUTEMAN_ROUTES_API_KEY?.trim() ?? "";
  let usage = (await readRoutesUsage(env)) ?? emptyUsage(new Date());
  const cache = await readRoutesCache(env);
  let cacheDirty = false;
  const now = new Date();
  const out: LeaveEstimate[] = [];

  for (const event of events.slice(0, 40)) {
    const id = event.id;
    const start = event.start;
    const destination = event.location ?? "";
    const origin = pickOrigin(event.leaveFrom, from, settings.leaveFrom);
    const arrive = new Date(start);
    if (!isPhysical(destination)) {
      out.push(estimate(id, start, null, "notPhysical"));
      continue;
    }
    if (Number.isNaN(arrive.getTime()) || arrive.getTime() <= now.getTime()) {
      out.push(estimate(id, start, null, Number.isNaN(arrive.getTime()) ? "unavailable" : "past"));
      continue;
    }
    if (!origin) {
      out.push(estimate(id, start, null, "noOrigin"));
      continue;
    }
    if (!key) {
      out.push(estimate(id, start, null, "noKey"));
      continue;
    }
    if (!shouldQuery(now, arrive)) {
      out.push(estimate(id, start, null, "tooFar"));
      continue;
    }
    const slot = cacheKey(origin, destination, arrive);
    const saved = cache[slot];
    if (saved && stillFresh(new Date(saved.at), now, arrive, saved.minutes === null)) {
      out.push(estimate(id, start, saved.minutes, saved.minutes === null ? "unavailable" : "ok"));
      continue;
    }
    const driven = await drivingMinutes(env, key, origin, destination, arrive, now, usage, limits);
    usage = driven.usage;
    if (driven.limited) {
      out.push(estimate(id, start, null, "limited"));
      continue;
    }
    const entry = { at: now.toISOString(), minutes: driven.minutes };
    cache[slot] = entry;
    cacheDirty = true;
    out.push(estimate(id, start, driven.minutes, driven.minutes === null ? "unavailable" : "ok"));
  }
  if (cacheDirty) await writeRoutesCache(env, prune(cache, now)).catch(() => undefined);
  return out;
}

function prune(cache: RouteCache, now: Date): RouteCache {
  const kept: RouteCache = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (now.getTime() - new Date(entry.at).getTime() < 24 * 60 * 60 * 1000) kept[key] = entry;
  }
  return kept;
}
