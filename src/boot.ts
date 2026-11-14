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
    followKeyboard(this);
  };
  // A dialog taken off the page while open (not closed first) mustn't leave the dimming behind.
  new MutationObserver(() => document.body.classList.contains("dimmed") && update()).observe(document.body, {
    childList: true,
  });
}

/**
 * Phones: how much of the screen's bottom the on-screen keyboard covers, on
 * an open dialog: --keyboard (0 without one), and --above-keyboard (only
 * while it's up), so an edit form can sit just above it, Save and Cancel in
 * view, and a search box at its edge (styles.css).
 */
function followKeyboard(dialog: HTMLDialogElement): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const place = () => {
    const covered = Math.max(0, Math.round(window.innerHeight - (viewport.offsetTop + viewport.height)));
    dialog.style.setProperty("--keyboard", `${covered}px`);
    // A little left over is the browser's bars, not a keyboard.
    if (covered > 80) dialog.style.setProperty("--above-keyboard", `${covered + 8}px`);
    else dialog.style.removeProperty("--above-keyboard");
  };
  place();
  viewport.addEventListener("resize", place);
  viewport.addEventListener("scroll", place);
  dialog.addEventListener(
    "close",
    () => {
      viewport.removeEventListener("resize", place);
      viewport.removeEventListener("scroll", place);
    },
    { once: true },
  );
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
