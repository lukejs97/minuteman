// Your history with people: Recents (as Cardhop's: what you did with whom,
// latest first, an edit included), and each card's History, from what's
// logged (src-tauri/src/interactions.rs) and your past events with them.
// Removing someone from Recents logs "hidden": their earlier entries leave
// Recents but stay in their History.
import type { Contact, ContactDraft, Interaction, InteractionKind } from "../api";

/** How each kind of interaction reads in a card's History and the Recent list. */
export const KIND_WORDS: Record<InteractionKind, string> = {
  call: "Called",
  message: "Messaged",
  email: "Emailed",
  facetime: "FaceTimed",
  meeting: "Set up a meeting",
  met: "Met",
  note: "Note",
  added: "Added to Contacts",
  edited: "Edited",
  hidden: "Removed from Recents",
};

/** How many people the Recent list shows. */
export const RECENT_COUNT = 6;

/**
 * What Recents shows: everything logged, but not "hidden" markers, nor
 * anyone's entries from before they were last removed from Recents.
 */
export function recentEntries(log: Interaction[]): Interaction[] {
  const removed = new Map<string, number>();
  for (const entry of log) {
    if (entry.kind === "hidden") removed.set(entry.contactId, Math.max(removed.get(entry.contactId) ?? 0, time(entry.at)));
  }
  return log.filter((entry) => entry.kind !== "hidden" && time(entry.at) > (removed.get(entry.contactId) ?? -Infinity));
}

/** Each contact's latest interaction in Recents, by contact ID. */
export function latestByContact(log: Interaction[]): Map<string, Interaction> {
  const latest = new Map<string, Interaction>();
  for (const entry of recentEntries(log)) {
    const seen = latest.get(entry.contactId);
    if (!seen || entry.at >= seen.at) latest.set(entry.contactId, entry);
  }
  return latest;
}

/** The people you've been in touch with most recently, latest first. */
export function recentContacts(contacts: Contact[], log: Interaction[], count = RECENT_COUNT): Contact[] {
  const latest = latestByContact(log);
  return contacts
    .filter((c) => latest.has(c.id))
    .sort((a, b) => time(latest.get(b.id)!.at) - time(latest.get(a.id)!.at))
    .slice(0, count);
}

/** Someone's interactions, latest first (their History: removing them from Recents doesn't change it). */
export function historyOf(contact: Contact, log: Interaction[]): Interaction[] {
  return log.filter((e) => e.contactId === contact.id && e.kind !== "hidden").sort((a, b) => time(b.at) - time(a.at));
}

/** Recents, as Cardhop's: each thing done with someone, latest first, by day. */
export function recentsByDay(contacts: Contact[], log: Interaction[], now: Date, limit = 200): { day: string; entries: Interaction[] }[] {
  const here = new Set(contacts.map((c) => c.id));
  const entries = recentEntries(log)
    .filter((e) => here.has(e.contactId))
    .sort((a, b) => time(b.at) - time(a.at))
    .slice(0, limit);
  const days: { day: string; entries: Interaction[] }[] = [];
  for (const entry of entries) {
    const day = dayName(new Date(entry.at), now);
    if (days.at(-1)?.day === day) days.at(-1)!.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  return days;
}

/** "Today", "Yesterday", "Monday" (this week), "Oct 12", "Oct 12, 2025". */
function dayName(when: Date, now: Date): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(when)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return when.toLocaleDateString(undefined, { weekday: "long" });
  return when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(when.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** What an edit changed, in words: "name, address, photo". */
export function changedWords(draft: ContactDraft, photo = false): string[] {
  const words: string[] = [];
  const has = (key: keyof ContactDraft) => draft[key] !== undefined;
  if (has("givenName") || has("familyName")) words.push("name");
  if (has("nickname")) words.push("nickname");
  if (has("organization") || has("jobTitle")) words.push("work");
  if (has("phones")) words.push("phone");
  if (has("emails")) words.push("email");
  if (has("addresses")) words.push("address");
  if (has("urls")) words.push("website");
  if (has("birthdays")) words.push("birthday");
  if (has("relations")) words.push("related people");
  if (has("notes")) words.push("notes");
  if (photo) words.push("photo");
  return words;
}

const time = (iso: string) => new Date(iso).getTime();

/** "Just now", "5 min ago", "3 hr ago", "Yesterday", "4 days ago", "Oct 12", "Oct 12, 2025". */
export function relativeTime(when: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - when.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (when >= midnight) return `${Math.round(minutes / 60)} hr ago`;
  const days = Math.ceil((midnight.getTime() - when.getTime()) / 86_400_000);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(when.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** "Called", "Edited: name, address", "Note: likes jazz": one entry, as Recents shows it. */
export function describeEntry(entry: Interaction): string {
  const words = KIND_WORDS[entry.kind];
  if (!entry.detail) return words;
  return entry.kind === "email" ? `${words} about “${entry.detail}”` : `${words}: ${entry.detail}`;
}

/** "Called · 2 days ago", for the Recent list. */
export function describeLatest(entry: Interaction, now: Date): string {
  return `${describeEntry(entry)} · ${relativeTime(new Date(entry.at), now)}`;
}
