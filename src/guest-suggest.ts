// Guests in New and Edit (event-form.ts): type part of someone's name (or
// nickname, company, or email address) and your contacts with an email
// show under the box; pick one and their address goes in, with ", " after
// it for the next. Looks like the place suggestions (place-suggest.ts), and
// uses the same contacts, so nothing new is fetched.
import type { Contact } from "./api";
import { el } from "./dom";
import { knownContacts } from "./place-suggest";

/** At most this many suggestions at once. */
const MAX = 6;

interface Guest {
  name: string;
  email: string;
  /** "Work", "Home"… */
  label: string | null;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}@._+-]+/u)
    .filter(Boolean);

/** The guest being typed: what's after the last comma or semicolon. */
function current(value: string, caret: number): { start: number; text: string } {
  const before = value.slice(0, caret);
  const start = Math.max(before.lastIndexOf(","), before.lastIndexOf(";")) + 1;
  return { start, text: before.slice(start).trim() };
}

/** Contacts' emails matching `text` (every word starts a word of their name, or the email starts with it), not already in `taken`. */
export function matchGuests(contacts: Contact[], text: string, taken: Set<string>): Guest[] {
  const wanted = words(text);
  if (wanted.length === 0) return [];
  const found: Guest[] = [];
  for (const person of contacts) {
    const name = person.name || [person.givenName, person.familyName].filter(Boolean).join(" ") || person.organization || "";
    const names = words([name, person.nickname, person.organization].filter(Boolean).join(" "));
    const byName = wanted.every((w) => names.some((n) => n.startsWith(w)));
    for (const email of person.emails) {
      const address = email.value.trim().toLowerCase();
      // Each address once (two contacts can share one).
      if (!address || taken.has(address) || found.some((g) => g.email.toLowerCase() === address)) continue;
      if (!byName && !address.startsWith(text.trim().toLowerCase())) continue;
      const label = email.label ? email.label[0].toUpperCase() + email.label.slice(1) : null;
      found.push({ name: name || address, email: email.value.trim(), label });
    }
  }
  return found.slice(0, MAX);
}

/** Suggests contacts under `field` (comma-separated emails) as you type a name. */
export function enableGuestSuggestions(field: HTMLInputElement): void {
  const list = el("div", "place-suggest");
  list.setAttribute("role", "listbox");
  list.id = `guest-suggest-${Math.random().toString(36).slice(2, 8)}`;
  list.hidden = true;
  field.setAttribute("aria-autocomplete", "list");
  field.setAttribute("aria-controls", list.id);
  field.setAttribute("aria-expanded", "false");
  field.autocomplete = "off";
  let shown: Guest[] = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    shown = [];
    active = -1;
    field.setAttribute("aria-expanded", "false");
    field.removeAttribute("aria-activedescendant");
  };

  // Under the field (above it when there's more room there, as over a phone's keyboard).
  const place = () => {
    const host = field.parentElement!;
    if (list.parentElement !== host) {
      host.classList.add("place-suggest-host");
      field.after(list);
    }
    list.style.left = `${field.offsetLeft}px`;
    list.style.width = `${field.offsetWidth}px`;
    const view = window.visualViewport;
    const top = view ? view.offsetTop : 0;
    const bottom = view ? view.offsetTop + view.height : window.innerHeight;
    const r = field.getBoundingClientRect();
    const [below, above] = [bottom - r.bottom - 8, r.top - top - 8];
    const up = below < Math.min(list.scrollHeight, 260) && above > below;
    list.style.maxHeight = `${Math.max(100, Math.min(260, up ? above : below))}px`;
    if (up) {
      list.style.top = "";
      list.style.bottom = `${host.clientHeight - field.offsetTop + 4}px`;
    } else {
      list.style.bottom = "";
      list.style.top = `${field.offsetTop + field.offsetHeight + 4}px`;
    }
  };

  const highlight = (index: number) => {
    active = index;
    [...list.children].forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
    if (index >= 0) field.setAttribute("aria-activedescendant", `${list.id}-${index}`);
    else field.removeAttribute("aria-activedescendant");
  };

  /** Puts `guest`'s email in place of what's being typed, then ", " for the next. */
  const pick = (guest: Guest) => {
    close();
    const caret = field.selectionStart ?? field.value.length;
    const { start } = current(field.value, caret);
    const before = field.value.slice(0, start).replace(/\s*$/, "");
    const after = field.value.slice(caret).replace(/^[^,;]*[,;]?\s*/, "");
    const head = before ? `${before} ` : "";
    field.value = `${head}${guest.email}, ${after}`;
    const end = head.length + guest.email.length + 2;
    field.setSelectionRange(end, end);
    // As if typed, so the form knows it changed.
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const show = (guests: Guest[]) => {
    shown = guests;
    if (!guests.length || document.activeElement !== field) return close();
    list.replaceChildren(
      ...guests.map((g, i) => {
        const option = el("div", "place-suggest-option");
        option.id = `${list.id}-${i}`;
        option.setAttribute("role", "option");
        option.append(
          el("span", "place-suggest-main", g.name),
          el("span", "place-suggest-detail", g.label ? `${g.email} · ${g.label}` : g.email),
        );
        // Pressed, not clicked: the field keeps focus (and a phone its keyboard).
        option.addEventListener("pointerdown", (e) => e.preventDefault());
        option.addEventListener("mousedown", (e) => e.preventDefault());
        option.addEventListener("click", () => pick(g));
        return option;
      }),
    );
    // The first is chosen: Enter adds it (rather than saving the form).
    highlight(0);
    list.hidden = false;
    place();
    field.setAttribute("aria-expanded", "true");
  };

  let asked = 0;
  field.addEventListener("input", (e) => {
    if (!e.isTrusted) return; // filled in by pick()
    const { text } = current(field.value, field.selectionStart ?? field.value.length);
    if (text.length < 1) return close();
    const taken = new Set(
      field.value
        .split(/[\s,;]+/)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.includes("@")),
    );
    const ask = ++asked;
    void knownContacts().then(
      (contacts) => ask === asked && show(matchGuests(contacts, text, taken)),
      () => close(),
    );
  });
  field.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = active + (e.key === "ArrowDown" ? 1 : -1);
      highlight(next >= shown.length ? 0 : next < 0 ? shown.length - 1 : next);
    } else if ((e.key === "Enter" || e.key === "Tab") && active >= 0) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Escape") {
      // Closes the list, not the dialog around it.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  // A moment later: a tap on a suggestion can take the focus first (iPhone).
  field.addEventListener("blur", () => window.setTimeout(() => document.activeElement !== field && close(), 200));
  window.visualViewport?.addEventListener("resize", () => !list.hidden && place());
  window.addEventListener("resize", () => !list.hidden && place());
}
