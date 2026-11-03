// Sample data for previewing the UI in a normal browser (`npm run dev`, then
// open http://localhost:1420), where the Rust side isn't available, and for
// Demo mode (Settings → Demo mode, see demo.ts): made-up events, tasks and
// people, safe for screenshots. Loaded only then.
import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { answerCommandsHere } from "./api";
import type {
  Agenda,
  AgendaItem,
  Alerts,
  Contact,
  ContactDraft,
  EventDraft,
  EventTimes,
  Interaction,
  TaskDraft,
  TaskDue,
} from "./api";
import { eventColor } from "./event-colors";
import { addDays, isSameDay, overlaps, parseDate, startOfDay, toDateString } from "./time";

const PERSONAL = { name: "Personal", color: "#7986cb" };
const WORK = { name: "Continental Army", color: "#33b679" };
const FAMILY = { name: "Family", color: "#f6bf26" };
const HOLIDAYS = { name: "Holidays", color: "#e67c73" };
// Todoist projects
const INBOX = { name: "Inbox", color: "#808080" };
const HOME = { name: "Farm", color: "#7ecc49" };
const WORK_TASKS = { name: "Committee", color: "#4073ff" };
const PERSONAL_TASKS = { name: "Personal", color: "#af38eb" };

type Calendar = typeof PERSONAL;

function sampleItems(from: Date, to: Date): AgendaItem[] {
  const items: AgendaItem[] = [];
  const base: Omit<AgendaItem, "id" | "title" | "start" | "end" | "allDay" | "location" | "color" | "listName"> = {
    source: "google",
    kind: "event",
    url: "https://calendar.google.com/",
    completed: false,
    overdue: false,
    priority: null,
    account: "paul.revere@example.com",
    listId: "personal",
    sourceId: null,
    seriesId: null,
    editable: true,
    recurring: false,
    description: null,
    attendees: [],
    conferenceUrl: null,
    reminders: [10],
  };
  const today = startOfDay(new Date());

  const task = (
    day: Date,
    title: string,
    priority: number,
    project: Calendar,
    hour?: number,
    overdue = false,
    extra: Partial<AgendaItem> = {},
  ) => {
    const start = hour === undefined ? null : new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
    items.push({
      ...base,
      source: "todoist",
      kind: "task",
      url: "https://app.todoist.com/",
      account: null,
      listId: "inbox",
      editable: true,
      reminders: [],
      id: `todoist:${title}:${toDateString(day)}`,
      title,
      start: start ? start.toISOString() : toDateString(day),
      end: start ? start.toISOString() : toDateString(addDays(day, 1)),
      allDay: !start,
      location: null,
      color: project.color,
      listName: project.name,
      overdue,
      priority,
      ...extra,
    });
  };

  const timed = (
    day: Date,
    title: string,
    cal: Calendar,
    hour: number,
    minutes: number,
    location?: string,
    extra: Partial<AgendaItem> = {},
  ) => {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(hour), (hour % 1) * 60);
    items.push({
      ...base,
      ...extra,
      id: `mock:${title}:${toDateString(day)}`,
      title,
      start: start.toISOString(),
      end: new Date(start.getTime() + minutes * 60_000).toISOString(),
      allDay: false,
      location: location ?? null,
      color: cal.color,
      listName: cal.name,
    });
  };
  const allDay = (day: Date, title: string, cal: Calendar, days = 1) =>
    items.push({
      ...base,
      id: `mock:${title}:${toDateString(day)}`,
      title,
      start: toDateString(day),
      end: toDateString(addDays(day, days)),
      allDay: true,
      location: null,
      color: cal.color,
      listName: cal.name,
    });

  for (let day = from; day < to; day = addDays(day, 1)) {
    const weekday = day.getDay();
    const date = day.getDate();
    if (weekday >= 1 && weekday <= 5) {
      timed(day, "Militia muster", WORK, 9.5, 15, "Lexington Green", {
        recurring: true,
        seriesId: "muster",
        conferenceUrl: "https://meet.google.com/abc-defg-hij",
        attendees: [
          { name: "John Parker", email: "captain.parker@example.com", response: "accepted", organizer: true, isSelf: false },
          { name: null, email: "paul.revere@example.com", response: "accepted", organizer: false, isSelf: true },
          { name: "Samuel Adams", email: "sam.adams@example.com", response: "tentative", organizer: false, isSelf: false },
        ],
        description:
          "<p>Muster on the green. Orders: <a href=\"https://docs.example.com/muster\">drill notes</a></p><p>Three things:<br>powder, shot, provisions.</p>",
      });
    }
    if (weekday === 1 || weekday === 4) {
      task(day, "Read the dispatches", 4, INBOX, undefined, false, { recurring: true, repeat: "every mon, thu" });
    }
    if (weekday === 3) task(day, "Shoe the horse", 2, HOME, 13);
    if (weekday === 5) task(day, "Send the ledger to the Committee", 1, WORK_TASKS);
    if (isSameDay(day, today)) {
      task(day, "Finish the silver tea set", 1, PERSONAL_TASKS, undefined, true);
      task(day, "Buy lantern oil", 3, HOME);
      timed(day, "Coffee at the Green Dragon", PERSONAL, 16, 45, "Green Dragon Tavern, Union St, Boston, MA");
    }
    if (weekday === 1) {
      timed(day, "Committee of Correspondence", WORK, 10, 60, "Faneuil Hall", { recurring: true, seriesId: "committee" });
    }
    if (weekday === 2) {
      timed(day, "Proof the Boston Massacre engraving", WORK, 11, 60, "Revere's shop, North Square", {
        reminders: [30, 7 * 24 * 60],
        emailReminders: [60],
        alertAt: [new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 0).toISOString()],
      });
      timed(day, "Lunch with Sam Adams", PERSONAL, 11.5, 60, "Green Dragon Tavern");
      timed(day, "Quick word with Dr. Warren", WORK, 11.75, 30);
    }
    if (weekday === 3) timed(day, "Fit a false tooth", PERSONAL, 14, 60, "19 North Square, Boston, MA");
    if (weekday === 4) {
      timed(day, "Provincial Congress", WORK, 9, 8 * 60, "Concord Meetinghouse");
      timed(day, "1:1 with Captain Parker", WORK, 15, 30);
    }
    if (weekday === 5) timed(day, "Sons of Liberty", PERSONAL, 18, 120, "Green Dragon Tavern");
    if (weekday === 6) timed(day, "Night watch", PERSONAL, 22, 180, "Boston Neck"); // runs past midnight
    // Demo mode's clock starts at 9:45 PM on April 18, 1775 (demo.ts).
    if (day.getFullYear() === 1775 && day.getMonth() === 3 && date === 18) {
      task(day, "Warn Hancock and Adams", 1, WORK_TASKS);
      timed(day, "Two lanterns in the Old North Church", PERSONAL, 21.5, 15, "Old North Church, 193 Salem St, Boston, MA");
      timed(day, "Row across the Charles", PERSONAL, 22, 30, "Charlestown, MA");
      timed(day, "Midnight ride", PERSONAL, 22.5, 150, "Hancock-Clarke House, 36 Hancock St, Lexington, MA", {
        description: "<p>The regulars are coming out. By way of Medford, rousing every house to Lexington.</p>",
        reminders: [10],
      });
    }
    if (day.getFullYear() === 1775 && day.getMonth() === 3 && date === 19) {
      allDay(day, "Battles of Lexington and Concord", WORK);
      timed(day, "Muster on Lexington Green", WORK, 4.5, 60, "Lexington Green, Lexington, MA");
      timed(day, "North Bridge", WORK, 9.5, 60, "Old North Bridge, Concord, MA");
    }
    if (weekday === 0) timed(day, "Family dinner", FAMILY, 18.5, 90);
    if (date === 1) allDay(day, "Pay the rent", PERSONAL);
    if (date === 12) allDay(day, "Second Continental Congress", WORK, 3);
    if (date === 20) allDay(day, "Rachel's birthday", FAMILY);
    if (date === 28) allDay(day, "Furlough", PERSONAL, 4);
    if (date === 29) allDay(day, "Market day", FAMILY);
    if (date === 25 && day.getMonth() === 11) allDay(day, "Christmas Day", HOLIDAYS);
  }
  return items;
}

/** Sample people for the Contacts window: birthdays near today, a favourite, some with photos missing. */
function sampleContacts(): Contact[] {
  const today = startOfDay(new Date());
  const inDays = (n: number, year: number | null) => {
    const d = addDays(today, n);
    return { year, month: d.getMonth() + 1, day: d.getDate() };
  };
  const person = (given: string, family: string, more: Partial<Contact> = {}): Contact => {
    const id = `people/c${given.toLowerCase()}${family.toLowerCase()}`.replace(/[^a-z0-9/]/g, "");
    return {
      id: `paul.revere@example.com/${id}`,
      account: "paul.revere@example.com",
      resourceName: id,
      etag: "%mock",
      name: [given, family].filter(Boolean).join(" "),
      givenName: given,
      familyName: family || null,
      nickname: null,
      organization: null,
      jobTitle: null,
      emails: [],
      phones: [],
      addresses: [],
      urls: [],
      birthday: null,
      notes: null,
      photo: null,
      starred: false,
      ...more,
    };
  };
  return [
    person("John", "Parker", {
      organization: "Lexington Militia",
      jobTitle: "Captain",
      emails: [{ value: "captain.parker@example.com", label: "work" }],
      phones: [{ value: "+1 781 555 0134", label: "work" }],
      starred: true,
    }),
    person("Samuel", "Adams", {
      emails: [
        { value: "sam.adams@example.com", label: "work" },
        { value: "sons.of.liberty@example.com", label: "home" },
      ],
      phones: [
        { value: "+1 617 555 0100", label: "mobile" },
        { value: "+1 617 555 0199", label: "home" },
      ],
      addresses: [{ value: "Purchase Street, Boston, MA 02110", label: "home" }],
      birthday: inDays(3, 1722),
      notes: "Brews a fine argument.",
      starred: true,
      nickname: "Sam",
    }),
    person("Abigail", "Adams", {
      organization: "Peacefield",
      emails: [{ value: "abigail@example.com", label: "home" }],
      birthday: inDays(0, null),
    }),
    person("Benjamin", "Franklin", { phones: [{ value: "(215) 555-0147", label: "mobile" }], urls: [{ value: "poorrichard.example", label: "homePage" }] }),
    person("Marquis de", "Lafayette", { emails: [{ value: "lafayette@example.fr", label: null }], birthday: inDays(40, 1757) }),
    person("Dr. Joseph", "Warren", { organization: "Boston", jobTitle: "Physician", phones: [{ value: "555 0162", label: "work" }] }),
    person("Mercy Otis", "Warren", { organization: "Plymouth", jobTitle: "Playwright", birthday: { year: 1728, month: 9, day: 14 } }),
    person("Haym", "Salomon", { emails: [{ value: "haym@example.com", label: "home" }] }),
    person("Rachel", "Revere", { phones: [{ value: "+1 617 555 0110", label: "mobile" }], starred: true, birthday: inDays(10, 1745) }),
    person("Phillis", "Wheatley", { emails: [{ value: "phillis@example.com", label: null }] }),
    person("", "", { name: "", givenName: null, organization: "Green Dragon Tavern", phones: [{ value: "+1 617 555 0177", label: "main" }], addresses: [{ value: "Union Street, Boston, MA 02108", label: "work" }] }),
  ];
}

/** A contact as the mock "Google" would save `draft`. */
function contactFrom(base: Contact, draft: ContactDraft): Contact {
  const c = { ...base };
  if (draft.givenName !== undefined || draft.familyName !== undefined) {
    c.givenName = draft.givenName || null;
    c.familyName = draft.familyName || null;
    c.name = [draft.givenName, draft.familyName].filter(Boolean).join(" ");
  }
  if (draft.nickname !== undefined) c.nickname = draft.nickname || null;
  if (draft.organization !== undefined) c.organization = draft.organization || null;
  if (draft.jobTitle !== undefined) c.jobTitle = draft.jobTitle || null;
  for (const kind of ["emails", "phones", "addresses", "urls"] as const) if (draft[kind]) c[kind] = draft[kind]!;
  if (draft.birthdays) c.birthday = draft.birthdays[0] ?? null;
  if (draft.notes !== undefined) c.notes = draft.notes || null;
  c.etag = `%${Date.now()}`;
  return c;
}

/** A little history with the sample people, for Recent and their cards. */
function sampleInteractions(): Interaction[] {
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const id = (name: string) => `paul.revere@example.com/people/c${name}`;
  return [
    { contactId: id("samueladams"), kind: "met", at: ago(24 * 9), detail: "ale at the Green Dragon" },
    { contactId: id("benjaminfranklin"), kind: "email", at: ago(24 * 4), detail: "the printing press" },
    { contactId: id("rachelrevere"), kind: "call", at: ago(26), detail: null },
    { contactId: id("samueladams"), kind: "call", at: ago(3), detail: null },
    { contactId: id("samueladams"), kind: "note", at: ago(2), detail: "Raising a militia by spring" },
  ];
}

/**
 * Commands the desktop app's Demo mode still sends to the real app: windows,
 * the Mac's location, open at login. Everything else is sample data.
 */
const DESKTOP_COMMANDS = new Set([
  "show_contacts",
  "show_main",
  "set_flyout_detached",
  "location_access",
  "current_location",
  "open_at_login",
  "set_open_at_login",
  // The menu bar and alerts, told Demo mode is on (demo.ts).
  "set_demo",
]);

/**
 * Answers the app's commands with sample data. In the desktop app (Demo
 * mode), `inApp` keeps windows, events and the other plugins working:
 * only the app's own data commands are answered here.
 */
export function install(inApp = false): void {
  let contacts = sampleContacts();
  const interactions = sampleInteractions();
  let accounts = ["paul.revere@example.com"];
  let todoistConnected = true;
  const completedTasks = new Set<string>();
  const created: AgendaItem[] = [];
  // Changes to sample items, which are made afresh for every request.
  const edits = new Map<string, Partial<AgendaItem>>();
  const deleted = new Set<string>();
  const edit = (id: string, changes: Partial<AgendaItem>) => edits.set(id, { ...edits.get(id), ...changes });
  /** What the form saved, as the agenda would show it after a reload. Null leaves them as they are. */
  const savedAlerts = (
    alerts: Alerts | null,
  ): Pick<AgendaItem, "reminders" | "emailReminders" | "alertAt" | "leaveAlerts"> | null => {
    if (!alerts) return null;
    if (alerts.kind === "default") return { reminders: [10], emailReminders: [], alertAt: [] };
    const list =
      alerts.alerts ?? (alerts.minutes ?? []).map((minutes) => ({ kind: "relative" as const, minutes, method: "popup" as const }));
    const reminders: number[] = [];
    const emailReminders: number[] = [];
    const alertAt: string[] = [];
    const leaveAlerts: number[] = [];
    for (const alert of list) {
      if (alert.kind === "absolute") alertAt.push(alert.at);
      else if (alert.kind === "leave") leaveAlerts.push(alert.bufferMinutes);
      else if (alert.method === "email") emailReminders.push(alert.minutes);
      else reminders.push(alert.minutes);
    }
    return { reminders, emailReminders, alertAt, leaveAlerts };
  };
  const dueFields = (due: TaskDue): Partial<AgendaItem> => {
    if (due.kind !== "at" && due.kind !== "move") return {};
    const allDay = due.at.length === 10;
    return { start: due.at, end: allDay ? toDateString(addDays(parseDate(due.at), 1)) : due.at, allDay, overdue: false };
  };
  const calendars = [
    { id: "personal", ...PERSONAL, primary: true },
    { id: "work", ...WORK, primary: false },
  ];

  // Desktop settings (src-tauri/src/prefs.rs), as a Mac would have them.
  let preferences = {
    menuBarNext: true,
    timeToLeave: false,
    leaveFrom: "19 North Square, Boston, MA 02113",
    leaveFromHere: false,
    routesDailyLimit: 80,
    routesMonthlyLimit: 2500,
    appleCalendar: false,
    appleReminders: false,
    appleCalendarsShown: {} as Record<string, boolean>,
  };
  const appleAccess = { calendar: "notAsked", reminders: "notAsked" };
  // Google calendars hidden in Settings (by name here; the samples have no real IDs).
  const hiddenCalendars = new Set<string>();
  let openAtLoginNow = false;
  // A pretend Routes key, so the preview can show leave-by times.
  let routesKey = "preview";

  // The weather (src/weather.ts) comes from Open-Meteo; answer for it here.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "geocoding-api.open-meteo.com") {
      const name = url.searchParams.get("name") ?? "";
      return Response.json({
        results: [
          { name, admin1: "South Carolina", country: "United States", latitude: 34.94, longitude: -82.23 },
          { name, admin1: "Oklahoma", country: "United States", latitude: 34.94, longitude: -97.4 },
        ],
      });
    }
    if (url.hostname === "api.open-meteo.com") {
      const start = addDays(startOfDay(new Date()), -7);
      const days = Array.from({ length: 23 }, (_, i) => addDays(start, i));
      const codes = [0, 1, 2, 3, 61, 80, 95, 71, 45, 2];
      return Response.json({
        daily: {
          time: days.map(toDateString),
          weather_code: days.map((_, i) => codes[i % codes.length]),
          temperature_2m_max: days.map((_, i) => 64 + ((i * 7) % 15)),
          temperature_2m_min: days.map((_, i) => 44 + ((i * 5) % 11)),
        },
      });
    }
    return realFetch(input, init);
  };

  const respond = (cmd: string, args?: InvokeArgs): unknown => {
    switch (cmd) {
      case "auth_status":
        return accounts.length > 0;
      case "sign_in": {
        const email = accounts.length === 0 ? "paul.revere@example.com" : `work${accounts.length}@example.com`;
        accounts.push(email);
        return email;
      }
      case "google_accounts":
        return accounts;
      case "remove_google_account": {
        const { email } = args as { email: string };
        accounts = accounts.filter((a) => a !== email);
        return null;
      }
      case "get_agenda": {
        const { from, to } = args as { from: string; to: string };
        // Like the real API: done tasks aren't returned, nor any tasks without Todoist.
        const range = { from: parseDate(from), to: parseDate(to) };
        const items = [...sampleItems(range.from, range.to), ...created]
          .filter((item) => !deleted.has(item.id))
          .map((item) => ({ ...item, ...edits.get(item.id), sourceId: item.id }))
          .filter((item) => overlaps(item, range.from, range.to))
          .filter((item) => (item.kind === "task" ? todoistConnected && !completedTasks.has(item.id) : true))
          .filter((item) => item.source !== "google" || !hiddenCalendars.has(item.listName.toLowerCase()));
        const agenda: Agenda = { accounts, items, warnings: [], offlineSince: null };
        return agenda;
      }
      case "search": {
        const query = (args as { query: string }).query.toLowerCase();
        const today = startOfDay(new Date());
        // Like Google: titles, and guests' names and addresses.
        const found = sampleItems(addDays(today, -14), addDays(today, 15)).filter(
          (item) =>
            item.title.toLowerCase().includes(query) ||
            item.attendees.some((a) => a.email?.toLowerCase().includes(query) || a.name?.toLowerCase().includes(query)),
        );
        const now = Date.now();
        const end = (item: AgendaItem) => new Date(item.end ?? item.start).getTime();
        return {
          upcoming: found.filter((item) => end(item) > now).slice(0, 50),
          past: found.filter((item) => end(item) <= now).reverse().slice(0, 50),
          offline: false,
          warnings: [],
        };
      }
      case "todoist_projects":
        return [
          { id: "inbox", name: "Inbox", color: INBOX.color, inbox: true },
          { id: "home", name: HOME.name, color: HOME.color, inbox: false },
          { id: "committee", name: WORK_TASKS.name, color: WORK_TASKS.color, inbox: false },
        ];
      case "create_task": {
        const { task } = args as { task: TaskDraft };
        if (task.due?.kind === "at") {
          const due = task.due.at;
          const allDay = due.length === 10;
          created.push({
            id: `mock:task:${created.length}`,
            source: "todoist",
            kind: "task",
            title: task.content,
            start: due,
            end: allDay ? toDateString(addDays(parseDate(due), 1)) : due,
            allDay,
            location: null,
            color: INBOX.color,
            listName: "Inbox",
            url: "https://app.todoist.com/",
            completed: false,
            overdue: false,
            priority: task.priority ?? 4,
            account: null,
            listId: "inbox",
            sourceId: `mock:task:${created.length}`,
            seriesId: null,
            editable: true,
            recurring: false,
            description: null,
            attendees: [],
            conferenceUrl: null,
            reminders: [],
          });
        }
        return null;
      }
      case "get_saved_agenda":
        return null;
      case "event_calendars":
        return accounts.map((email, i) => ({
          email,
          canEdit: i === 0,
          calendars: i === 0 ? calendars.map(({ id, name, color, primary }) => ({ id, name, color, primary })) : [],
          error: null,
        }));
      case "event_recurrence":
        return ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=America/New_York:20261102T100000"];
      case "end_series_before":
        // As if the series went on before this one: it's cut there, and goes on in a new one.
        console.info("mock IPC: end_series_before", args);
        return ["RRULE:FREQ=WEEKLY;BYDAY=MO"];
      case "open_at_login":
        return openAtLoginNow;
      case "set_open_at_login":
        openAtLoginNow = (args as { enabled: boolean }).enabled;
        return null;
      case "google_calendars":
        return accounts.map((email, i) => ({
          email,
          calendars: (i === 0 ? [PERSONAL, WORK, FAMILY, HOLIDAYS] : [{ name: email, color: "#039be5" }]).map((cal, j) => {
            const id = cal.name.toLowerCase();
            return { id, name: cal.name, color: cal.color, primary: j === 0, shown: !hiddenCalendars.has(id) };
          }),
          error: null,
        }));
      case "set_google_calendar_shown": {
        const { calendarId, shown } = args as { calendarId: string; shown: boolean };
        if (shown) hiddenCalendars.delete(calendarId);
        else hiddenCalendars.add(calendarId);
        return null;
      }
      case "create_event": {
        const { calendarId, event } = args as { calendarId: string; event: EventDraft };
        const calendar = calendars.find((c) => c.id === calendarId)!;
        const id = `mock:created:${created.length}`;
        created.push({
          id,
          source: "google",
          kind: "event",
          title: event.title,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          location: event.location,
          color: eventColor(event.colorId) ?? calendar.color,
          colorId: eventColor(event.colorId) ? event.colorId : null,
          listName: calendar.name,
          url: "https://calendar.google.com/",
          completed: false,
          overdue: false,
          priority: null,
          account: "paul.revere@example.com",
          listId: calendarId,
          sourceId: id,
          seriesId: null,
          editable: true,
          recurring: false,
          description: null,
          attendees: [],
          conferenceUrl: null,
          leaveFrom: event.leaveFrom?.trim() || null,
          ...(savedAlerts(event.alerts) ?? { reminders: [10], emailReminders: [], alertAt: [], leaveAlerts: [] }),
        });
        return null;
      }
      case "update_event": {
        const { target, event, occurrence } = args as {
          target: { eventId: string };
          event: EventDraft;
          occurrence: unknown;
        };
        if (occurrence) console.info("mock IPC: update_event for the whole series", target, event, occurrence);
        const { title, start, end, allDay, location, description, leaveFrom } = event;
        const alerts = savedAlerts(event.alerts);
        edit(target.eventId, {
          title,
          start,
          end,
          allDay,
          location,
          description,
          leaveFrom: leaveFrom?.trim() || null,
          ...(alerts ?? {}),
        });
        if (typeof event.colorId === "string") {
          // Its own color, or ("") back to its calendar's.
          const { color: _color, colorId: _id, ...rest } = edits.get(target.eventId) ?? {};
          const color = eventColor(event.colorId);
          edits.set(target.eventId, color ? { ...rest, color, colorId: event.colorId } : rest);
        }
        return null;
      }
      case "set_event_times": {
        const { target, times } = args as { target: { eventId: string }; times: EventTimes };
        edit(target.eventId, { start: times.start, end: times.end, allDay: times.allDay });
        return null;
      }
      case "delete_event":
        deleted.add((args as { target: { eventId: string } }).target.eventId);
        return null;
      case "update_task": {
        const { id, task } = args as { id: string; task: TaskDraft };
        edit(id, { title: task.content, ...(task.description !== null ? { description: task.description } : {}) });
        if (task.due) edit(id, dueFields(task.due));
        if (task.priority) edit(id, { priority: task.priority });
        return null;
      }
      case "set_task_due": {
        const { id, due } = args as { id: string; due: TaskDue };
        edit(id, dueFields(due));
        return null;
      }
      case "delete_task":
        deleted.add((args as { id: string }).id);
        return null;
      case "todoist_status":
        return todoistConnected;
      case "todoist_connect":
        if (!(args as { token: string }).token.trim()) throw { kind: "input", message: "Invalid request: paste your Todoist API token first" };
        todoistConnected = true;
        return null;
      case "todoist_disconnect":
        todoistConnected = false;
        return null;
      case "set_task_completed": {
        const { id, completed } = args as { id: string; completed: boolean };
        if (completed) completedTasks.add(id);
        else completedTasks.delete(id);
        return null;
      }
      case "get_preferences":
        return preferences;
      case "set_preferences": {
        const next = (args as { preferences: typeof preferences }).preferences;
        preferences = {
          ...next,
          routesDailyLimit: Math.min(Math.max(0, next.routesDailyLimit ?? 80), 160),
          routesMonthlyLimit: Math.min(Math.max(0, next.routesMonthlyLimit ?? 2500), 4000),
        };
        return null;
      }
      case "apple_status":
        return appleAccess;
      case "apple_request_access": {
        const { kind } = args as { kind: "calendar" | "reminders" };
        appleAccess[kind] = "granted";
        return "granted";
      }
      case "apple_calendars":
        return [
          { id: "home", title: "Home", account: "iCloud", color: "#34c759", reminders: false, shown: true },
          { id: "g", title: "paul.revere@example.com", account: "paul.revere@example.com", color: "#4285f4", reminders: false, shown: false },
          { id: "todo", title: "Reminders", account: "iCloud", color: "#ff9500", reminders: true, shown: true },
        ].map((c) => ({ ...c, shown: preferences.appleCalendarsShown[c.id] ?? c.shown }));
      case "location_access":
        return "granted";
      case "routes_key_status":
        return { configured: routesKey.length > 0, source: routesKey ? "settings" : "none" };
      case "routes_usage":
        return {
          dayCount: 3,
          dayLimit: preferences.routesDailyLimit,
          monthCount: 10,
          monthLimit: preferences.routesMonthlyLimit,
          capped: "none",
          maxDaily: 160,
          maxMonthly: 4000,
        };
      case "set_routes_key": {
        const key = (args as { key: string }).key.trim();
        if (key.length > 256 || /\s/.test(key)) throw { kind: "input", message: "Invalid request: That doesn't look like an API key." };
        routesKey = key;
        return null;
      }
      case "leave_times": {
        const { events, here } = args as {
          events: { id: string; start: string; location: string; leaveFrom: string | null }[];
          here?: string | null;
        };
        // Where you are ("@lat,lng"), when that's on and this device found it.
        const fallback = (preferences.leaveFromHere && here) || preferences.leaveFrom.trim();
        return (events ?? []).slice(0, 40).map((event) => {
          const location = event.location ?? "";
          const startMs = Date.parse(event.start);
          const virtual = !location.trim() || /:\/\/|zoom|meet\.google|teams|webex|facetime|online|virtual|phone|call/i.test(location);
          const blank = { id: event.id, start: event.start, minutes: null, leaveAt: null };
          if (virtual) return { ...blank, status: "notPhysical" };
          if (!Number.isFinite(startMs)) return { ...blank, status: "unavailable" };
          if (startMs <= Date.now()) return { ...blank, status: "past" };
          if (startMs - Date.now() > 48 * 60 * 60 * 1000) return { ...blank, status: "tooFar" };
          const origin = (event.leaveFrom ?? "").trim() || fallback;
          if (!origin) return { ...blank, status: "noOrigin" };
          if (!routesKey) return { ...blank, status: "noKey" };
          // Like Google with a street and no town: a same-named street far away.
          if (!/,|\b\d{5}\b/.test(origin)) return { ...blank, minutes: 550, status: "implausible" };
          // Shorter from where you are, so the two are easy to tell apart.
          const minutes = origin.startsWith("@") ? 12 : 25;
          return { id: event.id, start: event.start, minutes, leaveAt: new Date(startMs - minutes * 60_000).toISOString(), status: "ok" };
        });
      }
      case "get_contacts":
      case "get_saved_contacts":
        return {
          accounts: accounts.map((email) => ({ email, canUse: email === "paul.revere@example.com", error: null })),
          // Sorted by name, as the Rust side does; people without one last.
          contacts: contacts
            .filter((c) => accounts.includes(c.account))
            .sort((a, b) => Number(!a.name) - Number(!b.name) || (a.name || a.organization || "").localeCompare(b.name || b.organization || "")),
          offlineSince: null,
        };
      case "create_contact": {
        const { email, contact } = args as { email: string; contact: ContactDraft };
        const id = `people/c${Date.now()}`;
        const blank = { ...sampleContacts()[0], id: `${email}/${id}`, account: email, resourceName: id, starred: false };
        const empty = { name: "", givenName: null, familyName: null, organization: null, jobTitle: null, emails: [], phones: [], urls: [], addresses: [], birthday: null, notes: null, nickname: null };
        const saved = contactFrom({ ...blank, ...empty }, contact);
        contacts.push(saved);
        return saved;
      }
      case "update_contact": {
        const { target, contact } = args as { target: { resourceName: string }; contact: ContactDraft };
        const existing = contacts.find((c) => c.resourceName === target.resourceName);
        if (!existing) throw { kind: "api", message: "Google API error (404): Not found" };
        const saved = contactFrom(existing, contact);
        contacts = contacts.map((c) => (c === existing ? saved : c));
        return saved;
      }
      case "delete_contact": {
        const { target } = args as { target: { resourceName: string } };
        contacts = contacts.filter((c) => c.resourceName !== target.resourceName);
        return null;
      }
      case "interactions":
        return interactions;
      case "log_interaction": {
        const { interaction } = args as { interaction: Omit<Interaction, "at"> };
        const entry = { ...interaction, at: new Date().toISOString() };
        interactions.push(entry);
        return entry;
      }
      case "set_contact_starred": {
        const { target, starred } = args as { target: { resourceName: string }; starred: boolean };
        contacts = contacts.map((c) => (c.resourceName === target.resourceName ? { ...c, starred, etag: `%${Date.now()}` } : c));
        return contacts.find((c) => c.resourceName === target.resourceName);
      }
      case "plugin:opener|open_url": {
        // As the website does (web-bridge.ts `openLink`).
        const { url } = args as { url: string };
        if (/^https?:/i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
        else location.href = url;
        return null;
      }
      default:
        console.info("mock IPC:", cmd, args);
        return null;
    }
  };

  if (!inApp) {
    mockIPC(respond);
    return;
  }
  // Tauri's own invoke can't be replaced, so api.ts asks here first.
  answerCommandsHere((cmd, args) =>
    cmd.startsWith("plugin:") || DESKTOP_COMMANDS.has(cmd) ? null : { answer: respond(cmd, args) },
  );
}
