// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { type InvokeArgs, invoke as tauriInvoke } from "@tauri-apps/api/core";

/**
 * Answers the app's own commands in the desktop app's Demo mode (see
 * demo.ts and dev-mock.ts), or null to send them to the app as usual.
 * The website and `npm run dev` answer them further down, in place of the
 * app itself, so there it stays null.
 */
let answerHere: ((command: string, args?: InvokeArgs) => { answer: unknown } | null) | null = null;

export function answerCommandsHere(answer: typeof answerHere): void {
  answerHere = answer;
}

function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (answerHere) {
    try {
      const here = answerHere(command, args);
      if (here) return Promise.resolve(here.answer as T);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return tauriInvoke<T>(command, args);
}

export type Source = "google" | "todoist" | "apple";
export type ItemKind = "event" | "task";

/** Someone invited to an event. Mirrors `Attendee` in src-tauri/src/agenda.rs. */
export interface Attendee {
  name: string | null;
  email: string | null;
  /** "accepted", "declined", "tentative" or "needsAction". */
  response: string | null;
  organizer: boolean;
  isSelf: boolean;
}

/** Mirrors `AgendaItem` in src-tauri/src/agenda.rs. */
export interface AgendaItem {
  id: string;
  source: Source;
  kind: ItemKind;
  title: string;
  /** "YYYY-MM-DD" when allDay, otherwise an ISO timestamp. */
  start: string;
  /** For all-day items, the day after the last day. */
  end: string | null;
  allDay: boolean;
  location: string | null;
  color: string | null;
  listName: string;
  url: string | null;
  /** Tasks only. */
  completed: boolean;
  /** Tasks only: due before today, and shown on today instead. */
  overdue: boolean;
  /** Tasks only: 1 (most urgent) to 4, as numbered in the Todoist app. */
  priority: number | null;
  /** Google events: the account they're in. */
  account: string | null;
  /** The Google calendar, or Todoist project, it's in. */
  listId: string | null;
  /** Its ID in its own service: the Google event, or Todoist task. */
  sourceId: string | null;
  /** For one occurrence of a repeating Google event, the whole series' ID. */
  seriesId: string | null;
  /** Items the app may change (see AgendaItem.editable in agenda.rs). */
  editable: boolean;
  /** One occurrence of a repeating event, or a repeating task. */
  recurring: boolean;
  /** Notes. Google's may contain simple HTML. */
  description: string | null;
  attendees: Attendee[];
  /** Video call link: Google Meet, Zoom, Teams and the like. */
  conferenceUrl: string | null;
  /** Popup alerts, in minutes before the start. */
  reminders: number[];
  /** Email alerts, in minutes before the start. Google sends these. */
  emailReminders?: number[];
  /**
   * Exact instants to alert (ISO). Minuteman stores and fires these; Google
   * Calendar's own reminders can't represent an absolute time.
   */
  alertAt?: string[];
  /**
   * This event's own starting address, when it shouldn't use the one in
   * Settings. Empty means that default.
   */
  leaveFrom?: string | null;
  /**
   * Minutes before the leave-by time to alert. Minuteman stores and fires
   * these; the time depends on traffic, so Google Calendar can't.
   */
  leaveAlerts?: number[];
  /** A repeating Todoist task's repeat, in Todoist's words ("every Monday"). */
  repeat?: string | null;
  /**
   * Google events: the event's own color ("1" to "11", see event-colors.ts),
   * when it isn't its calendar's. `color` is already that color.
   */
  colorId?: string | null;
  /**
   * Keeps its clock time in any time zone (an event marked so here, or
   * Apple's floating events): its times are that clock time here.
   */
  floating?: boolean;
  /** Google events: the event's own time zone. */
  timeZone?: string | null;
}

export interface Agenda {
  /** The Google accounts' email addresses. */
  accounts: string[];
  items: AgendaItem[];
  warnings: string[];
  /** Set when there's no internet and these are saved items: when they were fetched. */
  offlineSince: string | null;
}

/** A calendar you can add events to. Mirrors `EventCalendar` in google/calendar.rs. */
export interface EventCalendar {
  id: string;
  name: string;
  color: string | null;
  primary: boolean;
}

/** One of an account's calendars, for choosing which to show. Mirrors `ListedCalendar` in google/calendar.rs. */
export interface ListedCalendar extends EventCalendar {
  /** Not hidden in Settings. */
  shown: boolean;
}

export interface AccountCalendarList {
  email: string;
  calendars: ListedCalendar[];
  /** Why the calendars couldn't be listed, if they couldn't. */
  error: string | null;
}

export interface AccountCalendars {
  email: string;
  /** False until an account added before the app could add events is added again. */
  canEdit: boolean;
  calendars: EventCalendar[];
  /** Why the calendars couldn't be listed, if they couldn't. */
  error: string | null;
}

/** When an event happens. Mirrors `EventTimes` in google/calendar.rs. */
export interface EventTimes {
  /** "YYYY-MM-DD" when allDay, otherwise an ISO timestamp with offset. */
  start: string;
  /** For all-day events, the day after the last day. */
  end: string;
  allDay: boolean;
  /** IANA time zone, e.g. "Europe/London". */
  timeZone: string | null;
}

/** How a notification is delivered. "popup" is a notification; "email" is Google's. */
export type AlertMethod = "popup" | "email";

/**
 * One notification. `relative` is a lead time before the start (minutes, however
 * it was entered). `absolute` is an exact instant, which Google Calendar cannot
 * store as a reminder.
 */
export type EventAlert =
  | { kind: "relative"; minutes: number; method?: AlertMethod }
  | { kind: "absolute"; at: string }
  /** Minutes before you need to leave. Traffic decides the clock time. */
  | { kind: "leave"; bufferMinutes: number };

/**
 * An event's alerts: its calendar's defaults, or its own list (empty for none).
 * `minutes` is the older shape (popup minutes only) and still accepted.
 */
export type Alerts = { kind: "default" } | { kind: "custom"; minutes?: number[]; alerts?: EventAlert[] };

/** An event as the New or Edit form filled it in. Mirrors `EventDraft` in google/calendar.rs. */
export interface EventDraft extends EventTimes {
  /** Keep its clock time in any time zone; null leaves it as it is. */
  floating?: boolean | null;
  title: string;
  location: string | null;
  description: string | null;
  /** Repeat rules ("RRULE:…"); null leaves an existing event's repeat as it is. */
  recurrence: string[] | null;
  /** Null leaves an existing event's alerts as they are. */
  alerts: Alerts | null;
  /** Null leaves an existing event's guests as they are. `response` keeps someone's reply. */
  guests: { email: string; response: string | null }[] | null;
  /**
   * Starting address for the drive. Null leaves an existing one as it is.
   * "" clears it (use the address in Settings).
   */
  leaveFrom?: string | null;
  /**
   * The event's own color ("1" to "11"). Null or missing leaves it as it is;
   * "" goes back to the calendar's color.
   */
  colorId?: string | null;
}

/** Which Google event. For a repeating event, use `seriesId` to mean every occurrence. */
export interface EventRef {
  email: string;
  calendarId: string;
  eventId: string;
}

export function eventRef(item: AgendaItem, wholeSeries = false): EventRef {
  return {
    email: item.account!,
    calendarId: item.listId!,
    eventId: (wholeSeries && item.seriesId) || item.sourceId!,
  };
}

/** Mirrors `SearchResults` in src-tauri/src/search.rs. */
export interface SearchResults {
  /** Soonest first. */
  upcoming: AgendaItem[];
  /** Most recent first. */
  past: AgendaItem[];
  /** True when nothing could be reached and saved items were searched. */
  offline: boolean;
  warnings: string[];
}

/** A Todoist project. Mirrors `ProjectInfo` in src-tauri/src/todoist.rs. */
export interface TodoistProject {
  id: string;
  name: string;
  color: string | null;
  inbox: boolean;
}

/** A task's due date: none; a day ("YYYY-MM-DD") or ISO time; or words Todoist reads ("every Monday"). */
/**
 * A task's due date: none, a day or time, Todoist's own words ("every
 * Monday"), or (`move`) a repeating task's next date moved there, still
 * repeating, as rescheduling one does in Todoist.
 */
export type TaskDue =
  | { kind: "none" }
  | { kind: "at"; at: string }
  | { kind: "words"; at: string }
  | { kind: "move"; at: string };

/** A task as the New or Edit form filled it in. Mirrors `TaskDraft` in todoist.rs. */
export interface TaskDraft {
  content: string;
  description: string | null;
  /** Null: the Inbox when adding; when editing, leaves it where it is. */
  projectId: string | null;
  /** Null leaves an existing task's due date as it is (and adds none). */
  due: TaskDue | null;
  /** 1 (most urgent) to 4, as in the Todoist app. */
  priority: number | null;
}

/** A value with its label: Google's type ("home", "work", "mobile"…, or your own). */
export interface Labeled {
  value: string;
  label: string | null;
}

/** A birthday; Google allows one without a year. */
export interface Birthday {
  year: number | null;
  month: number;
  day: number;
}

/** One person in a Google account's contacts. Mirrors `Contact` in src-tauri/src/google/contacts.rs. */
export interface Contact {
  /** Unique across accounts: "<account>/<resourceName>". */
  id: string;
  /** The Google account it's in. */
  account: string;
  /** Google's ID for it, "people/c123…". */
  resourceName: string;
  /** Google's version of it; saving a change needs the latest. */
  etag: string | null;
  /** As Google shows it ("Sam Lee"); empty if it has no name. */
  name: string;
  givenName: string | null;
  familyName: string | null;
  nickname: string | null;
  organization: string | null;
  jobTitle: string | null;
  emails: Labeled[];
  phones: Labeled[];
  addresses: Labeled[];
  urls: Labeled[];
  birthday: Birthday | null;
  notes: string | null;
  /** A photo's address (not Google's letter picture). */
  photo: string | null;
  /** In Favorites. */
  starred: boolean;
}

/**
 * A new contact, or changes to one. Mirrors `ContactDraft` in google/contacts.rs.
 * When changing one, a field left out stays as it is and an empty one is cleared.
 * Names go together (give both or neither), as do organization and job title.
 */
export interface ContactDraft {
  givenName?: string;
  familyName?: string;
  nickname?: string;
  organization?: string;
  jobTitle?: string;
  emails?: Labeled[];
  phones?: Labeled[];
  addresses?: Labeled[];
  urls?: Labeled[];
  /** Empty clears the birthday. */
  birthdays?: Birthday[];
  notes?: string;
}

/** Mirrors `ContactList` in src-tauri/src/contacts.rs. */
export interface ContactList {
  accounts: {
    email: string;
    /** False until an account added before Minuteman used contacts is added again. */
    canUse: boolean;
    /** Why its contacts couldn't be loaded, if they couldn't. */
    error: string | null;
  }[];
  /** Sorted by name. */
  contacts: Contact[];
  /** Set when there's no internet and these are saved contacts: when they were fetched. */
  offlineSince: string | null;
}

/** Which contact, and the version it was read at. */
export interface ContactRef {
  email: string;
  resourceName: string;
  etag: string | null;
}

export const contactRef = (contact: Contact): ContactRef => ({
  email: contact.account,
  resourceName: contact.resourceName,
  etag: contact.etag,
});

/** What can be logged with someone (see src-tauri/src/interactions.rs). */
export type InteractionKind = "call" | "message" | "email" | "facetime" | "meeting" | "met" | "note" | "added";

/** Something you did with someone. Mirrors `Interaction` in src-tauri/src/interactions.rs. */
export interface Interaction {
  /** The contact's `id`. */
  contactId: string;
  kind: InteractionKind;
  /** When (ISO timestamp). */
  at: string;
  /** A note's text, an email's subject, what a meeting was… */
  detail: string | null;
}

/** Shape of every error a command rejects with (see src-tauri/src/error.rs). */
export interface AppError {
  kind: "notSignedIn" | "config" | "auth" | "input" | "api" | "network" | "keychain" | "io";
  message: string;
}

export const authStatus = () => invoke<boolean>("auth_status");
/** Adds a Google account (or renews one already added); resolves to its email. */
export const signIn = () => invoke<string>("sign_in");
export const googleAccounts = () => invoke<string[]>("google_accounts");
export const removeGoogleAccount = (email: string) => invoke<void>("remove_google_account", { email });
/** Events and tasks from a year back to a year ahead matching `query`. */
export const search = (query: string) => invoke<SearchResults>("search", { query });
export const eventCalendars = () => invoke<AccountCalendars[]>("event_calendars");
/** Every Google account's calendars, and which are shown. */
export const googleCalendars = () => invoke<AccountCalendarList[]>("google_calendars");
/** Shows or hides one of a Google account's calendars. */
export const setGoogleCalendarShown = (email: string, calendarId: string, shown: boolean) =>
  invoke<void>("set_google_calendar_shown", { email, calendarId, shown });
export const createEvent = (email: string, calendarId: string, event: EventDraft) =>
  invoke<void>("create_event", { email, calendarId, event });
/**
 * `moveTo`: another calendar in the same account, or null. `notifyGuests`
 * emails them. `occurrence`: when editing every event in a repeating series
 * from one of them, that one's times before the edit (and `target` is the series).
 */
/** A repeating event's rules (RRULE lines and so on), from its series (`eventRef(item, true)`). */
export const eventRecurrence = (target: EventRef) => invoke<string[]>("event_recurrence", { target });
/**
 * "This and following events": ends the series (`target` its series) just
 * before its occurrence at `before`, and resolves to its rules for a new
 * series from there; null when that's the first occurrence (change them all).
 */
/** Website: the key a browser subscribes to alerts with (web/src/push.ts). */
export const pushKey = () => invoke<string>("push_key");
/** Website: this browser's alerts on (its push subscription), or off. */
export const pushSubscribe = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, site: string) =>
  invoke<void>("push_subscribe", { subscription, site });
export const pushUnsubscribe = (endpoint: string) => invoke<void>("push_unsubscribe", { endpoint });
/** Website: a test alert now, to every device that has them on. */
export const pushTest = () => invoke<void>("push_test");
/**
 * Desktop app: Demo mode on (with the demo's items and clock: the menu bar
 * shows its next event, and real alerts wait) or off.
 */
export const showDemoInMenuBar = (on: boolean, items: AgendaItem[] = [], now: string | null = null) =>
  invoke<void>("set_demo", { on, items, now });
export const endSeriesBefore = (target: EventRef, before: string, allDay: boolean) =>
  invoke<string[] | null>("end_series_before", { target, before, allDay });

export const updateEvent = (
  target: EventRef,
  event: EventDraft,
  moveTo: string | null,
  notifyGuests: boolean,
  occurrence: EventTimes | null = null,
) => invoke<void>("update_event", { target, event, moveTo, notifyGuests, occurrence });
/** Moves or resizes an event (dragging it). */
/** Your reply to an invitation. For a repeating event, `target` is one occurrence, or its series for all. */
export const respondToEvent = (target: EventRef, response: "accepted" | "declined" | "tentative") =>
  invoke<void>("respond_to_event", { target, response });
export const setEventTimes = (target: EventRef, times: EventTimes, notifyGuests: boolean) =>
  invoke<void>("set_event_times", { target, times, notifyGuests });
export const deleteEvent = (target: EventRef, notifyGuests: boolean) =>
  invoke<void>("delete_event", { target, notifyGuests });
/** Items from local date `from` up to (not including) `to`, both "YYYY-MM-DD". */
export const getAgenda = (from: string, to: string) => invoke<Agenda>("get_agenda", { from, to });
/** What was saved last time for that range, without the network; null if nothing. */
export const getSavedAgenda = (from: string, to: string) => invoke<Agenda | null>("get_saved_agenda", { from, to });

export const todoistStatus = () => invoke<boolean>("todoist_status");
export const todoistConnect = (token: string) => invoke<void>("todoist_connect", { token });
export const todoistDisconnect = () => invoke<void>("todoist_disconnect");
export const todoistProjects = () => invoke<TodoistProject[]>("todoist_projects");
export const createTask = (task: TaskDraft) => invoke<void>("create_task", { task });
/** `id` is the task's own Todoist ID (`AgendaItem.sourceId`). */
export const updateTask = (id: string, task: TaskDraft) => invoke<void>("update_task", { id, task });
export const setTaskDue = (id: string, due: TaskDue) => invoke<void>("set_task_due", { id, due });
export const deleteTask = (id: string) => invoke<void>("delete_task", { id });
export const setTaskCompleted = (id: string, completed: boolean) =>
  invoke<void>("set_task_completed", { id, completed });

/** Every Google account's contacts; without internet, the ones saved last time. */
export const getContacts = () => invoke<ContactList>("get_contacts");
/** The contacts saved last time, without the network; null if none. */
export const getSavedContacts = () => invoke<ContactList | null>("get_saved_contacts");
/** Adds a contact to `email`'s Google Contacts; resolves to it as saved. */
export const createContact = (email: string, contact: ContactDraft) =>
  invoke<Contact>("create_contact", { email, contact });
/** Saves changes to a contact; resolves to it as saved. */
export const updateContact = (target: ContactRef, contact: ContactDraft) =>
  invoke<Contact>("update_contact", { target, contact });
export const deleteContact = (target: ContactRef) => invoke<void>("delete_contact", { target });
/** Adds a contact to Favorites, or takes it out; resolves to it as saved. */
export const setContactStarred = (target: ContactRef, starred: boolean) =>
  invoke<Contact>("set_contact_starred", { target, starred });
/** Your history with people in Contacts, oldest first. */
export const getInteractions = () => invoke<Interaction[]>("interactions");
/** Logs a call, message, note… with someone, now; resolves to it as kept. */
export const logInteraction = (contactId: string, kind: InteractionKind, detail: string | null = null) =>
  invoke<Interaction>("log_interaction", { interaction: { contactId, kind, detail } });
/** Desktop: opens the Contacts window, showing what matches `query`. */
export const showContacts = (query: string | null = null) => invoke<void>("show_contacts", { query });

/** Brings up the main window (from the menu bar window). */
export const showMain = () => invoke<void>("show_main");
/** Detaches the menu bar window into a window of its own, or puts it back. */
export const setFlyoutDetached = (detached: boolean) => invoke<void>("set_flyout_detached", { detached });

/** Settings the Rust side keeps (mirrors `Prefs` in src-tauri/src/prefs.rs). */
export interface Preferences {
  menuBarNext: boolean;
  timeToLeave: boolean;
  /** Default starting address for leave-by times. Empty means none. */
  leaveFrom: string;
  /** Start drives from where the device is, when known (the address is the fallback). */
  leaveFromHere?: boolean;
  /** Routes attempts allowed per day. Never unlimited. */
  routesDailyLimit: number;
  /** Routes attempts allowed per month. Never unlimited. */
  routesMonthlyLimit: number;
  appleCalendar: boolean;
  appleReminders: boolean;
  /** Apple calendars and reminder lists shown or left out, where chosen. */
  appleCalendarsShown: Record<string, boolean>;
}

/** One event to estimate a drive for. Mirrors `LeaveQuery` in lib.rs. */
export interface LeaveQuery {
  id: string;
  start: string;
  location: string;
  leaveFrom: string | null;
}

/** Why a leave-by time isn't shown. `ok` is the one that has a time. */
export type LeaveStatus =
  | "ok"
  | "noKey"
  | "noOrigin"
  | "notPhysical"
  | "tooFar"
  | "past"
  | "unavailable"
  | "limited"
  /** Google's drive is too long to be right (an address in the wrong town): minutes, but no leave time. */
  | "implausible";

/** A drive to one event. Mirrors `LeaveEstimate` in lib.rs. */
export interface LeaveEstimate {
  id: string;
  start: string;
  /** Driving minutes, when known. */
  minutes: number | null;
  /** When to set off to arrive as the event starts (ISO), when known. */
  leaveAt: string | null;
  status: LeaveStatus;
}

/** Where a Routes API key was found. The key itself never comes back. */
export interface RoutesKeyStatus {
  configured: boolean;
  source: "none" | "environment" | "dotenv" | "settings";
}

/** Drives for these events. A missing key or address is a status, not an error. */
/** `here`: where you are (a spotOrigin), used when Settings says to start from there. */
export const leaveTimes = (events: LeaveQuery[], here: string | null = null) =>
  invoke<LeaveEstimate[]>("leave_times", { events, here });
export const routesKeyStatus = () => invoke<RoutesKeyStatus>("routes_key_status");

/** Routes attempts used today and this month. Mirrors `UsageSnapshot` in leave.rs. */
export interface RoutesUsage {
  dayCount: number;
  dayLimit: number;
  monthCount: number;
  monthLimit: number;
  /** "none", "day", or "month". */
  capped: "none" | "day" | "month";
  maxDaily: number;
  maxMonthly: number;
}

export const routesUsage = () => invoke<RoutesUsage>("routes_usage");
/** Saves a Routes API key, or clears the saved one when `key` is empty. */
export const setRoutesKey = (key: string) => invoke<void>("set_routes_key", { key });

/** Whether macOS lets Minuteman use something (calendars, location). */
export type Access = "notAsked" | "granted" | "denied";

export interface AppleStatus {
  calendar: Access;
  reminders: Access;
}

/** A calendar from the Mac's Calendar app, or a list from Reminders. */
export interface AppleCalendar {
  id: string;
  title: string;
  /** Its account: "iCloud", "On My Mac", an email address… */
  account: string;
  color: string;
  reminders: boolean;
  shown: boolean;
}

export const getPreferences = () => invoke<Preferences>("get_preferences");
export const setPreferences = (preferences: Preferences) => invoke<void>("set_preferences", { preferences });
/** Mac only; null elsewhere. */
export const appleStatus = () => invoke<AppleStatus | null>("apple_status");
/** Shows macOS's permission prompt the first time; resolves once answered. */
export const appleRequestAccess = (kind: "calendar" | "reminders") =>
  invoke<Access>("apple_request_access", { kind });
export const appleCalendars = () => invoke<AppleCalendar[]>("apple_calendars");
/** Mac only; null elsewhere. */
export const locationAccess = () => invoke<Access | null>("location_access");
/** Whether Minuteman opens when you log in (desktop; null elsewhere). */
export const openAtLogin = () => invoke<boolean | null>("open_at_login");
export const setOpenAtLogin = (enabled: boolean) => invoke<void>("set_open_at_login", { enabled });
/** Mac only: where the Mac is, for the weather; null if not allowed or not known. */
export const currentLocation = () => invoke<{ latitude: number; longitude: number } | null>("current_location");

function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export const isNotSignedIn = (e: unknown) => isAppError(e) && e.kind === "notSignedIn";

export const errorMessage = (e: unknown) => (isAppError(e) ? e.message : String(e));
