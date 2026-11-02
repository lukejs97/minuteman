//! The agenda: one sorted list of things happening, whatever service they came
//! from: Google Calendar events and Todoist tasks. The UI (main window and the
//! future tray flyout) only ever deals with `AgendaItem`.

use std::collections::HashSet;

use chrono::{DateTime, Local, NaiveDate};
use futures::future::join_all;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::google::{self, auth::GoogleAuth};
use crate::{secrets, todoist};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Google,
    Todoist,
    /// The Mac's Calendar and Reminders apps (apple.rs).
    Apple,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Event,
    Task,
}

/// Someone invited to an event.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Attendee {
    pub name: Option<String>,
    pub email: Option<String>,
    /// "accepted", "declined", "tentative" or "needsAction".
    pub response: Option<String>,
    pub organizer: bool,
    pub is_self: bool,
}

// Deserialize: items are also saved to disk for offline use (see cache.rs).
// Fields added later have `default`, so older saved items still load.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgendaItem {
    /// Unique across sources, e.g. "google:<calendarId>:<eventId>".
    pub id: String,
    pub source: Source,
    pub kind: ItemKind,
    pub title: String,
    /// "YYYY-MM-DD" when `all_day`, otherwise an RFC 3339 timestamp.
    pub start: String,
    /// Same format as `start`. For all-day items this is the day *after* the
    /// last day (Google's convention).
    pub end: Option<String>,
    pub all_day: bool,
    pub location: Option<String>,
    /// CSS color, e.g. the calendar's color.
    pub color: Option<String>,
    /// Calendar name, or Todoist project name.
    pub list_name: String,
    /// Where to open the item in its own web app.
    pub url: Option<String>,
    /// Tasks only.
    pub completed: bool,
    /// Tasks only: due before today, and shown on today instead.
    pub overdue: bool,
    /// Tasks only: 1 (most urgent) to 4, as numbered in the Todoist app.
    pub priority: Option<u8>,
    /// Google events: the account they're in.
    #[serde(default)]
    pub account: Option<String>,
    /// The Google calendar, or Todoist project, it's in.
    #[serde(default, alias = "calendarId")]
    pub list_id: Option<String>,
    /// Its ID in its own service: the Google event, or Todoist task.
    #[serde(default, alias = "eventId")]
    pub source_id: Option<String>,
    /// For one occurrence of a repeating Google event, the whole series' ID.
    #[serde(default)]
    pub series_id: Option<String>,
    /// Items the app may change. Google events: on a calendar you can edit,
    /// organized by you (or open to changes by guests), in an account that
    /// allowed the app to edit events. Todoist tasks: ones that don't repeat
    /// (changing a repeating task's date here would end its repeat).
    #[serde(default)]
    pub editable: bool,
    /// One occurrence of a repeating event, or a repeating task.
    #[serde(default)]
    pub recurring: bool,
    /// Notes. Google's may contain simple HTML.
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub attendees: Vec<Attendee>,
    /// Video call link: Google Meet, Zoom, Teams, Webex and the like.
    #[serde(default)]
    pub conference_url: Option<String>,
    /// Popup alerts, in minutes before the start. Google's own, or (past
    /// Google's limit of 5) ones Minuteman kept on the event. See
    /// `LOCAL_ALERTS` in google/calendar.rs.
    #[serde(default)]
    pub reminders: Vec<u32>,
    /// Email alerts, in minutes before the start. Google sends these; the app
    /// doesn't also pop up.
    #[serde(default)]
    pub email_reminders: Vec<u32>,
    /// Exact instants to alert (RFC 3339). Not Google reminders: Minuteman
    /// stores them on the event and fires them itself.
    #[serde(default)]
    pub alert_at: Vec<String>,
    /// Keeps its clock time in any time zone: `start` and `end` are then that
    /// clock time here (see google/calendar.rs `FLOATING`).
    #[serde(default)]
    pub floating: bool,
    /// Google events: the event's own time zone (IANA name).
    #[serde(default)]
    pub time_zone: Option<String>,
    /// This event's own starting address, when it shouldn't use the one in
    /// Settings. Empty means that default.
    #[serde(default)]
    pub leave_from: Option<String>,
    /// Minutes before the leave-by time to alert. Empty means none. Not a
    /// Google reminder: Minuteman stores these on the event and fires them
    /// (see `LOCAL_ALERTS` in google/calendar.rs).
    #[serde(default)]
    pub leave_alerts: Vec<u32>,
    /// Google events: the event's own color ("1" to "11", see
    /// `google::calendar::event_color`), when it isn't the calendar's.
    /// `color` is already that color.
    #[serde(default)]
    pub color_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agenda {
    /// The Google accounts' email addresses.
    pub accounts: Vec<String>,
    pub items: Vec<AgendaItem>,
    pub warnings: Vec<String>,
    /// Set when there's no internet and these are saved items: when they
    /// were fetched (RFC 3339).
    pub offline_since: Option<String>,
    /// The sources that loaded (account emails, "todoist"), for the cache.
    #[serde(skip)]
    pub loaded: Vec<String>,
}

/// Longest range one request may cover. A year view needs 366 days.
const MAX_RANGE_DAYS: i64 = 400;

/// Everything from local midnight on `from` up to (not including) local
/// midnight on `to`.
pub async fn load(
    http: &reqwest::Client,
    google_auth: &GoogleAuth,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Agenda> {
    let days = (to - from).num_days();
    if !(1..=MAX_RANGE_DAYS).contains(&days) {
        return Err(AppError::InvalidInput(format!(
            "date range must be 1 to {MAX_RANGE_DAYS} days long, got {days}"
        )));
    }

    let todoist_token = secrets::get(secrets::TODOIST_TOKEN)?;
    let accounts = google_auth.accounts().await?;
    if accounts.is_empty() {
        return Err(AppError::NotSignedIn);
    }

    // Fetch from every Google account and Todoist at the same time.
    let google = join_all(accounts.iter().map(|email| async move {
        let token = google_auth.access_token(email).await?;
        let can_edit = google_auth.can_edit_events(email).await?;
        google::calendar::events_between(http, &token, email, can_edit, local_midnight(from), local_midnight(to))
            .await
    }));
    let tasks = async {
        match &todoist_token {
            Some(token) => Some(todoist::tasks_between(http, token, from, to).await),
            None => None,
        }
    };
    let (google, tasks) = tokio::join!(google, tasks);

    let mut items = Vec::new();
    let mut warnings = Vec::new();
    // A calendar shared between two of your accounts shows up in both; list
    // its events once.
    let mut seen = HashSet::new();
    let mut signed_in = Vec::new();
    let mut loaded = Vec::new();
    let mut loaded_any = false;
    let mut first_error = None;
    for (email, result) in accounts.into_iter().zip(google) {
        match result {
            Ok(events) => {
                items.extend(events.items.into_iter().filter(|item| seen.insert(item.id.clone())));
                warnings.extend(events.warnings);
                loaded.push(email.clone());
                signed_in.push(email);
                loaded_any = true;
            }
            // Its token stopped working, and it's been removed.
            Err(AppError::NotSignedIn) => {
                warnings.push(format!("{email}: Google signed this account out. Add it again under Settings → Google accounts."));
                first_error.get_or_insert(AppError::NotSignedIn);
            }
            Err(e) => {
                warnings.push(format!("{email}: {e}"));
                first_error.get_or_insert(e);
                signed_in.push(email);
            }
        }
    }
    // If one account fails, still show the others.
    if !loaded_any && let Some(e) = first_error {
        return Err(e);
    }

    match tasks {
        Some(Ok(tasks)) => {
            items.extend(tasks);
            loaded.push("todoist".into());
        }
        // A Todoist problem shouldn't hide your calendar; show it as a warning.
        Some(Err(e)) => warnings.push(format!("Todoist: {e}")),
        None => {}
    }

    #[cfg(target_os = "macos")]
    add_apple(from, to, &signed_in, &mut items, &mut warnings, &mut loaded).await;

    items.sort_by_cached_key(|item| (start_timestamp(item), !item.all_day, item.title.clone()));
    Ok(Agenda { accounts: signed_in, items, warnings, offline_since: None, loaded })
}

/// The Mac's Calendar and Reminders apps' items, if turned on in Settings.
#[cfg(target_os = "macos")]
async fn add_apple(
    from: NaiveDate,
    to: NaiveDate,
    google_accounts: &[String],
    items: &mut Vec<AgendaItem>,
    warnings: &mut Vec<String>,
    loaded: &mut Vec<String>,
) {
    use crate::apple;
    let prefs = crate::prefs::get();
    let mut all_loaded = prefs.apple_calendar || prefs.apple_reminders;
    if prefs.apple_calendar {
        match apple::events_between(local_midnight(from), local_midnight(to), google_accounts.to_vec()).await {
            Ok(events) => items.extend(events),
            Err(e) => {
                warnings.push(format!("Apple Calendar: {e}"));
                all_loaded = false;
            }
        }
    }
    if prefs.apple_reminders {
        match apple::reminders_between(from, to, google_accounts.to_vec()).await {
            Ok(reminders) => items.extend(reminders),
            Err(e) => {
                warnings.push(format!("Reminders: {e}"));
                all_loaded = false;
            }
        }
    }
    if all_loaded {
        loaded.push("apple".into());
    }
}

/// Start time as a Unix timestamp; all-day items count as starting at local
/// midnight, and sort before timed items that start at the same moment.
fn start_timestamp(item: &AgendaItem) -> i64 {
    parse_timestamp(&item.start, item.all_day).unwrap_or(i64::MAX)
}

/// When an item starts and ends, as Unix timestamps. An item without an end
/// (or ending as it starts) counts as lasting one second.
pub fn item_span(item: &AgendaItem) -> (i64, i64) {
    let start = start_timestamp(item);
    let end = item.end.as_deref().and_then(|end| parse_timestamp(end, item.all_day)).unwrap_or(start);
    (start, end.max(start.saturating_add(1)))
}

fn parse_timestamp(s: &str, all_day: bool) -> Option<i64> {
    if all_day {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| local_midnight(d).timestamp())
    } else {
        DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp())
    }
}

pub fn local_midnight(date: NaiveDate) -> DateTime<Local> {
    let midnight = date.and_hms_opt(0, 0, 0).expect("midnight is valid");
    // `earliest` handles the rare zones where a DST change skips/repeats midnight.
    midnight
        .and_local_timezone(Local)
        .earliest()
        .unwrap_or_else(|| midnight.and_utc().with_timezone(&Local))
}
