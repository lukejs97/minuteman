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
import { isTauri } from "@tauri-apps/api/core";
import { type Contact, getContacts, getPreferences, getSavedContacts } from "./api";
import { el } from "./dom";
import { splitAddress } from "./routes-budget";
import { placeOnOneLine } from "./time";
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
  /** A contact's address: whose, and which ("Samuel Adams · Home"). */
  contact?: string;
}

interface PhotonFeature {
  /** [longitude, latitude] */
  geometry?: { coordinates?: [number, number] };
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
    /** What it is in OpenStreetMap: "highway" + "bus_stop", "amenity" + "cafe"… */
    osm_key?: string;
    osm_value?: string;
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

/**
 * A Photon result as a suggestion; null for whole countries, states and the
 * like. `houseNumber`, typed before the street ("20 Nora Dr"), goes in front
 * of a street found without one: OpenStreetMap often has the street but not
 * each house on it.
 */
export function toSuggestion(
  feature: PhotonFeature,
  houseNumber: string | null = null,
  postalTowns: Map<string, string> = new Map(),
): PlaceSuggestion | null {
  const p = feature.properties;
  if (p.type && ["country", "state", "county"].includes(p.type)) return null;
  const us = p.countrycode?.toUpperCase() === "US";
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  // No city, town or village (outside any town's limits): the mailing
  // address's town, from the ZIP (`postalTown`), rather than the
  // neighborhood OpenStreetMap has.
  const postal = us && p.postcode ? postalTowns.get(p.postcode) : undefined;
  const town = p.city ?? p.town ?? p.village ?? postal ?? p.district ?? "";
  const state = (us && p.state && US_STATES[p.state]) || p.state || "";
  const zip = p.postcode ?? "";
  // A street on its own comes as its name; an address has none, or its
  // number and street again. Shops, churches and the like (also type
  // "house") keep theirs.
  const isStreet = p.type === "street";
  const name = p.name && !isStreet && p.name !== street && p.name !== p.street ? p.name : null;
  let streetPart = street || (isStreet ? (p.name ?? "") : "");
  if (houseNumber && isStreet && !p.housenumber && streetPart) streetPart = `${houseNumber} ${streetPart}`;
  const regionZip = [state, zip].filter(Boolean).join(" ");
  const country = us ? "" : (p.country ?? "");
  const line = [name, streetPart, town !== name ? town : "", regionZip, country].filter(Boolean).join(", ");
  if (!line) return null;
  return { name, street: streetPart, town, state, zip, country, line };
}

const cache = new Map<string, PlaceSuggestion[]>();

interface Spot {
  latitude: number;
  longitude: number;
}

/** Results this far away (km) come after the nearer ones. */
const NEAR_KM = 150;

/** Places and addresses matching `text`, the ones near you first. */
async function suggest(text: string, signal: AbortSignal): Promise<PlaceSuggestion[]> {
  const key = text.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const near = await nearYou();
  const query = text.trim();
  const houseNumber = /^(\d+[a-z]?)\s+\S/i.exec(query)?.[1] ?? null;
  // Near you: a search of just the area around you, as well as the usual
  // one, so a house on your street isn't crowded out by better-known
  // matches far away. With a house number, the area is also searched for
  // the street alone ("Nora" for "20 Nora"): OpenStreetMap often has the
  // street but not each house, and a number that matches nothing there
  // can keep the street from being found at all.
  const street = houseNumber ? query.slice(houseNumber.length).trim() : "";
  const area = near ? areaAround(near) : null;
  const [local, localStreets, everywhere] = await Promise.all([
    area ? photon(query, LIMIT, near, signal, area).catch(() => []) : Promise.resolve([]),
    area && street.length >= 3 ? photon(street, LIMIT, near, signal, area).catch(() => []) : Promise.resolve([]),
    photon(query, LIMIT + 4, near, signal),
  ]);
  // Bus stops and platforms ("Poinsett Hwy @ Nora Dr") are named after the
  // street they're on, so they match a typed address well, but they're
  // seldom where you're going.
  const features = [...local.slice(0, 4), ...localStreets.slice(0, 3), ...everywhere].filter((f) => !isStop(f));
  const hasNumber = (f: PhotonFeature) => !!houseNumber && f.properties.housenumber?.toLowerCase() === houseNumber.toLowerCase();
  // That very house found on a street: that street doesn't also get the
  // number put in front (two of the same address).
  const sameStreet = (f: PhotonFeature) =>
    `${(f.properties.street ?? f.properties.name ?? "").toLowerCase()}|${f.properties.postcode ?? ""}`;
  const housesFound = new Set(features.filter(hasNumber).map(sameStreet));
  // A town or ZIP typed ("…, Taylorsville, NC 28681") says where: results
  // there come before anything near you.
  // The town counts only after a comma, as an address is written: "Bethel
  // Church Road" isn't asking for the town of Bethel.
  const typed = query.includes(",") ? words(query.slice(query.indexOf(",") + 1)) : [];
  const zipTyped = /\b(\d{5})(?:-\d{4})?\b/.exec(query)?.[1] ?? null;
  const inTypedPlace = (f: PhotonFeature) => {
    const p = f.properties;
    if (zipTyped && p.postcode?.startsWith(zipTyped)) return true;
    const town = words(p.city ?? p.town ?? p.village ?? p.district ?? "");
    // The town's every word typed (the last may be typed in part: "Taylorsv").
    return town.length > 0 && town.every((w) => typed.some((t) => w === t || (t.length >= 3 && w.startsWith(t) && t === typed.at(-1))));
  };
  // The very address typed: its house number, and every word of its street
  // ("Rd" for "Road" and so on). It comes before a place nearby that only
  // shares a word ("Bethel … Church" for "1509 Bethel Church Road").
  const typedStreet = words(query.split(",")[0]).map(shortStreetWord);
  const fullAddress = (f: PhotonFeature) => {
    if (!hasNumber(f) || !f.properties.street) return false;
    const want = words(f.properties.street).map(shortStreetWord);
    return want.length > 0 && want.every((w) => typedStreet.some((t) => w === t || (t.length >= 2 && w.startsWith(t))));
  };
  const ranked = features.map((feature, order) => {
    const [lon, lat] = feature.geometry?.coordinates ?? [NaN, NaN];
    const far = near && Number.isFinite(lat) ? kmBetween(near, { latitude: lat, longitude: lon }) > NEAR_KM : false;
    return { feature, order, far, exact: hasNumber(feature), there: inTypedPlace(feature), full: fullAddress(feature) };
  });
  // Something matches near you: other countries are left out (a 20 Via Nora
  // in Italy isn't what someone in South Carolina means by "20 Nora").
  const nearCountries = new Set(ranked.filter((r) => !r.far).map((r) => r.feature.properties.countrycode?.toUpperCase()));
  const kept = (
    near && nearCountries.size > 0
      ? ranked.filter((r) => !r.far || r.there || nearCountries.has(r.feature.properties.countrycode?.toUpperCase()))
      : ranked
  )
    // The house found: the bare street it's on isn't needed as well.
    .filter((r) => !(r.feature.properties.type === "street" && housesFound.has(sameStreet(r.feature))));
  // Mailing towns for US addresses outside any town's limits.
  const needed = features
    .map((f) => f.properties)
    .filter((p) => p.countrycode?.toUpperCase() === "US" && p.postcode && !p.city && !p.town && !p.village)
    .map((p) => p.postcode!);
  const towns = new Map<string, string>();
  await Promise.all(
    [...new Set(needed)].map(async (zip) => {
      const town = await postalTown(zip);
      if (town) towns.set(zip, town);
    }),
  );
  // In the town or ZIP typed first, then near you; among those, the very
  // house typed; otherwise as Photon ranked them.
  kept.sort(
    (a, b) =>
      Number(b.there) - Number(a.there) ||
      Number(b.full) - Number(a.full) ||
      Number(a.far) - Number(b.far) ||
      Number(b.exact) - Number(a.exact) ||
      a.order - b.order,
  );
  const seen = new Set<string>();
  const found = kept
    .map(({ feature }) => toSuggestion(feature, housesFound.has(sameStreet(feature)) ? null : houseNumber, towns))
    .filter((s): s is PlaceSuggestion => !!s && !seen.has(s.line) && !!seen.add(s.line))
    .slice(0, LIMIT);
  cache.set(key, found);
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return found;
}

/** A street word as it's usually shortened ("road" → "rd"), so "Rd" and "Road" match. */
const STREET_WORDS: Record<string, string> = {
  road: "rd", drive: "dr", street: "st", avenue: "ave", av: "ave", court: "ct", lane: "ln", circle: "cir",
  boulevard: "blvd", highway: "hwy", place: "pl", parkway: "pkwy", terrace: "ter", trail: "trl", way: "wy",
  north: "n", south: "s", east: "e", west: "w",
};
const shortStreetWord = (word: string) => STREET_WORDS[word] ?? word;

/** A bus or tram stop, or a platform: not a place to go to (stations are). */
const isStop = (f: PhotonFeature) => {
  const { osm_key: key, osm_value: value } = f.properties;
  return (
    (key === "highway" && (value === "bus_stop" || value === "platform")) ||
    (key === "public_transport" && (value === "platform" || value === "stop_position")) ||
    (key === "railway" && (value === "platform" || value === "tram_stop"))
  );
};

/** About 110 km each way around `near`, as Photon's bbox (west, south, east, north). */
function areaAround(near: Spot): string {
  const [dLat, dLon] = [1, 1 / Math.max(0.2, Math.cos((near.latitude * Math.PI) / 180))];
  return [near.longitude - dLon, near.latitude - dLat, near.longitude + dLon, near.latitude + dLat].map((n) => n.toFixed(2)).join(",");
}

async function photon(
  query: string,
  limit: number,
  near: Spot | null,
  signal?: AbortSignal,
  bbox?: string,
): Promise<PhotonFeature[]> {
  const url = new URL(PHOTON);
  if (bbox) url.searchParams.set("bbox", bbox);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  const lang = navigator.language.slice(0, 2).toLowerCase();
  if (["en", "de", "fr", "it"].includes(lang)) url.searchParams.set("lang", lang);
  if (near) {
    // To about a kilometre: enough to put nearby places first.
    url.searchParams.set("lat", near.latitude.toFixed(2));
    url.searchParams.set("lon", near.longitude.toFixed(2));
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Place search unavailable (${response.status})`);
  return ((await response.json()) as { features?: PhotonFeature[] }).features ?? [];
}

const ZIP_TOWNS_KEY = "calendar.zipTowns";

/**
 * The town a US ZIP code's mail goes to ("29609" → "Greenville"), as an
 * address is written. From Zippopotam.us (free, no key); only the ZIP is
 * sent, once, and kept on this device. Null if it can't be found quickly.
 */
async function postalTown(zip: string): Promise<string | null> {
  const five = zip.slice(0, 5);
  if (!/^\d{5}$/.test(five)) return null;
  let saved: Record<string, string> = {};
  try {
    saved = JSON.parse(localStorage.getItem(ZIP_TOWNS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    // Look it up.
  }
  if (saved[five]) return saved[five];
  try {
    const response = await fetch(`https://api.zippopotam.us/us/${five}`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const body = (await response.json()) as { places?: { "place name"?: string }[] };
    const town = body.places?.[0]?.["place name"]?.trim();
    if (!town) return null;
    saved[five] = town;
    try {
      localStorage.setItem(ZIP_TOWNS_KEY, JSON.stringify(saved));
    } catch {
      // Kept for now only.
    }
    return town;
  } catch {
    return null; // offline or slow: the neighborhood will do
  }
}

/** Straight-line distance in km. */
function kmBetween(a: Spot, b: Spot): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

// ".v2": the first version could keep a town of the same name in another state.
const BIAS_KEY = "calendar.placeSearchNear.v2";
let nearby: Promise<Spot | null> | null = null;

/**
 * Where to look first, without asking for anything new: the weather's
 * place; else the town of the Leave from address in Settings (found once,
 * and kept);
 * else this device's location, only if it's already allowed.
 */
function nearYou(): Promise<Spot | null> {
  const place = weatherSettings().place;
  if (place) return Promise.resolve(place);
  nearby ??= (async () => {
    const spot = (await leaveFromSpot().catch(() => null)) ?? (await allowedPosition().catch(() => null));
    if (!spot) nearby = null; // none yet (offline, say): try again next time
    return spot;
  })();
  return nearby;
}

async function leaveFromSpot(): Promise<Spot | null> {
  const address = (await getPreferences()).leaveFrom?.trim();
  if (!address) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(BIAS_KEY) ?? "null") as (Spot & { address: string }) | null;
    if (saved?.address === address) return saved;
  } catch {
    // Look it up again.
  }
  // Only the town and state are looked up, not the street address. Photon
  // doesn't know "SC" for South Carolina, so the state goes by its name, and
  // only a town in that state will do ("Greenville" is in several).
  const { town, state, zip } = splitAddress(address);
  const usState = Object.entries(US_STATES).find(([, code]) => code === state.trim().toUpperCase())?.[0];
  const query = town ? [town, usState ?? state.trim()].filter(Boolean).join(", ") : zip;
  if (!query) return null;
  const found = await photon(query, 5, null);
  const match = usState ? found.find((f) => f.properties.state === usState) : found[0];
  const [lon, lat] = match?.geometry?.coordinates ?? [];
  if (lat === undefined || lon === undefined) return null;
  const spot = { address, latitude: lat, longitude: lon };
  try {
    localStorage.setItem(BIAS_KEY, JSON.stringify(spot));
  } catch {
    // Kept for now only.
  }
  return spot;
}

/** This device's location, if the browser already allows it (it never asks here). */
async function allowedPosition(): Promise<Spot | null> {
  if (isTauri() || !navigator.permissions || !navigator.geolocation) return null;
  const { state } = await navigator.permissions.query({ name: "geolocation" });
  if (state !== "granted") return null;
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => resolve(null),
      { maximumAge: 60 * 60 * 1000, timeout: 5000 },
    ),
  );
}

/**
 * Contacts with an address, kept a few minutes. The ones saved on this
 * device (the desktop app's, from the last time Contacts loaded) answer
 * straight away; Google is asked too, and its answer replaces them as soon
 * as it comes (a saved copy can be days old: contacts added since were
 * missing). The website saves none, so it waits for Google.
 */
let people: { at: number; list: Promise<Contact[]> } | null = null;
function contactsWithAddresses(): Promise<Contact[]> {
  if (!people || Date.now() - people.at > 10 * 60_000) {
    const withAddresses = (all: { contacts: Contact[] }) => all.contacts.filter((c) => c.addresses.length > 0);
    const fresh = getContacts().then(withAddresses);
    const saved = getSavedContacts()
      .then((list) => (list ? withAddresses(list) : null))
      .catch(() => null);
    const at = Date.now();
    people = { at, list: saved.then((list) => list ?? fresh).catch(() => []) };
    void fresh.then(
      (list) => {
        if (people?.at === at) people = { at, list: Promise.resolve(list) };
      },
      () => {}, // offline: the saved ones will do
    );
  }
  return people.list;
}

/**
 * Addresses of contacts whose name (or nickname, or company) has every word
 * typed: "sam ad" finds Samuel Adams's. Nothing is sent anywhere for these.
 */
async function contactSuggestions(text: string): Promise<PlaceSuggestion[]> {
  const wanted = words(text);
  if (wanted.length === 0) return [];
  const found: PlaceSuggestion[] = [];
  for (const person of await contactsWithAddresses()) {
    const names = words([person.name, person.nickname, person.organization].filter(Boolean).join(" "));
    if (!wanted.every((w) => names.some((n) => n.startsWith(w)))) continue;
    for (const address of person.addresses) {
      const line = placeOnOneLine(address.value);
      if (!line) continue;
      const label = address.label ? ` · ${address.label[0].toUpperCase()}${address.label.slice(1)}` : "";
      found.push({ ...splitAddress(line), name: null, country: "", line, contact: `${person.name || person.organization}${label}` });
    }
  }
  return found.slice(0, 4);
}

/**
 * The place `text` names ("Old North Church", "starbucks", "boston", or a
 * contact: "sam adams"), if one nearby (or in Contacts) is called that;
 * null if not, or offline. For a place found in a sentence: is it one, and
 * (with a street) where it actually is.
 */
export async function findPlace(text: string): Promise<PlaceSuggestion | null> {
  const wanted = words(text);
  if (wanted.length === 0) return null;
  const person = (await contactSuggestions(text))[0];
  if (person) return person;
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
 * Suggests places under `field` as you type, and contacts' addresses
 * (unless `contacts` is false). `onPick` fills in what's picked; without
 * it, the field gets the one-line form.
 */
export function enablePlaceSuggestions(
  field: HTMLInputElement | HTMLTextAreaElement,
  onPick?: (place: PlaceSuggestion) => void,
  { contacts = true } = {},
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

  /**
   * Under the field, as wide: placed beside it in the page, so it moves with
   * the field when the form scrolls or a phone's keyboard shifts the view.
   * Above it when there's more room there than below, above the keyboard.
   */
  const place = () => {
    const host = field.parentElement!;
    if (list.parentElement !== host) {
      host.classList.add("place-suggest-host");
      field.after(list);
    }
    list.style.left = `${field.offsetLeft}px`;
    list.style.width = `${field.offsetWidth}px`;
    // What's on screen: above a phone's keyboard, not the whole page.
    const view = window.visualViewport;
    const top = view ? view.offsetTop : 0;
    const bottom = view ? view.offsetTop + view.height : window.innerHeight;
    const r = field.getBoundingClientRect();
    const [below, above] = [bottom - r.bottom - 8, r.top - top - 8];
    const wanted = Math.min(list.scrollHeight, 260);
    const up = below < wanted && above > below;
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
        const [first, ...rest] = s.contact
          ? [s.contact, s.line]
          : s.name
            ? [s.name, s.line.slice(s.name.length + 2)]
            : [s.line];
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
    list.hidden = false;
    place();
    field.setAttribute("aria-expanded", "true");
  };

  field.addEventListener("input", (e) => {
    if (!e.isTrusted) return; // filled in by pick(), not typed
    const text = field.value;
    window.clearTimeout(timer);
    request?.abort();
    // Contacts from 2 letters (they're here already); places from 3.
    const length = text.trim().length;
    if (length < (contacts ? 2 : MIN_LETTERS) || notAPlace(text) || text === picked || text.includes("\n")) return close();
    timer = window.setTimeout(() => {
      request = new AbortController();
      const asked = text;
      const people = contacts ? contactSuggestions(text) : Promise.resolve([]);
      // Contacts as soon as they're matched, then the places after them.
      void people.then((found) => field.value === asked && found.length > 0 && show(found));
      if (length < MIN_LETTERS) return;
      Promise.all([people, suggest(text, request.signal)])
        .then(([found, places]) => field.value === asked && show([...found, ...places]))
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
  // The keyboard coming or going changes the room above and below.
  window.visualViewport?.addEventListener("resize", () => !list.hidden && place());
  window.addEventListener("resize", () => !list.hidden && place());
}

/** For an address box with lines: the street, then the town, state and ZIP. */
function multiline(s: PlaceSuggestion): string {
  const regionZip = [s.state, s.zip].filter(Boolean).join(" ");
  const last = [s.town, regionZip].filter(Boolean).join(", ");
  return [s.street || s.name || "", last, s.country].filter(Boolean).join("\n");
}
