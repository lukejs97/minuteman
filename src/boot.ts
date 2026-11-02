// What every page (the calendar, the menu bar window, Contacts) does first.
import { isTauri } from "@tauri-apps/api/core";
import { startDemo } from "./demo";

export async function boot(): Promise<void> {
  // Demo mode (Settings): sample data in place of the real thing, anywhere.
  // Otherwise, in a plain browser there's no Rust side: during `npm run dev`,
  // use sample data; on the website (web/), send commands to its server.
  if (await startDemo()) {
    // Sample data is in place.
  } else if (!isTauri()) {
    if (import.meta.env.DEV) (await import("./dev-mock")).install();
    else (await import("./web-bridge")).install();
  }

  // In the app, right-clicking where Minuteman has no menu of its own shows
  // nothing, rather than the web view's (Reload, Inspect…). Text fields and
  // selected text keep theirs, for copy and paste.
  if (isTauri()) {
    document.addEventListener("contextmenu", (e) => {
      const target = e.target as Element;
      if (target.closest("input, textarea, [contenteditable]") || getSelection()?.toString()) return;
      e.preventDefault();
    });
  }
}
