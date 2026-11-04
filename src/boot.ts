// What every page (the calendar, the menu bar window, Contacts) does first.
import { isTauri } from "@tauri-apps/api/core";
import { startDemo } from "./demo";

/**
 * The page is dimmed behind any open dialog by one layer of its own
 * (body.dimmed::after), not by each dialog: a dialog's ::backdrop or shadow
 * is repainted as its contents change size (calendars loading into New
 * event), and the Mac's web view flickered doing it. The layer stays while
 * one dialog replaces another, so it never blinks in between.
 */
function dimBehindDialogs(): void {
  const update = () => document.body.classList.toggle("dimmed", !!document.querySelector("dialog[open]"));
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    showModal.call(this);
    this.addEventListener("close", () => queueMicrotask(update), { once: true });
    update();
  };
  // A dialog taken off the page while open (not closed first) mustn't leave the dimming behind.
  new MutationObserver(() => document.body.classList.contains("dimmed") && update()).observe(document.body, {
    childList: true,
  });
}

export async function boot(): Promise<void> {
  dimBehindDialogs();
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
