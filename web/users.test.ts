// users.ts: who signs in as whom, and each person's things kept apart.
// Run: node --experimental-strip-types --test users.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "./src/env.ts";
import { sha256 } from "./src/crypto.ts";
import { readAccounts, writeAccounts, createSession, sessionUser, readTodoistToken, writeTodoistToken } from "./src/store.ts";
import { claimAccount, everyone, forUser, invite, OWNER, peopleList, personSigningIn, removePerson, whoseAccount } from "./src/users.ts";

/** A KV namespace in memory, with list and metadata (enough for users.ts). */
function memoryKV(): KVNamespace & { data: Map<string, { value: string; metadata?: unknown }> } {
  const data = new Map<string, { value: string; metadata?: unknown }>();
  return {
    data,
    async get(key: string) {
      return data.get(key)?.value ?? null;
    },
    async put(key: string, value: string, options?: { metadata?: unknown }) {
      data.set(key, { value, metadata: options?.metadata });
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const keys = [...data.keys()]
        .filter((k) => k.startsWith(options?.prefix ?? ""))
        .sort()
        .map((name) => ({ name, metadata: data.get(name)?.metadata }));
      return { keys, list_complete: true, cursor: "" };
    },
  } as unknown as KVNamespace & { data: Map<string, { value: string; metadata?: unknown }> };
}

function siteEnv(): Env & { STORE: ReturnType<typeof memoryKV> } {
  return {
    STORE: memoryKV(),
    TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_EMAILS: "paul.revere@example.com",
  } as unknown as Env & { STORE: ReturnType<typeof memoryKV> };
}

const account = (email: string) => ({ email, refreshToken: `token-${email}`, canEditEvents: true });

test("the owner signs in as the owner, with their things where they were", async () => {
  const env = siteEnv();
  await writeAccounts(env, [account("paul.revere@example.com")]);
  assert.equal(await personSigningIn(env, "Paul.Revere@example.com", null), OWNER);
  // The owner's part of the store is the store as it was: no prefix.
  assert.deepEqual((await readAccounts(forUser(env, OWNER))).map((a) => a.email), ["paul.revere@example.com"]);
  assert.ok(env.STORE.data.has("accounts"));
});

test("someone not invited can't sign in; invited, they join with their own part", async () => {
  const env = siteEnv();
  await assert.rejects(personSigningIn(env, "rachel.revere@example.com", null), /isn't invited/);

  await invite(env, "Rachel.Revere@example.com");
  const rachel = await personSigningIn(env, "rachel.revere@example.com", null);
  assert.notEqual(rachel, OWNER);
  const hers = forUser(env, rachel);
  await writeAccounts(hers, [account("rachel.revere@example.com")]);
  await claimAccount(env, "rachel.revere@example.com", rachel);
  await writeTodoistToken(hers, "her-todoist");

  // Kept apart: the owner sees none of it, and her keys are under her prefix.
  assert.deepEqual(await readAccounts(forUser(env, OWNER)), []);
  assert.equal(await readTodoistToken(forUser(env, OWNER)), null);
  assert.equal(await readTodoistToken(hers), "her-todoist");
  assert.ok([...env.STORE.data.keys()].some((k) => k === `u:${rachel}:accounts`));

  // The invite is used up; signing in again finds her.
  assert.deepEqual((await peopleList(env)).invites, []);
  assert.equal(await personSigningIn(env, "rachel.revere@example.com", null), rachel);
  assert.deepEqual(await everyone(env), [OWNER, rachel]);
});

test("an account can't be added by someone else once it's someone's", async () => {
  const env = siteEnv();
  await writeAccounts(env, [account("paul.revere@example.com"), account("north.church@example.com")]);
  await invite(env, "rachel.revere@example.com");
  const rachel = await personSigningIn(env, "rachel.revere@example.com", null);
  await assert.rejects(personSigningIn(env, "north.church@example.com", rachel), /already used by someone else/);
  // One of no one's: fine, and hers from then on.
  assert.equal(await personSigningIn(env, "joshua.revere@example.com", rachel), rachel);
  await writeAccounts(forUser(env, rachel), [account("rachel.revere@example.com"), account("joshua.revere@example.com")]);
  await claimAccount(env, "joshua.revere@example.com", rachel);
  assert.equal(await whoseAccount(env, "joshua.revere@example.com"), rachel);
  await assert.rejects(personSigningIn(env, "joshua.revere@example.com", OWNER), /already used/);
  // Someone invited isn't added to the owner's by mistake, from a signed-in browser.
  await invite(env, "mercy.warren@example.com");
  await assert.rejects(personSigningIn(env, "mercy.warren@example.com", OWNER), /invited to a Minuteman of its own/);
  assert.notEqual(await personSigningIn(env, "mercy.warren@example.com", null), OWNER);
});

test("sessions say whose they are; old ones are the owner's", async () => {
  const env = siteEnv();
  const token = await createSession(env, "abc123");
  assert.equal(await sessionUser(env, token), "abc123");
  // A session from before there were other people: its value was "1".
  env.STORE.data.set(`session:${await sha256("old-cookie")}`, { value: "1" });
  assert.equal(await sessionUser(env, "old-cookie"), OWNER);
  // Seen from inside someone's part, sessions are still the site's.
  assert.equal(await sessionUser(forUser(env, "abc123"), token), "abc123");
  assert.equal(await sessionUser(env, null), null);
});

test("removing someone forgets all theirs, and theirs alone", async () => {
  const env = siteEnv();
  await writeAccounts(env, [account("paul.revere@example.com")]);
  await writeTodoistToken(env, "his-todoist");
  await invite(env, "rachel.revere@example.com");
  const rachel = await personSigningIn(env, "rachel.revere@example.com", null);
  const hers = forUser(env, rachel);
  await writeAccounts(hers, [account("rachel.revere@example.com")]);
  await claimAccount(env, "rachel.revere@example.com", rachel);
  await writeTodoistToken(hers, "her-todoist");
  const herSession = await createSession(env, rachel);
  const hisSession = await createSession(env, OWNER);

  const revoked: string[] = [];
  await removePerson(env, rachel, async (t) => void revoked.push(t));
  assert.deepEqual(revoked, ["token-rachel.revere@example.com"]);
  assert.equal([...env.STORE.data.keys()].filter((k) => k.startsWith(`u:${rachel}:`)).length, 0);
  assert.equal(await sessionUser(env, herSession), null);
  assert.equal(await sessionUser(env, hisSession), OWNER);
  assert.equal(await readTodoistToken(env), "his-todoist");
  assert.deepEqual(await everyone(env), [OWNER]);
  assert.equal(await whoseAccount(env, "rachel.revere@example.com"), null);
  await assert.rejects(removePerson(env, OWNER, async () => undefined), /can't be removed/);
});
