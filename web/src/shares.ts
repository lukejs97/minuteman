// Google Routes (leave-by times) and TomTom (place search) for everyone on
// the site come out of one Routes key and one TomTom key, each kept inside
// its free tier by caps (src/routes-budget.ts). With other people here:
//
// - each person has their own count, and someone the owner invited has a
//   smaller share than the owner (SHARE), whatever their Settings say;
// - everyone's attempts are also counted together, against the owner's caps
//   (Routes: Settings → Leave-by; TomTom: places.ts), so however many
//   people there are, the site as a whole stays inside the free tiers.
import { charge, clampLimits, emptyUsage, pacificDate } from "../../src/routes-budget";
import type { Env } from "./env";
import { readLeaveSettings, readRoutesUsage, writeRoutesUsage } from "./store";
import { forUser, isOwner, OWNER, siteStore } from "./users";

/** A person's share (not the owner's): attempts a day and a month. */
export const SHARE = { daily: 20, monthly: 300 };

/** `limits`, or for someone not the owner, no more than their share. */
export function personal(env: Env, limits: { daily: number; monthly: number }): { daily: number; monthly: number } {
  if (isOwner(env)) return limits;
  return { daily: Math.min(limits.daily, SHARE.daily), monthly: Math.min(limits.monthly, SHARE.monthly) };
}

/** The owner's Routes caps: the site's whole allowance. */
export async function siteRoutesLimits(env: Env): Promise<{ daily: number; monthly: number }> {
  const settings = await readLeaveSettings(forUser(env, OWNER));
  return clampLimits(settings.routesDailyLimit, settings.routesMonthlyLimit);
}

/**
 * Counts one attempt for the whole site in `name` ("site:routesUsage"…),
 * saved before it's sent; false at `limits` (or if it can't be saved).
 */
export async function chargeSite(env: Env, name: string, limits: { daily: number; monthly: number }): Promise<boolean> {
  const site = { ...env, STORE: siteStore(env) };
  const usage = (await readRoutesUsage(site, name)) ?? emptyUsage(new Date());
  const next = charge(usage, pacificDate(new Date()), limits);
  try {
    await writeRoutesUsage(site, next.usage, name);
  } catch {
    return false;
  }
  return next.kind === "allowed";
}
