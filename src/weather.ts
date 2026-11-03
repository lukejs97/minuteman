// Weather on each day, from Open-Meteo (free, no account or key): an icon and
// the day's high and low, for a place chosen in Settings. Kept on this device
// (local storage), like the multi-day view's days; the menu bar window shares
// it with the main window.
import { isTauri } from "@tauri-apps/api/core";
import { currentLocation } from "./api";
import { isDemo } from "./demo";
import { el } from "./dom";
import { toDateString } from "./time";

const FORECAST = "https://api.open-meteo.com/v1/forecast";
const GEOCODING = "https://geocoding-api.open-meteo.com/v1/search";
const SETTINGS_KEY = "calendar.weather";
const FORECAST_KEY = "calendar.weatherForecast";
/** A forecast is fetched again after this long. */
const REFRESH_MS = 3 * 60 * 60 * 1000;

export type Unit = "fahrenheit" | "celsius";

/** A place to show the weather for. */
export interface Place {
  name: string;
  /** Region and country, to tell places with the same name apart. */
  detail: string;
  latitude: number;
  longitude: number;
  /** Wherever you are: located again each time the forecast is fetched. */
  current?: boolean;
}

export interface WeatherSettings {
  /** No place: weather is off. */
  place: Place | null;
  unit: Unit;
}

/** One day's forecast. */
export interface DayWeather {
  /** WMO weather code (see `describe`). */
  code: number;
  high: number;
  low: number;
}

interface SavedForecast {
  /** Which place and unit it's for, and when it was fetched. */
  key: string;
  fetchedAt: number;
  days: Record<string, DayWeather>;
}

/** Fahrenheit where that's what's used (the US and a few others), otherwise Celsius. */
function defaultUnit(): Unit {
  const region = new Intl.Locale(navigator.language).maximize().region;
  return region && ["US", "LR", "MM", "BS", "BZ", "KY", "PW", "FM", "MH"].includes(region) ? "fahrenheit" : "celsius";
}

export function weatherSettings(): WeatherSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<WeatherSettings> | null;
    if (saved) return { place: saved.place ?? null, unit: saved.unit ?? defaultUnit() };
  } catch {
    // Storage unavailable or unreadable: weather off.
  }
  return { place: null, unit: defaultUnit() };
}

export function setWeatherSettings(settings: WeatherSettings): void {
  saveSettings(settings);
  forecast = null;
}

function saveSettings(settings: WeatherSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Then it lasts until the app closes.
  }
}

const isMacApp = () => isTauri() && /Macintosh|Mac OS X/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent);

/**
 * Where you are now, to about a kilometre: from the Mac's location in the
 * Mac app, otherwise from the browser (which asks you the first time).
 */
export async function locate(): Promise<Place> {
  const round = (n: number) => Math.round(n * 100) / 100;
  const here = await devicePosition();
  return {
    name: "Current location",
    detail: "",
    latitude: round(here.latitude),
    longitude: round(here.longitude),
    current: true,
  };
}

/** Where the device is: the Mac's location in the Mac app, otherwise the browser's. */
export async function devicePosition(): Promise<{ latitude: number; longitude: number }> {
  let here: { latitude: number; longitude: number };
  if (isMacApp()) {
    const found = await currentLocation();
    if (!found) throw new Error("Allow Minuteman in System Settings → Privacy & Security → Location Services.");
    here = found;
  } else {
    if (!navigator.geolocation) throw new Error("This device can't share its location.");
    here = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(position.coords),
        (error) =>
          reject(
            new Error(
              error.code === error.PERMISSION_DENIED
                ? "Location isn't allowed for Minuteman. Allow it in your browser's or system's settings."
                : "Couldn't find your location.",
            ),
          ),
        { timeout: 20_000, maximumAge: 30 * 60 * 1000 },
      ),
    );
  }
  return { latitude: here.latitude, longitude: here.longitude };
}

/** Places matching `name` ("Lexington", "Paris, France"), for choosing one. */
export async function searchPlaces(name: string): Promise<Place[]> {
  const url = new URL(GEOCODING);
  // Only the town's name helps Open-Meteo's search; "Lexington, MA" finds nothing.
  url.searchParams.set("name", name.split(",")[0].trim());
  url.searchParams.set("count", "8");
  url.searchParams.set("language", navigator.language.split("-")[0]);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't search for places (${response.status})`);
  const body = (await response.json()) as {
    results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[];
  };
  const places = (body.results ?? []).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(", "),
    latitude: r.latitude,
    longitude: r.longitude,
  }));
  // After a comma, the region or country ("SC", "France") narrows the list,
  // unless nothing matches it.
  const rest = name.split(",").slice(1).join(",").trim().toLowerCase();
  const narrowed = places.filter((place) => place.detail.toLowerCase().includes(rest) || abbreviates(rest, place.detail));
  return rest && narrowed.length ? narrowed : places;
}

/** Whether `short` ("sc") is the initials of the region in `detail` ("South Carolina, United States"). */
function abbreviates(short: string, detail: string): boolean {
  const region = detail.split(",")[0];
  const initials = region.split(/\s+/).map((word) => word[0]?.toLowerCase() ?? "").join("");
  return initials === short.replace(/[^a-z]/g, "");
}

let forecast: SavedForecast | null = null;
let fetching: Promise<boolean> | null = null;

const keyFor = (settings: WeatherSettings) =>
  settings.place ? `${settings.place.latitude},${settings.place.longitude},${settings.unit}` : "";

/**
 * Makes sure there's a recent forecast for the chosen place. Resolves to
 * true if it fetched a new one (so the views should redraw).
 */
export function refreshWeather(): Promise<boolean> {
  if (isDemo()) return Promise.resolve(false); // made up (`demoWeather`)
  const settings = weatherSettings();
  if (!settings.place) return Promise.resolve(false);
  forecast ??= savedForecast();
  if (forecast?.key === keyFor(settings) && Date.now() - forecast.fetchedAt < REFRESH_MS) return Promise.resolve(false);
  fetching ??= whereNow(settings)
    .then((now) => fetchForecast(now, keyFor(now)))
    .then((fresh) => {
      forecast = fresh;
      try {
        localStorage.setItem(FORECAST_KEY, JSON.stringify(fresh));
      } catch {
        // Kept in memory only.
      }
      return true;
    })
    .catch(() => false) // offline: try again next time
    .finally(() => {
      fetching = null;
    });
  return fetching;
}

/** `settings`, with the current location found again if that's the place. */
async function whereNow(settings: WeatherSettings): Promise<WeatherSettings> {
  if (!settings.place?.current) return settings;
  const now = { ...settings, place: await locate() };
  saveSettings(now);
  return now;
}

function savedForecast(): SavedForecast | null {
  try {
    return JSON.parse(localStorage.getItem(FORECAST_KEY) ?? "null") as SavedForecast | null;
  } catch {
    return null;
  }
}

async function fetchForecast(settings: WeatherSettings, key: string): Promise<SavedForecast> {
  const place = settings.place!;
  const url = new URL(FORECAST);
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
  url.searchParams.set("temperature_unit", settings.unit);
  url.searchParams.set("timezone", "auto");
  // The last week too, so this week's earlier days have theirs.
  url.searchParams.set("past_days", "7");
  url.searchParams.set("forecast_days", "16");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Weather unavailable (${response.status})`);
  const body = (await response.json()) as {
    daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[] };
  };
  const days: Record<string, DayWeather> = {};
  body.daily.time.forEach((day, i) => {
    const [code, high, low] = [body.daily.weather_code[i], body.daily.temperature_2m_max[i], body.daily.temperature_2m_min[i]];
    if (code != null && high != null && low != null) days[day] = { code, high: Math.round(high), low: Math.round(low) };
  });
  return { key, fetchedAt: Date.now(), days };
}

/** The forecast for `day`, if there's one (weather on, and the day within about two weeks). */
export function weatherOn(day: Date): DayWeather | undefined {
  const settings = weatherSettings();
  if (!settings.place) return undefined;
  if (isDemo()) return demoWeather(day, settings.unit);
  forecast ??= savedForecast();
  if (forecast?.key !== keyFor(settings)) return undefined;
  return forecast.days[toDateString(day)];
}

/**
 * Demo mode's weather, as no forecast goes back to 1775: a spring in New
 * England, the same for a day each time. April 18, 1775 was clear (a bright
 * moon for the ride), and the 19th warm for April.
 */
function demoWeather(day: Date, unit: Unit): DayWeather {
  const key = day.getFullYear() * 10_000 + (day.getMonth() + 1) * 100 + day.getDate();
  const known: Record<number, [number, number, number]> = { 17750418: [0, 57, 41], 17750419: [1, 66, 45] };
  const roll = (salt: number) => {
    const x = Math.sin(key * 12.9898 + salt * 78.233) * 43_758.5453;
    return x - Math.floor(x);
  };
  const codes = [0, 0, 1, 1, 2, 2, 3, 3, 61, 80, 45, 51];
  const [code, high, low] = known[key] ?? [
    codes[Math.floor(roll(1) * codes.length)],
    Math.round(48 + roll(2) * 16),
    Math.round(34 + roll(3) * 10),
  ];
  const degrees = (f: number) => (unit === "celsius" ? Math.round(((f - 32) * 5) / 9) : f);
  return { code, high: degrees(high), low: degrees(Math.min(low, high - 8)) };
}

/** An icon and words for a WMO weather code. */
export function describe(code: number): [icon: string, words: string] {
  if (code === 0) return ["☀️", "Clear"];
  if (code === 1) return ["🌤️", "Mostly clear"];
  if (code === 2) return ["⛅", "Partly cloudy"];
  if (code === 3) return ["☁️", "Cloudy"];
  if (code === 45 || code === 48) return ["🌫️", "Fog"];
  if (code >= 51 && code <= 57) return ["🌦️", "Drizzle"];
  if (code === 66 || code === 67) return ["🌧️", "Freezing rain"];
  if ((code >= 61 && code <= 65) || (code >= 80 && code <= 82)) return ["🌧️", code >= 80 ? "Showers" : "Rain"];
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ["🌨️", "Snow"];
  if (code >= 95) return ["⛈️", "Thunderstorms"];
  return ["🌡️", "Weather"];
}

/**
 * A day's weather as a small label: the icon and the high ("☀️ 72°"), or
 * with `full` also the low ("☀️ 72° / 55°"). Hover for the words.
 */
export function weatherBadge(weather: DayWeather, full = false): HTMLElement {
  const [icon, words] = describe(weather.code);
  const badge = el("span", "weather");
  badge.title = `${words}, high ${weather.high}°, low ${weather.low}°`;
  badge.append(el("span", "weather-icon", icon), el("span", "weather-high", `${weather.high}°`));
  if (full) badge.append(el("span", "weather-low", ` / ${weather.low}°`));
  return badge;
}
