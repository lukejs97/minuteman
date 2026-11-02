// Minuteman's web server (a Cloudflare Worker).
//
//   /auth/google/start      → Google's sign-in page (to sign in, or add an account)
//   /auth/google/callback   ← Google sends the browser back here
//   /auth/signout   (POST)  ends this browser's session
//   /api/<command>  (POST)  the app's commands (see commands.ts)
//   anything else           the website's files
//
// Browsers only ever get an HttpOnly session cookie, which page scripts can't
// read. Google and Todoist tokens stay here, encrypted in KV.
import { commands } from "./commands";
import { pkceChallenge, randomToken } from "./crypto";
import type { Context, Env } from "./env";
import { AppError, notSignedIn } from "./errors";
import { authorizeUrl, finishSignIn } from "./google";
import {
  createSession,
  endSession,
  hasSession,
  readAccounts,
  SESSION_SECONDS,
  savePendingSignIn,
  takePendingSignIn,
} from "./store";
import { validZone } from "./zone";

const COOKIE = "__Host-minuteman";

/** Only the app's own files; no outside scripts; links don't reveal the page. */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    // Contacts' photos come straight from Google.
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com; " +
    // The weather (src/weather.ts) comes straight from Open-Meteo.
    "connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com https://photon.komoot.io; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
};

function withHeaders(response: Response, extra: Record<string, string> = {}): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(name, value);
  return out;
}

function sessionCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

const setCookie = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

function json(body: unknown, status = 200): Response {
  return withHeaders(
    new Response(JSON.stringify(body ?? null), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
  );
}

function errorResponse(e: unknown): Response {
  if (e instanceof AppError) return json(e.toJSON(), e.status);
  console.error(e);
  return json({ kind: "io", message: "Something went wrong on the server." }, 500);
}

/** A small page for sign-in problems (the browser left the app to sign in). */
function messagePage(title: string, message: string, status: number): Response {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>Minuteman</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem 1rem">` +
    `<h2>${escape(title)}</h2><p>${escape(message)}</p><p><a href="/">Back to Minuteman</a></p>`;
  return withHeaders(new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } }));
}

/**
 * Requests that change things must come from this site's own pages: the
 * custom header can't be sent cross-site without permission, which this
 * server never grants, and the Origin (when sent) must be ours.
 */
function fromThisSite(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  return request.headers.get("X-Minuteman") === "1" && (origin === null || origin === url.origin);
}

async function startSignIn(request: Request, env: Env, url: URL): Promise<Response> {
  const state = randomToken(16);
  const verifier = randomToken(32);
  const signedIn = await hasSession(env, sessionCookie(request));
  await savePendingSignIn(env, state, { verifier, signedIn });
  const target = authorizeUrl(env, `${url.origin}/auth/google/callback`, state, await pkceChallenge(verifier));
  return withHeaders(Response.redirect(target, 302));
}

async function finishGoogleSignIn(request: Request, env: Env, url: URL): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) return messagePage("Sign-in didn't complete", `Google returned "${error}".`, 400);
  const pending = await takePendingSignIn(env, url.searchParams.get("state") ?? "");
  const code = url.searchParams.get("code");
  if (!pending || !code) return messagePage("Sign-in didn't complete", "That sign-in link expired. Try again.", 400);

  try {
    await finishSignIn(env, code, pending.verifier, `${url.origin}/auth/google/callback`, pending.signedIn);
  } catch (e) {
    return messagePage("Sign-in didn't complete", e instanceof Error ? e.message : String(e), 403);
  }

  const headers: Record<string, string> = { Location: "/" };
  if (!(await hasSession(env, sessionCookie(request)))) {
    headers["Set-Cookie"] = setCookie(await createSession(env), SESSION_SECONDS);
  }
  return withHeaders(new Response(null, { status: 302, headers }));
}

async function runCommand(request: Request, env: Env, name: string): Promise<Response> {
  const signedIn = await hasSession(env, sessionCookie(request));
  // Asked before signing in: answer without needing a session.
  if (name === "auth_status") return json(signedIn && (await readAccounts(env)).length > 0);
  if (!signedIn) throw notSignedIn();

  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) return json({ kind: "input", message: `Invalid request: unknown command ${name}` }, 404);
  const args = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const ctx: Context = { env, zone: validZone(request.headers.get("X-Time-Zone")) };
  return json(await command(ctx, args ?? {}));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/auth/google/start" && request.method === "GET") return await startSignIn(request, env, url);
      if (url.pathname === "/auth/google/callback" && request.method === "GET") {
        return await finishGoogleSignIn(request, env, url);
      }
      if (url.pathname === "/auth/signout" && request.method === "POST") {
        if (!fromThisSite(request, url)) return json({ kind: "auth", message: "Not allowed" }, 403);
        await endSession(env, sessionCookie(request));
        return withHeaders(new Response(null, { status: 204 }), { "Set-Cookie": setCookie("", 0) });
      }
      if (url.pathname.startsWith("/api/")) {
        if (request.method !== "POST" || !fromThisSite(request, url)) {
          return json({ kind: "auth", message: "Not allowed" }, 403);
        }
        return await runCommand(request, env, url.pathname.slice("/api/".length));
      }
    } catch (e) {
      return errorResponse(e);
    }
    return withHeaders(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
