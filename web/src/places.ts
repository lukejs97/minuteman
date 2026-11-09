// Place search with TomTom, when OpenStreetMap (searched by the page with
// Photon) doesn't know a place by the name typed. A port of
// src-tauri/src/places.rs: the key is a Cloudflare secret, every attempt is
// counted first (100 a day, 1,500 a month), and TomTom's free tier needs no
// card and turns requests down past it, so it never costs anything.
import type { FoundPlace } from "../../src/api";
import { charge, emptyUsage, pacificDate, type Usage } from "../../src/routes-budget";
import type { Env } from "./env";
import { readRoutesUsage, writeRoutesUsage } from "./store";

const DISCOVER_URL = "https://api.tomtom.com/maps/orbis/places/discover";
const SEARCH_URL = "https://api.tomtom.com/search/2/search/";
export const PLACES_DAILY = 100;
export const PLACES_MONTHLY = 1_500;
const LIMITS = { daily: PLACES_DAILY, monthly: PLACES_MONTHLY };
const LIMIT = 5;
const USAGE_KEY = "placesUsage";

type Json = Record<string, unknown>;
type Answer = FoundPlace[] | "overLimit" | "unexpected";

export interface Near {
  latitude: number;
  longitude: number;
}

/** Counts one attempt, saved before it's sent; false at the cap (or if it can't be saved). */
async function spend(env: Env): Promise<boolean> {
  const usage = (await readRoutesUsage(env, USAGE_KEY)) ?? emptyUsage(new Date());
  const next = charge(usage, pacificDate(new Date()), LIMITS);
  try {
    await writeRoutesUsage(env, next.usage, USAGE_KEY);
  } catch {
    return false;
  }
  return next.kind === "allowed";
}

export async function placesUsage(env: Env): Promise<{ dayCount: number; dayLimit: number; monthCount: number; monthLimit: number }> {
  const usage: Usage = (await readRoutesUsage(env, USAGE_KEY)) ?? emptyUsage(new Date());
  const today = pacificDate(new Date());
  return {
    dayCount: usage.day === today ? usage.dayCount : 0,
    dayLimit: PLACES_DAILY,
    monthCount: usage.month === today.slice(0, 7) ? usage.monthCount : 0,
    monthLimit: PLACES_MONTHLY,
  };
}

/** Places by name near `near`; empty without a key, past the cap, or when TomTom doesn't answer. */
export async function searchPlaces(env: Env, query: string, near: Near | null): Promise<FoundPlace[]> {
  const key = env.MINUTEMAN_TOMTOM_API_KEY?.trim();
  const text = query.trim();
  if (!key || text.length < 3 || text.length > 120) return [];
  if (!(await spend(env))) return [];
  const first = await discover(key, text, near);
  if (first === "overLimit") return [];
  if (first !== "unexpected") return first;
  if (!(await spend(env))) return [];
  const second = await olderSearch(key, text, near);
  return Array.isArray(second) ? second : [];
}

async function discover(key: string, query: string, near: Near | null): Promise<Answer> {
  let response: Response;
  try {
    response = await fetch(DISCOVER_URL, {
      method: "POST",
      headers: {
        "TomTom-Api-Key": key,
        "TomTom-Api-Version": "3",
        Attributes: "results(title,subtitles,position,address)",
        "Accept-Language": "en-US,en",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        maxResults: LIMIT,
        filters: { types: ["poi", "address", "street"] },
        ...(near ? { preferences: { geometry: { type: "point", coordinates: [near.longitude, near.latitude] } } } : {}),
      }),
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return "unexpected";
  }
  if (response.status === 429) return "overLimit";
  if (!response.ok) return "unexpected";
  const body = (await response.json().catch(() => null)) as Json | null;
  return parseDiscover(body) ?? "unexpected";
}

/** Places Search's answer (`results` with title, subtitles, position, address); null when it isn't that. */
export function parseDiscover(body: Json | null): FoundPlace[] | null {
  const results = body?.results;
  if (!Array.isArray(results)) return null;
  const found: FoundPlace[] = [];
  for (const result of results as Json[]) {
    const subtitles = Array.isArray(result.subtitles) ? (result.subtitles as unknown[]).filter((s): s is string => typeof s === "string") : [];
    let place = fromAddress((result.address as Json) ?? {});
    if (!place.street && !place.town) {
      const line = subtitles.find((s) => s.includes(","));
      if (line) place = fromLine(line);
    }
    const coordinates = (result.position as Json | undefined)?.coordinates;
    if (Array.isArray(coordinates)) {
      place.longitude = typeof coordinates[0] === "number" ? coordinates[0] : null;
      place.latitude = typeof coordinates[1] === "number" ? coordinates[1] : null;
    }
    const title = typeof result.title === "string" ? result.title.trim() : "";
    place.name = title && title !== place.street ? title : null;
    if (place.name || place.street || place.town) found.push(place);
  }
  return found.slice(0, LIMIT);
}

async function olderSearch(key: string, query: string, near: Near | null): Promise<Answer> {
  const url = new URL(`${SEARCH_URL}${encodeURIComponent(query)}.json`);
  url.searchParams.set("key", key);
  url.searchParams.set("typeahead", "true");
  url.searchParams.set("limit", String(LIMIT));
  url.searchParams.set("idxSet", "POI,PAD,Addr,Str");
  url.searchParams.set("language", "en-US");
  if (near) {
    url.searchParams.set("lat", String(near.latitude));
    url.searchParams.set("lon", String(near.longitude));
  }
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  } catch {
    return "unexpected";
  }
  // The older API says "over the limit" with 403 (and 429).
  if (response.status === 403 || response.status === 429) return "overLimit";
  if (!response.ok) return "unexpected";
  const body = (await response.json().catch(() => null)) as Json | null;
  return parseOlder(body) ?? "unexpected";
}

/** The older Search API's answer (`results` with poi.name, address, position {lat, lon}). */
export function parseOlder(body: Json | null): FoundPlace[] | null {
  const results = body?.results;
  if (!Array.isArray(results)) return null;
  const found: FoundPlace[] = [];
  for (const result of results as Json[]) {
    if (!result.address) continue;
    const place = fromAddress(result.address as Json);
    const name = ((result.poi as Json | undefined)?.name as string | undefined)?.trim();
    place.name = name || null;
    const position = result.position as Json | undefined;
    place.latitude = typeof position?.lat === "number" ? position.lat : null;
    place.longitude = typeof position?.lon === "number" ? position.lon : null;
    if (place.name || place.street || place.town) found.push(place);
  }
  return found.slice(0, LIMIT);
}

const firstOf = (address: Json, keys: string[]) =>
  keys.map((k) => address[k]).find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim() ?? "";

/** An address in parts, under the names TomTom's APIs use. */
function fromAddress(address: Json): FoundPlace {
  const country = firstOf(address, ["countryCodeIso2", "countryCode"]).toUpperCase();
  const us = country === "US" || country === "USA";
  const place: FoundPlace = {
    name: null,
    street: [firstOf(address, ["streetNumber", "houseNumber"]), firstOf(address, ["streetName", "street"])].filter(Boolean).join(" "),
    town: firstOf(address, ["municipality", "locality", "city", "localName"]),
    state: us
      ? firstOf(address, ["countrySubdivisionCode", "countrySubdivision", "region"])
      : firstOf(address, ["countrySubdivisionName", "countrySubdivision", "region"]),
    zip: firstOf(address, ["postalCode", "extendedPostalCode"]),
    country: us || !country ? "" : firstOf(address, ["country", "countryName"]),
    latitude: null,
    longitude: null,
  };
  if (!place.street && !place.town) {
    const line = firstOf(address, ["freeformAddress", "formattedAddress", "freeform"]);
    if (line) {
      const parsed = fromLine(line);
      place.street = parsed.street;
      place.town = parsed.town;
      place.state ||= parsed.state;
      place.zip ||= parsed.zip;
    }
  }
  // "US-NC" → "NC".
  if (place.state.includes("-")) place.state = place.state.split("-").pop()!;
  return place;
}

/** "3030 Burke Mill Rd, Winston-Salem, NC 27103" (maybe ", United States") in parts. */
function fromLine(line: string): FoundPlace {
  const parts = line.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 2 && /^(united states( of america)?|usa?)$/i.test(parts.at(-1)!)) parts.pop();
  const place: FoundPlace = { name: null, street: "", town: "", state: "", zip: "", country: "", latitude: null, longitude: null };
  if (parts.length === 1) place.street = parts[0];
  else if (parts.length === 2) [place.street, place.town] = parts;
  else if (parts.length > 2) {
    place.street = parts.slice(0, -2).join(", ");
    place.town = parts.at(-2)!;
    const last = /^(.*?)\s+(\S*\d\S*)$/.exec(parts.at(-1)!);
    place.state = (last ? last[1] : parts.at(-1)!).trim();
    place.zip = last ? last[2] : "";
  }
  return place;
}
