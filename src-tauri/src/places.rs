//! Place search with TomTom, for when OpenStreetMap (searched by the page,
//! with Photon) doesn't know a place by the name typed. Only then, and only
//! with a key: none is built in.
//!
//! It never costs money: TomTom's free tier needs no card and turns requests
//! down past it (HTTP 429), and Minuteman stops well before, counting every
//! attempt (`DAILY` and `MONTHLY`, in places-usage.json, the same way as the
//! Routes cap). TomTom's pricing page (checked 2026-11-09) gives Places
//! Search 5,000 free place searches a month, and the older Search API 5,000.
//!
//! The newer Places Search (`discover`) is asked first; if it doesn't answer
//! in the form expected (an older key, a change on TomTom's side), the
//! older Search API is.

use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{AppError, Result};
use crate::leave::{Limits, UsageSnapshot, UsageStore};
use crate::secrets;

pub const ENV_KEY: &str = "MINUTEMAN_TOMTOM_API_KEY";
const DISCOVER_URL: &str = "https://api.tomtom.com/maps/orbis/places/discover";
const SEARCH_URL: &str = "https://api.tomtom.com/search/2/search";
/// Searches a day and a month, on this computer. The website keeps its own
/// count; both together stay under TomTom's 5,000 a month (100 × 31 = 3,100,
/// and 1,500 + 1,500 = 3,000).
pub const DAILY: u32 = 100;
pub const MONTHLY: u32 = 1_500;
const LIMIT: usize = 5;

/// A place TomTom found, in the parts the page's suggestions use.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FoundPlace {
    pub name: Option<String>,
    pub street: String,
    pub town: String,
    /// "NC" in the US.
    pub state: String,
    pub zip: String,
    /// Empty in the US.
    pub country: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

/// Near here, to rank what's close first.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Near {
    pub latitude: f64,
    pub longitude: f64,
}

static USAGE: Mutex<Option<UsageStore>> = Mutex::new(None);

pub fn init_usage(path: Option<std::path::PathBuf>) {
    *USAGE.lock().expect("not poisoned") = Some(UsageStore::load(path));
}

const LIMITS: Limits = Limits { daily: DAILY, monthly: MONTHLY };

fn try_spend(now: DateTime<Utc>) -> bool {
    let mut usage = USAGE.lock().expect("not poisoned");
    usage.get_or_insert_with(|| UsageStore::load(None)).try_spend(now, LIMITS)
}

pub fn usage_snapshot(now: DateTime<Utc>) -> UsageSnapshot {
    let mut usage = USAGE.lock().expect("not poisoned");
    usage.get_or_insert_with(|| UsageStore::load(None)).snapshot(now, LIMITS)
}

/// Places by name (or address) near `near`. Empty without a key, past the
/// cap, or when TomTom doesn't answer: the page then has OpenStreetMap's alone.
pub async fn search(http: &reqwest::Client, query: &str, near: Option<Near>) -> Vec<FoundPlace> {
    let query = query.trim();
    if query.chars().count() < 3 || query.chars().count() > 120 {
        return Vec::new();
    }
    let Some(key) = api_key() else { return Vec::new() };
    if !try_spend(Utc::now()) {
        return Vec::new();
    }
    match discover(http, &key, query, near).await {
        Answer::Places(found) => return found,
        // Over TomTom's free allowance: nothing more today.
        Answer::OverLimit => return Vec::new(),
        Answer::Unexpected => {}
    }
    if !try_spend(Utc::now()) {
        return Vec::new();
    }
    match older_search(http, &key, query, near).await {
        Answer::Places(found) => found,
        _ => Vec::new(),
    }
}

enum Answer {
    Places(Vec<FoundPlace>),
    OverLimit,
    /// Not the answer expected (or none): try the other API.
    Unexpected,
}

async fn discover(http: &reqwest::Client, key: &str, query: &str, near: Option<Near>) -> Answer {
    let response = http
        .post(DISCOVER_URL)
        .timeout(Duration::from_secs(6))
        .header("TomTom-Api-Key", key)
        .header("TomTom-Api-Version", "3")
        .header("Attributes", "results(title,subtitles,position,address)")
        .header("Accept-Language", "en-US,en")
        .json(&discover_request(query, near))
        .send()
        .await;
    let Ok(response) = response else { return Answer::Unexpected };
    if response.status().as_u16() == 429 {
        return Answer::OverLimit;
    }
    if !response.status().is_success() {
        return Answer::Unexpected;
    }
    match response.json::<Value>().await {
        Ok(body) => parse_discover(&body).map_or(Answer::Unexpected, Answer::Places),
        Err(_) => Answer::Unexpected,
    }
}

pub fn discover_request(query: &str, near: Option<Near>) -> Value {
    let mut body = json!({
        "query": query,
        "maxResults": LIMIT,
        "filters": { "types": ["poi", "address", "street"] },
    });
    if let Some(near) = near {
        body["preferences"] = json!({ "geometry": { "type": "point", "coordinates": [near.longitude, near.latitude] } });
    }
    body
}

/// Places Search's answer: `results`, each with a `title`, `subtitles`, a
/// GeoJSON `position` and (if given) an `address`. None when it isn't that.
pub fn parse_discover(body: &Value) -> Option<Vec<FoundPlace>> {
    let results = body.get("results")?.as_array()?;
    Some(
        results
            .iter()
            .filter_map(|result| {
                let title = text(result, &["title"]);
                let subtitles: Vec<String> = result
                    .get("subtitles")
                    .and_then(Value::as_array)
                    .map(|list| list.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let address = result.get("address").cloned().unwrap_or(Value::Null);
                let mut place = from_address(&address);
                // No address in parts: the subtitles have it on a line ("3030 Burke Mill Rd, Winston-Salem, NC 27103").
                if place.street.is_empty()
                    && place.town.is_empty()
                    && let Some(line) = subtitles.iter().find(|s| s.contains(','))
                {
                    place = from_line(line);
                }
                let coordinates = result.pointer("/position/coordinates").and_then(Value::as_array);
                place.longitude = coordinates.and_then(|c| c.first()).and_then(Value::as_f64);
                place.latitude = coordinates.and_then(|c| c.get(1)).and_then(Value::as_f64);
                // A title that's the address itself isn't a name.
                place.name = title.filter(|t| !t.is_empty() && *t != place.street);
                (place.name.is_some() || !place.street.is_empty() || !place.town.is_empty()).then_some(place)
            })
            .take(LIMIT)
            .collect(),
    )
}

async fn older_search(http: &reqwest::Client, key: &str, query: &str, near: Option<Near>) -> Answer {
    let mut url = url::Url::parse(SEARCH_URL).expect("valid URL");
    url.path_segments_mut().expect("base URL").push(&format!("{query}.json"));
    url.query_pairs_mut()
        .append_pair("key", key)
        .append_pair("typeahead", "true")
        .append_pair("limit", &LIMIT.to_string())
        .append_pair("idxSet", "POI,PAD,Addr,Str")
        .append_pair("language", "en-US");
    if let Some(near) = near {
        url.query_pairs_mut().append_pair("lat", &near.latitude.to_string()).append_pair("lon", &near.longitude.to_string());
    }
    let Ok(response) = http.get(url).timeout(Duration::from_secs(6)).send().await else { return Answer::Unexpected };
    // The older API says "over the limit" with 403 (and 429).
    if matches!(response.status().as_u16(), 403 | 429) {
        return Answer::OverLimit;
    }
    if !response.status().is_success() {
        return Answer::Unexpected;
    }
    match response.json::<Value>().await {
        Ok(body) => parse_older(&body).map_or(Answer::Unexpected, Answer::Places),
        Err(_) => Answer::Unexpected,
    }
}

/// The older Search API's answer: `results`, each with `poi.name`, `address` and `position` {lat, lon}.
pub fn parse_older(body: &Value) -> Option<Vec<FoundPlace>> {
    let results = body.get("results")?.as_array()?;
    Some(
        results
            .iter()
            .filter_map(|result| {
                let mut place = from_address(result.get("address")?);
                place.name = text(result, &["poi", "name"]);
                place.latitude = result.pointer("/position/lat").and_then(Value::as_f64);
                place.longitude = result.pointer("/position/lon").and_then(Value::as_f64);
                (place.name.is_some() || !place.street.is_empty() || !place.town.is_empty()).then_some(place)
            })
            .take(LIMIT)
            .collect(),
    )
}

/// The text at `path` (keys), trimmed; None if missing or blank.
fn text(value: &Value, path: &[&str]) -> Option<String> {
    let mut at = value;
    for key in path {
        at = at.get(key)?;
    }
    Some(at.as_str()?.trim().to_string()).filter(|s| !s.is_empty())
}

/// The first of `keys` that `address` has.
fn first(address: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|key| text(address, &[key])).unwrap_or_default()
}

/// An address in parts, under the names TomTom's APIs use for them.
fn from_address(address: &Value) -> FoundPlace {
    let country = first(address, &["countryCodeIso2", "countryCode"]).to_uppercase();
    let us = country == "US" || country == "USA";
    let number = first(address, &["streetNumber", "houseNumber"]);
    let street_name = first(address, &["streetName", "street"]);
    let mut place = FoundPlace {
        street: [number, street_name].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" "),
        town: first(address, &["municipality", "locality", "city", "localName"]),
        state: if us {
            first(address, &["countrySubdivisionCode", "countrySubdivision", "region"])
        } else {
            first(address, &["countrySubdivisionName", "countrySubdivision", "region"])
        },
        zip: first(address, &["postalCode", "extendedPostalCode"]),
        country: if us || country.is_empty() { String::new() } else { first(address, &["country", "countryName"]) },
        ..FoundPlace::default()
    };
    // Only a line: split it as an address is written.
    if place.street.is_empty() && place.town.is_empty() {
        let line = first(address, &["freeformAddress", "formattedAddress", "freeform"]);
        if !line.is_empty() {
            let parsed = from_line(&line);
            place.street = parsed.street;
            place.town = parsed.town;
            if place.state.is_empty() {
                place.state = parsed.state;
            }
            if place.zip.is_empty() {
                place.zip = parsed.zip;
            }
        }
    }
    // "US-NC" → "NC".
    if let Some((_, code)) = place.state.split_once('-') {
        place.state = code.to_string();
    }
    place
}

/// "3030 Burke Mill Rd, Winston-Salem, NC 27103" (and maybe ", United States") in parts.
fn from_line(line: &str) -> FoundPlace {
    let mut parts: Vec<&str> = line.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.len() > 2 && parts.last().is_some_and(|p| ["united states", "usa", "us", "united states of america"].contains(&p.to_lowercase().as_str())) {
        parts.pop();
    }
    let mut place = FoundPlace::default();
    match parts.as_slice() {
        [] => {}
        [street] => place.street = street.to_string(),
        [street, town] => {
            place.street = street.to_string();
            place.town = town.to_string();
        }
        [street @ .., town, last] => {
            place.street = street.join(", ");
            place.town = town.to_string();
            let (state, zip) = last.rsplit_once(' ').filter(|(_, zip)| zip.chars().any(|c| c.is_ascii_digit())).unwrap_or((last, ""));
            place.state = state.trim().to_string();
            place.zip = zip.trim().to_string();
        }
    }
    place
}

// ---------- The key ----------

/// Whether there's a key, and where it is (as for the Routes key).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub configured: bool,
    pub source: &'static str,
}

pub fn key_status() -> KeyStatus {
    let source = if env_key().is_some() {
        "environment"
    } else if keychain_key().is_some() {
        "settings"
    } else if dotenv_key().is_some() {
        "dotenv"
    } else {
        "none"
    };
    KeyStatus { configured: source != "none", source }
}

fn api_key() -> Option<String> {
    env_key().or_else(keychain_key).or_else(dotenv_key)
}

fn env_key() -> Option<String> {
    std::env::var(ENV_KEY).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn keychain_key() -> Option<String> {
    secrets::get(secrets::TOMTOM_API_KEY).ok().flatten().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Development builds only, from `src-tauri/.env` (never compiled in).
fn dotenv_key() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    ["src-tauri/.env", ".env", "../.env"]
        .iter()
        .find_map(|path| crate::leave::parse_env_value(&std::fs::read_to_string(path).ok()?, ENV_KEY))
}

/// Saves the key in the keychain; empty removes it.
pub fn set_api_key(key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return secrets::delete(secrets::TOMTOM_API_KEY);
    }
    if key.len() > 256 || key.chars().any(char::is_whitespace) {
        return Err(AppError::InvalidInput("That doesn't look like an API key.".into()));
    }
    secrets::set(secrets::TOMTOM_API_KEY, key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_places_search() {
        let body = json!({ "results": [
            {
                "title": "Grace Free Presbyterian Church",
                "subtitles": ["3030 Burke Mill Rd, Winston-Salem, NC 27103", "United States"],
                "position": { "type": "Point", "coordinates": [-80.31, 36.05] },
                "address": { "countryCodeIso2": "US" }
            },
            {
                "title": "3030 Burke Mill Rd",
                "address": { "streetNumber": "3030", "streetName": "Burke Mill Rd", "municipality": "Winston-Salem",
                             "countrySubdivisionCode": "US-NC", "postalCode": "27103", "countryCodeIso2": "US" }
            }
        ]});
        let found = parse_discover(&body).unwrap();
        assert_eq!(found[0].name.as_deref(), Some("Grace Free Presbyterian Church"));
        assert_eq!((found[0].street.as_str(), found[0].town.as_str(), found[0].state.as_str(), found[0].zip.as_str()), ("3030 Burke Mill Rd", "Winston-Salem", "NC", "27103"));
        assert_eq!(found[0].latitude, Some(36.05));
        // An address found as itself has no name.
        assert_eq!(found[1].name, None);
        assert_eq!(found[1].state, "NC");
        assert!(parse_discover(&json!({ "error": "x" })).is_none());
    }

    #[test]
    fn reads_the_older_search() {
        let body = json!({ "results": [{
            "poi": { "name": "Grace Free Presbyterian Church" },
            "address": { "streetNumber": "3030", "streetName": "Burke Mill Road", "municipality": "Winston-Salem",
                         "countrySubdivision": "NC", "postalCode": "27103", "countryCode": "US",
                         "freeformAddress": "3030 Burke Mill Road, Winston-Salem, NC 27103" },
            "position": { "lat": 36.05, "lon": -80.31 }
        }]});
        let found = parse_older(&body).unwrap();
        assert_eq!(found[0].name.as_deref(), Some("Grace Free Presbyterian Church"));
        assert_eq!(found[0].street, "3030 Burke Mill Road");
        assert_eq!(found[0].country, "");
        assert_eq!(found[0].longitude, Some(-80.31));
    }

    #[test]
    fn biases_toward_where_you_are() {
        let body = discover_request("grace free", Some(Near { latitude: 34.85, longitude: -82.4 }));
        assert_eq!(body["preferences"]["geometry"]["coordinates"], json!([-82.4, 34.85]));
        assert_eq!(body["maxResults"], json!(5));
    }

    #[test]
    fn stops_at_the_cap() {
        init_usage(None);
        let now = Utc::now();
        let spent = (0..DAILY + 5).filter(|_| try_spend(now)).count();
        assert_eq!(spent as u32, DAILY);
    }
}
