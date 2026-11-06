// Minuteman Contacts: your Google contacts, in the style of Cardhop. One box
// does everything: type to search; type someone new ("Jane Doe
// jane@example.com 555-0100") to add them; or say what to do ("call Sam",
// "email Sam about lunch", "meet Sam tomorrow 3pm", "note Sam: likes jazz").
// The line under the box says what Enter will do.
//
// On the desktop it's a window of its own (src-tauri/src/desktop.rs); on a
// phone and the website, its own page (contacts.html).
import "@fontsource/libre-caslon-text/latin-400.css";
import "@fontsource/libre-caslon-text/latin-700.css";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  authStatus,
  contactRef,
  createContact,
  deleteContact,
  errorMessage,
  getContacts,
  getInteractions,
  getSavedContacts,
  isNotSignedIn,
  logInteraction,
  mergeContacts,
  saveContactCard,
  setContactStarred,
  signIn,
  updateContact,
  type AgendaItem,
  type Contact,
  type ContactDraft,
  type ContactList,
  type Interaction,
  type InteractionKind,
  type Labeled,
} from "../api";
import { boot } from "../boot";
import { ask, openDetails } from "../details";
import { setUpDockMenu } from "../dock-menu";
import { el, showMenu } from "../dom";
import { openDuplicate, openEdit, openNew } from "../event-form";
import { mapLink } from "../maps";
import { openSettings } from "../settings";
import { announceChange } from "../sync";
import { timeFormat } from "../time";
import { avatar, isMac, renderCard, type CardActions } from "./card";
import { openContactForm } from "./form";
import { openCalendar } from "./open";
import { describeLatest, historyOf, KIND_WORDS, latestByContact, recentContacts } from "./history";
import {
  bestToKeep,
  cardText,
  dialable,
  displayName,
  findDuplicates,
  groupKey,
  indexLetter,
  labelText,
  mergeOf,
  newValues,
  toVCard,
  turning,
  upcomingBirthdays,
  whenBirthday,
  workLine,
} from "./model";
import { eventSentence, interpret, type Action, type Intent, type ParsedContact } from "./parse";

/** How often to fetch contacts again while the window's in view. */
const SYNC_EVERY_MS = 5 * 60 * 1000;
/** Birthdays this many days ahead are listed above everyone. */
const BIRTHDAY_DAYS = 14;
/** The account new contacts go in, as last chosen. */
const ACCOUNT_STORAGE_KEY = "contacts.account";
/** Groups of possible duplicates you said aren't the same person (`groupKey`s, JSON). */
const NOT_DUPLICATES_KEY = "contacts.notDuplicates";

const input = document.querySelector<HTMLInputElement>("#ask")!;
const hint = document.querySelector<HTMLElement>("#hint")!;
const listBox = document.querySelector<HTMLElement>("#list")!;
const cardBox = document.querySelector<HTMLElement>("#card")!;
const banner = document.querySelector<HTMLElement>("#banner")!;
const countLine = document.querySelector<HTMLElement>("#account")!;
const body = document.body;
/** Phone-sized: the box and buttons float at the bottom (contacts.css). */
const phone = window.matchMedia("(max-width: 640px)");

let list: ContactList | undefined;
/** What's logged with people (interactions.rs), oldest first. */
let log: Interaction[] = [];
let intent: Intent = { kind: "empty" };
/** The person whose card is open. */
let selectedId: string | null = null;
/** The people in the list as drawn, in order, for ↑ and ↓. */
let listed: Contact[] = [];
let lastSync = 0;
let latestRequest = 0;

const contacts = () => list?.contacts ?? [];

/** Possible duplicates (same account), worked out again when the list changes. */
let duplicateGroups: Contact[][] = [];
let duplicatesOfList: ContactList | undefined;

function notDuplicates(): Set<string> {
  try {
    return new Set(JSON.parse(readSaved(NOT_DUPLICATES_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function duplicates(): Contact[][] {
  if (duplicatesOfList !== list) {
    duplicateGroups = findDuplicates(contacts(), notDuplicates());
    duplicatesOfList = list;
  }
  return duplicateGroups;
}

const groupOf = (contact: Contact) => duplicates().find((g) => g.some((c) => c.id === contact.id)) ?? null;
const selected = () => contacts().find((c) => c.id === selectedId) ?? null;

/** Accounts that allow contacts, the one last used for new contacts first. */
function usableAccounts(): string[] {
  const usable = (list?.accounts ?? []).filter((a) => a.canUse).map((a) => a.email);
  const saved = readSaved(ACCOUNT_STORAGE_KEY);
  return saved && usable.includes(saved) ? [saved, ...usable.filter((a) => a !== saved)] : usable;
}

function readSaved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not important enough to report.
  }
}

// ---------- Loading ----------

async function load(): Promise<void> {
  const request = ++latestRequest;
  if (!list) {
    const saved = await getSavedContacts().catch(() => null);
    if (saved && request === latestRequest && !list) show(saved);
  }
  void getInteractions()
    .then((entries) => {
      if (JSON.stringify(entries) === JSON.stringify(log)) return;
      log = entries;
      if (list) update();
    })
    .catch(() => {});
  try {
    const fresh = await getContacts();
    lastSync = Date.now();
    if (request === latestRequest) show(fresh);
  } catch (e) {
    if (request !== latestRequest) return;
    if (isNotSignedIn(e)) return showSignedOut();
    banner.replaceChildren(el("p", list ? "warning" : "error", errorMessage(e)));
    if (!list) listBox.replaceChildren();
  }
}

function show(loaded: ContactList): void {
  // Nothing new: leave it be (and the list where you'd scrolled it).
  if (list && JSON.stringify(list) === JSON.stringify(loaded)) return;
  list = loaded;
  body.classList.remove("signed-out");
  showNotes(loaded);
  const n = loaded.contacts.length;
  countLine.textContent = n === 1 ? "1 contact" : `${n.toLocaleString()} contacts`;
  update();
}

/** Accounts that need permission, couldn't load, or no internet. */
function showNotes(loaded: ContactList): void {
  const notes: HTMLElement[] = [];
  if (loaded.offlineSince) {
    const saved = new Date(loaded.offlineSince);
    const when = Number.isNaN(saved.getTime()) ? "" : ` from ${saved.toLocaleDateString()} ${timeFormat.format(saved)}`;
    notes.push(el("p", "warning", `No internet. Showing contacts saved${when}.`));
  }
  for (const account of loaded.accounts) {
    if (account.error) notes.push(el("p", "warning", `Couldn't load ${account.email}'s contacts: ${account.error}`));
    if (account.canUse) continue;
    const note = el("p", "warning");
    const allow = el("button", "link-button", "Allow…");
    allow.addEventListener("click", async () => {
      allow.disabled = true;
      allow.textContent = "Continue in your browser…";
      try {
        await signIn();
        await load();
      } catch (e) {
        allow.textContent = errorMessage(e);
      }
    });
    note.append(`Minuteman needs permission to use ${account.email}'s contacts. `, allow);
    notes.push(note);
  }
  banner.replaceChildren(...notes);
}

function showSignedOut(): void {
  list = undefined;
  body.classList.add("signed-out");
  banner.replaceChildren();
  hint.replaceChildren();
  cardBox.replaceChildren();
  countLine.textContent = "";
  const view = el("div", "sign-in");
  view.append(el("p", "sign-in-text", "Sign in to Google in Minuteman to see your contacts here."));
  const open = el("button", "primary-button", "Open Minuteman");
  open.addEventListener("click", () => openCalendar());
  view.append(open);
  listBox.replaceChildren(view);
}

// ---------- Drawing ----------

/** Reads the box again and redraws the hint, the list and the card. */
function update(): void {
  if (!list) return;
  intent = interpret(input.value, list.contacts, new Date());
  drawHint();
  drawList();
  // Typing someone's name shows their card, as in Cardhop.
  const best = intentContact(intent);
  if (best) selectedId = best.id;
  drawCard();
}

/** The person what's typed is about, if any. */
function intentContact(i: Intent): Contact | null {
  switch (i.kind) {
    case "search":
      return i.matches[0] ?? null;
    case "action":
    case "log":
      return i.contact;
    case "update":
      return i.contact;
    default:
      return null;
  }
}

const ACTION_WORDS: Record<Action, string> = {
  call: "Call",
  message: "Message",
  email: "Email",
  facetime: "FaceTime",
  event: "New event with",
  note: "Add a note to",
  map: "Map",
};

/** The line under the box: what Enter does. Clicking it does it too. */
function drawHint(): void {
  const line = el("button", "hint");
  line.type = "button";
  const enter = el("kbd", "hint-key", "↵");
  let text = "";
  let detail = "";
  let doable = true;
  switch (intent.kind) {
    case "empty":
      hint.replaceChildren(el("p", "hint-help", "Type a name to search, someone new to add them, or “call Sam”, “email Sam”, “meet Sam tomorrow 3pm”…"));
      return;
    case "search":
      if (intent.matches[0]) text = `Open ${displayName(intent.matches[0])}`;
      else if (intent.add) {
        text = `Add “${[intent.add.givenName, intent.add.familyName].filter(Boolean).join(" ")}” as a new contact`;
      } else {
        text = "No contacts match";
        doable = false;
      }
      break;
    case "action": {
      const { contact, action, rest } = intent;
      if (!contact) {
        text = `No one called “${intent.query}”`;
        doable = false;
        break;
      }
      const missing = missingFor(action, contact);
      text = `${ACTION_WORDS[action]} ${displayName(contact)}`;
      if (missing) {
        detail = missing;
        doable = false;
      } else if (action === "email" && rest) detail = `About “${rest}”`;
      else if (action === "note") detail = rest ? `“${rest}”` : "Type the note after their name";
      else if (action === "event" && rest) detail = eventSentence(contact, rest, new Date());
      else detail = describeTarget(action, contact);
      if (action === "note" && !rest) doable = false;
      break;
    }
    case "log": {
      const { contact, logKind, rest } = intent;
      if (!contact) {
        text = `No one called “${intent.query}”`;
        doable = false;
        break;
      }
      text = `Log for ${displayName(contact)}: ${KIND_WORDS[logKind]}`;
      detail = rest ? (logKind === "email" ? `About “${rest}”` : rest) : "Add what it was about, or press Enter";
      break;
    }
    case "add":
      text = "Add a new contact";
      detail = summary(intent.details);
      if (usableAccounts().length > 1) detail += ` · to ${usableAccounts()[0]}`;
      break;
    case "update": {
      text = `Add to ${displayName(intent.contact)}`;
      const added = additions(intent.contact, intent.details);
      detail = added.length ? added.join(" · ") : "They already have these details";
      doable = added.length > 0;
      break;
    }
  }
  line.disabled = !doable;
  line.append(doable ? enter : "", el("span", "hint-text", text));
  if (detail) line.append(el("span", "hint-detail", detail));
  line.addEventListener("click", () => void perform(line));
  hint.replaceChildren(line);
}

/** Why someone can't be called, emailed… ("Sam Lee has no phone number"), or null. */
function missingFor(action: Action, contact: Contact): string | null {
  const name = displayName(contact);
  if ((action === "call" || action === "message") && contact.phones.length === 0) {
    if (action === "message" && isMac() && contact.emails.length) return null;
    return `${name} has no phone number`;
  }
  if (action === "email" && contact.emails.length === 0) return `${name} has no email address`;
  if (action === "facetime" && contact.phones.length + contact.emails.length === 0) return `${name} has no phone or email`;
  if (action === "map" && contact.addresses.length === 0) return `${name} has no address`;
  return null;
}

/** "+1 555 0100", or "2 numbers" when there's a choice. */
function describeTarget(action: Action, contact: Contact): string {
  const values = targets(action, contact);
  if (values.length === 1) return values[0].value;
  if (values.length > 1) return `${values.length} to choose from`;
  return "";
}

/** What a new contact will have: "Jane Doe · Designer at Acme · jane@example.com". */
function summary(details: ParsedContact): string {
  const name = [details.givenName, details.familyName].filter(Boolean).join(" ");
  const work = details.jobTitle && details.organization ? `${details.jobTitle} at ${details.organization}` : (details.jobTitle ?? details.organization);
  const birthday = details.birthday ? `born ${details.birthday.month}/${details.birthday.day}${details.birthday.year ? `/${details.birthday.year}` : ""}` : null;
  return [
    name,
    details.nickname ? `“${details.nickname}”` : null,
    work,
    ...[...details.phones, ...details.emails, ...details.addresses, ...details.urls].map(labeledText),
    birthday,
    details.notes ? `note: ${details.notes}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const labeledText = (v: Labeled) => (v.label ? `${labelText(v.label, v.label).toLowerCase()} ${v.value}` : v.value);

/** The details in `details` that `contact` doesn't have yet, in words. */
function additions(contact: Contact, details: ParsedContact): string[] {
  return [
    ...newValues(details.phones, contact.phones, "phone"),
    ...newValues(details.emails, contact.emails, "email"),
    ...newValues(details.addresses, contact.addresses, "other"),
    ...newValues(details.urls, contact.urls, "other"),
  ]
    .map(labeledText)
    .concat(details.organization && details.organization !== contact.organization ? [`works at ${details.organization}`] : [])
    .concat(details.birthday && !contact.birthday ? ["birthday"] : [])
    .concat(details.notes ? [`note: ${details.notes}`] : []);
}

function drawList(): void {
  const all = contacts();
  const typed = input.value.trim() !== "";
  let people: Contact[];
  const sections: HTMLElement[] = [];
  if (!typed) {
    people = [];
    const today = new Date();
    const groups = duplicates();
    if (groups.length) {
      // As Google Contacts' "Merge & fix": a line to review them.
      const notice = el("button", "duplicates-notice");
      notice.type = "button";
      notice.textContent = groups.length === 1 ? "1 possible duplicate · Review…" : `${groups.length} possible duplicates · Review…`;
      notice.addEventListener("click", () => reviewDuplicates(groups));
      sections.push(notice);
    }
    const recent = recentContacts(all, log);
    if (recent.length) {
      const latest = latestByContact(log);
      sections.push(heading("Recent"));
      for (const c of recent) sections.push(row(c, describeLatest(latest.get(c.id)!, today)));
      people.push(...recent);
    }
    const birthdays = upcomingBirthdays(all, today, BIRTHDAY_DAYS);
    if (birthdays.length) {
      sections.push(heading("Birthdays"));
      for (const c of birthdays) {
        const age = turning(c.birthday!, today);
        sections.push(row(c, `${whenBirthday(c.birthday!, today)}${age ? `, turning ${age}` : ""} 🎂`));
      }
      people.push(...birthdays);
    }
    const favorites = all.filter((c) => c.starred);
    if (favorites.length) {
      sections.push(heading("Favorites"));
      for (const c of favorites) sections.push(row(c));
      people.push(...favorites);
    }
    let letter = "";
    for (const c of all) {
      const first = indexLetter(c);
      if (first !== letter) {
        letter = first;
        sections.push(heading(letter));
      }
      sections.push(row(c));
      people.push(c);
    }
    if (all.length === 0) sections.push(el("p", "empty", "No contacts yet. Type someone’s name and details above to add them."));
  } else {
    people =
      intent.kind === "search" || intent.kind === "action" || intent.kind === "log"
        ? intent.matches
        : intent.kind === "update"
          ? [intent.contact]
          : [];
    for (const c of people) sections.push(row(c));
  }
  listed = people;
  listBox.replaceChildren(...sections);
  listBox.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
}

function heading(text: string): HTMLElement {
  const node = el("h3", "list-heading", text);
  node.setAttribute("role", "presentation");
  return node;
}

function row(contact: Contact, note?: string): HTMLElement {
  const button = el("button", "contact-row");
  button.type = "button";
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(contact.id === selectedId));
  const text = el("span", "contact-row-text");
  text.append(el("span", "contact-row-name", displayName(contact)));
  const second = note ?? (workLine(contact) || contact.emails[0]?.value || contact.phones[0]?.value || "");
  if (second && second !== displayName(contact)) text.append(el("span", "contact-row-detail", second));
  button.append(avatar(contact, "small"), text);
  if (contact.starred && !note) button.append(el("span", "contact-row-star", "★"));
  button.addEventListener("click", () => select(contact, true));
  return button;
}

function select(contact: Contact, openCard: boolean): void {
  selectedId = contact.id;
  for (const r of listBox.querySelectorAll<HTMLElement>(".contact-row")) r.setAttribute("aria-selected", "false");
  const index = listed.findIndex((c) => c.id === contact.id);
  const rows = listBox.querySelectorAll<HTMLElement>(".contact-row");
  rows[index]?.setAttribute("aria-selected", "true");
  rows[index]?.scrollIntoView({ block: "nearest" });
  drawCard();
  if (openCard) body.classList.add("card-open");
}

/** The contact on the card now, as JSON, to skip drawing it again. */
let shownCard = "";

function drawCard(): void {
  const contact = selected();
  if (!contact) {
    shownCard = "";
    cardBox.replaceChildren(el("p", "empty card-placeholder", list?.contacts.length ? "Choose someone to see their card." : ""));
    body.classList.remove("card-open");
    return;
  }
  // Unchanged (typing more of the same name): leave it, and its events, be.
  const history = historyOf(contact, log);
  const json = JSON.stringify([contact, history]);
  if (json === shownCard) return;
  const scroll = cardBox.dataset.shown === contact.id ? cardBox.scrollTop : 0;
  cardBox.replaceChildren(renderCard(contact, cardActions, list?.accounts.length ?? 1, history));
  cardBox.dataset.shown = contact.id;
  cardBox.scrollTop = scroll;
  shownCard = json;
}

// ---------- Doing things ----------

/** The phone numbers, emails or addresses an action could use. */
function targets(action: Action, contact: Contact): Labeled[] {
  switch (action) {
    case "call":
      return contact.phones;
    case "message":
      return contact.phones.length || !isMac() ? contact.phones : contact.emails;
    case "email":
      return contact.emails;
    case "facetime":
      return [...contact.phones, ...contact.emails];
    case "map":
      return contact.addresses;
    default:
      return [];
  }
}

/** Runs `run` with the one value, or with the one chosen from a menu at `anchor`. */
function choose(values: Labeled[], anchor: HTMLElement, run: (value: Labeled) => void): void {
  if (values.length === 1) return run(values[0]);
  const rect = anchor.getBoundingClientRect();
  showMenu(
    rect.left,
    rect.bottom + 4,
    values.map((v) => [`${labelText(v.label, "Other")}: ${v.value}`, () => run(v)]),
  );
}

/** Messages, calls, emails… someone, or starts a meeting or note with them. */
function act(action: Action, contact: Contact, anchor: HTMLElement, rest = ""): void {
  if (action === "event") {
    openNew(
      ({ start, allDay }) => {
        announceChange();
        const when = start?.toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          ...(allDay ? {} : { hour: "numeric", minute: "2-digit" }),
        });
        record(contact, "meeting", when ? `for ${when}` : null);
      },
      "event",
      null,
      `${eventSentence(contact, rest, new Date())} `,
    );
    return;
  }
  if (action === "note") {
    if (rest) {
      void addNote(contact, rest).catch((e) => {
        banner.replaceChildren(el("p", "error", `Couldn't save the note: ${errorMessage(e)}`));
        void load();
      });
    }
    else focusNote();
    return;
  }
  choose(targets(action, contact), anchor, (v) => {
    const subject = rest ? `?subject=${encodeURIComponent(rest)}` : "";
    const urls: Record<Exclude<Action, "event" | "note">, string> = {
      call: `tel:${dialable(v.value)}`,
      message: `sms:${v.value.includes("@") ? v.value : dialable(v.value)}`,
      email: `mailto:${v.value}${subject}`,
      facetime: `facetime:${v.value.includes("@") ? v.value : dialable(v.value)}`,
      map: mapLink(v.value),
    };
    void openUrl(urls[action]);
    if (action !== "map") record(contact, action, action === "email" ? rest || null : null);
  });
}

/** Logs something done with someone, and shows it in Recent and their History. */
function record(contact: Contact, kind: InteractionKind, detail: string | null = null): void {
  void logInteraction(contact.id, kind, detail)
    .then((entry) => {
      log = [...log, entry];
      drawList();
      drawCard();
    })
    .catch((e) => banner.replaceChildren(el("p", "error", `Couldn't log it: ${errorMessage(e)}`)));
}

function focusNote(): void {
  body.classList.add("card-open");
  cardBox.querySelector<HTMLInputElement>(".card-note-input")?.focus();
}

/** Enter (or a click on the hint): does what the hint says. */
async function perform(anchor: HTMLElement): Promise<void> {
  const current = intent;
  switch (current.kind) {
    case "empty":
      return;
    case "search": {
      const first = current.matches[0];
      if (first) select(first, true);
      else if (current.add) await add(current.add);
      return;
    }
    case "action": {
      if (!current.contact || missingFor(current.action, current.contact)) return;
      if (current.action === "note" && !current.rest) return;
      select(current.contact, false);
      act(current.action, current.contact, anchor, current.rest);
      if (current.action !== "event") clearBox();
      return;
    }
    case "log":
      if (!current.contact) return;
      select(current.contact, false);
      record(current.contact, current.logKind, current.rest || null);
      clearBox();
      return;
    case "add":
      await add(current.details);
      return;
    case "update":
      await addDetails(current.contact, current.details);
      return;
  }
}

function clearBox(): void {
  input.value = "";
  update();
}

/** Adds a new contact straight away, then shows their card (Edit is there). */
async function add(details: ParsedContact): Promise<void> {
  const [account] = usableAccounts();
  if (!account) {
    banner.replaceChildren(el("p", "warning", "Allow Minuteman to use your contacts first (see above)."));
    return;
  }
  input.disabled = true;
  try {
    const contact = await createContact(account, draftFrom(details));
    saved(contact);
    record(contact, "added");
    input.value = "";
  } catch (e) {
    banner.replaceChildren(el("p", "error", `Couldn't add them: ${errorMessage(e)}`));
  } finally {
    input.disabled = false;
    input.focus();
    update();
  }
}

function draftFrom(details: ParsedContact): ContactDraft {
  const { givenName, familyName, nickname, organization, jobTitle, emails, phones, addresses, urls, birthday, notes } = details;
  return {
    givenName,
    familyName,
    ...(nickname ? { nickname } : {}),
    ...(organization || jobTitle ? { organization: organization ?? "", jobTitle: jobTitle ?? "" } : {}),
    emails,
    phones,
    addresses,
    urls,
    birthdays: birthday ? [birthday] : [],
    ...(notes ? { notes: datedNote(notes) } : {}),
  };
}

/** Adds what's new in `details` to someone you have. */
async function addDetails(contact: Contact, details: ParsedContact): Promise<void> {
  const draft: ContactDraft = {};
  const merge = (kind: "phones" | "emails" | "addresses" | "urls", type: "phone" | "email" | "other") => {
    const extra = newValues(details[kind], contact[kind], type);
    if (extra.length) draft[kind] = [...contact[kind], ...extra];
  };
  merge("phones", "phone");
  merge("emails", "email");
  merge("addresses", "other");
  merge("urls", "other");
  if (details.organization && details.organization !== contact.organization) {
    draft.organization = details.organization;
    draft.jobTitle = details.jobTitle ?? contact.jobTitle ?? "";
  }
  if (details.birthday && !contact.birthday) draft.birthdays = [details.birthday];
  if (details.notes) draft.notes = withNote(contact.notes, details.notes);
  if (Object.keys(draft).length === 0) return;
  input.disabled = true;
  try {
    saved(await updateContact(contactRef(contact), draft));
    if (details.notes) record(contact, "note", details.notes);
    input.value = "";
  } catch (e) {
    banner.replaceChildren(el("p", "error", `Couldn't update ${displayName(contact)}: ${errorMessage(e)}`));
    void load(); // changed elsewhere meanwhile, perhaps: fetch the latest to try again
  } finally {
    input.disabled = false;
    input.focus();
    update();
  }
}

/** "Oct 30, 2026: met for coffee". */
const datedNote = (text: string) =>
  `${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}: ${text}`;

const withNote = (notes: string | null, text: string) => [notes?.trim(), datedNote(text)].filter(Boolean).join("\n");

async function addNote(contact: Contact, text: string): Promise<void> {
  saved(await updateContact(contactRef(contact), { notes: withNote(contact.notes, text) }));
  record(contact, "note", text);
}

/** Puts a just-saved contact in the list (Google can take a moment to list it) and shows them. */
function saved(contact: Contact, warning?: string): void {
  if (warning) banner.replaceChildren(el("p", "warning", warning));
  if (!list) return;
  const others = list.contacts.filter((c) => c.id !== contact.id);
  list = { ...list, contacts: [...others, contact].sort(byName) };
  selectedId = contact.id;
  save(ACCOUNT_STORAGE_KEY, contact.account);
  update();
}

const byName = (a: Contact, b: Contact) =>
  Number(!a.name) - Number(!b.name) || displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" });

const cardActions: CardActions = {
  perform: (action, contact, anchor) => act(action, contact, anchor),
  edit: (contact) => openContactForm(contact, null, usableAccounts(), saved, contacts().map(displayName)),
  async remove(contact) {
    const answer = await ask(`Delete ${displayName(contact)}?`, `They're deleted from ${contact.account}'s Google Contacts too.`, [
      ["delete", "Delete contact", true],
    ]);
    if (answer !== "delete" || !list) return;
    try {
      await deleteContact(contactRef(contact));
      list = { ...list, contacts: list.contacts.filter((c) => c.id !== contact.id) };
      log = log.filter((e) => e.contactId !== contact.id);
      selectedId = null;
      body.classList.remove("card-open");
      update();
    } catch (e) {
      banner.replaceChildren(el("p", "error", `Couldn't delete them: ${errorMessage(e)}`));
    }
  },
  async star(contact) {
    try {
      saved(await setContactStarred(contactRef(contact), !contact.starred));
    } catch (e) {
      banner.replaceChildren(el("p", "error", `Couldn't change Favorites: ${errorMessage(e)}`));
    }
  },
  addNote,
  openEvent: (item) => showEvent(item),
  showDay: (day) => openCalendar(day),
  logManually: (contact, anchor) => {
    const rect = anchor.getBoundingClientRect();
    const kinds: [string, InteractionKind][] = [
      ["Called", "call"],
      ["Messaged", "message"],
      ["Emailed", "email"],
      ["Met in person", "met"],
    ];
    showMenu(rect.left, rect.bottom + 4, kinds.map(([label, kind]) => [label, () => record(contact, kind)]));
  },
  back: () => {
    body.classList.remove("card-open");
    input.focus();
  },
  showPerson(name) {
    const wanted = name.trim().toLowerCase();
    const match = contacts().find((c) => displayName(c).toLowerCase() === wanted);
    if (match) return select(match, true);
    // Not in Contacts by that name: find them as typed.
    input.value = name;
    body.classList.remove("card-open");
    update();
    input.focus();
  },
  share: (contact, anchor) => shareMenu(contact, anchor),
  duplicatesOf: (contact) => groupOf(contact)?.filter((c) => c.id !== contact.id) ?? [],
  reviewDuplicates(contact) {
    const group = groupOf(contact);
    if (group) reviewDuplicates([group]);
  },
};

// ---------- Sharing ----------

/** Share…: the share sheet (phones), copy as text, or save the contact card (.vcf). */
function shareMenu(contact: Contact, anchor: HTMLElement): void {
  const name = displayName(contact);
  const vcard = toVCard(contact);
  const file = new File([vcard], `${name.replace(/[/\\:*?"<>|]+/g, " ").trim() || "Contact"}.vcf`, { type: "text/vcard" });
  const done = (text: string, kind = "notice") => {
    const line = el("p", kind, text);
    banner.replaceChildren(line);
    // A note that it worked goes after a moment; an error stays.
    if (kind === "notice") window.setTimeout(() => line.remove(), 5000);
  };
  const items: [string, () => void][] = [];
  if (navigator.canShare?.({ files: [file] })) {
    items.push([
      "Share…",
      () =>
        void navigator.share({ files: [file], title: name }).catch((e: unknown) => {
          if ((e as Error).name !== "AbortError") done(`Couldn't share: ${errorMessage(e)}`, "error");
        }),
    ]);
  }
  items.push([
    "Copy as text",
    () =>
      void navigator.clipboard.writeText(cardText(contact)).then(
        () => done(`Copied ${name}'s details.`),
        (e: unknown) => done(`Couldn't copy: ${errorMessage(e)}`, "error"),
      ),
  ]);
  if (isTauri()) {
    items.push([
      "Save contact card",
      () =>
        void saveContactCard(name, vcard).then(
          (path) => done(`Saved ${path}`),
          (e: unknown) => done(`Couldn't save it: ${errorMessage(e)}`, "error"),
        ),
    ]);
  } else {
    items.push([
      "Download contact card (.vcf)",
      () => {
        const link = el("a");
        link.href = URL.createObjectURL(file);
        link.download = file.name;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      },
    ]);
  }
  const rect = anchor.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4, items);
}

// ---------- Duplicates ----------

/** "2 phones · 3 emails · birthday · photo": what someone has, in short. */
function holdings(contact: Contact): string {
  const count = (n: number, one: string) => (n ? `${n} ${one}${n === 1 ? "" : "s"}` : "");
  return [
    count(contact.phones.length, "phone"),
    count(contact.emails.length, "email"),
    count(contact.addresses.length, "address"),
    contact.birthday ? "birthday" : "",
    contact.notes ? "notes" : "",
    contact.photo ? "photo" : "",
  ]
    .filter(Boolean)
    .join(" · ")
    .replace("addresss", "addresses");
}

/**
 * The review of possible duplicates, as Google Contacts' "Merge & fix" and
 * Cardhop do: each group, what merging makes of it, and Merge or Not the
 * same person.
 */
function reviewDuplicates(groups: Contact[][]): void {
  const dialog = el("dialog", "dialog duplicates-dialog");
  dialog.setAttribute("aria-labelledby", "duplicates-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  const title = el("h2", undefined, groups.length === 1 ? "Possible duplicate" : "Possible duplicates");
  title.id = "duplicates-title";
  const intro = el(
    "p",
    "form-notes",
    "These look like the same person, listed more than once in one account (the same email, phone number or name). Merge keeps one contact with everything from all of them, and deletes the others from Google Contacts.",
  );
  const box = el("div", "duplicate-groups");
  for (const group of groups) box.append(duplicateGroup(group, dialog));
  const close = el("button", "primary-button", "Done");
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  const buttons = el("div", "dialog-buttons");
  buttons.append(close);
  dialog.append(title, intro, box, buttons);
  dialog.showModal();
  close.focus();
}

function duplicateGroup(group: Contact[], dialog: HTMLDialogElement): HTMLElement {
  const section = el("section", "duplicate-group");
  const keep = bestToKeep(group);
  const others = group.filter((c) => c !== keep);
  const merge = mergeOf(keep, others);
  for (const contact of group) {
    const line = el("div", "duplicate-person");
    const text = el("span", "contact-row-text");
    text.append(el("span", "contact-row-name", displayName(contact)));
    const detail = [contact.emails[0]?.value, contact.phones[0]?.value, holdings(contact)].filter(Boolean).join(" · ");
    if (detail) text.append(el("span", "contact-row-detail", detail));
    line.append(avatar(contact, "small"), text);
    section.append(line);
  }
  const accounts = new Set((list?.accounts ?? []).map((a) => a.email));
  const where = accounts.size > 1 ? ` in ${keep.account}` : "";
  section.append(el("p", "duplicate-result", `Merged: ${displayName(merge.result)}${where} · ${holdings(merge.result) || "no details"}`));
  const error = el("p", "error");
  const separate = el("button", "text-button", "Not the same person");
  separate.type = "button";
  separate.addEventListener("click", () => {
    const kept = notDuplicates();
    kept.add(groupKey(group));
    save(NOT_DUPLICATES_KEY, JSON.stringify([...kept]));
    duplicatesOfList = undefined;
    section.replaceChildren(el("p", "duplicate-result", "Kept apart."));
    update();
  });
  const mergeButton = el("button", "primary-button", "Merge");
  mergeButton.type = "button";
  mergeButton.addEventListener("click", async () => {
    mergeButton.disabled = separate.disabled = true;
    error.textContent = "";
    try {
      const result = await mergeContacts(contactRef(keep), others.map(contactRef), merge.draft, merge.photo, merge.starred);
      const gone = new Set(others.map((c) => c.id));
      log = log.map((e) => (gone.has(e.contactId) ? { ...e, contactId: result.id } : e));
      if (list) list = { ...list, contacts: list.contacts.filter((c) => !gone.has(c.id)) };
      saved(result);
      section.replaceChildren(el("p", "duplicate-result", `Merged into ${displayName(result)}.`));
      if (!dialog.querySelector(".duplicate-group button")) dialog.querySelector<HTMLButtonElement>(".primary-button")?.focus();
    } catch (e) {
      error.textContent = `Couldn't merge them: ${errorMessage(e)}`;
      mergeButton.disabled = separate.disabled = false;
    }
  });
  const buttons = el("div", "duplicate-buttons");
  buttons.append(separate, mergeButton);
  section.append(error, buttons);
  return section;
}

/** An event with someone: its details, editable as in the calendar. */
function showEvent(item: AgendaItem): void {
  const changed = () => {
    announceChange();
    shownCard = ""; // its events changed
    drawCard();
  };
  openDetails(item, {
    toggleTask: () => {},
    edit: (it) => openEdit(it, changed),
    duplicate: (it) => openDuplicate(it, changed),
    deleted: changed,
    changed,
  });
}

// ---------- Setting up ----------

function setUp(): void {
  document.querySelector("#calendar")!.addEventListener("click", () => openCalendar());
  document.querySelector("#refresh")!.addEventListener("click", () => void load());
  document.querySelector("#new-contact")!.addEventListener("click", newContact);
  document.querySelector("#settings")!.addEventListener("click", showSettings);
  // Phones: the floating buttons at the bottom, as in the calendar, and a
  // shorter hint in the box, which is narrower there.
  const placeholder = () => {
    input.placeholder = phone.matches ? "Search, add, or “call Sam”" : "Search, add “Jane Doe jane@example.com”, or “call Sam”";
  };
  phone.addEventListener("change", placeholder);
  placeholder();
  setUpDockMenu(document.querySelector("#menu-button")!, document.querySelector("#menu")!, (line) => [
    line("Refresh", () => void load()),
    line("Find duplicates…", () => (duplicates().length ? reviewDuplicates(duplicates()) : banner.replaceChildren(el("p", "notice", "No duplicates found.")))),
    el("hr", "menu-line"),
    line("Settings…", showSettings),
  ]);
  document.querySelector("#dock-calendar")!.addEventListener("click", () => openCalendar());
  document.querySelector("#dock-search")!.addEventListener("click", () => {
    body.classList.remove("card-open"); // back to the list, where the results are
    input.focus();
    input.select();
  });
  document.querySelector("#dock-new")!.addEventListener("click", newContact);
  keepBoxAboveKeyboard();
  if (!isTauri() || /iPhone|iPad|Android/.test(navigator.userAgent)) {
    document.querySelector<HTMLElement>("#calendar")!.title = "Back to the calendar";
  }

  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void perform(input);
    } else if (e.key === "Escape" && input.value) {
      e.preventDefault();
      clearBox();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && listed.length) {
      e.preventDefault();
      const at = listed.findIndex((c) => c.id === selectedId);
      const next = e.key === "ArrowDown" ? Math.min(at + 1, listed.length - 1) : Math.max(at - 1, 0);
      select(listed[next], false);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]")) return;
    const command = e.metaKey || e.ctrlKey;
    if (command && !e.altKey && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "k")) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (command && !e.altKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      newContact();
    } else if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      input.focus();
    } else if (e.key === "," && (command || !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement))) {
      e.preventDefault();
      showSettings();
    }
  });

  // Fetch again on coming back to the window, if it's been a while.
  const sync = () => {
    if (!document.hidden && list && Date.now() - lastSync > SYNC_EVERY_MS / 5 && !document.querySelector("dialog[open]")) {
      void load();
    }
  };
  window.addEventListener("focus", sync);
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("online", sync);
  window.setInterval(() => {
    if (!document.hidden && list && !document.querySelector("dialog[open]")) void load();
  }, SYNC_EVERY_MS);
}

/**
 * The calendar's Settings, here too. Changes that affect the calendar are
 * announced, so its window redraws.
 */
function showSettings(): void {
  openSettings({
    accountsChanged: (signedIn) => {
      announceChange();
      if (!signedIn) return showSignedOut();
      list = undefined;
      void load();
    },
    todoistChanged: announceChange,
    daysChanged: announceChange,
    sourcesChanged: announceChange,
    weatherChanged: announceChange,
  });
}

/**
 * Phones: the box floats above the buttons at the bottom, which the
 * keyboard covers. While it's open, the box sits just above the keyboard
 * instead (and the buttons hide). The keyboard's height is what the
 * visible part of the page lost at its bottom.
 */
function keepBoxAboveKeyboard(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const place = () => {
    const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    body.style.setProperty("--keyboard", `${covered}px`);
    body.classList.toggle("keyboard-open", covered > 80);
  };
  viewport.addEventListener("resize", place);
  viewport.addEventListener("scroll", place);
  // iOS can leave the never-scrolling page scrolled after the keyboard goes
  // (see keepPageInPlace in main.ts): put it back.
  input.addEventListener("blur", () => window.setTimeout(() => window.scrollTo(0, 0), 100));
}

/** "+": the New contact form, filled in from the box if it reads as someone new. */
function newContact(): void {
  if (!list) return;
  const start = intent.kind === "add" ? intent.details : intent.kind === "search" ? intent.add : null;
  openContactForm(
    null,
    start,
    usableAccounts(),
    (contact, warning) => {
      input.value = "";
      saved(contact, warning);
      record(contact, "added");
    },
    contacts().map(displayName),
  );
}

/** Shows `query` in the box (from the calendar: a guest's address, say). */
function showQuery(query: string | null | undefined): void {
  if (query) {
    input.value = query;
    selectedId = null;
  }
  update();
  if (query && intent.kind === "search" && intent.matches[0]) select(intent.matches[0], true);
  // Phones: not until you tap it (or Search), or the keyboard would cover the list.
  if (phone.matches) return;
  input.focus();
  if (!query) input.select();
}

async function start(): Promise<void> {
  await boot();
  setUp();
  const query = window.__MINUTEMAN_CONTACTS_QUERY__ ?? new URLSearchParams(location.search).get("q");
  if (isTauri()) {
    // Opened again (⌥⌘K, the menu, a guest's name): to the box, with the query if any.
    void listen<string | null>("contacts-shown", (event) => showQuery(event.payload));
  }
  try {
    if (!(await authStatus())) return showSignedOut();
  } catch (e) {
    listBox.replaceChildren(el("p", "error", errorMessage(e)));
    return;
  }
  listBox.replaceChildren(el("p", "empty", "Loading…"));
  await load();
  showQuery(query);
}

void start();
