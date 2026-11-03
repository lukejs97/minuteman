// Web Push: alerts on a phone (the Home Screen app, iOS 16.4 or later) or
// any browser, even when Minuteman isn't open. The browser gives the site a
// subscription (an address at Apple's, Google's or Mozilla's push service,
// and two keys); the server sends each alert there, encrypted so only that
// browser can read it (RFC 8291), and signed so the push service knows it's
// from this site (VAPID, RFC 8292). The site's signing key is made here the
// first time it's needed and kept, encrypted, with the other secrets: there
// is nothing to set up. Everything is WebCrypto; no library, no cost.
import { decrypt, encrypt } from "./crypto";
import type { Env } from "./env";

/** A browser that turned alerts on, and where its alerts go. */
export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The browser's time zone, for the times in its alerts. */
  zone: string;
  /** This site's address, for the signature's contact ("sub"). */
  site: string;
}

/** What one alert shows. */
export interface PushMessage {
  title: string;
  body: string;
  /** Alerts with the same tag replace each other (one per event and time). */
  tag: string;
}

const SUBSCRIPTIONS = "pushSubscriptions";
const KEY = "pushKey";

// ---------- Stored ----------

export async function readSubscriptions(env: Env): Promise<PushSubscription[]> {
  const value = await env.STORE.get(SUBSCRIPTIONS);
  return value ? (JSON.parse(await decrypt(env, value)) as PushSubscription[]) : [];
}

async function writeSubscriptions(env: Env, subs: PushSubscription[]): Promise<void> {
  if (subs.length === 0) await env.STORE.delete(SUBSCRIPTIONS);
  else await env.STORE.put(SUBSCRIPTIONS, await encrypt(env, JSON.stringify(subs)));
}

/** Adds (or refreshes) a browser's subscription. */
export async function subscribe(env: Env, sub: PushSubscription): Promise<void> {
  const subs = (await readSubscriptions(env)).filter((s) => s.endpoint !== sub.endpoint);
  // A handful of devices at most; the oldest go first.
  await writeSubscriptions(env, [...subs, sub].slice(-10));
}

export async function unsubscribe(env: Env, endpoint: string): Promise<void> {
  const subs = await readSubscriptions(env);
  const kept = subs.filter((s) => s.endpoint !== endpoint);
  if (kept.length !== subs.length) await writeSubscriptions(env, kept);
}

/** The site's signing key pair: made the first time, then kept (encrypted). */
async function signingKey(env: Env): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const stored = await env.STORE.get(KEY);
  let jwk: JsonWebKey;
  if (stored) jwk = JSON.parse(await decrypt(env, stored)) as JsonWebKey;
  else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    await env.STORE.put(KEY, await encrypt(env, JSON.stringify(jwk)));
  }
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // The public half, as browsers want it: an uncompressed point (0x04, x, y).
  const publicKey = b64url(concat(new Uint8Array([4]), fromB64url(jwk.x!), fromB64url(jwk.y!)));
  return { privateKey, publicKey };
}

/** The public key a browser subscribes with (`applicationServerKey`). */
export async function publicKey(env: Env): Promise<string> {
  return (await signingKey(env)).publicKey;
}

// ---------- Sending ----------

/**
 * Sends `message` to every subscribed browser. Ones the push service says
 * are gone (unsubscribed, app removed) are forgotten.
 */
export async function sendToAll(env: Env, message: PushMessage | ((sub: PushSubscription) => PushMessage)): Promise<void> {
  const subs = await readSubscriptions(env);
  if (subs.length === 0) return;
  const key = await signingKey(env);
  const results = await Promise.allSettled(
    subs.map((sub) => send(key, sub, typeof message === "function" ? message(sub) : message)),
  );
  const gone = subs.filter((_, i) => {
    const r = results[i];
    return r.status === "fulfilled" && (r.value === 404 || r.value === 410);
  });
  for (const sub of gone) await unsubscribe(env, sub.endpoint);
}

/** One push; resolves to the push service's status (201 is sent). */
async function send(key: { privateKey: CryptoKey; publicKey: string }, sub: PushSubscription, message: PushMessage): Promise<number> {
  const endpoint = new URL(sub.endpoint);
  const jwt = await vapidToken(key.privateKey, endpoint.origin, sub.site);
  const body = await encryptPayload(new TextEncoder().encode(JSON.stringify(message)), sub.keys.p256dh, sub.keys.auth);
  const response = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${key.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      // An alert is no use late: dropped after 10 minutes undelivered.
      TTL: "600",
      Urgency: "high",
    },
    body,
  });
  return response.status;
}

/** A signed token saying this site sent it (VAPID, ES256), good for 12 hours. */
async function vapidToken(privateKey: CryptoKey, audience: string, site: string): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: site };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

/**
 * Encrypts a push for one browser (RFC 8291, "aes128gcm"): a key agreed with
 * its public key and auth secret, a fresh key pair and salt each time.
 */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const ua = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  // `public`, the standard name (Cloudflare's type file calls it `$public`).
  const ecdh = { name: "ECDH", public: ua } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));

  const text = (s: string) => new TextEncoder().encode(s);
  const ikm = await hkdf(authSecret, shared, concat(text("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 12);

  // One record: the message, then 0x02 (the last record's delimiter).
  const record = concat(plaintext, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));

  // Header: salt, record size (4096), key id length, and our public key.
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// ---------- Bytes ----------

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
