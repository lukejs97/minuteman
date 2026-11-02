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
/// ("10 Mill Park Ct" with several in the country). No leave-by time or alert
/// is given for it; the minutes are kept so the details can say so. Kept in
/// step with `MAX_PLAUSIBLE_DRIVE_MINUTES` in src/routes-budget.ts.
pub const MAX_PLAUSIBLE_DRIVE: u32 = 240;
/// Live traffic isn't worth a lookup until the event is this close.
pub const LOOKUP_HORIZON: TimeDelta = TimeDelta::hours(48);
/// Ask again when the guessed departure and the drive disagree by more.
const REFINE_GAP_MINUTES: i64 = 10;
/// A failed lookup is remembered this long, so a blip isn't retried at once
/// and a real outage isn't retried on every check.
const FAILURE_TTL: TimeDelta = TimeDelta::minutes(2);
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
    /// The daily or monthly Routes cap is used up. A drive already saved is
    /// still shown; nothing new is asked of Google.
    Limited,
    /// Google's drive is longer than `MAX_PLAUSIBLE_DRIVE`: probably an
    /// address matched in the wrong town. No leave-by time is given.
    Implausible,
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
/// sooner, because that's when traffic actually moves the leave-by time.
pub fn fresh_for(until_arrival: TimeDelta) -> TimeDelta {
    if until_arrival <= TimeDelta::minutes(45) {
        TimeDelta::minutes(5)
    } else if until_arrival <= TimeDelta::hours(3) {
        TimeDelta::minutes(15)
    } else if until_arrival <= TimeDelta::hours(12) {
        TimeDelta::hours(1)
    } else {
        TimeDelta::hours(4)
    }
}

/// Whether an answer fetched at `fetched` can still be used at `now`.
pub fn still_fresh(fetched: DateTime<Utc>, now: DateTime<Utc>, arrive: DateTime<Utc>, failed: bool) -> bool {
    let age = now.signed_duration_since(fetched);
    if age < TimeDelta::zero() {
        return false;
    }
    if failed {
        return age < FAILURE_TTL;
    }
    let until = arrive.signed_duration_since(now);
    age < fresh_for(until)
}

/// Whether it's worth asking about a drive that should arrive at `arrive`.
pub fn should_query(now: DateTime<Utc>, arrive: DateTime<Utc>) -> bool {
    arrive > now && arrive.signed_duration_since(now) <= LOOKUP_HORIZON
}

/// The device-location fallback only covers the next few hours.
pub fn device_should_query(now: DateTime<Utc>, arrive: DateTime<Utc>) -> bool {
    arrive > now && arrive.signed_duration_since(now) <= LEGACY_HORIZON
}

/// The departure to ask about first: half an hour before arrival, but never
/// in the past (Routes rejects that).
pub fn first_departure(now: DateTime<Utc>, arrive: DateTime<Utc>) -> DateTime<Utc> {
    let soonest = now + TimeDelta::seconds(60);
    let guess = arrive - TimeDelta::minutes(30);
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
    json!({
        "origin": { "address": origin },
        "destination": { "address": destination },
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
        return TravelAnswer { minutes, leave_at: None, status: TravelStatus::Implausible };
    }
    let leave_at = minutes.and_then(|m| leave_at(arrive, m, 0)).map(|t| t.to_rfc3339());
    TravelAnswer { minutes, leave_at, status }
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
    device: F,
) -> TravelAnswer
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Option<u32>>,
{
    match classify(destination, arrive, now, origin, has_key, allow_device) {
        Classify::Status(status) => answer(None, arrive, status),
        Classify::Routes(origin) => match driving_minutes(http, &origin, destination, arrive, now).await {
            Fetch::Ready(minutes) => answer(Some(minutes), arrive, TravelStatus::Ok),
            // No new request. A drive saved earlier is returned above, from
            // the cache, and can still fire a leave alert. With nothing saved,
            // the alert waits.
            Fetch::Limited => answer(None, arrive, TravelStatus::Limited),
            Fetch::Failed => answer(None, arrive, TravelStatus::Unavailable),
        },
        Classify::Device => {
            let key = cache_key(DEVICE_ORIGIN, destination, arrive);
            if let Some(cached) = lookup(&key, arrive, now) {
                return answer(cached, arrive, if cached.is_some() { TravelStatus::Ok } else { TravelStatus::Unavailable });
            }
            let minutes = device().await;
            remember(&key, minutes, Utc::now());
            answer(minutes, arrive, if minutes.is_some() { TravelStatus::Ok } else { TravelStatus::Unavailable })
        }
    }
}

enum Fetch {
    Ready(u32),
    Failed,
    Limited,
}

async fn driving_minutes(
    http: &reqwest::Client,
    origin: &str,
    destination: &str,
    arrive: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Fetch {
    let key = cache_key(origin, destination, arrive);
    if let Some(cached) = lookup(&key, arrive, now) {
        return match cached {
            Some(minutes) => Fetch::Ready(minutes),
            None => Fetch::Failed,
        };
    }
    let fetched = fetch_minutes(http, origin, destination, arrive, now).await;
    match fetched {
        Fetch::Ready(minutes) => remember(&key, Some(minutes), Utc::now()),
        Fetch::Failed => remember(&key, None, Utc::now()),
        // Don't remember a cap as a failed drive: when the day turns, the
        // next check should ask again instead of waiting out a failure.
        Fetch::Limited => {}
    }
    fetched
}

async fn fetch_minutes(
    http: &reqwest::Client,
    origin: &str,
    destination: &str,
    arrive: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Fetch {
    let Some(key) = api_key() else { return Fetch::Failed };
    let mut departure = first_departure(now, arrive);
    let mut refined = false;
    // The first answer, kept if the refinement would pass the cap.
    let mut latest: Option<u32> = None;
    loop {
        // Count this attempt before it is sent, success or failure.
        if !try_spend(now) {
            return match latest {
                Some(minutes) => Fetch::Ready(minutes),
                None => Fetch::Limited,
            };
        }
        let Some(seconds) = query(http, &key, origin, destination, departure).await else {
            return match latest {
                Some(minutes) => Fetch::Ready(minutes),
                None => Fetch::Failed,
            };
        };
        let Some(minutes) = minutes_from_seconds(seconds) else {
            return match latest {
                Some(minutes) => Fetch::Ready(minutes),
                None => Fetch::Failed,
            };
        };
        match judge(departure, minutes, arrive, now, refined) {
            Sample::Done(minutes) => return Fetch::Ready(minutes),
            Sample::Again(next) => {
                latest = Some(minutes);
                departure = next;
                refined = true;
            }
        }
    }
}

async fn query(http: &reqwest::Client, key: &str, origin: &str, destination: &str, departure: DateTime<Utc>) -> Option<f64> {
    let response = http
        .post(ROUTES_URL)
        .timeout(Duration::from_secs(12))
        .header("X-Goog-Api-Key", key)
        .header("X-Goog-FieldMask", "routes.duration")
        .json(&route_request(origin, destination, departure))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: RoutesBody = response.json().await.ok()?;
    let raw = body.routes.first()?.duration.as_deref()?;
    let seconds: f64 = raw.trim().strip_suffix('s')?.parse().ok()?;
    if seconds.is_finite() && seconds >= 0.0 { Some(seconds) } else { None }
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
    format!("{}|{}|{}", norm(origin), norm(destination), arrive.timestamp().div_euclid(60))
}

fn norm(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

struct Entry {
    minutes: Option<u32>,
    at: DateTime<Utc>,
}

static CACHE: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);

fn lookup(key: &str, arrive: DateTime<Utc>, now: DateTime<Utc>) -> Option<Option<u32>> {
    let cache = CACHE.lock().expect("not poisoned");
    let entry = cache.as_ref()?.get(key)?;
    if still_fresh(entry.at, now, arrive, entry.minutes.is_none()) { Some(entry.minutes) } else { None }
}

fn remember(key: &str, minutes: Option<u32>, now: DateTime<Utc>) {
    let mut cache = CACHE.lock().expect("not poisoned");
    let map = cache.get_or_insert_with(HashMap::new);
    map.retain(|_, entry| now.signed_duration_since(entry.at) < TimeDelta::hours(24));
    map.insert(key.to_string(), Entry { minutes, at: now });
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
    fn a_drive_too_long_to_be_right_gets_no_leave_time() {
        let arrive = Utc::now() + TimeDelta::hours(5);
        // 550 minutes: "10 Mill Park Ct" matched nine hours away.
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
        assert_eq!(parse_duration("10"), None);
        assert_eq!(parse_duration("-5s"), None);
        assert_eq!(parse_duration(""), None);
        assert_eq!(minutes_from_seconds(f64::NAN), None);
    }

    #[test]
    fn closer_events_are_refreshed_sooner() {
        assert_eq!(fresh_for(TimeDelta::minutes(20)), TimeDelta::minutes(5));
        assert_eq!(fresh_for(TimeDelta::minutes(45)), TimeDelta::minutes(5));
        assert_eq!(fresh_for(TimeDelta::hours(2)), TimeDelta::minutes(15));
        assert_eq!(fresh_for(TimeDelta::hours(6)), TimeDelta::hours(1));
        assert_eq!(fresh_for(TimeDelta::hours(20)), TimeDelta::hours(4));

        let arrive = utc("2026-11-02T16:00:00Z");
        let now = utc("2026-11-02T14:00:00Z"); // two hours out: fresh for 15 min
        let fetched = utc("2026-11-02T13:50:00Z");
        assert!(still_fresh(fetched, now, arrive, false));
        assert!(!still_fresh(utc("2026-11-02T13:40:00Z"), now, arrive, false));
        // A failure is reused for two minutes, then asked again.
        assert!(still_fresh(utc("2026-11-02T13:59:00Z"), now, arrive, true));
        assert!(!still_fresh(utc("2026-11-02T13:57:00Z"), now, arrive, true));
        // A clock that jumps backwards isn't "fresh".
        assert!(!still_fresh(now, fetched, arrive, false));
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
        assert_eq!(first_departure(utc("2026-11-02T13:00:00Z"), arrive), utc("2026-11-02T14:30:00Z"));
        // Half an hour before would be 14:30, which is already past.
        assert_eq!(first_departure(utc("2026-11-02T14:50:00Z"), arrive), utc("2026-11-02T14:51:00Z"));
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
