// A contact's card: their picture and name, buttons to message, call, email,
// FaceTime, meet or find them, everything you know about them, notes, and
// your events with them from Minuteman.
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, search, type AgendaItem, type Contact, type Interaction, type Labeled } from "../api";
import { el, setItemColor } from "../dom";
import { mapLink } from "../maps";
import { describeTimes, itemEnd, itemStart } from "../time";
import { describeLatest, KIND_WORDS, latestByContact, relativeTime } from "./history";
import type { Action } from "./parse";
import {
  age,
  daysUntilBirthday,
  describeBirthday,
  dialable,
  displayName,
  initials,
  labelText,
  nextBirthday,
  turning,
  whenBirthday,
  workLine,
} from "./model";

export interface CardActions {
  /** Messages, calls… someone; `anchor` is the button, for a menu of their numbers. */
  perform(action: Action, contact: Contact, anchor: HTMLElement): void;
  edit(contact: Contact): void;
  remove(contact: Contact): void;
  star(contact: Contact): void;
  /** Adds a dated line to their notes. */
  addNote(contact: Contact, text: string): Promise<void>;
  /** Opens one of the events with them. */
  openEvent(item: AgendaItem): void;
  /** Shows a day in the calendar (their next birthday). */
  showDay(day: Date): void;
  /** "Log…": a menu of things you did with them (a call from your phone, a meeting…). */
  logManually(contact: Contact, anchor: HTMLElement): void;
  /** Narrow windows: back to the list. */
  back(): void;
  /** Shows someone they're related to, by name (their card, or a search for them). */
  showPerson(name: string): void;
  /** Share…: a menu of ways to send their card. */
  share(contact: Contact, anchor: HTMLElement): void;
  /** Others in the same account who look like the same person. */
  duplicatesOf(contact: Contact): Contact[];
  /** Opens the review of `contact`'s duplicates, to merge them. */
  reviewDuplicates(contact: Contact): void;
}

export const isMac = () => /Macintosh|Mac OS X/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent);

/** Each person gets one of these colours behind their initials, always the same one. */
const AVATAR_COLORS = 6;

/** How long a card stays up before its events are looked up. */
const EVENTS_DELAY_MS = 300;

/** A round picture: their photo, or their initials on a colour. */
export function avatar(contact: Contact, size: "small" | "large"): HTMLElement {
  const node = el("span", `avatar avatar-${size}`);
  node.setAttribute("aria-hidden", "true");
  let hash = 0;
  for (const ch of contact.resourceName) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  node.classList.add(`avatar-color-${hash % AVATAR_COLORS}`);
  const letters = () => node.replaceChildren(el("span", "avatar-initials", initials(contact)));
  if (contact.photo) {
    const img = el("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    // Offline, or the photo has gone: the initials instead.
    img.addEventListener("error", letters, { once: true });
    img.src = contact.photo;
    node.append(img);
  } else letters();
  return node;
}

/** The quick actions across the top of the card, and what each needs. */
const QUICK: { action: Action; label: string; icon: string; has: (c: Contact) => boolean }[] = [
  {
    action: "message",
    label: "Message",
    icon: '<path d="M4 5h16v11H9l-4 4v-4H4z" />',
    has: (c) => c.phones.length > 0 || (isMac() && c.emails.length > 0),
  },
  {
    action: "call",
    label: "Call",
    icon: '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2Z" />',
    has: (c) => c.phones.length > 0,
  },
  {
    action: "email",
    label: "Email",
    icon: '<rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" />',
    has: (c) => c.emails.length > 0,
  },
  {
    action: "facetime",
    label: "FaceTime",
    icon: '<rect x="3" y="6.5" width="12.5" height="11" rx="2" /><path d="m15.5 11 5.5-3.5v9L15.5 13" />',
    has: (c) => isMac() && (c.phones.length > 0 || c.emails.length > 0),
  },
  {
    action: "event",
    label: "Meet",
    icon: '<rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" />',
    has: () => true,
  },
  {
    action: "map",
    label: "Map",
    icon: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.3" />',
    has: (c) => c.addresses.length > 0,
  },
];

const svg = (paths: string, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/**
 * Draws `contact`'s card. `accounts`: how many Google accounts there are (to
 * say which it's in). `history`: what's logged with them.
 */
export function renderCard(contact: Contact, actions: CardActions, accounts: number, history: Interaction[]): HTMLElement {
  const card = el("article", "contact-card");
  card.setAttribute("aria-label", displayName(contact));

  const back = el("button", "text-button card-back", "‹ Contacts");
  back.addEventListener("click", () => actions.back());

  const head = el("header", "card-head");
  const names = el("div", "card-names");
  const title = el("h2", "card-name", displayName(contact));
  names.append(title);
  if (contact.nickname) names.append(el("p", "card-sub", `“${contact.nickname}”`));
  const work = workLine(contact);
  if (work && work !== displayName(contact)) names.append(el("p", "card-sub", work));
  if (accounts > 1) names.append(el("p", "card-account", contact.account));
  const latest = latestByContact(history).get(contact.id);
  if (latest) names.append(el("p", "card-account card-latest", `Last: ${describeLatest(latest, new Date())}`));
  const star = el("button", "icon-button card-star", contact.starred ? "★" : "☆");
  star.setAttribute("aria-pressed", String(contact.starred));
  star.title = contact.starred ? "Remove from Favorites" : "Add to Favorites";
  star.setAttribute("aria-label", star.title);
  star.addEventListener("click", () => actions.star(contact));
  head.append(avatar(contact, "large"), names, star);

  const quick = el("div", "card-quick");
  for (const { action, label, icon, has } of QUICK) {
    if (action === "facetime" && !isMac()) continue;
    const button = el("button", "quick-action");
    button.innerHTML = svg(icon);
    button.append(el("span", "quick-label", label));
    button.disabled = !has(contact);
    button.addEventListener("click", () => actions.perform(action, contact, button));
    quick.append(button);
  }

  const fields = el("div", "card-fields");
  const callable = (phone: Labeled) => {
    const value = linkish(phone.value, () => void openUrl(`tel:${dialable(phone.value)}`));
    const text = el("button", "link-button card-mini", "Text");
    text.addEventListener("click", () => void openUrl(`sms:${dialable(phone.value)}`));
    const box = el("span", "card-value");
    box.append(value, text, copyButton(phone.value));
    return box;
  };
  for (const phone of contact.phones) fields.append(field(labelText(phone.label, "Phone"), callable(phone)));
  for (const email of contact.emails) {
    const value = linkish(email.value, () => void openUrl(`mailto:${email.value}`));
    const box = el("span", "card-value");
    box.append(value, copyButton(email.value));
    fields.append(field(labelText(email.label, "Email"), box));
  }
  for (const address of contact.addresses) {
    const value = linkish(address.value, () => void openUrl(mapLink(address.value)));
    value.classList.add("card-address");
    const box = el("span", "card-value");
    box.append(value, copyButton(address.value));
    fields.append(field(labelText(address.label, "Address"), box));
  }
  for (const url of contact.urls) {
    const href = /^https?:\/\//i.test(url.value) ? url.value : `https://${url.value}`;
    fields.append(field(labelText(url.label, "Website"), linkish(url.value, () => void openUrl(href))));
  }
  if (contact.birthday) {
    const today = new Date();
    const days = daysUntilBirthday(contact.birthday, today);
    const next = turning(contact.birthday, today);
    const now = age(contact.birthday, today);
    const soon = days < 30 ? ` · ${whenBirthday(contact.birthday, today)}${next ? `, turning ${next}` : ""}` : "";
    // Their age, as Cardhop shows it: "March 4, 1990 (age 36)".
    const years = now !== null && days !== 0 ? ` (age ${now})` : "";
    // Clicking it shows their next birthday in the calendar.
    const value = linkish(`${describeBirthday(contact.birthday)}${years}${soon}`, () =>
      actions.showDay(nextBirthday(contact.birthday!, today)),
    );
    value.classList.add("card-birthday");
    if (days === 0) value.classList.add("today");
    value.title = "Show in the calendar";
    fields.append(field("Birthday", value));
  }
  for (const relation of contact.relations ?? []) {
    const value = linkish(relation.value, () => actions.showPerson(relation.value));
    value.title = `Show ${relation.value}`;
    fields.append(field(labelText(relation.label, "Related"), value));
  }
  if (contact.phones.length + contact.emails.length + contact.addresses.length + contact.urls.length === 0 && !contact.birthday) {
    fields.append(el("p", "card-empty", "No phone, email or address yet. Edit to add them."));
  }

  const notes = notesSection(contact, actions);
  const parts: HTMLElement[] = [back, head, quick];
  const duplicates = actions.duplicatesOf(contact);
  if (duplicates.length) {
    // "Also listed as Sam Adams · Review…", as Cardhop and Google Contacts point them out.
    const notice = el("div", "card-duplicate");
    const names = [...new Set(duplicates.map(displayName))].join(", ");
    notice.append(el("span", undefined, `Looks like the same person as ${names}.`));
    const review = el("button", "link-button card-mini", "Merge…");
    review.type = "button";
    review.addEventListener("click", () => actions.reviewDuplicates(contact));
    notice.append(review);
    parts.push(notice);
  }
  card.append(...parts, fields, notes, historySection(contact, actions, history), footer(contact, actions));
  return card;
}

function field(label: string, value: Node): HTMLElement {
  const row = el("div", "card-field");
  row.append(el("span", "card-label", label), value);
  return row;
}

/** A value that does something when clicked (calls, emails, maps), but reads as text. */
function linkish(text: string, run: () => void): HTMLButtonElement {
  const button = el("button", "card-link", text);
  button.type = "button";
  button.addEventListener("click", run);
  return button;
}

function copyButton(text: string): HTMLButtonElement {
  const button = el("button", "link-button card-mini", "Copy");
  button.type = "button";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Couldn't copy";
    }
    window.setTimeout(() => (button.textContent = "Copy"), 1500);
  });
  return button;
}

/** Their notes, and a box to add a dated one ("Oct 30: met for coffee"). */
function notesSection(contact: Contact, actions: CardActions): HTMLElement {
  const section = el("section", "card-section card-notes");
  section.append(el("h3", "card-heading", "Notes"));
  if (contact.notes) section.append(el("p", "card-notes-text", contact.notes));
  const form = el("form", "card-note-form");
  const input = el("input", "text-input card-note-input");
  input.placeholder = "Add a note…";
  input.setAttribute("aria-label", `Add a note about ${displayName(contact)}`);
  const error = el("p", "error");
  form.append(input, error);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    error.textContent = "";
    try {
      await actions.addNote(contact, text);
    } catch (err) {
      error.textContent = `Couldn't save the note: ${errorMessage(err)}`;
      input.disabled = false;
    }
  });
  section.append(form);
  return section;
}

/** Entries in History before "Show all". */
const HISTORY_SHOWN = 8;

/** A line in History: something logged, or a past event with them. */
type HistoryLine = { at: Date; entry: Interaction } | { at: Date; event: AgendaItem };

/**
 * "With Sam": upcoming events with them, then their History: what's logged
 * (calls, messages, notes…) merged with past events, latest first. Events are
 * found by their email addresses (or whole name).
 */
function historySection(contact: Contact, actions: CardActions, log: Interaction[]): HTMLElement {
  const section = el("section", "card-section card-events");
  const first = contact.givenName || displayName(contact).split(" ")[0];
  const head = el("div", "card-heading-row");
  const logButton = el("button", "link-button card-mini", "Log…");
  logButton.type = "button";
  logButton.title = `Log something you did with ${first}`;
  logButton.addEventListener("click", () => actions.logManually(contact, logButton));
  head.append(el("h3", "card-heading", `With ${first}`), logButton);
  const upcomingBox = el("div");
  const historyBox = el("div");
  const status = el("p", "card-empty");
  section.append(head, upcomingBox, historyBox, status);

  let lines: HistoryLine[] = log.map((entry) => ({ at: new Date(entry.at), entry }));
  let showAll = false;
  const drawHistory = () => {
    lines.sort((a, b) => b.at.getTime() - a.at.getTime());
    const list = el("ul", "history-list");
    for (const line of showAll ? lines : lines.slice(0, HISTORY_SHOWN)) list.append(historyLine(line, actions));
    const parts: HTMLElement[] = [el("h4", "card-subheading", "History"), list];
    if (!showAll && lines.length > HISTORY_SHOWN) {
      const more = el("button", "link-button card-mini history-more", `Show all ${lines.length}`);
      more.type = "button";
      more.addEventListener("click", () => {
        showAll = true;
        drawHistory();
      });
      parts.push(more);
    }
    historyBox.replaceChildren(...(lines.length ? parts : []));
    status.textContent = lines.length
      ? ""
      : `Nothing yet. Calls, messages and emails you start here, notes, and meetings with ${first} show up here.`;
  };
  drawHistory();

  const queries = contact.emails.map((e) => e.value);
  // A name alone finds too much unless it's a whole name.
  if (queries.length === 0 && displayName(contact).includes(" ") && contact.name) queries.push(contact.name);
  if (queries.length === 0) return section;

  // A moment's wait: while you type, the card can change with each letter.
  const look = () => Promise.all(queries.slice(0, 3).map((q) => search(q)));
  void new Promise((resolve) => window.setTimeout(resolve, EVENTS_DELAY_MS))
    .then(() => (section.isConnected ? look() : null))
    .then((results) => {
      if (!results) return;
      const seen = new Set<string>();
      const unique = (items: AgendaItem[]) => items.filter((item) => !seen.has(item.id) && seen.add(item.id));
      const upcoming = oncePerSeries(unique(results.flatMap((r) => r.upcoming)), 1);
      const past = oncePerSeries(unique(results.flatMap((r) => r.past)), -1);
      if (upcoming.length) upcomingBox.replaceChildren(eventList("Upcoming", upcoming.slice(0, 4), actions));
      lines = [...lines, ...past.map((event) => ({ at: itemStart(event), event }))];
      drawHistory();
    })
    .catch((e) => {
      upcomingBox.replaceChildren(el("p", "card-empty", `Couldn't look in your calendars: ${errorMessage(e)}`));
    });
  return section;
}

/**
 * A repeating event once, so a daily standup doesn't fill the card: its
 * soonest occurrence (`order` 1) or latest (-1). Sorted the same way.
 */
function oncePerSeries(items: AgendaItem[], order: 1 | -1): AgendaItem[] {
  const sorted = [...items].sort((a, b) => order * (+itemStart(a) - +itemStart(b)));
  const seen = new Set<string>();
  return sorted.filter((item) => {
    const key = item.seriesId ?? (item.recurring ? `${item.listId}:${item.title}` : item.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function historyLine(line: HistoryLine, actions: CardActions): HTMLElement {
  const li = el("li", "history-line");
  const now = new Date();
  if ("event" in line) {
    const button = el("button", "history-event");
    button.type = "button";
    setItemColor(li, line.event); // its dot
    button.append(
      el("span", "history-what", line.event.title),
      el("span", "history-when", `${line.event.recurring ? "Repeating event, last" : "Event"} · ${relativeTime(line.at, now)}`),
    );
    button.title = describeTimes(itemStart(line.event), itemEnd(line.event), line.event.allDay);
    button.addEventListener("click", () => actions.openEvent(line.event));
    li.append(button);
    return li;
  }
  const { entry } = line;
  li.classList.add(`history-${entry.kind}`);
  const what = el("span", "history-what", KIND_WORDS[entry.kind]);
  if (entry.detail) what.append(el("span", "history-detail", entry.kind === "email" ? ` about “${entry.detail}”` : `: ${entry.detail}`));
  const when = el("span", "history-when", relativeTime(line.at, now));
  when.title = line.at.toLocaleString();
  li.append(what, when);
  return li;
}

function eventList(title: string, items: AgendaItem[], actions: CardActions): HTMLElement {
  const box = el("div");
  const list = el("ul", "search-list");
  for (const item of items) {
    const button = el("button", "search-result");
    setItemColor(button, item);
    button.append(
      el("span", "search-title", item.title),
      el("span", "search-when", describeTimes(itemStart(item), itemEnd(item), item.allDay)),
    );
    button.addEventListener("click", () => actions.openEvent(item));
    const li = el("li");
    li.append(button);
    list.append(li);
  }
  box.append(el("h4", "card-subheading", title), list);
  return box;
}

function footer(contact: Contact, actions: CardActions): HTMLElement {
  const buttons = el("div", "dialog-buttons card-buttons");
  const remove = el("button", "text-button danger", "Delete");
  remove.addEventListener("click", () => actions.remove(contact));
  const google = el("button", "text-button", "Open in Google Contacts");
  const id = contact.resourceName.replace(/^people\//, "");
  google.addEventListener("click", () =>
    openUrl(`https://contacts.google.com/person/${encodeURIComponent(id)}?authuser=${encodeURIComponent(contact.account)}`),
  );
  const share = el("button", "text-button", "Share…");
  share.title = "Send their contact card, or copy it";
  share.addEventListener("click", () => actions.share(contact, share));
  const edit = el("button", "primary-button", "Edit");
  edit.addEventListener("click", () => actions.edit(contact));
  buttons.append(remove, google, share, edit);
  return buttons;
}
