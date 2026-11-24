// The small window under the menu bar icon (desktop only): a month at a
// glance with a dot on busy days, the chosen day and the six after it, and
// quick add. The Rust side creates the window (see src-tauri/src/desktop.rs)
// and tells this page when it's shown, or when ⌥⌘N wants New event.
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  authStatus,
  errorMessage,
  getAgenda,
  getSavedAgenda,
  isNotSignedIn,
  setFlyoutDetached,
  setTaskCompleted,
  showContacts,
  showMain,
  type Agenda,
  type AgendaItem,
} from "./api";
import { openDetails, showItemMenu } from "./details";
import { openSearch } from "./search";
import { openSettings } from "./settings";
import { el, setItemMenu } from "./dom";
import { openDuplicate, openEdit, openNew } from "./event-form";
import { isHidden, onHiddenChange } from "./undo";
import { announceChange, onChangeElsewhere } from "./sync";
import { refreshWeather } from "./weather";
import {
  addDays,
  addMonths,
  daysBetween,
  itemStart,
  isSameDay,
  itemsOnDay,
  overlaps,
  startOfDay,
  startOfWeek,
  toDateString,
} from "./time";
import { renderAgenda } from "./views/agenda";

/** How often to check for changes made elsewhere while it's open. */
const SYNC_EVERY_MS = 60 * 1000;
/** Days listed under the month: the chosen one and the six after it. */
const LIST_DAYS = 7;

const monthTitle = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const todayTitle = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const weekdayLetter = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });

const root = document.querySelector<HTMLElement>("#app")!;
const banner = document.querySelector<HTMLElement>("#banner")!;

const state = { month: monthOf(new Date()), selected: startOfDay(new Date()) };
let agenda: Agenda | undefined;
let latestRequest = 0;

function monthOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** The six weeks shown for `state.month`, plus the list's days if they run past them. */
function range() {
  const from = startOfWeek(state.month);
  const to = addDays(from, 42);
  const listEnd = addDays(state.selected, LIST_DAYS);
  return { from, to: listEnd > to ? listEnd : to };
}

async function load(): Promise<void> {
  // The weather comes separately; redraw when it does.
  void refreshWeather().then((fresh) => fresh && agenda && draw());
  const { from, to } = range();
  const request = ++latestRequest;
  if (!agenda) {
    const saved = await getSavedAgenda(toDateString(from), toDateString(to)).catch(() => null);
    if (saved && request === latestRequest) show(saved);
  }
  try {
    const fresh = await getAgenda(toDateString(from), toDateString(to));
    if (request === latestRequest) show(fresh);
  } catch (e) {
    if (request !== latestRequest) return;
    if (isNotSignedIn(e)) return showSignedOut();
    banner.replaceChildren(el("p", "error", errorMessage(e)));
    if (!agenda) draw();
  }
}

function show(loaded: Agenda): void {
  // Nothing new: leave it be (and the list where you'd scrolled it).
  if (agenda && JSON.stringify(agenda) === JSON.stringify(loaded)) return;
  agenda = loaded;
  banner.replaceChildren(...loaded.warnings.map((w) => el("p", "warning", `Couldn't load ${w}`)));
  if (loaded.offlineSince) banner.prepend(el("p", "warning", "No internet. Showing saved events."));
  draw();
}

function draw(): void {
  const today = startOfDay(new Date());
  const items = (agenda?.items ?? []).filter((item) => !isHidden(item));
  root.replaceChildren(header(today), miniMonth(items, today), list(items));
}

/** Icons for the header's buttons (fixed markup, no user text): the main window's, and the popup's own. */
const ICONS = {
  add: '<path d="M12 4.5v15M4.5 12h15" />',
  search: '<circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" />',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v4.5h-4.5" />',
  contacts: '<circle cx="12" cy="8.5" r="3.6" /><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" />',
  settings:
    '<circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />',
  // The whole window: a square with an arrow out of it.
  open: '<path d="M14 4h6v6M20 4l-7 7" /><path d="M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />',
  // Detach: a window lifted off another; put back: an arrow into it.
  detach: '<rect x="8" y="3.5" width="12.5" height="12.5" rx="2" /><path d="M16 20.5H5.5a2 2 0 0 1-2-2V8" />',
  attach: '<path d="M11 13l9-9M11 7v6h6" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />',
  close: '<path d="M6 6l12 12M18 6 6 18" />',
};

function iconButton(icon: keyof typeof ICONS, label: string, onClick: () => void): HTMLButtonElement {
  const button = el("button", "icon-button");
  button.innerHTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

/**
 * The header's buttons, in the order every Minuteman window has them: New,
 * Search, Refresh, the other app (Contacts), Settings; then the popup's own:
 * the whole window, detach (or put back), and close when detached.
 */
function header(today: Date): HTMLElement {
  const head = el("header", "flyout-head");
  const titles = el("div");
  titles.append(el("h1", "flyout-title", "Today"), el("p", "flyout-date", todayTitle.format(today)));
  // Dragging the header moves the window, which detaches it (the Rust side
  // notices the move).
  head.addEventListener("mousedown", (e) => {
    if (isTauri() && e.button === 0 && e.detail === 1 && !(e.target as Element).closest("button")) {
      e.preventDefault();
      void getCurrentWebviewWindow().startDragging();
    }
  });
  const add = iconButton("add", "New event (⌥⌘N)", newEvent);
  const find = iconButton("search", "Search (/)", search);
  const refresh = iconButton("refresh", "Refresh", () => void load());
  const contacts = iconButton("contacts", "Contacts (⌥⌘K)", () => void showContacts());
  const settings = iconButton("settings", "Settings (,)", settingsHere);
  const open = iconButton("open", "Open Minuteman", () => void showMain());
  // Only one of these two shows, by whether the window is detached.
  const detachButton = iconButton("detach", "Detach into its own window", () => void detach(true));
  detachButton.classList.add("fly-detach");
  const attachButton = iconButton("attach", "Put back under the menu bar icon", () => void detach(false));
  attachButton.classList.add("fly-attach");
  const close = iconButton("close", "Close", () => void getCurrentWebviewWindow().hide());
  close.classList.add("fly-close");
  const buttons = el("div", "actions");
  buttons.append(add, find, refresh, contacts, settings, open);
  if (isTauri()) buttons.append(detachButton, attachButton, close);
  head.append(titles, buttons);
  return head;
}

/** Search, here: a result picked shows its day here, then its details. */
function search(): void {
  openSearch((item) => {
    select(startOfDay(itemStart(item)));
    openDetails(item, itemActions);
  });
}

/** Settings, here (as in the main window); what's changed is fetched again. */
function settingsHere(): void {
  const again = () => {
    announceChange();
    void load();
  };
  void openSettings({
    accountsChanged: (signedIn) => (signedIn ? again() : showSignedOut()),
    todoistChanged: again,
    daysChanged: () => undefined,
    sourcesChanged: again,
    weatherChanged: () => void refreshWeather().then(draw),
  });
}

/** Detaches the window (it stays open, where you put it) or puts it back. */
async function detach(detached: boolean): Promise<void> {
  document.body.classList.toggle("detached", detached);
  await setFlyoutDetached(detached);
}

function miniMonth(items: AgendaItem[], today: Date): HTMLElement {
  const box = el("section", "fly-month");
  const nav = el("div", "fly-nav");
  const prev = el("button", "icon-button", "‹");
  prev.setAttribute("aria-label", "Previous month");
  prev.addEventListener("click", () => goToMonth(-1));
  const next = el("button", "icon-button", "›");
  next.setAttribute("aria-label", "Next month");
  next.addEventListener("click", () => goToMonth(1));
  nav.append(prev, el("h2", "fly-month-title", monthTitle.format(state.month)), next);

  const grid = el("div", "fly-grid");
  const first = startOfWeek(state.month);
  for (let i = 0; i < 7; i++) grid.append(el("span", "fly-weekday", weekdayLetter.format(addDays(first, i))));
  for (let i = 0; i < 42; i++) {
    const day = addDays(first, i);
    const cell = el("button", "fly-day", String(day.getDate()));
    if (day.getMonth() !== state.month.getMonth()) cell.classList.add("other-month");
    if (isSameDay(day, today)) cell.classList.add("today");
    if (isSameDay(day, state.selected)) cell.setAttribute("aria-pressed", "true");
    if (itemsOnDay(items, day).some((item) => !item.completed)) cell.classList.add("busy");
    cell.addEventListener("click", () => select(day));
    grid.append(cell);
  }
  box.append(nav, grid);
  return box;
}

function list(items: AgendaItem[]): HTMLElement {
  const box = el("div", "flyout-list");
  const from = state.selected;
  const to = addDays(from, LIST_DAYS);
  renderAgenda(box, {
    // Only these days: the list puts anything that began earlier on the first day.
    items: items.filter((item) => overlaps(item, from, to)),
    from,
    to,
    anchor: state.selected,
    now: new Date(),
    preserveScroll: false,
    goTo: () => {},
    toggleTask,
    openItem: showDetails,
    moveItem: () => {},
  });
  return box;
}

function select(day: Date): void {
  state.selected = day;
  if (day.getMonth() !== state.month.getMonth()) state.month = monthOf(day);
  // Already loaded, unless the list now runs past what was fetched.
  draw();
  void load();
}

function goToMonth(direction: 1 | -1): void {
  state.month = addMonths(state.month, direction);
  const today = startOfDay(new Date());
  state.selected = daysBetween(monthOf(today), state.month) === 0 ? today : state.month;
  draw();
  void load();
}

/** Back to today, e.g. each time the window opens. */
function reset(): void {
  state.month = monthOf(new Date());
  state.selected = startOfDay(new Date());
  void load();
}

async function toggleTask(item: AgendaItem): Promise<void> {
  try {
    await setTaskCompleted(item.id, !item.completed);
    changed();
  } catch (e) {
    banner.replaceChildren(el("p", "error", `Couldn't update "${item.title}": ${errorMessage(e)}`));
  }
}

function changed(): void {
  announceChange();
  void load();
}

const itemActions = {
  toggleTask,
  edit: (it: AgendaItem) => openEdit(it, changed),
  duplicate: (it: AgendaItem) => openDuplicate(it, changed),
  convert: (it: AgendaItem) => openEdit(it, changed, it.kind === "task" ? "event" : "task"),
  deleted: changed,
  changed,
  open: (it: AgendaItem) => showDetails(it),
};

function showDetails(item: AgendaItem): void {
  openDetails(item, itemActions);
}

function newEvent(): void {
  openNew(({ start }) => {
    if (start) select(startOfDay(start));
    changed();
  });
}

function showSignedOut(): void {
  agenda = undefined;
  banner.replaceChildren();
  const view = el("div", "sign-in");
  view.append(el("p", "sign-in-text", "Sign in to Google in the main window to see your calendars here."));
  const open = el("button", "primary-button", "Open Minuteman");
  open.addEventListener("click", () => void showMain());
  view.append(open);
  root.replaceChildren(view);
}

export async function startFlyout(): Promise<void> {
  document.body.classList.add("flyout");
  onHiddenChange(draw);
  // Right-click (or press and hold) an event or task: quick actions.
  setItemMenu((item, x, y) => showItemMenu(item, x, y, itemActions));
  // Its own header replaces the main window's.
  for (const node of document.querySelectorAll<HTMLElement>(".chrome")) node.hidden = true;

  if (isTauri()) {
    void listen("flyout-shown", () => {
      if (!document.querySelector("dialog[open]")) reset();
    });
    void listen("flyout-detached", () => document.body.classList.add("detached"));
    void listen("flyout-new", () => {
      document.querySelector<HTMLDialogElement>("dialog[open]")?.close();
      reset();
      newEvent();
    });
  }
  onChangeElsewhere(() => void load());
  window.setInterval(() => {
    if (!document.hidden && agenda && !document.querySelector("dialog[open]")) void load();
  }, SYNC_EVERY_MS);

  // Esc closes it, like a menu (once any popup in it is closed).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.querySelector("dialog[open]") && isTauri()) {
      void getCurrentWebviewWindow().hide();
    }
  });

  try {
    if (await authStatus()) void load();
    else showSignedOut();
  } catch (e) {
    root.replaceChildren(el("p", "error", errorMessage(e)));
  }
}
