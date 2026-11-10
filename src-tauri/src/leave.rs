//! When to leave for an event, from a starting address to the event's place.
//!
//! The time math, the cache, and the Google Routes request live here, with no
//! macOS or desktop types, so a future Android build can use the same code.
//! Apple Maps from the Mac's location (travel.rs) is only a fallback for the
//! older "time to leave" switch, when no address is set.
//!
//! Driving traffic is asked for a departure time (Routes won't take an arrival
//! time for a drive). We guess a departure, and if the drive it comes back
//! with would have you leave more than a few minutes earlier or later, we ask
//! once more at that time.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Datelike, NaiveDate, SecondsFormat, TimeDelta, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::secrets;

/// Process environment. Wins over a key saved in Settings, so a launch can
/// override it. Never compiled into the app.
pub const ENV_KEY: &str = "MINUTEMAN_ROUTES_API_KEY";

const ROUTES_URL: &str = "https://routes.googleapis.com/directions/v2:computeRoutes";

/// The older Mac switch alerts this many minutes before the leave-by time.
pub const LEGACY_BUFFER_MINUTES: u32 = 5;
/// That switch only looks at events this close, matching what it did before.
pub const LEGACY_HORIZON: TimeDelta = TimeDelta::hours(3);
/// A drive shorter than this isn't worth that automatic alert (you're as
/// good as there). An alert the event itself asks for still fires.
pub const MIN_LEGACY_DRIVE: u32 = 3;
/// A drive longer than this (4 hours) almost always means Google matched an
/// address somewhere else: a street name with no town is the usual cause
/// ("10 Battle Rd" with several in the country). No leave-by time or alert
/// is given for it; the minutes are kept so the details can say so. Kept in
/// step with `MAX_PLAUSIBLE_DRIVE_MINUTES` in src/routes-budget.ts.
pub const MAX_PLAUSIBLE_DRIVE: u32 = 240;
/// Live traffic isn't worth a lookup until the event is this close.
pub const LOOKUP_HORIZON: TimeDelta = TimeDelta::hours(48);
/// Ask again when the guessed departure and the drive disagree by more.
const REFINE_GAP_MINUTES: i64 = 10;
/// A failed lookup is remembered this long, so a blip isn't retried at once
/// and a real outage isn't retried on every check.
/// A lookup that failed (no internet, Google busy) is asked again after this.
const FAILURE_TTL: TimeDelta = TimeDelta::minutes(10);
/// A place Google can't drive to ("Church" alone, a typo) isn't asked again
/// for this long: asking every few minutes used up the day's lookups.
const NO_ROUTE_TTL: TimeDelta = TimeDelta::hours(12);
/// A drive from where you are is used again while you're within this of
/// where it was asked from (kilometres): a few streets don't change it.
const NEARBY_KM: f64 = 2.0;
/// Where a drive from the device's own location is cached (no street address).
const DEVICE_ORIGIN: &str = "@device";

/// Free successful Compute Routes Pro requests per month (traffic-aware).
/// Google Maps Platform pricing list, checked 2026-10-31. The cap resets at
/// midnight Pacific time on the first of the month.
/// The website uses the same numbers in src/routes-budget.ts.
pub const FREE_ROUTES_PER_MONTH: u32 = 5_000;
/// Default lookups per Pacific day. 80 × 31 = 2,480, under half the free cap,
/// and each lookup may be two requests (a guess and one refinement).
pub const DEFAULT_DAILY: u32 = 80;
/// Default lookups per Pacific month. Half the free cap, so a raised daily
/// limit still cannot spend the whole allowance.
pub const DEFAULT_MONTHLY: u32 = 2_500;
/// Highest daily limit Settings will keep. floor(5,000 / 31) is 161; 160
/// leaves a little room for quota and billing not matching exactly.
pub const MAX_DAILY: u32 = 160;
/// Highest monthly limit. Leaves 1,000 of the free 5,000 unused.
pub const MAX_MONTHLY: u32 = 4_000;

/// The caps above stay inside the free tier: a full month of the daily
/// maximum, and the monthly maximum itself.
const _: () = {
    assert!(MAX_DAILY * 31 <= FREE_ROUTES_PER_MONTH);
    assert!(MAX_MONTHLY < FREE_ROUTES_PER_MONTH);
    assert!(DEFAULT_DAILY * 31 < FREE_ROUTES_PER_MONTH / 2);
    assert!(DEFAULT_MONTHLY * 2 == FREE_ROUTES_PER_MONTH);
};

/// Why a leave-by time isn't shown. `ok` is the one that has a time.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TravelStatus {
    Ok,
    NoKey,
    NoOrigin,
    NotPhysical,
    TooFar,
    Past,
    Unavailable,
    /// Google found no drive to the place (or from the starting address):
    /// it's asked again after `NO_ROUTE_TTL`.
    NoRoute,
    /// The daily or monthly Routes cap is used up. A drive already saved is
    /// still shown; nothing new is asked of Google.
    Limited,
    /// Google's drive is longer than `MAX_PLAUSIBLE_DRIVE`: probably an
    /// address matched in the wrong town. No leave-by time is given.
    Implausible,
    /// The address doesn't name a town, and nothing nearby says which street
    /// it is. Google is not asked: it would pick one in another state.
    Vague,
}

/// Where the Routes API key was found. `environment` wins over Settings.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum KeySource {
    None,
    Environment,
    /// A development build read it from a `.env` file at run time.
    Dotenv,
    Settings,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutesKeyStatus {
    pub configured: bool,
    pub source: KeySource,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TravelAnswer {
    pub minutes: Option<u32>,
    /// When to set off to arrive as the event starts, with no extra buffer
    /// (RFC 3339). The alert's buffer is applied separately.
    pub leave_at: Option<String>,
    pub status: TravelStatus,
    /// Where a vague leave-from address was matched, so a wrong town is visible.
    pub origin_label: Option<String>,
    /// Where a vague destination was matched.
    pub destination_label: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum Classify {
    Status(TravelStatus),
    Routes(String),
    Device,
}

#[derive(Debug, PartialEq)]
pub enum Sample {
    Done(u32),
    Again(DateTime<Utc>),
}

#[derive(Debug, PartialEq)]
pub struct LeaveNotice {
    pub key: String,
    pub title: String,
    pub body: String,
}

/// Where you are, as a starting point: "@42.447,-71.227", rounded to about
/// 100 m so a little GPS wobble doesn't ask Google again. Kept in step with
/// `spotOrigin` in src/routes-budget.ts.
pub fn spot_origin(latitude: f64, longitude: f64) -> String {
    format!("@{latitude:.3},{longitude:.3}")
}

/// The latitude and longitude in a `spot_origin`; `None` for an address.
pub fn parse_spot(origin: &str) -> Option<(f64, f64)> {
    let (lat, lng) = origin.trim().strip_prefix('@')?.split_once(',')?;
    let (lat, lng): (f64, f64) = (lat.trim().parse().ok()?, lng.trim().parse().ok()?);
    ((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lng)).then_some((lat, lng))
}

/// Where a drive starts: the event's own address, else where you are (when
/// Settings says so and it's known), else the address in Settings. Blank is none.
pub fn pick_origin(event_override: Option<&str>, here: Option<&str>, default_address: &str) -> Option<String> {
    let here = here.filter(|spot| parse_spot(spot).is_some());
    resolve_origin(event_override, here.unwrap_or(default_address))
}

/// The event's own starting address, or the one in Settings. Blank is none.
pub fn resolve_origin(event_override: Option<&str>, default_address: &str) -> Option<String> {
    let own = event_override.map(str::trim).filter(|s| !s.is_empty());
    if let Some(own) = own {
        return Some(own.to_string());
    }
    let default_address = default_address.trim();
    if default_address.is_empty() { None } else { Some(default_address.to_string()) }
}

/// Whether `place` is somewhere you'd travel to, not a video call or a link.
pub fn is_physical(place: &str) -> bool {
    let place = place.trim().to_lowercase();
    !place.is_empty()
        && !place.contains("://")
        && !["zoom", "meet.google", "teams", "webex", "facetime", "online", "virtual", "phone", "call"].iter().any(|word| place.contains(word))
}

/// When to set off: the arrival, minus the drive, minus any extra buffer.
pub fn leave_at<Tz: TimeZone>(arrive: DateTime<Tz>, travel_minutes: u32, buffer_minutes: u32) -> Option<DateTime<Tz>> {
    arrive.checked_sub_signed(TimeDelta::minutes(i64::from(travel_minutes)))?.checked_sub_signed(TimeDelta::minutes(i64::from(buffer_minutes)))
}

/// Whole minutes, rounded up, so "8 min" isn't really 8½. `None` if `seconds`
/// isn't a usable duration.
pub fn minutes_from_seconds(seconds: f64) -> Option<u32> {
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    let minutes = (seconds / 60.0).ceil();
    if minutes > f64::from(u32::MAX) { None } else { Some(minutes as u32) }
}

/// Google's duration is a string of seconds, `"165s"` or `"165.4s"`.
/// The live request parses the seconds itself (it may refine before rounding);
/// this is what the tests and any caller use for the minute count.
#[allow(dead_code)]
pub fn parse_duration(raw: &str) -> Option<u32> {
    let body = raw.trim().strip_suffix('s')?;
    minutes_from_seconds(body.parse().ok()?)
}

/// How long a successful answer stays usable. Closer events are asked again
/// sooner, because that's when traffic actually moves the leave-by time;
/// further out, Google's answer is the usual traffic for that hour anyway.
pub fn fresh_for(until_arrival: TimeDelta) -> TimeDelta {
    if until_arrival <= TimeDelta::minutes(45) {
        TimeDelta::minutes(10)
    } else if until_arrival <= TimeDelta::hours(3) {
        TimeDelta::minutes(30)
    } else if until_arrival <= TimeDelta::hours(12) {
        TimeDelta::hours(2)
    } else {
        TimeDelta::hours(12)
    }
}

/// What a lookup came to, as saved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Saved {
    Drive(u32),
    /// Google found no drive between the two places.
    NoRoute,
    /// It couldn't be asked, or didn't answer.
    Failed,
}

/// Whether an answer fetched at `fetched` can still be used at `now`. Once
/// it's time to leave, the drive is kept: you're on your way.
pub fn still_fresh(fetched: DateTime<Utc>, now: DateTime<Utc>, arrive: DateTime<Utc>, saved: Saved) -> bool {
    let age = now.signed_duration_since(fetched);
    if age < TimeDelta::zero() {
        return false;
    }
    match saved {
        Saved::Failed => age < FAILURE_TTL,
        Saved::NoRoute => age < NO_ROUTE_TTL,
        // Too long to be a local trip: keep it only for a while, then ask again.
        // "You're already leaving, so keep the drive" must not apply. A 9 hour
        // mismatch would otherwise stick until the event, because its bogus
        // leave time is already in the past.
        Saved::Drive(minutes) if minutes > MAX_PLAUSIBLE_DRIVE => age < NO_ROUTE_TTL,
        Saved::Drive(minutes) => {
            let leave = arrive - TimeDelta::minutes(i64::from(minutes));
            now >= leave || age < fresh_for(arrive.signed_duration_since(now))
        }
    }
}

/// Kilometres between two points (near enough, for a few kilometres).
pub fn km_between(a: (f64, f64), b: (f64, f64)) -> f64 {
    let lat = ((a.0 + b.0) / 2.0).to_radians();
    let dy = (a.0 - b.0) * 111.32;
    let dx = (a.1 - b.1) * 111.32 * lat.cos();
    (dx * dx + dy * dy).sqrt()
}

/// Whether it's worth asking about a drive that should arrive at `arrive`.
pub fn should_query(now: DateTime<Utc>, arrive: DateTime<Utc>) -> bool {
    arrive > now && arrive.signed_duration_since(now) <= LOOKUP_HORIZON
}

/// The device-location fallback only covers the next few hours.
pub fn device_should_query(now: DateTime<Utc>, arrive: DateTime<Utc>) -> bool {
    arrive > now && arrive.signed_duration_since(now) <= LEGACY_HORIZON
}

/// The departure to ask about first: the last drive's before arrival (so it
/// rarely needs asking twice), else half an hour before, but never in the
/// past (Routes rejects that).
pub fn first_departure(now: DateTime<Utc>, arrive: DateTime<Utc>, previous: Option<u32>) -> DateTime<Utc> {
    let soonest = now + TimeDelta::seconds(60);
    let guess = arrive - TimeDelta::minutes(i64::from(previous.unwrap_or(30)));
    if guess < soonest { soonest } else { guess }
}

/// One refinement. `refined` means this answer is already the second ask, so
/// it's kept even if it still disagrees a little.
pub fn judge(queried: DateTime<Utc>, travel_minutes: u32, arrive: DateTime<Utc>, now: DateTime<Utc>, refined: bool) -> Sample {
    let Some(depart) = leave_at(arrive, travel_minutes, 0) else {
        return Sample::Done(travel_minutes);
    };
    let gap = depart.signed_duration_since(queried).num_minutes().abs();
    let soonest = now + TimeDelta::seconds(30);
    if !refined && gap > REFINE_GAP_MINUTES && depart >= soonest { Sample::Again(depart) } else { Sample::Done(travel_minutes) }
}

/// Which alerts to fire. The event's own leave alerts win. Otherwise the
/// older switch alerts, with its fixed buffer, and only inside its window.
pub fn alert_buffers(explicit: &[u32], global: bool, until_start: TimeDelta) -> Vec<u32> {
    if !explicit.is_empty() {
        return explicit.to_vec();
    }
    if global && until_start > TimeDelta::zero() && until_start <= LEGACY_HORIZON { vec![LEGACY_BUFFER_MINUTES] } else { Vec::new() }
}

/// What to show or look up. A virtual place, a past event, a missing key and
/// a missing address are decided before any request. An address is never
/// replaced with the device's location: that would ignore the address.
pub fn classify(destination: &str, arrive: DateTime<Utc>, now: DateTime<Utc>, origin: Option<&str>, has_key: bool, allow_device: bool) -> Classify {
    if !is_physical(destination) {
        return Classify::Status(TravelStatus::NotPhysical);
    }
    if arrive <= now {
        return Classify::Status(TravelStatus::Past);
    }
    let origin = origin.map(str::trim).filter(|s| !s.is_empty());
    match origin {
        Some(_) if !has_key => Classify::Status(TravelStatus::NoKey),
        Some(_) if !should_query(now, arrive) => Classify::Status(TravelStatus::TooFar),
        Some(origin) => Classify::Routes(origin.to_string()),
        None if allow_device && device_should_query(now, arrive) => Classify::Device,
        None => Classify::Status(TravelStatus::NoOrigin),
    }
}

/// The Routes request body. `departure` is an absolute time.
pub fn route_request(origin: &str, destination: &str, departure: DateTime<Utc>) -> Value {
    // Where you are, and an address we already resolved, go as coordinates:
    // nothing for Google to mismatch. A written address is geocoded by Routes.
    let place = |text: &str| match parse_spot(text).or_else(|| crate::anchor::parse_geo_pin(text)) {
        Some((latitude, longitude)) => json!({ "location": { "latLng": { "latitude": latitude, "longitude": longitude } } }),
        None => json!({ "address": text }),
    };
    json!({
        "origin": place(origin),
        "destination": place(destination),
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_AWARE",
        "departureTime": departure.to_rfc3339_opts(SecondsFormat::Secs, true),
        "computeAlternativeRoutes": false,
    })
}

/// `KEY=value` lines (a `.env` file). Quotes around the value are dropped.
pub fn parse_env_value(text: &str, name: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != name {
            continue;
        }
        let value = value.trim().trim_matches('"').trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// Alerts whose leave time has arrived and whose event hasn't started.
/// `sent` holds keys already shown, so each buffer fires once. `start_key`
/// is the event's own start string, so a repeating series' occurrences
/// don't share one alert.
pub fn notices(
    id: &str,
    start_key: &str,
    title: &str,
    place: &str,
    start: DateTime<chrono::Local>,
    travel_minutes: u32,
    buffers: &[u32],
    now: DateTime<chrono::Local>,
    sent: &std::collections::HashSet<String>,
) -> Vec<LeaveNotice> {
    let mut out = Vec::new();
    for &buffer in buffers {
        let key = format!("leave|{id}|{start_key}|{buffer}");
        if sent.contains(&key) {
            continue;
        }
        let Some(when) = leave_at(start, travel_minutes, buffer) else {
            continue;
        };
        if when <= now && now < start {
            out.push(LeaveNotice {
                key,
                title: format!("Time to leave for {title}"),
                body: leave_alert_body(travel_minutes, leave_at(start, travel_minutes, 0).unwrap_or(when), start, place, buffer),
            });
        }
    }
    out
}

fn leave_alert_body(minutes: u32, leave_at: DateTime<chrono::Local>, start: DateTime<chrono::Local>, place: &str, buffer: u32) -> String {
    let leave = leave_at.format("%-I:%M %p");
    let starts = start.format("%-I:%M %p");
    let spare = if buffer == 0 { String::new() } else { format!(" · {buffer} min to spare") };
    format!("{minutes} min drive · leave by {leave}{spare} · starts {starts} · {place}")
}

fn answer(minutes: Option<u32>, arrive: DateTime<Utc>, status: TravelStatus) -> TravelAnswer {
    // A drive too long to be right: no time to leave, and the reason.
    if status == TravelStatus::Ok && minutes.is_some_and(|m| m > MAX_PLAUSIBLE_DRIVE) {
        return TravelAnswer { minutes, leave_at: None, status: TravelStatus::Implausible, origin_label: None, destination_label: None };
    }
    let leave_at = minutes.and_then(|m| leave_at(arrive, m, 0)).map(|t| t.to_rfc3339());
    TravelAnswer { minutes, leave_at, status, origin_label: None, destination_label: None }
}

fn with_labels(mut answer: TravelAnswer, origin_label: Option<String>, destination_label: Option<String>) -> TravelAnswer {
    answer.origin_label = origin_label;
    answer.destination_label = destination_label;
    answer
}

/// Minutes to drive, from the cache when it's still fresh. `None` is a
/// lookup that failed recently, as well as "no answer".
pub async fn resolve<F, Fut>(
    http: &reqwest::Client,
    destination: &str,
    arrive: DateTime<Utc>,
    now: DateTime<Utc>,
    origin: Option<&str>,
    has_key: bool,
    allow_device: bool,
    bias: Option<(f64, f64)>,
    device: F,
) -> TravelAnswer
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Option<u32>>,
{
    match classify(destination, arrive, now, origin, has_key, allow_device) {
        Classify::Status(status) => answer(None, arrive, status),
        Classify::Routes(origin) => match driving_minutes(http, &origin, destination, arrive, now, bias).await {
            Fetch::Ready { minutes, origin_label, destination_label } => with_labels(answer(Some(minutes), arrive, TravelStatus::Ok), origin_label, destination_label),
            // No new request. A drive saved earlier is returned above, from
            // the cache, and can still fire a leave alert. With nothing saved,
            // the alert waits.
            Fetch::Limited => answer(None, arrive, TravelStatus::Limited),
            Fetch::NoRoute => answer(None, arrive, TravelStatus::NoRoute),
            Fetch::Vague => answer(None, arrive, TravelStatus::Vague),
            Fetch::Failed => answer(None, arrive, TravelStatus::Unavailable),
        },
        Classify::Device => {
            let key = cache_key(DEVICE_ORIGIN, destination, arrive);
            if let Some(Lookup::Fresh(cached, _, _)) = lookup(&key, None, arrive, now) {
                let minutes = match cached {
                    Saved::Drive(minutes) => Some(minutes),
                    _ => None,
                };
                return answer(minutes, arrive, if minutes.is_some() { TravelStatus::Ok } else { TravelStatus::Unavailable });
            }
            let minutes = device().await;
            remember(&key, minutes.map_or(Saved::Failed, Saved::Drive), None, None, None, Utc::now());
            answer(minutes, arrive, if minutes.is_some() { TravelStatus::Ok } else { TravelStatus::Unavailable })
        }
    }
}

enum Fetch {
    Ready { minutes: u32, origin_label: Option<String>, destination_label: Option<String> },
    NoRoute,
    Failed,
    Limited,
    /// The address needs a town. Google was not asked.
    Vague,
}

fn ready(minutes: u32) -> Fetch {
    Fetch::Ready { minutes, origin_label: None, destination_label: None }
}

async fn driving_minutes(http: &reqwest::Client, origin: &str, destination: &str, arrive: DateTime<Utc>, now: DateTime<Utc>, bias: Option<(f64, f64)>) -> Fetch {
    // A street with no town is resolved here, before Google picks one. Not a
    // Routes call, so it doesn't spend the cap.
    let ends = crate::anchor::anchor_ends(origin, destination, bias, |query, hint| {
        let http = http.clone();
        async move { crate::anchor::lookup(&http, &query, hint).await }
    })
    .await;
    let (origin, destination, origin_label, destination_label) = match ends {
        crate::anchor::AnchorResult::Ready { origin, destination } => (origin.waypoint, destination.waypoint, origin.label, destination.label),
        crate::anchor::AnchorResult::Vague => return Fetch::Vague,
        crate::anchor::AnchorResult::Unavailable => return Fetch::Failed,
    };
    // From where you are: one slot, used again nearby (see NEARBY_KM).
    // A resolved address is not that, even though it is coordinates.
    let spot = parse_spot(&origin);
    let key = cache_key(if spot.is_some() { DEVICE_ORIGIN } else { &origin }, &destination, arrive);
    let previous = match lookup(&key, spot, arrive, now) {
        Some(Lookup::Fresh(Saved::Drive(minutes), saved_origin, saved_destination)) => {
            return Fetch::Ready { minutes, origin_label: saved_origin.or(origin_label), destination_label: saved_destination.or(destination_label) };
        }
        Some(Lookup::Fresh(Saved::NoRoute, _, _)) => return Fetch::NoRoute,
        Some(Lookup::Fresh(Saved::Failed, _, _)) => return Fetch::Failed,
        // A saved 9 hour mismatch is not a useful first guess for the next ask.
        Some(Lookup::Stale(previous)) => previous.filter(|minutes| *minutes <= MAX_PLAUSIBLE_DRIVE),
        None => None,
    };
    let fetched = fetch_minutes(http, &origin, &destination, arrive, now, previous).await;
    let fetched = match fetched {
        Fetch::Ready { minutes, .. } => Fetch::Ready { minutes, origin_label: origin_label.clone(), destination_label: destination_label.clone() },
        other => other,
    };
    match &fetched {
        Fetch::Ready { minutes, origin_label, destination_label } => remember(&key, Saved::Drive(*minutes), spot, origin_label.clone(), destination_label.clone(), Utc::now()),
        Fetch::NoRoute => remember(&key, Saved::NoRoute, spot, None, None, Utc::now()),
        Fetch::Failed => remember(&key, Saved::Failed, spot, None, None, Utc::now()),
        // Don't remember a cap, or a vague address, as a failed drive.
        Fetch::Limited | Fetch::Vague => {}
    }
    fetched
}

async fn fetch_minutes(
    http: &reqwest::Client,
    origin: &str,
    destination: &str,
    arrive: DateTime<Utc>,
    now: DateTime<Utc>,
    previous: Option<u32>,
) -> Fetch {
    let Some(key) = api_key() else { return Fetch::Failed };
    let mut departure = first_departure(now, arrive, previous);
    let mut refined = false;
    // The first answer, kept if the refinement would pass the cap.
    let mut latest: Option<u32> = None;
    loop {
        // Count this attempt before it is sent, success or failure.
            if !try_spend(now) {
            return match latest {
                Some(minutes) => ready(minutes),
                None => Fetch::Limited,
            };
        }
        let seconds = match query(http, &key, origin, destination, departure).await {
            Query::Seconds(seconds) => seconds,
            failed => {
                return match (latest, failed) {
                    (Some(minutes), _) => ready(minutes),
                    (None, Query::NoRoute) => Fetch::NoRoute,
                    (None, _) => Fetch::Failed,
                };
            }
        };
        let Some(minutes) = minutes_from_seconds(seconds) else {
            return match latest {
                Some(minutes) => ready(minutes),
                None => Fetch::Failed,
            };
        };
        match judge(departure, minutes, arrive, now, refined) {
            Sample::Done(minutes) => return ready(minutes),
            Sample::Again(next) => {
                latest = Some(minutes);
                departure = next;
                refined = true;
            }
        }
    }
}

/// What Google said about one drive.
enum Query {
    Seconds(f64),
    /// No drive between the two (a place it can't find): not worth asking again soon.
    NoRoute,
    /// No answer: no internet, Google busy, a key problem.
    Failed,
}

async fn query(http: &reqwest::Client, key: &str, origin: &str, destination: &str, departure: DateTime<Utc>) -> Query {
    let Some(response) = http
        .post(ROUTES_URL)
        .timeout(Duration::from_secs(12))
        .header("X-Goog-Api-Key", key)
        .header("X-Goog-FieldMask", "routes.duration")
        .json(&route_request(origin, destination, departure))
        .send()
        .await
        .ok()
    else {
        return Query::Failed;
    };
    let status = response.status().as_u16();
    if !response.status().is_success() {
        // A place Google can't find comes back as a bad request (or not found).
        return if matches!(status, 400 | 404) { Query::NoRoute } else { Query::Failed };
    }
    let Ok(body) = response.json::<RoutesBody>().await else { return Query::Failed };
    let raw = body.routes.first().and_then(|route| route.duration.as_deref());
    // An answer with no route: there's no drive between them.
    match raw.and_then(|raw| raw.trim().strip_suffix('s')?.parse::<f64>().ok()) {
        Some(seconds) if seconds.is_finite() && seconds >= 0.0 => Query::Seconds(seconds),
        _ => Query::NoRoute,
    }
}

#[derive(serde::Deserialize)]
struct RoutesBody {
    #[serde(default)]
    routes: Vec<RouteLeg>,
}

#[derive(serde::Deserialize)]
struct RouteLeg {
    duration: Option<String>,
}

fn cache_key(origin: &str, destination: &str, arrive: DateTime<Utc>) -> String {
    // v2: a drive asked with the raw vague address (the wrong-town match) is not reused.
    format!("v2|{}|{}|{}", norm(origin), norm(destination), arrive.timestamp().div_euclid(60))
}

fn norm(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

struct Entry {
    saved: Saved,
    at: DateTime<Utc>,
    /// Where you were, for a drive from where you are.
    spot: Option<(f64, f64)>,
    origin_label: Option<String>,
    destination_label: Option<String>,
}

static CACHE: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);

/// A saved answer: still good, or too old (with its drive, a good first guess for the next ask).
enum Lookup {
    Fresh(Saved, Option<String>, Option<String>),
    Stale(Option<u32>),
}

fn lookup(key: &str, spot: Option<(f64, f64)>, arrive: DateTime<Utc>, now: DateTime<Utc>) -> Option<Lookup> {
    let cache = CACHE.lock().expect("not poisoned");
    let entry = cache.as_ref()?.get(key)?;
    let nearby = match (spot, entry.spot) {
        (Some(here), Some(there)) => km_between(here, there) <= NEARBY_KM,
        _ => true,
    };
    let previous = match entry.saved {
        Saved::Drive(minutes) => Some(minutes),
        _ => None,
    };
    Some(if nearby && still_fresh(entry.at, now, arrive, entry.saved) {
        Lookup::Fresh(entry.saved, entry.origin_label.clone(), entry.destination_label.clone())
    } else {
        Lookup::Stale(previous)
    })
}

fn remember(key: &str, saved: Saved, spot: Option<(f64, f64)>, origin_label: Option<String>, destination_label: Option<String>, now: DateTime<Utc>) {
    let mut cache = CACHE.lock().expect("not poisoned");
    let map = cache.get_or_insert_with(HashMap::new);
    // Drives from before vague addresses were resolved (no "v2|" key) matched the wrong town.
    map.retain(|saved_key, entry| saved_key.starts_with("v2|") && now.signed_duration_since(entry.at) < TimeDelta::hours(24));
    map.insert(key.to_string(), Entry { saved, at: now, spot, origin_label, destination_label });
}

/// Where a Routes API key comes from, if anywhere. The value itself stays here.
pub fn key_status() -> RoutesKeyStatus {
    let source = if env_key().is_some() {
        KeySource::Environment
    } else if keychain_key().is_some() {
        KeySource::Settings
    } else if dotenv_key().is_some() {
        KeySource::Dotenv
    } else {
        KeySource::None
    };
    RoutesKeyStatus { configured: source != KeySource::None, source }
}

pub fn api_key() -> Option<String> {
    env_key().or_else(keychain_key).or_else(dotenv_key)
}

fn env_key() -> Option<String> {
    let value = std::env::var(ENV_KEY).ok()?;
    let value = value.trim();
    if value.is_empty() { None } else { Some(value.to_string()) }
}

fn keychain_key() -> Option<String> {
    secrets::get(secrets::ROUTES_API_KEY).ok().flatten().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

/// Development builds only: the same `src-tauri/.env` as the OAuth client,
/// read when the app runs so the key is never compiled in. A release build
/// ignores it (the installed app shouldn't go looking for a file).
fn dotenv_key() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    for path in [".env", "src-tauri/.env", "../.env"] {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        if let Some(value) = parse_env_value(&text, ENV_KEY) {
            return Some(value);
        }
    }
    None
}

/// Saves or clears the key in the keychain. Empty clears it. A key in the
/// environment still wins until that variable is unset.
pub fn set_api_key(key: &str) -> crate::error::Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return secrets::delete(secrets::ROUTES_API_KEY);
    }
    if key.len() > 256 || key.chars().any(char::is_whitespace) {
        return Err(crate::error::AppError::InvalidInput("That doesn't look like an API key.".into()));
    }
    secrets::set(secrets::ROUTES_API_KEY, key)
}

/// One day's and one month's Routes requests, in Pacific time (the clock
/// Google's free cap uses). Counts are of attempts, not only successes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Usage {
    pub day: NaiveDate,
    pub day_count: u32,
    /// The first day of the counted month.
    pub month: NaiveDate,
    pub month_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub daily: u32,
    pub monthly: u32,
}

/// What one more request does to the count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Charge {
    Allowed(Usage),
    /// The day is full. `Usage` is the count after any date rollover, not incremented.
    Daily(Usage),
    /// The month is full.
    Monthly(Usage),
}

/// What Settings shows, and whether new requests are paused.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub day_count: u32,
    pub day_limit: u32,
    pub month_count: u32,
    pub month_limit: u32,
    /// "none", "day", or "month".
    pub capped: &'static str,
    pub max_daily: u32,
    pub max_monthly: u32,
}

/// The Pacific date Google uses for daily quotas and the monthly free cap.
pub fn pacific_date(now: DateTime<Utc>) -> NaiveDate {
    now.with_timezone(&chrono_tz::America::Los_Angeles).date_naive()
}

fn month_start(day: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(day.year(), day.month(), 1).expect("the first of the month")
}

/// A number from Settings, kept inside the range that cannot be unlimited.
pub fn clamp_limits(daily: u32, monthly: u32) -> Limits {
    Limits { daily: daily.min(MAX_DAILY), monthly: monthly.min(MAX_MONTHLY) }
}

/// Drop a finished day or month before deciding. A new month clears both.
pub fn roll(usage: Usage, today: NaiveDate) -> Usage {
    let month = month_start(today);
    if usage.month != month {
        Usage { day: today, day_count: 0, month, month_count: 0 }
    } else if usage.day != today {
        Usage { day: today, day_count: 0, ..usage }
    } else {
        usage
    }
}

/// Count one Routes attempt if both caps still have room. A failure counts
/// the same as a success: the caller records the attempt, then sends.
pub fn charge(usage: Usage, today: NaiveDate, limits: Limits) -> Charge {
    let usage = roll(usage, today);
    if usage.month_count >= limits.monthly {
        return Charge::Monthly(usage);
    }
    if usage.day_count >= limits.daily {
        return Charge::Daily(usage);
    }
    Charge::Allowed(Usage { day_count: usage.day_count + 1, month_count: usage.month_count + 1, ..usage })
}

#[derive(Serialize, Deserialize)]
struct SavedUsage {
    day: String,
    day_count: u32,
    month: String,
    month_count: u32,
}

impl SavedUsage {
    fn from_usage(usage: &Usage) -> Self {
        SavedUsage {
            day: usage.day.to_string(),
            day_count: usage.day_count,
            month: format!("{:04}-{:02}", usage.month.year(), usage.month.month()),
            month_count: usage.month_count,
        }
    }

    fn to_usage(&self) -> Option<Usage> {
        let day = NaiveDate::parse_from_str(&self.day, "%Y-%m-%d").ok()?;
        let month = NaiveDate::parse_from_str(&format!("{}-01", self.month), "%Y-%m-%d").ok()?;
        Some(Usage { day, day_count: self.day_count, month, month_count: self.month_count })
    }
}

/// The count on disk, so it survives a restart. `path` None is memory only
/// (tests, or a config folder that couldn't be found).
pub struct UsageStore {
    path: Option<std::path::PathBuf>,
    usage: Usage,
}

impl UsageStore {
    pub fn load(path: Option<std::path::PathBuf>) -> Self {
        let usage = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice::<SavedUsage>(&bytes).ok())
            .and_then(|saved| saved.to_usage())
            .unwrap_or_else(|| Usage { day: pacific_date(Utc::now()), day_count: 0, month: month_start(pacific_date(Utc::now())), month_count: 0 });
        UsageStore { path, usage }
    }

    /// Record one attempt. False when a cap is already full, or the count
    /// could not be saved (then nothing is sent, so a restart can't forget it
    /// and keep going).
    pub fn try_spend(&mut self, now: DateTime<Utc>, limits: Limits) -> bool {
        let limits = clamp_limits(limits.daily, limits.monthly);
        match charge(self.usage.clone(), pacific_date(now), limits) {
            Charge::Allowed(next) => {
                self.usage = next;
                self.save()
            }
            Charge::Daily(rolled) | Charge::Monthly(rolled) => {
                self.usage = rolled;
                let _ = self.save();
                false
            }
        }
    }

    pub fn snapshot(&self, now: DateTime<Utc>, limits: Limits) -> UsageSnapshot {
        let limits = clamp_limits(limits.daily, limits.monthly);
        let usage = roll(self.usage.clone(), pacific_date(now));
        let capped = if usage.month_count >= limits.monthly {
            "month"
        } else if usage.day_count >= limits.daily {
            "day"
        } else {
            "none"
        };
        UsageSnapshot {
            day_count: usage.day_count,
            day_limit: limits.daily,
            month_count: usage.month_count,
            month_limit: limits.monthly,
            capped,
            max_daily: MAX_DAILY,
            max_monthly: MAX_MONTHLY,
        }
    }

    /// False when a file was supposed to be written and wasn't.
    fn save(&self) -> bool {
        let Some(path) = &self.path else { return true };
        let Ok(json) = serde_json::to_vec_pretty(&SavedUsage::from_usage(&self.usage)) else { return false };
        if let Some(dir) = path.parent()
            && std::fs::create_dir_all(dir).is_err()
        {
            return false;
        }
        let temporary = path.with_extension("json.tmp");
        if std::fs::write(&temporary, json).is_err() {
            return false;
        }
        std::fs::rename(&temporary, path).is_ok()
    }
}

static USAGE: Mutex<Option<UsageStore>> = Mutex::new(None);

/// Reads the usage file once at startup. Missing means a count of zero.
pub fn init_usage(path: Option<std::path::PathBuf>) {
    *USAGE.lock().expect("not poisoned") = Some(UsageStore::load(path));
}

fn with_store<T>(f: impl FnOnce(&mut UsageStore) -> T) -> T {
    let mut guard = USAGE.lock().expect("not poisoned");
    if guard.is_none() {
        *guard = Some(UsageStore::load(None));
    }
    f(guard.as_mut().expect("loaded above"))
}

fn current_limits() -> Limits {
    let prefs = crate::prefs::get();
    clamp_limits(prefs.routes_daily_limit, prefs.routes_monthly_limit)
}

/// Count one attempt against the saved caps. False means do not send.
fn try_spend(now: DateTime<Utc>) -> bool {
    with_store(|store| store.try_spend(now, current_limits()))
}

/// The counts Settings shows.
pub fn usage_snapshot(now: DateTime<Utc>) -> UsageSnapshot {
    with_store(|store| store.snapshot(now, current_limits()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, TimeZone};

    fn utc(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    #[test]
    fn only_real_places_need_travel() {
        assert!(is_physical("Cafe Roma, 12 High St"));
        assert!(is_physical("Room 4"));
        assert!(!is_physical("https://zoom.us/j/123"));
        assert!(!is_physical("Microsoft Teams Meeting"));
        assert!(!is_physical("meet.google.com/abc"));
        assert!(!is_physical("Phone call"));
        assert!(!is_physical("  "));
    }

    #[test]
    fn an_event_address_wins_over_the_default() {
        assert_eq!(resolve_origin(Some("  Office  "), "Home").as_deref(), Some("Office"));
        assert_eq!(resolve_origin(Some("  "), "Home").as_deref(), Some("Home"));
        assert_eq!(resolve_origin(None, "  ").as_deref(), None);
        assert_eq!(resolve_origin(None, "Home").as_deref(), Some("Home"));
    }

    #[test]
    fn where_you_are_goes_to_google_as_coordinates() {
        let spot = spot_origin(42.44731, -71.22719);
        assert_eq!(spot, "@42.447,-71.227");
        assert_eq!(parse_spot(&spot), Some((42.447, -71.227)));
        assert_eq!(parse_spot("10 Battle Rd, Lexington, MA"), None);
        assert_eq!(parse_spot("@95,0"), None);
        let body = route_request(&spot, "Church", Utc::now());
        assert_eq!(body["origin"]["location"]["latLng"]["latitude"], json!(42.447));
        assert!(body["origin"].get("address").is_none());
        let body = route_request("10 Battle Rd, Lexington, MA", "Church", Utc::now());
        assert_eq!(body["origin"]["address"], json!("10 Battle Rd, Lexington, MA"));
        // The event's own address wins; then where you are; then Settings.
        assert_eq!(pick_origin(Some("Office"), Some(&spot), "Home").as_deref(), Some("Office"));
        assert_eq!(pick_origin(None, Some(&spot), "Home").as_deref(), Some(spot.as_str()));
        assert_eq!(pick_origin(None, None, "Home").as_deref(), Some("Home"));
        assert_eq!(pick_origin(None, Some("nonsense"), "Home").as_deref(), Some("Home"));
    }

    #[test]
    fn a_drive_too_long_to_be_right_gets_no_leave_time() {
        let arrive = Utc::now() + TimeDelta::hours(5);
        // 550 minutes: "10 Battle Rd" matched nine hours away.
        let wrong = answer(Some(550), arrive, TravelStatus::Ok);
        assert_eq!(wrong.status, TravelStatus::Implausible);
        assert_eq!(wrong.leave_at, None);
        assert_eq!(wrong.minutes, Some(550));
        let right = answer(Some(20), arrive, TravelStatus::Ok);
        assert_eq!(right.status, TravelStatus::Ok);
        assert!(right.leave_at.is_some());
        assert_eq!(answer(Some(MAX_PLAUSIBLE_DRIVE), arrive, TravelStatus::Ok).status, TravelStatus::Ok);
    }

    #[test]
    fn leave_at_subtracts_the_drive_and_the_buffer() {
        let arrive = utc("2026-11-02T15:00:00Z");
        let leave = leave_at(arrive, 30, 0).unwrap();
        assert_eq!(leave, utc("2026-11-02T14:30:00Z"));
        let early = leave_at(arrive, 30, 10).unwrap();
        assert_eq!(early, utc("2026-11-02T14:20:00Z"));
        // No buffer and no drive: you leave as it starts.
        assert_eq!(leave_at(arrive, 0, 0).unwrap(), arrive);
    }

    #[test]
    fn durations_round_up_to_a_whole_minute() {
        assert_eq!(parse_duration("90s"), Some(2));
        assert_eq!(parse_duration("60s"), Some(1));
        assert_eq!(parse_duration("0s"), Some(0));
        assert_eq!(parse_duration("61s"), Some(2));
        assert_eq!(parse_duration("119.2s"), Some(2));
        assert_eq!(parse_duration("  30s "), Some(1));
        // A 20 minute drive is 1200 seconds, not 1200 minutes. 570 minutes is 34200 seconds.
        assert_eq!(parse_duration("1200s"), Some(20));
        assert_eq!(parse_duration("34200s"), Some(570));
        assert_eq!(parse_duration("1200"), None);
        assert_eq!(parse_duration("10"), None);
        assert_eq!(parse_duration("-5s"), None);
        assert_eq!(parse_duration(""), None);
        assert_eq!(minutes_from_seconds(f64::NAN), None);
    }

    #[test]
    fn closer_events_are_refreshed_sooner() {
        assert_eq!(fresh_for(TimeDelta::minutes(20)), TimeDelta::minutes(10));
        assert_eq!(fresh_for(TimeDelta::minutes(45)), TimeDelta::minutes(10));
        assert_eq!(fresh_for(TimeDelta::hours(2)), TimeDelta::minutes(30));
        assert_eq!(fresh_for(TimeDelta::hours(6)), TimeDelta::hours(2));
        assert_eq!(fresh_for(TimeDelta::hours(20)), TimeDelta::hours(12));

        let arrive = utc("2026-11-02T16:00:00Z");
        let now = utc("2026-11-02T14:00:00Z"); // two hours out: fresh for 30 min
        let drive = Saved::Drive(20);
        assert!(still_fresh(utc("2026-11-02T13:40:00Z"), now, arrive, drive));
        assert!(!still_fresh(utc("2026-11-02T13:20:00Z"), now, arrive, drive));
        // Once it's time to leave, the drive is kept.
        assert!(still_fresh(utc("2026-11-02T15:00:00Z"), utc("2026-11-02T15:45:00Z"), arrive, drive));
        // A 9 hour mismatch is not kept just because that bogus leave time has passed.
        let wrong = Saved::Drive(550);
        let soon = utc("2026-11-02T18:00:00Z");
        assert!(still_fresh(utc("2026-11-02T13:00:00Z"), now, soon, wrong));
        assert!(!still_fresh(utc("2026-11-01T13:00:00Z"), now, soon, wrong));
        // A failure is reused for ten minutes, then asked again.
        assert!(still_fresh(utc("2026-11-02T13:55:00Z"), now, arrive, Saved::Failed));
        assert!(!still_fresh(utc("2026-11-02T13:45:00Z"), now, arrive, Saved::Failed));
        // A place Google can't drive to isn't asked about again for 12 hours.
        assert!(still_fresh(utc("2026-11-02T03:00:00Z"), now, arrive, Saved::NoRoute));
        assert!(!still_fresh(utc("2026-11-02T01:00:00Z"), now, arrive, Saved::NoRoute));
        // A clock that jumps backwards isn't "fresh".
        assert!(!still_fresh(now, utc("2026-11-02T13:50:00Z"), arrive, drive));
    }

    #[test]
    fn nearby_spots_share_a_drive() {
        // About 1.1 km north, and about 11 km.
        assert!(km_between((34.85, -82.40), (34.86, -82.40)) < NEARBY_KM);
        assert!(km_between((34.85, -82.40), (34.95, -82.40)) > NEARBY_KM);
    }

    /// The most lookups one event can take, start to finish, if it's on screen
    /// all the time: few enough that 80 a day covers a busy day.
    #[test]
    fn an_event_takes_few_lookups() {
        let arrive = utc("2026-11-03T15:00:00Z");
        let drive = 25;
        let mut now = arrive - LOOKUP_HORIZON;
        let mut fetched: Option<DateTime<Utc>> = None;
        let mut asks = 0;
        while now < arrive {
            if !fetched.is_some_and(|at| still_fresh(at, now, arrive, Saved::Drive(drive))) {
                asks += 1;
                fetched = Some(now);
            }
            now += TimeDelta::minutes(1);
        }
        assert!(asks <= 16, "{asks} lookups");
    }

    #[test]
    fn lookups_wait_until_the_event_is_close_enough() {
        let now = utc("2026-11-01T12:00:00Z");
        assert!(should_query(now, utc("2026-11-02T12:00:00Z")));
        assert!(!should_query(now, utc("2026-11-04T12:00:01Z")));
        assert!(!should_query(now, now));
        assert!(device_should_query(now, utc("2026-11-01T14:00:00Z")));
        assert!(!device_should_query(now, utc("2026-11-01T16:00:00Z")));
    }

    #[test]
    fn the_first_guess_is_not_in_the_past() {
        let arrive = utc("2026-11-02T15:00:00Z");
        assert_eq!(first_departure(utc("2026-11-02T13:00:00Z"), arrive, None), utc("2026-11-02T14:30:00Z"));
        // Half an hour before would be 14:30, which is already past.
        assert_eq!(first_departure(utc("2026-11-02T14:50:00Z"), arrive, None), utc("2026-11-02T14:51:00Z"));
        // The last drive's length is the better guess.
        assert_eq!(first_departure(utc("2026-11-02T13:00:00Z"), arrive, Some(45)), utc("2026-11-02T14:15:00Z"));
    }

    #[test]
    fn a_bad_guess_is_asked_once_more() {
        let arrive = utc("2026-11-02T15:00:00Z");
        let now = utc("2026-11-02T12:00:00Z");
        let queried = utc("2026-11-02T14:00:00Z");
        // 30 min drive means leave at 14:30, half an hour off the guess.
        assert_eq!(judge(queried, 30, arrive, now, false), Sample::Again(utc("2026-11-02T14:30:00Z")));
        // The second answer is kept.
        assert_eq!(judge(queried, 30, arrive, now, true), Sample::Done(30));
        // Ten minutes or less isn't worth another request. The gap is strict.
        assert_eq!(judge(utc("2026-11-02T14:20:00Z"), 30, arrive, now, false), Sample::Done(30));
        assert_eq!(judge(utc("2026-11-02T14:19:00Z"), 30, arrive, now, false), Sample::Again(utc("2026-11-02T14:30:00Z")));
    }

    #[test]
    fn an_events_own_leave_alert_replaces_the_automatic_one() {
        assert_eq!(alert_buffers(&[10, 0], true, TimeDelta::hours(2)), vec![10, 0]);
        // Far enough out that the automatic one wouldn't have fired yet.
        assert_eq!(alert_buffers(&[10], false, TimeDelta::hours(20)), vec![10]);
        assert_eq!(alert_buffers(&[], true, TimeDelta::hours(2)), vec![LEGACY_BUFFER_MINUTES]);
        assert_eq!(alert_buffers(&[], true, TimeDelta::hours(4)), Vec::<u32>::new());
        assert_eq!(alert_buffers(&[], false, TimeDelta::hours(1)), Vec::<u32>::new());
        assert!(alert_buffers(&[], true, TimeDelta::minutes(-5)).is_empty());
    }

    #[test]
    fn a_leave_alert_fires_when_its_time_comes_and_not_after_the_start() {
        let start = Local.with_ymd_and_hms(2026, 11, 2, 15, 0, 0).unwrap();
        let sent = std::collections::HashSet::new();
        let early = start - TimeDelta::minutes(41); // alert is at 14:20
        assert!(notices("e", "start", "Dentist", "123 Main St", start, 30, &[10], early, &sent).is_empty());

        let due = start - TimeDelta::minutes(40);
        let fired = notices("e", "start", "Dentist", "123 Main St", start, 30, &[10], due, &sent);
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].key, "leave|e|start|10");
        assert_eq!(fired[0].title, "Time to leave for Dentist");
        assert!(fired[0].body.starts_with("30 min drive · leave by "));
        assert!(fired[0].body.contains("10 min to spare"));
        assert!(fired[0].body.ends_with(" · 123 Main St"));

        // Already shown.
        let mut sent = sent;
        sent.insert(fired[0].key.clone());
        assert!(notices("e", "start", "Dentist", "123 Main St", start, 30, &[10], due, &sent).is_empty());

        // The event has started: no "you should have left" after you're there.
        let late = start + TimeDelta::minutes(1);
        assert!(notices("e", "start", "Dentist", "123 Main St", start, 30, &[10], late, &std::collections::HashSet::new()).is_empty());
    }

    #[test]
    fn two_buffers_can_both_be_due() {
        let start = Local.with_ymd_and_hms(2026, 11, 2, 15, 0, 0).unwrap();
        let now = start - TimeDelta::minutes(30); // leave-by itself; the 10-min one was earlier
        let fired = notices("e", "s", "Lunch", "Cafe", start, 30, &[10, 0], now, &std::collections::HashSet::new());
        let keys: Vec<_> = fired.iter().map(|n| n.key.as_str()).collect();
        assert_eq!(keys, vec!["leave|e|s|10", "leave|e|s|0"]);
        assert!(!fired[1].body.contains("to spare"));
    }

    #[test]
    fn classify_fails_closed_without_a_place_a_key_or_an_address() {
        let now = utc("2026-11-02T12:00:00Z");
        let soon = utc("2026-11-02T14:00:00Z");
        let later = utc("2026-11-03T12:00:00Z");
        let far = utc("2026-11-06T12:00:00Z");
        assert_eq!(classify("https://zoom.us/j/1", soon, now, Some("Home"), true, true), Classify::Status(TravelStatus::NotPhysical));
        assert_eq!(classify("Cafe", now, now, Some("Home"), true, true), Classify::Status(TravelStatus::Past));
        // An address with no key is not quietly replaced by the device.
        assert_eq!(classify("Cafe", soon, now, Some("Home"), false, true), Classify::Status(TravelStatus::NoKey));
        assert_eq!(classify("Cafe", far, now, Some("Home"), true, true), Classify::Status(TravelStatus::TooFar));
        assert_eq!(classify("Cafe", soon, now, Some(" Home "), true, false), Classify::Routes("Home".into()));
        assert_eq!(classify("Cafe", soon, now, None, false, true), Classify::Device);
        // Tomorrow, and no address: ask for one, even on a Mac.
        assert_eq!(classify("Cafe", later, now, None, true, true), Classify::Status(TravelStatus::NoOrigin));
        assert_eq!(classify("Cafe", soon, now, None, true, false), Classify::Status(TravelStatus::NoOrigin));
    }

    #[test]
    fn the_routes_request_asks_for_traffic_at_a_departure() {
        let body = route_request("Home", "Cafe Roma", utc("2026-11-02T14:30:00Z"));
        assert_eq!(body["origin"]["address"], "Home");
        assert_eq!(body["destination"]["address"], "Cafe Roma");
        assert_eq!(body["travelMode"], "DRIVE");
        assert_eq!(body["routingPreference"], "TRAFFIC_AWARE");
        assert_eq!(body["departureTime"], "2026-11-02T14:30:00Z");
        assert_eq!(body["computeAlternativeRoutes"], false);
    }

    #[test]
    fn an_env_file_line_is_read_without_keeping_quotes() {
        let text = "# comment\nOTHER=nope\nMINUTEMAN_ROUTES_API_KEY=\"abc-123\"\n";
        assert_eq!(parse_env_value(text, ENV_KEY).as_deref(), Some("abc-123"));
        assert_eq!(parse_env_value("MINUTEMAN_ROUTES_API_KEY=\n", ENV_KEY), None);
        assert_eq!(parse_env_value("MINUTEMAN_ROUTES_API_KEY=  \n", ENV_KEY), None);
    }

    fn empty(day: NaiveDate) -> Usage {
        Usage { day, day_count: 0, month: month_start(day), month_count: 0 }
    }

    fn day(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn pacific_midnight_is_the_quota_boundary() {
        // December is Pacific Standard Time (UTC−8): midnight is 08:00 UTC.
        assert_eq!(pacific_date(utc("2026-12-01T07:30:00Z")), day(2026, 11, 30));
        assert_eq!(pacific_date(utc("2026-12-01T08:30:00Z")), day(2026, 12, 1));
        // July is daylight time (UTC−7): midnight is 07:00 UTC.
        assert_eq!(pacific_date(utc("2026-07-01T06:30:00Z")), day(2026, 6, 30));
        assert_eq!(pacific_date(utc("2026-07-01T07:30:00Z")), day(2026, 7, 1));
    }

    #[test]
    fn every_attempt_counts_and_the_next_one_stops() {
        let today = day(2026, 6, 15);
        let limits = Limits { daily: 2, monthly: 10 };
        let once = charge(empty(today), today, limits);
        let Charge::Allowed(usage) = once else { panic!("first attempt") };
        assert_eq!((usage.day_count, usage.month_count), (1, 1));
        // A failure is the same charge: the caller records it before hearing back.
        let Charge::Allowed(usage) = charge(usage, today, limits) else { panic!("second") };
        assert_eq!(usage.day_count, 2);
        match charge(usage.clone(), today, limits) {
            Charge::Daily(stayed) => assert_eq!(stayed.day_count, 2),
            other => panic!("expected the daily cap, got {other:?}"),
        }
    }

    #[test]
    fn a_new_day_resets_the_day_and_a_new_month_resets_both() {
        let june = day(2026, 6, 15);
        let limits = Limits { daily: 2, monthly: 10 };
        let usage = Usage { day: june, day_count: 2, month: month_start(june), month_count: 5 };
        let Charge::Allowed(next) = charge(usage, day(2026, 6, 16), limits) else { panic!("next day") };
        assert_eq!((next.day_count, next.month_count), (1, 6));

        let Charge::Allowed(july) = charge(next, day(2026, 7, 1), limits) else { panic!("next month") };
        assert_eq!((july.day_count, july.month_count), (1, 1));
        assert_eq!(july.month, day(2026, 7, 1));
    }

    #[test]
    fn the_monthly_cap_stops_a_fresh_day() {
        let today = day(2026, 6, 15);
        let usage = Usage { day: today, day_count: 0, month: month_start(today), month_count: 4 };
        let limits = Limits { daily: 80, monthly: 4 };
        match charge(usage, today, limits) {
            Charge::Monthly(stayed) => assert_eq!((stayed.day_count, stayed.month_count), (0, 4)),
            other => panic!("expected the monthly cap, got {other:?}"),
        }
        // Zero means no requests at all, which is still not unlimited.
        match charge(empty(today), today, Limits { daily: 0, monthly: 10 }) {
            Charge::Daily(stayed) => assert_eq!(stayed.day_count, 0),
            other => panic!("expected a daily stop, got {other:?}"),
        }
    }

    #[test]
    fn a_limit_above_the_free_tier_is_pulled_back() {
        assert_eq!(clamp_limits(10_000, 10_000), Limits { daily: MAX_DAILY, monthly: MAX_MONTHLY });
        assert_eq!(clamp_limits(0, 2_500), Limits { daily: 0, monthly: DEFAULT_MONTHLY });
        // 160 a day for 31 days is 4,960, under the 5,000 free requests.
        assert!(MAX_DAILY as u64 * 31 <= FREE_ROUTES_PER_MONTH as u64);
        assert!(DEFAULT_DAILY as u64 * 31 < FREE_ROUTES_PER_MONTH as u64 / 2);
        assert!(MAX_MONTHLY < FREE_ROUTES_PER_MONTH);
    }

    #[test]
    fn the_count_survives_a_restart_and_then_stops() {
        let path = std::env::temp_dir().join(format!("minuteman-routes-usage-{}-restart.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let now = utc("2026-06-15T18:00:00Z");
        let limits = Limits { daily: 2, monthly: 10 };
        {
            let mut store = UsageStore::load(Some(path.clone()));
            assert!(store.try_spend(now, limits));
            assert!(store.try_spend(now, limits));
            assert!(!store.try_spend(now, limits));
        }
        let mut store = UsageStore::load(Some(path.clone()));
        assert_eq!(store.usage.day_count, 2);
        assert_eq!(store.snapshot(now, limits).capped, "day");
        // The next Pacific day is allowed again, and the month keeps counting.
        let tomorrow = utc("2026-06-16T18:00:00Z");
        assert!(store.try_spend(tomorrow, limits));
        assert_eq!((store.usage.day_count, store.usage.month_count), (1, 3));
        let _ = std::fs::remove_file(&path);
    }
}
