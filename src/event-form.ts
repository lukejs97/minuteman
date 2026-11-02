// The New and Edit window for events and tasks. New: type a sentence and the
// fields below fill in as you type; any field can also be set directly, and
// from then on the sentence leaves that field alone. Edit: the same fields,
// filled in from the item.
import {
  createEvent,
  endSeriesBefore,
  createTask,
  errorMessage,
  eventCalendars,
  eventRecurrence,
  eventRef,
  getPreferences,
  routesKeyStatus,
  todoistProjects,
  todoistStatus,
  updateEvent,
  updateTask,
  type AgendaItem,
  type Alerts,
  type EventDraft,
  type TaskDraft,
  type TaskDue,
} from "./api";
import { AlertEditor } from "./alert-editor";
import { askSeriesChoice } from "./series";
import { el } from "./dom";
import { EVENT_COLORS } from "./event-colors";
import { enablePlaceSuggestions, findPlace, type PlaceSuggestion } from "./place-suggest";
import { parseEvent, parseTask, REPEAT_RULES, type Repeat } from "./quick-parse";
import { describeRecurrence, endAfter } from "./recurrence";
import {
  addDays,
  floatingZone,
  placeOnOneLine,
  itemEnd,
  itemStart,
  localTimeZone,
  parseDate,
  sameClockIn,
  toDateString,
  toLocalIso,
} from "./time";

export type Mode = "event" | "task";

/** When the saved event or task is (null for a task without a date). */
export interface Saved {
  start: Date | null;
  allDay: boolean;
}

const CALENDAR_STORAGE_KEY = "calendar.newEventCalendar";
const PROJECT_STORAGE_KEY = "calendar.newTaskProject";

const REPEAT_OPTIONS: [Repeat | "", string][] = [
  ["", "Doesn't repeat"],
  ["daily", "Every day"],
  ["weekdays", "Every weekday"],
  ["weekly", "Every week"],
  ["biweekly", "Every 2 weeks"],
  ["monthly", "Every month"],
  ["yearly", "Every year"],
];

const PRIORITY_OPTIONS: [string, string][] = [
  ["1", "Priority 1 (urgent)"],
  ["2", "Priority 2"],
  ["3", "Priority 3"],
  ["4", "Priority 4 (normal)"],
];

interface CalendarChoice {
  email: string;
  calendarId: string;
}

/** Opens the New window. */
/** A day (and maybe a time) to add at, e.g. where you double-clicked. */
export interface At {
  start: Date;
  allDay: boolean;
}

/** `sentence`: starts the sentence box with it, e.g. "Meeting with Sam Lee with sam@example.com". */
export function openNew(
  onSaved: (saved: Saved) => void,
  mode: Mode = "event",
  at: At | null = null,
  sentence = "",
): void {
  new Form(onSaved, mode, null, at, sentence).open();
}

/** Opens the New window filled in like `item`: a copy to change and add. */
export function openDuplicate(item: AgendaItem, onSaved: (saved: Saved) => void): void {
  new Form(onSaved, item.kind === "task" ? "task" : "event", null, null, "", item).open();
}

/** Opens the Edit window for an event or task. */
export function openEdit(item: AgendaItem, onSaved: (saved: Saved) => void): void {
  new Form(onSaved, item.kind === "task" ? "task" : "event", item).open();
}

function option(value: string, text: string): HTMLOptionElement {
  return new Option(text, value);
}

function select(options: [string, string][]): HTMLSelectElement {
  const node = el("select", "text-input");
  node.append(...options.map(([value, text]) => option(value, text)));
  return node;
}

/** Not places, after "at" or "in": "at the moment", "in my car", "at home". */
const NOT_PLACES = new Set(
  "the a an my your his her our their its this that some least last first all once home work school office length time person mind".split(" "),
);

/**
 * A lowercase place at the end of a title ("coffee at starbucks", "dinner
 * in boston"), to look up; capitalised ones are found by `parseEvent`.
 */
export function placeAtEnd(title: string): { title: string; place: string } | null {
  const m = /^(.*\S)\s+(?:at|in)\s+([a-z0-9][^,;:!?]{1,40})$/i.exec(title);
  if (!m) return null;
  const place = m[2].trim();
  const first = place.split(/\s+/);
  if (place.length < 3 || first.length > 5 || NOT_PLACES.has(first[0].toLowerCase()) || /^\d+$/.test(place)) return null;
  return { title: m[1], place };
}

function input(type: string, placeholder = ""): HTMLInputElement {
  const node = el("input", "text-input");
  node.type = type;
  node.placeholder = placeholder;
  node.autocomplete = "off";
  return node;
}

/** "HH:MM" in local time. */
function timeString(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A local date from date and time fields ("YYYY-MM-DD", "HH:MM"). */
function combine(date: string, time: string): Date {
  const day = parseDate(date);
  const [h, m] = (time || "00:00").split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

/** Plain text from notes that may be HTML (for editing them). */
function plainText(notes: string | null): string {
  if (!notes) return "";
  if (!/<[a-z][\s\S]*>/i.test(notes)) return notes;
  const doc = new DOMParser().parseFromString(notes.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n"), "text/html");
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

class Form {
  private dialog = el("dialog", "dialog event-form");
  private title = el("h2");
  private sentence = input("text");
  private error = el("p", "error");
  private save = el("button", "primary-button", "Add");
  /** Fields set by hand, which the sentence no longer changes. */
  private touched = new Set<string>();
  /** Places named in the sentence, looked up: where each is, or null if it isn't one. */
  private placeLookups = new Map<string, PlaceSuggestion | null>();
  private placeTimer: number | undefined;
  private eventFields = el("div", "form-grid");
  private taskFields = el("div", "form-grid");
  private modeButtons: [Mode, HTMLButtonElement][] = [];

  // Event fields
  private eventTitle = input("text", "Title");
  private allDay = el("input");
  /** Keeps its clock time in any time zone. */
  private floating = el("input");
  private floatingLabel = el("label", "form-check");
  private startDate = input("date");
  private startTime = input("time");
  private endDate = input("date");
  private endTime = input("time");
  private location = input("text", "Place or video link");
  /** Where this event's drive starts, when it isn't the address in Settings. */
  private leaveFrom = input("text", "Set a default in Settings");
  private leaveHint = el("div", "form-notes", "Where you start from, if it isn't the address in Settings.");
  private repeat = select(REPEAT_OPTIONS);
  /**
   * For one event in a repeating series: change just it, it and the ones
   * after it, or all of them. Asked when you save, as Google Calendar does.
   */
  private seriesChoice: "one" | "following" | "all" = "one";
  private alerts = new AlertEditor(
    () => this.touched.add("alert"),
    () => this.startValue(),
  );
  private guests = input("text", "Email addresses, separated by commas");
  private eventNotes = el("textarea", "text-input");
  private calendar = el("select", "text-input");
  private calendarNotes = el("div", "form-notes");
  private notifyGuests = el("input");
  private notifyRow = el("label", "form-check");
  private calendarChoices: CalendarChoice[] = [];
  /** Each calendar choice's color, for the "calendar's color" swatch. */
  private calendarColors: (string | null)[] = [];
  /** The event's own color ("1" to "11"), or "" for its calendar's. */
  private colorId = "";
  private colorPicker = el("div", "color-choices");
  private calendarsReady = false;

  // Task fields
  private taskName = input("text", "Name");
  private dueDate = input("date");
  private dueTime = input("time");
  private repeatWords = el("span");
  private repeatRow = el("div", "form-note-row");
  private priority = select(PRIORITY_OPTIONS);
  private project = el("select", "text-input");
  private projectNotes = el("div", "form-notes");
  private taskNotes = el("textarea", "text-input");
  private projectsReady = false;
  private projectsRequested = false;
  /** A repeat in Todoist's own words, from the sentence. */
  private taskRepeat: string | null = null;
  /** A repeating event's series' rules, once fetched (to show them, or end them). */
  private seriesRules: string[] | null = null;

  constructor(
    private onSaved: (saved: Saved) => void,
    private mode: Mode,
    /** The item being edited; null when adding. */
    private item: AgendaItem | null,
    /** When adding: the day (and time) chosen, if any; a date in the sentence wins. */
    private at: At | null = null,
    /** When adding: what the sentence box starts with. */
    private startSentence = "",
    /** When duplicating: the event or task it's a copy of. */
    private copyOf: AgendaItem | null = null,
  ) {}

  open(): void {
    const { dialog } = this;
    dialog.setAttribute("aria-labelledby", "form-title");
    this.title.id = "form-title";
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove());

    const header = el("div", "quick-header");
    header.append(this.title);
    if (!this.item && !this.copyOf) {
      const switcher = el("div", "segmented");
      switcher.role = "group";
      switcher.setAttribute("aria-label", "Add an event or a task");
      for (const m of ["event", "task"] as const) {
        const button = el("button", undefined, m === "event" ? "Event" : "Task");
        button.type = "button";
        button.addEventListener("click", () => this.setMode(m));
        switcher.append(button);
        this.modeButtons.push([m, button]);
      }
      header.append(switcher);
    }

    this.buildEventFields();
    this.buildTaskFields();

    const cancel = el("button", "text-button", "Cancel");
    cancel.type = "button"; // not "submit", which a button inside the form would be
    cancel.addEventListener("click", () => dialog.close());
    this.save.textContent = this.item ? "Save" : "Add";
    const buttons = el("div", "dialog-buttons");
    buttons.append(cancel, this.save);

    const form = el("form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.submit();
    });
    if (!this.item && !this.copyOf) {
      this.sentence.setAttribute("aria-label", "Describe it in a sentence");
      this.sentence.addEventListener("input", () => this.fromSentence());
      this.sentence.value = this.startSentence;
      form.append(this.sentence);
    }
    form.append(this.eventFields, this.taskFields, this.error, buttons);
    dialog.append(header, form);
    dialog.showModal();

    if (this.item) this.fillFromItem(this.item);
    else if (this.copyOf) this.fillFromItem(this.copyOf, true);
    else this.fillDefaults();
    void this.loadCalendars();
    void this.loadLeaveDefault();
    this.setMode(this.mode);
  }

  // ---------- Layout ----------

  private row(grid: HTMLElement, label: string, ...controls: (HTMLElement | string)[]): HTMLElement {
    const name = el("span", "form-label", label);
    const box = el("div", "form-controls");
    box.append(...controls);
    grid.append(name, box);
    return box;
  }

  /** Google Calendar's event colors as swatches, the first being the calendar's own. */
  private buildColorPicker(): void {
    const picker = this.colorPicker;
    picker.setAttribute("role", "radiogroup");
    picker.setAttribute("aria-label", "Event color");
    const choices = [{ id: "", name: "Calendar's color", color: null as string | null }, ...EVENT_COLORS];
    for (const choice of choices) {
      const swatch = el("button", "color-choice");
      swatch.type = "button";
      swatch.setAttribute("role", "radio");
      swatch.title = choice.name;
      swatch.setAttribute("aria-label", choice.name);
      swatch.dataset.id = choice.id;
      if (choice.color) swatch.style.setProperty("--swatch", choice.color);
      else swatch.classList.add("calendar-color");
      swatch.addEventListener("click", () => {
        this.touched.add("color");
        this.setColor(choice.id);
      });
      picker.append(swatch);
    }
    this.setColor(this.colorId);
  }

  private setColor(id: string): void {
    this.colorId = id;
    for (const swatch of this.colorPicker.querySelectorAll<HTMLElement>(".color-choice")) {
      swatch.setAttribute("aria-checked", String(swatch.dataset.id === id));
    }
  }

  /** The "calendar's color" swatch, in the chosen calendar's color. */
  private showCalendarColor(): void {
    const color = this.calendarColors[Number(this.calendar.value)];
    if (color) this.colorPicker.style.setProperty("--calendar-color", color);
    else this.colorPicker.style.removeProperty("--calendar-color");
  }

  /** Marks `name` as set by hand whenever one of `controls` changes. */
  private track(name: string, ...controls: HTMLElement[]): void {
    for (const control of controls) {
      control.addEventListener("input", () => this.touched.add(name));
      control.addEventListener("change", () => this.touched.add(name));
    }
  }

  private buildEventFields(): void {
    const grid = this.eventFields;
    this.allDay.type = "checkbox";
    const allDayLabel = el("label", "form-check");
    allDayLabel.append(this.allDay, " All day");
    this.floating.type = "checkbox";
    this.floatingLabel.title =
      "Stays at this time wherever you are: 9 AM is 9 AM in any time zone. (Only in Minuteman: Google's own apps show it fixed.)";
    this.floatingLabel.append(this.floating, " Same time in any time zone");
    this.eventNotes.rows = 3;
    this.notifyGuests.type = "checkbox";
    this.notifyGuests.checked = true;
    this.notifyRow.append(this.notifyGuests, " Email guests about the changes");

    this.row(grid, "Title", this.eventTitle);
    this.row(grid, "Starts", this.startDate, this.startTime, allDayLabel);
    this.row(grid, "Ends", this.endDate, this.endTime, this.floatingLabel);
    this.row(grid, "Where", this.location);
    this.row(grid, "Leave from", this.leaveFrom, this.leaveHint);
    enablePlaceSuggestions(this.location);
    enablePlaceSuggestions(this.leaveFrom);
    this.row(grid, "Repeat", this.repeat);
    const alertRow = this.row(grid, "Alert", this.alerts.root);
    alertRow.previousElementSibling?.classList.add("alert-label");
    this.row(grid, "Guests", this.guests);
    this.row(grid, "Notes", this.eventNotes);
    this.row(grid, "Calendar", this.calendar, this.calendarNotes);
    this.row(grid, "Color", this.colorPicker);
    this.buildColorPicker();
    this.calendar.addEventListener("change", () => this.showCalendarColor());
    if (this.item) grid.append(el("span"), this.notifyRow);

    this.track("title", this.eventTitle);
    this.track("when", this.allDay, this.startDate, this.startTime, this.endDate, this.endTime);
    this.track("floating", this.floating);
    this.track("location", this.location);
    this.track("leaveFrom", this.leaveFrom);
    this.track("repeat", this.repeat);
    this.track("guests", this.guests);
    this.track("notes", this.eventNotes);
    this.track("calendar", this.calendar);

    this.allDay.addEventListener("change", () => this.showTimes());
    // Moving the start keeps the length, as in most calendars.
    let previousStart = this.startValue();
    const keepLength = () => {
      const start = this.startValue();
      const end = this.endValue();
      if (previousStart && start && end) this.setEnd(new Date(end.getTime() + (start.getTime() - previousStart.getTime())));
      previousStart = this.startValue();
    };
    this.startDate.addEventListener("change", keepLength);
    this.startTime.addEventListener("change", keepLength);
    this.startDate.addEventListener("focus", () => (previousStart = this.startValue()));
    this.startTime.addEventListener("focus", () => (previousStart = this.startValue()));
    this.calendar.addEventListener("change", () => {
      if (!this.item && !this.copyOf) save(CALENDAR_STORAGE_KEY, this.calendarChoices[Number(this.calendar.value)]);
    });
  }

  /** The placeholder is the address in Settings, once that's known. */
  private async loadLeaveDefault(): Promise<void> {
    const [prefs, key] = await Promise.all([getPreferences().catch(() => null), routesKeyStatus().catch(() => null)]);
    if (!this.leaveFrom.isConnected) return;
    const address = prefs?.leaveFrom?.trim() ?? "";
    this.leaveFrom.placeholder = prefs?.leaveFromHere ? "Where you are" : address || "Set a default in Settings";
    const traffic = key?.configured ? "" : " Live traffic isn't set up, so leave-by times stay hidden until it is.";
    this.leaveHint.textContent = prefs?.leaveFromHere
      ? `Starts from where you are when this is empty${address ? ` (or “${address}” if your location isn't available)` : ""}.${traffic}`
      : address
        ? `Uses “${address}” from Settings when this is empty.${traffic}`
        : `Set a default address in Settings, or type one here.${traffic}`;
  }

  private buildTaskFields(): void {
    const grid = this.taskFields;
    this.taskNotes.rows = 3;
    const clear = el("button", "link-button", "Remove");
    clear.type = "button";
    clear.addEventListener("click", () => {
      this.taskRepeat = null;
      this.touched.add("due");
      this.showTaskRepeat();
    });
    this.repeatRow.append("Repeats: ", this.repeatWords, " ", clear);

    this.row(grid, "Name", this.taskName);
    const due = this.row(grid, "Due", this.dueDate, this.dueTime, this.repeatRow);
    if (this.item?.recurring) {
      this.dueDate.disabled = this.dueTime.disabled = true;
      due.append(el("p", "form-notes", "This task repeats; change its schedule in Todoist."));
    }
    this.row(grid, "Priority", this.priority);
    this.row(grid, "Project", this.project, this.projectNotes);
    this.row(grid, "Notes", this.taskNotes);

    this.track("title", this.taskName);
    this.track("due", this.dueDate, this.dueTime);
    this.track("priority", this.priority);
    this.track("project", this.project);
    this.track("notes", this.taskNotes);
    // Typing a date by hand replaces a repeat from the sentence.
    this.dueDate.addEventListener("input", () => {
      this.taskRepeat = null;
      this.showTaskRepeat();
    });
    this.project.addEventListener("change", () => {
      if (!this.item && !this.copyOf) save(PROJECT_STORAGE_KEY, this.project.value);
    });
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    const event = mode === "event";
    this.title.textContent = this.item
      ? event
        ? "Edit event"
        : "Edit task"
      : this.copyOf
        ? event
          ? "Duplicate event"
          : "Duplicate task"
        : event
          ? "New event"
          : "New task";
    this.sentence.placeholder = event ? "Lunch with Sam tomorrow 1pm at Cafe Roma" : "Submit expenses Friday p1";
    this.eventFields.hidden = !event;
    this.taskFields.hidden = event;
    for (const [m, button] of this.modeButtons) button.setAttribute("aria-pressed", String(m === mode));
    if (!event && !this.projectsRequested) {
      this.projectsRequested = true;
      void this.loadProjects();
    }
    this.error.textContent = "";
    this.fromSentence();
    this.updateSaveButton();
    (this.item || this.copyOf ? (event ? this.eventTitle : this.taskName) : this.sentence).focus();
    // Started with a sentence: carry on typing at its end.
    if (!this.item) this.sentence.setSelectionRange(this.sentence.value.length, this.sentence.value.length);
  }

  private showTimes(): void {
    const timed = !this.allDay.checked;
    this.startTime.hidden = this.endTime.hidden = !timed;
    // All-day events are the same days anywhere already.
    this.floatingLabel.hidden = !timed;
  }

  private showTaskRepeat(): void {
    this.repeatRow.hidden = !this.taskRepeat;
    this.repeatWords.textContent = this.taskRepeat ?? "";
    this.dueDate.hidden = this.dueTime.hidden = Boolean(this.taskRepeat);
  }

  private updateSaveButton(): void {
    const ready = this.mode === "event" ? this.calendarsReady || Boolean(this.item) : this.projectsReady;
    this.save.disabled = !ready;
  }

  // ---------- Values ----------

  private startValue(): Date | null {
    if (!this.startDate.value) return null;
    return this.allDay.checked ? parseDate(this.startDate.value) : combine(this.startDate.value, this.startTime.value);
  }

  /** For all-day events, the midnight after the last day. */
  private endValue(): Date | null {
    if (!this.endDate.value) return null;
    return this.allDay.checked
      ? addDays(parseDate(this.endDate.value), 1)
      : combine(this.endDate.value, this.endTime.value);
  }

  private setWhen(start: Date, end: Date, allDay: boolean): void {
    this.allDay.checked = allDay;
    this.startDate.value = toDateString(start);
    this.startTime.value = timeString(start);
    this.setEnd(end);
    this.showTimes();
  }

  /** `end` as for an event (all-day: the midnight after the last day). */
  private setEnd(end: Date): void {
    const shown = this.allDay.checked ? addDays(end, -1) : end;
    this.endDate.value = toDateString(shown);
    this.endTime.value = timeString(end);
  }

  private fillDefaults(): void {
    const { at } = this;
    if (at?.allDay) {
      this.setWhen(at.start, addDays(at.start, 1), true);
    } else {
      // The time chosen, or else the next whole hour; for an hour.
      const start = at ? new Date(at.start) : new Date();
      if (!at) start.setHours(start.getHours() + 1, 0, 0, 0);
      this.setWhen(start, new Date(start.getTime() + 60 * 60 * 1000), false);
    }
    this.fillDueFromAt();
    this.alerts.setDefault();
    this.priority.value = "4";
    this.showTaskRepeat();
  }

  /** A new task's due date (and time): the day chosen, or else today. */
  private fillDueFromAt(): void {
    this.dueDate.value = toDateString(this.at ? this.at.start : new Date());
    this.dueTime.value = this.at && !this.at.allDay ? timeString(this.at.start) : "";
  }

  /** `copy`: for a duplicate, a new item that doesn't repeat. */
  private fillFromItem(item: AgendaItem, copy = false): void {
    if (item.kind === "task") {
      this.taskName.value = item.title;
      const start = itemStart(item);
      this.dueDate.value = toDateString(start);
      this.dueTime.value = item.allDay ? "" : timeString(start);
      this.priority.value = String(item.priority ?? 4);
      this.taskNotes.value = item.description ?? "";
      this.showTaskRepeat();
      return;
    }
    this.eventTitle.value = item.title;
    this.setWhen(itemStart(item), itemEnd(item), item.allDay);
    this.floating.checked = Boolean(item.floating);
    // One line (an address saved earlier with line breaks would run together here).
    this.location.value = placeOnOneLine(item.location) ?? "";
    this.leaveFrom.value = item.leaveFrom ?? "";
    this.eventNotes.value = plainText(item.description);
    this.guests.value = item.attendees
      .filter((a) => !a.isSelf && !a.organizer && a.email)
      .map((a) => a.email)
      .join(", ");
    this.alerts.setFromItem(item);
    this.setColor(item.colorId ?? "");
    if (copy) {
      // A one-off copy; Repeat can make it repeat.
    } else if (this.inSeries()) {
      // "keep" leaves the series' rule be; it's shown in words once fetched.
      // "end" makes this the last one (the ones before it stay).
      this.repeat.querySelector('option[value=""]')?.remove();
      const keep = option("keep", "Repeats (as now)");
      this.repeat.prepend(keep, option("end", "Doesn't repeat after this one"));
      this.repeat.value = "keep";
      void this.seriesRecurrence().then((rules) => {
        const words = rules && describeRecurrence(rules, itemStart(item));
        if (words) keep.textContent = words;
      });
    } else if (item.recurring) {
      this.repeat.replaceChildren(option("", "Repeats"));
      this.repeat.disabled = true;
    }
    this.notifyRow.hidden = !item.attendees.some((a) => !a.isSelf);
  }

  /** Looks up a place named in the sentence once typing pauses, then fills in from the sentence again. */
  private lookUpPlace(place: string): void {
    window.clearTimeout(this.placeTimer);
    this.placeTimer = window.setTimeout(async () => {
      const found = await findPlace(place);
      this.placeLookups.set(place, found);
      if (this.sentence.isConnected && this.mode === "event") this.fromSentence();
    }, 400);
  }

  /** Fills in every field not yet set by hand from the sentence. */
  private fromSentence(): void {
    if (this.item) return;
    const text = this.sentence.value;
    const now = new Date();
    if (this.mode === "event") {
      const parsed = text.trim() ? parseEvent(text, now) : null;
      if (!parsed) return;
      let { title, location } = parsed;
      /** What to look up once typing pauses, if anything (a word half typed is dropped). */
      let lookUp: string | null = null;
      // "coffee at starbucks": a place only if one nearby is called that.
      const guess = location ? null : placeAtEnd(title);
      if (guess) {
        const known = this.placeLookups.get(guess.place);
        if (known) [title, location] = [guess.title, known.name ?? guess.place];
        else if (known === undefined) lookUp = guess.place;
      }
      if (!this.touched.has("title")) this.eventTitle.value = title;
      if (!this.touched.has("when") && parsed.dated) this.setWhen(parsed.start, parsed.end, parsed.allDay);
      if (!this.touched.has("location")) {
        // Where it actually is, once looked up: "Old North Church, 193 Salem St, Boston, MA 02113".
        const found = location ? this.placeLookups.get(location) : null;
        this.location.value = found?.street ? found.line : (location ?? "");
        if (location && found === undefined) lookUp = location;
      }
      if (lookUp) this.lookUpPlace(lookUp);
      else window.clearTimeout(this.placeTimer);
      if (!this.touched.has("repeat")) this.repeat.value = parsed.repeat ?? "";
      if (!this.touched.has("alert")) this.alerts.setFromSentence(parsed.alert);
      if (!this.touched.has("guests")) this.guests.value = parsed.guests.join(", ");
    } else {
      const parsed = text.trim() ? parseTask(text, now) : null;
      if (!parsed) return;
      if (!this.touched.has("title")) this.taskName.value = parsed.title;
      if (!this.touched.has("due")) {
        this.taskRepeat = parsed.repeat;
        if (parsed.due) {
          this.dueDate.value = toDateString(parsed.due.start);
          this.dueTime.value = parsed.due.allDay ? "" : timeString(parsed.due.start);
        } else {
          this.fillDueFromAt(); // no date in the sentence: the day chosen, or today
        }
        this.showTaskRepeat();
      }
      if (!this.touched.has("priority")) this.priority.value = String(parsed.priority ?? 4);
    }
  }

  // ---------- Pickers ----------

  /** Calendars you can add events to. When editing, only the event's own account's. */
  private async loadCalendars(): Promise<void> {
    const { calendar, calendarNotes } = this;
    calendar.replaceChildren(option("", "Loading calendars…"));
    calendar.disabled = true;
    try {
      const accounts = await eventCalendars();
      const saved = load<CalendarChoice>(CALENDAR_STORAGE_KEY);
      const choices: CalendarChoice[] = [];
      let chosen = -1;
      const notes: string[] = [];
      calendar.replaceChildren();
      for (const account of accounts) {
        if (this.item && account.email !== this.item.account) continue;
        if (account.error) notes.push(`Couldn't load ${account.email}'s calendars: ${account.error}`);
        else if (!account.canEdit) {
          notes.push(`To add events to ${account.email}, add it again under Accounts so Google can ask for permission.`);
        }
        if (account.calendars.length === 0) continue;
        const group = document.createElement("optgroup");
        group.label = account.email;
        for (const cal of account.calendars) {
          const index = choices.push({ email: account.email, calendarId: cal.id }) - 1;
          this.calendarColors[index] = cal.color ?? null;
          group.append(option(String(index), cal.name));
          // Editing or duplicating: its own calendar; otherwise the one used last.
          const source = this.item ?? this.copyOf;
          const want = source?.account ? { email: source.account, calendarId: source.listId } : saved;
          if (want?.email === account.email && want.calendarId === cal.id) chosen = index;
          if (chosen < 0 && !this.item && cal.primary) chosen = index;
        }
        calendar.append(group);
      }
      this.calendarChoices = choices;
      calendarNotes.replaceChildren(...notes.map((text) => el("p", undefined, text)));
      if (choices.length === 0) calendar.append(option("", "No calendars to add to"));
      else {
        calendar.value = String(Math.max(chosen, 0));
        this.showCalendarColor();
        calendar.disabled = false;
        this.calendarsReady = true;
      }
    } catch (err) {
      calendar.replaceChildren(option("", "Couldn't load calendars"));
      calendarNotes.replaceChildren(el("p", "error", errorMessage(err)));
    }
    this.updateSaveButton();
  }

  private async loadProjects(): Promise<void> {
    const { project, projectNotes } = this;
    project.replaceChildren(option("", "Loading projects…"));
    project.disabled = true;
    try {
      if (!(await todoistStatus())) {
        project.replaceChildren(option("", "Todoist isn't connected"));
        projectNotes.replaceChildren(el("p", undefined, "Connect Todoist first: click Todoist in the top bar."));
        this.updateSaveButton();
        return;
      }
      const projects = await todoistProjects();
      project.replaceChildren(...projects.map((p) => option(p.id, p.name)));
      const source = this.item ?? this.copyOf;
      const want = source ? source.listId : load<string>(PROJECT_STORAGE_KEY);
      if (want && projects.some((p) => p.id === want)) project.value = want;
      project.disabled = false;
      this.projectsReady = true;
    } catch (err) {
      project.replaceChildren(option("", "Couldn't load projects"));
      projectNotes.replaceChildren(el("p", "error", errorMessage(err)));
    }
    this.updateSaveButton();
  }

  // ---------- Saving ----------

  private async submit(): Promise<void> {
    this.error.textContent = "";
    let saved: Saved;
    try {
      saved = this.mode === "event" ? this.checkEvent() : this.checkTask();
    } catch (problem) {
      this.error.textContent = String((problem as Error).message ?? problem);
      return;
    }
    if (this.mode === "event" && this.inSeries()) {
      const choice = await this.askSeriesChoice();
      if (!choice) return; // cancelled: back to the form
      this.seriesChoice = choice;
    }
    this.save.disabled = true;
    this.save.textContent = this.item ? "Saving…" : "Adding…";
    try {
      if (this.mode === "event") await this.saveEvent();
      else await this.saveTask();
      this.dialog.close();
      this.onSaved(saved);
    } catch (err) {
      this.error.textContent = errorMessage(err);
      this.save.disabled = false;
      this.save.textContent = this.item ? "Save" : "Add";
    }
  }

  /**
   * Which events of the series to change, as Google Calendar asks: this
   * one, this and the following ones, or all. A new repeat can't be for this
   * one alone; "doesn't repeat after this one" needs no asking.
   */
  private async askSeriesChoice(): Promise<"one" | "following" | "all" | null> {
    const repeat = this.repeat.value;
    if (repeat === "end") return "all";
    return askSeriesChoice(`Save "${this.eventTitle.value.trim()}"?`, repeat === "keep");
  }

  private checkEvent(): Saved {
    if (!this.eventTitle.value.trim()) throw new Error("Add a title.");
    const start = this.startValue();
    const end = this.endValue();
    if (!start || !end) throw new Error("Choose when it starts and ends.");
    if (end < start || (this.allDay.checked && end <= start)) throw new Error("It must end after it starts.");
    // Checked here so a half-filled notification is reported like the other fields.
    if (!this.item || this.touched.has("alert") || this.alerts.diverged()) this.alerts.toDraft();
    return { start, allDay: this.allDay.checked };
  }

  private checkTask(): Saved {
    if (!this.taskName.value.trim()) throw new Error("Add a name.");
    if (this.taskRepeat || !this.dueDate.value) return { start: null, allDay: true };
    return { start: combine(this.dueDate.value, this.dueTime.value), allDay: !this.dueTime.value };
  }

  /**
   * The event as filled in. `asNew`: all of it, for a new series made from
   * this event ("this and following"), except notes left as they were,
   * which keep their formatting.
   */
  private eventDraft(asNew = false): EventDraft {
    const item = this.item;
    const allDay = this.allDay.checked;
    const start = this.startValue()!;
    const end = this.endValue()!;
    const editing = (name: string) => !item || (asNew && name !== "notes") || this.touched.has(name);

    let recurrence: string[] | null = null;
    if (item?.recurring) {
      const repeat = this.repeat.value;
      if (this.wholeSeries() && repeat in REPEAT_RULES) recurrence = [REPEAT_RULES[repeat as Repeat]];
      if (this.wholeSeries() && repeat === "end" && this.seriesRules) {
        recurrence = endAfter(this.seriesRules, this.savedInstant(itemStart(item)), item.allDay);
      }
    } else if (editing("repeat")) {
      const repeat = this.repeat.value as Repeat | "";
      recurrence = repeat ? [REPEAT_RULES[repeat]] : item ? [] : null;
    }

    let alerts: Alerts | null = null;
    if (editing("alert") || this.alerts.diverged()) alerts = this.alerts.toDraft();

    let guests: EventDraft["guests"] = null;
    if (editing("guests")) {
      const emails = this.guests.value
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.includes("@"));
      const existing = item?.attendees ?? [];
      // Keep yourself and the organizer, and everyone's replies.
      const kept = existing.filter((a) => (a.isSelf || a.organizer) && a.email && !emails.includes(a.email.toLowerCase()));
      const reply = (email: string) => existing.find((a) => a.email?.toLowerCase() === email)?.response ?? null;
      guests = [
        ...kept.map((a) => ({ email: a.email!, response: a.response })),
        ...emails.map((email) => ({ email, response: reply(email) })),
      ];
      if (!item && guests.length === 0) guests = null;
    }

    // Kept at its clock time anywhere: what's shown here is saved as that
    // clock time in the event's own zone.
    const zone = this.floating.checked ? floatingZone(item) : null;
    const time = (d: Date) => (zone ? sameClockIn(d, zone).toISOString() : toLocalIso(d));
    return {
      title: this.eventTitle.value.trim(),
      start: allDay ? toDateString(start) : time(start),
      end: allDay ? toDateString(end) : time(end),
      allDay,
      timeZone: zone ?? localTimeZone(),
      floating: allDay ? null : item ? (editing("floating") ? this.floating.checked : null) : this.floating.checked || null,
      location: this.location.value.trim() || null,
      // Empty clears an address saved earlier, so the Settings one is used.
      leaveFrom: this.leaveFrom.value.trim(),
      // Untouched notes are sent back exactly as they were, formatting and all.
      description: editing("notes") ? this.eventNotes.value.trim() || null : (item?.description ?? null),
      recurrence,
      alerts,
      guests,
      // Editing: only if chosen here ("" goes back to the calendar's color).
      colorId: item ? (editing("color") ? this.colorId : null) : this.colorId || null,
    };
  }

  private async saveEvent(): Promise<void> {
    // Ending the series needs its rules; fetch them now if they aren't yet.
    if (this.repeat.value === "end" && !(await this.seriesRecurrence())) {
      throw new Error("Couldn't read how this event repeats, to end it. Try again.");
    }
    const choice = this.calendarChoices[Number(this.calendar.value)];
    // Its first event: "this and following" is all of them (drafted below).
    if (this.item && this.seriesChoice === "following" && (await this.saveFollowing(choice))) return;
    const draft = this.eventDraft();
    if (!this.item) {
      if (!choice) throw new Error("Choose a calendar.");
      await createEvent(choice.email, choice.calendarId, draft);
      save(CALENDAR_STORAGE_KEY, choice);
      return;
    }
    const moveTo = choice && choice.calendarId !== this.item.listId ? choice.calendarId : null;
    const item = this.item;
    const whole = this.wholeSeries();
    // Editing the whole series from this event: when this one was, so the
    // others move by as much as it did.
    const zone = floatingZone(item);
    const at = (iso: string) => (zone ? sameClockIn(new Date(iso), zone).toISOString() : iso);
    const occurrence = whole
      ? { start: at(item.start), end: at(item.end ?? item.start), allDay: item.allDay, timeZone: zone ?? localTimeZone() }
      : null;
    const notify = this.notifyGuests.checked && !this.notifyRow.hidden;
    await updateEvent(eventRef(item, whole), draft, moveTo, notify, occurrence);
  }

  /** When `shown` (a time as shown here) really is, for this event: its own zone's clock time if it's floating. */
  private savedInstant(shown: Date): Date {
    const zone = floatingZone(this.item);
    return zone ? sameClockIn(shown, zone) : shown;
  }

  /** The series' rules (fetched once); null if they couldn't be. */
  private async seriesRecurrence(): Promise<string[] | null> {
    if (!this.seriesRules && this.item) {
      this.seriesRules = await eventRecurrence(eventRef(this.item, true)).catch(() => null);
    }
    return this.seriesRules;
  }

  /** One event of a repeating Google series, being edited. */
  private inSeries(): boolean {
    return Boolean(this.item?.recurring && this.item.kind === "event" && this.item.seriesId);
  }

  private wholeSeries(): boolean {
    return this.inSeries() && this.seriesChoice === "all";
  }

  /**
   * "This and following events", as Google Calendar does it: the series
   * ends just before this event, and a new one starts from it, as changed
   * here. False when this is the series' first event: then change them all.
   */
  private async saveFollowing(choice: CalendarChoice | undefined): Promise<boolean> {
    const item = this.item!;
    const original = this.savedInstant(itemStart(item));
    const before = item.allDay ? toDateString(itemStart(item)) : original.toISOString();
    const rules = await endSeriesBefore(eventRef(item, true), before, item.allDay);
    if (!rules) {
      this.seriesChoice = "all";
      return false;
    }
    const repeat = this.repeat.value;
    const draft = { ...this.eventDraft(true), recurrence: repeat in REPEAT_RULES ? [REPEAT_RULES[repeat as Repeat]] : rules };
    const to = choice ?? { email: item.account!, calendarId: item.listId! };
    await createEvent(to.email, to.calendarId, draft);
    return true;
  }

  private taskDraft(): TaskDraft {
    const item = this.item;
    const editing = (name: string) => !item || this.touched.has(name);
    let due: TaskDue | null = null;
    if (this.taskRepeat) due = { kind: "words", at: this.taskRepeat };
    else if (editing("due") && !item?.recurring) {
      if (!this.dueDate.value) due = item ? { kind: "none" } : null;
      else {
        const at = this.dueTime.value
          ? toLocalIso(combine(this.dueDate.value, this.dueTime.value))
          : this.dueDate.value;
        due = { kind: "at", at };
      }
    }
    return {
      content: this.taskName.value.trim(),
      // When adding, no notes; when editing, an emptied box clears them.
      description: item ? (this.touched.has("notes") ? this.taskNotes.value.trim() : null) : this.taskNotes.value.trim() || null,
      projectId: !item || (this.touched.has("project") && this.project.value !== item.listId) ? this.project.value || null : null,
      due,
      priority: editing("priority") ? Number(this.priority.value) : null,
    };
  }

  private async saveTask(): Promise<void> {
    const draft = this.taskDraft();
    if (this.item) await updateTask(this.item.sourceId!, draft);
    else {
      await createTask(draft);
      save(PROJECT_STORAGE_KEY, this.project.value);
    }
  }
}

function load<T>(key: string): T | undefined {
  try {
    const saved = localStorage.getItem(key);
    return saved ? (JSON.parse(saved) as T) : undefined;
  } catch {
    return undefined;
  }
}

function save(key: string, value: unknown): void {
  if (value === undefined) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not important enough to report.
  }
}
