// "Undo", as Google Calendar offers it: a bar at the bottom for a few seconds
// after deleting, moving or completing something, and ⌘Z / Ctrl+Z while it's
// there.
//
// A delete isn't sent until the bar goes away (or the window is closed or
// put away, when it's sent at once): until then the item is only hidden, so
// Undo just shows it again. A move or a completed task is saved straight
// away, and Undo puts it back.
import type { AgendaItem } from "./api";
import { el } from "./dom";

const SHOWN_MS = 7000;

interface Offer {
  node: HTMLElement;
  timer: number;
  undo: () => unknown;
  /** Sends what's waiting (a delete); runs when the bar goes away, not after Undo. */
  commit?: () => Promise<unknown>;
}

let current: Offer | null = null;

/** Items hidden while their delete waits to be sent. */
const hidden: ((item: AgendaItem) => boolean)[] = [];
const listeners = new Set<() => void>();

/** Whether `item` is waiting to be deleted (so it's left out of what's shown). */
export const isHidden = (item: AgendaItem) => hidden.some((matches) => matches(item));

/** Runs `redraw` when an item is hidden or shown again. */
export function onHiddenChange(redraw: () => void): void {
  listeners.add(redraw);
}

const hiddenChanged = () => listeners.forEach((redraw) => redraw());

/**
 * Shows "`message` · Undo". `undo` runs if it's pressed; `commit`, if given,
 * runs once the bar goes away without it.
 */
export function offerUndo(message: string, undo: () => unknown, commit?: () => Promise<unknown>): void {
  finish(); // an earlier one is done with: send what it held
  const node = el("div", "undo-bar");
  node.setAttribute("role", "status");
  const button = el("button", "undo-button", "Undo");
  button.type = "button";
  node.append(el("span", "undo-message", message), button);
  document.body.append(node);
  const offer: Offer = { node, undo, commit, timer: window.setTimeout(() => finish(), SHOWN_MS) };
  button.addEventListener("click", () => {
    if (current !== offer) return;
    window.clearTimeout(offer.timer);
    current = null;
    node.remove();
    void offer.undo();
  });
  current = offer;
}

/** Takes the bar away and sends what it was holding back. */
function finish(): void {
  const offer = current;
  if (!offer) return;
  current = null;
  window.clearTimeout(offer.timer);
  offer.node.remove();
  void offer.commit?.();
}

/**
 * Hides what `matches` (an item, or the events of a series) and offers Undo;
 * `send` deletes it for real once the bar goes away, then `done` runs (to
 * load what's left). If sending fails, the items come back and `failed` says why.
 */
export function deleteWithUndo(
  message: string,
  matches: (item: AgendaItem) => boolean,
  send: () => Promise<unknown>,
  done: () => void,
  failed: (error: unknown) => void,
): void {
  hidden.push(matches);
  hiddenChanged();
  const show = () => {
    const at = hidden.indexOf(matches);
    if (at >= 0) hidden.splice(at, 1);
    hiddenChanged();
  };
  offerUndo(message, show, async () => {
    try {
      await send();
      show();
      done();
    } catch (e) {
      show();
      failed(e);
    }
  });
}

// ⌘Z / Ctrl+Z while the bar is up (not while typing, where it undoes typing).
document.addEventListener("keydown", (e) => {
  if (!current || e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable]")) return;
  e.preventDefault();
  current.node.querySelector<HTMLButtonElement>(".undo-button")?.click();
});

// Leaving or putting the window away: send a waiting delete now.
window.addEventListener("pagehide", finish);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") finish();
});
