// Reads what's typed in the Contacts window's box, as Cardhop does. It can be:
//
//   a search          "sam", "acme", "555 01"
//   a new contact     "Jane Doe jane@example.com 555-0100 Designer at Acme"
//   more about someone you have
//                     "Sam Lee mobile 555-0101", "Sam 484", "Sam 12 Main",
//                     "Sam wife Abigail", "Sam title Printer"… (offered for
//                     everyone the name fits, as Cardhop's "Add to…")
//   something to do   "call Sam", "text Sam", "email Sam about lunch",
//                     "meet Sam tomorrow 3pm", "note Sam: likes jazz",
//                     "map Sam", "facetime Sam"
//   something done    "called Sam about the lease", "met Ana for coffee"
//                     (logged in their History)
//
// Runs locally, as you type; chrono-node finds a meeting's date and time.
import * as chrono from "chrono-node/en";
import type { Birthday, Contact, InteractionKind, Labeled } from "../api";
import { displayName, matchScore, monthNumber, search } from "./model";

export type Action = "call" | "message" | "email" | "facetime" | "event" | "note" | "map";

/** A person as read from the box (names split, fields found). */
export interface ParsedContact {
  givenName: string;
  familyName: string;
  nickname: string | null;
  organization: string | null;
  jobTitle: string | null;
  emails: Labeled[];
  phones: Labeled[];
  addresses: Labeled[];
  urls: Labeled[];
  /** People they're related to: "wife Abigail Adams" → { value: "Abigail Adams", label: "spouse" }. */
  relations: Labeled[];
  birthday: Birthday | null;
  notes: string | null;
}

export type Intent =
  | { kind: "empty" }
  /** Just a search. `add`: the words as a new contact's name, if they could be one. */
  | { kind: "search"; query: string; matches: Contact[]; add: ParsedContact | null }
  /** Something to do with someone: `contact` is the best match (null if none). */
  | { kind: "action"; action: Action; query: string; contact: Contact | null; matches: Contact[]; rest: string }
  /** Something done with someone, to log in their History. */
  | { kind: "log"; logKind: InteractionKind; query: string; contact: Contact | null; matches: Contact[]; rest: string }
  /**
   * Details for a new contact, or to add to someone you have: `candidates`
   * are the people the name fits ("Sam" → Samuel Adams, Sam Adams), as
   * Cardhop's "Add to…". Enter adds a new contact.
   */
  | { kind: "add"; details: ParsedContact; candidates: Contact[] }
  /** The same, the name being someone's in full: Enter adds to `contact` (also first of `candidates`). */
  | { kind: "update"; contact: Contact; details: ParsedContact; candidates: Contact[] };

const VERBS: [RegExp, Action][] = [
  [/^(?:call|phone|ring|dial)$/i, "call"],
  [/^(?:text|message|msg|sms|imessage)$/i, "message"],
  [/^(?:email|e-mail|mail)$/i, "email"],
  [/^(?:facetime|video)$/i, "facetime"],
  [/^(?:meet|meeting|schedule|invite)$/i, "event"],
  [/^(?:note|notes)$/i, "note"],
  [/^(?:map|directions|navigate)$/i, "map"],
];

/** Past tense: something already done, to log. */
const DONE: [RegExp, InteractionKind][] = [
  [/^(?:called|phoned|rang)$/i, "call"],
  [/^(?:texted|messaged)$/i, "message"],
  [/^(?:emailed|e-mailed|mailed)$/i, "email"],
  [/^(?:facetimed)$/i, "facetime"],
  [/^(?:met|saw|visited)$/i, "met"],
];

/** Words after the person that only join them to the rest: "email Sam about…". */
const JOINERS: Partial<Record<Action, RegExp>> = {
  email: /^(?:about|re|regarding|subject)\b[:\s]*/i,
  note: /^(?:that|:)\s*/i,
  event: /^(?:on|at|for)\s+(?=\S)/i,
};

/** The most words of a person's name looked for after a verb. */
const MAX_NAME_WORDS = 4;

/** The most people offered to add details to ("Add to…"). */
const MAX_CANDIDATES = 6;

/** Reads `text`, typed in the box, against `contacts`. */
export function interpret(text: string, contacts: Contact[], now: Date): Intent {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return { kind: "empty" };

  const action = readAction(trimmed, contacts);
  if (action) return action;

  const matches = search(contacts, trimmed);
  // Details nobody has yet ("Sam Lee sam@example.com" when Sam has that
  // address is just a search). With a name and nothing found for all of
  // it, read more freely: "Sam 484" is Sam's number, "Sam 12 Main" an address.
  const { name, details, found } = parseDetails(trimmed, now, { loose: matches.length === 0 });
  if (found && matches.length === 0) {
    // Everyone the name fits, to add these to; best first.
    const candidates = name ? search(contacts, name).slice(0, MAX_CANDIDATES) : [];
    // A name you already have, in full: Enter adds these details to them.
    const named = candidates.filter((c) => matchScore(c, name) === 100);
    if (named.length === 1) {
      return { kind: "update", contact: named[0], details, candidates: [named[0], ...candidates.filter((c) => c !== named[0])] };
    }
    return { kind: "add", details, candidates };
  }

  const add = /[\p{L}]/u.test(trimmed) && !/[@/:]/.test(trimmed) ? details : null;
  return { kind: "search", query: trimmed, matches, add };
}

/**
 * "call Sam", "email Sam Lee about lunch", "called Sam about the lease"…,
 * or null if it doesn't start with a verb.
 */
function readAction(text: string, contacts: Contact[]): Intent | null {
  const [verb, ...words] = text.split(" ");
  const action = VERBS.find(([pattern]) => pattern.test(verb))?.[1];
  const done = action ? undefined : DONE.find(([pattern]) => pattern.test(verb))?.[1];
  if ((!action && !done) || words.length === 0) return null;
  const intent = (query: string, contact: Contact | null, matches: Contact[], rest: string): Intent =>
    action
      ? { kind: "action", action, query, contact, matches, rest }
      : { kind: "log", logKind: done!, query, contact, matches, rest };

  // The longest run of words that names someone ("Sam Lee" before "Sam").
  for (let n = Math.min(MAX_NAME_WORDS, words.length); n >= 1; n--) {
    const query = words.slice(0, n).join(" ").replace(/[:,]$/, "");
    const matches = search(contacts, query);
    if (matches.length === 0) continue;
    let rest = words.slice(n).join(" ").replace(/^[:,]\s*/, "");
    const joiner = action ? JOINERS[action] : LOG_JOINER;
    if (joiner) rest = rest.replace(joiner, "");
    return intent(query, matches[0], matches, rest);
  }
  return intent(words.join(" "), null, [], "");
}

/** "called Sam about the lease" → "the lease"; "met Ana for coffee" keeps "for coffee". */
const LOG_JOINER = /^(?:about|re|regarding|:)\s*/i;

// ---------- Details of a new contact ----------

const EMAIL = /(?:\b(work|home|personal|school|other)\s*:?\s+)?\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const EMAIL_LABELS: Record<string, string> = { personal: "home", school: "other" };

/** A phone number: at least 7 digits, maybe a +, spaces, dots, dashes and brackets. */
const PHONE =
  /(?:\b(mobile|cell|cellphone|iphone|work|office|home|main|fax|pager|other)\s*:?\s+)?(?<![\w/-])(\+?\(?\d[\d\s().-]{5,}\d)(?![\w/-])/gi;
const PHONE_LABELS: Record<string, string> = {
  cell: "mobile",
  cellphone: "mobile",
  iphone: "mobile",
  office: "work",
  fax: "workFax",
};

const URL_PATTERN =
  /\b(?:https?:\/\/[^\s<>"]+|www\.[^\s<>"]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|co|app|me|ai|uk|us|ca|de|fr|au|nz|ie|info|biz|xyz)(?:\/[^\s<>"]*)?)(?![\w@])/gi;

/** "123 Main St", "42 Elm Street, Springfield, IL 62704", optionally "home: …". */
const ADDRESS = new RegExp(
  String.raw`(?:\b(home|work|other)\s*(?:address)?\s*:?\s+|\b(?:address|lives at|lives on)\s*:?\s+)?` +
    String.raw`\b(\d{1,6}[A-Za-z]?\s+(?:[A-Za-z0-9.'-]+\s+){0,5}?` +
    String.raw`(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl|Terrace|Ter|Parkway|Pkwy|Circle|Cir|Highway|Hwy|Square|Sq|Close|Crescent|Cres)\b\.?` +
    // Then ", Town", ", State 12345", ", Country" (up to three more parts),
    // each maybe ending in a ZIP or postcode.
    String.raw`(?:\s*,\s*[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)*(?:\s+(?:\d{4,5}(?:-\d{4})?|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}))?){0,3})`,
  "i",
);

/** "birthday March 4", "bday 3/4/1990", "born 1990-03-04", "birthday: 4 Mar". */
const BIRTHDAY = /\b(?:birthday|bday|b-day|born)\b(?:\s+(?:is|on))?\s*:?\s*([A-Za-z0-9 ,./-]+?)(?=\s*(?:$|[;|]|\b(?:at|works?|email|phone|mobile|notes?)\b))/i;

/** "note: met at the conference", or the same in quotes. */
const NOTES = /(?:\bnotes?\s*:\s*(.+)$|"([^"]+)"|“([^”]+)”)/i;

/** "aka Bobby", "nickname Bobby", or "Robert (Bob) Smith". */
const NICKNAME = /(?:\b(?:aka|a\.k\.a\.|nickname)\s+([\p{L}'-]+)|\(([\p{L}'-]+)\))/iu;

/** "Designer at Acme", "CEO of Acme", "from Acme", "@ Acme": the job, then the company. */
const WORK = /(?:,\s*|\s+)(?:(?:works?\s+)?(?:at|@)|of|from)\s+([\p{Lu}0-9&][\p{L}0-9&.'’-]*(?:\s+(?:[\p{Lu}0-9&][\p{L}0-9&.'’-]*|&|and|of))*)/u;

/**
 * With a name, read more freely (`loose`): a number then words, at the end,
 * is an address without "Street" ("Sam 1700 Wade Hampton", "Ann 5 Elm,
 * Concord"); a number on its own of 3 to 6 digits is a phone ("Sam 484").
 */
const LOOSE_ADDRESS =
  /(?:\b(home|work|other)\s*(?:address)?\s*:?\s+|\b(?:address|lives at|lives on)\s*:?\s+)?\b(\d{1,6}[A-Za-z]?\s+\p{L}[^\s,]*(?:[\s,]+[\p{L}\d][^\s,]*){0,9})\s*$/iu;
const SHORT_PHONE = /(?:\b(mobile|cell|cellphone|iphone|work|office|home|main|fax|pager|other)\s*:?\s+)?(?<![\w/-])(\+?\d{3,6})(?![\w/-])/gi;

/** "wife Abigail Adams", "son John", "my boss: Paul Revere": how they're related, then who. */
const RELATION =
  /\b(?:my\s+|his\s+|her\s+|their\s+)?(wife|husband|spouse|partner|domestic partner|son|daughter|child|kid|mother|mom|mum|father|dad|parent|brother|sister|sibling|friend|cousin|relative|manager|boss|assistant|referred by)\s*(?:is\s+|:\s*)?\s+(\p{L}[\p{L}'’.-]*(?:\s+(?!(?:at|of|from|works?|and)\b)\p{L}[\p{L}'’.-]*){0,3})/iu;
const RELATION_LABELS: Record<string, string> = {
  wife: "spouse",
  husband: "spouse",
  "domestic partner": "domesticPartner",
  son: "child",
  daughter: "child",
  kid: "child",
  mom: "mother",
  mum: "mother",
  dad: "father",
  sibling: "relative",
  cousin: "relative",
  boss: "manager",
  "referred by": "referredBy",
};

/** "title Printer", "job: Silversmith", "role Courier": a job title on its own. */
const TITLE = /\b(?:job\s+title|title|job|role|position)\s*:?\s+([^,;]+?)(?=\s*(?:$|[,;]|\s(?:at|of|from|@)\s))/i;

/** Words that start a job title, so "Jane Doe Designer at Acme" is Jane Doe, Designer. */
const JOB_WORDS = new Set(
  (
    "ceo cto cfo coo cmo cio vp evp svp president director manager engineer designer developer founder co-founder " +
    "cofounder partner consultant analyst lead head officer architect producer editor writer teacher professor " +
    "doctor dr nurse lawyer attorney accountant recruiter owner intern associate assistant scientist researcher " +
    "sales marketing product senior sr junior jr chief principal staff coordinator specialist agent broker realtor " +
    "chef artist photographer student administrator admin representative rep executive investor advisor adviser"
  ).split(" "),
);

/** Words before a family name that belong to it: "van der Berg", "de la Cruz". */
const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "la", "le", "da", "di", "du", "dos", "bin", "al", "st", "st."]);

/** Everything recognised in `text`, the name left over, and whether any detail (not just a name) was found. */
export function parseDetails(
  text: string,
  now: Date,
  { loose = false }: { loose?: boolean } = {},
): { name: string; details: ParsedContact; found: boolean } {
  let rest = text;
  const take = (match: RegExpExecArray) => {
    rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`;
  };

  let notes: string | null = null;
  const note = NOTES.exec(rest);
  if (note) {
    notes = (note[1] ?? note[2] ?? note[3]).trim();
    take(note);
  }

  let birthday: Birthday | null = null;
  const born = BIRTHDAY.exec(rest);
  if (born) {
    birthday = parseBirthday(born[1], now);
    if (birthday) take(born);
  }

  const emails: Labeled[] = [];
  for (const match of [...rest.matchAll(EMAIL)].reverse()) {
    const label = match[1]?.toLowerCase() ?? null;
    emails.unshift({ value: match[2], label: label ? (EMAIL_LABELS[label] ?? label) : null });
    take(match as RegExpExecArray);
  }

  const urls: Labeled[] = [];
  for (const match of [...rest.matchAll(URL_PATTERN)].reverse()) {
    urls.unshift({ value: match[0].replace(/[.,;)]+$/, ""), label: null });
    take(match as RegExpExecArray);
  }

  const addresses: Labeled[] = [];
  for (let match = ADDRESS.exec(rest); match; match = ADDRESS.exec(rest)) {
    addresses.push({ value: match[2].trim().replace(/\s*,\s*/g, ", "), label: match[1]?.toLowerCase() ?? null });
    take(match);
  }

  const phones: Labeled[] = [];
  for (const match of [...rest.matchAll(PHONE)].reverse()) {
    const digits = match[2].replace(/\D/g, "");
    // Not a date ("1990-02-28"), which isn't a phone number however many digits.
    if (digits.length < 7 || digits.length > 15 || /^\d{4}-\d{1,2}-\d{1,2}$/.test(match[2].trim())) continue;
    const label = match[1]?.toLowerCase() ?? null;
    phones.unshift({ value: match[2].trim(), label: label ? (PHONE_LABELS[label] ?? label) : null });
    take(match as RegExpExecArray);
  }

  // Read freely (see LOOSE_ADDRESS), only with words before for a name.
  const named = (match: RegExpExecArray) => /\p{L}/u.test(rest.slice(0, match.index));
  if (loose) {
    const place = LOOSE_ADDRESS.exec(rest);
    if (place && named(place)) {
      addresses.push({ value: place[2].trim().replace(/\s*,\s*/g, ", "), label: place[1]?.toLowerCase() ?? null });
      take(place);
    }
    for (const match of [...rest.matchAll(SHORT_PHONE)].reverse()) {
      if (!named(match as RegExpExecArray)) continue;
      const label = match[1]?.toLowerCase() ?? null;
      phones.unshift({ value: match[2], label: label ? (PHONE_LABELS[label] ?? label) : null });
      take(match as RegExpExecArray);
    }
  }

  const relations: Labeled[] = [];
  for (let match = RELATION.exec(rest); match; match = RELATION.exec(rest)) {
    const kind = match[1].toLowerCase();
    relations.push({ value: capitalized(match[2].trim()), label: RELATION_LABELS[kind] ?? kind });
    take(match);
  }

  let jobTitle: string | null = null;
  const titled = TITLE.exec(rest);
  if (titled) {
    jobTitle = titled[1].trim();
    take(titled);
  }

  let nickname: string | null = null;
  const aka = NICKNAME.exec(rest);
  if (aka) {
    nickname = aka[1] ?? aka[2];
    take(aka);
  }

  // The job and company: "Jane Doe, Designer at Acme" or "Jane Doe Designer at Acme".
  let organization: string | null = null;
  const work = WORK.exec(rest);
  let before = rest;
  if (work) {
    organization = work[1].trim();
    before = rest.slice(0, work.index);
    rest = `${before} ${rest.slice(work.index + work[0].length)}`;
  }
  let name = tidy(before);
  if (work) {
    const comma = before.indexOf(",");
    if (comma >= 0) {
      name = tidy(before.slice(0, comma));
      jobTitle = jobTitle ?? (tidy(before.slice(comma + 1)) || null);
    } else {
      // The job starts at a word like "Designer" or "CEO"; without one, it's all name.
      const words = name.split(" ").filter(Boolean);
      const job = words.findIndex((w, i) => i > 0 && JOB_WORDS.has(w.toLowerCase().replace(/[.,]$/, "")));
      // Or the words in small letters after a name in capitals: "Sam Adams brewer at…".
      // ("de", "van"… are the name's: "Marquis de Lafayette at…" is all name.)
      const lower = (w: string) => w === w.toLowerCase();
      const small = words.findIndex(
        (_, i) =>
          i > 0 &&
          words.slice(0, i).every((n) => !lower(n) || PARTICLES.has(n)) &&
          words.slice(i).every((n) => lower(n) && !PARTICLES.has(n)),
      );
      const start = job > 0 ? job : small;
      if (start > 0 && !jobTitle) {
        jobTitle = words.slice(start).join(" ");
        name = words.slice(0, start).join(" ");
      }
    }
    // What's left after the company (rare) joins the name's leftovers.
    const after = tidy(rest.slice(before.length));
    if (after && !name) name = after;
  } else {
    name = tidy(rest);
  }

  // Typed all in small letters ("john appleseed"): capitalised, as names are.
  if (name === name.toLowerCase()) name = capitalized(name);
  const [givenName, familyName] = splitName(name);
  const details: ParsedContact = {
    givenName,
    familyName,
    nickname,
    organization,
    jobTitle,
    emails,
    phones,
    addresses,
    urls,
    relations,
    birthday,
    notes,
  };
  const found = Boolean(
    emails.length ||
      phones.length ||
      addresses.length ||
      urls.length ||
      relations.length ||
      birthday ||
      notes ||
      organization ||
      jobTitle ||
      nickname,
  );
  return { name, details, found };
}

/** "john appleseed" → "John Appleseed" (as typed, if any capitals: "McGee" stays). */
const capitalized = (name: string) =>
  name === name.toLowerCase()
    ? name.replace(/\p{L}[\p{L}'’-]*/gu, (w) => (PARTICLES.has(w) ? w : w[0].toUpperCase() + w.slice(1)))
    : name;

const tidy = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:|-]+|[\s,;:|-]+$/g, "")
    .trim();

/** "Mary Ann Smith" → ["Mary Ann", "Smith"]; "Jan van der Berg" → ["Jan", "van der Berg"]. */
export function splitName(name: string): [string, string] {
  const words = name.split(" ").filter(Boolean);
  if (words.length <= 1) return [words[0] ?? "", ""];
  let first = words.length - 1;
  while (first > 1 && PARTICLES.has(words[first - 1].toLowerCase())) first--;
  return [words.slice(0, first).join(" "), words.slice(first).join(" ")];
}

/**
 * A birthday from "March 4", "4 March 1990", "Mar 4th, 1990", "3/4", "3/4/90"
 * or "1990-03-04". Numbers alone are month/day unless the first is over 12.
 */
export function parseBirthday(text: string, now: Date): Birthday | null {
  const s = text.trim().replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1").replace(/,/g, " ");
  const year = (y: string | undefined): number | null => {
    if (!y) return null;
    const n = Number(y);
    if (y.length === 4) return n;
    // "90" is 1990; "05" is 2005 if that's not in the future.
    const century = 2000 + n <= now.getFullYear() ? 2000 : 1900;
    return century + n;
  };
  const valid = (b: Birthday) => {
    const date = new Date(b.year ?? 2000, b.month - 1, b.day);
    return b.month >= 1 && b.month <= 12 && date.getMonth() === b.month - 1 && date.getDate() === b.day ? b : null;
  };

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return valid({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) });
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(s);
  if (m) {
    let [month, day] = [Number(m[1]), Number(m[2])];
    if (month > 12) [month, day] = [day, month];
    return valid({ year: year(m[3]), month, day });
  }
  m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:\s+(\d{4}))?$/.exec(s);
  if (m && monthNumber(m[1])) return valid({ year: year(m[3]), month: monthNumber(m[1]), day: Number(m[2]) });
  m = /^(\d{1,2})\s+([A-Za-z]+)\.?(?:\s+(\d{4}))?$/.exec(s);
  if (m && monthNumber(m[2])) return valid({ year: year(m[3]), month: monthNumber(m[2]), day: Number(m[1]) });
  return null;
}

/**
 * For "meet Sam tomorrow 3pm": a sentence for Minuteman's New event, whose
 * title is what you wrote before the date ("Lunch"), else "Meeting", with
 * the person and them invited by email.
 */
export function eventSentence(contact: Contact, rest: string, now: Date): string {
  const found = chrono.casual.parse(rest, now, { forwardDate: true })[0];
  const what = (found ? rest.slice(0, found.index) : rest).trim();
  const when = found ? rest.slice(found.index).trim() : "";
  const title = what ? what[0].toUpperCase() + what.slice(1) : "Meeting";
  const email = contact.emails[0]?.value;
  return [`${title} with ${displayName(contact)}`, when, email ? `with ${email}` : ""].filter(Boolean).join(" ");
}
