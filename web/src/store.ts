// What the server keeps, in Cloudflare KV (a simple key–value store):
//
//   accounts            encrypted list of Google accounts and their refresh tokens
//   todoist             encrypted Todoist API token
//   hiddenCalendars     encrypted list of Google calendars hidden in Settings
//   interactions        encrypted history with people in Contacts (calls, notes…)
//   leaveSettings       default leave-from address and the Routes caps
//   routesUsage         how many Routes attempts have been made (the free-tier cap)
//   routesCache         recent drive times, so a refresh doesn't ask again
//   geocodeCache        vague addresses already matched (OpenStreetMap), so a refresh doesn't ask again
//   placesUsage         how many TomTom place searches have been made (places.ts)
//   pushSubscriptions   encrypted list of phones and browsers with alerts on (push.ts)
//   pushKey             encrypted key the site signs its alerts with (push.ts)
//   pushUpcoming        encrypted alerts due in the next half hour, further ahead (reminders.ts)
//   session:<hash>      a signed-in browser (only a hash of its cookie is kept)
//   oauth:<state>       a Google sign-in in progress (10 minutes)
//
// One person per deployment: the site's owner, who can add several Google
// accounts. Tokens never leave the server; browsers only get a session cookie.
import type { Interaction } from "../../src/api";
import type { Usage } from "../../src/routes-budget";
import type { GeoCache } from "./nominatim";
import { decrypt, encrypt, randomToken, sha256 } from "./crypto";
import type { Env } from "./env";

export interface Account {
  email: string;
  refreshToken: string;
  /** Whether Google granted the permission to change events. */
  canEditEvents: boolean;
  /** Whether Google granted the permission to use contacts (missing on accounts added before). */
  canUseContacts?: boolean;
  /** Whether Google granted putting attached files in Drive (missing on accounts added before). */
  canAttachFiles?: boolean;
}

const SESSION_DAYS = 30;
export const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

async function readEncrypted(env: Env, key: string): Promise<string | null> {
  const value = await env.STORE.get(key);
  return value === null ? null : decrypt(env, value);
}

async function writeEncrypted(env: Env, key: string, value: string | null): Promise<void> {
  if (value === null) await env.STORE.delete(key);
  else await env.STORE.put(key, await encrypt(env, value));
}

export async function readAccounts(env: Env): Promise<Account[]> {
  const json = await readEncrypted(env, "accounts");
  return json ? (JSON.parse(json) as Account[]) : [];
}

export async function writeAccounts(env: Env, accounts: Account[]): Promise<void> {
  await writeEncrypted(env, "accounts", accounts.length ? JSON.stringify(accounts) : null);
}

export async function removeAccount(env: Env, email: string): Promise<Account | undefined> {
  const accounts = await readAccounts(env);
  const removed = accounts.find((a) => a.email === email);
  if (removed) await writeAccounts(env, accounts.filter((a) => a.email !== email));
  return removed;
}

/** Google calendars hidden in Settings: account email → calendar IDs. */
export type HiddenCalendars = Record<string, string[]>;

export async function readHiddenCalendars(env: Env): Promise<HiddenCalendars> {
  const json = await readEncrypted(env, "hiddenCalendars");
  return json ? (JSON.parse(json) as HiddenCalendars) : {};
}

/** Shows or hides one Google calendar. */
export async function setCalendarShown(env: Env, email: string, calendarId: string, shown: boolean): Promise<void> {
  const hidden = await readHiddenCalendars(env);
  const ids = new Set(hidden[email] ?? []);
  if (shown) ids.delete(calendarId);
  else ids.add(calendarId);
  if (ids.size) hidden[email] = [...ids];
  else delete hidden[email];
  await writeEncrypted(env, "hiddenCalendars", Object.keys(hidden).length ? JSON.stringify(hidden) : null);
}

/** History with people in Contacts, oldest first (see src-tauri/src/interactions.rs). */
export async function readInteractions(env: Env): Promise<Interaction[]> {
  const json = await readEncrypted(env, "interactions");
  return json ? (JSON.parse(json) as Interaction[]) : [];
}

export async function writeInteractions(env: Env, entries: Interaction[]): Promise<void> {
  await writeEncrypted(env, "interactions", entries.length ? JSON.stringify(entries) : null);
}

export const readTodoistToken = (env: Env) => readEncrypted(env, "todoist");
export const writeTodoistToken = (env: Env, token: string | null) => writeEncrypted(env, "todoist", token);

/** The default starting address and the Routes caps. Not the API key. */
export interface LeaveSettings {
  leaveFrom: string;
  /** Start from where the browser is, when it says (the address is the fallback). */
  leaveFromHere?: boolean;
  routesDailyLimit: number;
  routesMonthlyLimit: number;
}

export async function readLeaveSettings(env: Env): Promise<LeaveSettings> {
  const json = await readEncrypted(env, "leaveSettings");
  const parsed = json ? (JSON.parse(json) as Partial<LeaveSettings>) : {};
  return {
    leaveFrom: typeof parsed.leaveFrom === "string" ? parsed.leaveFrom : "",
    leaveFromHere: parsed.leaveFromHere === true,
    routesDailyLimit: typeof parsed.routesDailyLimit === "number" ? parsed.routesDailyLimit : 80,
    routesMonthlyLimit: typeof parsed.routesMonthlyLimit === "number" ? parsed.routesMonthlyLimit : 2500,
  };
}

export async function writeLeaveSettings(env: Env, settings: LeaveSettings): Promise<void> {
  await writeEncrypted(env, "leaveSettings", JSON.stringify(settings));
}

/** Routes attempts already made, so a restart doesn't start the count over. */
export async function readRoutesUsage(env: Env, name = "routesUsage"): Promise<Usage | null> {
  const json = await readEncrypted(env, name);
  if (!json) return null;
  const parsed = JSON.parse(json) as { day?: string; dayCount?: number; month?: string; monthCount?: number };
  if (!parsed.day || !parsed.month) return null;
  return {
    day: parsed.day,
    dayCount: parsed.dayCount ?? 0,
    month: parsed.month,
    monthCount: parsed.monthCount ?? 0,
  };
}

export async function writeRoutesUsage(env: Env, usage: Usage, name = "routesUsage"): Promise<void> {
  await writeEncrypted(env, name, JSON.stringify(usage));
}

export interface RouteCacheEntry {
  at: string;
  minutes: number | null;
  /** Google found no drive (minutes is null). */
  noRoute?: boolean;
  /** Where you were, for a drive from where you are. */
  spot?: { latitude: number; longitude: number };
  /** The place a vague leave-from address was matched to. */
  originLabel?: string;
  /** The place a vague destination was matched to. */
  destinationLabel?: string;
}

export type RouteCache = Record<string, RouteCacheEntry>;

export async function readRoutesCache(env: Env): Promise<RouteCache> {
  const json = await readEncrypted(env, "routesCache");
  return json ? (JSON.parse(json) as RouteCache) : {};
}

export async function writeRoutesCache(env: Env, cache: RouteCache): Promise<void> {
  await writeEncrypted(env, "routesCache", JSON.stringify(cache));
}

/** Vague addresses already matched to a point. */
export async function readGeocodeCache(env: Env): Promise<GeoCache> {
  const json = await readEncrypted(env, "geocodeCache");
  if (!json) return {};
  const parsed = JSON.parse(json) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as GeoCache) : {};
}

export async function writeGeocodeCache(env: Env, cache: GeoCache): Promise<void> {
  await writeEncrypted(env, "geocodeCache", JSON.stringify(cache));
}

/** Starts a session; returns the value for the browser's cookie. */
export async function createSession(env: Env): Promise<string> {
  const token = randomToken();
  await env.STORE.put(`session:${await sha256(token)}`, "1", { expirationTtl: SESSION_SECONDS });
  return token;
}

export async function hasSession(env: Env, token: string | null): Promise<boolean> {
  if (!token) return false;
  return (await env.STORE.get(`session:${await sha256(token)}`)) !== null;
}

export async function endSession(env: Env, token: string | null): Promise<void> {
  if (token) await env.STORE.delete(`session:${await sha256(token)}`);
}

export interface PendingSignIn {
  verifier: string;
  /** Adding an account from a signed-in browser (any account may be added). */
  signedIn: boolean;
}

export async function savePendingSignIn(env: Env, state: string, pending: PendingSignIn): Promise<void> {
  await env.STORE.put(`oauth:${state}`, JSON.stringify(pending), { expirationTtl: 600 });
}

export async function takePendingSignIn(env: Env, state: string): Promise<PendingSignIn | null> {
  const key = `oauth:${state}`;
  const json = await env.STORE.get(key);
  if (json === null) return null;
  await env.STORE.delete(key);
  return JSON.parse(json) as PendingSignIn;
}
