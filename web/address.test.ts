// A pasted or picked address keeps its town, state and ZIP. The same string
// is what Settings saves on the website (the Worker) and in the desktop app;
// neither side shortens it. Leave-by's vague-address check (anchorEnds) only
// runs when the town really is missing, so a full address is not looked up
// again and does not spend a Routes call on that account.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorEnds,
  hasLocality,
  joinAddress,
  keptAddress,
  keptLeaveFrom,
  looksComplete,
  pastedPlaceText,
  splitAddress,
} from "../src/routes-budget.ts";

const full = "10 Mill Park Ct, Greenville, SC 29611";

test("a pasted address keeps the town, state and ZIP on one line", () => {
  const pasted = "10 Mill Park Ct\nGreenville, SC 29611";
  const parts = splitAddress(pasted);
  assert.deepEqual(parts, { street: "10 Mill Park Ct", town: "Greenville", state: "SC", zip: "29611" });
  assert.equal(joinAddress(parts), full);
  assert.equal(pastedPlaceText(pasted), full);
  assert.equal(pastedPlaceText("10 Mill Park Ct\r\nGreenville, SC 29611\r\nUnited States"), full);
  // Already one line: the field can take it as it is.
  assert.equal(pastedPlaceText(full), null);
  assert.equal(pastedPlaceText("10 Mill Park Ct"), null);
});

test("the street box can hold the whole address until it is split", () => {
  assert.deepEqual(splitAddress(full), { street: "10 Mill Park Ct", town: "Greenville", state: "SC", zip: "29611" });
  assert.deepEqual(splitAddress("10 Mill Park Ct, Greenville SC 29611"), {
    street: "10 Mill Park Ct",
    town: "Greenville",
    state: "SC",
    zip: "29611",
  });
  assert.deepEqual(splitAddress("10 Mill Park Ct, Greenville, SC, 29611"), {
    street: "10 Mill Park Ct",
    town: "Greenville",
    state: "SC",
    zip: "29611",
  });
  assert.deepEqual(splitAddress("10 Mill Park Ct, Greenville, South Carolina 29611"), {
    street: "10 Mill Park Ct",
    town: "Greenville",
    state: "South Carolina",
    zip: "29611",
  });
  // A place name stays with the street. A second part with no state is the town.
  assert.deepEqual(splitAddress("Old North Church, 193 Salem St, Boston, MA 02113"), {
    street: "Old North Church, 193 Salem St",
    town: "Boston",
    state: "MA",
    zip: "02113",
  });
  assert.deepEqual(splitAddress("Green Dragon Tavern, 84 Union St"), {
    street: "Green Dragon Tavern",
    town: "84 Union St",
    state: "",
    zip: "",
  });
  assert.equal(hasLocality(splitAddress("Green Dragon Tavern, 84 Union St")), false);
  assert.deepEqual(splitAddress("10 Mill Park Ct"), { street: "10 Mill Park Ct", town: "", state: "", zip: "" });
  assert.equal(splitAddress("10 Mill Park Ct, Greenville, SC 29611-1234").zip, "29611-1234");
});

test("picking a suggestion keeps a town the user already typed", () => {
  // The list's first line is only the street. The typed address had the rest.
  assert.equal(keptAddress(full, "10 Mill Park Court", "10 Mill Park Court"), full);
  // A full hit is the address they picked, including a place's name.
  const church = "Old North Church, 193 Salem St, Boston, MA 02113";
  assert.equal(keptAddress(full, church, "193 Salem St"), church);
  assert.equal(keptAddress("", church, "193 Salem St"), church);
  assert.deepEqual(keptLeaveFrom(full, { street: full, town: "", state: "", zip: "" }, { line: "10 Mill Park Court", street: "10 Mill Park Court", name: null }), {
    street: "10 Mill Park Ct",
    town: "Greenville",
    state: "SC",
    zip: "29611",
  });
  assert.deepEqual(
    keptLeaveFrom("10 Mill Park Ct", { street: "10 Mill Park Ct", town: "Greenville", state: "SC", zip: "29611" }, { line: "10 Mill Park Court", street: "10 Mill Park Court", name: null }),
    { street: "10 Mill Park Court", town: "Greenville", state: "SC", zip: "29611" },
  );
  assert.deepEqual(keptLeaveFrom("", { street: "", town: "", state: "", zip: "" }, { line: church, street: "193 Salem St", name: "Old North Church" }), {
    street: "Old North Church, 193 Salem St",
    town: "Boston",
    state: "MA",
    zip: "02113",
  });
});

test("a full address is not geocoded again before Routes", async () => {
  const saved = joinAddress(splitAddress("10 Mill Park Ct\nGreenville, SC 29611\nUnited States"));
  assert.equal(saved, full);
  assert.equal(looksComplete(saved), true);
  // What was already saved without a town stays vague, for the matcher in PR #12.
  assert.equal(looksComplete("10 Mill Park Ct"), false);
  let lookups = 0;
  const result = await anchorEnds(saved, "1207 Haywood Rd, Greenville, SC 29615", null, async () => {
    lookups += 1;
    return [];
  });
  assert.equal(lookups, 0);
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.equal(result.origin.waypoint, saved);
  assert.equal(result.origin.label, null);
});
