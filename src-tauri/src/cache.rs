//! Keeps the events and tasks last fetched in a file, so the app shows your
//! calendar straight away when it opens, and still shows it without internet.
//! The file is in the app's cache folder (on macOS,
//! ~/Library/Caches/com.lukesassa.calendar/agenda.json); losing it only means
//! fetching again.

use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{Local, NaiveDate, TimeDelta};
use serde::{Deserialize, Serialize};

use crate::agenda::{AgendaItem, Source, item_span, local_midnight};

/// Items further than this from today are dropped, to keep the file small.
const KEEP_DAYS: i64 = 400;

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Saved {
    /// When the newest items were fetched (RFC 3339).
    saved_at: Option<String>,
    items: Vec<AgendaItem>,
}

pub struct AgendaCache {
    path: Option<PathBuf>,
    saved: Mutex<Saved>,
}

/// Which source an item came from: its Google account, "todoist" or "apple".
pub fn source_key(item: &AgendaItem) -> &str {
    match (item.source, &item.account) {
        (Source::Google, Some(account)) => account,
        (Source::Apple, _) => "apple",
        _ => "todoist",
    }
}

impl AgendaCache {
    /// Reads the file at `path`. A missing or unreadable file means an empty cache.
    pub fn load(path: Option<PathBuf>) -> Self {
        let saved = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        AgendaCache { path, saved: Mutex::new(saved) }
    }

    /// Replaces what's saved between `from` and `to` (local dates, `to`
    /// exclusive) for each source in `sources` with `items`. Sources that
    /// failed to load this time keep their saved items.
    pub fn store(&self, from: NaiveDate, to: NaiveDate, sources: &[String], items: &[AgendaItem]) {
        let (start, end) = (local_midnight(from).timestamp(), local_midnight(to).timestamp());
        let now = Local::now();
        let (keep_from, keep_to) = (
            (now - TimeDelta::days(KEEP_DAYS)).timestamp(),
            (now + TimeDelta::days(KEEP_DAYS)).timestamp(),
        );
        let mut saved = self.saved.lock().expect("not poisoned");
        saved.items.retain(|item| {
            let (s, e) = item_span(item);
            let replaced = s < end && e > start && sources.iter().any(|k| k == source_key(item));
            !replaced && e > keep_from && s < keep_to
        });
        saved.items.extend(items.iter().cloned());
        saved.saved_at = Some(now.to_rfc3339());
        self.write(&saved);
    }

    /// The saved items between `from` and `to`, and when they were saved.
    /// `None` if nothing has ever been saved.
    pub fn between(&self, from: NaiveDate, to: NaiveDate) -> Option<(Vec<AgendaItem>, String)> {
        let (start, end) = (local_midnight(from).timestamp(), local_midnight(to).timestamp());
        let saved = self.saved.lock().expect("not poisoned");
        let saved_at = saved.saved_at.clone()?;
        let items = saved
            .items
            .iter()
            .filter(|item| {
                let (s, e) = item_span(item);
                s < end && e > start && !hidden(item)
            })
            .cloned()
            .collect();
        Some((items, saved_at))
    }

    /// Every saved item, e.g. to search without internet.
    pub fn all(&self) -> Vec<AgendaItem> {
        self.saved.lock().expect("not poisoned").items.iter().filter(|item| !hidden(item)).cloned().collect()
    }

    /// Forgets one source's items: a removed account, or Todoist when disconnected.
    pub fn forget(&self, source: &str) {
        let mut saved = self.saved.lock().expect("not poisoned");
        saved.items.retain(|item| source_key(item) != source);
        if saved.items.is_empty() {
            saved.saved_at = None;
        }
        self.write(&saved);
    }

    /// Best effort: the cache is only a convenience, so a failed write is ignored.
    fn write(&self, saved: &Saved) {
        let Some(path) = &self.path else { return };
        let Ok(json) = serde_json::to_vec(saved) else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Write a temporary file and rename it, so a crash mid-write can't
        // leave a half-written cache.
        let temporary = path.with_extension("json.tmp");
        if std::fs::write(&temporary, json).is_ok() {
            let _ = std::fs::rename(&temporary, path);
        }
    }
}

/// From a Google calendar hidden in Settings since it was saved.
fn hidden(item: &AgendaItem) -> bool {
    match (&item.source, &item.account, &item.list_id) {
        (Source::Google, Some(account), Some(calendar)) => !crate::prefs::google_calendar_shown(account, calendar),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agenda::ItemKind;

    fn event(account: &str, id: &str, day: &str) -> AgendaItem {
        AgendaItem {
            id: id.into(),
            source: Source::Google,
            kind: ItemKind::Event,
            title: id.into(),
            start: format!("{day}T10:00:00+00:00"),
            end: Some(format!("{day}T11:00:00+00:00")),
            all_day: false,
            location: None,
            color: None,
            list_name: "Cal".into(),
            url: None,
            completed: false,
            overdue: false,
            priority: None,
            account: Some(account.into()),
            list_id: None,
            source_id: None,
            series_id: None,
            editable: false,
            recurring: false,
            description: None,
            attendees: Vec::new(),
            conference_url: None,
            reminders: Vec::new(),
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

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn ids(items: &[AgendaItem]) -> Vec<&str> {
        let mut ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        ids.sort();
        ids
    }

    #[test]
    fn nothing_saved_yet() {
        let cache = AgendaCache::load(None);
        assert!(cache.between(day("2026-11-01"), day("2026-11-08")).is_none());
    }

    #[test]
    fn a_new_fetch_replaces_only_its_range_and_sources() {
        let today = Local::now().date_naive();
        let d = |n: i64| (today + TimeDelta::days(n)).to_string();
        let cache = AgendaCache::load(None);
        let a = "a@example.com".to_string();
        let b = "b@example.com".to_string();
        cache.store(
            today,
            today + TimeDelta::days(7),
            &[a.clone(), b.clone()],
            &[event(&a, "a-old", &d(1)), event(&b, "b-old", &d(2)), event(&a, "a-later", &d(10))],
        );

        // Next fetch of the same week: account a loaded (its event moved), b failed.
        cache.store(today, today + TimeDelta::days(7), std::slice::from_ref(&a), &[event(&a, "a-new", &d(3))]);

        let (week, _) = cache.between(today, today + TimeDelta::days(7)).unwrap();
        assert_eq!(ids(&week), ["a-new", "b-old"]);
        let (later, _) = cache.between(today + TimeDelta::days(7), today + TimeDelta::days(14)).unwrap();
        assert_eq!(ids(&later), ["a-later"]);
    }

    #[test]
    fn forgetting_a_source_removes_its_items() {
        let today = Local::now().date_naive();
        let cache = AgendaCache::load(None);
        let a = "a@example.com".to_string();
        let b = "b@example.com".to_string();
        let tomorrow = (today + TimeDelta::days(1)).to_string();
        cache.store(
            today,
            today + TimeDelta::days(7),
            &[a.clone(), b.clone()],
            &[event(&a, "a1", &tomorrow), event(&b, "b1", &tomorrow)],
        );
        cache.forget(&a);
        assert_eq!(ids(&cache.all()), ["b1"]);
    }

    #[test]
    fn items_saved_before_exact_alerts_still_load() {
        let json = r#"{
            "savedAt": "2026-10-01T00:00:00+00:00",
            "items": [{
                "id": "google:cal:1",
                "source": "google",
                "kind": "event",
                "title": "Standup",
                "start": "2026-11-02T15:00:00+00:00",
                "end": null,
                "allDay": false,
                "location": null,
                "color": null,
                "listName": "Work",
                "url": null,
                "completed": false,
                "overdue": false,
                "priority": null,
                "reminders": [10, 1440]
            }]
        }"#;
        let saved: Saved = serde_json::from_str(json).unwrap();
        assert_eq!(saved.items[0].reminders, vec![10, 1440]);
        assert!(saved.items[0].email_reminders.is_empty());
        assert!(saved.items[0].alert_at.is_empty());
    }
}
