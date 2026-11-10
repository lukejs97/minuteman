// Same cases as the budget tests in src-tauri/src/leave.rs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANCHOR_KM,
  DEFAULT_DAILY,
  DEFAULT_MONTHLY,
  FREE_ROUTES_PER_MONTH,
  MAX_DAILY,
  MAX_MONTHLY,
  MAX_PLAUSIBLE_DRIVE_MINUTES,
  anchorEnds,
  charge,
  chooseHit,
  clampLimits,
  emptyUsage,
  geoPin,
  kmBetween,
  nominatimHits,
  pacificDate,
  parseDuration,
  parseGeoPin,
  parseSpot,
  stillFresh,
  type GeoHit,
  type GeoLookup,
  type Usage,
} from "../src/routes-budget.ts";

const limits = { daily: 2, monthly: 10 };

test("pacific midnight is the quota boundary", () => {
  assert.equal(pacificDate(new Date("2026-12-01T07:30:00Z")), "2026-11-30");
  assert.equal(pacificDate(new Date("2026-12-01T08:30:00Z")), "2026-12-01");
  assert.equal(pacificDate(new Date("2026-07-01T06:30:00Z")), "2026-06-30");
  assert.equal(pacificDate(new Date("2026-07-01T07:30:00Z")), "2026-07-01");
});

test("every attempt counts and the next one stops", () => {
  const today = "2026-06-15";
  let usage = emptyUsage(new Date("2026-06-15T18:00:00Z"));
  const first = charge(usage, today, limits);
  assert.equal(first.kind, "allowed");
  if (first.kind !== "allowed") return;
  assert.deepEqual([first.usage.dayCount, first.usage.monthCount], [1, 1]);
  const second = charge(first.usage, today, limits);
  assert.equal(second.kind, "allowed");
  if (second.kind !== "allowed") return;
  assert.equal(second.usage.dayCount, 2);
  const third = charge(second.usage, today, limits);
  assert.equal(third.kind, "daily");
  assert.equal(third.usage.dayCount, 2);
});

test("a new day resets the day and a new month resets both", () => {
  const usage: Usage = { day: "2026-06-15", dayCount: 2, month: "2026-06", monthCount: 5 };
  const next = charge(usage, "2026-06-16", limits);
  assert.equal(next.kind, "allowed");
  if (next.kind !== "allowed") return;
  assert.deepEqual([next.usage.dayCount, next.usage.monthCount], [1, 6]);
  const july = charge(next.usage, "2026-07-01", limits);
  assert.equal(july.kind, "allowed");
  if (july.kind !== "allowed") return;
  assert.deepEqual([july.usage.dayCount, july.usage.monthCount], [1, 1]);
  assert.equal(july.usage.month, "2026-07");
});

test("the monthly cap stops a fresh day and zero is not unlimited", () => {
  const usage: Usage = { day: "2026-06-15", dayCount: 0, month: "2026-06", monthCount: 4 };
  const stopped = charge(usage, "2026-06-15", { daily: 80, monthly: 4 });
  assert.equal(stopped.kind, "monthly");
  assert.equal(stopped.usage.monthCount, 4);
  const none = charge(emptyUsage(new Date("2026-06-15T18:00:00Z")), "2026-06-15", { daily: 0, monthly: 10 });
  assert.equal(none.kind, "daily");
  assert.equal(none.usage.dayCount, 0);
});

test("a limit above the free tier is pulled back", () => {
  assert.deepEqual(clampLimits(10_000, 10_000), { daily: MAX_DAILY, monthly: MAX_MONTHLY });
  assert.deepEqual(clampLimits(0, 2_500), { daily: 0, monthly: DEFAULT_MONTHLY });
  assert.ok(MAX_DAILY * 31 <= FREE_ROUTES_PER_MONTH);
  assert.ok(DEFAULT_DAILY * 31 < FREE_ROUTES_PER_MONTH / 2);
  assert.ok(MAX_MONTHLY < FREE_ROUTES_PER_MONTH);
  assert.equal(DEFAULT_MONTHLY * 2, FREE_ROUTES_PER_MONTH);
});

const church: GeoHit = {
  latitude: 34.8673,
  longitude: -82.33066,
  label: "Faith Free Presbyterian Church, 1207 Haywood Road, Wade Hampton, SC 29615",
};
const greenville: GeoHit = { latitude: 34.86739, longitude: -82.4285, label: "10 Mill Park Court, Greenville, SC 29611" };
const loudoun: GeoHit = { latitude: 39.10833, longitude: -77.5133, label: "10 Mill Park Court, Loudoun County, VA" };

test("a routes duration is seconds, so a 20 minute drive is not 1200 minutes", () => {
  assert.equal(parseDuration("1200s"), 20);
  assert.equal(parseDuration("34200s"), 570);
  assert.equal(parseDuration("90s"), 2);
  assert.equal(parseDuration("1200"), null);
  assert.equal(parseDuration("1200m"), null);
});

test("the same street far away is not a guess", () => {
  assert.equal(chooseHit([loudoun, greenville], null), null);
  assert.deepEqual(chooseHit([loudoun, greenville], church), greenville);
  assert.deepEqual(chooseHit([church], null), church);
  assert.equal(chooseHit([loudoun], church), null);
  assert.ok(kmBetween(greenville, church) < ANCHOR_KM);
  assert.ok(kmBetween(loudoun, church) > ANCHOR_KM);
});

test("a 9 hour mismatch is not kept just because its bogus leave time has passed", () => {
  const now = new Date("2026-11-02T14:00:00Z");
  const soon = new Date("2026-11-02T18:00:00Z");
  assert.equal(stillFresh(new Date("2026-11-02T13:00:00Z"), now, soon, 550), true);
  assert.equal(stillFresh(new Date("2026-11-01T13:00:00Z"), now, soon, 550), false);
  assert.ok(550 > MAX_PLAUSIBLE_DRIVE_MINUTES);
});

test("a nominatim church becomes a short label and a geo pin routes sends as coordinates", () => {
  const hits = nominatimHits([
    {
      lat: "34.8672960",
      lon: "-82.3306632",
      name: "Faith Free Presbyterian Church",
      address: {
        house_number: "1207",
        road: "Haywood Road",
        town: "Wade Hampton",
        state: "South Carolina",
        "ISO3166-2-lvl4": "US-SC",
        postcode: "29615",
      },
    },
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, "Faith Free Presbyterian Church, 1207 Haywood Road, Wade Hampton, SC 29615");
  const pin = geoPin(hits[0].latitude, hits[0].longitude);
  assert.equal(parseSpot(pin), null);
  assert.ok(parseGeoPin(pin));
});

/** Scripted geocoder: query + whether a bias was passed. */
function scripted(rows: [string, boolean, GeoHit[] | "failed"][]): GeoLookup {
  return async (query, bias) => {
    const found = rows.find(([name, biased]) => name === query && biased === (bias !== null));
    if (!found) return [];
    return found[2];
  };
}

test("the greenville street is chosen from the church, not the one in virginia", async () => {
  const result = await anchorEnds(
    "10 Mill Park Ct",
    "Faith Free Presbyterian Church",
    null,
    scripted([
      ["Faith Free Presbyterian Church", false, [church]],
      ["10 Mill Park Ct", true, [loudoun, greenville]],
    ]),
  );
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.equal(result.origin.waypoint, geoPin(greenville.latitude, greenville.longitude));
  assert.equal(result.origin.label, greenville.label);
  assert.equal(result.destination.waypoint, geoPin(church.latitude, church.longitude));
  assert.match(result.destination.label ?? "", /Faith Free Presbyterian Church/);
});

test("two vague places and no hint are not sent onward", async () => {
  const result = await anchorEnds(
    "10 Mill Park Ct",
    "Somewhere",
    null,
    scripted([
      ["Somewhere", false, [loudoun, greenville]],
      ["10 Mill Park Ct", false, [loudoun, greenville]],
    ]),
  );
  assert.deepEqual(result, { kind: "vague" });
});

test("a full address is left alone and a geocoder failure is not 'no such place'", async () => {
  let calls = 0;
  const full = await anchorEnds("10 Mill Park Ct, Greenville, SC 29611", "1207 Haywood Rd, Greenville, SC 29615", null, async () => {
    calls += 1;
    return [];
  });
  assert.equal(full.kind, "ready");
  if (full.kind === "ready") {
    assert.equal(full.origin.waypoint, "10 Mill Park Ct, Greenville, SC 29611");
    assert.equal(full.destination.waypoint, "1207 Haywood Rd, Greenville, SC 29615");
  }
  assert.equal(calls, 0);
  const down = await anchorEnds("10 Mill Park Ct", "Church", null, async () => "failed");
  assert.deepEqual(down, { kind: "unavailable" });
});
