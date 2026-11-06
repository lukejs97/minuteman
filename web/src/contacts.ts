// Google People API v1: contacts. A port of src-tauri/src/google/contacts.rs
// and contacts.rs (without the saved copy: the site always fetches).
import type { Birthday, Contact, ContactDraft, ContactList, ContactRef, Labeled } from "../../src/api";
import type { Env } from "./env";
import { AppError, invalidInput } from "./errors";
import { accessToken, errorText, findAccount, google } from "./google";
import { readAccounts } from "./store";

const API = "https://people.googleapis.com/v1";

/** The parts of a contact the app shows and edits. */
const PERSON_FIELDS =
  "names,nicknames,emailAddresses,phoneNumbers,addresses,organizations,birthdays,biographies,urls,photos,memberships,metadata,relations";

/** The group Google Contacts calls "Favorites". */
const STARRED = "contactGroups/starred";

interface Field {
  value?: string;
  /** "home", "work", "mobile"… or a label of your own. */
  type?: string;
}

interface Person {
  resourceName?: string;
  etag?: string;
  metadata?: { deleted?: boolean };
  names?: { displayName?: string; givenName?: string; familyName?: string }[];
  nicknames?: { value?: string }[];
  emailAddresses?: Field[];
  phoneNumbers?: Field[];
  addresses?: { formattedValue?: string; type?: string }[];
  organizations?: { name?: string; title?: string }[];
  birthdays?: { date?: { year?: number; month?: number; day?: number } }[];
  biographies?: { value?: string }[];
  urls?: Field[];
  photos?: { url?: string; default?: boolean }[];
  memberships?: { contactGroupMembership?: { contactGroupResourceName?: string } }[];
  relations?: { person?: string; type?: string }[];
}

/** Every account's contacts, sorted by name. */
export async function allContacts(env: Env): Promise<ContactList> {
  const accounts = await readAccounts(env);
  const lists = await Promise.allSettled(
    accounts.map(async (account) => {
      if (!account.canUseContacts) return null;
      return listContacts(await accessToken(env, account), account.email);
    }),
  );
  const contacts: Contact[] = [];
  const statuses = accounts.map((account, i) => {
    const result = lists[i];
    if (result.status === "rejected") return { email: account.email, canUse: true, error: errorText(result.reason) };
    if (result.value === null) return { email: account.email, canUse: false, error: null };
    contacts.push(...result.value);
    return { email: account.email, canUse: true, error: null };
  });
  contacts.sort(byName);
  return { accounts: statuses, contacts, offlineSince: null };
}

/** By name, as an address book is; people without one go last. */
function byName(a: Contact, b: Contact): number {
  const key = (c: Contact) => (c.name || c.organization || c.emails[0]?.value || "").toLowerCase();
  return Number(!a.name) - Number(!b.name) || key(a).localeCompare(key(b));
}

async function listContacts(token: string, account: string): Promise<Contact[]> {
  const contacts: Contact[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API}/people/me/connections`);
    url.searchParams.set("personFields", PERSON_FIELDS);
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("sortOrder", "FIRST_NAME_ASCENDING");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await google<{ connections?: Person[]; nextPageToken?: string }>(token, url.toString());
    for (const person of page.connections ?? []) {
      const contact = toContact(account, person);
      if (contact) contacts.push(contact);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return contacts;
}

export async function createContact(env: Env, email: string, draft: ContactDraft): Promise<Contact> {
  const token = await accessToken(env, await findAccount(env, email));
  const url = new URL(`${API}/people:createContact`);
  url.searchParams.set("personFields", PERSON_FIELDS);
  const saved = await google<Person>(token, url.toString(), { method: "POST", body: JSON.stringify(personJson(draft).person) });
  return savedContact(email, saved);
}

export async function updateContact(env: Env, target: ContactRef, draft: ContactDraft): Promise<Contact> {
  const token = await accessToken(env, await findAccount(env, target.email));
  const { person, fields } = personJson(draft);
  if (fields.length === 0) throw invalidInput("nothing to change");
  // Google turns down a change made to an older version than it has.
  person.etag = target.etag;
  const url = new URL(personUrl(target.resourceName, "updateContact"));
  url.searchParams.set("updatePersonFields", fields.join(","));
  url.searchParams.set("personFields", PERSON_FIELDS);
  const saved = await google<Person>(token, url.toString(), { method: "PATCH", body: JSON.stringify(person) });
  return savedContact(target.email, saved);
}

export async function deleteContact(env: Env, target: ContactRef): Promise<void> {
  const token = await accessToken(env, await findAccount(env, target.email));
  try {
    await google(token, personUrl(target.resourceName, "deleteContact"), { method: "DELETE" });
  } catch (e) {
    // Already gone, which is what was wanted.
    if (!(e instanceof AppError && e.message.startsWith("Google API error (404)"))) throw e;
  }
}

/** Adds a contact to Favorites, or takes it out; returns it as it is now (its version changes). */
export async function setStarred(env: Env, target: ContactRef, starred: boolean): Promise<Contact> {
  const person = new URL(personUrl(target.resourceName, ""));
  const token = await accessToken(env, await findAccount(env, target.email));
  const key = starred ? "resourceNamesToAdd" : "resourceNamesToRemove";
  await google(token, `${API}/contactGroups/starred/members:modify`, {
    method: "POST",
    body: JSON.stringify({ [key]: [target.resourceName] }),
  });
  person.searchParams.set("personFields", PERSON_FIELDS);
  return savedContact(target.email, await google<Person>(token, person.toString()));
}

/** Most a contact's photo can be (the page sends a small square). */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** Sets a contact's photo (`data`: a JPEG or PNG, base64); returns them as they are now. */
export async function setPhoto(env: Env, target: ContactRef, data: string): Promise<Contact> {
  const token = await accessToken(env, await findAccount(env, target.email));
  return setPhotoWith(token, target, data);
}

async function setPhotoWith(token: string, target: ContactRef, data: string): Promise<Contact> {
  const photoBytes = data.trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(photoBytes) || photoBytes.length > (MAX_PHOTO_BYTES * 4) / 3 + 4) {
    throw invalidInput("a photo can be up to 5 MB");
  }
  const saved = await google<{ person?: Person }>(token, personUrl(target.resourceName, "updateContactPhoto"), {
    method: "PATCH",
    body: JSON.stringify({ photoBytes, personFields: PERSON_FIELDS }),
  });
  return saved.person ? savedContact(target.email, saved.person) : getContact(token, target.email, target.resourceName);
}

/** Takes a contact's photo off; returns them as they are now. */
export async function removePhoto(env: Env, target: ContactRef): Promise<Contact> {
  const token = await accessToken(env, await findAccount(env, target.email));
  const url = new URL(personUrl(target.resourceName, "deleteContactPhoto"));
  url.searchParams.set("personFields", PERSON_FIELDS);
  const saved = await google<{ person?: Person } | undefined>(token, url.toString(), { method: "DELETE" });
  return saved?.person ? savedContact(target.email, saved.person) : getContact(token, target.email, target.resourceName);
}

async function getContact(token: string, account: string, resourceName: string): Promise<Contact> {
  const url = new URL(personUrl(resourceName, ""));
  url.searchParams.set("personFields", PERSON_FIELDS);
  return savedContact(account, await google<Person>(token, url.toString()));
}

/** A photo's bytes as base64, if it's one of Google's photos (to give to another contact on a merge). */
async function googlePhoto(photoUrl: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(photoUrl);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (url.protocol !== "https:" || !(host === "googleusercontent.com" || host.endsWith(".googleusercontent.com"))) return null;
  const response = await fetch(url.toString()).catch(() => null);
  if (!response?.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_PHOTO_BYTES) return null;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Merges duplicates into `keep`, as Google Contacts' Merge does: it gets
 * `draft` (everything of theirs together, worked out by the page), `photo`
 * (another's, when it has none) and Favorites if any was; the others are
 * deleted. All in the same account. Returns the one kept, as saved.
 */
export async function mergeContacts(
  env: Env,
  keep: ContactRef,
  others: ContactRef[],
  draft: ContactDraft,
  photo: string | null,
  starred: boolean,
): Promise<Contact> {
  if (!others.length || others.some((o) => o.email !== keep.email || o.resourceName === keep.resourceName)) {
    throw invalidInput("only other contacts in the same account can be merged");
  }
  const token = await accessToken(env, await findAccount(env, keep.email));
  let saved: Contact | null = null;
  if (personJson(draft).fields.length) saved = await updateContact(env, keep, draft);
  if (photo) {
    // A photo that can't be copied isn't worth stopping the merge for.
    const data = await googlePhoto(photo);
    if (data) saved = (await setPhotoWith(token, keep, data).catch(() => null)) ?? saved;
  }
  if (starred && !saved?.starred) saved = await setStarred(env, keep, true);
  for (const other of others) await deleteContact(env, other);
  return saved ?? getContact(token, keep.email, keep.resourceName);
}

/** ".../people/c123:<method>". The name comes from the page, so it's checked to be a person's ID. */
function personUrl(resourceName: string, method: string): string {
  const id = /^people\/([A-Za-z0-9_-]+)$/.exec(resourceName)?.[1];
  if (!id) throw invalidInput(`not a contact: ${JSON.stringify(resourceName)}`);
  return `${API}/people/${id}${method ? `:${method}` : ""}`;
}

function savedContact(account: string, person: Person): Contact {
  const contact = toContact(account, person);
  if (!contact) throw new AppError("api", "Google API error (500): Google lost the contact", 502);
  return contact;
}

/** The People API's person for `draft`, and which of its fields are given (for `updatePersonFields`). */
function personJson(draft: ContactDraft): { person: Record<string, unknown>; fields: string[] } {
  const person: Record<string, unknown> = {};
  const fields: string[] = [];
  const put = (field: string, value: unknown) => {
    person[field] = value;
    fields.push(field);
  };
  const text = (s: string | undefined) => (s ?? "").trim();
  const labeled = (values: Labeled[], key: string) =>
    values
      .filter((v) => v.value.trim())
      .map((v) => ({ [key]: v.value.trim(), ...(v.label?.trim() ? { type: v.label.trim() } : {}) }));

  if (draft.givenName !== undefined || draft.familyName !== undefined) {
    const [givenName, familyName] = [text(draft.givenName), text(draft.familyName)];
    put("names", givenName || familyName ? [{ givenName, familyName }] : []);
  }
  if (draft.nickname !== undefined) put("nicknames", text(draft.nickname) ? [{ value: text(draft.nickname) }] : []);
  if (draft.organization !== undefined || draft.jobTitle !== undefined) {
    const [name, title] = [text(draft.organization), text(draft.jobTitle)];
    put("organizations", name || title ? [{ name, title }] : []);
  }
  if (draft.emails) put("emailAddresses", labeled(draft.emails, "value"));
  if (draft.phones) put("phoneNumbers", labeled(draft.phones, "value"));
  if (draft.addresses) put("addresses", labeled(draft.addresses, "formattedValue"));
  if (draft.urls) put("urls", labeled(draft.urls, "value"));
  if (draft.birthdays) {
    const valid = (b: Birthday) => b.month >= 1 && b.month <= 12 && b.day >= 1 && b.day <= 31;
    put(
      "birthdays",
      draft.birthdays.filter(valid).map((b) => ({ date: { ...(b.year ? { year: b.year } : {}), month: b.month, day: b.day } })),
    );
  }
  if (draft.notes !== undefined) {
    put("biographies", text(draft.notes) ? [{ value: text(draft.notes), contentType: "TEXT_PLAIN" }] : []);
  }
  if (draft.relations) put("relations", labeled(draft.relations, "person"));
  return { person, fields };
}

function toContact(account: string, person: Person): Contact | null {
  if (!person.resourceName || person.metadata?.deleted) return null;
  const name = person.names?.[0];
  const organization = person.organizations?.[0];
  const labeled = (fields: Field[] | undefined): Labeled[] =>
    (fields ?? []).filter((f) => f.value?.trim()).map((f) => ({ value: f.value!, label: f.type ?? null }));
  const date = person.birthdays?.map((b) => b.date).find((d) => d?.month && d.day);
  return {
    id: `${account}/${person.resourceName}`,
    account,
    resourceName: person.resourceName,
    etag: person.etag ?? null,
    name: name?.displayName ?? "",
    givenName: name?.givenName ?? null,
    familyName: name?.familyName ?? null,
    nickname: person.nicknames?.find((n) => n.value)?.value ?? null,
    organization: organization?.name || null,
    jobTitle: organization?.title || null,
    emails: labeled(person.emailAddresses),
    phones: labeled(person.phoneNumbers),
    addresses: (person.addresses ?? [])
      .filter((a) => a.formattedValue?.trim())
      .map((a) => ({ value: a.formattedValue!, label: a.type ?? null })),
    urls: labeled(person.urls),
    birthday: date ? { year: date.year ?? null, month: date.month!, day: date.day! } : null,
    notes: person.biographies?.find((b) => b.value?.trim())?.value ?? null,
    photo: person.photos?.find((p) => !p.default)?.url ?? null,
    starred: (person.memberships ?? []).some((m) => m.contactGroupMembership?.contactGroupResourceName === STARRED),
    relations: (person.relations ?? [])
      .filter((r) => r.person?.trim())
      .map((r) => ({ value: r.person!, label: r.type ?? null })),
  };
}
