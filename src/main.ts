// Caslon: the typeface the Declaration of Independence was first printed in.
import "@fontsource/libre-caslon-text/latin-400.css";
import "@fontsource/libre-caslon-text/latin-700.css";
import {
  authStatus,
  errorMessage,
  getAgenda,
  getSavedAgenda,
  eventRef,
  isNotSignedIn,
  setEventTimes,
  setTaskCompleted,
  setTaskDue,
  signIn,
  type Agenda,
  type AgendaItem,
} from "./api";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { boot } from "./boot";
import { GO_TO_DAY, openContacts } from "./contacts/open";
import { openDetails, showItemMenu } from "./details";
import { setUpDockMenu } from "./dock-menu";
import { el, setItemMenu } from "./dom";
import { openEdit, openNew, type At } from "./event-form";
import { openSearch } from "./search";
import { announceChange, onChangeElsewhere } from "./sync";
import { refreshWeather } from "./weather";
import { openSettings } from "./settings";
import {
  addDays,
  floatingZone,
  isSameDay,
  itemEnd,
  itemStart,
  localTimeZone,
  overlaps,
  parseDate,
  sameClockIn,
  startOfDay,
  startOfWeek,
  timeFormat,
  toDateString,
  toLocalIso,
} from "./time";
import { slideTimeline, slidingDays, VIEW_ORDER, viewLabel, VIEWS, type ViewName } from "./views";

/** How often to check Google and Todoist for changes while the window's in view. */
const SYNC_EVERY_MS = 60 * 1000;
const CACHE_LIMIT = 24;
const VIEW_STORAGE_KEY = "calendar.view";

const app = document.querySelector<HTMLElement>("#app")!;
const banner = document.querySelector<HTMLElement>("#banner")!;
const title = document.querySelector<HTMLElement>("#title")!;
const account = document.querySelector<HTMLElement>("#account")!;
const actions = document.querySelector<HTMLElement>("#actions")!;
const toolbar = document.querySelector<HTMLElement>("#toolbar")!;
const viewSwitcher = document.querySelector<HTMLElement>("#view-switcher")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const dock = document.querySelector<HTMLElement>("#dock")!;
const menuButton = document.querySelector<HTMLButtonElement>("#menu-button")!;
const menu = document.querySelector<HTMLElement>("#menu")!;
/** Closes the phone's ☰ menu (set up in setUpMenu). */
let closeMenu = () => {};

const firstView = savedView();
const state = { view: firstView, anchor: firstDay(firstView, new Date()) };

/** Recently loaded ranges, so going back and forth shows something instantly. */
const cache = new Map<string, Agenda>();
/** Tasks ticked off or back on in this session, by id. */
const toggledTasks = new Map<string, AgendaItem>();
/** What's on screen, so auto-refresh and resizing can redraw it in place. */
let shown: { view: ViewName; range: string; agenda: Agenda } | undefined;
let latestRequest = 0;
/** A just-added event's start, to scroll into view on the next draw. */
let reveal: Date | undefined;
let syncTimer: number | undefined;
let lastSync = 0;
/**
 * Where week view is sliding to, until it gets there. Taps on ‹ › while it
 * slides count on from there, not from wherever the slide has got to, so
 * five quick taps go five weeks.
 */
let heading: Date | null = null;

function savedView(): ViewName {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    if (saved && saved in VIEWS) return saved as ViewName;
  } catch {
    // Storage unavailable; use the default.
  }
  // A whole week is cramped on a phone; start with a few days there.
  return window.matchMedia("(max-width: 640px)").matches ? "days" : "week";
}

function saveView(view: ViewName): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Not important enough to report.
  }
}

function currentRange() {
  const { from, to } = VIEWS[state.view].range(state.anchor);
  return { from, to, key: `${toDateString(from)}/${toDateString(to)}` };
}

/**
 * Loaded items, with this session's task check-offs applied. Todoist stops
 * returning a task once it's done, so done tasks are kept here and stay
 * visible (struck through) until the app restarts.
 */
function itemsToShow(agenda: Agenda, from: Date, to: Date): AgendaItem[] {
  const loaded = new Set(agenda.items.map((item) => item.id));
  const doneElsewhere = [...toggledTasks.values()].filter(
    (task) => !loaded.has(task.id) && overlaps(task, from, to),
  );
  return [...agenda.items.map((item) => toggledTasks.get(item.id) ?? item), ...doneElsewhere];
}

function render(agenda: Agenda): void {
  const { from, to, key } = currentRange();
  const revealNow = reveal;
  reveal = undefined;
  account.textContent = agenda.accounts.join(", ");
  banner.replaceChildren(...agenda.warnings.map((w) => el("p", "warning", `Couldn't load ${w}`)));
  if (agenda.offlineSince) banner.prepend(el("p", "warning", offlineNote(agenda.offlineSince)));
  VIEWS[state.view].render(app, {
    items: itemsToShow(agenda, from, to),
    from,
    to,
    anchor: state.anchor,
    now: new Date(),
    // Week view keeps its place in the day when drawing more weeks to slide to.
    preserveScroll: shown?.view === state.view && (shown.range === key || slidingDays(state.view) !== null),
    reveal: revealNow,
    goTo,
    toggleTask,
    openItem: showDetails,
    moveItem,
    slid,
    create: (start, allDay, mode) => newEvent(mode, { start, allDay }),
  });
  shown = { view: state.view, range: key, agenda };
}

/**
 * Week view slid to start on `first`: show its dates, and once it stops,
 * draw the weeks around it if it's near the end of those drawn.
 */
function slid(first: Date, settled: boolean): void {
  if (settled) heading = null;
  state.anchor = first;
  updateToolbar();
  if (settled && shown && currentRange().key !== shown.range) void load();
}

function rerender(): void {
  if (shown) render(shown.agenda);
}

/** Ticks a task off (or back on) right away, then tells Todoist. */
async function toggleTask(item: AgendaItem): Promise<void> {
  const completed = !item.completed;
  toggledTasks.set(item.id, { ...item, completed });
  rerender();
  try {
    await setTaskCompleted(item.id, completed);
    announceChange();
    if (!completed) {
      // Reopened: Todoist lists it again, so fetch it fresh.
      toggledTasks.delete(item.id);
      cache.clear();
      await load();
    }
  } catch (e) {
    if (item.completed) toggledTasks.set(item.id, item);
    else toggledTasks.delete(item.id);
    rerender();
    banner.replaceChildren(el("p", "error", `Couldn't update "${item.title}": ${errorMessage(e)}`));
  }
}

/** Swaps in a changed copy of an item in what's on screen, and redraws. */
function replaceShown(item: AgendaItem): void {
  if (!shown) return;
  const agenda = { ...shown.agenda, items: shown.agenda.items.map((i) => (i.id === item.id ? item : i)) };
  cache.set(shown.range, agenda);
  shown = { ...shown, agenda };
  rerender();
}

/** Whether an event has guests besides you, who'd be emailed about changes. */
const hasGuests = (item: AgendaItem) => item.attendees.some((a) => !a.isSelf);

/** Moves an event or task right away on screen (after dragging it), then saves it. */
async function moveItem(item: AgendaItem, start: Date, end: Date): Promise<void> {
  if (start.getTime() === itemStart(item).getTime() && end.getTime() === itemEnd(item).getTime()) {
    rerender(); // dropped where it was
    return;
  }
  const format = (d: Date) => (item.allDay ? toDateString(d) : toLocalIso(d));
  replaceShown({ ...item, start: format(start), end: format(end), overdue: false });
  try {
    if (item.source === "todoist") {
      await setTaskDue(item.sourceId!, { kind: "at", at: format(start) });
    } else {
      // Kept at its clock time anywhere: saved as that clock time in its own zone.
      const zone = floatingZone(item);
      const at = (d: Date) => (zone ? sameClockIn(d, zone).toISOString() : format(d));
      const times = { start: at(start), end: at(end), allDay: item.allDay, timeZone: zone ?? localTimeZone() };
      await setEventTimes(eventRef(item), times, hasGuests(item));
    }
    announceChange();
    // Other cached ranges may show it too; fetch them fresh when visited.
    for (const key of cache.keys()) if (key !== shown?.range) cache.delete(key);
  } catch (e) {
    replaceShown(item);
    banner.replaceChildren(el("p", "error", `Couldn't move "${item.title}": ${errorMessage(e)}`));
  }
}

function updateToolbar(): void {
  // The year in a span of its own, so it can be styled apart from the month.
  const parts = VIEWS[state.view].title(state.anchor).split(/(\d{4})/);
  title.replaceChildren(...parts.map((part, i) => (i % 2 ? el("span", "title-year", part) : part)));
  title.title = "Go to today (T)";
  for (const button of viewSwitcher.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  }
}

/** "No internet. Showing events saved at 3:42 PM." */
function offlineNote(savedAt: string): string {
  const saved = new Date(savedAt);
  const when = Number.isNaN(saved.getTime())
    ? ""
    : startOfDay(saved).getTime() === startOfDay(new Date()).getTime()
      ? ` at ${timeFormat.format(saved)}`
      : ` on ${saved.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${timeFormat.format(saved)}`;
  return `No internet. Showing events saved${when}.`;
}

/**
 * Shows the current view right away (from memory, or else from what was
 * saved on disk last time), then fresh from Google and Todoist.
 */
async function load(): Promise<void> {
  const { from, to, key } = currentRange();
  updateToolbar();

  const request = ++latestRequest;
  let cached = cache.get(key);
  if (cached) render(cached);
  else if (shown?.view === state.view && slidingDays(state.view) !== null) {
    // Slid on to new weeks: most of what's needed is already on screen.
    render(shown.agenda);
  } else {
    app.classList.add("loading");
    void getSavedAgenda(toDateString(from), toDateString(to))
      .then((saved) => {
        // Only if the fresh answer hasn't arrived first.
        if (saved && request === latestRequest && !cache.has(key)) {
          cached = saved;
          render(saved);
          app.classList.remove("loading");
        }
      })
      .catch(() => {});
  }

  refreshButton.disabled = true;
  try {
    const agenda = await getAgenda(toDateString(from), toDateString(to));
    cache.delete(key);
    cache.set(key, agenda);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    if (request === latestRequest) render(agenda);
  } catch (e) {
    if (request !== latestRequest) return;
    if (isNotSignedIn(e)) {
      showSignedOut("Your Google session ended. Please sign in again.");
      return;
    }
    if (cached) banner.replaceChildren(el("p", "error", errorMessage(e)));
    else app.replaceChildren(el("p", "error", errorMessage(e)));
  } finally {
    if (request === latestRequest) {
      refreshButton.disabled = false;
      app.classList.remove("loading");
    }
  }
}

/**
 * Checks Google and Todoist for changes made elsewhere, and redraws only if
 * there are any. Runs every minute, and when the window comes back into
 * view or back online; not while it's hidden, or while you're dragging
 * something or have a menu open.
 */
async function sync(): Promise<void> {
  // Not under an open popup either: the change would show through its dimmed background.
  if (document.hidden || !shown || document.querySelector(".dragging, .context-menu, dialog[open]")) return;
  void updateWeather();
  if (Date.now() - lastSync < SYNC_EVERY_MS / 4) return;
  lastSync = Date.now();
  const { from, to, key } = currentRange();
  const request = latestRequest;
  try {
    const agenda = await getAgenda(toDateString(from), toDateString(to));
    // Something else loaded meanwhile (you moved on, or changed something).
    if (request !== latestRequest) return;
    cache.delete(key);
    cache.set(key, agenda);
    if (shown?.range === key && JSON.stringify(shown.agenda) === JSON.stringify(agenda)) return;
    if (document.querySelector(".dragging, .context-menu, dialog[open]")) return;
    render(agenda);
  } catch {
    // Offline or the like: the next try, or a refresh, says so.
  }
}

/** Fetches the weather if it's due (every few hours), and redraws with it. */
async function updateWeather(): Promise<void> {
  if (!(await refreshWeather()) || !shown) return;
  // Under an open popup, wait until it's closed.
  const open = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (open) open.addEventListener("close", () => void updateWeather().then(rerender), { once: true });
  else if (!document.querySelector(".dragging, .context-menu")) render(shown.agenda);
}

function goTo(view: ViewName, date: Date): void {
  heading = null;
  state.view = view;
  state.anchor = firstDay(view, date);
  saveView(view);
  void load();
}

function step(direction: 1 | -1): void {
  showDate(VIEWS[state.view].step(heading ?? state.anchor, direction));
}

/** Goes to `date` in the current view; in week view by sliding there, if it's near. */
function showDate(date: Date): void {
  const visible = slidingDays(state.view);
  const first = firstDay(state.view, date);
  if (visible !== null && slideTimeline(app, first, visible)) {
    heading = first;
    return;
  }
  goTo(state.view, date);
}

/**
 * Changes view, keeping to the same dates. The multi-day view starts today
 * if the view it came from showed today.
 */
function switchView(view: ViewName): void {
  const today = startOfDay(new Date());
  const anchor = state.anchor;
  const showsToday =
    state.view === "year"
      ? anchor.getFullYear() === today.getFullYear()
      : state.view === "month"
        ? anchor.getFullYear() === today.getFullYear() && anchor.getMonth() === today.getMonth()
        : today >= startOfDay(anchor) && today < addDays(startOfDay(anchor), slidingDays(state.view) ?? 1);
  goTo(view, view === "days" && showsToday ? today : anchor);
}

/** The first day `view` shows to show `date`: a week from its start (until slid). */
function firstDay(view: ViewName, date: Date): Date {
  return view === "week" ? startOfWeek(date) : startOfDay(date);
}

function showCalendar(): void {
  actions.hidden = false;
  toolbar.hidden = false;
  dock.hidden = false;
  app.replaceChildren(el("p", "empty", "Loading…"));
  void load();
  void updateWeather();
  window.clearInterval(syncTimer);
  syncTimer = window.setInterval(sync, SYNC_EVERY_MS);
}

function showSignedOut(error?: string): void {
  window.clearInterval(syncTimer);
  latestRequest++; // ignore any request still in flight
  cache.clear();
  toggledTasks.clear();
  shown = undefined;
  actions.hidden = true;
  toolbar.hidden = true;
  dock.hidden = true;
  closeMenu();
  title.textContent = "Minuteman";
  title.removeAttribute("title");
  account.textContent = "";
  banner.replaceChildren();
  app.classList.remove("loading");

  const view = el("div", "sign-in");
  view.append(el("p", "sign-in-text", "Connect your Google account to see your calendars."));
  if (error) view.append(el("p", "error", error));

  const button = el("button", "primary-button", "Sign in with Google");
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Continue in your browser…";
    try {
      await signIn();
      showCalendar();
    } catch (e) {
      showSignedOut(errorMessage(e));
    }
  });
  view.append(button);
  app.replaceChildren(view);
}

/** Reloads everything after an event or task was edited or deleted. */
function changed(): void {
  cache.clear();
  announceChange();
  void load();
}

const itemActions = {
  toggleTask,
  edit: (it: AgendaItem) => openEdit(it, changed),
  deleted: changed,
  open: (it: AgendaItem) => showDetails(it),
};

function showDetails(item: AgendaItem): void {
  openDetails(item, itemActions);
}

/** Opens "New event" (or task); once it's added, shows the day it's on. */
function newEvent(mode: "event" | "task" = "event", at: At | null = null): void {
  openNew(
    ({ start, allDay }) => {
      cache.clear();
      announceChange();
      // A task without a date isn't on the calendar; one added where you
      // clicked is already on screen.
      if (!start || (at && isSameDay(start, at.start))) return void load();
      if (!allDay) reveal = start;
      goTo(state.view, start);
    },
    mode,
    at,
  );
}

/** Opens search; a chosen result shows its day, then its details. */
function searchEvents(): void {
  openSearch((item) => {
    goTo("day", itemStart(item));
    showDetails(item);
  });
}

/** The view buttons' names ("3 Days" changes with Settings). */
function labelViews(): void {
  for (const button of viewSwitcher.querySelectorAll<HTMLButtonElement>("button")) {
    const name = button.dataset.view as ViewName;
    button.textContent = viewLabel(name);
    button.title = `${viewLabel(name)} (${VIEWS[name].key.toUpperCase()})`;
  }
}

function showSettings(): void {
  openSettings({
    accountsChanged: (signedIn) => {
      if (!signedIn) return showSignedOut();
      cache.clear();
      void load();
    },
    todoistChanged: () => {
      cache.clear();
      void load();
    },
    daysChanged: () => {
      labelViews();
      if (state.view === "days") void load();
    },
    sourcesChanged: () => {
      cache.clear();
      void load();
      announceChange();
    },
    weatherChanged: () => {
      if (shown) render(shown.agenda); // the old place's weather goes at once
      void updateWeather();
      announceChange();
    },
  });
}

/**
 * iPhone: after the on-screen keyboard goes away, iOS can leave the page
 * scrolled a little, though it never scrolls by design; then buttons fixed
 * to the screen (the ☰ menu) are drawn in one place but answer taps in
 * another, until the app restarts. Put it back whenever the keyboard or a
 * popup goes.
 */
function keepPageInPlace(): void {
  const settle = () => {
    const typing = document.activeElement?.matches("input, textarea, select, [contenteditable]");
    if (!typing && (window.scrollY || window.scrollX)) window.scrollTo(0, 0);
  };
  window.visualViewport?.addEventListener("resize", () => window.setTimeout(settle, 50));
  document.addEventListener("focusout", () => window.setTimeout(settle, 100));
  document.addEventListener("close", () => window.setTimeout(settle, 50), true);
  window.addEventListener("scroll", () => window.setTimeout(settle, 100), { passive: true });
}

/** Phones: the ‹ › buttons beside the title; otherwise in the toolbar. */
function placeArrows(): void {
  const phone = window.matchMedia("(max-width: 640px)");
  const arrows = document.querySelector<HTMLElement>(".nav-buttons")!;
  const place = () => {
    if (phone.matches) document.querySelector("#title-row")!.append(arrows);
    else toolbar.prepend(arrows);
  };
  phone.addEventListener("change", place);
  place();
}

/** The phone's ☰ menu: the views, Refresh and Settings. */
function setUpMenu(): void {
  closeMenu = setUpDockMenu(menuButton, menu, (line) => [
    ...VIEW_ORDER.map((name) => line(viewLabel(name), () => switchView(name), name === state.view)),
    el("hr", "menu-line"),
    line("Refresh", () => void load()),
    el("hr", "menu-line"),
    line("Settings…", showSettings),
  ]);
}

function setUpControls(): void {
  for (const name of VIEW_ORDER) {
    const button = el("button");
    button.dataset.view = name;
    button.addEventListener("click", () => switchView(name));
    viewSwitcher.append(button);
  }
  labelViews();

  // The month title doubles as the "Today" button.
  title.addEventListener("click", () => {
    if (!toolbar.hidden) showDate(new Date());
  });
  document.querySelector("#today")!.addEventListener("click", () => showDate(new Date()));
  document.querySelector("#prev")!.addEventListener("click", () => step(-1));
  document.querySelector("#next")!.addEventListener("click", () => step(1));
  refreshButton.addEventListener("click", load);
  document.querySelector("#new-event")!.addEventListener("click", () => newEvent());
  document.querySelector("#search")!.addEventListener("click", searchEvents);
  document.querySelector("#settings")!.addEventListener("click", showSettings);
  document.querySelector("#contacts")!.addEventListener("click", () => openContacts());
  document.querySelector("#dock-new")!.addEventListener("click", () => newEvent());
  document.querySelector("#dock-search")!.addEventListener("click", searchEvents);
  document.querySelector("#dock-contacts")!.addEventListener("click", () => openContacts());
  setUpMenu();
  placeArrows();

  document.addEventListener("keydown", (e) => {
    if (toolbar.hidden || document.querySelector("dialog[open]")) return;
    // Cmd+F (Ctrl+F on Windows) searches, as in most apps.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchEvents();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const key = e.key.toLowerCase();
    const view = VIEW_ORDER.find((name) => VIEWS[name].key === key);
    if (view) switchView(view);
    else if (key === "t") showDate(new Date());
    else if (key === "n") newEvent();
    else if (key === "/") searchEvents();
    else if (key === ",") showSettings();
    else if (key === "c") openContacts();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else return;
    e.preventDefault();
  });

  // Two fingers sideways on a trackpad (or Shift + mouse wheel): the next or
  // previous day, week, etc., like the arrows. One step per swipe: the
  // scrolling that carries on after the fingers lift is part of the same one.
  let sideways = 0;
  let swiped = false;
  let swipeEnded: number | undefined;
  app.addEventListener(
    "wheel",
    (e) => {
      // Week view slides through the days itself.
      if (slidingDays(state.view) !== null || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      window.clearTimeout(swipeEnded);
      swipeEnded = window.setTimeout(() => {
        sideways = 0;
        swiped = false;
      }, 200);
      if (swiped) return;
      sideways += e.deltaX;
      if (Math.abs(sideways) > 60) {
        swiped = true;
        step(sideways > 0 ? 1 : -1);
      }
    },
    { passive: false },
  );

  // Swipe left/right (touch screens) to go to the next/previous day, week, etc.
  let swipe: { x: number; y: number; time: number } | undefined;
  app.addEventListener(
    "touchstart",
    (e) => {
      const touch = e.touches[0];
      swipe = e.touches.length === 1 && slidingDays(state.view) === null ? { x: touch.clientX, y: touch.clientY, time: Date.now() } : undefined;
    },
    { passive: true },
  );
  app.addEventListener(
    "touchend",
    (e) => {
      if (!swipe) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - swipe.x;
      const dy = touch.clientY - swipe.y;
      const quick = Date.now() - swipe.time < 600;
      swipe = undefined;
      // Mostly sideways and far enough, so vertical scrolling never flips pages.
      if (quick && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
    },
    { passive: true },
  );

  // Month and year views size themselves to the window, so redraw them on resize.
  let resizeTimer: number | undefined;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if ((state.view === "month" || state.view === "year") && shown) render(shown.agenda);
    }, 150);
  });
}

async function start(): Promise<void> {
  await boot();

  // The menu bar window loads this same page (or, to preview it in a browser, add ?flyout).
  const flyoutPreview = import.meta.env.DEV && new URLSearchParams(location.search).has("flyout");
  if (window.__MINUTEMAN_FLYOUT__ || flyoutPreview) return (await import("./flyout")).startFlyout();

  setUpControls();
  // Right-click (or press and hold) an event or task: quick actions.
  setItemMenu((item, x, y) => showItemMenu(item, x, y, itemActions));
  keepPageInPlace();
  // Changed in the menu bar window: show it here too.
  document.addEventListener("visibilitychange", () => void sync());
  window.addEventListener("focus", () => void sync());
  window.addEventListener("online", () => void sync());
  onChangeElsewhere(() => {
    if (toolbar.hidden) return;
    cache.clear();
    void load();
  });
  // Contacts asked for a day (someone's birthday): in Day view. On the
  // desktop it says so from its window; elsewhere it comes as ?date=.
  if (isTauri()) {
    void listen<string>(GO_TO_DAY, (event) => {
      if (!toolbar.hidden && /^\d{4}-\d{2}-\d{2}$/.test(event.payload)) goTo("day", parseDate(event.payload));
    });
  }
  const askedDay = new URLSearchParams(location.search).get("date");
  if (askedDay && /^\d{4}-\d{2}-\d{2}$/.test(askedDay)) {
    state.view = "day";
    state.anchor = firstDay("day", parseDate(askedDay));
    history.replaceState(null, "", location.pathname);
  }
  try {
    if (await authStatus()) showCalendar();
    else showSignedOut();
  } catch (e) {
    showSignedOut(errorMessage(e));
  }
}

void start();
