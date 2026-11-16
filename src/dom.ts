import type { AgendaItem } from "./api";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Colors an element (via the --item-color CSS variable) with its item's calendar color. */
export function setItemColor(node: HTMLElement, item: AgendaItem): void {
  node.style.setProperty("--item-color", item.color ?? "var(--accent)");
}

/**
 * Sets up a task's look: its checkbox (inserted first in `node`), struck
 * through when done, and an "overdue" style. Does nothing for events.
 */
export function decorateTask(node: HTMLElement, item: AgendaItem, onToggle: (item: AgendaItem) => void): void {
  if (item.kind !== "task") return;
  node.classList.add("task");
  if (item.completed) node.classList.add("completed");
  if (item.overdue) node.classList.add("overdue");

  const check = el("button", "task-check");
  check.role = "checkbox";
  check.setAttribute("aria-checked", String(item.completed));
  check.setAttribute("aria-label", item.completed ? `Mark "${item.title}" not done` : `Complete "${item.title}"`);
  check.title = item.completed ? "Mark as not done" : "Complete";
  if (item.priority) check.dataset.priority = String(item.priority);
  check.addEventListener("click", (e) => {
    e.stopPropagation(); // don't also open the task in Todoist
    onToggle(item);
  });
  node.prepend(check);
}

/** Shows the item's details (`open`) on click or Enter. */
export function makeOpenable(node: HTMLElement, item: AgendaItem, open: (item: AgendaItem) => void): void {
  node.title = item.title;
  node.tabIndex = 0;
  node.role = "button";
  node.addEventListener("click", (e) => {
    e.stopPropagation();
    // The click that ends dragging an event isn't a request to open it.
    if (!node.classList.contains("dragging")) open(item);
  });
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter") open(item);
  });
  // Quick actions: right-click, or press and hold.
  node.addEventListener("contextmenu", (e) => {
    if (!itemMenu) return;
    e.preventDefault();
    e.stopPropagation();
    itemMenu(item, e.clientX, e.clientY);
  });
  onLongPress(node, (press) => itemMenu?.(item, press.clientX, press.clientY));
}

/** Quick actions for an item (right-click, or press and hold), set by the page that shows items. */
let itemMenu: ((item: AgendaItem, x: number, y: number) => void) | null = null;
export function setItemMenu(show: (item: AgendaItem, x: number, y: number) => void): void {
  itemMenu = show;
}

/** How long a finger rests, without moving, to press and hold. */
const HOLD_MS = 500;
/** Presses already taken by an element inside the one that hears it next. */
const claimed = new WeakSet<Event>();

/**
 * Pressing and holding with a finger (on a touch screen; a mouse
 * right-clicks instead): `held` runs with the press, unless the finger
 * moved first (that's scrolling) or lifted. The tap, and the system's own
 * long-press menu, that would follow are swallowed. The innermost element
 * listening gets it.
 */
export function onLongPress(node: HTMLElement, held: (press: PointerEvent) => void): void {
  node.addEventListener("pointerdown", (down) => {
    if (down.pointerType !== "touch" || !down.isPrimary || claimed.has(down)) return;
    claimed.add(down);
    const stop = () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", moved);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("contextmenu", quiet, true);
    };
    const moved = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > 10) stop();
    };
    // Android's own long-press menu would come first; this one decides.
    const quiet = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const timer = window.setTimeout(() => {
      stop();
      swallow("click");
      swallow("contextmenu");
      navigator.vibrate?.(10);
      held(down);
    }, HOLD_MS);
    window.addEventListener("pointermove", moved, { passive: true });
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("contextmenu", quiet, true);
  });
}

/** Swallows the next `type` event (within a moment), e.g. the tap that ends a long press. */
function swallow(type: "click" | "contextmenu"): void {
  const eat = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener(type, eat, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener(type, eat, true), 800);
}

/**
 * A small menu at (x, y), e.g. on right-click: one button per item. It closes
 * when one is chosen, or on a click elsewhere, Esc, scrolling or resizing.
 */
export function showMenu(x: number, y: number, items: [string, () => void][]): void {
  document.querySelector(".context-menu")?.remove();
  const menu = el("div", "context-menu");
  menu.role = "menu";
  const close = () => {
    menu.remove();
    window.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("keydown", escape, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
    document.removeEventListener("scroll", close, true);
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  for (const [label, run] of items) {
    const item = el("button", "context-menu-item", label);
    item.role = "menuitem";
    item.addEventListener("click", () => {
      close();
      run();
    });
    menu.append(item);
  }
  document.body.append(menu);
  // Keep it on screen.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - rect.height - 4))}px`;
  menu.querySelector<HTMLButtonElement>("button")?.focus();
  window.addEventListener("pointerdown", outside, true);
  window.addEventListener("keydown", escape, true);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  document.addEventListener("scroll", close, true);
}

/** A left chevron, the "Back" icon (also on a contact card's bar). */
export const BACK_ICON = '<path d="M15 5l-7 7 7 7" />';

/**
 * Every way back, the same: a button with a left chevron over "Back", as
 * the contact card's bar on a phone. `to` names where it goes ("Settings"),
 * for screen readers and the tooltip.
 */
export function backButton(to: string, onClick: () => void, className = ""): HTMLButtonElement {
  const button = el("button", `back-button${className ? ` ${className}` : ""}`);
  button.type = "button";
  button.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BACK_ICON}</svg>`;
  button.append(el("span", "back-button-label", "Back"));
  button.setAttribute("aria-label", `Back to ${to}`);
  button.title = `Back to ${to}`;
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Focuses `dialog` itself, no field in it, so a phone's keyboard stays down
 * until you tap a field. (Its outline is off: `dialog:focus` in styles.css.)
 */
export function focusDialog(dialog: HTMLDialogElement): void {
  dialog.tabIndex = -1;
  dialog.focus();
}

/** Whether focusing `node` would bring up a phone's keyboard. */
export function isTextField(node: Element): boolean {
  if (node instanceof HTMLTextAreaElement) return true;
  if (node instanceof HTMLElement && node.isContentEditable) return true;
  if (!(node instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(node.type);
}
