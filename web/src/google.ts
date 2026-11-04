// Google sign-in (server side) and Google Calendar API v3. A port of
// src-tauri/src/google/auth.rs and calendar.rs; behavior should match them.
import type {
  AccountCalendarList,
  AccountCalendars,
  AgendaItem,
  Attendee,
  EventCalendar,
  EventDraft,
  EventTimes,
} from "../../src/api";
import { eventColor } from "../../src/event-colors";
import { placeOnOneLine } from "../../src/time";
import type { Env } from "./env";
import { AppError, apiError, authFailed, configError, fetchOrFail, invalidInput, notSignedIn } from "./errors";
import { type Account, readAccounts, readHiddenCalendars, removeAccount, writeAccounts } from "./store";
import {
  addDays,
  dayOf,
  dayString,
  midnight,
  parseDay,
  type Wall,
  validZone,
  wallClock,
  wallFromMs,
  wallMs,
  wallToInstant,
} from "./zone";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

/** Lets the app change events. Reading the calendar list needs `calendar.readonly`. */
const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/** Lets the Contacts page read and change your Google Contacts. */
const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts";
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly", EVENTS_SCOPE, CONTACTS_SCOPE];

/** Refresh a little before Google's stated expiry so a request never races it. */
const EXPIRY_MARGIN_MS = 60_000;

function client(env: Env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw configError("The Google web client isn't configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }
  return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
}

// ---------- Sign-in ----------

export function authorizeUrl(env: Env, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: client(env).id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    // "offline": also give a refresh token. "consent": even if this account
    // approved the app before. "select_account": let you pick which account.
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
  }).toString();
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

interface TokenError {
  error: string;
  error_description?: string;
}

async function postToken(env: Env, fields: Record<string, string>): Promise<TokenResponse | TokenError> {
  const { id, secret } = client(env);
  const response = await fetchOrFail(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...fields }),
  });
  return (await response.json()) as TokenResponse | TokenError;
}

const describe = (e: TokenError) => (e.error_description ? `${e.error} (${e.error_description})` : e.error);

/** Finishes a sign-in: swaps the one-time code for tokens, and stores the account. */
export async function finishSignIn(
  env: Env,
  code: string,
  verifier: string,
  redirectUri: string,
  mayAddAnyAccount: boolean,
): Promise<string> {
  const tokens = await postToken(env, {
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if ("error" in tokens) throw authFailed(describe(tokens));
  if (!tokens.refresh_token) throw authFailed("Google didn't return a refresh token");

  const email = await primaryEmail(tokens.access_token);
  const accounts = await readAccounts(env);
  const allowed = env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase());
  const known = accounts.some((a) => a.email === email);
  if (!mayAddAnyAccount && !known && !allowed.includes(email.toLowerCase())) {
    await revoke(tokens.refresh_token);
    throw new AppError("auth", `Sign-in failed: ${email} isn't allowed on this site.`, 403);
  }

  const account: Account = {
    email,
    refreshToken: tokens.refresh_token,
    canEditEvents: tokens.scope.split(" ").includes(EVENTS_SCOPE),
    canUseContacts: tokens.scope.split(" ").includes(CONTACTS_SCOPE),
  };
  await writeAccounts(env, [...accounts.filter((a) => a.email !== email), account]);
  remember(email, tokens);
  return email;
}

export async function revoke(token: string): Promise<void> {
  // Best effort: still forget the account if Google can't be reached.
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}

/** Access tokens (about an hour each), kept only in this server instance's memory. */
const accessTokens = new Map<string, { value: string; expiresAt: number }>();

function remember(email: string, tokens: TokenResponse): void {
  accessTokens.set(email, { value: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 });
}

/** A valid access token for `account`, refreshing it first if needed. */
export async function accessToken(env: Env, account: Account): Promise<string> {
  const cached = accessTokens.get(account.email);
  if (cached && cached.expiresAt > Date.now() + EXPIRY_MARGIN_MS) return cached.value;

  const tokens = await postToken(env, { refresh_token: account.refreshToken, grant_type: "refresh_token" });
  if ("error" in tokens) {
    // Revoked or expired (e.g. the project is in "Testing" and 7 days passed):
    // forget the account so the site asks to add it again.
    if (tokens.error === "invalid_grant") {
      await removeAccount(env, account.email);
      throw notSignedIn();
    }
    throw authFailed(describe(tokens));
  }
  remember(account.email, tokens);
  return tokens.access_token;
}

export function forgetAccessToken(email: string): void {
  accessTokens.delete(email);
}

// ---------- Calendar API ----------

interface CalendarListEntry {
  id: string;
  summary?: string;
  /** The name you gave a calendar someone else shares with you. */
  summaryOverride?: string;
  backgroundColor?: string;
  /** "owner", "writer", "reader" or "freeBusyReader". */
  accessRole?: string;
  primary?: boolean;
  defaultReminders?: Reminder[];
  /** For events that don't name their own. */
  timeZone?: string;
}

const calendarName = (c: CalendarListEntry) => c.summaryOverride ?? c.summary ?? c.id;
const canWrite = (c: CalendarListEntry) => c.accessRole === "owner" || c.accessRole === "writer";

interface Reminder {
  method?: string;
  minutes?: number;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: {
    self?: boolean;
    responseStatus?: string;
    email?: string;
    displayName?: string;
    organizer?: boolean;
    resource?: boolean;
  }[];
  eventType?: string;
  description?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  reminders?: { useDefault?: boolean; overrides?: Reminder[] };
  organizer?: { self?: boolean };
  guestsCanModify?: boolean;
  recurringEventId?: string;
  extendedProperties?: { private?: Record<string, string> };
  colorId?: string;
}

/**
 * Marks an event (privately, on your copy) as keeping its clock time in any
 * time zone, as in google/calendar.rs. Google itself has no such events.
 */
const FLOATING = "minutemanFloating";

/**
 * Exact-time alerts, and any reminder Google's API can't store, kept on the
 * event as a private property (a JSON string). Google Calendar reminders are
 * only "minutes before the start", at most 5 of them, and at most 4 weeks
 * out. These are not reminder overrides: Google's own apps neither show nor
 * send them. Minuteman reads them back with the event and fires them itself
 * (on the desktop). Kept in step with `LOCAL_ALERTS` in google/calendar.rs.
 */
const LOCAL_ALERTS = "minutemanAlerts";
/** This event's own starting address. Kept in step with `LEAVE_FROM` in google/calendar.rs. */
const LEAVE_FROM = "minutemanLeaveFrom";
const GOOGLE_MAX_OVERRIDES = 5;
const GOOGLE_MAX_MINUTES = 40_320;

/** Only the event fields the app uses, to keep replies (and the server's work) small. */
const EVENT_FIELDS =
  "nextPageToken,items(id,status,summary,location,htmlLink,start,end,eventType,description,hangoutLink," +
  "attendees(self,responseStatus,email,displayName,organizer,resource),conferenceData/entryPoints(entryPointType,uri)," +
  "reminders,organizer/self,guestsCanModify,recurringEventId,extendedProperties/private,colorId)";

const path = (...segments: string[]) => segments.map(encodeURIComponent).join("/");

/** Sends a request to a Google API and reads the JSON reply, or Google's error message. */
export async function google<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchOrFail(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  if (response.ok) return (response.status === 204 ? undefined : await response.json()) as T;
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  throw apiError(response.status, body?.error?.message ?? response.statusText);
}

/** Google returns long lists in pages; keep asking for the next page until there isn't one. */
async function allPages<T>(token: string, url: URL): Promise<T[]> {
  const all: T[] = [];
  let pageToken: string | undefined;
  do {
    const page = new URL(url);
    if (pageToken) page.searchParams.set("pageToken", pageToken);
    const reply = await google<{ items?: T[]; nextPageToken?: string }>(token, page.toString());
    all.push(...(reply.items ?? []));
    pageToken = reply.nextPageToken;
  } while (pageToken);
  return all;
}

const listCalendars = (token: string) =>
  allPages<CalendarListEntry>(token, new URL(`${API}/users/me/calendarList`));

/** A repeating event's rules (RRULE, EXDATE and so on), from its series. Empty if it doesn't repeat. */
export async function recurrence(token: string, calendarId: string, eventId: string): Promise<string[]> {
  const url = new URL(`${API}/${path("calendars", calendarId, "events", eventId)}`);
  url.searchParams.set("fields", "recurrence");
  return (await google<{ recurrence?: string[] }>(token, url.toString())).recurrence ?? [];
}

/**
 * "This and following events": ends the series just before its occurrence at
 * `before` (an RFC 3339 time, or a date for an all-day series), and returns
 * its rules for a new series from there (RRULE lines; a COUNT becomes what's
 * left of it). Null when that's its first occurrence. As `end_series_before`
 * in calendar.rs. `zone`: where an all-day `before` day starts.
 */
export async function endSeriesBefore(
  token: string,
  zone: string,
  calendarId: string,
  seriesId: string,
  before: string,
  allDay: boolean,
): Promise<string[] | null> {
  const url = new URL(`${API}/${path("calendars", calendarId, "events", seriesId)}`);
  url.searchParams.set("fields", "start,recurrence");
  const series = await google<{ start?: { date?: string; dateTime?: string }; recurrence?: string[] }>(token, url.toString());
  const rules = series.recurrence ?? [];
  const until = untilBefore(before, allDay);
  if (!until) throw invalidInput("not a time or date");
  const first = series.start?.dateTime ?? series.start?.date ?? "";
  if (rules.length === 0 || !startsBefore(first, before)) return null;
  const isRule = (rule: string) => /^RRULE:/i.test(rule);
  // "10 times": the new series has as many as are left after the ones before.
  const counted = rules.some((rule) => countOf(rule) !== null);
  const beforeCount = counted ? await instancesBefore(token, calendarId, seriesId, allDay ? midnight(before.slice(0, 10), zone).toISOString() : before) : 0;
  const ended = rules.map((rule) => (isRule(rule) ? `${withoutParts(rule, ["UNTIL", "COUNT"])};UNTIL=${until}` : rule));
  url.search = "";
  await google(token, url.toString(), { method: "PATCH", body: JSON.stringify({ recurrence: ended }) });
  return followingRules(rules, beforeCount);
}

/** RRULE lines for the part from an occurrence on, any COUNT less the `beforeCount` that came before. */
export function followingRules(rules: string[], beforeCount: number): string[] {
  return rules
    .filter((rule) => /^RRULE:/i.test(rule))
    .map((rule) => {
      const count = countOf(rule);
      return count === null ? rule : `${withoutParts(rule, ["COUNT"])};COUNT=${Math.max(1, count - beforeCount)}`;
    });
}

function countOf(rule: string): number | null {
  const m = /(?:^RRULE:|;)COUNT=(\d+)/i.exec(rule);
  return m ? Number(m[1]) : null;
}

/** How many of a series' occurrences start before `timeMax`, cancelled ones too (they count toward its COUNT). */
async function instancesBefore(token: string, calendarId: string, seriesId: string, timeMax: string): Promise<number> {
  let count = 0;
  let page: string | undefined;
  do {
    const url = new URL(`${API}/${path("calendars", calendarId, "events", seriesId, "instances")}`);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("maxResults", "2500");
    url.searchParams.set("fields", "items(id),nextPageToken");
    if (page) url.searchParams.set("pageToken", page);
    const found = await google<{ items?: unknown[]; nextPageToken?: string }>(token, url.toString());
    count += found.items?.length ?? 0;
    page = found.nextPageToken;
  } while (page);
  return count;
}

/** The UNTIL that ends a series just before `before`: the day before (all day), or a second before, in UTC. */
export function untilBefore(before: string, allDay: boolean): string | null {
  if (allDay) {
    if (!isDay(before.slice(0, 10))) return null;
    const day = new Date(`${before.slice(0, 10)}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - 1);
    return day.toISOString().slice(0, 10).replaceAll("-", "");
  }
  const at = Date.parse(before);
  if (Number.isNaN(at)) return null;
  return new Date(at - 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function startsBefore(first: string, before: string): boolean {
  const [a, b] = [Date.parse(first), Date.parse(before)];
  return Number.isNaN(a) || Number.isNaN(b) ? first.slice(0, 10) < before.slice(0, 10) : a < b;
}

function withoutParts(rule: string, names: string[]): string {
  const kept = rule
    .replace(/^RRULE:/i, "")
    .split(";")
    .filter((part) => part && !names.includes(part.split("=")[0].toUpperCase()));
  return `RRULE:${kept.join(";")}`;
}

/** The signed-in account's email address, which is its primary calendar's ID. */
async function primaryEmail(token: string): Promise<string> {
  return (await google<{ id: string }>(token, `${API}/calendars/primary`)).id;
}

function listEvents(token: string, calendarId: string, from: Date, to: Date, query?: string) {
  const url = new URL(`${API}/${path("calendars", calendarId, "events")}`);
  url.searchParams.set("timeMin", from.toISOString());
  url.searchParams.set("timeMax", to.toISOString());
  // Expand repeating events into their individual occurrences.
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "250");
  url.searchParams.set("fields", EVENT_FIELDS);
  if (query) url.searchParams.set("q", query);
  return allPages<GoogleEvent>(token, url);
}

export interface CalendarEvents {
  items: AgendaItem[];
  /** Calendars that failed to load; the rest are still shown. */
  warnings: string[];
}

/**
 * Events between `from` and `to` on the account's calendars (leaving out
 * the ones in `hidden`), optionally matching `query`.
 */
export async function findEvents(
  token: string,
  account: Account,
  from: Date,
  to: Date,
  hidden: string[],
  zone: string,
  query?: string,
): Promise<CalendarEvents> {
  const calendars = (await listCalendars(token)).filter((c) => !hidden.includes(c.id));
  const results = await Promise.allSettled(calendars.map((c) => listEvents(token, c.id, from, to, query)));
  const items: AgendaItem[] = [];
  const warnings: string[] = [];
  calendars.forEach((calendar, i) => {
    const result = results[i];
    if (result.status === "fulfilled") {
      for (const event of result.value) {
        const item = toAgendaItem(account, calendar, event, zone);
        if (item) items.push(item);
      }
    } else {
      warnings.push(`${calendarName(calendar)}: ${errorText(result.reason)}`);
    }
  });
  return { items, warnings };
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every account's calendars, and which are shown: the main one first, then by name. */
export async function allCalendars(env: Env): Promise<AccountCalendarList[]> {
  const [accounts, hidden] = await Promise.all([readAccounts(env), readHiddenCalendars(env)]);
  return Promise.all(
    accounts.map(async (account): Promise<AccountCalendarList> => {
      try {
        const token = await accessToken(env, account);
        const calendars = (await listCalendars(token))
          .map((c) => ({
            id: c.id,
            name: calendarName(c),
            color: c.backgroundColor ?? null,
            primary: !!c.primary,
            shown: !(hidden[account.email] ?? []).includes(c.id),
          }))
          .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
        return { email: account.email, calendars, error: null };
      } catch (e) {
        return { email: account.email, calendars: [], error: errorText(e) };
      }
    }),
  );
}

/** The calendars you can add events to, your main ("primary") one first. */
export async function eventCalendars(env: Env): Promise<AccountCalendars[]> {
  const accounts = await readAccounts(env);
  return Promise.all(
    accounts.map(async (account): Promise<AccountCalendars> => {
      if (!account.canEditEvents) return { email: account.email, canEdit: false, calendars: [], error: null };
      try {
        const token = await accessToken(env, account);
        const calendars: EventCalendar[] = (await listCalendars(token))
          .filter(canWrite)
          .map((c) => ({ id: c.id, name: calendarName(c), color: c.backgroundColor ?? null, primary: !!c.primary }))
          .sort((a, b) => Number(b.primary) - Number(a.primary));
        return { email: account.email, canEdit: true, calendars, error: null };
      } catch (e) {
        return { email: account.email, canEdit: false, calendars: [], error: errorText(e) };
      }
    }),
  );
}

/**
 * An event as an agenda item. `zone` is the browser's: a floating event's
 * clock time in its own zone becomes that same clock time there.
 */
function toAgendaItem(account: Account, calendar: CalendarListEntry, event: GoogleEvent, zone: string): AgendaItem | null {
  if (event.status === "cancelled") return null;
  // "Working from home/office" markers clutter an agenda.
  if (event.eventType === "workingLocation") return null;
  const attendees = event.attendees ?? [];
  if (attendees.some((a) => a.self && a.responseStatus === "declined")) return null;

  const startValue = event.start?.dateTime ?? event.start?.date;
  if (!startValue) return null;
  const allDay = !event.start?.dateTime;
  const end = event.end?.dateTime ?? event.end?.date ?? null;
  const timeZone = event.start?.timeZone ?? calendar.timeZone ?? null;
  const floating = !allDay && event.extendedProperties?.private?.[FLOATING] === "true";
  const floatHere = (instant: string) =>
    floating && timeZone ? wallToInstant(wallClock(new Date(instant), validZone(timeZone)), zone).toISOString() : instant;

  const conferenceUrl =
    event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    event.hangoutLink ??
    findMeetingLink(event.location) ??
    findMeetingLink(event.description) ??
    null;
  const source =
    event.reminders && !event.reminders.useDefault ? (event.reminders.overrides ?? []) : (calendar.defaultReminders ?? []);
  const stored = readStored(event.extendedProperties?.private?.[LOCAL_ALERTS]);
  // All-day events too: "1 day before" is measured back from midnight.
  const reminders = unique([...minutesOf(source, "popup"), ...stored.popup]);
  const emailReminders = unique([...minutesOf(source, "email"), ...stored.email]);
  const alertAt = stored.at;
  const leaveAlerts = stored.leave;
  const organizedByYou = !event.organizer || !!event.organizer.self;
  const guests: Attendee[] = attendees
    .filter((a) => !a.resource)
    .map((a) => ({
      name: a.displayName ?? null,
      email: a.email ?? null,
      response: a.responseStatus ?? null,
      organizer: !!a.organizer,
      isSelf: !!a.self,
    }));
  const nonEmpty = (s?: string) => (s && s.trim() ? s : null);
  const leaveFrom = nonEmpty(event.extendedProperties?.private?.[LEAVE_FROM]);

  return {
    id: `google:${calendar.id}:${event.id}`,
    source: "google",
    kind: "event",
    title: nonEmpty(event.summary) ?? "(No title)",
    start: floatHere(startValue),
    end: end && floatHere(end),
    allDay,
    floating,
    timeZone,
    location: placeOnOneLine(event.location),
    color: eventColor(event.colorId) ?? calendar.backgroundColor ?? null,
    colorId: eventColor(event.colorId) ? event.colorId! : null,
    listName: calendarName(calendar),
    url: event.htmlLink ?? null,
    completed: false,
    overdue: false,
    priority: null,
    account: account.email,
    listId: calendar.id,
    sourceId: event.id,
    seriesId: event.recurringEventId ?? null,
    editable: account.canEditEvents && canWrite(calendar) && (organizedByYou || !!event.guestsCanModify),
    recurring: !!event.recurringEventId,
    description: nonEmpty(event.description),
    attendees: guests,
    conferenceUrl,
    reminders,
    emailReminders,
    alertAt,
    leaveFrom,
    leaveAlerts,
  };
}

interface StoredAlerts {
  at?: string[];
  popup?: number[];
  email?: number[];
  leave?: number[];
}

const readStored = (value?: string): Required<StoredAlerts> => {
  if (!value) return { at: [], popup: [], email: [], leave: [] };
  try {
    const parsed = JSON.parse(value) as StoredAlerts;
    return { at: parsed.at ?? [], popup: parsed.popup ?? [], email: parsed.email ?? [], leave: parsed.leave ?? [] };
  } catch {
    return { at: [], popup: [], email: [], leave: [] };
  }
};

const minutesOf = (reminders: Reminder[], method: string) =>
  reminders.filter((r) => r.method === method && r.minutes !== undefined).map((r) => r.minutes!);

const unique = (minutes: number[]) => minutes.filter((m, i) => minutes.indexOf(m) === i);

const MEETING_HOSTS = [
  "zoom.us/",
  "meet.google.com/",
  "teams.microsoft.com/",
  "teams.live.com/",
  "webex.com/",
  "whereby.com/",
  "gotomeeting.com/",
  "chime.aws/",
];

/** The first video-call link in `text` (a location or notes, possibly HTML). */
function findMeetingLink(text?: string): string | null {
  if (!text) return null;
  const word = text
    .replaceAll("&amp;", "&")
    .split(/[\s"'<>()]+/)
    .find((w) => w.startsWith("https://") && MEETING_HOSTS.some((host) => w.includes(host)));
  return word ? word.replace(/[.,;]+$/, "") : null;
}

// ---------- Changing events ----------

const isDay = (s: string) => parseDay(s) !== null;

function parseTime(s: string): number {
  const t = Date.parse(s);
  if (Number.isNaN(t) || isDay(s)) throw invalidInput(`not an RFC 3339 time: ${JSON.stringify(s)}`);
  return t;
}

/** The `start` and `end` Google expects, after checking them. */
function timesJson(times: EventTimes): { start: object; end: object } {
  if (times.allDay) {
    if (!isDay(times.start) || !isDay(times.end)) throw invalidInput("not a YYYY-MM-DD date");
    if (times.end <= times.start) throw invalidInput("the event must end after its first day");
    return { start: { date: times.start }, end: { date: times.end } };
  }
  if (parseTime(times.end) < parseTime(times.start)) throw invalidInput("the event must end after it starts");
  const at = (dateTime: string) => (times.timeZone ? { dateTime, timeZone: times.timeZone } : { dateTime });
  return { start: at(times.start), end: at(times.end) };
}

function draftJson(draft: EventDraft): Record<string, unknown> {
  const title = draft.title.trim();
  if (!title) throw invalidInput("the event needs a title");
  const text = (s: string | null) => (s ?? "").trim();
  // An empty string clears a field when editing.
  const body: Record<string, unknown> = {
    summary: title,
    ...timesJson(draft),
    location: text(draft.location),
    description: text(draft.description),
  };
  const privateProps: Record<string, string> = {};
  if (draft.floating !== null && draft.floating !== undefined) privateProps[FLOATING] = String(draft.floating);
  if (draft.alerts) {
    const split = splitAlerts(draft.alerts);
    body.reminders = split.reminders;
    // An empty string asks an update to remove alerts kept earlier.
    privateProps[LOCAL_ALERTS] = split.stored;
  }
  if (typeof draft.leaveFrom === "string") privateProps[LEAVE_FROM] = draft.leaveFrom.trim();
  if (Object.keys(privateProps).length > 0) body.extendedProperties = { private: privateProps };
  if (draft.recurrence) body.recurrence = draft.recurrence;
  // null removes the event's own color (Google's update is a PATCH).
  if (typeof draft.colorId === "string") {
    const id = draft.colorId.trim();
    if (id && !eventColor(id)) throw invalidInput("that isn't one of Google Calendar's event colors");
    body.colorId = id || null;
  }
  if (draft.guests) {
    body.attendees = draft.guests.map((g) =>
      g.response ? { email: g.email.trim(), responseStatus: g.response } : { email: g.email.trim() },
    );
  }
  return body;
}

/** `calendars/{calendar}/events[/{event}]`, telling Google whether to email guests. */
function eventsUrl(calendarId: string, eventId: string | null, notifyGuests: boolean): string {
  const segments = eventId ? path("calendars", calendarId, "events", eventId) : path("calendars", calendarId, "events");
  return `${API}/${segments}?sendUpdates=${notifyGuests ? "all" : "none"}`;
}

export async function createEvent(token: string, calendarId: string, draft: EventDraft): Promise<void> {
  const hasGuests = !!draft.guests?.length;
  const body = draftJson(draft);
  dropEmptyPrivate(body);
  await google(token, eventsUrl(calendarId, null, hasGuests), { method: "POST", body: JSON.stringify(body) });
}

/** Saves an edited event. For one occurrence of a repeating event, only that one changes. */
export async function updateEvent(
  token: string,
  calendarId: string,
  eventId: string,
  draft: EventDraft,
  notifyGuests: boolean,
): Promise<void> {
  const body = draftJson(draft);
  await mergePrivate(token, calendarId, eventId, body);
  await google(token, eventsUrl(calendarId, eventId, notifyGuests), {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * Saves an edit made to every event in a repeating series, from one of its
 * occurrences (`occurrence`: when that one was, before the edit). Times move
 * by as much as the occurrence's did, so the series keeps its own first date.
 */
export async function updateSeries(
  token: string,
  zone: string,
  calendarId: string,
  seriesId: string,
  occurrence: EventTimes,
  draft: EventDraft,
  notifyGuests: boolean,
): Promise<void> {
  const body = draftJson(draft);
  delete body.start;
  delete body.end;
  const unchanged =
    occurrence.allDay === draft.allDay && sameTime(occurrence.start, draft.start) && sameTime(occurrence.end, draft.end);
  if (!unchanged) {
    const series = await google<{ start?: { date?: string; dateTime?: string } }>(
      token,
      eventsUrl(calendarId, seriesId, false),
    );
    const firstDay = series.start?.date ?? (series.start?.dateTime ? dayOf(new Date(series.start.dateTime), zone) : null);
    if (!firstDay) throw apiError(200, "Google sent a repeating event without a start");
    Object.assign(body, timesJson(shiftSeries(firstDay, occurrence, draft, zone)));
  }
  await mergePrivate(token, calendarId, seriesId, body);
  await google(token, eventsUrl(calendarId, seriesId, notifyGuests), { method: "PATCH", body: JSON.stringify(body) });
}

/**
 * The reminders Google will store, and a JSON string of the rest ("" when
 * there's nothing to keep). Mirrors `split_alerts` in google/calendar.rs.
 */
function splitAlerts(alerts: NonNullable<EventDraft["alerts"]>): {
  reminders: { useDefault: boolean; overrides?: { method: string; minutes: number }[] };
  stored: string;
} {
  if (alerts.kind === "default") return { reminders: { useDefault: true }, stored: "" };
  const specs =
    alerts.alerts ?? (alerts.minutes ?? []).map((minutes) => ({ kind: "relative" as const, minutes, method: "popup" as const }));
  const overrides: { method: string; minutes: number }[] = [];
  const stored: Required<StoredAlerts> = { at: [], popup: [], email: [], leave: [] };
  for (const spec of specs) {
    if (spec.kind === "absolute") {
      parseTime(spec.at);
      stored.at.push(spec.at);
      continue;
    }
    if (spec.kind === "leave") {
      const buffer = spec.bufferMinutes;
      if (!Number.isInteger(buffer) || buffer < 0 || buffer > 7 * 24 * 60) {
        throw invalidInput("a leave alert can't be more than a week before you need to leave");
      }
      if (!stored.leave.includes(buffer)) stored.leave.push(buffer);
      continue;
    }
    const minutes = spec.minutes;
    if (!Number.isInteger(minutes) || minutes < 0) throw invalidInput("a notification's lead time must be a whole number of minutes");
    const method = spec.method === "email" ? "email" : "popup";
    if (minutes <= GOOGLE_MAX_MINUTES && overrides.length < GOOGLE_MAX_OVERRIDES) overrides.push({ method, minutes });
    else if (method === "email") stored.email.push(minutes);
    else stored.popup.push(minutes);
  }
  const kept = stored.at.length || stored.popup.length || stored.email.length || stored.leave.length ? JSON.stringify(stored) : "";
  return { reminders: { useDefault: false, overrides }, stored: kept };
}

/** A new event has nothing to clear: don't store a blank private key. */
function dropEmptyPrivate(body: Record<string, unknown>): void {
  const ext = body.extendedProperties as { private?: Record<string, string> } | undefined;
  if (!ext?.private) return;
  for (const [key, value] of Object.entries(ext.private)) if (value === "") delete ext.private[key];
  if (Object.keys(ext.private).length === 0) delete body.extendedProperties;
}

/**
 * Google replaces the whole private-property map when a patch includes one.
 * Read what's there and lay our keys over it. An empty string removes a key.
 */
async function mergePrivate(token: string, calendarId: string, eventId: string, body: Record<string, unknown>): Promise<void> {
  const ext = body.extendedProperties as { private?: Record<string, string> } | undefined;
  if (!ext?.private) return;
  const url = new URL(`${API}/${path("calendars", calendarId, "events", eventId)}`);
  url.searchParams.set("fields", "extendedProperties/private");
  const current = await google<{ extendedProperties?: { private?: Record<string, string> } }>(token, url.toString());
  const merged = { ...(current.extendedProperties?.private ?? {}) };
  for (const [key, value] of Object.entries(ext.private)) {
    if (value === "") delete merged[key];
    else merged[key] = value;
  }
  body.extendedProperties = { private: merged };
}

function sameTime(a: string, b: string): boolean {
  return a === b || (!isDay(a) && !isDay(b) && Date.parse(a) === Date.parse(b));
}

/** Local date and time of a `start`/`end` (midnight for whole days). */
function localWall(s: string, allDay: boolean, zone: string): Wall {
  if (allDay) {
    const day = parseDay(s);
    if (!day) throw invalidInput(`not a YYYY-MM-DD date: ${JSON.stringify(s)}`);
    return day;
  }
  return wallClock(new Date(parseTime(s)), zone);
}

/** The series' times after an occurrence went from `occurrence` to `edited`. */
function shiftSeries(firstDay: string, occurrence: EventTimes, edited: EventTimes, zone: string): EventTimes {
  const was = localWall(occurrence.start, occurrence.allDay, zone);
  const start = localWall(edited.start, edited.allDay, zone);
  const end = localWall(edited.end, edited.allDay, zone);
  const dayShift = Math.round((wallMs({ ...start, hour: 0, minute: 0, second: 0 }) - wallMs({ ...was, hour: 0, minute: 0, second: 0 })) / 86_400_000);
  const newDay = parseDay(addDays(firstDay, dayShift))!;
  const newStart = { ...newDay, hour: start.hour, minute: start.minute, second: start.second };
  const newEnd = wallFromMs(wallMs(newStart) + (wallMs(end) - wallMs(start)));
  const formatted = (w: Wall) => (edited.allDay ? dayString(w) : wallToInstant(w, zone).toISOString());
  return { start: formatted(newStart), end: formatted(newEnd), allDay: edited.allDay, timeZone: edited.timeZone };
}

/** Moves an event to another of the same account's calendars. */
export async function moveToCalendar(token: string, calendarId: string, eventId: string, destination: string) {
  const url = `${API}/${path("calendars", calendarId, "events", eventId, "move")}?destination=${encodeURIComponent(destination)}`;
  await google(token, url, { method: "POST" });
}

/**
 * Your reply to an invitation ("accepted", "declined", "tentative"): only your
 * own entry on the guest list changes, and the organizer is told. As
 * `respond` in calendar.rs.
 */
export async function respondToEvent(token: string, calendarId: string, eventId: string, response: string): Promise<void> {
  if (!["accepted", "declined", "tentative"].includes(response)) throw invalidInput("a reply is yes, no or maybe");
  const read = new URL(`${API}/${path("calendars", calendarId, "events", eventId)}`);
  read.searchParams.set("fields", "attendees");
  const { attendees = [] } = await google<{ attendees?: Record<string, unknown>[] }>(token, read.toString());
  const you = attendees.find((a) => a.self === true);
  if (!you) throw invalidInput("you're not on this event's guest list");
  you.responseStatus = response;
  await google(token, `${eventsUrl(calendarId, eventId, true)}&fields=id`, { method: "PATCH", body: JSON.stringify({ attendees }) });
}

/** Changes only when an event happens (dragging it). */
export async function setEventTimes(
  token: string,
  calendarId: string,
  eventId: string,
  times: EventTimes,
  notifyGuests: boolean,
): Promise<void> {
  await google(token, eventsUrl(calendarId, eventId, notifyGuests), {
    method: "PATCH",
    body: JSON.stringify(timesJson(times)),
  });
}

/** Deletes an event: a series' own ID deletes every occurrence; an occurrence's ID, just that one. */
export async function deleteEvent(token: string, calendarId: string, eventId: string, notifyGuests: boolean) {
  try {
    await google(token, eventsUrl(calendarId, eventId, notifyGuests), { method: "DELETE" });
  } catch (e) {
    // 410 Gone: it was already deleted, which is what we wanted.
    if (!(e instanceof AppError && e.message.startsWith("Google API error (410)"))) throw e;
  }
}

/** The account with this email, or "not signed in". */
export async function findAccount(env: Env, email: string): Promise<Account> {
  const account = (await readAccounts(env)).find((a) => a.email === email);
  if (!account) throw notSignedIn();
  return account;
}
