//! Desktop only: pop-up alerts before events start, at the reminder times set
//! on each event in Google Calendar (or its calendar's defaults), and at any
//! exact time Minuteman stored on the event. They come from this side, not the
//! web page, so they keep coming while the app sits in the menu bar with its
//! window closed. The same loop keeps the next event's name beside the menu
//! bar icon up to date.

use std::collections::HashSet;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, TimeDelta};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;

use crate::AppState;
use crate::agenda::{self, AgendaItem, ItemKind};
use crate::cache::AgendaCache;
use crate::{desktop, prefs};

const CHECK_EVERY: Duration = Duration::from_secs(30);
const RELOAD_EVERY: TimeDelta = TimeDelta::minutes(5);
/// After Demo mode, up to this many alerts it held come one by one; more
/// come as one notice.
const MISSED_SHOWN_ONE_BY_ONE: usize = 5;

/// Alerts more than this late are skipped, so waking a laptop that slept
/// through the morning doesn't deliver a pile of them at once.
const LATEST: TimeDelta = TimeDelta::minutes(2);

/// Set when events change in the app, to reload before the next check.
static STALE: AtomicBool = AtomicBool::new(false);
/// Wakes the loop early, e.g. after a settings change.
static WAKE: OnceLock<Notify> = OnceLock::new();
/// Demo mode is on (Settings → Demo mode): the menu bar shows the demo's
/// next event (`show_demo`), and real alerts wait until it's off, then come
/// (marked as from Demo mode).
static DEMO: AtomicBool = AtomicBool::new(false);

/// Demo mode on, with its items and its clock (April 1775): the menu bar shows
/// the demo's next event. Off: back to the real calendar, now.
pub fn show_demo(app: &AppHandle, on: bool, items: &[AgendaItem], now: Option<DateTime<Local>>) {
    DEMO.store(on, Ordering::Relaxed);
    if on {
        let next = if prefs::get().menu_bar_next { menu_bar_text(items, now.unwrap_or_else(Local::now)) } else { None };
        desktop::set_menu_bar_text(app, next);
    } else {
        refresh();
    }
}

fn wake() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

/// Reloads and checks again now, e.g. after adding or moving an event.
pub fn refresh() {
    STALE.store(true, Ordering::Relaxed);
    wake().notify_one();
}

/// Checks for due alerts every 30 seconds for as long as the app runs.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Today's and tomorrow's items.
        let mut upcoming: Vec<AgendaItem> = Vec::new();
        let mut loaded_at: Option<DateTime<Local>> = None;
        let mut last_check = Local::now();
        // Alerts already shown: item, its start, and minutes before.
        let mut sent = HashSet::new();
        // When Demo mode began, while it's on: its alerts come once it's off.
        let mut demo_since: Option<DateTime<Local>> = None;
        loop {
            let now = Local::now();
            let stale = STALE.swap(false, Ordering::Relaxed);
            if (stale || loaded_at.is_none_or(|at| now - at > RELOAD_EVERY))
                && let Some(items) = load(&app).await
            {
                upcoming = items;
                loaded_at = Some(now);
            }
            // Demo mode: nothing real is shown meanwhile. What comes due
            // waits, and comes once it's off (`last_check` stays put).
            if DEMO.load(Ordering::Relaxed) {
                demo_since.get_or_insert(last_check);
                tokio::select! {
                    _ = tokio::time::sleep(CHECK_EVERY) => {}
                    _ = wake().notified() => {}
                }
                continue;
            }
            let from = match demo_since.take() {
                // Just out of Demo mode: everything since it began (up to a
                // day, after a laptop slept through it).
                Some(since) => since.max(now - TimeDelta::hours(24)),
                None => last_check.max(now - LATEST),
            };
            let missed_in_demo = from < now - LATEST;
            last_check = now;
            let alerts: Vec<_> = due(&upcoming, from, now).into_iter().filter(|(key, ..)| sent.insert(key.clone())).collect();
            if missed_in_demo && alerts.len() > MISSED_SHOWN_ONE_BY_ONE {
                // Many: one notice for them all, rather than a pile.
                let titles: Vec<&str> = alerts.iter().map(|(_, title, _)| title.as_str()).collect();
                let _ = app
                    .notification()
                    .builder()
                    .title(format!("{} alerts during Demo mode", alerts.len()))
                    .body(titles.join(" · "))
                    .show();
            } else {
                for (_, title, body) in alerts {
                    let body = if missed_in_demo { format!("During Demo mode · {body}") } else { body };
                    let _ = app.notification().builder().title(title).body(body).show();
                }
            }
            let prefs = prefs::get();
            time_to_leave(&app, &upcoming, now, &mut sent).await;
            let next = if prefs.menu_bar_next { menu_bar_text(&upcoming, now) } else { None };
            desktop::set_menu_bar_text(&app, next);
            tokio::select! {
                _ = tokio::time::sleep(CHECK_EVERY) => {}
                _ = wake().notified() => {}
            }
        }
    });
}

/// Time to leave. An event's own "before leaving" alerts fire at each buffer.
/// With none, the Settings switch still alerts (5 minutes early) for a real
/// place in the next 3 hours, as it used to. The drive comes from the
/// leave-from address via Routes; on a Mac with no address, from Apple Maps.
async fn time_to_leave(app: &AppHandle, items: &[AgendaItem], now: DateTime<Local>, sent: &mut HashSet<String>) {
    use chrono::Utc;

    let prefs = prefs::get();
    let state = app.state::<crate::AppState>();
    let has_key = crate::leave::api_key().is_some();
    let allow_device = prefs.uses_device_location();
    for item in items.iter().filter(|item| item.kind == ItemKind::Event && !item.all_day) {
        let Some(place) = item.location.as_deref().filter(|place| crate::leave::is_physical(place)) else {
            continue;
        };
        let Ok(start) = DateTime::parse_from_rfc3339(&item.start) else { continue };
        let start = start.with_timezone(&Local);
        if start <= now {
            continue;
        }
        let buffers = crate::leave::alert_buffers(&item.leave_alerts, prefs.time_to_leave, start - now);
        if buffers.is_empty() {
            continue;
        }
        let here = if prefs.leave_from_here { here_now(app).await } else { None };
        let origin = crate::leave::pick_origin(item.leave_from.as_deref(), here.as_deref(), &prefs.leave_from);
        let arrive = start.with_timezone(&Utc);
        let answer = crate::leave::resolve(
            &state.http,
            place,
            arrive,
            now.with_timezone(&Utc),
            origin.as_deref(),
            has_key,
            allow_device,
            || crate::device_drive(app, place, start),
        )
        .await;
        // The automatic alert skips a drive so short you're already there.
        // One the event asked for still fires. A drive too long to be right
        // (an address matched in the wrong town) never alerts.
        if answer.status == crate::leave::TravelStatus::Implausible {
            continue;
        }
        let Some(minutes) =
            answer.minutes.filter(|minutes| !item.leave_alerts.is_empty() || *minutes >= crate::leave::MIN_LEGACY_DRIVE)
        else {
            continue;
        };
        for notice in crate::leave::notices(&item.id, &item.start, &item.title, place, start, minutes, &buffers, now, sent)
        {
            sent.insert(notice.key);
            let _ = app.notification().builder().title(notice.title).body(notice.body).show();
        }
    }
}

/// How far ahead to load. Google's longest reminder is 4 weeks, and an exact
/// time can fall well before the event, so the loop has to be holding the
/// event when the alert comes due. 120 days covers a quarter: an exact alert
/// on an event further out than that isn't seen until the event itself is.
const LOOK_AHEAD_DAYS: i64 = 120;

/// Today's items and the ones far enough ahead that a reminder can come due
/// now: fetched if possible (and saved for offline use), otherwise as saved
/// last time. `None` if neither works, e.g. signed out.
/// Where the Mac or PC is, for drives that start from there (Settings →
/// Leave from), asked at most every 5 minutes. `None` when location is off:
/// alerts then use the address in Settings.
async fn here_now(app: &AppHandle) -> Option<String> {
    use std::sync::Mutex;
    use std::time::Instant;
    static LAST: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);
    if let Some((at, spot)) = LAST.lock().expect("not poisoned").clone()
        && at.elapsed() < Duration::from_secs(5 * 60)
    {
        return spot;
    }
    let spot = crate::device_location(app)
        .await
        .map(|(latitude, longitude)| crate::leave::spot_origin(latitude, longitude));
    *LAST.lock().expect("not poisoned") = Some((Instant::now(), spot.clone()));
    spot
}

async fn load(app: &AppHandle) -> Option<Vec<AgendaItem>> {
    let (state, cache) = (app.state::<AppState>(), app.state::<AgendaCache>());
    let today = Local::now().date_naive();
    let to = today + TimeDelta::days(LOOK_AHEAD_DAYS);
    match agenda::load(&state.http, &state.google_auth, today, to).await {
        Ok(agenda) => {
            cache.store(today, to, &agenda.loaded, &agenda.items);
            Some(agenda.items)
        }
        Err(_) => cache.between(today, to).map(|(items, _)| items),
    }
}

/// The alerts due after `from`, up to and including `now`: a key to show each
/// once, the title, and the text.
fn due(items: &[AgendaItem], from: DateTime<Local>, now: DateTime<Local>) -> Vec<(String, String, String)> {
    let mut alerts = Vec::new();
    for item in items {
        if item.kind != ItemKind::Event {
            continue;
        }
        let Some(start) = event_start(item) else { continue };
        for &minutes in &item.reminders {
            let Some(at) = start.checked_sub_signed(TimeDelta::minutes(i64::from(minutes))) else { continue };
            if at > from && at <= now {
                let key = format!("{}|{}|{minutes}", item.id, item.start);
                alerts.push((key, item.title.clone(), alert_text(item, start, minutes)));
            }
        }
        for at_str in &item.alert_at {
            let Ok(at) = DateTime::parse_from_rfc3339(at_str) else { continue };
            let at = at.with_timezone(&Local);
            if at > from && at <= now {
                // One exact time on a repeating series is the same instant for
                // every occurrence, so it should notify once.
                let owner = item.series_id.as_deref().unwrap_or(&item.id);
                let key = format!("at|{owner}|{at_str}");
                let lead = (start - at).num_minutes();
                let minutes = if lead < 0 { 0 } else { lead as u32 };
                alerts.push((key, item.title.clone(), alert_text(item, start, minutes)));
            }
        }
    }
    alerts
}

/// When an event starts. An all-day event starts at local midnight on its first day.
fn event_start(item: &AgendaItem) -> Option<DateTime<Local>> {
    if item.all_day {
        let date = NaiveDate::parse_from_str(&item.start, "%Y-%m-%d").ok()?;
        Some(crate::agenda::local_midnight(date))
    } else {
        Some(DateTime::parse_from_rfc3339(&item.start).ok()?.with_timezone(&Local))
    }
}

/// Beside the menu bar icon: what's next ("Standup in 12 min", "Lunch at
/// 1:00 PM", "○ Pay rent in 5 min" for a task), or, while an event is on and
/// nothing else starts before it ends, that one ("Work until 5:00 PM").
/// `None` when nothing's on or coming up in the next 12 hours.
///
/// What starts next wins over what's on: you know you're at work, but not
/// that a call's coming up during it.
fn menu_bar_text(items: &[AgendaItem], now: DateTime<Local>) -> Option<String> {
    let times = |item: &AgendaItem| {
        let start = DateTime::parse_from_rfc3339(&item.start).ok()?.with_timezone(&Local);
        let end = item.end.as_deref().and_then(|end| DateTime::parse_from_rfc3339(end).ok());
        Some((start, end.map_or(start, |end| end.with_timezone(&Local))))
    };
    // Events and tasks at a time of day (not all-day ones, or tasks done).
    let timed = items
        .iter()
        .filter(|item| !item.all_day && !item.completed)
        .filter_map(|item| Some((item, times(item)?)));
    let next = timed
        .clone()
        .filter(|(_, (start, _))| *start > now && *start - now <= TimeDelta::hours(12))
        .min_by_key(|(_, (start, _))| *start);
    let ongoing = timed
        .filter(|(item, (start, end))| item.kind == ItemKind::Event && *start <= now && *end > now)
        .min_by_key(|(_, (_, end))| *end);

    let clock = |t: DateTime<Local>| t.format("%-I:%M %p").to_string();
    let name = |item: &AgendaItem| match item.kind {
        ItemKind::Task => format!("○ {}", short(&item.title)),
        ItemKind::Event => short(&item.title),
    };
    match (next, ongoing) {
        // On now, and nothing else starts before it ends: this one.
        (next, Some((item, (_, end)))) if next.is_none_or(|(_, (start, _))| start >= end) => {
            Some(format!("{} until {}", name(item), clock(end)))
        }
        (Some((item, (start, _))), _) => {
            // Rounded up: "in 1 min" until it starts, never "in 0 min".
            let minutes = ((start - now).num_seconds() + 59) / 60;
            Some(match minutes {
                0 => format!("{} now", name(item)),
                1..60 => format!("{} in {minutes} min", name(item)),
                _ => format!("{} at {}", name(item), clock(start)),
            })
        }
        _ => None,
    }
}

/// A title short enough for the menu bar.
fn short(title: &str) -> String {
    const MAX: usize = 22;
    let title = title.trim();
    if title.chars().count() <= MAX {
        return title.to_string();
    }
    let cut: String = title.chars().take(MAX - 1).collect();
    format!("{}…", cut.trim_end())
}

/// "In 10 min · 2:00 PM · Room 4", or "Now · 2:00 PM". An all-day event is
/// named by its day ("In 1 day · Fri, Nov 6") rather than midnight.
fn alert_text(item: &AgendaItem, start: DateTime<Local>, minutes: u32) -> String {
    let when = match minutes {
        0 => "Now".to_string(),
        1..60 => format!("In {minutes} min"),
        _ => format!("In {}", format_hours(minutes)),
    };
    let time = if item.all_day {
        start.format("%a, %b %-d").to_string()
    } else {
        start.format("%-I:%M %p").to_string()
    };
    [Some(when), Some(time), item.location.clone()].into_iter().flatten().collect::<Vec<_>>().join(" · ")
}

fn format_hours(minutes: u32) -> String {
    const WEEK: u32 = 7 * 24 * 60;
    const DAY: u32 = 24 * 60;
    if minutes >= WEEK && minutes.is_multiple_of(WEEK) {
        let weeks = minutes / WEEK;
        return if weeks == 1 { "1 week".into() } else { format!("{weeks} weeks") };
    }
    if minutes.is_multiple_of(DAY) {
        return if minutes == DAY { "1 day".into() } else { format!("{} days", minutes / DAY) };
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest == 0 { format!("{hours} h") } else { format!("{hours} h {rest} min") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agenda::Source;

    fn event(start: DateTime<Local>, reminders: Vec<u32>) -> AgendaItem {
        AgendaItem {
            id: "google:cal:1".into(),
            source: Source::Google,
            kind: ItemKind::Event,
            title: "Standup".into(),
            start: start.to_rfc3339(),
            end: None,
            all_day: false,
            location: Some("Room 4".into()),
            color: None,
            list_name: "Work".into(),
            url: None,
            completed: false,
            overdue: false,
            priority: None,
            account: None,
            list_id: None,
            source_id: None,
            series_id: None,
            editable: false,
            recurring: false,
            description: None,
            attendees: Vec::new(),
            conference_url: None,
            reminders,
            email_reminders: Vec::new(),
            alert_at: Vec::new(),
            floating: false,
            time_zone: None,
            leave_from: None,
            leave_alerts: Vec::new(),
            color_id: None,
            attachments: Vec::new(),
            repeat: None,
        }
    }

    #[test]
    fn alerts_fall_due_once_in_their_window() {
        let now = Local::now();
        let items = [event(now + TimeDelta::minutes(10), vec![10, 30, 0])];
        let alerts = due(&items, now - TimeDelta::seconds(30), now);
        assert_eq!(alerts.len(), 1);
        assert!(alerts[0].2.starts_with("In 10 min · "));
        assert!(alerts[0].2.ends_with(" · Room 4"));
        // The 30-minute one was due 20 minutes ago, before this window.
        assert!(due(&items, now, now + TimeDelta::seconds(30)).is_empty());
    }

    #[test]
    fn the_menu_bar_shows_whats_next_or_on_now() {
        let now = Local::now();
        let at = |minutes: i64| now + TimeDelta::minutes(minutes);
        let event = |title: &str, start: i64, end: i64| AgendaItem {
            title: title.into(),
            end: Some(at(end).to_rfc3339()),
            ..event(at(start), vec![])
        };
        assert_eq!(menu_bar_text(&[event("Standup", 12, 27)], now).unwrap(), "Standup in 12 min");
        assert!(menu_bar_text(&[event("Lunch", 90, 150)], now).unwrap().starts_with("Lunch at "));
        // On now, and the next one starts after it ends: the one that's on.
        let busy = [event("Workshop", -30, 60), event("Lunch", 90, 150)];
        assert!(menu_bar_text(&busy, now).unwrap().starts_with("Workshop until "));
        // ...but one starting before it ends takes over.
        let soon = [event("Workshop", -30, 60), event("Call with a very long name indeed", 10, 40)];
        assert_eq!(menu_bar_text(&soon, now).unwrap(), "Call with a very long… in 10 min");
        // Tasks at a time count too, marked as tasks; done ones don't.
        let task = |title: &str, start: i64, completed: bool| AgendaItem {
            kind: ItemKind::Task,
            end: None,
            completed,
            ..event(title, start, start)
        };
        let work = [event("Work", -60, 480), task("Test", 120, false)];
        assert!(menu_bar_text(&work, now).unwrap().starts_with("○ Test at "));
        let done = [event("Work", -60, 480), task("Test", 120, true)];
        assert!(menu_bar_text(&done, now).unwrap().starts_with("Work until "));
        assert!(menu_bar_text(&[event("Tomorrow", 60 * 20, 60 * 21)], now).is_none());
    }

    #[test]
    fn longer_alerts_read_in_hours_and_days() {
        assert_eq!(format_hours(60), "1 h");
        assert_eq!(format_hours(90), "1 h 30 min");
        assert_eq!(format_hours(24 * 60), "1 day");
        assert_eq!(format_hours(2 * 24 * 60), "2 days");
        assert_eq!(format_hours(7 * 24 * 60), "1 week");
        assert_eq!(format_hours(2 * 7 * 24 * 60), "2 weeks");
    }

    #[test]
    fn several_alerts_and_an_exact_time_each_fire_once() {
        let now = Local::now();
        let start = now;
        let exact = (now - TimeDelta::seconds(10)).to_rfc3339();
        let mut item = event(start, vec![0, 1]);
        item.alert_at = vec![exact.clone()];
        let alerts = due(std::slice::from_ref(&item), now - TimeDelta::seconds(90), now);
        assert_eq!(alerts.len(), 3);
        // The same exact time on two occurrences of one series is one alert.
        let other = AgendaItem { id: "google:cal:2".into(), series_id: Some("series".into()), ..item.clone() };
        item.series_id = Some("series".into());
        let both = due(&[item, other], now - TimeDelta::seconds(90), now);
        let exact_keys: Vec<_> = both.iter().filter(|(key, _, _)| key.starts_with("at|")).map(|(key, _, _)| key.clone()).collect();
        assert_eq!(exact_keys.len(), 2);
        assert_eq!(exact_keys[0], exact_keys[1]);
        // Ten minutes ago is outside this window.
        let mut late = event(now, vec![]);
        late.alert_at = vec![(now - TimeDelta::minutes(10)).to_rfc3339()];
        assert!(due(&[late], now - TimeDelta::seconds(30), now).is_empty());
    }

    #[test]
    fn an_all_day_event_alerts_at_its_midnight() {
        let midnight = crate::agenda::local_midnight(Local::now().date_naive());
        let now = midnight + TimeDelta::seconds(20);
        let mut item = event(midnight, vec![0]);
        item.all_day = true;
        item.start = midnight.date_naive().to_string();
        item.location = None;
        let alerts = due(std::slice::from_ref(&item), midnight - TimeDelta::seconds(1), now);
        assert_eq!(alerts.len(), 1);
        assert!(alerts[0].2.starts_with("Now · "));
        assert!(!alerts[0].2.contains("AM") && !alerts[0].2.contains("PM"));
    }
}
