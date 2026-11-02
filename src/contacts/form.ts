// The New and Edit contact window: names, work, phones, emails, addresses,
// websites, birthday and notes. Editing saves only what changed.
import {
  createContact,
  contactRef,
  errorMessage,
  updateContact,
  type Birthday,
  type Contact,
  type ContactDraft,
  type Labeled,
} from "../api";
import { el } from "../dom";
import { labelText } from "./model";
import type { ParsedContact } from "./parse";
import { enablePlaceSuggestions } from "../place-suggest";

type ListKind = "phones" | "emails" | "addresses" | "urls";

/** The labels offered for each kind of value (Google's own types). */
const LABEL_CHOICES: Record<ListKind, string[]> = {
  phones: ["mobile", "work", "home", "main", "workMobile", "homeFax", "workFax", "pager", "other"],
  emails: ["home", "work", "other"],
  addresses: ["home", "work", "other"],
  urls: ["homePage", "work", "blog", "profile", "other"],
};

const LIST_NAMES: Record<ListKind, [string, string]> = {
  phones: ["Phone", "Add phone"],
  emails: ["Email", "Add email"],
  addresses: ["Address", "Add address"],
  urls: ["Website", "Add website"],
};

const PLACEHOLDERS: Record<ListKind, string> = {
  phones: "Phone number",
  emails: "Email address",
  addresses: "Street, town, postcode",
  urls: "Web address",
};

/**
 * Opens the form. `contact`: the one to edit, or null for a new one, which
 * starts with `start` (e.g. from the sentence box). `accounts`: the Google
 * accounts a new one can go in, the usual one first.
 */
export function openContactForm(
  contact: Contact | null,
  start: ParsedContact | null,
  accounts: string[],
  onSaved: (saved: Contact) => void,
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
    if (contact && Object.keys(draft).length === 0) {
      dialog.close();
      return;
    }
    save.disabled = true;
    error.textContent = "";
    try {
      const saved = contact ? await updateContact(contactRef(contact), draft) : await createContact(account.value, draft);
      dialog.close();
      onSaved(saved);
    } catch (err) {
      error.textContent = `Couldn't save: ${errorMessage(err)}`;
      save.disabled = false;
    }
  });
  form.append(grid, error, buttons);
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
  for (const kind of ["phones", "emails", "addresses", "urls"] as const) {
    if (!sameList(contact[kind], values[kind])) draft[kind] = values[kind];
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
  ) {
    this.add = el("button", "link-button", LIST_NAMES[kind][1]);
    this.add.type = "button";
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
      input.type = this.kind === "emails" ? "email" : this.kind === "phones" ? "tel" : this.kind === "urls" ? "url" : "text";
    } else {
      input.rows = 2;
      enablePlaceSuggestions(input);
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
    this.year.min = "1900";
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
