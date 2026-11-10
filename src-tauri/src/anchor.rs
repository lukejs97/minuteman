//! Resolving a vague address before Google's Routes geocoder sees it.
//!
//! "10 Mill Park Ct" is a house in Greenville and also a street in other
//! states. Routes would pick one on its own, with no hint of which, and the
//! drive would be hours off. Nominatim (OpenStreetMap) is free and takes no
//! key. Its public server asks for one request a second, a real User-Agent,
//! and that answers be kept, so a hit is reused for a week. This is not a
//! Routes call and does not count against the Routes cap.
//!
//! The choice of which hit to trust is the same as `chooseHit` / `anchorEnds`
//! in src/routes-budget.ts.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use serde_json::Value;

use crate::leave::{km_between, parse_spot};

/// How close a vague address must be to a known point before that match is
/// trusted. Kept in step with `ANCHOR_KM` in src/routes-budget.ts.
pub const ANCHOR_KM: f64 = 80.0;

const NOMINATIM: &str = "https://nominatim.openstreetmap.org/search";
const USER_AGENT: &str = "Minuteman leave-by (https://github.com/lukejs97/minuteman)";
const PACE: Duration = Duration::from_millis(1100);

/// One place Nominatim returned. `label` is a short address a person can check.
#[derive(Clone, Debug, PartialEq)]
pub struct GeoHit {
    pub latitude: f64,
    pub longitude: f64,
    pub label: String,
}

/// What Routes is asked for, and the place a vague address was matched to.
#[derive(Clone, Debug, PartialEq)]
pub struct AnchoredEnd {
    pub waypoint: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AnchorResult {
    Ready {
        origin: AnchoredEnd,
        destination: AnchoredEnd,
    },
    /// A street (or place) with no town, and nothing nearby to decide which one.
    Vague,
    /// The geocoder didn't answer. Not a reason to ask Google with the vague text.
    Unavailable,
}

/// "geo:34.86739,-82.42850". Not the device: those stay "@lat,lng".
pub fn geo_pin(latitude: f64, longitude: f64) -> String {
    format!("geo:{latitude:.5},{longitude:.5}")
}

/// The coordinates in a `geo_pin`; `None` for an address or a device spot.
pub fn parse_geo_pin(value: &str) -> Option<(f64, f64)> {
    let rest = value.trim().strip_prefix("geo:")?;
    let (lat, lng) = rest.split_once(',')?;
    let (lat, lng): (f64, f64) = (lat.trim().parse().ok()?, lng.trim().parse().ok()?);
    ((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lng)).then_some((lat, lng))
}

/// Whether an address names its town or ZIP. Kept in step with `looksComplete`.
pub fn looks_complete(address: &str) -> bool {
    let text = address.trim();
    if text.is_empty() || text.contains(',') {
        return true;
    }
    // A 5-digit ZIP, possibly with the 4-digit add-on, as its own word.
    text.split(|c: char| !c.is_ascii_digit() && c != '-')
        .any(|word| {
            (word.len() == 5 && word.chars().all(|c| c.is_ascii_digit()))
                || (word.len() == 10
                    && word.as_bytes().get(5) == Some(&b'-')
                    && word.chars().filter(|c| c.is_ascii_digit()).count() == 9)
        })
}

/// Which hit is safe to route from. With a known point, the closest within
/// [`ANCHOR_KM`]. With none, only a single hit.
pub fn choose_hit(hits: &[GeoHit], bias: Option<(f64, f64)>) -> Option<GeoHit> {
    let usable: Vec<&GeoHit> = hits
        .iter()
        .filter(|hit| {
            (-90.0..=90.0).contains(&hit.latitude) && (-180.0..=180.0).contains(&hit.longitude)
        })
        .collect();
    if let Some(bias) = bias {
        return usable
            .into_iter()
            .filter(|hit| km_between((hit.latitude, hit.longitude), bias) <= ANCHOR_KM)
            .min_by(|a, b| {
                let da = km_between((a.latitude, a.longitude), bias);
                let db = km_between((b.latitude, b.longitude), bias);
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
            .cloned();
    }
    (usable.len() == 1).then(|| usable[0].clone())
}

/// Nominatim's viewbox, "left,top,right,bottom", about `km` around `bias`.
pub fn nominatim_viewbox(bias: (f64, f64), km: f64) -> String {
    let d_lat = km / 111.32;
    let d_lon = km / (111.32 * bias.0.to_radians().cos().abs().max(0.2));
    format!(
        "{},{},{},{}",
        bias.1 - d_lon,
        bias.0 + d_lat,
        bias.1 + d_lon,
        bias.0 - d_lat
    )
}

fn point(hit: &GeoHit) -> (f64, f64) {
    (hit.latitude, hit.longitude)
}

fn coords_of(text: &str) -> Option<(f64, f64)> {
    parse_spot(text).or_else(|| parse_geo_pin(text))
}

/// Turn vague ends into points before Google geocodes them. A full address is
/// left as written. `lookup` returns the hits, or `Err` when it didn't answer.
pub async fn anchor_ends<F, Fut>(
    origin: &str,
    destination: &str,
    device: Option<(f64, f64)>,
    mut lookup: F,
) -> AnchorResult
where
    F: FnMut(String, Option<(f64, f64)>) -> Fut,
    Fut: Future<Output = Result<Vec<GeoHit>, ()>>,
{
    let origin_coord = coords_of(origin);
    let dest_coord = coords_of(destination);
    let origin_vague = origin_coord.is_none() && !looks_complete(origin);
    let dest_vague = dest_coord.is_none() && !looks_complete(destination);
    if !origin_vague && !dest_vague {
        return AnchorResult::Ready {
            origin: AnchoredEnd {
                waypoint: origin.to_string(),
                label: None,
            },
            destination: AnchoredEnd {
                waypoint: destination.to_string(),
                label: None,
            },
        };
    }

    let mut failed = false;

    async fn take<F, Fut>(
        lookup: &mut F,
        query: &str,
        bias: Option<(f64, f64)>,
        failed: &mut bool,
    ) -> Option<GeoHit>
    where
        F: FnMut(String, Option<(f64, f64)>) -> Fut,
        Fut: Future<Output = Result<Vec<GeoHit>, ()>>,
    {
        match lookup(query.to_string(), bias).await {
            Ok(hits) => choose_hit(&hits, bias),
            Err(()) => {
                *failed = true;
                None
            }
        }
    }

    let mut origin_hit = origin_coord.map(|(latitude, longitude)| GeoHit {
        latitude,
        longitude,
        label: String::new(),
    });
    let mut dest_hit = dest_coord.map(|(latitude, longitude)| GeoHit {
        latitude,
        longitude,
        label: String::new(),
    });

    if dest_vague {
        dest_hit = take(&mut lookup, destination, device, &mut failed).await;
        if !failed && dest_hit.is_none() && device.is_some() {
            dest_hit = take(&mut lookup, destination, None, &mut failed).await;
        }
    }
    if failed {
        return AnchorResult::Unavailable;
    }

    if origin_vague {
        let mut bias = device.or_else(|| dest_hit.as_ref().map(point));
        if bias.is_none() && !dest_vague {
            dest_hit = take(&mut lookup, destination, None, &mut failed).await;
            bias = dest_hit.as_ref().map(point);
        }
        if failed {
            return AnchorResult::Unavailable;
        }
        origin_hit = take(&mut lookup, origin, bias, &mut failed).await;
        if !failed && origin_hit.is_none() && bias.is_some() {
            origin_hit = take(&mut lookup, origin, None, &mut failed).await;
        }
    }
    if failed {
        return AnchorResult::Unavailable;
    }

    if dest_vague && dest_hit.is_none() {
        let mut bias = device.or_else(|| origin_hit.as_ref().filter(|_| origin_vague).map(point));
        if bias.is_none() && !origin_vague {
            origin_hit = take(&mut lookup, origin, None, &mut failed).await;
            bias = origin_hit.as_ref().map(point);
        }
        if failed {
            return AnchorResult::Unavailable;
        }
        if let Some(bias) = bias {
            dest_hit = take(&mut lookup, destination, Some(bias), &mut failed).await;
            if !failed && dest_hit.is_none() {
                dest_hit = take(&mut lookup, destination, None, &mut failed).await;
            }
        }
    }
    if failed {
        return AnchorResult::Unavailable;
    }

    if origin_vague
        && origin_hit.is_none()
        && let Some(dest) = dest_hit.as_ref()
    {
        origin_hit = take(&mut lookup, origin, Some(point(dest)), &mut failed).await;
        if failed {
            return AnchorResult::Unavailable;
        }
    }

    if (origin_vague && origin_hit.is_none()) || (dest_vague && dest_hit.is_none()) {
        return AnchorResult::Vague;
    }

    let end = |text: &str, vague: bool, hit: Option<GeoHit>| -> AnchoredEnd {
        match (vague, hit) {
            (true, Some(hit)) => AnchoredEnd {
                waypoint: geo_pin(hit.latitude, hit.longitude),
                label: (!hit.label.is_empty()).then_some(hit.label),
            },
            (_, hit) => AnchoredEnd {
                waypoint: text.to_string(),
                label: hit.and_then(|hit| (!hit.label.is_empty()).then_some(hit.label)),
            },
        }
    };
    AnchorResult::Ready {
        origin: end(origin, origin_vague, origin_hit),
        destination: end(destination, dest_vague, dest_hit),
    }
}

fn text_at<'a>(address: Option<&'a Value>, key: &str) -> &'a str {
    address
        .and_then(|row| row.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// "Faith Free Presbyterian Church, 1207 Haywood Road, Wade Hampton, SC 29615".
pub fn nominatim_label(place: &Value) -> String {
    let address = place.get("address");
    let iso = text_at(address, "ISO3166-2-lvl4");
    let region = iso
        .rsplit('-')
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or("");
    let region = if region.is_empty() || region == iso {
        text_at(address, "state")
    } else {
        region
    };
    let town = ["city", "town", "village", "hamlet"]
        .into_iter()
        .map(|key| text_at(address, key))
        .find(|part| !part.is_empty())
        .unwrap_or("");
    let street = [text_at(address, "house_number"), text_at(address, "road")]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let name = place
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty() && *name != street)
        .unwrap_or("");
    let region_zip = [region, text_at(address, "postcode")]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let line = [name, street.as_str(), town, region_zip.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    let text = if line.is_empty() {
        place
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    } else {
        line
    };
    if text.chars().count() > 160 {
        let cut = text.chars().take(157).collect::<String>();
        format!("{cut}…")
    } else {
        text
    }
}

pub fn nominatim_hits(body: &Value) -> Vec<GeoHit> {
    let Some(rows) = body.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let latitude: f64 = row.get("lat")?.as_str()?.parse().ok()?;
            let longitude: f64 = row.get("lon")?.as_str()?.parse().ok()?;
            let label = nominatim_label(row);
            (!label.is_empty()).then_some(GeoHit {
                latitude,
                longitude,
                label,
            })
        })
        .collect()
}

fn geo_key(query: &str, bias: Option<(f64, f64)>) -> String {
    let norm = query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let cell = bias
        .map(|(lat, lng)| format!("{lat:.1},{lng:.1}"))
        .unwrap_or_else(|| "-".into());
    format!("{norm}|{cell}")
}

struct GeoEntry {
    at: DateTime<Utc>,
    hits: Vec<GeoHit>,
    failed: bool,
}

static GEO: Mutex<Option<HashMap<String, GeoEntry>>> = Mutex::new(None);
static NEXT: Mutex<Option<std::time::Instant>> = Mutex::new(None);

async fn pace() {
    let wait = {
        let mut next = NEXT.lock().expect("not poisoned");
        let now = std::time::Instant::now();
        let start = next.unwrap_or(now).max(now);
        *next = Some(start + PACE);
        start.saturating_duration_since(now)
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

async fn search(
    http: &reqwest::Client,
    query: &str,
    bias: Option<(f64, f64)>,
) -> Result<Vec<GeoHit>, ()> {
    pace().await;
    let mut url = reqwest::Url::parse(NOMINATIM).expect("nominatim url");
    {
        let mut pairs = url.query_pairs_mut();
        pairs
            .append_pair("format", "jsonv2")
            .append_pair("addressdetails", "1")
            .append_pair("limit", "5")
            .append_pair("q", query);
        if let Some(bias) = bias {
            pairs.append_pair("viewbox", &nominatim_viewbox(bias, ANCHOR_KM));
        }
    }
    let Ok(response) = http
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(8))
        .send()
        .await
    else {
        return Err(());
    };
    if !response.status().is_success() {
        return Err(());
    }
    let Ok(body) = response.json::<Value>().await else {
        return Err(());
    };
    if !body.is_array() {
        return Err(());
    }
    Ok(nominatim_hits(&body))
}

/// Hits for `query`, from the last week when we already asked. `Err` when
/// Nominatim didn't answer (kept for ten minutes, so a blip isn't retried at once).
pub async fn lookup(
    http: &reqwest::Client,
    query: &str,
    bias: Option<(f64, f64)>,
) -> Result<Vec<GeoHit>, ()> {
    let key = geo_key(query, bias);
    let now = Utc::now();
    if let Some(entry) = GEO
        .lock()
        .expect("not poisoned")
        .as_ref()
        .and_then(|map| map.get(&key))
    {
        let age = now.signed_duration_since(entry.at);
        let limit = if entry.failed {
            TimeDelta::minutes(10)
        } else {
            TimeDelta::days(7)
        };
        if age >= TimeDelta::zero() && age < limit {
            return if entry.failed {
                Err(())
            } else {
                Ok(entry.hits.clone())
            };
        }
    }
    let outcome = search(http, query, bias).await;
    let mut cache = GEO.lock().expect("not poisoned");
    let map = cache.get_or_insert_with(HashMap::new);
    map.retain(|_, entry| now.signed_duration_since(entry.at) < TimeDelta::days(7));
    match outcome {
        Ok(hits) => {
            map.insert(
                key,
                GeoEntry {
                    at: now,
                    hits: hits.clone(),
                    failed: false,
                },
            );
            Ok(hits)
        }
        Err(()) => {
            map.insert(
                key,
                GeoEntry {
                    at: now,
                    hits: Vec::new(),
                    failed: true,
                },
            );
            Err(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hit(latitude: f64, longitude: f64, label: &str) -> GeoHit {
        GeoHit {
            latitude,
            longitude,
            label: label.into(),
        }
    }

    /// Faith Free Presbyterian Church, and the two "10 Mill Park Ct" streets
    /// a geocoder actually returns: Greenville (about 12 km away) and Loudoun
    /// County, Virginia (about 800 km, roughly 9½ hours by road).
    fn church() -> GeoHit {
        hit(
            34.86730,
            -82.33066,
            "Faith Free Presbyterian Church, 1207 Haywood Road, Wade Hampton, SC 29615",
        )
    }
    fn greenville() -> GeoHit {
        hit(
            34.86739,
            -82.42850,
            "10 Mill Park Court, Greenville, SC 29611",
        )
    }
    fn loudoun() -> GeoHit {
        hit(
            39.10833,
            -77.51330,
            "10 Mill Park Court, Loudoun County, VA",
        )
    }

    #[test]
    fn a_street_with_no_town_is_not_complete() {
        assert!(!looks_complete("10 Mill Park Ct"));
        assert!(!looks_complete("Faith Free Presbyterian Church"));
        assert!(looks_complete("10 Mill Park Ct, Greenville, SC 29611"));
        assert!(looks_complete("1207 Haywood Rd, Greenville, SC"));
        assert!(looks_complete(""));
        assert!(looks_complete("29611"));
    }

    #[test]
    fn the_same_street_far_away_is_not_a_guess() {
        let both = vec![loudoun(), greenville()];
        assert_eq!(choose_hit(&both, None), None);
        assert_eq!(
            choose_hit(&both, Some((church().latitude, church().longitude))),
            Some(greenville())
        );
        assert_eq!(choose_hit(&[church()], None), Some(church()));
        assert_eq!(
            choose_hit(&[loudoun()], Some((church().latitude, church().longitude))),
            None
        );
        assert!(
            km_between(
                (greenville().latitude, greenville().longitude),
                (church().latitude, church().longitude)
            ) < ANCHOR_KM
        );
        assert!(
            km_between(
                (loudoun().latitude, loudoun().longitude),
                (church().latitude, church().longitude)
            ) > ANCHOR_KM
        );
    }

    #[test]
    fn a_geo_pin_is_not_the_device_spot() {
        let pin = geo_pin(34.86739, -82.42850);
        assert_eq!(pin, "geo:34.86739,-82.42850");
        assert_eq!(parse_geo_pin(&pin), Some((34.86739, -82.42850)));
        assert_eq!(parse_geo_pin("@34.867,-82.429"), None);
        assert_eq!(parse_spot(&pin), None);
    }

    #[test]
    fn a_nominatim_church_becomes_a_short_label() {
        let body = json!([{
            "lat": "34.8672960",
            "lon": "-82.3306632",
            "name": "Faith Free Presbyterian Church",
            "display_name": "Faith Free Presbyterian Church, 1207, Haywood Road, Rogers Valley Heights, Wade Hampton, Greenville County, South Carolina, 29615, United States",
            "address": {
                "house_number": "1207",
                "road": "Haywood Road",
                "town": "Wade Hampton",
                "state": "South Carolina",
                "ISO3166-2-lvl4": "US-SC",
                "postcode": "29615"
            }
        }]);
        let hits = nominatim_hits(&body);
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0].label,
            "Faith Free Presbyterian Church, 1207 Haywood Road, Wade Hampton, SC 29615"
        );
        assert!((hits[0].latitude - 34.867296).abs() < 1e-6);
    }

    /// A geocoder whose answers are fixed, and a list of what it was asked.
    fn script(
        rows: Vec<(String, bool, Result<Vec<GeoHit>, ()>)>,
    ) -> (
        impl FnMut(String, Option<(f64, f64)>) -> std::future::Ready<Result<Vec<GeoHit>, ()>>,
        std::sync::Arc<Mutex<Vec<(String, bool)>>>,
    ) {
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let lookup = move |query: String, bias: Option<(f64, f64)>| {
            let biased = bias.is_some();
            seen.lock()
                .expect("not poisoned")
                .push((query.clone(), biased));
            let found = rows
                .iter()
                .find(|(name, is_biased, _)| name == &query && *is_biased == biased)
                .map(|(_, _, hits)| hits.clone());
            std::future::ready(found.unwrap_or_else(|| Ok(Vec::new())))
        };
        (lookup, calls)
    }

    fn ready(result: AnchorResult) -> (AnchoredEnd, AnchoredEnd) {
        match result {
            AnchorResult::Ready {
                origin,
                destination,
            } => (origin, destination),
            other => panic!("expected a route, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_greenville_street_is_chosen_from_the_church() {
        let (lookup, _) = script(vec![
            (
                "Faith Free Presbyterian Church".into(),
                false,
                Ok(vec![church()]),
            ),
            (
                "10 Mill Park Ct".into(),
                true,
                Ok(vec![loudoun(), greenville()]),
            ),
        ]);
        let result = anchor_ends(
            "10 Mill Park Ct",
            "Faith Free Presbyterian Church",
            None,
            lookup,
        )
        .await;
        let (origin, destination) = ready(result);
        assert_eq!(
            origin.waypoint,
            geo_pin(greenville().latitude, greenville().longitude)
        );
        assert_eq!(
            origin.label.as_deref(),
            Some("10 Mill Park Court, Greenville, SC 29611")
        );
        assert_eq!(
            destination.waypoint,
            geo_pin(church().latitude, church().longitude)
        );
        assert!(
            destination
                .label
                .unwrap()
                .contains("Faith Free Presbyterian Church")
        );
    }

    #[tokio::test]
    async fn two_vague_streets_and_no_hint_are_not_sent_to_google() {
        let (lookup, _) = script(vec![
            ("Somewhere".into(), false, Ok(vec![loudoun(), greenville()])),
            (
                "10 Mill Park Ct".into(),
                false,
                Ok(vec![loudoun(), greenville()]),
            ),
        ]);
        let result = anchor_ends("10 Mill Park Ct", "Somewhere", None, lookup).await;
        assert_eq!(result, AnchorResult::Vague);
    }

    #[tokio::test]
    async fn a_full_address_is_left_alone() {
        let (lookup, calls) = script(vec![]);
        let result = anchor_ends(
            "10 Mill Park Ct, Greenville, SC 29611",
            "1207 Haywood Rd, Greenville, SC 29615",
            None,
            lookup,
        )
        .await;
        let (origin, destination) = ready(result);
        assert_eq!(origin.waypoint, "10 Mill Park Ct, Greenville, SC 29611");
        assert_eq!(
            destination.waypoint,
            "1207 Haywood Rd, Greenville, SC 29615"
        );
        assert!(calls.lock().expect("not poisoned").is_empty());
    }

    #[tokio::test]
    async fn a_geocoder_that_doesnt_answer_is_not_treated_as_no_such_place() {
        let (lookup, _) = script(vec![("Church".into(), false, Err(()))]);
        let result = anchor_ends("10 Mill Park Ct", "Church", None, lookup).await;
        assert_eq!(result, AnchorResult::Unavailable);
    }

    #[tokio::test]
    async fn where_you_are_breaks_the_tie_before_the_other_end() {
        let (lookup, calls) = script(vec![(
            "10 Mill Park Ct".into(),
            true,
            Ok(vec![loudoun(), greenville()]),
        )]);
        let device = (greenville().latitude, greenville().longitude);
        let result = anchor_ends(
            "10 Mill Park Ct",
            "1207 Haywood Rd, Greenville, SC 29615",
            Some(device),
            lookup,
        )
        .await;
        let (origin, destination) = ready(result);
        assert_eq!(
            origin.waypoint,
            geo_pin(greenville().latitude, greenville().longitude)
        );
        assert_eq!(
            destination.waypoint,
            "1207 Haywood Rd, Greenville, SC 29615"
        );
        let calls = calls.lock().expect("not poisoned");
        assert_eq!(calls.len(), 1);
        assert!(calls[0].1, "the device was the hint");
    }
}
