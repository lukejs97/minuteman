//! Mac only: events from the Calendar app and reminders from the Reminders
//! app, through EventKit (the same store those apps use, so iCloud, Exchange
//! and anything else added on the Mac). Read-only for now, except ticking
//! reminders off.
//!
//! Every EventKit call happens on one background thread that owns the
//! `EKEventStore` (it isn't meant to be shared between threads); `run` hands
//! it work and waits for the answer.

use std::collections::BTreeMap;
use std::ptr::NonNull;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use block2::RcBlock;
use chrono::{DateTime, Local, NaiveDate, TimeDelta, TimeZone};
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{Bool, NSObjectProtocol};
use objc2::sel;
use objc2_app_kit::NSColorSpace;
use objc2_event_kit::{
    EKAuthorizationStatus, EKCalendar, EKCalendarItem, EKEntityType, EKEvent, EKEventStore, EKReminder,
};
use objc2_foundation::{NSArray, NSCalendar, NSDate, NSDateComponentUndefined, NSError};
use serde::{Deserialize, Serialize};

use crate::agenda::{AgendaItem, ItemKind, Source};
use crate::error::{AppError, Result};
use crate::prefs;

/// Item ID prefixes: events carry their start too, as a repeating event's
/// occurrences share one identifier.
const EVENT_PREFIX: &str = "apple:";
const REMINDER_PREFIX: &str = "apple-reminder:";

type Job = Box<dyn FnOnce(&EKEventStore) + Send>;

static WORKER: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();

/// Runs `f` on the EventKit thread and waits for its answer.
async fn run<T: Send + 'static>(f: impl FnOnce(&EKEventStore) -> T + Send + 'static) -> Result<T> {
    let sender = WORKER
        .get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("eventkit".into())
                .spawn(move || {
                    let store = unsafe { EKEventStore::new() };
                    for job in rx {
                        autoreleasepool(|_| job(&store));
                    }
                })
                .expect("can start a thread");
            Mutex::new(tx)
        })
        .lock()
        .expect("not poisoned")
        .clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    sender
        .send(Box::new(move |store| {
            let _ = tx.send(f(store));
        }))
        .map_err(|_| stopped())?;
    rx.await.map_err(|_| stopped())
}

fn stopped() -> AppError {
    AppError::Config("the Mac's calendar store stopped responding".into())
}

/// Whether Minuteman may read the Calendar or Reminders app's data.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    /// Not asked yet: asking shows macOS's permission prompt.
    NotAsked,
    Granted,
    /// Turned off (System Settings → Privacy & Security), or limited.
    Denied,
}

fn access(kind: EKEntityType) -> Access {
    match unsafe { EKEventStore::authorizationStatusForEntityType(kind) } {
        EKAuthorizationStatus::NotDetermined => Access::NotAsked,
        EKAuthorizationStatus::FullAccess => Access::Granted,
        _ => Access::Denied,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub calendar: Access,
    pub reminders: Access,
}

pub fn status() -> Status {
    Status { calendar: access(EKEntityType::Event), reminders: access(EKEntityType::Reminder) }
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Calendar,
    Reminders,
}

/// Asks macOS for access (it shows its own prompt the first time); resolves
/// once you've answered.
pub async fn request_access(kind: Kind) -> Result<Access> {
    run(move |store| {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(Some(tx));
        let done = RcBlock::new(move |_granted: Bool, _error: *mut NSError| {
            if let Some(tx) = tx.lock().expect("not poisoned").take() {
                let _ = tx.send(());
            }
        });
        let done = RcBlock::as_ptr(&done);
        unsafe {
            // macOS 14 split access in two; older versions have one request.
            let (entity, full) = match kind {
                Kind::Calendar => (EKEntityType::Event, sel!(requestFullAccessToEventsWithCompletion:)),
                Kind::Reminders => (EKEntityType::Reminder, sel!(requestFullAccessToRemindersWithCompletion:)),
            };
            if store.respondsToSelector(full) {
                match kind {
                    Kind::Calendar => store.requestFullAccessToEventsWithCompletion(done),
                    Kind::Reminders => store.requestFullAccessToRemindersWithCompletion(done),
                }
            } else {
                #[allow(deprecated)]
                store.requestAccessToEntityType_completion(entity, done);
            }
        }
        // Waits for your answer to the prompt (or at once, if asked before).
        let _ = rx.recv_timeout(Duration::from_secs(600));
        // The store only sees calendars granted after it was made; refresh it.
        unsafe { store.reset() };
        match kind {
            Kind::Calendar => access(EKEntityType::Event),
            Kind::Reminders => access(EKEntityType::Reminder),
        }
    })
    .await
}

/// A calendar or reminder list, for choosing which to show in Settings.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub id: String,
    pub title: String,
    /// Its account, e.g. "iCloud", "On My Mac", an email address.
    pub account: String,
    pub color: String,
    pub reminders: bool,
    pub shown: bool,
}

/// Every Apple calendar and reminder list Minuteman may read.
pub async fn calendars(google_accounts: Vec<String>) -> Result<Vec<CalendarInfo>> {
    let choices = prefs::get().apple_calendars_shown;
    run(move |store| {
        let mut list = Vec::new();
        for (entity, reminders) in [(EKEntityType::Event, false), (EKEntityType::Reminder, true)] {
            if access(entity) != Access::Granted {
                continue;
            }
            for calendar in unsafe { store.calendarsForEntityType(entity) }.iter() {
                let account = account_name(&calendar);
                let id = unsafe { calendar.calendarIdentifier() }.to_string();
                list.push(CalendarInfo {
                    shown: is_shown(&choices, &id, &account, &google_accounts),
                    title: unsafe { calendar.title() }.to_string(),
                    color: color(&calendar),
                    account,
                    reminders,
                    id,
                });
            }
        }
        list
    })
    .await
}

fn account_name(calendar: &EKCalendar) -> String {
    unsafe { calendar.source() }.map(|s| unsafe { s.title() }.to_string()).unwrap_or_default()
}

/// Shown unless chosen otherwise, or it's from a Google account (whose events
/// Minuteman already gets from Google; showing both would double them).
fn is_shown(choices: &BTreeMap<String, bool>, id: &str, account: &str, google_accounts: &[String]) -> bool {
    if let Some(&shown) = choices.get(id) {
        return shown;
    }
    let account = account.to_lowercase();
    let from_google = account.contains("google")
        || account.ends_with("@gmail.com")
        || google_accounts.iter().any(|email| email.eq_ignore_ascii_case(&account));
    !from_google
}

/// The calendar's colour as "#rrggbb".
fn color(calendar: &EKCalendar) -> String {
    let color = unsafe { calendar.color() };
    let Some(rgb) = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace()) else {
        return "#8e8e93".into();
    };
    let byte = |c: f64| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", byte(rgb.redComponent()), byte(rgb.greenComponent()), byte(rgb.blueComponent()))
}

/// The shown calendars (or reminder lists) of one kind, or `None` if there are none.
fn shown_calendars(
    store: &EKEventStore,
    entity: EKEntityType,
    google_accounts: &[String],
) -> Option<Retained<NSArray<EKCalendar>>> {
    let choices = prefs::get().apple_calendars_shown;
    let shown: Vec<Retained<EKCalendar>> = unsafe { store.calendarsForEntityType(entity) }
        .iter()
        .filter(|c| {
            let id = unsafe { c.calendarIdentifier() }.to_string();
            is_shown(&choices, &id, &account_name(c), google_accounts)
        })
        .collect();
    (!shown.is_empty()).then(|| NSArray::from_retained_slice(&shown))
}

fn ns_date(time: DateTime<Local>) -> Retained<NSDate> {
    NSDate::dateWithTimeIntervalSince1970(time.timestamp() as f64)
}

fn local(date: &NSDate) -> DateTime<Local> {
    let seconds = date.timeIntervalSince1970();
    Local.timestamp_opt(seconds.floor() as i64, 0).single().unwrap_or_else(Local::now)
}

/// Events in the Calendar app's shown calendars from `from` to `to`.
pub async fn events_between(
    from: DateTime<Local>,
    to: DateTime<Local>,
    google_accounts: Vec<String>,
) -> Result<Vec<AgendaItem>> {
    run(move |store| {
        if access(EKEntityType::Event) != Access::Granted {
            return Vec::new();
        }
        let Some(calendars) = shown_calendars(store, EKEntityType::Event, &google_accounts) else {
            return Vec::new();
        };
        let events = unsafe {
            let predicate =
                store.predicateForEventsWithStartDate_endDate_calendars(&ns_date(from), &ns_date(to), Some(&calendars));
            store.eventsMatchingPredicate(&predicate)
        };
        events.iter().map(|event| event_item(&event)).collect()
    })
    .await
}

fn event_item(event: &EKEvent) -> AgendaItem {
    let (start, end) = unsafe { (local(&event.startDate()), local(&event.endDate())) };
    let all_day = unsafe { event.isAllDay() };
    let (start_text, end_text) = if all_day {
        // EventKit ends an all-day event at 23:59:59 on its last day; the app
        // (like Google) uses the day after.
        let last = if end.time() == chrono::NaiveTime::MIN { end.date_naive() } else { end.date_naive() + TimeDelta::days(1) };
        (start.date_naive().to_string(), last.max(start.date_naive() + TimeDelta::days(1)).to_string())
    } else {
        (start.to_rfc3339(), end.to_rfc3339())
    };
    let item: &EKCalendarItem = event;
    let alarms = apple_alarms(item);
    let identifier = unsafe { item.calendarItemIdentifier() }.to_string();
    let calendar = unsafe { item.calendar() };
    let notes = unsafe { item.notes() }.map(|n| n.to_string());
    let location = unsafe { item.location() }.map(|l| l.to_string()).filter(|l| !l.trim().is_empty());
    AgendaItem {
        id: format!("{EVENT_PREFIX}{identifier}:{}", start.timestamp()),
        source: Source::Apple,
        kind: ItemKind::Event,
        title: unsafe { item.title() }.to_string(),
        start: start_text,
        end: Some(end_text),
        all_day,
        location: location.clone(),
        color: calendar.as_deref().map(color),
        list_name: calendar.as_deref().map(|c| unsafe { c.title() }.to_string()).unwrap_or_default(),
        url: None,
        completed: false,
        overdue: false,
        priority: None,
        account: None,
        list_id: calendar.as_deref().map(|c| unsafe { c.calendarIdentifier() }.to_string()),
        source_id: Some(identifier),
        series_id: None,
        editable: false,
        recurring: unsafe { item.hasRecurrenceRules() },
        conference_url: crate::google::calendar::meeting_link(location.as_deref(), notes.as_deref()),
        description: notes,
        attendees: Vec::new(),
        reminders: alarms.0,
        email_reminders: Vec::new(),
        alert_at: alarms.1,
        // Apple Calendar has floating events of its own: no time zone. (EventKit
        // already gives their times here.)
        floating: !all_day && unsafe { event.timeZone() }.is_none(),
        time_zone: unsafe { event.timeZone() }.map(|zone| zone.name().to_string()),
        leave_from: None,
        leave_alerts: Vec::new(),
        color_id: None,
    }
}

/// Alerts: a lead time before the start, in minutes, and any set for an exact instant.
fn apple_alarms(item: &EKCalendarItem) -> (Vec<u32>, Vec<String>) {
    let Some(alarms) = (unsafe { item.alarms() }) else { return (Vec::new(), Vec::new()) };
    let mut minutes = Vec::new();
    let mut at = Vec::new();
    for alarm in alarms.iter() {
        if let Some(date) = unsafe { alarm.absoluteDate() } {
            at.push(local(&date).to_rfc3339());
        } else {
            let before = -unsafe { alarm.relativeOffset() };
            if before >= 0.0 {
                minutes.push((before / 60.0).round() as u32);
            }
        }
    }
    (minutes, at)
}

/// Reminders not done yet that are due from `from` up to `to` (local dates),
/// and overdue ones on today, as Todoist's are.
pub async fn reminders_between(from: NaiveDate, to: NaiveDate, google_accounts: Vec<String>) -> Result<Vec<AgendaItem>> {
    run(move |store| {
        if access(EKEntityType::Reminder) != Access::Granted {
            return Ok(Vec::new());
        }
        let Some(lists) = shown_calendars(store, EKEntityType::Reminder, &google_accounts) else {
            return Ok(Vec::new());
        };
        let end = crate::agenda::local_midnight(to);
        let (tx, rx) = mpsc::channel::<Vec<Retained<EKReminder>>>();
        let tx = Mutex::new(Some(tx));
        let done = RcBlock::new(move |found: *mut NSArray<EKReminder>| {
            let found = NonNull::new(found).map(|f| unsafe { f.as_ref() }.to_vec()).unwrap_or_default();
            if let Some(tx) = tx.lock().expect("not poisoned").take() {
                let _ = tx.send(found);
            }
        });
        unsafe {
            // Due any time before the end, overdue ones included.
            let predicate =
                store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars(None, Some(&ns_date(end)), Some(&lists));
            store.fetchRemindersMatchingPredicate_completion(&predicate, &done);
        }
        let reminders = rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| AppError::Config("Reminders didn't answer in time".into()))?;
        let today = Local::now().date_naive();
        Ok(reminders.iter().filter_map(|r| reminder_item(r, from, to, today)).collect())
    })
    .await?
}

fn reminder_item(reminder: &EKReminder, from: NaiveDate, to: NaiveDate, today: NaiveDate) -> Option<AgendaItem> {
    let due = unsafe { reminder.dueDateComponents() }?;
    let timed = due.hour() != NSDateComponentUndefined;
    let date = NSCalendar::currentCalendar().dateFromComponents(&due)?;
    let at = local(&date);
    let overdue = at.date_naive() < today;
    let day = if overdue { today } else { at.date_naive() };
    if day < from || day >= to {
        return None;
    }
    let (start, end, all_day) = if overdue || !timed {
        (day.to_string(), (day + TimeDelta::days(1)).to_string(), true)
    } else {
        (at.to_rfc3339(), at.to_rfc3339(), false)
    };
    let item: &EKCalendarItem = reminder;
    let identifier = unsafe { item.calendarItemIdentifier() }.to_string();
    let list = unsafe { item.calendar() };
    // EventKit: 1–4 high, 5 medium, 6–9 low, 0 none. The app shows Todoist's
    // 1 (urgent) to 4 (normal).
    let priority = match unsafe { reminder.priority() } {
        1..=4 => 1,
        5 => 2,
        6..=9 => 3,
        _ => 4,
    };
    Some(AgendaItem {
        id: format!("{REMINDER_PREFIX}{identifier}"),
        source: Source::Apple,
        kind: ItemKind::Task,
        title: unsafe { item.title() }.to_string(),
        start,
        end: Some(end),
        all_day,
        location: None,
        color: list.as_deref().map(color),
        list_name: list.as_deref().map(|c| unsafe { c.title() }.to_string()).unwrap_or_default(),
        url: None,
        completed: false,
        overdue,
        priority: Some(priority),
        account: None,
        list_id: list.as_deref().map(|c| unsafe { c.calendarIdentifier() }.to_string()),
        source_id: Some(identifier),
        series_id: None,
        editable: false,
        recurring: unsafe { item.hasRecurrenceRules() },
        description: unsafe { item.notes() }.map(|n| n.to_string()),
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
    })
}

/// Whether `id` is an Apple reminder's item ID.
pub fn is_reminder(id: &str) -> bool {
    id.starts_with(REMINDER_PREFIX)
}

/// Ticks a reminder off (or back on) in the Reminders app.
pub async fn set_reminder_completed(id: &str, completed: bool) -> Result<()> {
    let identifier = id
        .strip_prefix(REMINDER_PREFIX)
        .ok_or_else(|| AppError::InvalidInput(format!("not an Apple reminder: {id:?}")))?
        .to_string();
    run(move |store| {
        let item = unsafe { store.calendarItemWithIdentifier(&objc2_foundation::NSString::from_str(&identifier)) }
            .ok_or_else(|| AppError::InvalidInput("that reminder is gone from Reminders".into()))?;
        let reminder = item
            .downcast::<EKReminder>()
            .map_err(|_| AppError::InvalidInput("that isn't a reminder".into()))?;
        unsafe {
            reminder.setCompleted(completed);
            store
                .saveReminder_commit_error(&reminder, true)
                .map_err(|e| AppError::Config(format!("Reminders couldn't save it: {}", e.localizedDescription())))
        }
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_calendars_on_the_mac_are_left_out_unless_chosen() {
        let accounts = ["me@example.com".to_string()];
        let none = BTreeMap::new();
        assert!(is_shown(&none, "a", "iCloud", &accounts));
        assert!(!is_shown(&none, "a", "me@example.com", &accounts));
        assert!(!is_shown(&none, "a", "someone@gmail.com", &accounts));
        let chosen = BTreeMap::from([("a".to_string(), true)]);
        assert!(is_shown(&chosen, "a", "me@example.com", &accounts));
    }
}
