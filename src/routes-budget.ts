// The free-tier cap for Google Routes lookups. The same rules as
// src-tauri/src/leave.rs: every attempt counts, the day and the month reset
// on Pacific time, and a limit can never be unlimited.
//
// Traffic-aware Compute Routes is the Pro SKU: 5,000 free successful
// requests a month (pricing list checked 2026-10-31). 80 × 31 = 2,480, under
// half of that. 160 × 31 = 4,960, just under 5,000.

export const FREE_ROUTES_PER_MONTH = 5_000;
export const DEFAULT_DAILY = 80;
export const DEFAULT_MONTHLY = 2_500;
export const MAX_DAILY = 160;
export const MAX_MONTHLY = 4_000;

/**
 * A drive longer than this (4 hours) almost always means Google matched an
 * address somewhere else, usually a street with no town ("10 Mill Park Ct").
 * No leave-by time is given for it. Kept in step with MAX_PLAUSIBLE_DRIVE in
 * leave.rs.
 */
export const MAX_PLAUSIBLE_DRIVE_MINUTES = 240;

const LOOKUP_HORIZON_MS = 48 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 2 * 60 * 1000;
const REFINE_GAP_MINUTES = 10;

export interface Usage {
  /** "YYYY-MM-DD" in America/Los_Angeles. */
  day: string;
  dayCount: number;
  /** "YYYY-MM" in America/Los_Angeles. */
  month: string;
  monthCount: number;
}

export interface Limits {
  daily: number;
  monthly: number;
}

export type Charge =
  | { kind: "allowed"; usage: Usage }
  | { kind: "daily"; usage: Usage }
  | { kind: "monthly"; usage: Usage };

/** The Pacific date Google uses for daily quotas, as "YYYY-MM-DD". */
export function pacificDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function pacificMonth(day: string): string {
  return day.slice(0, 7);
}

export function emptyUsage(now: Date): Usage {
  const day = pacificDate(now);
  return { day, dayCount: 0, month: pacificMonth(day), monthCount: 0 };
}

/** A number from Settings, kept inside the range that cannot be unlimited. */
export function clampLimits(daily: number, monthly: number): Limits {
  const whole = (value: number, max: number, fallback: number) => {
    if (!Number.isInteger(value) || value < 0) return fallback;
    return Math.min(value, max);
  };
  return {
    daily: whole(daily, MAX_DAILY, DEFAULT_DAILY),
    monthly: whole(monthly, MAX_MONTHLY, DEFAULT_MONTHLY),
  };
}

/** Drop a finished day or month before deciding. A new month clears both. */
export function roll(usage: Usage, today: string): Usage {
  const month = pacificMonth(today);
  if (usage.month !== month) return { day: today, dayCount: 0, month, monthCount: 0 };
  if (usage.day !== today) return { ...usage, day: today, dayCount: 0 };
  return usage;
}

/**
 * Count one Routes attempt if both caps still have room. A failure counts
 * the same as a success: record the attempt, then send.
 */
export function charge(usage: Usage, today: string, limits: Limits): Charge {
  const rolled = roll(usage, today);
  if (rolled.monthCount >= limits.monthly) return { kind: "monthly", usage: rolled };
  if (rolled.dayCount >= limits.daily) return { kind: "daily", usage: rolled };
  return {
    kind: "allowed",
    usage: { ...rolled, dayCount: rolled.dayCount + 1, monthCount: rolled.monthCount + 1 },
  };
}

export function capped(usage: Usage, today: string, limits: Limits): "none" | "day" | "month" {
  const rolled = roll(usage, today);
  if (rolled.monthCount >= limits.monthly) return "month";
  if (rolled.dayCount >= limits.daily) return "day";
  return "none";
}

/** Whether `place` is somewhere you'd travel to. Kept in step with leave.rs. */
export function isPhysical(place: string): boolean {
  const text = place.trim().toLowerCase();
  if (!text || text.includes("://")) return false;
  return !["zoom", "meet.google", "teams", "webex", "facetime", "online", "virtual", "phone", "call"].some((word) =>
    text.includes(word),
  );
}

export function resolveOrigin(eventOverride: string | null | undefined, defaultAddress: string): string | null {
  const own = eventOverride?.trim();
  if (own) return own;
  const fallback = defaultAddress.trim();
  return fallback || null;
}

/** Worth a lookup only inside 48 hours, and not after the event has started. */
export function shouldQuery(now: Date, arrive: Date): boolean {
  const until = arrive.getTime() - now.getTime();
  return until > 0 && until <= LOOKUP_HORIZON_MS;
}

export function freshFor(untilArrivalMs: number): number {
  const minute = 60_000;
  if (untilArrivalMs <= 45 * minute) return 5 * minute;
  if (untilArrivalMs <= 3 * 60 * minute) return 15 * minute;
  if (untilArrivalMs <= 12 * 60 * minute) return 60 * minute;
  return 4 * 60 * minute;
}

export function stillFresh(fetched: Date, now: Date, arrive: Date, failed: boolean): boolean {
  const age = now.getTime() - fetched.getTime();
  if (age < 0) return false;
  if (failed) return age < FAILURE_TTL_MS;
  return age < freshFor(arrive.getTime() - now.getTime());
}

/** Half an hour before arrival, but never in the past (Routes rejects that). */
export function firstDeparture(now: Date, arrive: Date): Date {
  const soonest = now.getTime() + 60_000;
  const guess = arrive.getTime() - 30 * 60_000;
  return new Date(Math.max(guess, soonest));
}

/** One refinement when the drive would change the departure by more than 10 minutes. */
export function judge(queried: Date, travelMinutes: number, arrive: Date, now: Date, refined: boolean): Date | "done" {
  const depart = arrive.getTime() - travelMinutes * 60_000;
  const gap = Math.abs(depart - queried.getTime()) / 60_000;
  const soonest = now.getTime() + 30_000;
  if (!refined && gap > REFINE_GAP_MINUTES && depart >= soonest) return new Date(depart);
  return "done";
}

/**
 * Whether an address names its town or ZIP: "10 Mill Park Ct" alone can match
 * a street with that name anywhere. A comma, or a 5-digit ZIP, counts.
 */
export function looksComplete(address: string): boolean {
  const text = address.trim();
  return !text || text.includes(",") || /\b\d{5}(?:-\d{4})?\b/.test(text);
}

/** `"165s"` or `"165.4s"` → whole minutes, rounded up. */
export function parseDuration(raw: string): number | null {
  const body = raw.trim().match(/^(\d+(?:\.\d+)?)s$/);
  if (!body) return null;
  const seconds = Number(body[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds / 60);
}
