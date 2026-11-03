// The website version (see web/): there's no Rust side in a browser, so the
// app's commands go to Minuteman's web server instead, at /api/<command>,
// with the same names and arguments. The screens don't know the difference.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { AppError } from "./api";

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function send(command: string, args: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/${command}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        // Proves the request comes from this site's own pages (see web/src/index.ts).
        "X-Minuteman": "1",
        // "Today" and midnights are worked out in your time zone, not the server's.
        "X-Time-Zone": zone,
      },
      body: JSON.stringify(args ?? {}),
    });
  } catch {
    throw { kind: "network", message: "Can't reach Minuteman. Check your internet connection." } satisfies AppError;
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw body ?? ({ kind: "api", message: `Server error ${response.status}` } satisfies AppError);
  return body;
}

/** Ends this browser's session (other devices stay signed in), then reloads. */
export async function signOutHere(): Promise<void> {
  await fetch("/auth/signout", { method: "POST", credentials: "same-origin", headers: { "X-Minuteman": "1" } });
  location.reload();
}

/**
 * Opens a link from the website. Web pages open in a new tab. Links to an
 * app (maps:, tel:, sms:, mailto:, facetime:) go straight to it: a new
 * window for one is a blank page (on an iPhone, a browser sheet) that stays
 * behind after the app opens.
 */
export function openLink(url: string): void {
  if (/^https?:/i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
  else location.href = url;
}

export function install(): void {
  mockIPC((command, args) => {
    switch (command) {
      // Signing in leaves the page for Google's, and comes back signed in.
      case "sign_in":
        location.assign("/auth/google/start");
        return new Promise(() => {});
      case "plugin:opener|open_url":
        openLink((args as { url: string }).url);
        return null;
      default:
        // Other desktop plugins (windows, events) have nothing to do here.
        if (command.startsWith("plugin:")) return null;
        return send(command, args);
    }
  });
}
