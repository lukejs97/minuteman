// Where a place opens: Apple Maps on a phone, Google Maps on a computer,
// unless Settings has chosen one. Built when the link is opened, so a change
// in Settings applies to the next tap.
import { savedMapProvider, type MapProvider } from "./preferences";

export type { MapProvider };

/**
 * A phone or tablet browser. iOS Safari is the one that matters most: an
 * iPhone says so, and iPadOS Safari claims to be a Mac unless the touch
 * screen is noticed. Android phones count too.
 */
export function isMobileBrowser(
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  maxTouchPoints: number = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
): boolean {
  if (/iPhone|iPad|iPod|Android/i.test(userAgent)) return true;
  return /Macintosh|Mac OS X/i.test(userAgent) && maxTouchPoints > 1;
}

/** Apple Maps on a phone or tablet, Google Maps on a computer. */
export function defaultMapProvider(
  userAgent?: string,
  maxTouchPoints?: number,
): MapProvider {
  return isMobileBrowser(userAgent, maxTouchPoints) ? "apple" : "google";
}

/** A saved choice in Settings, or the default for this device. */
export function mapProvider(): MapProvider {
  return savedMapProvider() ?? defaultMapProvider();
}

/** An iPhone or iPad (iPadOS Safari says it's a Mac, but has a touch screen). */
const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/** A link that searches `place` in Apple Maps or Google Maps. */
export function mapLink(place: string, provider: MapProvider = mapProvider()): string {
  const query = encodeURIComponent(place);
  // On an iPhone, straight into the Maps app: a web link first opens a
  // browser sheet, which stays behind, blank, once Maps takes over.
  if (provider === "apple" && isIOS()) return `maps://?q=${query}`;
  if (provider === "apple") return `https://maps.apple.com/?q=${query}`;
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}
