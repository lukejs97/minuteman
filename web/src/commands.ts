// The commands the website calls at /api/<name>: the same names and
// arguments as the desktop app's Rust commands (src-tauri/src/lib.rs), so
// the shared screens work unchanged.
import type {
  ContactDraft,
  ContactRef,
  EventDraft,
  EventRef,
  EventTimes,
  Interaction,
  InteractionKind,
  LeaveQuery,
  Preferences,
  TaskDraft,
  TaskDue,
} from "../../src/api";
import * as agenda from "./agenda";
import * as contacts from "./contacts";
import * as places from "./places";
import type { Context } from "./env";
import { configError, invalidInput } from "./errors";
import * as google from "./google";
import {
  readAccounts,
  readInteractions,
  readLeaveSettings,
  readRoutesUsage,
  readTodoistToken,
  removeAccount,
  setCalendarShown,
  writeInteractions,
  writeLeaveSettings,
  writeTodoistToken,
} from "./store";
import * as routes from "./routes";
import { clampLimits, capped, emptyUsage, pacificDate, MAX_DAILY, MAX_MONTHLY } from "../../src/routes-budget";
import * as push from "./push";
import * as reminders from "./reminders";
import * as todoist from "./todoist";

type Args = Record<string, unknown>;
type Command = (ctx: Context, args: Args) => Promise<unknown>;

const text = (args: Args, name: string): string => {
  const value = args[name];
  if (typeof value !== "string") throw invalidInput(`${name} must be text`);
  return value;
};
const flag = (args: Args, name: string) => args[name] === true;

/** What can be logged, the most kept, and the longest detail: as in src-tauri/src/interactions.rs. */
const INTERACTION_KINDS: InteractionKind[] = ["call", "message", "email", "facetime", "meeting", "met", "note", "added", "edited", "hidden"];
const MAX_INTERACTIONS = 5000;
const MAX_DETAIL = 2000;

/** Forgets the history with contacts `matching`. */
async function forgetInteractions(ctx: Context, matching: (contactId: string) => boolean): Promise<void> {
  const entries = await readInteractions(ctx.env);
  const kept = entries.filter((e) => !matching(e.contactId));
  if (kept.length !== entries.length) await writeInteractions(ctx.env, kept);
}
const value = <T>(args: Args, name: string): T => {
  if (!(name in args)) throw invalidInput(`${name} is missing`);
  return args[name] as T;
};

async function todoistToken(ctx: Context): Promise<string> {
  const token = await readTodoistToken(ctx.env);
  if (!token) throw configError("Todoist isn't connected");
  return token;
}

async function tokenFor(ctx: Context, email: string): Promise<string> {
  return google.accessToken(ctx.env, await google.findAccount(ctx.env, email));
}

export const commands: Record<string, Command> = {
  // Accounts
  async google_accounts(ctx) {
    return (await readAccounts(ctx.env)).map((a) => a.email);
  },
  async remove_google_account(ctx, args) {
    const removed = await removeAccount(ctx.env, text(args, "email"));
    if (removed) {
      google.forgetAccessToken(removed.email);
      await google.revoke(removed.refreshToken);
      await forgetInteractions(ctx, (id) => id.startsWith(`${removed.email}/`));
    }
    return null;
  },

  // Reading
  async get_agenda(ctx, args) {
    return agenda.load(ctx, text(args, "from"), text(args, "to"));
  },
  // Nothing is saved on the server for offline use; the site always fetches.
  async get_saved_agenda() {
    return null;
  },
  async search(ctx, args) {
    return agenda.search(ctx, text(args, "query"));
  },
  async event_calendars(ctx) {
    return google.eventCalendars(ctx.env);
  },
  async google_calendars(ctx) {
    return google.allCalendars(ctx.env);
  },
  async set_google_calendar_shown(ctx, args) {
    await setCalendarShown(ctx.env, text(args, "email"), text(args, "calendarId"), flag(args, "shown"));
    return null;
  },

  // Events
  async create_event(ctx, args) {
    const token = await tokenFor(ctx, text(args, "email"));
    await google.createEvent(token, text(args, "calendarId"), value<EventDraft>(args, "event"));
    return null;
  },
  async update_event(ctx, args) {
    const target = value<EventRef>(args, "target");
    const token = await tokenFor(ctx, target.email);
    let calendarId = target.calendarId;
    const moveTo = args.moveTo as string | null;
    if (moveTo && moveTo !== calendarId) {
      await google.moveToCalendar(token, calendarId, target.eventId, moveTo);
      calendarId = moveTo;
    }
    const event = value<EventDraft>(args, "event");
    const occurrence = (args.occurrence ?? null) as EventTimes | null;
    const notify = flag(args, "notifyGuests");
    if (occurrence) await google.updateSeries(token, ctx.zone, calendarId, target.eventId, occurrence, event, notify);
    else await google.updateEvent(token, calendarId, target.eventId, event, notify);
    return null;
  },
  // Alerts on this browser (push.ts): the key to subscribe with, and turning
  // them on and off. A test sends one now, to every browser that's on.
  async push_key(ctx) {
    return push.publicKey(ctx.env);
  },
  async push_subscribe(ctx, args) {
    const sub = value<{ endpoint: string; keys: { p256dh: string; auth: string } }>(args, "subscription");
    const site = text(args, "site");
    if (!/^https:\/\//.test(sub?.endpoint ?? "") || !sub.keys?.p256dh || !sub.keys?.auth) throw invalidInput("not a push subscription");
    if (!/^https:\/\//.test(site)) throw invalidInput("not this site's address");
    await push.subscribe(ctx.env, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, zone: ctx.zone, site });
    // Alerts further ahead, now rather than at the next half hour.
    await reminders.lookAhead(ctx.env, Date.now()).catch(() => {});
    return null;
  },
  async push_unsubscribe(ctx, args) {
    await push.unsubscribe(ctx.env, text(args, "endpoint"));
    return null;
  },
  async push_test(ctx) {
    await push.sendToAll(ctx.env, { title: "Minuteman", body: "Alerts are on for this device.", tag: "test" });
    return null;
  },
  async event_recurrence(ctx, args) {
    const target = value<EventRef>(args, "target");
    return google.recurrence(await tokenFor(ctx, target.email), target.calendarId, target.eventId);
  },
  async end_series_before(ctx, args) {
    const target = value<EventRef>(args, "target");
    const token = await tokenFor(ctx, target.email);
    return google.endSeriesBefore(token, ctx.zone, target.calendarId, target.eventId, value<string>(args, "before"), flag(args, "allDay"));
  },
  async remove_event_attachment(ctx, args) {
    const target = value<EventRef>(args, "target");
    const token = await tokenFor(ctx, target.email);
    await google.removeAttachment(token, target.calendarId, target.eventId, text(args, "url"));
    return null;
  },
  async task_attachments(ctx, args) {
    return todoist.taskAttachments(await todoistToken(ctx), text(args, "id"));
  },
  async respond_to_event(ctx, args) {
    const target = value<EventRef>(args, "target");
    const token = await tokenFor(ctx, target.email);
    await google.respondToEvent(token, target.calendarId, target.eventId, text(args, "response"));
    return null;
  },
  async set_event_times(ctx, args) {
    const target = value<EventRef>(args, "target");
    const token = await tokenFor(ctx, target.email);
    await google.setEventTimes(token, target.calendarId, target.eventId, value<EventTimes>(args, "times"), flag(args, "notifyGuests"));
    return null;
  },
  async delete_event(ctx, args) {
    const target = value<EventRef>(args, "target");
    const token = await tokenFor(ctx, target.email);
    await google.deleteEvent(token, target.calendarId, target.eventId, flag(args, "notifyGuests"));
    return null;
  },

  // Contacts
  async get_contacts(ctx) {
    return contacts.allContacts(ctx.env);
  },
  // Nothing is saved on the server for offline use; the site always fetches.
  async get_saved_contacts() {
    return null;
  },
  async create_contact(ctx, args) {
    return contacts.createContact(ctx.env, text(args, "email"), value<ContactDraft>(args, "contact"));
  },
  async update_contact(ctx, args) {
    return contacts.updateContact(ctx.env, value<ContactRef>(args, "target"), value<ContactDraft>(args, "contact"));
  },
  async delete_contact(ctx, args) {
    const target = value<ContactRef>(args, "target");
    await contacts.deleteContact(ctx.env, target);
    await forgetInteractions(ctx, (id) => id === `${target.email}/${target.resourceName}`);
    return null;
  },
  async interactions(ctx) {
    return readInteractions(ctx.env);
  },
  /** Logs a call, message, note… with someone, now. */
  async log_interaction(ctx, args) {
    const { contactId, kind, detail } = value<{ contactId: string; kind: InteractionKind; detail?: string | null }>(
      args,
      "interaction",
    );
    if (!INTERACTION_KINDS.includes(kind)) throw invalidInput(`not a kind of interaction: ${JSON.stringify(kind)}`);
    if (typeof contactId !== "string" || !contactId.includes("/people/")) throw invalidInput("not a contact");
    const text = typeof detail === "string" ? detail.trim().slice(0, MAX_DETAIL) : "";
    const entry: Interaction = { contactId, kind, at: new Date().toISOString(), detail: text || null };
    const entries = [...(await readInteractions(ctx.env)), entry].slice(-MAX_INTERACTIONS);
    await writeInteractions(ctx.env, entries);
    return entry;
  },
  async set_contact_starred(ctx, args) {
    return contacts.setStarred(ctx.env, value<ContactRef>(args, "target"), flag(args, "starred"));
  },
  async set_contact_photo(ctx, args) {
    return contacts.setPhoto(ctx.env, value<ContactRef>(args, "target"), text(args, "data"));
  },
  async contact_photo(_ctx, args) {
    return contacts.contactPhoto(text(args, "url"));
  },
  async remove_contact_photo(ctx, args) {
    return contacts.removePhoto(ctx.env, value<ContactRef>(args, "target"));
  },
  /** Duplicates into one; what's logged with the others moves to it. */
  async merge_contacts(ctx, args) {
    const keep = value<ContactRef>(args, "keep");
    const others = value<ContactRef[]>(args, "others");
    if (!Array.isArray(others)) throw invalidInput("others must be a list");
    const photo = typeof args.photo === "string" ? args.photo : null;
    const saved = await contacts.mergeContacts(ctx.env, keep, others, value<ContactDraft>(args, "contact"), photo, flag(args, "starred"));
    const moved = new Set(others.map((o) => `${o.email}/${o.resourceName}`));
    const entries = await readInteractions(ctx.env);
    if (entries.some((e) => moved.has(e.contactId))) {
      await writeInteractions(
        ctx.env,
        entries.map((e) => (moved.has(e.contactId) ? { ...e, contactId: saved.id } : e)),
      );
    }
    return saved;
  },

  // Todoist
  async todoist_status(ctx) {
    return (await readTodoistToken(ctx.env)) !== null;
  },
  /** Checks the API token with Todoist, then stores it (encrypted). */
  async todoist_connect(ctx, args) {
    const token = text(args, "token").trim();
    if (!token) throw invalidInput("paste your Todoist API token first");
    await todoist.verifyToken(token);
    await writeTodoistToken(ctx.env, token);
    return null;
  },
  async todoist_disconnect(ctx) {
    await writeTodoistToken(ctx.env, null);
    return null;
  },
  async todoist_projects(ctx) {
    return todoist.projects(await todoistToken(ctx));
  },
  async create_task(ctx, args) {
    await todoist.createTask(await todoistToken(ctx), value<TaskDraft>(args, "task"));
    return null;
  },
  async update_task(ctx, args) {
    await todoist.updateTask(await todoistToken(ctx), text(args, "id"), value<TaskDraft>(args, "task"));
    return null;
  },
  async set_task_due(ctx, args) {
    await todoist.setTaskDue(await todoistToken(ctx), text(args, "id"), value<TaskDue>(args, "due"));
    return null;
  },
  async delete_task(ctx, args) {
    await todoist.deleteTask(await todoistToken(ctx), text(args, "id"));
    return null;
  },
  async set_task_completed(ctx, args) {
    await todoist.setCompleted(await todoistToken(ctx), text(args, "id"), flag(args, "completed"));
    return null;
  },

  // Desktop-only windows have nothing to do on the web.
  async show_main() {
    return null;
  },

  // Leave-by. The address and the caps live in KV. The Routes key is a Worker
  // secret and is never returned. Lookups, when the secret is set, use the
  // same daily and monthly cap as the desktop app.
  async get_preferences(ctx) {
    const leave = await readLeaveSettings(ctx.env);
    const limits = clampLimits(leave.routesDailyLimit, leave.routesMonthlyLimit);
    const prefs: Preferences = {
      menuBarNext: true,
      taskAlerts: leave.taskAlerts !== false,
      timeToLeave: false,
      leaveFrom: leave.leaveFrom,
      leaveFromHere: !!leave.leaveFromHere,
      routesDailyLimit: limits.daily,
      routesMonthlyLimit: limits.monthly,
      appleCalendar: false,
      appleReminders: false,
      appleCalendarsShown: {},
    };
    return prefs;
  },
  async set_preferences(ctx, args) {
    const prefs = value<Partial<Preferences>>(args, "preferences");
    const limits = clampLimits(Number(prefs.routesDailyLimit), Number(prefs.routesMonthlyLimit));
    const leaveFrom = typeof prefs.leaveFrom === "string" ? prefs.leaveFrom.trim().slice(0, 300) : "";
    await writeLeaveSettings(ctx.env, {
      leaveFrom,
      leaveFromHere: prefs.leaveFromHere === true,
      routesDailyLimit: limits.daily,
      routesMonthlyLimit: limits.monthly,
      taskAlerts: prefs.taskAlerts !== false,
    });
    return null;
  },
  async leave_times(ctx, args) {
    const events = args.events;
    if (!Array.isArray(events)) throw invalidInput("events must be a list");
    const here = typeof args.here === "string" ? args.here : null;
    const near = typeof args.near === "string" ? args.near : null;
    return routes.leaveTimes(ctx.env, events as LeaveQuery[], here, near);
  },
  async routes_key_status(ctx) {
    const configured = !!ctx.env.MINUTEMAN_ROUTES_API_KEY?.trim();
    // "environment" means the Worker secret. The key itself is not sent.
    return { configured, source: configured ? "environment" : "none" };
  },
  async routes_usage(ctx) {
    const leave = await readLeaveSettings(ctx.env);
    const limits = clampLimits(leave.routesDailyLimit, leave.routesMonthlyLimit);
    const usage = (await readRoutesUsage(ctx.env)) ?? emptyUsage(new Date());
    const today = pacificDate(new Date());
    return {
      dayCount: usage.day === today ? usage.dayCount : 0,
      dayLimit: limits.daily,
      monthCount: usage.month === today.slice(0, 7) ? usage.monthCount : 0,
      monthLimit: limits.monthly,
      capped: capped(usage, today, limits),
      maxDaily: MAX_DAILY,
      maxMonthly: MAX_MONTHLY,
    };
  },
  /** Places by name, from TomTom, when OpenStreetMap doesn't know one (places.ts). */
  async search_places(ctx, args) {
    const near = args.near as { latitude?: unknown; longitude?: unknown } | null | undefined;
    const spot =
      near && typeof near.latitude === "number" && typeof near.longitude === "number"
        ? { latitude: near.latitude, longitude: near.longitude }
        : null;
    return places.searchPlaces(ctx.env, text(args, "query"), spot);
  },
  async places_key_status(ctx) {
    const configured = !!ctx.env.MINUTEMAN_TOMTOM_API_KEY?.trim();
    return { configured, source: configured ? "environment" : "none" };
  },
  async places_usage(ctx) {
    return places.placesUsage(ctx.env);
  },
  async set_places_key() {
    throw invalidInput("On the website the TomTom key is a Cloudflare secret, not something you paste here");
  },
  async set_routes_key() {
    throw invalidInput("On the website the Routes key is a Cloudflare secret, not something you paste here");
  },
};

/** The largest file that can be attached. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Attaching a file (`/upload/attach_to_event` or `/upload/attach_to_task`):
 * the file is the request's body, as it is, and what it's for comes in the
 * X-Attach header (JSON, URI-encoded): { target | id, name, mimeType }.
 */
export async function upload(ctx: Context, name: string, request: Request): Promise<unknown> {
  let meta: { target?: EventRef; id?: string; name?: string; mimeType?: string };
  try {
    meta = JSON.parse(decodeURIComponent(request.headers.get("X-Attach") ?? "{}"));
  } catch {
    throw invalidInput("the file's details didn't come through");
  }
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > MAX_ATTACHMENT_BYTES) throw invalidInput("files can be up to 25 MB");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw invalidInput("files can be up to 25 MB");
  const fileName = (meta.name ?? "").trim().slice(0, 200) || "Attachment";
  const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(meta.mimeType ?? "") ? meta.mimeType! : "application/octet-stream";
  if (name === "attach_to_event") {
    const target = meta.target;
    if (!target?.email || !target.calendarId || !target.eventId) throw invalidInput("which event?");
    const account = await google.findAccount(ctx.env, target.email);
    const token = await google.accessToken(ctx.env, account);
    return google.attachToEvent(account, token, target.calendarId, target.eventId, fileName, mimeType, bytes);
  }
  if (name === "attach_to_task") {
    if (!meta.id) throw invalidInput("which task?");
    return todoist.attachToTask(await todoistToken(ctx), meta.id, fileName, mimeType, bytes);
  }
  throw invalidInput(`unknown upload ${name}`);
}
