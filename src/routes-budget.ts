// The free-tier cap for Google Routes lookups. The same rules as
// src-tauri/src/leave.rs: every attempt counts, the day and the month reset
// on Pacific time, and a limit can never be unlimited.
//
// Traffic-aware Compute Routes is the Pro SKU: 5,000 free successful
// requests a month (pricing list checked 2026-10-31). 80 × 31 = 2,480, under
// half of that. 160 × 31 = 4,960, just under 5,000.

export const FREE_ROUTES_PER_MONTH = 5_000;
export const DEFAULT_DAILY = 80;
export const DEFAULT_MONTHLY = 2_500;
export const MAX_DAILY = 160;
export const MAX_MONTHLY = 4_000;

/**
 * A drive longer than this (4 hours) almost always means an address was
 * matched in the wrong place. A street with no town is the usual cause:
 * "10 Mill Park Ct" is a house in Greenville and also a street in Virginia,
 * Delaware, and Illinois, and the wrong one is many hours away. No leave-by
 * time is given for it. Kept in step with MAX_PLAUSIBLE_DRIVE in leave.rs.
 */
export const MAX_PLAUSIBLE_DRIVE_MINUTES = 240;
/**
 * How close a vague address must be to a known point (the other end of the
 * drive, or this device) before that match is trusted. Farther than this,
 * same-named streets are different places. Kept in step with ANCHOR_KM in
 * src-tauri/src/anchor.rs.
 */
export const ANCHOR_KM = 80;

const LOOKUP_HORIZON_MS = 48 * 60 * 60 * 1000;
/** A lookup that failed (no internet, Google busy) is asked again after this. */
const FAILURE_TTL_MS = 10 * 60 * 1000;
/** A place Google can't drive to isn't asked again for this long. Kept in step with leave.rs. */
const NO_ROUTE_TTL_MS = 12 * 60 * 60 * 1000;
/** A drive from where you are is used again within this many kilometres of where it was asked from. */
export const NEARBY_KM = 2;
const REFINE_GAP_MINUTES = 10;

export interface Usage {
  /** "YYYY-MM-DD" in America/Los_Angeles. */
  day: string;
  dayCount: number;
  /** "YYYY-MM" in America/Los_Angeles. */
  month: string;
  monthCount: number;
}

export interface Limits {
  daily: number;
  monthly: number;
}

export type Charge =
  | { kind: "allowed"; usage: Usage }
  | { kind: "daily"; usage: Usage }
  | { kind: "monthly"; usage: Usage };

/** The Pacific date Google uses for daily quotas, as "YYYY-MM-DD". */
export function pacificDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function pacificMonth(day: string): string {
  return day.slice(0, 7);
}

export function emptyUsage(now: Date): Usage {
  const day = pacificDate(now);
  return { day, dayCount: 0, month: pacificMonth(day), monthCount: 0 };
}

/** A number from Settings, kept inside the range that cannot be unlimited. */
export function clampLimits(daily: number, monthly: number): Limits {
  const whole = (value: number, max: number, fallback: number) => {
    if (!Number.isInteger(value) || value < 0) return fallback;
    return Math.min(value, max);
  };
  return {
    daily: whole(daily, MAX_DAILY, DEFAULT_DAILY),
    monthly: whole(monthly, MAX_MONTHLY, DEFAULT_MONTHLY),
  };
}

/** Drop a finished day or month before deciding. A new month clears both. */
export function roll(usage: Usage, today: string): Usage {
  const month = pacificMonth(today);
  if (usage.month !== month) return { day: today, dayCount: 0, month, monthCount: 0 };
  if (usage.day !== today) return { ...usage, day: today, dayCount: 0 };
  return usage;
}

/**
 * Count one Routes attempt if both caps still have room. A failure counts
 * the same as a success: record the attempt, then send.
 */
export function charge(usage: Usage, today: string, limits: Limits): Charge {
  const rolled = roll(usage, today);
  if (rolled.monthCount >= limits.monthly) return { kind: "monthly", usage: rolled };
  if (rolled.dayCount >= limits.daily) return { kind: "daily", usage: rolled };
  return {
    kind: "allowed",
    usage: { ...rolled, dayCount: rolled.dayCount + 1, monthCount: rolled.monthCount + 1 },
  };
}

export function capped(usage: Usage, today: string, limits: Limits): "none" | "day" | "month" {
  const rolled = roll(usage, today);
  if (rolled.monthCount >= limits.monthly) return "month";
  if (rolled.dayCount >= limits.daily) return "day";
  return "none";
}

/** Whether `place` is somewhere you'd travel to. Kept in step with leave.rs. */
export function isPhysical(place: string): boolean {
  const text = place.trim().toLowerCase();
  if (!text || text.includes("://")) return false;
  return !["zoom", "meet.google", "teams", "webex", "facetime", "online", "virtual", "phone", "call"].some((word) =>
    text.includes(word),
  );
}

/**
 * Where you are, as a starting point: "@42.447,-71.227", rounded to about
 * 100 m so a little GPS wobble doesn't ask Google again. Kept in step with
 * spot_origin in leave.rs.
 */
export function spotOrigin(latitude: number, longitude: number): string {
  return `@${latitude.toFixed(3)},${longitude.toFixed(3)}`;
}

/** The coordinates in a spotOrigin; null for an address. */
export function parseSpot(origin: string): { latitude: number; longitude: number } | null {
  const m = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(origin.trim());
  if (!m) return null;
  const [latitude, longitude] = [Number(m[1]), Number(m[2])];
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}

/**
 * An address resolved to a point, "geo:34.86739,-82.42850". Not the device:
 * those stay "@lat,lng" and share one cache slot. Kept in step with
 * `geo_pin` in src-tauri/src/anchor.rs.
 */
export function geoPin(latitude: number, longitude: number): string {
  return `geo:${latitude.toFixed(5)},${longitude.toFixed(5)}`;
}

/** The coordinates in a geoPin; null for an address or a device spot. */
export function parseGeoPin(value: string): { latitude: number; longitude: number } | null {
  const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/i.exec(value.trim());
  if (!m) return null;
  const [latitude, longitude] = [Number(m[1]), Number(m[2])];
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}

/** The Routes waypoint: coordinates for a resolved point or where you are, otherwise the address. */
export function waypoint(origin: string): Record<string, unknown> {
  const spot = parseSpot(origin) ?? parseGeoPin(origin);
  return spot ? { location: { latLng: spot } } : { address: origin };
}

/**
 * Where a drive starts: the event's own address, else where you are (when
 * known and wanted), else the address in Settings.
 */
export function pickOrigin(eventOverride: string | null | undefined, here: string | null, defaultAddress: string): string | null {
  // Rounded again here, so the cache key is the same whatever the page sent.
  const spot = here ? parseSpot(here) : null;
  return resolveOrigin(eventOverride, spot ? spotOrigin(spot.latitude, spot.longitude) : defaultAddress);
}

/** An address in its four parts, as AutoFill fills them. */
export interface AddressParts {
  street: string;
  town: string;
  state: string;
  zip: string;
}

/** "10 Battle Rd", "Lexington", "MA", "02421" → "10 Battle Rd, Lexington, MA 02421". */
export function joinAddress(parts: AddressParts): string {
  const last = [parts.state.trim(), parts.zip.trim()].filter(Boolean).join(" ");
  return [parts.street.trim(), parts.town.trim(), last].filter(Boolean).join(", ");
}

/** The other way, for an address saved as one line. Anything unclear stays in the street. */
export function splitAddress(address: string): AddressParts {
  const parts = address
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  // A country at the end isn't one of the four.
  if (parts.length > 3 && /^(united states( of america)?|usa?)$/i.test(parts[parts.length - 1])) parts.pop();
  const empty = { street: "", town: "", state: "", zip: "" };
  if (parts.length === 0) return empty;
  const tail = /^(.*?)\s*(\d{5}(?:-\d{4})?)?$/.exec(parts[parts.length - 1])!;
  if (parts.length >= 3) {
    return { street: parts.slice(0, -2).join(", "), town: parts[parts.length - 2], state: tail[1], zip: tail[2] ?? "" };
  }
  if (parts.length === 2) return { ...empty, street: parts[0], town: parts[1] };
  return { ...empty, street: parts[0] };
}

export function resolveOrigin(eventOverride: string | null | undefined, defaultAddress: string): string | null {
  const own = eventOverride?.trim();
  if (own) return own;
  const fallback = defaultAddress.trim();
  return fallback || null;
}

/** Worth a lookup only inside 48 hours, and not after the event has started. */
export function shouldQuery(now: Date, arrive: Date): boolean {
  const until = arrive.getTime() - now.getTime();
  return until > 0 && until <= LOOKUP_HORIZON_MS;
}

/** How long a drive stays usable: closer events are asked again sooner. Kept in step with fresh_for in leave.rs. */
export function freshFor(untilArrivalMs: number): number {
  const minute = 60_000;
  if (untilArrivalMs <= 45 * minute) return 10 * minute;
  if (untilArrivalMs <= 3 * 60 * minute) return 30 * minute;
  if (untilArrivalMs <= 12 * 60 * minute) return 2 * 60 * minute;
  return 12 * 60 * minute;
}

/** What a lookup came to: driving minutes, "noRoute" (Google found no drive), or "failed". */
export type Saved = number | "noRoute" | "failed";

/** Whether a saved answer can still be used. Once it's time to leave, the drive is kept. */
export function stillFresh(fetched: Date, now: Date, arrive: Date, saved: Saved): boolean {
  const age = now.getTime() - fetched.getTime();
  if (age < 0) return false;
  if (saved === "failed") return age < FAILURE_TTL_MS;
  if (saved === "noRoute") return age < NO_ROUTE_TTL_MS;
  // Too long to be a local trip: keep it only for a while, then ask again.
  // The usual "you're already leaving, so keep the drive" rule must not apply.
  // A 9 hour mismatch would otherwise stick until the event, because its
  // bogus leave time is already in the past.
  if (saved > MAX_PLAUSIBLE_DRIVE_MINUTES) return age < NO_ROUTE_TTL_MS;
  if (now.getTime() >= arrive.getTime() - saved * 60_000) return true;
  return age < freshFor(arrive.getTime() - now.getTime());
}

/** Kilometres between two points (near enough, for a few kilometres). */
export function kmBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const lat = (((a.latitude + b.latitude) / 2) * Math.PI) / 180;
  const dy = (a.latitude - b.latitude) * 111.32;
  const dx = (a.longitude - b.longitude) * 111.32 * Math.cos(lat);
  return Math.hypot(dx, dy);
}

/** The last drive's length before arrival (so it rarely needs asking twice), else half an hour; never in the past. */
export function firstDeparture(now: Date, arrive: Date, previous: number | null = null): Date {
  const soonest = now.getTime() + 60_000;
  const guess = arrive.getTime() - (previous ?? 30) * 60_000;
  return new Date(Math.max(guess, soonest));
}

/** One refinement when the drive would change the departure by more than 10 minutes. */
export function judge(queried: Date, travelMinutes: number, arrive: Date, now: Date, refined: boolean): Date | "done" {
  const depart = arrive.getTime() - travelMinutes * 60_000;
  const gap = Math.abs(depart - queried.getTime()) / 60_000;
  const soonest = now.getTime() + 30_000;
  if (!refined && gap > REFINE_GAP_MINUTES && depart >= soonest) return new Date(depart);
  return "done";
}

/**
 * Whether an address names its town or ZIP: "10 Battle Rd" alone can match
 * a street with that name anywhere. A comma, or a 5-digit ZIP, counts.
 */
export function looksComplete(address: string): boolean {
  const text = address.trim();
  return !text || text.includes(",") || /\b\d{5}(?:-\d{4})?\b/.test(text);
}

/**
 * `"165s"` or `"165.4s"` → whole minutes, rounded up. Routes always reports
 * seconds with an "s" on the end (a 20 minute drive is `"1200s"`, not 1200
 * minutes). Anything else is not a duration.
 */
export function parseDuration(raw: string): number | null {
  const body = raw.trim().match(/^(\d+(?:\.\d+)?)s$/);
  if (!body) return null;
  const seconds = Number(body[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds / 60);
}

/** One place a free geocoder returned. `label` is a short address a person can check. */
export interface GeoHit {
  latitude: number;
  longitude: number;
  label: string;
}

/**
 * Which hit is safe to route from. With a known point nearby, the closest
 * hit within ANCHOR_KM. With none, only a single hit: two streets of the
 * same name are not a guess. Kept in step with `choose_hit` in anchor.rs.
 */
export function chooseHit(hits: GeoHit[], bias: { latitude: number; longitude: number } | null): GeoHit | null {
  const usable = hits.filter((hit) => Number.isFinite(hit.latitude) && Number.isFinite(hit.longitude) && Math.abs(hit.latitude) <= 90 && Math.abs(hit.longitude) <= 180);
  if (bias) {
    const near = usable
      .map((hit) => ({ hit, km: kmBetween(hit, bias) }))
      .filter((row) => row.km <= ANCHOR_KM)
      .sort((a, b) => a.km - b.km);
    return near[0]?.hit ?? null;
  }
  return usable.length === 1 ? usable[0] : null;
}

/** Nominatim's viewbox, "left,top,right,bottom", about `km` around `bias`. A hint, not a hard box. */
export function nominatimViewbox(bias: { latitude: number; longitude: number }, km = ANCHOR_KM): string {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.max(0.2, Math.abs(Math.cos((bias.latitude * Math.PI) / 180))));
  return `${bias.longitude - dLon},${bias.latitude + dLat},${bias.longitude + dLon},${bias.latitude - dLat}`;
}

/** A Nominatim row, the fields leave-by uses. */
export interface NominatimPlace {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  address?: Record<string, string>;
}

/** "1207 Haywood Road, Wade Hampton, SC 29615", with the place's name in front when it has one. */
export function nominatimLabel(place: NominatimPlace): string {
  const address = place.address ?? {};
  const region = (address["ISO3166-2-lvl4"] ?? "").split("-").pop() || address.state || "";
  const town = address.city || address.town || address.village || address.hamlet || "";
  const street = [address.house_number, address.road].filter(Boolean).join(" ");
  const name = place.name && place.name !== street ? place.name : "";
  const line = [name, street, town, [region, address.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const text = (line || place.display_name || "").trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** Nominatim's JSON list as hits. A row without coordinates is dropped. */
export function nominatimHits(body: unknown): GeoHit[] {
  if (!Array.isArray(body)) return [];
  const hits: GeoHit[] = [];
  for (const row of body) {
    if (!row || typeof row !== "object") continue;
    const place = row as NominatimPlace;
    const latitude = Number(place.lat);
    const longitude = Number(place.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const label = nominatimLabel(place);
    if (!label) continue;
    hits.push({ latitude, longitude, label });
  }
  return hits;
}

export interface AnchoredEnd {
  /** What Routes is asked for: an address, "@lat,lng", or a geo pin. */
  waypoint: string;
  /** The place that was matched, when a vague address had to be resolved. */
  label: string | null;
}

export type AnchorResult =
  | { kind: "ready"; origin: AnchoredEnd; destination: AnchoredEnd }
  | { kind: "vague" }
  | { kind: "unavailable" };

/** Hits for one address, or "failed" when the geocoder didn't answer. Empty is a real "nothing matched". */
export type GeoLookup = (query: string, bias: { latitude: number; longitude: number } | null) => Promise<GeoHit[] | "failed">;

/**
 * Turn vague ends ("10 Mill Park Ct", a place name with no town) into points
 * before Google geocodes them on its own. A full address is left as written.
 * Device location wins as the hint, then the other end. Neither: a vague
 * address is not guessed. Kept in step with `anchor_ends` in anchor.rs.
 */
export async function anchorEnds(origin: string, destination: string, device: { latitude: number; longitude: number } | null, lookup: GeoLookup): Promise<AnchorResult> {
  const originCoord = parseSpot(origin) ?? parseGeoPin(origin);
  const destCoord = parseSpot(destination) ?? parseGeoPin(destination);
  const originVague = !originCoord && !looksComplete(origin);
  const destVague = !destCoord && !looksComplete(destination);
  if (!originVague && !destVague) {
    return { kind: "ready", origin: { waypoint: origin, label: null }, destination: { waypoint: destination, label: null } };
  }

  let failed = false;
  const take = async (query: string, bias: { latitude: number; longitude: number } | null): Promise<GeoHit | null> => {
    const hits = await lookup(query, bias);
    if (hits === "failed") {
      failed = true;
      return null;
    }
    return chooseHit(hits, bias);
  };

  let originHit: GeoHit | null = originCoord ? { ...originCoord, label: "" } : null;
  let destHit: GeoHit | null = destCoord ? { ...destCoord, label: "" } : null;

  // A place name is often unique in the world. Try near the device first, then anywhere.
  if (destVague) {
    destHit = await take(destination, device);
    if (!failed && !destHit && device) destHit = await take(destination, null);
  }
  if (failed) return { kind: "unavailable" };

  if (originVague) {
    let bias = device ?? destHit;
    if (!bias && !destVague) {
      destHit = await take(destination, null);
      bias = destHit;
    }
    if (failed) return { kind: "unavailable" };
    originHit = await take(origin, bias);
    if (!failed && !originHit && bias) originHit = await take(origin, null);
  }
  if (failed) return { kind: "unavailable" };

  if (destVague && !destHit) {
    let bias = device ?? (originHit && originVague ? originHit : null);
    if (!bias && !originVague) {
      originHit = await take(origin, null);
      bias = originHit;
    }
    if (failed) return { kind: "unavailable" };
    if (bias) destHit = await take(destination, bias);
    if (!failed && !destHit && bias) destHit = await take(destination, null);
  }
  if (failed) return { kind: "unavailable" };

  if (originVague && !originHit && destHit) {
    originHit = await take(origin, destHit);
    if (failed) return { kind: "unavailable" };
  }

  if ((originVague && !originHit) || (destVague && !destHit)) return { kind: "vague" };

  const end = (text: string, vague: boolean, hit: GeoHit | null): AnchoredEnd =>
    vague && hit ? { waypoint: geoPin(hit.latitude, hit.longitude), label: hit.label || null } : { waypoint: text, label: hit?.label || null };
  return { kind: "ready", origin: end(origin, originVague, originHit), destination: end(destination, destVague, destHit) };
}
