// The New and Edit contact window: photo, names, work, phones, emails,
// addresses, websites, birthday, the people they're related to, and notes.
// Editing saves only what changed.
import {
  contactPhoto,
  createContact,
  contactRef,
  errorMessage,
  removeContactPhoto,
  setContactPhoto,
  updateContact,
  type Birthday,
  type Contact,
  type ContactDraft,
  type Labeled,
} from "../api";
import { el } from "../dom";
import { changedWords } from "./history";
import { labelText } from "./model";
import { cropPhoto } from "./photo";
import type { ParsedContact } from "./parse";
import { enablePlaceSuggestions } from "../place-suggest";

type ListKind = "phones" | "emails" | "addresses" | "urls" | "relations";

/** The labels offered for each kind of value (Google's own types). */
const LABEL_CHOICES: Record<ListKind, string[]> = {
  phones: ["mobile", "work", "home", "main", "workMobile", "homeFax", "workFax", "pager", "other"],
  emails: ["home", "work", "other"],
  addresses: ["home", "work", "other"],
  urls: ["homePage", "work", "blog", "profile", "other"],
  relations: [
    "spouse",
    "partner",
    "child",
    "mother",
    "father",
    "parent",
    "brother",
    "sister",
    "friend",
    "relative",
    "manager",
    "assistant",
    "referredBy",
    "domesticPartner",
  ],
};

const LIST_NAMES: Record<ListKind, [string, string]> = {
  phones: ["Phone", "Add phone"],
  emails: ["Email", "Add email"],
  addresses: ["Address", "Add address"],
  urls: ["Website", "Add website"],
  relations: ["Related", "Add related person"],
};

const PLACEHOLDERS: Record<ListKind, string> = {
  phones: "Phone number",
  emails: "Email address",
  addresses: "Street, town, postcode",
  urls: "Web address",
  relations: "Their name",
};

/**
 * Opens the form. `contact`: the one to edit, or null for a new one, which
 * starts with `start` (e.g. from the sentence box). `accounts`: the Google
 * accounts a new one can go in, the usual one first. `names`: everyone's
 * names, suggested for the people they're related to. `onSaved` gets a
 * warning when they were saved but their photo wasn't.
 */
export function openContactForm(
  contact: Contact | null,
  start: ParsedContact | null,
  accounts: string[],
  onSaved: (saved: Contact, warning?: string, changed?: string[]) => void,
  names: string[] = [],
): void {
  const dialog = el("dialog", "dialog event-form contact-form");
  dialog.setAttribute("aria-labelledby", "contact-form-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());

  const title = el("h2", undefined, contact ? "Edit contact" : "New contact");
  title.id = "contact-form-title";

  const text = (value: string | null | undefined, placeholder: string) => {
    const input = el("input", "text-input");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = value ?? "";
    return input;
  };
  const source = contact ?? start;
  const given = text(source?.givenName, "First name");
  const family = text(source?.familyName, "Last name");
  const nickname = text(source?.nickname, "Nickname");
  const organization = text(source?.organization, "Company");
  const jobTitle = text(source?.jobTitle, "Job title");

  const grid = el("div", "form-grid");
  const row = (label: string, ...controls: HTMLElement[]) => {
    const box = el("div", "form-controls");
    box.append(...controls);
    grid.append(el("span", "form-label", label), box);
    return box;
  };
  const photo = new PhotoField(contact?.photo ?? null);
  grid.append(el("span", "form-label", "Photo"), photo.node);
  row("Name", given, family);
  row("Nickname", nickname);
  row("Work", jobTitle, organization);

  const lists = {} as Record<ListKind, LabeledList>;
  for (const kind of ["phones", "emails", "addresses", "urls"] as const) {
    lists[kind] = new LabeledList(kind, source?.[kind] ?? []);
    grid.append(el("span", "form-label", LIST_NAMES[kind][0]), lists[kind].node);
  }

  const birthday = new BirthdayField(source?.birthday ?? null);
  row("Birthday", ...birthday.controls);
  // Everyone's names, offered as you type someone they're related to.
  const people = el("datalist");
  people.id = `contact-names-${Date.now()}`;
  people.append(...[...new Set(names.filter(Boolean))].map((n) => new Option(n)));
  lists.relations = new LabeledList("relations", contact?.relations ?? [], people.id);
  grid.append(el("span", "form-label", "Related"), lists.relations.node);
  const notes = el("textarea", "text-input");
  notes.rows = 3;
  notes.value = source?.notes ?? "";
  row("Notes", notes);

  const account = el("select", "text-input");
  account.append(...accounts.map((email) => new Option(email, email)));
  if (!contact && accounts.length > 1) row("Account", account);

  const error = el("p", "error");
  const cancel = el("button", "text-button", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  const save = el("button", "primary-button", contact ? "Save" : "Add");
  const buttons = el("div", "dialog-buttons");
  buttons.append(cancel, save);

  const form = el("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const values: Required<ContactDraft> = {
      givenName: given.value.trim(),
      familyName: family.value.trim(),
      nickname: nickname.value.trim(),
      organization: organization.value.trim(),
      jobTitle: jobTitle.value.trim(),
      phones: lists.phones.values(),
      emails: lists.emails.values(),
      addresses: lists.addresses.values(),
      urls: lists.urls.values(),
      birthdays: birthday.value() ? [birthday.value()!] : [],
      notes: notes.value.trim(),
      relations: lists.relations.values(),
    };
    if (birthday.invalid()) {
      error.textContent = "That birthday isn't a real date.";
      return;
    }
    const draft = contact ? changes(contact, values) : values;
    if (!contact && !Object.values(values).some((v) => (Array.isArray(v) ? v.length : v))) {
      error.textContent = "Fill in at least a name, phone or email.";
      return;
    }
    if (contact && Object.keys(draft).length === 0 && !photo.changed()) {
      dialog.close();
      return;
    }
    save.disabled = true;
    error.textContent = "";
    let saved: Contact;
    try {
      if (!contact) saved = await createContact(account.value, draft);
      else saved = Object.keys(draft).length ? await updateContact(contactRef(contact), draft) : contact;
    } catch (err) {
      error.textContent = `Couldn't save: ${errorMessage(err)}`;
      save.disabled = false;
      return;
    }
    // The photo goes on once they're saved (a new contact needs to exist first).
    let warning: string | undefined;
    try {
      if (photo.chosen) saved = await setContactPhoto(contactRef(saved), photo.chosen);
      else if (photo.removed && saved.photo) saved = await removeContactPhoto(contactRef(saved));
    } catch (err) {
      warning = `Saved, but the photo couldn't be changed: ${errorMessage(err)}`;
    }
    dialog.close();
    // What an edit changed, in words, for Recents ("name, address").
    onSaved(saved, warning, contact ? changedWords(draft, photo.changed() && !warning) : undefined);
  });
  form.append(grid, people, error, buttons);
  dialog.append(title, form);
  dialog.showModal();
  given.focus();
}

/** Only the fields that differ from `contact` (names, and work, go in pairs). */
function changes(contact: Contact, values: Required<ContactDraft>): ContactDraft {
  const draft: ContactDraft = {};
  const same = (a: string | null, b: string) => (a ?? "").trim() === b;
  const sameList = (a: Labeled[], b: Labeled[]) =>
    a.length === b.length &&
    a.every((v, i) => tidyValue(v.value) === tidyValue(b[i].value) && (v.label ?? null) === (b[i].label ?? null));
  if (!same(contact.givenName, values.givenName) || !same(contact.familyName, values.familyName)) {
    draft.givenName = values.givenName;
    draft.familyName = values.familyName;
  }
  if (!same(contact.nickname, values.nickname)) draft.nickname = values.nickname;
  if (!same(contact.organization, values.organization) || !same(contact.jobTitle, values.jobTitle)) {
    draft.organization = values.organization;
    draft.jobTitle = values.jobTitle;
  }
  for (const kind of ["phones", "emails", "addresses", "urls", "relations"] as const) {
    if (!sameList(contact[kind] ?? [], values[kind])) draft[kind] = values[kind];
  }
  const b = contact.birthday;
  const next = values.birthdays[0];
  if (Boolean(b) !== Boolean(next) || (b && next && (b.year !== next.year || b.month !== next.month || b.day !== next.day))) {
    draft.birthdays = values.birthdays;
  }
  if (!same(contact.notes, values.notes)) draft.notes = values.notes;
  return draft;
}

/** A value as saved: trimmed, and (addresses) each line trimmed, blank lines dropped. */
const tidyValue = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

/** Rows of [label][value][×], plus a button to add another. */
class LabeledList {
  node = el("div", "form-controls labeled-list");
  private rows: { label: HTMLSelectElement; value: HTMLInputElement | HTMLTextAreaElement; row: HTMLElement }[] = [];
  private add: HTMLButtonElement;

  constructor(
    private kind: ListKind,
    values: Labeled[],
    /** A <datalist> of suggestions for the values. */
    private suggestions?: string,
  ) {
    // A whole row to tap, "+" in a badge as on the dock's New button.
    this.add = el("button", "labeled-add");
    this.add.type = "button";
    this.add.append(el("span", "labeled-add-badge", "+"), el("span", undefined, LIST_NAMES[kind][1]));
    this.add.addEventListener("click", () => this.addRow({ value: "", label: LABEL_CHOICES[kind][0] }).focus());
    this.node.append(this.add);
    for (const value of values) this.addRow(value);
  }

  private addRow(value: Labeled): HTMLInputElement | HTMLTextAreaElement {
    const label = el("select", "text-input labeled-label");
    label.setAttribute("aria-label", `${LIST_NAMES[this.kind][0]} label`);
    const choices = [...LABEL_CHOICES[this.kind]];
    if (value.label && !choices.includes(value.label)) choices.push(value.label);
    label.append(new Option("—", ""), ...choices.map((c) => new Option(labelText(c, c), c)));
    label.value = value.label ?? "";

    const input =
      this.kind === "addresses" ? el("textarea", "text-input labeled-value") : el("input", "text-input labeled-value");
    if (input instanceof HTMLInputElement) {
      // A website as Google keeps it, "poorrichard.example" too: not type="url",
      // which turns down one without https:// and so stopped Save.
      input.type = this.kind === "emails" ? "email" : this.kind === "phones" ? "tel" : "text";
      if (this.kind === "urls") input.inputMode = "url";
      if (this.suggestions) input.setAttribute("list", this.suggestions);
    } else {
      input.rows = 3; // street, town, country: all of it in view
      // Places only: not other people's addresses.
      enablePlaceSuggestions(input, undefined, { contacts: false });
    }
    input.placeholder = PLACEHOLDERS[this.kind];
    input.value = value.value;
    input.setAttribute("aria-label", LIST_NAMES[this.kind][0]);

    const remove = el("button", "icon-button labeled-remove", "×");
    remove.type = "button";
    remove.title = "Remove";
    remove.setAttribute("aria-label", `Remove ${LIST_NAMES[this.kind][0].toLowerCase()}`);
    const row = el("div", "labeled-row");
    row.append(label, input, remove);
    const entry = { label, value: input, row };
    remove.addEventListener("click", () => {
      row.remove();
      this.rows = this.rows.filter((r) => r !== entry);
    });
    this.rows.push(entry);
    this.node.insertBefore(row, this.add);
    return input;
  }

  values(): Labeled[] {
    return this.rows.map((r) => ({ value: tidyValue(r.value.value), label: r.label.value || null })).filter((v) => v.value);
  }
}

/** Their photo: Choose… (or Change…) and Remove. */
class PhotoField {
  node = el("div", "form-controls photo-field");
  /** A new photo to put on, as base64 JPEG. */
  chosen: string | null = null;
  /** The one they had is to come off. */
  removed = false;
  /** The picture the new photo was framed from, to frame it again from all of it. */
  private original: Blob | null = null;
  private preview = el("button", "avatar avatar-large photo-preview");
  private choose = el("button", "link-button");
  private adjust = el("button", "link-button", "Adjust…");
  private remove = el("button", "link-button", "Remove");
  private picker = el("input");
  private note = el("span", "form-notes");

  constructor(private current: string | null) {
    this.picker.type = "file";
    this.picker.accept = "image/*";
    this.picker.hidden = true;
    for (const button of [this.preview, this.choose, this.adjust, this.remove]) button.type = "button";
    this.choose.addEventListener("click", () => this.picker.click());
    this.remove.addEventListener("click", () => {
      this.chosen = null;
      this.original = null;
      this.removed = true;
      this.draw(null);
    });
    this.adjust.addEventListener("click", () => void this.reframe());
    // Clicking the photo: adjust it, or choose one if there's none.
    this.preview.addEventListener("click", () => (this.shown() ? void this.reframe() : this.picker.click()));
    this.picker.addEventListener("change", async () => {
      const file = this.picker.files?.[0];
      this.picker.value = "";
      if (file) await this.frame(file, true);
    });
    this.node.append(this.preview, this.choose, this.adjust, this.remove, this.picker, this.note);
    this.draw(current);
  }

  changed(): boolean {
    return this.chosen !== null || (this.removed && this.current !== null);
  }

  /** The photo there now: the new one, or the one they had. */
  private shown(): boolean {
    return this.chosen !== null || (!this.removed && this.current !== null);
  }

  /** Adjust photo for `source`; it becomes the new photo unless cancelled. */
  private async frame(source: Blob, isNew: boolean): Promise<void> {
    this.note.textContent = "Opening it…";
    try {
      const framed = await cropPhoto(source);
      this.note.textContent = "";
      if (framed === null) return;
      this.chosen = framed;
      this.removed = false;
      if (isNew) this.original = source;
      this.draw(`data:image/jpeg;base64,${framed}`);
    } catch {
      this.note.textContent = "That picture couldn't be opened. Try a JPEG, PNG or HEIC.";
    }
  }

  /** Adjust… : the new photo again from all of its picture, or the one they have from Google. */
  private async reframe(): Promise<void> {
    if (this.original) return this.frame(this.original, false);
    if (!this.current) return;
    this.note.textContent = "Getting their photo…";
    try {
      const source = await photoBlob(this.current);
      // Adjusting it doesn't replace the picture it can be adjusted from again.
      this.original = source;
      await this.frame(source, false);
    } catch (e) {
      this.note.textContent = `Couldn't get their photo: ${errorMessage(e)}`;
    }
  }

  private draw(src: string | null): void {
    if (src) {
      const img = el("img");
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.src = src;
      this.preview.replaceChildren(img);
    } else this.preview.replaceChildren(el("span", "avatar-initials", "—"));
    this.preview.setAttribute("aria-label", src ? "Adjust photo" : "Choose a photo");
    this.preview.title = src ? "Adjust photo" : "Choose a photo";
    this.choose.textContent = src ? "Change…" : "Choose…";
    this.remove.hidden = this.adjust.hidden = !src;
  }
}

/**
 * A contact's photo as a picture to adjust: from a data: address as it is,
 * or from Google, as big as Google has it (its addresses end "=s100", the
 * size it's sent at).
 */
async function photoBlob(url: string): Promise<Blob> {
  const toBlob = (data: string, type: string) => new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type });
  const inline = /^data:([^;,]+);base64,(.*)$/.exec(url);
  if (inline) return toBlob(inline[2], inline[1]);
  const bigger = url.replace(/=s\d+(-[a-z0-9-]*)?$/i, "=s1024");
  const data = await contactPhoto(bigger).catch(() => contactPhoto(url));
  return toBlob(data, "image/jpeg");
}

/** Month, day and (optional) year: Google keeps birthdays without a year. */
class BirthdayField {
  private month = el("select", "text-input");
  private day = el("select", "text-input");
  private year = el("input", "text-input birthday-year");
  controls: HTMLElement[];

  constructor(start: Birthday | null) {
    const monthName = new Intl.DateTimeFormat(undefined, { month: "long" });
    this.month.append(new Option("Month", ""), ...Array.from({ length: 12 }, (_, i) => new Option(monthName.format(new Date(2000, i, 1)), String(i + 1))));
    this.day.append(new Option("Day", ""), ...Array.from({ length: 31 }, (_, i) => new Option(String(i + 1), String(i + 1))));
    this.year.type = "number";
    this.year.placeholder = "Year";
    this.year.min = "1"; // any year (Demo mode's people were born in the 1700s)
    this.year.max = String(new Date().getFullYear());
    this.month.setAttribute("aria-label", "Birthday month");
    this.day.setAttribute("aria-label", "Birthday day");
    this.year.setAttribute("aria-label", "Birthday year (optional)");
    if (start) {
      this.month.value = String(start.month);
      this.day.value = String(start.day);
      this.year.value = start.year ? String(start.year) : "";
    }
    this.controls = [this.month, this.day, this.year];
  }

  value(): Birthday | null {
    if (!this.month.value || !this.day.value) return null;
    const year = Number(this.year.value);
    return { month: Number(this.month.value), day: Number(this.day.value), year: year > 0 ? year : null };
  }

  /** Feb 30, or Feb 29 in a year without one. */
  invalid(): boolean {
    const b = this.value();
    if (!b) return false;
    const date = new Date(b.year ?? 2000, b.month - 1, b.day);
    return date.getMonth() !== b.month - 1;
  }
}
