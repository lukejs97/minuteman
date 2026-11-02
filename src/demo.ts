// Demo mode: the whole app with made-up events, tasks and people (the same
// sample data as `npm run dev`, from dev-mock.ts), for screenshots, screen
// recordings and copied text that show nothing real. Settings → Demo mode
// turns it on and off; on the website, adding ?demo to the address does too.
//
// Nothing is sent to Google, Todoist or the server while it's on, and
// anything changed (an event added, a setting) is made up as well. Settings
// kept on this device (the weather's place, the view) are kept apart from
// your real ones, so the demo neither shows nor changes them.
//
// The website remembers it for that tab only (open ?demo in another tab and
// keep your real calendar in this one). The desktop app remembers it for
// all its windows (calendar, Contacts, the menu bar window) and reloads
// them all when it's turned on or off.
import { isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

const FLAG = "minuteman.demo";
/** Tells the desktop app's other windows to reload, after a switch. */
const DEMO_CHANGED = "minuteman-demo-changed";
/** Settings stored on this device in Demo mode start with this. */
const PREFIX = "demo:";

/** This device's real storage, kept before Demo mode swaps in its own. */
const realStorage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

/** Where the switch is kept: every window (desktop app) or this tab (website). */
function flagStore(): Storage | null {
  try {
    return isTauri() ? realStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

let on: boolean | null = null;

/** Whether Demo mode is on in this window. */
export function isDemo(): boolean {
  if (on === null) {
    const asked = new URLSearchParams(location.search).has("demo");
    if (asked) flagStore()?.setItem(FLAG, "1");
    on = asked || flagStore()?.getItem(FLAG) === "1";
  }
  return on;
}

/** Turns Demo mode on or off, and starts again (every window, in the desktop app). */
export async function setDemo(next: boolean): Promise<void> {
  try {
    if (next) flagStore()?.setItem(FLAG, "1");
    else flagStore()?.removeItem(FLAG);
  } catch {
    // Storage blocked: only ?demo works, so go by the address.
  }
  if (isTauri()) await emit(DEMO_CHANGED).catch(() => {});
  const url = new URL(location.href);
  url.searchParams.delete("demo");
  if (next && !flagStore()) url.searchParams.set("demo", "");
  location.replace(url.toString());
}

/**
 * Starts Demo mode in this window if it's on: sample data in place of the
 * real thing, and a separate set of settings on this device. Run before
 * anything reads storage or asks the app for data.
 */
export async function startDemo(): Promise<boolean> {
  if (isTauri()) void listen(DEMO_CHANGED, () => location.reload()).catch(() => {});
  if (!isDemo()) return false;
  if (realStorage) {
    try {
      Object.defineProperty(window, "localStorage", { value: prefixed(realStorage), configurable: true });
    } catch {
      // Then the demo shares this device's settings.
    }
  }
  seedWeather();
  (await import("./dev-mock")).install(isTauri());
  document.documentElement.classList.add("demo");
  return true;
}

/** `storage`, with every key starting with "demo:", so the demo's settings stay apart. */
function prefixed(storage: Storage): Storage {
  const keys = () => {
    const found: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(PREFIX)) found.push(key.slice(PREFIX.length));
    }
    return found;
  };
  return {
    get length() {
      return keys().length;
    },
    key: (index: number) => keys()[index] ?? null,
    getItem: (key: string) => storage.getItem(PREFIX + key),
    setItem: (key: string, value: string) => storage.setItem(PREFIX + key, value),
    removeItem: (key: string) => storage.removeItem(PREFIX + key),
    clear: () => keys().forEach((key) => storage.removeItem(PREFIX + key)),
  };
}

/** The demo's weather: Lexington, Massachusetts, until a place is chosen in it. */
function seedWeather(): void {
  try {
    if (localStorage.getItem("calendar.weather") !== null) return;
    localStorage.setItem(
      "calendar.weather",
      JSON.stringify({
        place: { name: "Lexington", detail: "Massachusetts, United States", latitude: 42.45, longitude: -71.23 },
        unit: "fahrenheit",
      }),
    );
  } catch {
    // No weather in the demo, then.
  }
}
