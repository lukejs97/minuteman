// Day and week views: a column per day with hours down the side. Timed
// events are blocks sized by duration; all-day and multi-day items are bars in
// a strip above the hours.
//
// Week view draws six weeks but shows seven days at a time. They slide
// sideways under the trackpad, settling on a day, as in Apple's Calendar; the
// view is told which day is first, and draws a new six weeks around it when
// it gets near either end.
import type { AgendaItem } from "../api";
import { decorateTask, el, makeOpenable, setItemColor } from "../dom";
import { leaveLabel } from "../leave";
import { weatherBadge, weatherOn } from "../weather";
import {
  hourHeight as savedHourHeight,
  MAX_HOUR_HEIGHT,
  MIN_HOUR_HEIGHT,
  setHourHeight,
} from "../preferences";
import {
  addDays,
  compareForDay,
  daysBetween,
  isAllDayLike,
  isSameDay,
  itemEnd,
  itemStart,
  MS_PER_MINUTE,
  overlaps,
  timeFormat,
  toDateString,
} from "../time";
import { dayButton, enableCreate } from "./create";
import { enableDayDrag } from "./drag";
import type { ViewContext } from "./types";

const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** px per hour. Pinching changes it (see `enablePinch`); it's kept per device. */
let hourHeight = savedHourHeight();
const MIN_EVENT_HEIGHT = 18; // px, so short events stay clickable and readable
const minEventMs = () => (MIN_EVENT_HEIGHT / hourHeight) * MS_PER_HOUR;

/**
 * A vertical position or length for `ms` of time, in CSS that follows
 * --hour-height, so a pinch can stretch the whole view without redrawing it.
 */
const timeLength = (ms: number) => `calc(var(--hour-height) * ${ms / MS_PER_HOUR})`;
/** Dragged events move and resize in steps of this many minutes. */
const SNAP_MINUTES = 15;
/** px at the bottom of an event that resize it instead of moving it. */
const RESIZE_HANDLE = 7;
/** px the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4;

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

/** The part of a timed event that falls on one day, and where it sits. */
interface Segment {
  item: AgendaItem;
  start: number;
  end: number;
  /** Side by side with events that start at about the same time. */
  column: number;
  columns: number;
  /** Drawn over events it starts well after, this many steps in from the left. */
  indent: number;
}

/** px each step of `Segment.indent` moves an event in. */
const INDENT = 14;
/** At most this many steps in, so a busy day stays readable. */
const MAX_INDENT = 4;
/**
 * An event starting at least this many px (a line) below another that's
 * still on leaves the other's title showing, so it's drawn on top
 * (indented), as in Apple's Calendar, rather than both squeezed side by side.
 */
const ROOM_FOR_TITLE = 20;

/**
 * Lays out the day's timed events. One that starts well after an event
 * that's still on goes on top of it, a step in from the left; ones starting
 * at about the same time share the width side by side, in a group.
 */
function layoutColumns(segments: Segment[]): void {
  segments.sort((a, b) => a.start - b.start || b.end - a.end);
  // Use the drawn height, so tiny events that look overlapping are treated so.
  const visualEnd = (seg: Segment) => Math.max(seg.end, seg.start + minEventMs());
  const titleRoom = Math.max((ROOM_FOR_TITLE / hourHeight) * MS_PER_HOUR, 15 * MS_PER_MINUTE);
  const groupOf = new Map<Segment, { columnEnds: number[]; members: Segment[] }>();
  const placed: Segment[] = [];

  for (const seg of segments) {
    const under = placed.filter((p) => p.start < visualEnd(seg) && visualEnd(p) > seg.start);
    const close = under.find((p) => seg.start - p.start < titleRoom);
    if (close) {
      // Starts with `close`: side by side with its group.
      const group = groupOf.get(close)!;
      seg.indent = close.indent;
      let column = group.columnEnds.findIndex((end) => end <= seg.start);
      if (column === -1) column = group.columnEnds.push(0) - 1;
      group.columnEnds[column] = visualEnd(seg);
      seg.column = column;
      group.members.push(seg);
      groupOf.set(seg, group);
    } else {
      // Starts on its own, or well after everything still on: on top of them.
      seg.indent = under.length ? Math.min(MAX_INDENT, Math.max(...under.map((p) => p.indent)) + 1) : 0;
      seg.column = 0;
      groupOf.set(seg, { columnEnds: [visualEnd(seg)], members: [seg] });
    }
    placed.push(seg);
  }
  for (const seg of segments) seg.columns = groupOf.get(seg)!.columnEnds.length;
}

function positionNowLine(line: HTMLElement): void {
  line.style.top = timeLength(Date.now() - Number(line.dataset.dayStart));
}

// Keep the red "now" line moving without re-drawing the view.
setInterval(() => document.querySelectorAll<HTMLElement>(".tl-now").forEach(positionNowLine), MS_PER_MINUTE);

function headerRow(ctx: ViewContext, days: Date[]): HTMLElement {
  const row = el("div", "tl-row tl-header");
  row.append(el("div", "tl-gutter"));
  for (const day of days) {
    const cell = el("button", "tl-day-header");
    if (isSameDay(day, ctx.now)) cell.classList.add("today");
    cell.append(el("span", "tl-weekday", weekdayFormat.format(day)), el("span", "tl-date", String(day.getDate())));
    // One day on screen: the low too.
    const weather = weatherOn(day);
    if (weather) cell.append(weatherBadge(weather, days.length === 1));
    cell.title = "Show this day";
    dayButton(cell, ctx, day);
    row.append(cell);
  }
  return row;
}

/** Bars for all-day and multi-day items, stacked into lanes so they don't overlap. */
function allDayRow(ctx: ViewContext, days: Date[]): HTMLElement {
  const row = el("div", "tl-row tl-allday");
  const label = el("div", "tl-gutter tl-allday-label", "all-day");
  row.append(label);

  const rangeStart = days[0];
  const rangeEnd = addDays(days[days.length - 1], 1);
  const items = ctx.items
    .filter((item) => isAllDayLike(item) && overlaps(item, rangeStart, rangeEnd))
    .sort(compareForDay);

  const laneEnds: number[] = [];
  for (const item of items) {
    const first = Math.max(0, daysBetween(rangeStart, itemStart(item)));
    const last = Math.min(days.length - 1, daysBetween(rangeStart, new Date(itemEnd(item).getTime() - 1)));
    let lane = laneEnds.findIndex((end) => end < first);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(last);
    } else {
      laneEnds[lane] = last;
    }

    // The title in a box of its own, which keeps to the left edge of the days
    // on screen, so a long bar that began off screen still says what it is.
    const bar = el("div", "tl-allday-item");
    const title = el("span", "tl-allday-title", item.title);
    bar.append(title);
    setItemColor(bar, item);
    bar.style.gridColumn = `${first + 2} / ${last + 3}`; // +1 for the gutter, +1 because grid lines start at 1
    bar.style.gridRow = String(lane + 1);
    if (itemStart(item) < rangeStart) bar.classList.add("cont-left");
    if (itemEnd(item) > rangeEnd) bar.classList.add("cont-right");
    if (item.kind === "event" && itemEnd(item) <= ctx.now) bar.classList.add("past");
    decorateTask(bar, item, ctx.toggleTask);
    // A task's checkbox goes along with its title.
    const check = bar.querySelector(".task-check");
    if (check) title.prepend(check);
    makeOpenable(bar, item, ctx.openItem);
    // Drag along the row to another day; the day headers say which.
    const dayAt = (x: number) => {
      const headers = [...row.parentElement!.querySelectorAll<HTMLElement>(".tl-day-header")];
      const index = headers.findIndex((h) => {
        const r = h.getBoundingClientRect();
        return x >= r.left && x < r.right;
      });
      return index >= 0 ? days[index] : null;
    };
    const highlight = (day: Date | null) => {
      row.parentElement!.querySelectorAll<HTMLElement>(".tl-day-header").forEach((h, i) =>
        h.classList.toggle("drop-target", day !== null && isSameDay(days[i], day)),
      );
    };
    enableDayDrag(bar, item, ctx, days[first], dayAt, highlight);
    row.append(bar);
  }
  label.style.gridRow = `1 / span ${Math.max(1, laneEnds.length)}`;
  enableAllDayScroll(row, laneEnds.length);
  // Double-click or right-click under a day for an all-day item on it.
  enableCreate(row, ctx, (e) => {
    const headers = [...row.parentElement!.querySelectorAll<HTMLElement>(".tl-day-header")];
    const index = headers.findIndex((h) => {
      const r = h.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX < r.right;
    });
    return index >= 0 ? { start: days[index], allDay: true } : null;
  });
  return row;
}

/** A lane of all-day bars: 22px tall plus a 2px gap; keep in sync with .tl-allday. */
const ALL_DAY_LANE = 24;

/**
 * More lanes of all-day items than fit (3½ on a phone, 7½ in a wider
 * window): the row shows that many, and the rest scrolls into view (wheel
 * or finger), every day's column together. Not a real scroller, so its
 * "all-day" label still stays put as the days slide.
 */
function enableAllDayScroll(row: HTMLElement, lanes: number): void {
  const shown = window.matchMedia("(max-width: 640px)").matches ? 3.5 : 7.5;
  if (lanes <= Math.floor(shown)) return;
  row.classList.add("overflowing");
  row.style.setProperty("--all-day-lanes", String(shown));
  let offset = 0;
  const scrollBy = (dy: number): boolean => {
    const padding = 6; // .tl-allday's, top and bottom
    const max = Math.max(0, lanes * ALL_DAY_LANE - 2 + padding - row.clientHeight);
    const next = Math.min(Math.max(offset + dy, 0), max);
    if (next === offset) return false;
    offset = next;
    row.style.setProperty("--all-day-offset", `${-offset}px`);
    return true;
  };
  allDayScrollers.set(row, scrollBy);

  // Scrolling up or down here scrolls just this row, never the hours or the
  // days as well; sideways still slides the days.
  row.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || wheelGesture(e) !== row) return;
      e.preventDefault();
      scrollBy(e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY);
    },
    { passive: false },
  );
  // A finger: the way it first moves decides. Up or down scrolls this row
  // alone (the browser is stopped from scrolling anything else); sideways is
  // left to the browser, to slide the days.
  let touch: { x: number; y: number; vertical: boolean | null } | null = null;
  row.addEventListener(
    "touchstart",
    (e) => (touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, vertical: null } : null),
    { passive: true },
  );
  row.addEventListener(
    "touchmove",
    (e) => {
      if (!touch || e.touches.length !== 1) return;
      const { clientX: x, clientY: y } = e.touches[0];
      if (touch.vertical === null) {
        const [dx, dy] = [Math.abs(x - touch.x), Math.abs(y - touch.y)];
        if (dx + dy < 6) return; // not clearly one way or the other yet
        touch.vertical = dy >= dx;
      }
      if (!touch.vertical) return;
      e.preventDefault();
      scrollBy(touch.y - y);
      touch.x = x;
      touch.y = y;
    },
    { passive: false },
  );
  row.addEventListener("touchend", () => (touch = null));
  row.addEventListener("touchcancel", () => (touch = null));
}

/** Each overflowing all-day row's own scrolling, for wheel gestures that began on it. */
const allDayScrollers = new WeakMap<EventTarget, (dy: number) => boolean>();

/**
 * Where the current trackpad or wheel gesture began: its events keep going
 * (with momentum) after the pointer moves on, and should keep scrolling
 * what they started on, not something else they pass over.
 */
let wheelStart: { target: EventTarget | null; at: number } = { target: null, at: 0 };
function wheelGesture(e: WheelEvent): EventTarget | null {
  const now = e.timeStamp;
  if (now - wheelStart.at > 150) wheelStart = { target: e.currentTarget, at: now };
  else wheelStart.at = now;
  return wheelStart.target;
}

function eventBlock(seg: Segment, dayStart: number, ctx: ViewContext): HTMLElement {
  const { item } = seg;
  const block = el("div", "tl-event");
  setItemColor(block, item);
  if (item.kind === "event" && itemEnd(item) <= ctx.now) block.classList.add("past");

  // Height now, to choose a layout; the block itself follows --hour-height.
  const height = Math.max(MIN_EVENT_HEIGHT, ((seg.end - seg.start) / MS_PER_HOUR) * hourHeight);
  block.style.top = timeLength(seg.start - dayStart);
  block.style.height = `max(${MIN_EVENT_HEIGHT}px, ${timeLength(seg.end - seg.start)})`;
  const inset = seg.indent * INDENT;
  block.style.left = `calc(${inset}px + (100% - ${inset}px) * ${seg.column / seg.columns})`;
  block.style.width = `calc((100% - ${inset}px) / ${seg.columns} - 2px)`;

  const start = timeFormat.format(itemStart(item));
  const leave = leaveLabel(item, "tl-event-leave");
  if (height < 34) {
    // Too short for two lines: "9:30 AM Standup", and the leave-by time if it fits.
    block.classList.add("compact");
    block.append(el("span", "tl-event-time", start), " ", el("span", "tl-event-title", item.title));
    if (leave) block.append(" · ", leave);
  } else {
    // Tasks often have a due time but no duration: show just the time.
    const range = seg.end > seg.start ? `${start} – ${timeFormat.format(itemEnd(item))}` : start;
    const time = el("div", "tl-event-time", range);
    block.append(el("div", "tl-event-title", item.title), time);
    // A short block keeps "Leave by" on the time line. A taller one gives it a line of its own.
    if (leave && height < 64) time.append(" · ", leave);
    if (leave && height >= 64) block.append(leave);
    if (item.location && height >= (leave && height >= 64 ? 84 : 48)) {
      block.append(el("div", "tl-event-time tl-event-place", item.location));
    }
  }
  decorateTask(block, item, ctx.toggleTask);
  makeOpenable(block, item, ctx.openItem);
  if (item.editable) enableDrag(block, item, ctx);
  return block;
}

/** Same local time of day, `days` later, plus `minutes`. Safe across DST changes. */
function shift(d: Date, days: number, minutes: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes() + minutes);
}

/**
 * Lets an event be dragged to another time (or day, in week view), or made
 * longer or shorter by dragging its bottom edge. Mouse and trackpad only: on
 * touch screens a finger drag scrolls the view.
 */
function enableDrag(block: HTMLElement, item: AgendaItem, ctx: ViewContext): void {
  // Events can also be stretched; tasks only moved (their length is optional).
  const resizable = item.kind === "event";
  block.classList.add(resizable ? "editable" : "movable");
  block.addEventListener("pointerdown", (down) => {
    if (down.pointerType !== "mouse" || down.button !== 0) return;
    if ((down.target as Element).closest(".task-check")) return;
    const resizing = resizable && down.clientY > block.getBoundingClientRect().bottom - RESIZE_HANDLE;
    const columns = [...(block.closest(".tl-grid")?.querySelectorAll<HTMLElement>(".tl-col") ?? [])];
    const homeColumn = columns.indexOf(block.parentElement as HTMLElement);
    const start = itemStart(item);
    const end = itemEnd(item);
    const top = block.offsetTop;
    const height = block.offsetHeight;
    const label = block.querySelector<HTMLElement>(".tl-event-time");
    let minutes = 0;
    let days = 0;
    let dragging = false;

    const times = (): [Date, Date] =>
      resizing ? [start, shift(end, 0, minutes)] : [shift(start, days, minutes), shift(end, days, minutes)];

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      const dy = e.clientY - down.clientY;
      if (!dragging) {
        if (Math.hypot(e.clientX - down.clientX, dy) < DRAG_THRESHOLD) return;
        dragging = true;
        block.classList.add("dragging");
      }
      minutes = Math.round(dy / hourHeight * 60 / SNAP_MINUTES) * SNAP_MINUTES;
      if (resizing) {
        // At least one step long.
        minutes = Math.max(minutes, SNAP_MINUTES - Math.round((end.getTime() - start.getTime()) / MS_PER_MINUTE));
        block.style.height = `${Math.max(MIN_EVENT_HEIGHT, height + minutes * hourHeight / 60)}px`;
      } else {
        const over = columns.findIndex((column) => {
          const rect = column.getBoundingClientRect();
          return e.clientX >= rect.left && e.clientX < rect.right;
        });
        if (over >= 0 && over - homeColumn !== days) {
          days = over - homeColumn;
          columns[over].append(block);
        }
        block.style.top = `${top + minutes * hourHeight / 60}px`;
      }
      const [newStart, newEnd] = times();
      if (label) label.textContent = `${timeFormat.format(newStart)} – ${timeFormat.format(newEnd)}`;
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      if (e.type === "pointercancel") minutes = days = 0;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!dragging) return;
      // Wait for the click that follows, so it doesn't open the details.
      window.setTimeout(() => {
        const [newStart, newEnd] = times();
        if (newStart.getTime() === start.getTime() && newEnd.getTime() === end.getTime()) {
          block.classList.remove("dragging");
          ctx.moveItem(item, start, end); // puts it back where it was
        } else {
          ctx.moveItem(item, newStart, newEnd);
        }
      });
    };

    // On the window, not the block: moving the block to another day's column
    // would end pointer capture and lose the rest of the drag.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}

function dayColumn(ctx: ViewContext, day: Date): HTMLElement {
  const column = el("div", "tl-col");
  const next = addDays(day, 1);
  const dayStart = day.getTime();

  if (isSameDay(day, ctx.now)) {
    column.classList.add("today");
    const line = el("div", "tl-now");
    line.dataset.dayStart = String(dayStart);
    positionNowLine(line);
    column.append(line);
  }

  const segments: Segment[] = ctx.items
    .filter((item) => !isAllDayLike(item) && overlaps(item, day, next))
    .map((item) => ({
      item,
      // Events crossing midnight are cut at the day's edges.
      start: Math.max(itemStart(item).getTime(), dayStart),
      end: Math.min(itemEnd(item).getTime(), next.getTime()),
      column: 0,
      columns: 1,
      indent: 0,
    }));
  layoutColumns(segments);
  for (const seg of segments) column.append(eventBlock(seg, dayStart, ctx));
  // Double-click or right-click an empty spot for an item then (15-minute steps).
  enableCreate(column, ctx, (e) => {
    const y = e.clientY - column.getBoundingClientRect().top;
    const minutes = Math.floor(((y / hourHeight) * 60) / SNAP_MINUTES) * SNAP_MINUTES;
    const clamped = Math.min(Math.max(minutes, 0), 24 * 60 - SNAP_MINUTES);
    return { start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, clamped), allDay: false };
  });
  return column;
}

/** Zooming to fit never shows fewer hours than this (a lone hour-long event isn't blown up). */
const MIN_FIT_HOURS = 8;
/** ...nor makes an hour taller than this, in px. */
const MAX_FIT_HEIGHT = 96;
/** Hours shown for days with nothing at a time of day. */
const QUIET_HOURS: [number, number] = [8, 18];

/**
 * The hours worth seeing on `days`: from a little before their first timed
 * item to a little after their last, whole hours, at least `MIN_FIT_HOURS`.
 */
function busyHours(items: AgendaItem[], days: Date[]): [number, number] {
  let [from, to] = [24, 0];
  for (const day of days) {
    const [start, next] = [day.getTime(), addDays(day, 1)];
    for (const item of items) {
      if (isAllDayLike(item) || !overlaps(item, day, next)) continue;
      const itemFrom = itemStart(item).getTime();
      // A task at a time has no length; count half an hour.
      const itemTo = Math.max(itemEnd(item).getTime(), itemFrom + 30 * MS_PER_MINUTE);
      // The small hours of last night's late event don't count.
      if (itemFrom < start && itemTo <= start + 6 * MS_PER_HOUR) continue;
      from = Math.min(from, (Math.max(itemFrom, start) - start) / MS_PER_HOUR);
      to = Math.max(to, (Math.min(itemTo, next.getTime()) - start) / MS_PER_HOUR);
    }
  }
  if (from >= to) return QUIET_HOURS;
  from = Math.max(0, Math.floor(from - 0.25));
  to = Math.min(24, Math.ceil(to + 0.25));
  const short = MIN_FIT_HOURS - (to - from);
  if (short > 0) {
    from = Math.max(0, from - Math.floor(short / 2));
    to = Math.min(24, from + MIN_FIT_HOURS);
    from = Math.max(0, to - MIN_FIT_HOURS);
  }
  return [from, to];
}

/**
 * What the hours were last fitted to: the days on screen, and the hours
 * their items needed, and the size and first hour that fit them (and
 * whether that's been applied yet). A redraw for the same days keeps the
 * zoom (and any pinch or scroll since), unless their items now need other
 * hours and you haven't zoomed or scrolled since.
 */
let fitted = { days: "", hours: "", room: 0, adjusted: false, height: 0, from: 0, applied: true };

/** The sliding strip of each week view on screen, for `slideTimeline`. */
const sliders = new WeakMap<HTMLElement, { days: Date[]; column: () => number }>();

/**
 * Draws `days`, `visible` of them across the window at a time (all of them
 * unless sliding), starting at `ctx.anchor`.
 */
export function renderTimeline(
  root: HTMLElement,
  ctx: ViewContext,
  days: Date[],
  visible = days.length,
  startHour?: number,
): void {
  const timeline = el("div", "timeline");
  timeline.style.setProperty("--columns", String(days.length));
  timeline.style.setProperty("--hour-height", `${hourHeight}px`);
  if (days.length === 1) timeline.classList.add("single-day");

  // One box scrolls both ways; the day headers stay at the top and the hours
  // at the left (CSS position: sticky).
  const scroller = el("div", "tl-scroll");
  const sliding = days.length > visible;
  if (sliding) scroller.classList.add("sliding");
  const top = el("div", "tl-top");
  const allDay = allDayRow(ctx, days);
  top.append(headerRow(ctx, days), allDay);
  const grid = el("div", "tl-row tl-grid");
  const hours = el("div", "tl-gutter tl-hours");
  for (let h = 1; h < 24; h++) {
    const label = el("span", "tl-hour", hourFormat.format(new Date(2000, 0, 1, h)));
    label.style.top = timeLength(h * MS_PER_HOUR);
    hours.append(label);
  }
  grid.append(hours, ...days.map((day) => dayColumn(ctx, day)));
  scroller.append(top, grid);
  timeline.append(scroller);

  const previousScroll = ctx.preserveScroll ? root.querySelector(".tl-scroll")?.scrollTop : undefined;
  // How far the all-day row was scrolled, to keep it there (after a delete, say).
  const previousAllDay = ctx.preserveScroll
    ? -parseFloat(root.querySelector<HTMLElement>(".tl-allday")?.style.getPropertyValue("--all-day-offset") || "0")
    : 0;
  root.replaceChildren(timeline);
  if (previousAllDay > 0) allDayScrollers.get(allDay)?.(previousAllDay);

  // Columns are a seventh (or all) of the width beside the hours.
  let first = Math.min(Math.max(0, daysBetween(days[0], ctx.anchor)), days.length - visible);
  let column = 0;
  const size = () => {
    const gutter = parseFloat(getComputedStyle(timeline).getPropertyValue("--gutter")) || 56;
    column = Math.max(1, (scroller.clientWidth - gutter) / visible);
    timeline.style.setProperty("--column", `${column}px`);
    timeline.classList.toggle("narrow", column < 80);
    scroller.scrollLeft = first * column;
  };
  size();
  // The hours down the side: like an empty spot, at the leftmost day on
  // screen (double-click, right-click, or press and hold).
  enableCreate(hours, ctx, (e) => {
    const y = e.clientY - hours.getBoundingClientRect().top;
    const minutes = Math.floor(((y / hourHeight) * 60) / SNAP_MINUTES) * SNAP_MINUTES;
    const clamped = Math.min(Math.max(minutes, 0), 24 * 60 - SNAP_MINUTES);
    const day = days[first];
    return { start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, clamped), allDay: false };
  });
  // A bigger or smaller window: fit the hours to it again (once it's done
  // changing). Zoomed yourself, they're at least made tall enough to fill it.
  let refit: number | undefined;
  const resized = new ResizeObserver(() => {
    if (!scroller.isConnected) return resized.disconnect();
    size();
    window.clearTimeout(refit);
    refit = window.setTimeout(() => {
      if (!scroller.isConnected) return;
      const zoom = fit();
      const tall = Math.max(hourHeight, lowestHourHeight());
      if (!zoom && Math.abs(tall - hourHeight) < 0.5) return;
      const hoursAtTop = scroller.scrollTop / hourHeight;
      fitted.applied = true;
      hourHeight = zoom ? zoom[0] : tall;
      redraw(zoom ? zoom[1] : hoursAtTop);
    }, 150);
  });
  resized.observe(scroller);

  if (sliding) {
    sliders.set(root, { days, column: () => column });
    let settle: number | undefined;
    scroller.addEventListener(
      "scroll",
      () => {
        // A replaced view's box reports scrolling back to 0 as it goes.
        if (!scroller.isConnected) return;
        const index = Math.round(scroller.scrollLeft / column);
        if (index !== first) {
          first = index;
          ctx.slid?.(days[first], false);
        }
        window.clearTimeout(settle);
        settle = window.setTimeout(() => {
          if (!scroller.isConnected) return;
          scroller.dispatchEvent(new Event("slid"));
          ctx.slid?.(days[first], true);
        }, 200);
      },
      { passive: true },
    );
  }

  /** Redraws at the current size, keeping the days and hours on screen where they are. */
  const redraw = (hour?: number) =>
    renderTimeline(root, { ...ctx, anchor: days[first], preserveScroll: hour === undefined, reveal: undefined }, days, visible, hour);
  const onScreen = () => days.slice(first, first + visible);
  /** The hour height (and first hour) that fits the days on screen, if they need fitting now. */
  /** The hours' height on screen, less what the phone's floating buttons cover. */
  const room = () => {
    const dock = document.querySelector<HTMLElement>(".dock");
    const shown = dock && dock.getClientRects().length > 0; // not display: none (desktop)
    const covered = shown ? Math.max(0, scroller.getBoundingClientRect().bottom - dock.getBoundingClientRect().top) : 0;
    return scroller.clientHeight - top.offsetHeight - covered;
  };
  /**
   * The shortest hour a pinch may use. A full day still fills the hours
   * (`room() / 24`), and an hour is never under `MIN_HOUR_HEIGHT`. The resize
   * handler pulls a shorter day back up to this; pinching has to stop here
   * itself, or the day shrinks past it and then jumps.
   */
  const lowestHourHeight = () => Math.max(MIN_HOUR_HEIGHT, room() / 24);
  const fit = (): [height: number, from: number] | null => {
    const daysKey = `${toDateString(days[first])}+${visible}`;
    const [from, to] = busyHours(ctx.items, onScreen());
    const hoursKey = `${from}-${to}`;
    const space = room();
    // The same days, needing the same hours, in about the same space.
    const same = daysKey === fitted.days && (hoursKey === fitted.hours || fitted.adjusted);
    if (same && (fitted.adjusted || Math.abs(space - fitted.room) < 20)) {
      // Worked out already, but (say) a redraw came before it could be applied.
      return fitted.applied ? null : [fitted.height, fitted.from];
    }
    const height = Math.min(MAX_FIT_HEIGHT, Math.max(MIN_HOUR_HEIGHT, space / (to - from)));
    fitted = { days: daysKey, hours: hoursKey, room: space, adjusted: false, height, from, applied: false };
    return [height, from];
  };

  const zoom = startHour === undefined && !ctx.reveal ? fit() : null;
  if (zoom) fitted.applied = true;
  if (zoom && Math.abs(zoom[0] - hourHeight) > 0.5) {
    // Short events lay out by their height, so draw again at the new one.
    hourHeight = zoom[0];
    return redraw(zoom[1]);
  }
  if (startHour !== undefined) {
    scroller.scrollTop = startHour * hourHeight;
  } else if (zoom) {
    scroller.scrollTop = zoom[1] * hourHeight;
  } else if (ctx.reveal) {
    scroller.scrollTop = Math.max(0, ctx.reveal.getHours() - 1) * hourHeight;
    fitted = { ...fitted, days: `${toDateString(days[first])}+${visible}`, hours: "", adjusted: true, applied: true };
  } else if (previousScroll !== undefined) {
    scroller.scrollTop = previousScroll;
  } else {
    // Start at 7 AM, or a couple of hours before now when today is shown.
    const shown = days.slice(first, first + visible);
    const showsToday = shown.some((day) => isSameDay(day, ctx.now));
    scroller.scrollTop = (showsToday ? Math.max(0, ctx.now.getHours() - 2) : 7) * hourHeight;
  }

  // A trackpad swipe that began on the all-day row keeps scrolling only it,
  // even once the pointer drifts down over the hours.
  scroller.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) return;
      const started = wheelGesture(e);
      if (started === scroller || !(started instanceof HTMLElement) || started.contains(e.target as Node)) return;
      const scrollRow = allDayScrollers.get(started);
      if (!scrollRow) return;
      e.preventDefault();
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) scrollRow(e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY);
    },
    { passive: false },
  );

  // Zooming or scrolling the hours yourself keeps them as you left them,
  // until other days come on screen.
  const adjusted = () => (fitted.adjusted = true);
  scroller.addEventListener("wheel", (e) => Math.abs(e.deltaY) > Math.abs(e.deltaX) && adjusted(), { passive: true });
  scroller.addEventListener("touchmove", adjusted, { passive: true });

  // After sliding to other days, zoom to fit them, smoothly.
  if (sliding) {
    scroller.addEventListener("slid", () => {
      const zoom = fit();
      if (zoom)
        animateZoom(scroller, timeline, zoom[0], zoom[1], () => {
          fitted.applied = true;
          redraw();
        });
    });
  }

  // After a pinch, draw again at the new size (short events change layout),
  // keeping the days and hours on screen where they are.
  enablePinch(scroller, timeline, () => {
    adjusted();
    redraw();
  }, lowestHourHeight);
}

/**
 * Changes the hour height to `height` and scrolls to `fromHour`, over a
 * moment, then runs `done`. A touch or wheel stops it where it is.
 */
function animateZoom(scroller: HTMLElement, timeline: HTMLElement, height: number, fromHour: number, done: () => void) {
  const [startHeight, startTop, endTop] = [hourHeight, scroller.scrollTop, fromHour * height];
  const began = performance.now();
  let stopped = false;
  const stop = () => (stopped = true);
  scroller.addEventListener("touchstart", stop, { once: true, passive: true });
  scroller.addEventListener("wheel", stop, { once: true, passive: true });
  const step = (now: number) => {
    if (!scroller.isConnected) return;
    if (stopped) return done();
    const t = Math.min(1, (now - began) / 300);
    const eased = 1 - (1 - t) ** 3;
    hourHeight = startHeight + (height - startHeight) * eased;
    timeline.style.setProperty("--hour-height", `${hourHeight}px`);
    scroller.scrollTop = startTop + (endTop - startTop) * eased;
    if (t < 1) requestAnimationFrame(step);
    else done();
  };
  requestAnimationFrame(step);
}

/**
 * Pinching up and down shows more or fewer hours: two fingers on a touch
 * screen, or a trackpad pinch (which browsers report as ctrl + mouse wheel,
 * and Safari as "gesture" events). Only the vertical spread of the fingers
 * counts. The time under the fingers stays where it is. Once the pinch ends,
 * the size is saved and `redraw` runs.
 */
function enablePinch(
  scroller: HTMLElement,
  timeline: HTMLElement,
  redraw: () => void,
  lowestHourHeight: () => number,
): void {
  let settle: number | undefined;
  /** A pinch in this gesture actually changed the hour height. */
  let moved = false;
  /** Where the hours start inside the scrolling content, in px. */
  const gridTop = () => {
    const grid = scroller.querySelector<HTMLElement>(".tl-grid")!;
    return grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  };

  /**
   * Sets the hour height, keeping the time at `clientY` (a screen position)
   * in place. False when that's already the height, so the caller can leave
   * the scroll and the layout alone.
   *
   * Zooming in is only capped at `MAX_HOUR_HEIGHT`. Zooming out also stops
   * at `lowestHourHeight` (a full day filling the window). The limit is
   * applied before the scroll is chosen: a shorter requested height used to
   * be drawn, then the resize handler pulled the day back up and the view jumped.
   */
  const zoomTo = (height: number, clientY: number): boolean => {
    let next = Math.min(MAX_HOUR_HEIGHT, Math.max(MIN_HOUR_HEIGHT, height));
    if (height < hourHeight) next = Math.max(next, lowestHourHeight());
    if (Math.abs(next - hourHeight) < 0.1) return false;
    const offset = clientY - scroller.getBoundingClientRect().top;
    const top = gridTop();
    const hoursAtPoint = (scroller.scrollTop + offset - top) / hourHeight;
    hourHeight = next;
    timeline.style.setProperty("--hour-height", `${next}px`);
    // The clamped height, so the time under the pointer doesn't follow a
    // size the view then abandons.
    scroller.scrollTop = top + hoursAtPoint * next - offset;
    moved = true;
    return true;
  };

  const finish = () => {
    window.clearTimeout(settle);
    settle = window.setTimeout(() => {
      settle = undefined;
      moved = false;
      setHourHeight(hourHeight);
      if (scroller.isConnected) redraw();
    }, 250);
  };
  /**
   * Save and redraw once a gesture that changed the hour height has stopped.
   * A further zoom-out already at the limit must not schedule one: nothing
   * moved, and a redraw was when a too-short day got pulled back up.
   */
  const note = (changed: boolean) => {
    if (changed) moved = true;
    if (moved) finish();
  };

  // Trackpad pinch (and ctrl + mouse wheel). Not passive: preventDefault
  // stops the browser zooming the page, including when the hour height is
  // already at its limit and this gesture changes nothing.
  scroller.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // Trackpads send many small steps; a mouse wheel notch is one big one
      // (or a few "lines"), so cap each step at about a 28% change.
      const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
      const step = Math.max(-25, Math.min(25, delta));
      note(zoomTo(hourHeight * Math.exp(-step * 0.01), e.clientY));
    },
    { passive: false },
  );

  // Two fingers on a touch screen.
  let pinch: { gap: number; height: number } | null = null;
  const verticalGap = (touches: TouchList) => Math.max(30, Math.abs(touches[0].clientY - touches[1].clientY));
  const middle = (touches: TouchList) => (touches[0].clientY + touches[1].clientY) / 2;
  scroller.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) pinch = { gap: verticalGap(e.touches), height: hourHeight };
    },
    { passive: true },
  );
  scroller.addEventListener(
    "touchmove",
    (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault(); // no page zoom
      zoomTo(pinch.height * (verticalGap(e.touches) / pinch.gap), middle(e.touches));
    },
    { passive: false },
  );
  const touchEnd = (e: TouchEvent) => {
    if (pinch && e.touches.length < 2) {
      pinch = null;
      if (moved) finish();
    }
  };
  scroller.addEventListener("touchend", touchEnd);
  scroller.addEventListener("touchcancel", touchEnd);

  // Safari on a Mac trackpad sends "gesture" events, not ctrl + wheel. On
  // touch screens the touch handlers above do the work; these only stop
  // Safari zooming the page.
  type GestureEvent = UIEvent & { scale: number; clientY: number };
  let gestureStart = hourHeight;
  scroller.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gestureStart = hourHeight;
  });
  scroller.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    if (pinch) return;
    const g = e as GestureEvent;
    zoomTo(gestureStart * g.scale, g.clientY);
  });
  scroller.addEventListener("gestureend", (e) => {
    e.preventDefault();
    if (!pinch && moved) finish();
  });
}

/**
 * Slides the week view in `root` until `day` is first, smoothly. False if
 * `day` isn't among the days drawn (then draw them afresh instead).
 */
export function slideTimeline(root: HTMLElement, day: Date, visible = 7): boolean {
  const slider = sliders.get(root);
  const scroller = root.querySelector<HTMLElement>(".tl-scroll.sliding");
  if (!slider || !scroller) return false;
  const index = daysBetween(slider.days[0], day);
  if (index < 0 || index > slider.days.length - visible) return false;
  scroller.scrollTo({ left: index * slider.column(), behavior: "smooth" });
  return true;
}
