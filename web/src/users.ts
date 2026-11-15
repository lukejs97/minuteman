// Who uses this site, and keeping each person's things apart.
//
// The site's owner (ALLOWED_EMAILS) can invite other people by email, in
// Settings → People. Each person has their own Google accounts, Todoist,
// preferences, history with contacts, alerts and caps: everything the rest
// of the server keeps is in that person's own part of the store, as the
// rest of the code reads and writes it through `env.STORE` (see `forUser`).
//
// The owner's part is the store as it was before there were other people
// (keys with no prefix: "accounts", "todoist"…), so nothing of theirs moved.
// Everyone else's keys start "u:<id>:". The site's own keys start "site:",
// and sessions and sign-ins in progress are "session:…" and "oauth:…".
//
//   site:users              encrypted list of the people invited who joined
//   site:invites            encrypted list of emails invited, not yet joined
//   site:account:<hash>     which person a Google account belongs to (not the owner's)
//   site:routesUsage        Routes attempts by everyone together (routes.ts)
//   site:placesUsage        TomTom searches by everyone together (places.ts)
import { decrypt, encrypt, randomToken, sha256 } from "./crypto";
import type { Env } from "./env";
import { AppError, invalidInput } from "./errors";
import type { Account } from "./store";

/** The site's owner: their things are where they always were. */
export const OWNER = "owner";

/** Someone the owner invited, once they've signed in. */
export interface Person {
  id: string;
  /** The Google account they joined with (invited). */
  email: string;
  /** When they joined (ISO). */
  joined: string;
}

const USERS = "site:users";
const INVITES = "site:invites";
const accountKey = async (email: string) => `site:account:${await sha256(email.trim().toLowerCase())}`;
const prefixFor = (id: string) => (id === OWNER ? "" : `u:${id}:`);

/** The whole store, whoever's request this is. */
export const siteStore = (env: Env): KVNamespace => env.SITE ?? env.STORE;

/** Whose request this is: the owner unless said otherwise. */
export const userOf = (env: Env): string => env.USER ?? OWNER;
export const isOwner = (env: Env): boolean => userOf(env) === OWNER;

/** `store`, seen through `prefix`: get, put, delete and list only see keys starting with it. */
function prefixed(store: KVNamespace, prefix: string): KVNamespace {
  if (!prefix) return store;
  const wrapped = {
    get: (key: string, options?: unknown) => store.get(prefix + key, options as never),
    getWithMetadata: (key: string, options?: unknown) => store.getWithMetadata(prefix + key, options as never),
    put: (key: string, value: never, options?: KVNamespacePutOptions) => store.put(prefix + key, value, options),
    delete: (key: string) => store.delete(prefix + key),
    list: async (options?: KVNamespaceListOptions) => {
      const listed = await store.list({ ...options, prefix: prefix + (options?.prefix ?? "") });
      return { ...listed, keys: listed.keys.map((k) => ({ ...k, name: k.name.slice(prefix.length) })) };
    },
  };
  return wrapped as unknown as KVNamespace;
}

/** `env` for `id`'s requests: the store is theirs alone (the site's whole store stays at `SITE`). */
export function forUser(env: Env, id: string): Env {
  const site = siteStore(env);
  return { ...env, SITE: site, USER: id, STORE: prefixed(site, prefixFor(id)) };
}

async function readList<T>(env: Env, key: string): Promise<T[]> {
  const value = await siteStore(env).get(key);
  return value === null ? [] : (JSON.parse(await decrypt(env, value)) as T[]);
}

async function writeList<T>(env: Env, key: string, list: T[]): Promise<void> {
  if (list.length === 0) await siteStore(env).delete(key);
  else await siteStore(env).put(key, await encrypt(env, JSON.stringify(list)));
}

export const readPeople = (env: Env) => readList<Person>(env, USERS);
export const readInvites = (env: Env) => readList<string>(env, INVITES);

/** Everyone whose alerts the cron sends: the owner, then each person. */
export async function everyone(env: Env): Promise<string[]> {
  return [OWNER, ...(await readPeople(env)).map((p) => p.id)];
}

const lower = (email: string) => email.trim().toLowerCase();
const ownerEmails = (env: Env) => env.ALLOWED_EMAILS.split(",").map(lower).filter(Boolean);

/** `id`'s Google accounts (read without needing their requests' env). */
async function accountsOf(env: Env, id: string): Promise<Account[]> {
  const value = await prefixed(siteStore(env), prefixFor(id)).get("accounts");
  return value === null ? [] : (JSON.parse(await decrypt(env, value)) as Account[]);
}

/**
 * Who the Google account `email` belongs to on this site, if anyone: the
 * owner (it's one of theirs, or theirs to sign in with), or a person (one
 * of their accounts, or the one they joined with).
 */
export async function whoseAccount(env: Env, email: string): Promise<string | null> {
  const address = lower(email);
  if (ownerEmails(env).includes(address)) return OWNER;
  if ((await accountsOf(env, OWNER)).some((a) => lower(a.email) === address)) return OWNER;
  const site = siteStore(env);
  const key = await accountKey(address);
  const indexed = await site.get(key);
  if (indexed && (await accountsOf(env, indexed)).some((a) => lower(a.email) === address)) return indexed;
  // Removed from them since (or never added): not theirs any more.
  if (indexed) await site.delete(key);
  const joined = (await readPeople(env)).find((p) => lower(p.email) === address);
  return joined?.id ?? null;
}

/** Notes that `email` is `id`'s now (or no one's, with null). The owner's need no note. */
export async function claimAccount(env: Env, email: string, id: string | null): Promise<void> {
  const key = await accountKey(email);
  if (id === null || id === OWNER) await siteStore(env).delete(key);
  else await siteStore(env).put(key, id);
}

/**
 * Who signs in with the Google account `email` (just approved at Google):
 * the person it belongs to, or someone invited joining now. With `adding`,
 * someone signed in is adding it to theirs: fine unless it's someone else's.
 */
export async function personSigningIn(env: Env, email: string, adding: string | null): Promise<string> {
  const owner = await whoseAccount(env, email);
  const invites = await readInvites(env);
  if (adding !== null) {
    if (owner !== null && owner !== adding) {
      throw new AppError("auth", `${email} is already used by someone else on this site, so it can't be added here.`, 403);
    }
    // Invited to a Minuteman of their own: not to be added to someone else's.
    if (owner === null && invites.includes(lower(email))) {
      throw new AppError("auth", `${email} is invited to a Minuteman of its own here. Sign out first, then sign in with it.`, 403);
    }
    return adding;
  }
  if (owner !== null) return owner;

  if (!invites.includes(lower(email))) {
    throw new AppError("auth", `${email} isn't invited to this site. Ask whoever runs it to invite you.`, 403);
  }
  const person: Person = { id: randomToken(12).replace(/[^A-Za-z0-9]/g, "").slice(0, 16), email: lower(email), joined: new Date().toISOString() };
  await writeList(env, USERS, [...(await readPeople(env)), person]);
  await writeList(env, INVITES, invites.filter((e) => e !== lower(email)));
  return person.id;
}

// ---------- The owner's Settings → People ----------

export async function invite(env: Env, email: string): Promise<void> {
  const address = lower(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw invalidInput("That doesn't look like an email address");
  if ((await whoseAccount(env, address)) !== null) throw invalidInput(`${address} can already sign in here`);
  const invites = await readInvites(env);
  if (!invites.includes(address)) await writeList(env, INVITES, [...invites, address]);
}

export async function uninvite(env: Env, email: string): Promise<void> {
  const invites = await readInvites(env);
  await writeList(env, INVITES, invites.filter((e) => e !== lower(email)));
}

/**
 * Forgets `id` and everything of theirs: their part of the store, the notes
 * of which accounts are theirs, and their sessions. Their Google accounts'
 * access is given back to Google (`revoke`). Not the owner.
 */
export async function removePerson(env: Env, id: string, revoke: (token: string) => Promise<void>): Promise<void> {
  if (id === OWNER) throw invalidInput("The site's owner can't be removed");
  const site = siteStore(env);
  for (const account of await accountsOf(env, id)) {
    await revoke(account.refreshToken);
    await claimAccount(env, account.email, null);
  }
  await deleteAll(site, prefixFor(id));
  // Their sessions: each says whose it is (store.ts `createSession`).
  let cursor: string | undefined;
  do {
    const page = await site.list<{ user?: string }>({ prefix: "session:", cursor });
    for (const key of page.keys) {
      // Each says whose in its metadata; one without, in its value.
      const whose = key.metadata?.user ?? (await site.get(key.name));
      if (whose === id) await site.delete(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await writeList(env, USERS, (await readPeople(env)).filter((p) => p.id !== id));
}

async function deleteAll(store: KVNamespace, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix, cursor });
    for (const key of page.keys) await store.delete(key.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

/** The owner's view of who's here: people who joined (with their accounts) and invites waiting. */
export async function peopleList(env: Env): Promise<{ people: (Person & { accounts: string[] })[]; invites: string[] }> {
  const people = await readPeople(env);
  return {
    people: await Promise.all(people.map(async (p) => ({ ...p, accounts: (await accountsOf(env, p.id)).map((a) => a.email) }))),
    invites: await readInvites(env),
  };
}
