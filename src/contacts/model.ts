// Helpers for contacts: names, initials, finding people by what you type,
// labels in words, and birthdays. No page code here, so the sentence reader
// (parse.ts) can use it too.
import type { Birthday, Contact, ContactDraft, Labeled } from "../api";

/** What to call someone: their name, else their company, email or phone. */
export function displayName(contact: Contact): string {
  return (
    contact.name ||
    [contact.givenName, contact.familyName].filter(Boolean).join(" ") ||
    contact.organization ||
    contact.emails[0]?.value ||
    contact.phones[0]?.value ||
    "No name"
  );
}

/** Up to two letters for the round picture of someone without a photo. */
export function initials(contact: Contact): string {
  const words = displayName(contact)
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
  return letters.map((w) => [...w][0]).join("").toUpperCase() || "?";
}

/** "Designer at Acme", "Acme", "Designer", or "". */
export function workLine(contact: Contact): string {
  const { jobTitle, organization } = contact;
  if (jobTitle && organization) return `${jobTitle} at ${organization}`;
  return jobTitle ?? organization ?? "";
}

/** The letter a contact is listed under: A–Z, or # for anything else. */
export function indexLetter(contact: Contact): string {
  const first = displayName(contact)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")[0]
    ?.toUpperCase();
  return first && /[A-Z]/.test(first) ? first : "#";
}

const LABELS: Record<string, string> = {
  home: "Home",
  work: "Work",
  other: "Other",
  mobile: "Mobile",
  main: "Main",
  homeFax: "Home fax",
  workFax: "Work fax",
  otherFax: "Fax",
  pager: "Pager",
  workMobile: "Work mobile",
  workPager: "Work pager",
  googleVoice: "Google Voice",
  homePage: "Home page",
  blog: "Blog",
  profile: "Profile",
  appInstallPage: "App",
  ftp: "FTP",
  reservations: "Reservations",
  // How people are related (Google's types).
  spouse: "Spouse",
  partner: "Partner",
  domesticPartner: "Domestic partner",
  child: "Child",
  mother: "Mother",
  father: "Father",
  parent: "Parent",
  brother: "Brother",
  sister: "Sister",
  friend: "Friend",
  relative: "Relative",
  manager: "Manager",
  assistant: "Assistant",
  referredBy: "Referred by",
};

/** A label in words: "Mobile", "Work", or your own as you wrote it. */
export function labelText(label: string | null, fallback: string): string {
  if (!label) return fallback;
  return LABELS[label] ?? label;
}

/** Digits (and a leading +) only, for tel: and sms: links. */
export const dialable = (phone: string) => phone.replace(/(?!^\+)[^\d]/g, "");

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** The words a contact can be found by. */
function nameWords(contact: Contact): string[] {
  const names = [contact.name, contact.givenName, contact.familyName, contact.nickname].filter(Boolean).join(" ");
  return fold(names).split(/[\s.,'’-]+/).filter(Boolean);
}

/**
 * How well `query` matches a contact: 0 for not at all. Every word typed has
 * to start a word of their name, nickname, company or job, or be part of an
 * email address; digits can match part of a phone number.
 */
export function matchScore(contact: Contact, query: string): number {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const names = nameWords(contact);
  const full = fold(displayName(contact));
  const q = words.join(" ");
  if (full === q) return 100;

  const others = fold([contact.organization, contact.jobTitle].filter(Boolean).join(" ")).split(/\s+/);
  const emails = contact.emails.map((e) => fold(e.value));
  const phones = contact.phones.map((p) => dialable(p.value));
  let score = 0;
  let onlyNames = true;
  for (const word of words) {
    if (names.some((n) => n.startsWith(word))) continue;
    onlyNames = false;
    const digits = word.replace(/\D/g, "");
    if (others.some((o) => o.startsWith(word))) continue;
    if (emails.some((e) => e.includes(word))) continue;
    if (digits.length >= 3 && digits.length === word.replace(/[\s()+.-]/g, "").length && phones.some((p) => p.includes(digits))) {
      continue;
    }
    return 0;
  }
  if (onlyNames) score = full.startsWith(q) ? 80 : 60;
  else score = 30;
  return score + (contact.starred ? 5 : 0);
}

/** The contacts matching `query`, best first (A–Z among equals). */
export function search(contacts: Contact[], query: string): Contact[] {
  const scored = contacts.map((contact) => ({ contact, score: matchScore(contact, query) })).filter((s) => s.score > 0);
  return scored.sort((a, b) => b.score - a.score).map((s) => s.contact);
}

// ---------- Birthdays ----------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** A month's number (1–12) from its name or first three letters; 0 if it isn't one. */
export function monthNumber(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  return w.length < 3 ? 0 : MONTHS.findIndex((m) => m.startsWith(w)) + 1;
}

/** "March 4, 1990" or "March 4" (in your language's order). */
export function describeBirthday(birthday: Birthday): string {
  const date = new Date(birthday.year ?? 2000, birthday.month - 1, birthday.day);
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(birthday.year ? { year: "numeric" } : {}),
  });
}

/** The next birthday on or after `today` (Feb 29 falls on Mar 1 in other years). */
export function nextBirthday(birthday: Birthday, today: Date): Date {
  const on = (year: number) => new Date(year, birthday.month - 1, birthday.day);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const thisYear = on(start.getFullYear());
  return thisYear >= start ? thisYear : on(start.getFullYear() + 1);
}

/** Days until the next birthday: 0 today, 1 tomorrow… */
export function daysUntilBirthday(birthday: Birthday, today: Date): number {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((nextBirthday(birthday, today).getTime() - start.getTime()) / 86_400_000);
}

/** How old they'll be on their next birthday, if the year is known. */
export function turning(birthday: Birthday, today: Date): number | null {
  return birthday.year ? nextBirthday(birthday, today).getFullYear() - birthday.year : null;
}

/** How old they are now, if the year is known. */
export function age(birthday: Birthday, today: Date): number | null {
  if (!birthday.year) return null;
  const hadBirthday =
    today.getMonth() + 1 > birthday.month || (today.getMonth() + 1 === birthday.month && today.getDate() >= birthday.day);
  const years = today.getFullYear() - birthday.year - (hadBirthday ? 0 : 1);
  return years >= 0 ? years : null;
}

/** "Today", "Tomorrow", "In 5 days", "Mon, Nov 3". */
export function whenBirthday(birthday: Birthday, today: Date): string {
  const days = daysUntilBirthday(birthday, today);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 7) return nextBirthday(birthday, today).toLocaleDateString(undefined, { weekday: "long" });
  return nextBirthday(birthday, today).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** People whose birthday is within `days` of today, soonest first. */
export function upcomingBirthdays(contacts: Contact[], today: Date, days: number): Contact[] {
  return contacts
    .filter((c) => c.birthday && daysUntilBirthday(c.birthday, today) < days)
    .sort((a, b) => daysUntilBirthday(a.birthday!, today) - daysUntilBirthday(b.birthday!, today));
}

/** Labeled values that differ from `existing` (case-insensitive; phones by digits). */
export function newValues(values: Labeled[], existing: Labeled[], kind: "email" | "phone" | "other"): Labeled[] {
  const key = (v: string) => (kind === "phone" ? dialable(v) : v.trim().toLowerCase());
  const have = new Set(existing.map((e) => key(e.value)));
  return values.filter((v) => !have.has(key(v.value)));
}

// ---------- Duplicates ----------

/** The last ten digits of a phone number (enough to match +1 864… with (864)…), or "" if it's too short. */
const phoneKey = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : "";
};

/** A name worth matching on: two words or more ("Sam" alone is too common). */
const nameKey = (contact: Contact) => {
  const name = fold(contact.name || [contact.givenName, contact.familyName].filter(Boolean).join(" ")).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return name.includes(" ") ? name : "";
};

/** What a group of duplicates is known by, to remember it was "Not the same person". */
export const groupKey = (group: Contact[]) => group.map((c) => c.id).sort().join("|");

/**
 * People who look like the same person, listed twice in one account: the
 * same email, phone number or whole name. Groups dismissed as "not the same
 * person" (by `groupKey`) are left out. Each group in list order.
 */
export function findDuplicates(contacts: Contact[], dismissed: ReadonlySet<string> = new Set()): Contact[][] {
  const parent = contacts.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const seen = new Map<string, number>();
  contacts.forEach((contact, i) => {
    const keys = [
      ...contact.emails.map((e) => `e:${e.value.trim().toLowerCase()}`),
      ...contact.phones.map((p) => phoneKey(p.value)).filter(Boolean).map((k) => `p:${k}`),
      ...(nameKey(contact) ? [`n:${nameKey(contact)}`] : []),
    ];
    for (const key of new Set(keys)) {
      const scoped = `${contact.account}\n${key}`;
      const other = seen.get(scoped);
      if (other === undefined) seen.set(scoped, i);
      else parent[root(i)] = root(other);
    }
  });
  const groups = new Map<number, Contact[]>();
  contacts.forEach((contact, i) => {
    const r = root(i);
    groups.set(r, [...(groups.get(r) ?? []), contact]);
  });
  return [...groups.values()].filter((g) => g.length > 1 && !dismissed.has(groupKey(g)));
}

/** How much is known about someone: the one with the most is kept in a merge. */
function fullness(contact: Contact): number {
  const filled = [contact.name, contact.nickname, contact.organization, contact.jobTitle, contact.notes, contact.birthday, contact.photo];
  const lists = contact.emails.length + contact.phones.length + contact.addresses.length + contact.urls.length;
  return filled.filter(Boolean).length + lists + (contact.relations ?? []).length + (contact.starred ? 2 : 0);
}

/** The one to keep: the fullest (the first of equals). */
export const bestToKeep = (group: Contact[]) =>
  group.reduce((best, c) => (fullness(c) > fullness(best) ? c : best), group[0]);

/** `lists` together, each value once (emails by letters, phones by digits, the rest by text). */
function together(lists: Labeled[][], kind: "email" | "phone" | "other"): Labeled[] {
  const key = (v: string) => (kind === "phone" ? phoneKey(v) || dialable(v) : v.trim().toLowerCase().replace(/\s+/g, " "));
  const seen = new Set<string>();
  const all: Labeled[] = [];
  for (const value of lists.flat()) {
    const k = key(value.value);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    all.push(value);
  }
  return all;
}

export interface Merge {
  /** What changes on the one kept (only what's different). */
  draft: ContactDraft;
  /** Another's photo, when the one kept has none. */
  photo: string | null;
  /** In Favorites, if any of them was. */
  starred: boolean;
  /** Them all as one: what the kept contact will be. */
  result: Contact;
}

/** Everything of `keep`'s and `others`' together, as one contact: Google Contacts' Merge. */
export function mergeOf(keep: Contact, others: Contact[]): Merge {
  const all = [keep, ...others];
  const first = <T>(pick: (c: Contact) => T | null | undefined) => all.map(pick).find((v) => v) ?? null;
  const named = all.find((c) => c.givenName || c.familyName) ?? keep;
  const working = all.find((c) => c.organization || c.jobTitle) ?? keep;
  const notes = [...new Set(all.map((c) => c.notes?.trim()).filter((n): n is string => !!n))];
  const result: Contact = {
    ...keep,
    name: named.name || keep.name,
    givenName: named.givenName,
    familyName: named.familyName,
    nickname: first((c) => c.nickname),
    organization: working.organization,
    jobTitle: working.jobTitle,
    emails: together(all.map((c) => c.emails), "email"),
    phones: together(all.map((c) => c.phones), "phone"),
    addresses: together(all.map((c) => c.addresses), "other"),
    urls: together(all.map((c) => c.urls), "other"),
    relations: together(all.map((c) => c.relations ?? []), "other"),
    // One with a year beats one without.
    birthday: all.map((c) => c.birthday).find((b) => b?.year) ?? first((c) => c.birthday),
    notes: notes.join("\n") || null,
    photo: first((c) => c.photo),
    starred: all.some((c) => c.starred),
  };
  const draft: ContactDraft = {};
  if (named !== keep) {
    draft.givenName = result.givenName ?? "";
    draft.familyName = result.familyName ?? "";
  }
  if ((result.nickname ?? null) !== (keep.nickname ?? null)) draft.nickname = result.nickname ?? "";
  if (working !== keep) {
    draft.organization = result.organization ?? "";
    draft.jobTitle = result.jobTitle ?? "";
  }
  for (const kind of ["emails", "phones", "addresses", "urls", "relations"] as const) {
    if (result[kind].length !== (keep[kind] ?? []).length) draft[kind] = result[kind];
  }
  if (result.birthday !== keep.birthday && result.birthday) draft.birthdays = [result.birthday];
  if ((result.notes ?? null) !== (keep.notes ?? null)) draft.notes = result.notes ?? "";
  return { draft, photo: keep.photo ? null : result.photo, starred: result.starred, result };
}

// ---------- Sharing ----------

/** A vCard value: commas, semicolons, backslashes and new lines escaped. */
const vcardText = (s: string) => s.replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\r?\n/g, "\\n");

const VCARD_TYPES: Record<string, string> = {
  mobile: "CELL",
  work: "WORK",
  home: "HOME",
  main: "MAIN",
  workMobile: "WORK,CELL",
  homeFax: "HOME,FAX",
  workFax: "WORK,FAX",
  otherFax: "FAX",
  pager: "PAGER",
  other: "OTHER",
};

/**
 * Someone as a contact card (vCard 3.0), the kind Messages, Mail and
 * Contacts take: names, work, phones, emails, addresses, websites,
 * birthday, notes and the people they're related to.
 */
export function toVCard(contact: Contact): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];
  const put = (line: string) => lines.push(line);
  const type = (label: string | null, extra = "") => {
    const t = [extra, label ? (VCARD_TYPES[label] ?? "") : ""].filter(Boolean).join(",");
    return t ? `;TYPE=${t}` : "";
  };
  put(`N:${vcardText(contact.familyName ?? "")};${vcardText(contact.givenName ?? "")};;;`);
  put(`FN:${vcardText(displayName(contact))}`);
  if (contact.nickname) put(`NICKNAME:${vcardText(contact.nickname)}`);
  if (contact.organization) put(`ORG:${vcardText(contact.organization)}`);
  if (contact.jobTitle) put(`TITLE:${vcardText(contact.jobTitle)}`);
  for (const phone of contact.phones) put(`TEL${type(phone.label, "VOICE")}:${vcardText(phone.value)}`);
  for (const email of contact.emails) put(`EMAIL${type(email.label, "INTERNET")}:${vcardText(email.value)}`);
  for (const address of contact.addresses) put(`ADR${type(address.label)}:;;${vcardText(address.value)};;;;`);
  for (const url of contact.urls) put(`URL:${vcardText(url.value)}`);
  const b = contact.birthday;
  if (b) {
    const md = `${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`;
    // Apple's way of a birthday without a year.
    put(b.year ? `BDAY:${String(b.year).padStart(4, "0")}-${md}` : `BDAY;X-APPLE-OMIT-YEAR=1604:1604-${md}`);
  }
  (contact.relations ?? []).forEach((relation, i) => {
    put(`item${i + 1}.X-ABRELATEDNAMES:${vcardText(relation.value)}`);
    if (relation.label) put(`item${i + 1}.X-ABLabel:${vcardText(labelText(relation.label, relation.label))}`);
  });
  if (contact.notes) put(`NOTE:${vcardText(contact.notes)}`);
  put("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

/** Someone as plain text, to paste into a message: name, work, numbers, emails, addresses, birthday. */
export function cardText(contact: Contact): string {
  const lines = [displayName(contact)];
  const work = workLine(contact);
  if (work && work !== displayName(contact)) lines.push(work);
  for (const phone of contact.phones) lines.push(`${labelText(phone.label, "Phone")}: ${phone.value}`);
  for (const email of contact.emails) lines.push(`${labelText(email.label, "Email")}: ${email.value}`);
  for (const address of contact.addresses) lines.push(`${labelText(address.label, "Address")}: ${address.value.replace(/\s*\n\s*/g, ", ")}`);
  for (const url of contact.urls) lines.push(url.value);
  if (contact.birthday) lines.push(`Birthday: ${describeBirthday(contact.birthday)}`);
  return lines.join("\n");
}
