// Date helpers shared by all views. Everything is in local time.
import type { AgendaItem } from "./api";

export const MS_PER_MINUTE = 60 * 1000;
export const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** Parses "YYYY-MM-DD" as local midnight (`new Date("2026-10-27")` would be UTC). */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Formats a date as "YYYY-MM-DD" in local time. */
export function toDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Moves by whole months, keeping the day where possible (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), daysInTarget));
}

/** Whole calendar days from `a` to `b`. Rounding absorbs DST's 23/25-hour days. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / MS_PER_DAY);
}

export const isSameDay = (a: Date, b: Date) => daysBetween(a, b) === 0;

/** First day of the week from the system locale: 0 = Sunday … 6 = Saturday. */
export const firstDayOfWeek: number = (() => {
  try {
    // getWeekInfo() is the current name; older engines expose a weekInfo property.
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    if (info) return info.firstDay % 7; // Intl counts 1 = Monday … 7 = Sunday
  } catch {
    // Fall back to Sunday below.
  }
  return 0;
})();

export function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  return addDays(day, -((day.getDay() - firstDayOfWeek + 7) % 7));
}

export const itemStart = (item: AgendaItem) =>
  item.allDay ? parseDate(item.start) : new Date(item.start);

export function itemEnd(item: AgendaItem): Date {
  if (item.end) return item.allDay ? parseDate(item.end) : new Date(item.end);
  return item.allDay ? addDays(itemStart(item), 1) : itemStart(item);
}

/** All-day items, and timed ones lasting a day or more: drawn as bars, not in the hour grid. */
export function isAllDayLike(item: AgendaItem): boolean {
  return item.allDay || itemEnd(item).getTime() - itemStart(item).getTime() >= MS_PER_DAY;
}

/** Whether the item overlaps [from, to). A zero-length event counts at its start time. */
export function overlaps(item: AgendaItem, from: Date, to: Date): boolean {
  const start = itemStart(item).getTime();
  const end = Math.max(itemEnd(item).getTime(), start + 1);
  return start < to.getTime() && end > from.getTime();
}

/** Order within a day: bars first (earliest, then longest), then timed items by start. */
export function compareForDay(a: AgendaItem, b: AgendaItem): number {
  const barA = isAllDayLike(a);
  if (barA !== isAllDayLike(b)) return barA ? -1 : 1;
  return (
    itemStart(a).getTime() - itemStart(b).getTime() ||
    itemEnd(b).getTime() - itemEnd(a).getTime() ||
    a.title.localeCompare(b.title)
  );
}

export function itemsOnDay(items: AgendaItem[], day: Date): AgendaItem[] {
  const next = addDays(day, 1);
  return items.filter((item) => overlaps(item, day, next)).sort(compareForDay);
}

export const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const shortDayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const shortDayWithYearFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * "Thu, 29 Oct, 1:00 PM – 2:00 PM", or "Thu, 12 Nov – Sat, 14 Nov · All day"
 * (exact wording follows the system's language). For all-day items, `end`
 * is the midnight after the last day.
 */
export function describeTimes(start: Date, end: Date, allDay: boolean): string {
  const thisYear = new Date().getFullYear();
  const day = (d: Date) => (d.getFullYear() === thisYear ? shortDayFormat : shortDayWithYearFormat).format(d);
  if (allDay) {
    const last = addDays(end, -1);
    return `${last <= start ? day(start) : `${day(start)} – ${day(last)}`} · All day`;
  }
  const from = `${day(start)}, ${timeFormat.format(start)}`;
  if (end <= start) return from;
  const to = isSameDay(start, end) ? timeFormat.format(end) : `${day(end)}, ${timeFormat.format(end)}`;
  return `${from} – ${to}`;
}

/** "2026-10-29T13:00:00+01:00": local time with its UTC offset. */
export function toLocalIso(d: Date): string {
  // Before time zones (1883 in the US), a place kept its own clock, minutes
  // and seconds off the hour (Boston: 4:56:02 behind). An offset can't say
  // the seconds, so say exactly when it is, in UTC.
  const exact = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  if ((exact - d.getTime()) % 60_000 !== 0) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()).toISOString();
  }
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${toDateString(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** The system's time zone, e.g. "Europe/London". */
export const localTimeZone = (): string | null => Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;

/**
 * The instant `local`'s clock time (here) happens in `zone`. For events that
 * keep their clock time in any time zone: what's shown here at 9 AM is saved
 * as 9 AM in the event's own zone.
 */
export function sameClockIn(local: Date, zone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  /** How far `zone` is ahead of UTC at `at` (ms). */
  const offset = (at: number) => {
    const p: Record<string, number> = {};
    for (const part of parts.formatToParts(new Date(at))) if (part.type !== "literal") p[part.type] = Number(part.value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
  };
  const clock = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds());
  // Guess with the zone's offset then, and correct once (clock changes).
  const guess = clock - offset(clock);
  return new Date(clock - offset(guess));
}

/** The zone a floating timed event's clock time belongs to; null for any other item. */
/**
 * A place on one line: "10 Battle Rd\nLexington MA 02421\nUnited States"
 * (as Apple Maps and iPhones give addresses to Google Calendar) becomes "10
 * Battle Rd, Lexington MA 02421, United States". Null if blank. As
 * `place_on_one_line` in agenda.rs.
 */
export function placeOnOneLine(text: string | null | undefined): string | null {
  const line = (text ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim().replace(/,+$/, ""))
    .filter(Boolean)
    .join(", ");
  return line || null;
}

export const floatingZone = (item: { floating?: boolean; timeZone?: string | null; allDay: boolean } | null) =>
  item?.floating && item.timeZone && !item.allDay ? item.timeZone : null;
