//! Google Calendar API v3: the user's calendar list, the events on each
//! calendar within a time range, and adding events.

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use futures::future::join_all;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

use crate::agenda::{AgendaItem, Attendee as Guest, ItemKind, Source};
use crate::error::{AppError, Result};

const API: &str = "https://www.googleapis.com/calendar/v3";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    #[serde(default = "Vec::new")]
    items: Vec<T>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarListEntry {
    id: String,
    summary: Option<String>,
    /// The name the user gave a calendar someone else shares with them.
    summary_override: Option<String>,
    background_color: Option<String>,
    /// "owner", "writer", "reader" or "freeBusyReader".
    access_role: Option<String>,
    #[serde(default)]
    primary: bool,
    /// The calendar's reminders for events that don't set their own.
    #[serde(default)]
    default_reminders: Vec<Reminder>,
    /// The calendar's time zone, for events that don't name their own.
    time_zone: Option<String>,
}

impl CalendarListEntry {
    fn name(&self) -> String {
        self.summary_override.clone().or_else(|| self.summary.clone()).unwrap_or_else(|| self.id.clone())
    }

    fn can_write(&self) -> bool {
        matches!(self.access_role.as_deref(), Some("owner" | "writer"))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    id: String,
    status: Option<String>,
    summary: Option<String>,
    location: Option<String>,
    html_link: Option<String>,
    start: Option<EventTime>,
    end: Option<EventTime>,
    #[serde(default)]
    attendees: Vec<Attendee>,
    event_type: Option<String>,
    description: Option<String>,
    /// Google Meet link, on older events.
    hangout_link: Option<String>,
    conference_data: Option<ConferenceData>,
    reminders: Option<Reminders>,
    organizer: Option<Organizer>,
    #[serde(default)]
    guests_can_modify: bool,
    /// Set on each occurrence of a repeating event.
    recurring_event_id: Option<String>,
    extended_properties: Option<ExtendedProperties>,
    /// The event's own color, when it isn't its calendar's ("1" to "11").
    color_id: Option<String>,
}

#[derive(Deserialize)]
struct ExtendedProperties {
    #[serde(default)]
    private: std::collections::HashMap<String, String>,
}

/// Marks an event (privately, on your copy) as keeping its clock time in any
/// time zone: Minuteman shows 9 AM as 9 AM wherever you are. Google itself
/// has no such "floating" events, so its own apps still show it fixed.
pub const FLOATING: &str = "minutemanFloating";

/// This event's own starting address for leave-by, when it shouldn't use the
/// one in Settings. Empty removes it.
pub const LEAVE_FROM: &str = "minutemanLeaveFrom";

/// Exact-time alerts, leave alerts, and any reminder Google's API can't store,
/// kept on the event as a private property (a JSON string). Google Calendar
/// reminders are only "minutes before the start", at most 5 of them, and at
/// most 4 weeks out, so an alert at a chosen date and time — or one that
/// depends on traffic — has nowhere to go there.
///
/// These are not Google reminder overrides: Google's own apps neither show
/// nor send them. Minuteman reads them back with the event and fires them
/// itself. They live on the event (rather than in a file on one device) so
/// the website and the desktop app see the same list, and the desktop — where
/// notifications actually run — can fire an alert that was added in either.
pub const LOCAL_ALERTS: &str = "minutemanAlerts";

/// Google Calendar's event colors, by `colorId`, as its apps show them (the
/// API's own color list has older, paler ones). Kept in step with
/// src/event-colors.ts.
const EVENT_COLORS: [(&str, &str); 11] = [
    ("1", "#7986cb"),  // Lavender
    ("2", "#33b679"),  // Sage
    ("3", "#8e24aa"),  // Grape
    ("4", "#e67c73"),  // Flamingo
    ("5", "#f6bf26"),  // Banana
    ("6", "#f4511e"),  // Tangerine
    ("7", "#039be5"),  // Peacock
    ("8", "#616161"),  // Graphite
    ("9", "#3f51b5"),  // Blueberry
    ("10", "#0b8043"), // Basil
    ("11", "#d50000"), // Tomato
];

/// The color an event's `colorId` stands for; `None` for none or an unknown one.
pub fn event_color(color_id: &str) -> Option<&'static str> {
    EVENT_COLORS.iter().find(|(id, _)| *id == color_id).map(|(_, color)| *color)
}

/// Google Calendar allows at most this many reminder overrides on an event.
const GOOGLE_MAX_OVERRIDES: usize = 5;
/// Google Calendar's longest reminder, in minutes (4 weeks).
const GOOGLE_MAX_MINUTES: u32 = 40_320;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConferenceData {
    #[serde(default)]
    entry_points: Vec<EntryPoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryPoint {
    /// "video", "phone", "sip" or "more".
    entry_point_type: Option<String>,
    uri: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reminders {
    #[serde(default)]
    use_default: bool,
    #[serde(default)]
    overrides: Vec<Reminder>,
}

#[derive(Deserialize)]
struct Reminder {
    /// "popup" or "email".
    method: Option<String>,
    minutes: Option<u32>,
}

#[derive(Deserialize)]
struct Organizer {
    #[serde(rename = "self", default)]
    is_self: bool,
}

/// Exactly one of these is set: `date` ("2026-10-27") for all-day events,
/// `date_time` (RFC 3339, "2026-10-27T09:00:00-07:00") for timed ones.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventTime {
    date: Option<String>,
    date_time: Option<String>,
    time_zone: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attendee {
    #[serde(rename = "self", default)]
    is_self: bool,
    response_status: Option<String>,
    email: Option<String>,
    display_name: Option<String>,
    #[serde(default)]
    organizer: bool,
    /// Rooms and other resources, not people.
    #[serde(default)]
    resource: bool,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    error: ApiErrorDetail,
}

#[derive(Deserialize)]
struct ApiErrorDetail {
    message: String,
}

pub struct CalendarEvents {
    pub items: Vec<AgendaItem>,
    /// Calendars that failed to load; the rest are still shown.
    pub warnings: Vec<String>,
}

/// Events from every calendar in `account`'s list between `from` and `to`.
/// `can_edit`: whether the account allowed the app to change events.
pub async fn events_between(
    http: &reqwest::Client,
    token: &str,
    account: &str,
    can_edit: bool,
    from: DateTime<Local>,
    to: DateTime<Local>,
) -> Result<CalendarEvents> {
    find_events(http, token, account, can_edit, from, to, None).await
}

/// Events matching `query` (Google searches titles, notes, places and
/// guests) between `from` and `to`, on all of `account`'s calendars.
pub async fn search(
    http: &reqwest::Client,
    token: &str,
    account: &str,
    can_edit: bool,
    query: &str,
    from: DateTime<Local>,
    to: DateTime<Local>,
) -> Result<CalendarEvents> {
    find_events(http, token, account, can_edit, from, to, Some(query)).await
}

async fn find_events(
    http: &reqwest::Client,
    token: &str,
    account: &str,
    can_edit: bool,
    from: DateTime<Local>,
    to: DateTime<Local>,
    query: Option<&str>,
) -> Result<CalendarEvents> {
    // Leaving out the ones hidden in Settings.
    let mut calendars = list_calendars(http, token).await?;
    calendars.retain(|cal| crate::prefs::google_calendar_shown(account, &cal.id));

    // Fetch all calendars at the same time rather than one after another.
    let results =
        join_all(calendars.iter().map(|cal| list_events(http, token, &cal.id, from, to, query))).await;

    let mut items = Vec::new();
    let mut warnings = Vec::new();
    for (calendar, result) in calendars.iter().zip(results) {
        match result {
            Ok(events) => {
                items.extend(events.into_iter().filter_map(|e| to_agenda_item(account, can_edit, calendar, e)))
            }
            Err(e) => warnings.push(format!("{}: {e}", calendar.name())),
        }
    }
    Ok(CalendarEvents { items, warnings })
}

/// A repeating event's rules (RRULE, EXDATE and so on), as Google keeps them
/// on its series. Empty if it doesn't repeat.
pub async fn recurrence(http: &reqwest::Client, token: &str, calendar_id: &str, event_id: &str) -> Result<Vec<String>> {
    #[derive(Deserialize)]
    struct Series {
        #[serde(default)]
        recurrence: Vec<String>,
    }
    let mut url = Url::parse(API).expect("valid URL");
    url.path_segments_mut().expect("base URL").extend(["calendars", calendar_id, "events", event_id]);
    url.query_pairs_mut().append_pair("fields", "recurrence");
    let series: Series = get_json(http, token, url).await?;
    Ok(series.recurrence)
}

/// "This and following events": ends the series `series_id` just before its
/// occurrence at `before` (an RFC 3339 time, or a date for an all-day series),
/// and returns its rules for a new series from there on (RRULE lines; a
/// COUNT becomes what's left of it). `None` when `before` is its first
/// occurrence: nothing comes before it, so change the whole series.
pub async fn end_series_before(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    series_id: &str,
    before: &str,
    all_day: bool,
) -> Result<Option<Vec<String>>> {
    #[derive(Deserialize)]
    struct Series {
        start: Option<EventTime>,
        #[serde(default)]
        recurrence: Vec<String>,
    }
    let mut url = Url::parse(API).expect("valid URL");
    url.path_segments_mut().expect("base URL").extend(["calendars", calendar_id, "events", series_id]);
    url.query_pairs_mut().append_pair("fields", "start,recurrence");
    let series: Series = get_json(http, token, url.clone()).await?;
    let Some(until) = until_before(before, all_day) else {
        return Err(AppError::InvalidInput("not a time or date".into()));
    };
    let first = series.start.as_ref().and_then(|s| s.date_time.clone().or_else(|| s.date.clone())).unwrap_or_default();
    if series.recurrence.is_empty() || !starts_before(&first, before) {
        return Ok(None);
    }
    // "10 times": the new series has as many as are left after the ones before.
    let counted = series.recurrence.iter().any(|rule| count_of(rule).is_some());
    let before_count = if counted {
        instances_before(http, token, calendar_id, series_id, before, all_day).await?
    } else {
        0
    };
    let ended = with_until(&series.recurrence, &until);
    let _patched: Value = send(http.patch(url).bearer_auth(token).json(&json!({ "recurrence": ended }))).await?;
    Ok(Some(following_rules(&series.recurrence, before_count)))
}

/// A series' rules for the part from an occurrence on: RRULE lines only (the
/// others belong to the old series' dates), with any COUNT less the
/// `before_count` occurrences that came before it.
fn following_rules(rules: &[String], before_count: u32) -> Vec<String> {
    rules
        .iter()
        .filter(|rule| rule.to_ascii_uppercase().starts_with("RRULE:"))
        .map(|rule| match count_of(rule) {
            Some(count) => format!("{};COUNT={}", without_parts(rule, &["COUNT"]), count.saturating_sub(before_count).max(1)),
            None => rule.clone(),
        })
        .collect()
}

/// An RRULE's COUNT, if it has one.
fn count_of(rule: &str) -> Option<u32> {
    rule.get("RRULE:".len()..)?.split(';').find_map(|part| {
        let (name, value) = part.split_once('=')?;
        name.eq_ignore_ascii_case("COUNT").then(|| value.parse().ok()).flatten()
    })
}

/// How many of a series' occurrences start before `before`. Cancelled ones
/// count too, as they do toward its COUNT.
async fn instances_before(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    series_id: &str,
    before: &str,
    all_day: bool,
) -> Result<u32> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Instances {
        #[serde(default)]
        items: Vec<Value>,
        next_page_token: Option<String>,
    }
    // An all-day series: before that day starts here.
    let time_max = if all_day {
        let day = NaiveDate::parse_from_str(before.get(..10).unwrap_or(before), "%Y-%m-%d")
            .map_err(|_| AppError::InvalidInput("not a date".into()))?;
        Local
            .from_local_datetime(&day.and_time(NaiveTime::MIN))
            .earliest()
            .ok_or_else(|| AppError::InvalidInput("not a date".into()))?
            .to_rfc3339()
    } else {
        before.to_string()
    };
    let mut count = 0;
    let mut page: Option<String> = None;
    loop {
        let mut url = Url::parse(API).expect("valid URL");
        url.path_segments_mut().expect("base URL").extend(["calendars", calendar_id, "events", series_id, "instances"]);
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("timeMax", &time_max).append_pair("showDeleted", "true");
            query.append_pair("maxResults", "2500").append_pair("fields", "items(id),nextPageToken");
            if let Some(token) = &page {
                query.append_pair("pageToken", token);
            }
        }
        let found: Instances = get_json(http, token, url).await?;
        count += found.items.len() as u32;
        match found.next_page_token {
            Some(next) => page = Some(next),
            None => return Ok(count),
        }
    }
}

/// The UNTIL that ends a series just before `before`: the day before (all
/// day), or a second before, in UTC.
fn until_before(before: &str, all_day: bool) -> Option<String> {
    if all_day {
        let day = NaiveDate::parse_from_str(before.get(..10)?, "%Y-%m-%d").ok()?;
        return Some((day - chrono::TimeDelta::days(1)).format("%Y%m%d").to_string());
    }
    let at = DateTime::parse_from_rfc3339(before).ok()?.with_timezone(&Utc) - chrono::TimeDelta::seconds(1);
    Some(at.format("%Y%m%dT%H%M%SZ").to_string())
}

/// Whether a series starting at `first` has occurrences before `before`
/// (both RFC 3339 times, or both dates).
fn starts_before(first: &str, before: &str) -> bool {
    match (DateTime::parse_from_rfc3339(first), DateTime::parse_from_rfc3339(before)) {
        (Ok(first), Ok(before)) => first < before,
        _ => first.get(..10).unwrap_or(first) < before.get(..10).unwrap_or(before),
    }
}

/// `rules` with every RRULE ending at `until` (its UNTIL or COUNT replaced).
fn with_until(rules: &[String], until: &str) -> Vec<String> {
    rules
        .iter()
        .map(|rule| {
            if !rule.to_ascii_uppercase().starts_with("RRULE:") {
                return rule.clone();
            }
            format!("{};UNTIL={until}", without_parts(rule, &["UNTIL", "COUNT"]))
        })
        .collect()
}

/// An RRULE line without the parts named (e.g. COUNT).
fn without_parts(rule: &str, names: &[&str]) -> String {
    let body = &rule["RRULE:".len()..];
    let kept: Vec<&str> = body
        .split(';')
        .filter(|part| {
            let name = part.split('=').next().unwrap_or("").to_ascii_uppercase();
            !part.is_empty() && !names.contains(&name.as_str())
        })
        .collect();
    format!("RRULE:{}", kept.join(";"))
}

/// The signed-in account's email address, which is its primary calendar's ID.
pub async fn primary_email(http: &reqwest::Client, token: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Calendar {
        id: String,
    }
    let mut url = Url::parse(API).expect("valid URL");
    url.path_segments_mut().expect("base URL").extend(["calendars", "primary"]);
    let calendar: Calendar = get_json(http, token, url).await?;
    Ok(calendar.id)
}

/// A calendar you can add events to.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCalendar {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub primary: bool,
}

/// One of an account's calendars, for choosing which to show.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedCalendar {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub primary: bool,
    /// Not hidden in Settings.
    pub shown: bool,
}

/// All of `account`'s calendars, your main ("primary") one first, then by name.
pub async fn all_calendars(http: &reqwest::Client, token: &str, account: &str) -> Result<Vec<ListedCalendar>> {
    let mut calendars: Vec<ListedCalendar> = list_calendars(http, token)
        .await?
        .into_iter()
        .map(|cal| ListedCalendar {
            name: cal.name(),
            shown: crate::prefs::google_calendar_shown(account, &cal.id),
            id: cal.id,
            color: cal.background_color,
            primary: cal.primary,
        })
        .collect();
    calendars.sort_by_cached_key(|cal| (!cal.primary, cal.name.to_lowercase()));
    Ok(calendars)
}

/// The calendars you can add events to, your main ("primary") one first.
pub async fn editable_calendars(http: &reqwest::Client, token: &str) -> Result<Vec<EventCalendar>> {
    let mut calendars: Vec<EventCalendar> = list_calendars(http, token)
        .await?
        .into_iter()
        .filter(CalendarListEntry::can_write)
        .map(|cal| EventCalendar { name: cal.name(), id: cal.id, color: cal.background_color, primary: cal.primary })
        .collect();
    calendars.sort_by_key(|cal| !cal.primary);
    Ok(calendars)
}

/// When an event happens: whole days, or times.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTimes {
    /// "YYYY-MM-DD" when `all_day`, otherwise an RFC 3339 timestamp.
    pub start: String,
    /// Same format as `start`. For all-day events, the day after the last day.
    pub end: String,
    pub all_day: bool,
    /// IANA time zone, e.g. "Europe/London". Google needs it for timed events
    /// that repeat; for others it only labels the event.
    pub time_zone: Option<String>,
}

impl EventTimes {
    /// The `start` and `end` Google expects, after checking them.
    fn to_json(&self) -> Result<(Value, Value)> {
        if self.all_day {
            if parse_day(&self.end)? <= parse_day(&self.start)? {
                return Err(AppError::InvalidInput("the event must end after its first day".into()));
            }
            return Ok((json!({ "date": self.start }), json!({ "date": self.end })));
        }
        if parse_time(&self.end)? < parse_time(&self.start)? {
            return Err(AppError::InvalidInput("the event must end after it starts".into()));
        }
        let at = |time: &str| match &self.time_zone {
            Some(zone) => json!({ "dateTime": time, "timeZone": zone }),
            None => json!({ "dateTime": time }),
        };
        Ok((at(&self.start), at(&self.end)))
    }
}

/// Someone to invite.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestDraft {
    pub email: String,
    /// Kept for people already invited, so editing doesn't reset their reply.
    pub response: Option<String>,
}

/// "popup" (a notification) or "email" (Google sends it).
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AlertMethod {
    Popup,
    Email,
}

impl AlertMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Popup => "popup",
            Self::Email => "email",
        }
    }

    fn popup() -> Self {
        Self::Popup
    }
}

/// One notification: a lead time before the start, or an exact instant.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AlertSpec {
    Relative {
        minutes: u32,
        #[serde(default = "AlertMethod::popup")]
        method: AlertMethod,
    },
    /// RFC 3339. Not a Google Calendar reminder.
    Absolute { at: String },
    /// Minutes before the leave-by time. Not a Google Calendar reminder: the
    /// time depends on traffic, so Minuteman works it out and fires the alert.
    Leave {
        #[serde(rename = "bufferMinutes")]
        buffer_minutes: u32,
    },
}

/// An event's alerts: its calendar's defaults, or its own list (empty for none).
///
/// `minutes` is the older shape (popup minutes only). A custom list in `alerts`
/// wins when it isn't empty; otherwise `minutes` is used, so events saved
/// before alerts could be a list still sync.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Alerts {
    Default,
    Custom {
        #[serde(default)]
        minutes: Vec<u32>,
        #[serde(default)]
        alerts: Vec<AlertSpec>,
    },
}

/// An event as the New or Edit form filled it in.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDraft {
    pub title: String,
    #[serde(flatten)]
    pub times: EventTimes,
    pub location: Option<String>,
    pub description: Option<String>,
    /// Repeat rules, e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO". `None` leaves an
    /// existing event's repeat as it is.
    pub recurrence: Option<Vec<String>>,
    /// `None` leaves an existing event's alerts as they are.
    pub alerts: Option<Alerts>,
    /// `None` leaves an existing event's guests as they are.
    pub guests: Option<Vec<GuestDraft>>,
    /// Keep its clock time in any time zone (see `FLOATING`). `None` leaves it as it is.
    #[serde(default)]
    pub floating: Option<bool>,
    /// Starting address for the drive. `None` leaves an existing one as it is.
    /// `Some("")` clears it (use the address in Settings).
    #[serde(default)]
    pub leave_from: Option<String>,
    /// The event's own color ("1" to "11"). `None` leaves it as it is;
    /// `Some("")` goes back to the calendar's color.
    #[serde(default)]
    pub color_id: Option<String>,
}

impl EventDraft {
    fn to_json(&self) -> Result<Value> {
        let title = self.title.trim();
        if title.is_empty() {
            return Err(AppError::InvalidInput("the event needs a title".into()));
        }
        let (start, end) = self.times.to_json()?;
        let text = |s: &Option<String>| s.as_deref().map(str::trim).unwrap_or("").to_string();
        // An empty string clears a field when editing.
        let mut body = json!({
            "summary": title,
            "start": start,
            "end": end,
            "location": text(&self.location),
            "description": text(&self.description),
        });
        let mut private = serde_json::Map::new();
        if let Some(floating) = self.floating {
            private.insert(FLOATING.to_string(), json!(floating.to_string()));
        }
        if let Some(alerts) = &self.alerts {
            let (reminders, stored) = split_alerts(alerts)?;
            body["reminders"] = reminders;
            // An empty string asks an update to remove any alerts kept earlier.
            private.insert(LOCAL_ALERTS.to_string(), json!(stored.to_property()));
        }
        if let Some(from) = &self.leave_from {
            private.insert(LEAVE_FROM.to_string(), json!(from.trim()));
        }
        if !private.is_empty() {
            body["extendedProperties"] = json!({ "private": private });
        }
        if let Some(rules) = &self.recurrence {
            body["recurrence"] = json!(rules);
        }
        match self.color_id.as_deref().map(str::trim) {
            None => {}
            // null removes the event's own color (Google's update is a PATCH).
            Some("") => body["colorId"] = Value::Null,
            Some(id) if event_color(id).is_some() => body["colorId"] = json!(id),
            Some(_) => return Err(AppError::InvalidInput("that isn't one of Google Calendar's event colors".into())),
        }
        if let Some(guests) = &self.guests {
            body["attendees"] = guests
                .iter()
                .map(|g| match &g.response {
                    Some(response) => json!({ "email": g.email.trim(), "responseStatus": response }),
                    None => json!({ "email": g.email.trim() }),
                })
                .collect();
        }
        Ok(body)
    }

    fn has_guests(&self) -> bool {
        self.guests.as_ref().is_some_and(|g| !g.is_empty())
    }
}

/// Alerts Minuteman keeps on the event because Google Calendar's reminders
/// can't: an exact instant, a time to leave, a sixth override, or a lead
/// longer than 4 weeks.
#[derive(serde::Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
struct StoredAlerts {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    at: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    popup: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    email: Vec<u32>,
    /// Minutes before the leave-by time.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    leave: Vec<u32>,
}

impl StoredAlerts {
    fn is_empty(&self) -> bool {
        self.at.is_empty() && self.popup.is_empty() && self.email.is_empty() && self.leave.is_empty()
    }

    /// JSON for the private property, or "" when there's nothing to keep
    /// (which an update reads as "remove the property").
    fn to_property(&self) -> String {
        if self.is_empty() { String::new() } else { serde_json::to_string(self).unwrap_or_default() }
    }
}

fn parse_stored(value: Option<&str>) -> StoredAlerts {
    let Some(value) = value.filter(|s| !s.is_empty()) else { return StoredAlerts::default() };
    serde_json::from_str(value).unwrap_or_default()
}

/// The popup minutes, email minutes, and exact instants to show and fire.
/// Calendar defaults stand in when the event doesn't set its own reminders.
/// Anything kept in `local` is added on, without repeating a minute already there.
fn collect_reminders(
    event_reminders: Option<&Reminders>,
    defaults: &[Reminder],
    local: &StoredAlerts,
) -> (Vec<u32>, Vec<u32>, Vec<String>, Vec<u32>) {
    let source = match event_reminders {
        Some(reminders) if !reminders.use_default => &reminders.overrides,
        _ => defaults,
    };
    let mut popup = minutes_of(source, "popup");
    let mut email = minutes_of(source, "email");
    append_unique(&mut popup, &local.popup);
    append_unique(&mut email, &local.email);
    (popup, email, local.at.clone(), local.leave.clone())
}

fn minutes_of(reminders: &[Reminder], method: &str) -> Vec<u32> {
    reminders.iter().filter(|r| r.method.as_deref() == Some(method)).filter_map(|r| r.minutes).collect()
}

fn append_unique(base: &mut Vec<u32>, extra: &[u32]) {
    for minutes in extra {
        if !base.contains(minutes) {
            base.push(*minutes);
        }
    }
}

/// Google's `reminders` object, and the alerts that don't fit in it.
fn split_alerts(alerts: &Alerts) -> Result<(Value, StoredAlerts)> {
    let Alerts::Custom { minutes, alerts } = alerts else {
        return Ok((json!({ "useDefault": true }), StoredAlerts::default()));
    };
    // The newer list wins. An empty one with the old `minutes` field is an
    // event saved before an event could have several kinds of alert.
    let specs = if !alerts.is_empty() {
        alerts.clone()
    } else {
        minutes.iter().map(|&minutes| AlertSpec::Relative { minutes, method: AlertMethod::Popup }).collect::<Vec<_>>()
    };
    let mut overrides = Vec::new();
    let mut stored = StoredAlerts::default();
    for spec in specs {
        match spec {
            AlertSpec::Absolute { at } => {
                parse_time(&at)?;
                stored.at.push(at);
            }
            AlertSpec::Relative { minutes, method } => {
                let fits = minutes <= GOOGLE_MAX_MINUTES && overrides.len() < GOOGLE_MAX_OVERRIDES;
                if fits {
                    overrides.push(json!({ "method": method.as_str(), "minutes": minutes }));
                } else {
                    match method {
                        AlertMethod::Popup => stored.popup.push(minutes),
                        AlertMethod::Email => stored.email.push(minutes),
                    }
                }
            }
            AlertSpec::Leave { buffer_minutes } => {
                // A week of spare time is plenty; anything larger is a typo.
                if buffer_minutes > 7 * 24 * 60 {
                    return Err(AppError::InvalidInput(
                        "a leave alert can't be more than a week before you need to leave".into(),
                    ));
                }
                if !stored.leave.contains(&buffer_minutes) {
                    stored.leave.push(buffer_minutes);
                }
            }
        }
    }
    Ok((json!({ "useDefault": false, "overrides": overrides }), stored))
}

/// `calendars/{calendar_id}/events[/{event_id}]`, with Google told whether to
/// email guests about the change.
fn events_url(calendar_id: &str, event_id: Option<&str>, notify_guests: bool) -> Url {
    let mut url = Url::parse(API).expect("valid URL");
    {
        let mut path = url.path_segments_mut().expect("base URL");
        path.extend(["calendars", calendar_id, "events"]);
        if let Some(id) = event_id {
            path.push(id);
        }
    }
    url.query_pairs_mut().append_pair("sendUpdates", if notify_guests { "all" } else { "none" });
    url
}

/// Your reply to an invitation: "accepted", "declined" or "tentative" (maybe).
/// Only your own entry on the guest list changes; everyone else's (and their
/// replies, notes and the rest) is sent back as it was. The organizer is told,
/// as Google Calendar does.
pub async fn respond(http: &reqwest::Client, token: &str, calendar_id: &str, event_id: &str, response: &str) -> Result<()> {
    if !["accepted", "declined", "tentative"].contains(&response) {
        return Err(AppError::InvalidInput("a reply is yes, no or maybe".into()));
    }
    #[derive(Deserialize)]
    struct Guests {
        #[serde(default)]
        attendees: Vec<Value>,
    }
    let mut url = events_url(calendar_id, Some(event_id), true);
    let mut read = url.clone();
    read.set_query(Some("fields=attendees"));
    let Guests { mut attendees } = get_json(http, token, read).await?;
    let attendees = with_reply(&mut attendees, response)
        .ok_or_else(|| AppError::InvalidInput("you're not on this event's guest list".into()))?;
    url.query_pairs_mut().append_pair("fields", "id");
    let _replied: Value = send(http.patch(url).bearer_auth(token).json(&json!({ "attendees": attendees }))).await?;
    Ok(())
}

/// The guest list with your own reply set to `response`; `None` if you aren't on it.
fn with_reply<'a>(attendees: &'a mut [Value], response: &str) -> Option<&'a [Value]> {
    let you = attendees.iter_mut().find(|a| a.get("self").and_then(Value::as_bool) == Some(true))?;
    you["responseStatus"] = json!(response);
    Some(attendees)
}

/// Adds an event to the calendar `calendar_id`, inviting its guests.
pub async fn create_event(http: &reqwest::Client, token: &str, calendar_id: &str, draft: &EventDraft) -> Result<()> {
    let url = events_url(calendar_id, None, draft.has_guests());
    let mut body = draft.to_json()?;
    drop_empty_private(&mut body);
    let _created: Value = send(http.post(url).bearer_auth(token).json(&body)).await?;
    Ok(())
}

/// Saves an edited event. For one occurrence of a repeating event, only that
/// occurrence changes. `notify_guests` emails them about the change.
pub async fn update_event(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    event_id: &str,
    draft: &EventDraft,
    notify_guests: bool,
) -> Result<()> {
    let url = events_url(calendar_id, Some(event_id), notify_guests);
    let mut body = draft.to_json()?;
    merge_private(http, token, calendar_id, event_id, &mut body).await?;
    let _updated: Value = send(http.patch(url).bearer_auth(token).json(&body)).await?;
    Ok(())
}

/// Saves an edit made to every event in a repeating series, from one of its
/// occurrences (`occurrence`: when that one was, before the edit). Times are
/// changed by as much as the occurrence's were, so the series keeps its own
/// first date: an occurrence moved from 10:00 to 11:00 a day later moves every
/// event to 11:00 a day later.
pub async fn update_series(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    series_id: &str,
    occurrence: &EventTimes,
    draft: &EventDraft,
    notify_guests: bool,
) -> Result<()> {
    let mut body = draft.to_json()?;
    let fields = body.as_object_mut().expect("an object");
    fields.remove("start");
    fields.remove("end");
    if let Some(times) = series_times_for_edit(http, token, calendar_id, series_id, occurrence, &draft.times).await? {
        let (start, end) = times.to_json()?;
        fields.insert("start".into(), start);
        fields.insert("end".into(), end);
    }
    let url = events_url(calendar_id, Some(series_id), notify_guests);
    merge_private(http, token, calendar_id, series_id, &mut body).await?;
    let _updated: Value = send(http.patch(url).bearer_auth(token).json(&body)).await?;
    Ok(())
}

/// A new event has nothing to clear: drop private keys whose value is empty
/// rather than storing a blank one.
fn drop_empty_private(body: &mut Value) {
    let Some(obj) = body.as_object_mut() else { return };
    let Some(private) = obj.get_mut("extendedProperties").and_then(|v| v.get_mut("private")).and_then(|v| v.as_object_mut()) else {
        return;
    };
    private.retain(|_, value| value.as_str() != Some(""));
    if private.is_empty() {
        obj.remove("extendedProperties");
    }
}

/// Google replaces the whole private-property map when a patch includes one.
/// Read what's there and lay our keys over it, so saving alerts doesn't wipe
/// the floating flag (or the other way round). An empty string removes a key.
async fn merge_private(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    event_id: &str,
    body: &mut Value,
) -> Result<()> {
    let Some(ours) = body.pointer("/extendedProperties/private").and_then(|v| v.as_object()).cloned() else {
        return Ok(());
    };
    let mut url = Url::parse(API).expect("valid URL");
    url.path_segments_mut().expect("base URL").extend(["calendars", calendar_id, "events", event_id]);
    url.query_pairs_mut().append_pair("fields", "extendedProperties/private");
    let current: Value = get_json(http, token, url).await?;
    let mut private = current
        .pointer("/extendedProperties/private")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    for (key, value) in ours {
        if value.as_str() == Some("") {
            private.remove(&key);
        } else {
            private.insert(key, value);
        }
    }
    body["extendedProperties"] = json!({ "private": private });
    Ok(())
}

/// The series' new times, or `None` if the edit didn't change when it happens.
async fn series_times_for_edit(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    series_id: &str,
    occurrence: &EventTimes,
    edited: &EventTimes,
) -> Result<Option<EventTimes>> {
    if occurrence.all_day == edited.all_day
        && same_time(&occurrence.start, &edited.start)
        && same_time(&occurrence.end, &edited.end)
    {
        return Ok(None);
    }
    let url = events_url(calendar_id, Some(series_id), false);
    let series: Value = send(http.get(url).bearer_auth(token)).await?;
    let first = series_first_day(&series["start"])
        .ok_or_else(|| AppError::Api { status: 200, message: "Google sent a repeating event without a start".into() })?;
    shift_series(first, occurrence, edited).map(Some)
}

/// Whether two `start`/`end` strings are the same moment (or day).
fn same_time(a: &str, b: &str) -> bool {
    a == b || matches!((parse_time(a), parse_time(b)), (Ok(a), Ok(b)) if a == b)
}

/// The local day a series starts on, from Google's `start` object.
fn series_first_day(start: &Value) -> Option<NaiveDate> {
    if let Some(date) = start["date"].as_str() {
        return parse_day(date).ok();
    }
    let time = parse_time(start["dateTime"].as_str()?).ok()?;
    Some(time.with_timezone(&Local).date_naive())
}

/// Local date and time of a `start`/`end` (midnight for whole days).
fn local_time(s: &str, all_day: bool) -> Result<NaiveDateTime> {
    if all_day {
        return Ok(parse_day(s)?.and_time(NaiveTime::MIN));
    }
    Ok(parse_time(s)?.with_timezone(&Local).naive_local())
}

/// The series' times after an occurrence of it went from `occurrence` to
/// `edited`: its first day moved by as many days, at the edited time and length.
fn shift_series(first_day: NaiveDate, occurrence: &EventTimes, edited: &EventTimes) -> Result<EventTimes> {
    let was = local_time(&occurrence.start, occurrence.all_day)?;
    let start = local_time(&edited.start, edited.all_day)?;
    let end = local_time(&edited.end, edited.all_day)?;
    let day = first_day + (start.date() - was.date());
    let new_start = day.and_time(start.time());
    let new_end = new_start + (end - start);
    let format = |t: NaiveDateTime| -> Result<String> {
        if edited.all_day {
            return Ok(t.date().to_string());
        }
        let local = Local
            .from_local_datetime(&t)
            .earliest()
            .ok_or_else(|| AppError::InvalidInput("that time doesn't exist here (a clock change)".into()))?;
        Ok(local.to_rfc3339())
    };
    Ok(EventTimes {
        start: format(new_start)?,
        end: format(new_end)?,
        all_day: edited.all_day,
        time_zone: edited.time_zone.clone(),
    })
}

/// Moves an event to another of the same account's calendars.
pub async fn move_to_calendar(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    event_id: &str,
    destination: &str,
) -> Result<()> {
    let mut url = Url::parse(API).expect("valid URL");
    url.path_segments_mut().expect("base URL").extend(["calendars", calendar_id, "events", event_id, "move"]);
    url.query_pairs_mut().append_pair("destination", destination);
    let _moved: Value = send(http.post(url).bearer_auth(token)).await?;
    Ok(())
}

/// Changes only when an event happens (dragging it). For one occurrence of a
/// repeating event, only that occurrence changes.
pub async fn set_event_times(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    event_id: &str,
    times: &EventTimes,
    notify_guests: bool,
) -> Result<()> {
    let (start, end) = times.to_json()?;
    let url = events_url(calendar_id, Some(event_id), notify_guests);
    let _updated: Value = send(http.patch(url).bearer_auth(token).json(&json!({ "start": start, "end": end }))).await?;
    Ok(())
}

/// Deletes an event. Given a repeating event's own ID (`series_id`), deletes
/// every occurrence; given one occurrence's ID, just that one.
pub async fn delete_event(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    event_id: &str,
    notify_guests: bool,
) -> Result<()> {
    let url = events_url(calendar_id, Some(event_id), notify_guests);
    let response = http.delete(url).bearer_auth(token).send().await?;
    let status = response.status();
    // 410 Gone: it was already deleted, which is what we wanted.
    if status.is_success() || status.as_u16() == 410 {
        return Ok(());
    }
    Err(api_error(response).await)
}

fn parse_day(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| AppError::InvalidInput(format!("not a YYYY-MM-DD date: {s:?}")))
}

fn parse_time(s: &str) -> Result<DateTime<chrono::FixedOffset>> {
    DateTime::parse_from_rfc3339(s).map_err(|_| AppError::InvalidInput(format!("not an RFC 3339 time: {s:?}")))
}

async fn list_calendars(http: &reqwest::Client, token: &str) -> Result<Vec<CalendarListEntry>> {
    let mut url = Url::parse(API).expect("valid URL");
    url.path_segments_mut().expect("base URL").extend(["users", "me", "calendarList"]);
    get_all_pages(http, token, url).await
}

async fn list_events(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    from: DateTime<Local>,
    to: DateTime<Local>,
    query: Option<&str>,
) -> Result<Vec<Event>> {
    let mut url = Url::parse(API).expect("valid URL");
    // Calendar IDs contain characters like '#' that must be escaped in a URL path.
    url.path_segments_mut().expect("base URL").extend(["calendars", calendar_id, "events"]);
    url.query_pairs_mut()
        .append_pair("timeMin", &from.to_rfc3339())
        .append_pair("timeMax", &to.to_rfc3339())
        // Expand recurring events into their individual occurrences.
        .append_pair("singleEvents", "true")
        .append_pair("orderBy", "startTime")
        .append_pair("maxResults", "250");
    if let Some(q) = query {
        url.query_pairs_mut().append_pair("q", q);
    }
    get_all_pages(http, token, url).await
}

/// Google returns long lists in pages; keep asking for the next page until
/// there isn't one.
async fn get_all_pages<T: DeserializeOwned>(
    http: &reqwest::Client,
    token: &str,
    url: Url,
) -> Result<Vec<T>> {
    let mut all = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let mut page_url = url.clone();
        if let Some(t) = &page_token {
            page_url.query_pairs_mut().append_pair("pageToken", t);
        }
        let page: Page<T> = get_json(http, token, page_url).await?;
        all.extend(page.items);
        match page.next_page_token {
            Some(next) => page_token = Some(next),
            None => return Ok(all),
        }
    }
}

async fn get_json<T: DeserializeOwned>(http: &reqwest::Client, token: &str, url: Url) -> Result<T> {
    send(http.get(url).bearer_auth(token)).await
}

/// Sends a request and reads the JSON reply, or Google's error message.
pub(crate) async fn send<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T> {
    let response = request.send().await?;
    if response.status().is_success() {
        return Ok(response.json().await?);
    }
    Err(api_error(response).await)
}

async fn api_error(response: reqwest::Response) -> AppError {
    let status = response.status();
    let message = match response.json::<ApiErrorBody>().await {
        Ok(body) => body.error.message,
        Err(_) => status.canonical_reason().unwrap_or("unknown error").to_string(),
    };
    AppError::Api { status: status.as_u16(), message }
}

fn to_agenda_item(account: &str, can_edit: bool, calendar: &CalendarListEntry, event: Event) -> Option<AgendaItem> {
    if event.status.as_deref() == Some("cancelled") {
        return None;
    }
    // "Working from home/office" markers clutter an agenda.
    if event.event_type.as_deref() == Some("workingLocation") {
        return None;
    }
    let declined = event
        .attendees
        .iter()
        .any(|a| a.is_self && a.response_status.as_deref() == Some("declined"));
    if declined {
        return None;
    }

    let start = event.start?;
    // The event's own time zone (or else its calendar's).
    let time_zone = start.time_zone.clone().or_else(|| calendar.time_zone.clone());
    let (start, all_day) = match (start.date_time, start.date) {
        (Some(date_time), _) => (date_time, false),
        (None, Some(date)) => (date, true),
        (None, None) => return None,
    };
    let end = event.end.and_then(|e| e.date_time.or(e.date));
    let floating = !all_day
        && event.extended_properties.as_ref().is_some_and(|p| p.private.get(FLOATING).is_some_and(|v| v == "true"));
    // Floating: the same clock time it has in its own zone, but here.
    let (start, end) = match (&time_zone, floating) {
        (Some(zone), true) => (
            float_here(&start, zone).unwrap_or(start),
            end.map(|end| float_here(&end, zone).unwrap_or(end)),
        ),
        _ => (start, end),
    };

    let conference_url = event
        .conference_data
        .iter()
        .flat_map(|data| &data.entry_points)
        .find(|entry| entry.entry_point_type.as_deref() == Some("video"))
        .and_then(|entry| entry.uri.clone())
        .or(event.hangout_link)
        .or_else(|| event.location.as_deref().and_then(find_meeting_link))
        .or_else(|| event.description.as_deref().and_then(find_meeting_link));
    let props = event.extended_properties.as_ref().map(|p| &p.private);
    let stored = parse_stored(props.and_then(|p| p.get(LOCAL_ALERTS).map(String::as_str)));
    let leave_from = props.and_then(|p| p.get(LEAVE_FROM)).filter(|s| !s.trim().is_empty()).cloned();
    // All-day events too: "1 day before" is a real Google reminder, measured
    // back from midnight at the start of the event.
    let (reminders, email_reminders, alert_at, leave_alerts) =
        collect_reminders(event.reminders.as_ref(), &calendar.default_reminders, &stored);
    let organized_by_you = event.organizer.as_ref().is_none_or(|o| o.is_self);
    let attendees = event
        .attendees
        .into_iter()
        .filter(|a| !a.resource)
        .map(|a| Guest {
            name: a.display_name,
            email: a.email,
            response: a.response_status,
            organizer: a.organizer,
            is_self: a.is_self,
        })
        .collect();

    Some(AgendaItem {
        floating,
        time_zone,
        account: Some(account.to_string()),
        list_id: Some(calendar.id.clone()),
        source_id: Some(event.id.clone()),
        editable: can_edit && calendar.can_write() && (organized_by_you || event.guests_can_modify),
        recurring: event.recurring_event_id.is_some(),
        series_id: event.recurring_event_id,
        description: event.description.filter(|s| !s.trim().is_empty()),
        attendees,
        conference_url,
        reminders,
        email_reminders,
        alert_at,
        leave_from,
        leave_alerts,
        id: format!("google:{}:{}", calendar.id, event.id),
        source: Source::Google,
        kind: ItemKind::Event,
        title: event.summary.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "(No title)".into()),
        start,
        end,
        all_day,
        location: event.location.as_deref().and_then(crate::agenda::place_on_one_line),
        color: event
            .color_id
            .as_deref()
            .and_then(event_color)
            .map(str::to_string)
            .or_else(|| calendar.background_color.clone()),
        color_id: event.color_id.filter(|id| event_color(id).is_some()),
        repeat: None,
        list_name: calendar.name(),
        url: event.html_link,
        completed: false,
        overdue: false,
        priority: None,
    })
}

/// `instant`'s clock time in `zone`, as that same clock time here (RFC 3339).
/// A time that a clock change here skips moves on by an hour.
fn float_here(instant: &str, zone: &str) -> Option<String> {
    let zone: chrono_tz::Tz = zone.parse().ok()?;
    let clock = DateTime::parse_from_rfc3339(instant).ok()?.with_timezone(&zone).naive_local();
    let here = Local
        .from_local_datetime(&clock)
        .earliest()
        .or_else(|| Local.from_local_datetime(&(clock + chrono::TimeDelta::hours(1))).earliest())?;
    Some(here.to_rfc3339())
}

/// A video-call link in an event's location or notes (e.g. Apple Calendar's).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn meeting_link(location: Option<&str>, notes: Option<&str>) -> Option<String> {
    location.and_then(find_meeting_link).or_else(|| notes.and_then(find_meeting_link))
}

/// The first video-call link in `text` (a location or notes, possibly HTML).
fn find_meeting_link(text: &str) -> Option<String> {
    const HOSTS: &[&str] = &[
        "zoom.us/",
        "meet.google.com/",
        "teams.microsoft.com/",
        "teams.live.com/",
        "webex.com/",
        "whereby.com/",
        "gotomeeting.com/",
        "chime.aws/",
    ];
    text.replace("&amp;", "&")
        .split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '(' | ')'))
        .filter(|word| word.starts_with("https://"))
        .find(|word| HOSTS.iter().any(|host| word.contains(host)))
        .map(|word| word.trim_end_matches(['.', ',', ';']).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_changes_only_your_own_entry() {
        let mut guests = vec![
            json!({ "email": "parker@example.com", "organizer": true, "responseStatus": "accepted" }),
            json!({ "email": "you@example.com", "self": true, "responseStatus": "needsAction", "comment": "kept" }),
        ];
        let replied = with_reply(&mut guests, "tentative").unwrap();
        assert_eq!(replied[0]["responseStatus"], "accepted");
        assert_eq!(replied[1]["responseStatus"], "tentative");
        assert_eq!(replied[1]["comment"], "kept");
        assert!(with_reply(&mut [json!({ "email": "a@example.com" })], "accepted").is_none());
    }

    #[test]
    fn an_address_with_line_breaks_shows_on_one_line() {
        use crate::agenda::place_on_one_line;
        assert_eq!(
            place_on_one_line("10 Battle Rd\nLexington MA 02421\nUnited States").as_deref(),
            Some("10 Battle Rd, Lexington MA 02421, United States")
        );
        assert_eq!(place_on_one_line("Green Dragon Tavern,\r\n 84 Union St\n").as_deref(), Some("Green Dragon Tavern, 84 Union St"));
        assert_eq!(place_on_one_line("Old North Church").as_deref(), Some("Old North Church"));
        assert_eq!(place_on_one_line(" \n "), None);
    }

    #[test]
    fn this_and_following_ends_the_series_just_before() {
        assert_eq!(until_before("2026-11-10T09:00:00-05:00", false).as_deref(), Some("20261110T135959Z"));
        assert_eq!(until_before("2026-11-10", true).as_deref(), Some("20261109"));
        let rules = vec!["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10".to_string(), "EXDATE:20261103T140000Z".to_string()];
        assert_eq!(
            with_until(&rules, "20261110T135959Z"),
            vec!["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261110T135959Z".to_string(), "EXDATE:20261103T140000Z".to_string()]
        );
        assert_eq!(without_parts("RRULE:FREQ=DAILY;UNTIL=20270101;INTERVAL=2", &["UNTIL"]), "RRULE:FREQ=DAILY;INTERVAL=2");
        assert!(starts_before("2026-10-06T09:00:00-04:00", "2026-11-10T09:00:00-05:00"));
        assert_eq!(
            following_rules(&["RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=TU".into(), "EXDATE:20261103T140000Z".into()], 4),
            vec!["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6".to_string()]
        );
        assert_eq!(following_rules(&["RRULE:FREQ=DAILY".into()], 4), vec!["RRULE:FREQ=DAILY".to_string()]);
        assert_eq!(count_of("RRULE:FREQ=DAILY;count=3"), Some(3));
        // Its first occurrence: nothing before it to keep.
        assert!(!starts_before("2026-11-10T09:00:00-05:00", "2026-11-10T09:00:00-05:00"));
        assert!(starts_before("2026-10-06", "2026-11-10"));
    }

    fn draft(json: Value) -> EventDraft {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn floating_events_keep_their_clock_time_here() {
        // 9 AM in New York (and in Tokyo) is 9 AM here, whatever zone this runs in.
        for (instant, zone) in [("2026-10-29T09:00:00-04:00", "America/New_York"), ("2026-10-29T00:00:00Z", "Asia/Tokyo")] {
            let here = float_here(instant, zone).unwrap();
            let clock = DateTime::parse_from_rfc3339(&here).unwrap().with_timezone(&Local);
            assert_eq!(clock.format("%Y-%m-%d %H:%M").to_string(), "2026-10-29 09:00", "{instant} in {zone}");
        }
        assert!(float_here("2026-10-29T09:00:00Z", "Not/AZone").is_none());
    }

    #[test]
    fn floating_is_saved_as_a_private_property() {
        let body = draft(json!({
            "title": "Medicine", "start": "2026-10-29T09:00:00-04:00", "end": "2026-10-29T09:15:00-04:00",
            "allDay": false, "timeZone": "America/New_York", "location": null, "description": null,
            "recurrence": null, "alerts": null, "guests": null, "floating": true,
        }))
        .to_json()
        .unwrap();
        assert_eq!(body["extendedProperties"]["private"][FLOATING], json!("true"));
    }

    /// A local time as RFC 3339, whatever zone the tests run in.
    fn local(day: &str, time: &str) -> String {
        let t = NaiveDateTime::parse_from_str(&format!("{day} {time}"), "%Y-%m-%d %H:%M").unwrap();
        Local.from_local_datetime(&t).earliest().unwrap().to_rfc3339()
    }

    fn times(start: String, end: String, all_day: bool) -> EventTimes {
        EventTimes { start, end, all_day, time_zone: None }
    }

    #[test]
    fn editing_a_whole_series_keeps_its_first_day() {
        // A weekly series from Monday 5 January; this Monday's 10:00 was moved
        // to Tuesday, 11:00 to 11:30.
        let first = parse_day("2026-01-05").unwrap();
        let was = times(local("2026-10-26", "10:00"), local("2026-10-26", "11:00"), false);
        let now = times(local("2026-10-27", "11:00"), local("2026-10-27", "11:30"), false);
        let series = shift_series(first, &was, &now).unwrap();
        assert!(same_time(&series.start, &local("2026-01-06", "11:00")));
        assert!(same_time(&series.end, &local("2026-01-06", "11:30")));

        // Made all day instead.
        let all_day = times("2026-10-26".into(), "2026-10-27".into(), true);
        let series = shift_series(first, &was, &all_day).unwrap();
        assert_eq!((series.start.as_str(), series.end.as_str()), ("2026-01-05", "2026-01-06"));
    }

    #[test]
    fn a_new_repeating_event_with_an_alert_and_a_guest() {
        let body = draft(json!({
            "title": " Standup ",
            "start": "2026-11-02T09:00:00+00:00",
            "end": "2026-11-02T09:15:00+00:00",
            "allDay": false,
            "timeZone": "Europe/London",
            "location": null,
            "description": "Daily",
            "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
            "alerts": { "kind": "custom", "minutes": [10] },
            "guests": [{ "email": "sam@example.com", "response": null }],
        }))
        .to_json()
        .unwrap();
        assert_eq!(body["summary"], "Standup");
        assert_eq!(body["start"], json!({ "dateTime": "2026-11-02T09:00:00+00:00", "timeZone": "Europe/London" }));
        assert_eq!(body["location"], "");
        assert_eq!(body["recurrence"], json!(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]));
        assert_eq!(body["reminders"], json!({ "useDefault": false, "overrides": [{ "method": "popup", "minutes": 10 }] }));
        assert_eq!(body["attendees"], json!([{ "email": "sam@example.com" }]));
    }

    #[test]
    fn editing_leaves_repeat_and_guests_alone_unless_given() {
        let body = draft(json!({
            "title": "Holiday",
            "start": "2026-12-24",
            "end": "2026-12-27",
            "allDay": true,
            "timeZone": null,
            "location": "Home",
            "description": null,
            "recurrence": null,
            "alerts": { "kind": "default" },
            "guests": null,
        }))
        .to_json()
        .unwrap();
        assert_eq!(body["start"], json!({ "date": "2026-12-24" }));
        assert_eq!(body["reminders"], json!({ "useDefault": true }));
        assert!(body.get("recurrence").is_none());
        assert!(body.get("attendees").is_none());
    }

    fn bare(alerts: Value) -> Value {
        draft(json!({
            "title": "Standup",
            "start": "2026-11-02T09:00:00+00:00",
            "end": "2026-11-02T09:15:00+00:00",
            "allDay": false,
            "timeZone": null,
            "location": null,
            "description": null,
            "recurrence": null,
            "alerts": alerts,
            "guests": null,
        }))
        .to_json()
        .unwrap()
    }

    #[test]
    fn several_alerts_sync_until_google_runs_out_of_room() {
        let week = 7 * 24 * 60;
        let body = bare(json!({
            "kind": "custom",
            "alerts": [
                { "kind": "relative", "minutes": 30, "method": "popup" },
                { "kind": "relative", "minutes": 60, "method": "email" },
                { "kind": "relative", "minutes": 120 },
                { "kind": "relative", "minutes": week },
                { "kind": "relative", "minutes": 2 * week },
                // A sixth one, and one longer than 4 weeks, can't be overrides.
                { "kind": "relative", "minutes": 5 },
                { "kind": "relative", "minutes": 5 * week },
                { "kind": "absolute", "at": "2026-11-01T15:00:00+00:00" },
            ],
        }));
        assert_eq!(
            body["reminders"],
            json!({
                "useDefault": false,
                "overrides": [
                    { "method": "popup", "minutes": 30 },
                    { "method": "email", "minutes": 60 },
                    { "method": "popup", "minutes": 120 },
                    { "method": "popup", "minutes": week },
                    { "method": "popup", "minutes": 2 * week },
                ],
            })
        );
        let stored: StoredAlerts = serde_json::from_str(body["extendedProperties"]["private"][LOCAL_ALERTS].as_str().unwrap()).unwrap();
        assert_eq!(stored.popup, vec![5, 5 * week]);
        assert!(stored.email.is_empty());
        assert_eq!(stored.at, vec!["2026-11-01T15:00:00+00:00"]);
    }

    #[test]
    fn four_weeks_still_syncs_and_a_blank_list_clears_local_alerts() {
        let body = bare(json!({ "kind": "custom", "alerts": [{ "kind": "relative", "minutes": GOOGLE_MAX_MINUTES }] }));
        assert_eq!(body["reminders"]["overrides"], json!([{ "method": "popup", "minutes": GOOGLE_MAX_MINUTES }]));
        assert_eq!(body["extendedProperties"]["private"][LOCAL_ALERTS], json!(""));

        let cleared = bare(json!({ "kind": "custom", "alerts": [] }));
        assert_eq!(cleared["reminders"], json!({ "useDefault": false, "overrides": [] }));
        assert_eq!(cleared["extendedProperties"]["private"][LOCAL_ALERTS], json!(""));

        // The older "minutes" list is still a popup override.
        let old = bare(json!({ "kind": "custom", "minutes": [10, 1440] }));
        assert_eq!(
            old["reminders"]["overrides"],
            json!([{ "method": "popup", "minutes": 10 }, { "method": "popup", "minutes": 1440 }])
        );
    }

    #[test]
    fn an_exact_time_has_to_be_a_real_timestamp() {
        let err = draft(json!({
            "title": "Standup",
            "start": "2026-11-02T09:00:00+00:00",
            "end": "2026-11-02T09:15:00+00:00",
            "allDay": false,
            "timeZone": null,
            "location": null,
            "description": null,
            "recurrence": null,
            "alerts": { "kind": "custom", "alerts": [{ "kind": "absolute", "at": "tomorrow" }] },
            "guests": null,
        }))
        .to_json();
        assert!(err.is_err());
    }

    #[test]
    fn saved_local_alerts_come_back_with_the_event() {
        let defaults = vec![Reminder { method: Some("popup".into()), minutes: Some(10) }];
        let overrides = Reminders {
            use_default: false,
            overrides: vec![
                Reminder { method: Some("popup".into()), minutes: Some(30) },
                Reminder { method: Some("email".into()), minutes: Some(60) },
            ],
        };
        let local = StoredAlerts {
            at: vec!["2026-11-01T15:00:00+00:00".into()],
            popup: vec![5],
            email: vec![15],
            ..StoredAlerts::default()
        };
        let (popup, email, at, leave) = collect_reminders(Some(&overrides), &defaults, &local);
        assert_eq!(popup, vec![30, 5]);
        assert_eq!(email, vec![60, 15]);
        assert_eq!(at, vec!["2026-11-01T15:00:00+00:00"]);
        assert!(leave.is_empty());

        // No overrides of its own: the calendar's defaults, plus anything kept locally.
        let (popup, email, at, _) = collect_reminders(None, &defaults, &local);
        assert_eq!(popup, vec![10, 5]);
        assert_eq!(email, vec![15]);
        assert_eq!(at.len(), 1);

        // A minute already in the override isn't listed twice.
        let again = StoredAlerts { popup: vec![30], ..StoredAlerts::default() };
        let (popup, _, _, _) = collect_reminders(Some(&overrides), &defaults, &again);
        assert_eq!(popup, vec![30]);
    }

    #[test]
    fn a_leave_alert_and_a_starting_address_stay_on_the_event() {
        let body = bare(json!({
            "kind": "custom",
            "alerts": [
                { "kind": "relative", "minutes": 15 },
                { "kind": "leave", "bufferMinutes": 10 },
                { "kind": "leave", "bufferMinutes": 10 },
                { "kind": "leave", "bufferMinutes": 0 },
            ],
        }));
        assert_eq!(body["reminders"]["overrides"], json!([{ "method": "popup", "minutes": 15 }]));
        let stored: StoredAlerts =
            serde_json::from_str(body["extendedProperties"]["private"][LOCAL_ALERTS].as_str().unwrap()).unwrap();
        assert_eq!(stored.leave, vec![10, 0]);

        let with_from = draft(json!({
            "title": "Dentist",
            "start": "2026-11-02T15:00:00+00:00",
            "end": "2026-11-02T16:00:00+00:00",
            "allDay": false,
            "timeZone": null,
            "location": "123 Main St",
            "description": null,
            "recurrence": null,
            "alerts": null,
            "guests": null,
            "leaveFrom": " 100 High St ",
        }))
        .to_json()
        .unwrap();
        assert_eq!(with_from["extendedProperties"]["private"][LEAVE_FROM], json!("100 High St"));

        // An empty string clears an address saved earlier. Alerts aren't touched.
        let cleared = draft(json!({
            "title": "Dentist",
            "start": "2026-11-02T15:00:00+00:00",
            "end": "2026-11-02T16:00:00+00:00",
            "allDay": false,
            "timeZone": null,
            "location": "123 Main St",
            "description": null,
            "recurrence": null,
            "alerts": null,
            "guests": null,
            "leaveFrom": "",
        }))
        .to_json()
        .unwrap();
        assert_eq!(cleared["extendedProperties"]["private"][LEAVE_FROM], json!(""));
        assert!(cleared["extendedProperties"]["private"].get(LOCAL_ALERTS).is_none());
    }

    #[test]
    fn an_event_must_end_after_it_starts() {
        let times = EventTimes {
            start: "2026-11-02".into(),
            end: "2026-11-02".into(),
            all_day: true,
            time_zone: None,
        };
        assert!(times.to_json().is_err());
    }
}
