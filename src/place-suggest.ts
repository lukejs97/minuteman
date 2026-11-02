// Suggestions under a place or address field as you type: places by name
// ("Old North Church", "Starbucks Greenville") and street addresses. From
// Photon (photon.komoot.io), a free search over OpenStreetMap built for
// search-as-you-type, with no key or account: nothing here can cost money.
// What you type is sent to it (from 3 letters, after a short pause), so
// nothing is sent until you type in one of these fields.
//
// Up and down choose, Enter or a tap/click picks, Escape closes. Picking
// fills the field (or, with `onPick`, whatever the caller fills in). Video
// links are left alone.
import { el } from "./dom";
import { weatherSettings } from "./weather";

const PHOTON = "https://photon.komoot.io/api/";
const MIN_LETTERS = 3;
const PAUSE_MS = 250;
const LIMIT = 6;

/** A suggestion, with its parts for fields that take them one by one. */
export interface PlaceSuggestion {
  /** A place's name ("Old North Church"); null for a plain address. */
  name: string | null;
  /** "193 Salem St" */
  street: string;
  town: string;
  /** "MA" in the US, otherwise the region's name. */
  state: string;
  zip: string;
  country: string;
  /** All of it on one line, for a Location field. */
  line: string;
}

interface PhotonFeature {
  properties: {
    name?: string;
    housenumber?: string;
    street?: string;
    city?: string;
    town?: string;
    village?: string;
    district?: string;
    county?: string;
    state?: string;
    postcode?: string;
    country?: string;
    countrycode?: string;
    type?: string;
  };
}

const US_STATES: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO",
  Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY",
  Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH",
  "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
  Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT",
  Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
  "Puerto Rico": "PR",
};

/** A Photon result as a suggestion; null for whole countries, states and the like. */
export function toSuggestion(feature: PhotonFeature): PlaceSuggestion | null {
  const p = feature.properties;
  if (p.type && ["country", "state", "county"].includes(p.type)) return null;
  const us = p.countrycode?.toUpperCase() === "US";
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const town = p.city ?? p.town ?? p.village ?? p.district ?? "";
  const state = (us && p.state && US_STATES[p.state]) || p.state || "";
  const zip = p.postcode ?? "";
  // A street on its own comes as its name; an address has none, or its
  // number and street again. Shops, churches and the like (also type
  // "house") keep theirs.
  const isStreet = p.type === "street";
  const name = p.name && !isStreet && p.name !== street && p.name !== p.street ? p.name : null;
  const streetPart = street || (isStreet ? (p.name ?? "") : "");
  const regionZip = [state, zip].filter(Boolean).join(" ");
  const country = us ? "" : (p.country ?? "");
  const line = [name, streetPart, town !== name ? town : "", regionZip, country].filter(Boolean).join(", ");
  if (!line) return null;
  return { name, street: streetPart, town, state, zip, country, line };
}

const cache = new Map<string, PlaceSuggestion[]>();

/** Places and addresses matching `text`, nearest the weather's place first if one is set. */
async function suggest(text: string, signal: AbortSignal): Promise<PlaceSuggestion[]> {
  const key = text.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const url = new URL(PHOTON);
  url.searchParams.set("q", text.trim());
  url.searchParams.set("limit", String(LIMIT + 2));
  const lang = navigator.language.slice(0, 2).toLowerCase();
  if (["en", "de", "fr", "it"].includes(lang)) url.searchParams.set("lang", lang);
  // Somewhere near you first: the weather's place, when there is one.
  const place = weatherSettings().place;
  if (place) {
    url.searchParams.set("lat", String(place.latitude));
    url.searchParams.set("lon", String(place.longitude));
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Place search unavailable (${response.status})`);
  const body = (await response.json()) as { features?: PhotonFeature[] };
  const seen = new Set<string>();
  const found = (body.features ?? [])
    .map(toSuggestion)
    .filter((s): s is PlaceSuggestion => !!s && !seen.has(s.line) && !!seen.add(s.line))
    .slice(0, LIMIT);
  cache.set(key, found);
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return found;
}

/**
 * The place `text` names ("Old North Church", "starbucks", "boston"), if
 * one nearby is called that; null if not, or offline. For a place found in
 * a sentence: is it one, and (with a street) where it actually is.
 */
export async function findPlace(text: string): Promise<PlaceSuggestion | null> {
  const wanted = words(text);
  if (wanted.length === 0) return null;
  const found = await suggest(text, new AbortController().signal).catch(() => []);
  return (
    found.find((s) => {
      const name = words(s.name ?? s.town ?? s.street);
      // Every word asked for, in the name: "starbucks" is "Starbucks Coffee".
      return wanted.every((w) => name.some((n) => n.startsWith(w)));
    }) ?? null
  );
}

const words = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Whether `text` is a link or a meeting, not a place: no suggestions. */
const notAPlace = (text: string) => /:\/\/|^www\.|zoom|meet\.google|teams\.|webex|facetime/i.test(text);

/**
 * Suggests places under `field` as you type. `onPick` fills in what's
 * picked; without it, the field gets the one-line form.
 */
export function enablePlaceSuggestions(
  field: HTMLInputElement | HTMLTextAreaElement,
  onPick?: (place: PlaceSuggestion) => void,
): void {
  const list = el("div", "place-suggest");
  list.setAttribute("role", "listbox");
  list.id = `place-suggest-${Math.random().toString(36).slice(2, 8)}`;
  list.hidden = true;
  field.setAttribute("aria-autocomplete", "list");
  field.setAttribute("aria-controls", list.id);
  field.setAttribute("aria-expanded", "false");
  let shown: PlaceSuggestion[] = [];
  let active = -1;
  let timer: number | undefined;
  let request: AbortController | null = null;

  const close = () => {
    window.clearTimeout(timer);
    request?.abort();
    request = null;
    list.hidden = true;
    shown = [];
    active = -1;
    field.setAttribute("aria-expanded", "false");
    field.removeAttribute("aria-activedescendant");
  };

  /** Under the field, in the same dialog (so it's above it), and as wide. */
  const place = () => {
    const host = field.closest("dialog") ?? document.body;
    if (list.parentElement !== host) host.append(list);
    const r = field.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    list.style.left = `${r.left}px`;
    list.style.width = `${r.width}px`;
    // Above the field when there's more room there (a field low on a phone).
    if (below < 180 && r.top > below) {
      list.style.top = "";
      list.style.bottom = `${window.innerHeight - r.top + 4}px`;
    } else {
      list.style.bottom = "";
      list.style.top = `${r.bottom + 4}px`;
    }
  };

  const highlight = (index: number) => {
    active = index;
    [...list.children].forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
    if (index >= 0) field.setAttribute("aria-activedescendant", `${list.id}-${index}`);
    else field.removeAttribute("aria-activedescendant");
  };

  const pick = (suggestion: PlaceSuggestion) => {
    close();
    if (onPick) onPick(suggestion);
    else field.value = field instanceof HTMLTextAreaElement ? multiline(suggestion) : suggestion.line;
    // As if typed, so the form knows it changed.
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    picked = field.value;
  };
  /** What was just picked: no suggestions for it again until it's changed. */
  let picked = "";

  const show = (suggestions: PlaceSuggestion[]) => {
    shown = suggestions;
    if (!suggestions.length || document.activeElement !== field) return close();
    list.replaceChildren(
      ...suggestions.map((s, i) => {
        const option = el("div", "place-suggest-option");
        option.id = `${list.id}-${i}`;
        option.setAttribute("role", "option");
        const [first, ...rest] = s.name ? [s.name, s.line.slice(s.name.length + 2)] : [s.line];
        option.append(el("span", "place-suggest-main", first));
        if (rest[0]) option.append(el("span", "place-suggest-detail", rest[0]));
        // Pressed, not clicked: the field keeps focus (and a phone its keyboard).
        option.addEventListener("pointerdown", (e) => e.preventDefault());
        option.addEventListener("mousedown", (e) => e.preventDefault());
        option.addEventListener("click", () => pick(s));
        return option;
      }),
    );
    highlight(-1);
    place();
    list.hidden = false;
    field.setAttribute("aria-expanded", "true");
  };

  field.addEventListener("input", (e) => {
    if (!e.isTrusted) return; // filled in by pick(), not typed
    const text = field.value;
    window.clearTimeout(timer);
    request?.abort();
    if (text.trim().length < MIN_LETTERS || notAPlace(text) || text === picked || text.includes("\n")) return close();
    timer = window.setTimeout(() => {
      request = new AbortController();
      const asked = text;
      suggest(text, request.signal)
        .then((found) => field.value === asked && show(found))
        .catch(() => {}); // offline or stopped: just no suggestions
    }, PAUSE_MS);
  });
  field.addEventListener("keydown", (e: Event) => {
    if (!(e instanceof KeyboardEvent)) return;
    if (list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // Past the last or first: back to what you typed (none chosen).
      const next = active + (e.key === "ArrowDown" ? 1 : -1);
      highlight(next >= shown.length ? -1 : next < -1 ? shown.length - 1 : next);
    } else if (e.key === "Enter" && active >= 0) {
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
  // Scrolling the form moves the field away from the list.
  window.addEventListener("scroll", () => !list.hidden && place(), true);
  window.addEventListener("resize", () => !list.hidden && place());
}

/** For an address box with lines: the street, then the town, state and ZIP. */
function multiline(s: PlaceSuggestion): string {
  const regionZip = [s.state, s.zip].filter(Boolean).join(" ");
  const last = [s.town, regionZip].filter(Boolean).join(", ");
  return [s.street || s.name || "", last, s.country].filter(Boolean).join("\n");
}
