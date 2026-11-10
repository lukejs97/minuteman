// Resolving a vague address before Google's Routes geocoder sees it.
// Nominatim (OpenStreetMap) is free and takes no key. Its public server asks
// for one request a second, a real User-Agent, and that answers be kept, so
// a hit is reused for a week and a failure for ten minutes. This is not a
// Routes call and does not count against the Routes cap.
import {
  nominatimHits,
  nominatimViewbox,
  type GeoHit,
  type GeoLookup,
} from "../../src/routes-budget";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "Minuteman leave-by (https://github.com/lukejs97/minuteman)";
const OK_MS = 7 * 24 * 60 * 60 * 1000;
const FAIL_MS = 10 * 60 * 1000;
const PACE_MS = 1100;

export interface GeoCacheEntry {
  at: string;
  /** Missing when the geocoder didn't answer. */
  hits?: GeoHit[];
  failed?: boolean;
}

export type GeoCache = Record<string, GeoCacheEntry>;

/** Query plus the bias cell, so a hint in another state is a different answer. */
export function geoKey(query: string, bias: { latitude: number; longitude: number } | null): string {
  const norm = query.trim().toLowerCase().split(/\s+/).join(" ");
  const cell = bias ? `${bias.latitude.toFixed(1)},${bias.longitude.toFixed(1)}` : "-";
  return `${norm}|${cell}`;
}

export function pruneGeoCache(cache: GeoCache, now: Date): GeoCache {
  const kept: GeoCache = {};
  for (const [key, entry] of Object.entries(cache)) {
    const age = now.getTime() - new Date(entry.at).getTime();
    const limit = entry.failed ? FAIL_MS : OK_MS;
    if (age >= 0 && age < limit) kept[key] = entry;
  }
  return kept;
}

let gate: Promise<void> = Promise.resolve();
let lastAt = 0;

function pace(): Promise<void> {
  const run = gate.then(async () => {
    const wait = lastAt + PACE_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAt = Date.now();
  });
  gate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function search(query: string, bias: { latitude: number; longitude: number } | null): Promise<GeoHit[] | "failed"> {
  await pace();
  const url = new URL(NOMINATIM);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("q", query);
  if (bias) url.searchParams.set("viewbox", nominatimViewbox(bias));
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
  } catch {
    return "failed";
  }
  if (!response.ok) return "failed";
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) return "failed";
  return nominatimHits(body);
}

/**
 * A lookup that reuses `cache` (marking `dirty` when it learns something).
 * The same address in one pass doesn't ask twice.
 */
export function cachedLookup(cache: GeoCache, dirty: { current: boolean }, now: Date): GeoLookup {
  return async (query, bias) => {
    const key = geoKey(query, bias);
    const saved = cache[key];
    if (saved) {
      const age = now.getTime() - new Date(saved.at).getTime();
      const limit = saved.failed ? FAIL_MS : OK_MS;
      if (age >= 0 && age < limit) return saved.failed ? "failed" : (saved.hits ?? []);
    }
    const hits = await search(query, bias);
    cache[key] = hits === "failed" ? { at: now.toISOString(), failed: true } : { at: now.toISOString(), hits };
    dirty.current = true;
    return hits;
  };
}
