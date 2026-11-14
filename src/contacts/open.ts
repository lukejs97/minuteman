// Opens Contacts from anywhere in Minuteman (the toolbar, an event's guests),
// and the calendar from Contacts: in the desktop app their own windows; on a
// phone or the website, their pages.
//
// Added to a phone's Home Screen, the calendar and Contacts are apps of
// their own (manifest.webmanifest, contacts.webmanifest), and a web app
// can't open another. So there, each leaves out its switch to the other
// (`separateApps`). A guest's name or a birthday still opens the other page
// in the same app, marked `?from=`, and that page then shows the way back.
import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { showContacts, showMain } from "../api";
import { toDateString } from "../time";

/** Tells the calendar's window to show a day (see `GO_TO_DAY` in main.ts). */
export const GO_TO_DAY = "calendar-go-to-day";

const isPhone = () => /iPhone|iPad|Android/.test(navigator.userAgent);

/** Running as a Home Screen (installed) web app, not in a browser tab. */
export function inHomeScreenApp(): boolean {
  if (isTauri()) return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone || window.matchMedia("(display-mode: standalone)").matches;
}

/** Which page this one was opened from, in the same Home Screen app ("calendar" or "contacts"). */
const openedFrom = () => new URLSearchParams(location.search).get("from");

/**
 * Whether this page should leave out its switch to the other one: in a Home
 * Screen app of its own, unless it was opened from the other page there (a
 * guest's name, a birthday), when the switch is the way back.
 */
export function separateApps(page: "calendar" | "contacts"): boolean {
  return inHomeScreenApp() && openedFrom() !== (page === "calendar" ? "contacts" : "calendar");
}

/** Shows Contacts, with `query` (a name or email address) in its box if given. */
export function openContacts(query: string | null = null): void {
  if (isTauri() && !isPhone()) {
    void showContacts(query);
    return;
  }
  const url = new URL("contacts.html", location.href);
  const params = new URLSearchParams(query ? { q: query } : {});
  // In the calendar's Home Screen app: Contacts with a way back (not when
  // going back to the Contacts app this calendar page was opened from).
  if (inHomeScreenApp() && openedFrom() !== "contacts") params.set("from", "calendar");
  url.search = params.toString();
  location.assign(url.toString());
}

/** Shows the calendar, on `day` (in Day view) if given, e.g. someone's birthday. */
export function openCalendar(day: Date | null = null): void {
  if (isTauri() && !isPhone()) {
    void showMain().then(() => day && emit(GO_TO_DAY, toDateString(day)));
    return;
  }
  const url = new URL("./", location.href);
  const params = new URLSearchParams(day ? { date: toDateString(day) } : {});
  if (inHomeScreenApp() && openedFrom() !== "calendar") params.set("from", "contacts");
  url.search = params.toString();
  location.assign(url.toString());
}
