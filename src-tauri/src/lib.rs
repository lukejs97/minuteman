mod agenda;
#[cfg(target_os = "macos")]
mod apple;
#[cfg(desktop)]
mod alerts;
mod cache;
mod contacts;
#[cfg(desktop)]
mod desktop;
mod error;
mod google;
mod interactions;
mod leave;
mod prefs;
mod search;
mod secrets;
mod todoist;
#[cfg(target_os = "macos")]
mod travel;

use std::time::Duration;

use chrono::NaiveDate;
use futures::future::join_all;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use agenda::Agenda;
use cache::AgendaCache;
use contacts::ContactsCache;
use interactions::{Interaction, Interactions, NewInteraction};
use error::{AppError, Result};
use google::auth::GoogleAuth;
use google::calendar::{EventCalendar, EventDraft, EventTimes};
use google::contacts::{Contact, ContactDraft};

pub(crate) struct AppState {
    pub(crate) http: reqwest::Client,
    pub(crate) google_auth: GoogleAuth,
}

// Commands: Rust functions the TypeScript frontend calls with `invoke(...)`.
// All network access and tokens stay on this side; the web view only ever
// sees agenda data.

#[tauri::command]
fn auth_status(state: State<'_, AppState>) -> Result<bool> {
    state.google_auth.is_signed_in()
}

/// Adds a Google account (or renews one already added); returns its email.
#[tauri::command]
async fn sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<String> {
    let email = state.google_auth.sign_in(&app).await?;
    events_changed();
    Ok(email)
}

#[tauri::command]
async fn google_accounts(state: State<'_, AppState>) -> Result<Vec<String>> {
    state.google_auth.accounts().await
}

#[tauri::command]
async fn remove_google_account(
    state: State<'_, AppState>,
    cache: State<'_, AgendaCache>,
    contacts: State<'_, ContactsCache>,
    interactions: State<'_, Interactions>,
    email: String,
) -> Result<()> {
    state.google_auth.remove_account(&email).await?;
    cache.forget(&email);
    contacts.forget(&email);
    interactions.forget_account(&email);
    events_changed();
    Ok(())
}

/// `from` and `to` are local dates as "YYYY-MM-DD"; `to` is exclusive.
/// Without internet, falls back to the items saved last time (see cache.rs).
#[tauri::command]
async fn get_agenda(
    state: State<'_, AppState>,
    cache: State<'_, AgendaCache>,
    from: String,
    to: String,
) -> Result<Agenda> {
    let (from, to) = (parse_date(&from)?, parse_date(&to)?);
    match agenda::load(&state.http, &state.google_auth, from, to).await {
        Ok(agenda) => {
            cache.store(from, to, &agenda.loaded, &agenda.items);
            Ok(agenda)
        }
        // No internet (or Google unreachable): show what was saved.
        Err(e @ AppError::Http(_)) => saved_agenda(&state, &cache, from, to).await?.ok_or(e),
        Err(e) => Err(e),
    }
}

/// The items saved last time, straight away and without the network, so the
/// app can show something while it fetches. `None` if nothing is saved.
#[tauri::command]
async fn get_saved_agenda(
    state: State<'_, AppState>,
    cache: State<'_, AgendaCache>,
    from: String,
    to: String,
) -> Result<Option<Agenda>> {
    let agenda = saved_agenda(&state, &cache, parse_date(&from)?, parse_date(&to)?).await?;
    Ok(agenda.map(|agenda| Agenda { offline_since: None, ..agenda }))
}

async fn saved_agenda(
    state: &AppState,
    cache: &AgendaCache,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Option<Agenda>> {
    let Some((mut items, saved_at)) = cache.between(from, to) else {
        return Ok(None);
    };
    // Only accounts still signed in, in case one was removed meanwhile.
    let accounts = state.google_auth.accounts().await.unwrap_or_default();
    items.retain(|item| item.account.as_ref().is_none_or(|a| accounts.contains(a)));
    Ok(Some(Agenda { accounts, items, warnings: Vec::new(), offline_since: Some(saved_at), loaded: Vec::new() }))
}

/// Events and tasks from a year back to a year ahead matching `query`.
#[tauri::command]
async fn search(
    state: State<'_, AppState>,
    cache: State<'_, AgendaCache>,
    query: String,
) -> Result<search::SearchResults> {
    search::search(&state.http, &state.google_auth, &cache, &query).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountCalendars {
    email: String,
    /// False for accounts added before the app could add events. Adding the
    /// account again (Accounts → Add account) asks Google for permission.
    can_edit: bool,
    calendars: Vec<EventCalendar>,
    /// Why the calendars couldn't be listed, if they couldn't.
    error: Option<String>,
}

/// The calendars you can add events to, for each Google account.
#[tauri::command]
async fn event_calendars(state: State<'_, AppState>) -> Result<Vec<AccountCalendars>> {
    let (auth, http) = (&state.google_auth, &state.http);
    let accounts = auth.accounts().await?;
    let lists = join_all(accounts.iter().map(|email| async move {
        if !auth.can_edit_events(email).await? {
            return Ok((false, Vec::new()));
        }
        let token = auth.access_token(email).await?;
        Ok((true, google::calendar::editable_calendars(http, &token).await?))
    }))
    .await;
    Ok(accounts
        .into_iter()
        .zip(lists)
        .map(|(email, list): (String, Result<_>)| match list {
            Ok((can_edit, calendars)) => AccountCalendars { email, can_edit, calendars, error: None },
            Err(e) => AccountCalendars { email, can_edit: false, calendars: Vec::new(), error: Some(e.to_string()) },
        })
        .collect())
}

/// Adds an event to `calendar_id`, one of `email`'s calendars, inviting its guests.
#[tauri::command]
async fn create_event(
    state: State<'_, AppState>,
    email: String,
    calendar_id: String,
    event: EventDraft,
) -> Result<()> {
    let token = state.google_auth.access_token(&email).await?;
    google::calendar::create_event(&state.http, &token, &calendar_id, &event).await?;
    events_changed();
    Ok(())
}

/// Which Google event: its account, calendar and ID. For a repeating event,
/// one occurrence's ID affects that occurrence; the series' ID, all of them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventRef {
    email: String,
    calendar_id: String,
    event_id: String,
}

/// Saves an edited event, first moving it to `move_to` (another calendar in
/// the same account) if given. `notify_guests` emails them about the change.
/// `occurrence` is set when editing every event in a repeating series from
/// one of them: `target` is then the series, and `occurrence` when that one
/// was before the edit.
#[tauri::command]
async fn update_event(
    state: State<'_, AppState>,
    target: EventRef,
    event: EventDraft,
    move_to: Option<String>,
    notify_guests: bool,
    occurrence: Option<EventTimes>,
) -> Result<()> {
    let token = state.google_auth.access_token(&target.email).await?;
    let mut calendar_id = target.calendar_id;
    if let Some(destination) = move_to.filter(|d| *d != calendar_id) {
        google::calendar::move_to_calendar(&state.http, &token, &calendar_id, &target.event_id, &destination).await?;
        calendar_id = destination;
    }
    let (http, id) = (&state.http, &target.event_id);
    match occurrence {
        Some(occurrence) => {
            google::calendar::update_series(http, &token, &calendar_id, id, &occurrence, &event, notify_guests).await?
        }
        None => google::calendar::update_event(http, &token, &calendar_id, id, &event, notify_guests).await?,
    }
    events_changed();
    Ok(())
}

/// A repeating event's rules, from its series (`target`), to show them.
#[tauri::command]
async fn event_recurrence(state: State<'_, AppState>, target: EventRef) -> Result<Vec<String>> {
    let token = state.google_auth.access_token(&target.email).await?;
    google::calendar::recurrence(&state.http, &token, &target.calendar_id, &target.event_id).await
}

/// Moves or resizes an event (dragging it).
#[tauri::command]
async fn set_event_times(
    state: State<'_, AppState>,
    target: EventRef,
    times: EventTimes,
    notify_guests: bool,
) -> Result<()> {
    let token = state.google_auth.access_token(&target.email).await?;
    google::calendar::set_event_times(&state.http, &token, &target.calendar_id, &target.event_id, &times, notify_guests)
        .await?;
    events_changed();
    Ok(())
}

#[tauri::command]
async fn delete_event(state: State<'_, AppState>, target: EventRef, notify_guests: bool) -> Result<()> {
    let token = state.google_auth.access_token(&target.email).await?;
    google::calendar::delete_event(&state.http, &token, &target.calendar_id, &target.event_id, notify_guests).await?;
    events_changed();
    Ok(())
}

/// Every Google account's contacts, for the Contacts window. Without
/// internet, the ones saved last time.
#[tauri::command]
async fn get_contacts(state: State<'_, AppState>, cache: State<'_, ContactsCache>) -> Result<contacts::ContactList> {
    contacts::load(&state.http, &state.google_auth, &cache).await
}

/// The contacts saved last time, straight away and without the network.
#[tauri::command]
async fn get_saved_contacts(
    state: State<'_, AppState>,
    cache: State<'_, ContactsCache>,
) -> Result<Option<contacts::ContactList>> {
    let list = contacts::saved(&state.google_auth, &cache).await?;
    Ok(list.map(|list| contacts::ContactList { offline_since: None, ..list }))
}

/// Adds a contact to `email`'s Google Contacts; returns it as saved.
#[tauri::command]
async fn create_contact(
    state: State<'_, AppState>,
    cache: State<'_, ContactsCache>,
    email: String,
    contact: ContactDraft,
) -> Result<Contact> {
    let token = state.google_auth.access_token(&email).await?;
    let saved = google::contacts::create_contact(&state.http, &token, &email, &contact).await?;
    cache.put(&saved);
    Ok(saved)
}

/// Which contact: its account, Google's ID for it, and the version it was
/// read at (`etag`; changes to an older version are turned down).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContactRef {
    email: String,
    resource_name: String,
    etag: Option<String>,
}

/// Saves changes to a contact (fields left out stay as they are); returns it as saved.
#[tauri::command]
async fn update_contact(
    state: State<'_, AppState>,
    cache: State<'_, ContactsCache>,
    target: ContactRef,
    contact: ContactDraft,
) -> Result<Contact> {
    let token = state.google_auth.access_token(&target.email).await?;
    let (http, email, name) = (&state.http, &target.email, &target.resource_name);
    let saved = google::contacts::update_contact(http, &token, email, name, target.etag.as_deref(), &contact).await?;
    cache.put(&saved);
    Ok(saved)
}

#[tauri::command]
async fn delete_contact(
    state: State<'_, AppState>,
    cache: State<'_, ContactsCache>,
    interactions: State<'_, Interactions>,
    target: ContactRef,
) -> Result<()> {
    let token = state.google_auth.access_token(&target.email).await?;
    google::contacts::delete_contact(&state.http, &token, &target.resource_name).await?;
    let id = format!("{}/{}", target.email, target.resource_name);
    cache.remove(&id);
    interactions.forget_contact(&id);
    Ok(())
}

/// Your history with people in Contacts (see interactions.rs), oldest first.
#[tauri::command]
fn interactions(interactions: State<'_, Interactions>) -> Vec<Interaction> {
    interactions.all()
}

/// Logs a call, message, note… with someone, now; returns it as kept.
#[tauri::command]
fn log_interaction(interactions: State<'_, Interactions>, interaction: NewInteraction) -> Result<Interaction> {
    interactions.log(interaction)
}

/// Adds a contact to Favorites, or takes it out; returns it as saved.
#[tauri::command]
async fn set_contact_starred(
    state: State<'_, AppState>,
    cache: State<'_, ContactsCache>,
    target: ContactRef,
    starred: bool,
) -> Result<Contact> {
    let token = state.google_auth.access_token(&target.email).await?;
    let saved =
        google::contacts::set_starred(&state.http, &token, &target.email, &target.resource_name, starred).await?;
    cache.put(&saved);
    Ok(saved)
}

/// Events were added, changed or removed here: reload before checking alerts.
fn events_changed() {
    #[cfg(desktop)]
    alerts::refresh();
}

/// An account's calendars, for choosing which to show.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountCalendarList {
    email: String,
    calendars: Vec<google::calendar::ListedCalendar>,
    /// Why the calendars couldn't be listed, if they couldn't.
    error: Option<String>,
}

/// Every Google account's calendars, and which are shown.
#[tauri::command]
async fn google_calendars(state: State<'_, AppState>) -> Result<Vec<AccountCalendarList>> {
    let (auth, http) = (&state.google_auth, &state.http);
    let accounts = auth.accounts().await?;
    let lists = join_all(accounts.iter().map(|email| async move {
        let token = auth.access_token(email).await?;
        google::calendar::all_calendars(http, &token, email).await
    }))
    .await;
    Ok(accounts
        .into_iter()
        .zip(lists)
        .map(|(email, list): (String, Result<_>)| match list {
            Ok(calendars) => AccountCalendarList { email, calendars, error: None },
            Err(e) => AccountCalendarList { email, calendars: Vec::new(), error: Some(e.to_string()) },
        })
        .collect())
}

/// Shows or hides one of a Google account's calendars.
#[tauri::command]
fn set_google_calendar_shown(email: String, calendar_id: String, shown: bool) {
    prefs::set_google_calendar_shown(&email, &calendar_id, shown);
    // Alerts and the menu bar follow what's shown.
    events_changed();
}

/// Settings the Rust side keeps (see prefs.rs).
#[tauri::command]
fn get_preferences() -> prefs::Prefs {
    prefs::get()
}

#[tauri::command]
fn set_preferences(app: AppHandle, cache: State<'_, AgendaCache>, preferences: prefs::Prefs) {
    if !preferences.apple_calendar && !preferences.apple_reminders {
        cache.forget("apple");
    }
    // Follow the Mac's location only while time-to-leave has no address to
    // start from. An address is a Routes lookup, not a GPS one.
    #[cfg(target_os = "macos")]
    if preferences.uses_device_location() != prefs::get().uses_device_location() {
        if preferences.uses_device_location() { travel::start(&app) } else { travel::stop(&app) }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    let mut preferences = preferences;
    preferences.routes_daily_limit = preferences.routes_daily_limit.min(leave::MAX_DAILY);
    preferences.routes_monthly_limit = preferences.routes_monthly_limit.min(leave::MAX_MONTHLY);
    prefs::set(preferences);
    // Redraw the menu bar text, and reload (Apple calendars may have changed).
    events_changed();
}

/// Mac only: whether Minuteman may read the Calendar and Reminders apps'
/// data (`null` elsewhere).
#[tauri::command]
fn apple_status() -> Option<serde_json::Value> {
    #[cfg(target_os = "macos")]
    return serde_json::to_value(apple::status()).ok();
    #[cfg(not(target_os = "macos"))]
    None
}

/// Mac only: asks for access to the Calendar app ("calendar") or the
/// Reminders app ("reminders"), showing macOS's prompt the first time.
#[tauri::command]
async fn apple_request_access(kind: String) -> Result<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        let kind = serde_json::from_value(serde_json::Value::String(kind))
            .map_err(|_| AppError::InvalidInput("kind must be calendar or reminders".into()))?;
        let access = apple::request_access(kind).await?;
        events_changed();
        Ok(serde_json::to_value(access).expect("serializable"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err(AppError::Config("Apple Calendar is only on the Mac".into()))
    }
}

/// Mac only: the Calendar app's calendars and the Reminders app's lists, and
/// which are shown.
#[tauri::command]
async fn apple_calendars(state: State<'_, AppState>) -> Result<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        let accounts = state.google_auth.accounts().await.unwrap_or_default();
        Ok(serde_json::to_value(apple::calendars(accounts).await?).expect("serializable"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Ok(serde_json::Value::Array(Vec::new()))
    }
}

/// Whether Minuteman opens when you log in (desktop; `null` elsewhere).
#[tauri::command]
fn open_at_login(app: AppHandle) -> Option<bool> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().ok()
    }
    #[cfg(mobile)]
    {
        let _ = app;
        None
    }
}

/// Turns opening at login on or off (desktop).
#[tauri::command]
fn set_open_at_login(app: AppHandle, enabled: bool) -> Result<()> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let launcher = app.autolaunch();
        let changed = if enabled { launcher.enable() } else { launcher.disable() };
        changed.map_err(|e| AppError::Config(format!("Couldn't change opening at login: {e}")))
    }
    #[cfg(mobile)]
    {
        let _ = (app, enabled);
        Err(AppError::Config("Opening at login is only on the desktop".into()))
    }
}

/// Mac only: where the Mac is, for the weather (`{latitude, longitude}`), or
/// `null` if that isn't allowed or known. Elsewhere `null`: the page asks
/// the browser instead.
#[tauri::command]
async fn current_location(app: AppHandle) -> Option<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        let (latitude, longitude) = travel::current_location(&app).await?;
        Some(serde_json::json!({ "latitude": latitude, "longitude": longitude }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

/// Where a drive to an event starts from, and how long it takes in traffic.
/// One answer per event. Missing a key, an address, or a place comes back as
/// a status rather than an error, so the calendar still draws.
#[tauri::command]
async fn leave_times(
    app: AppHandle,
    state: State<'_, AppState>,
    events: Vec<LeaveQuery>,
    here: Option<String>,
) -> Result<Vec<LeaveEstimate>> {
    use chrono::{DateTime, Utc};
    use futures::StreamExt;

    let http = state.http.clone();
    let settings = prefs::get();
    let has_key = leave::api_key().is_some();
    let allow_device = settings.uses_device_location();
    let default_from = settings.leave_from.clone();
    // Where the page found you, when Settings says to start from there.
    let here = here.filter(|_| settings.leave_from_here);
    let queries = events.into_iter().take(40).map(|event| {
        let http = http.clone();
        let app = app.clone();
        let default_from = default_from.clone();
        let here = here.clone();
        async move {
            let origin = leave::pick_origin(event.leave_from.as_deref(), here.as_deref(), &default_from);
            let answer = match DateTime::parse_from_rfc3339(&event.start) {
                Ok(start) => {
                    let place = event.location.clone();
                    let arrive = start.with_timezone(&Utc);
                    leave::resolve(
                        &http,
                        &event.location,
                        arrive,
                        Utc::now(),
                        origin.as_deref(),
                        has_key,
                        allow_device,
                        || device_drive(&app, &place, start.with_timezone(&chrono::Local)),
                    )
                    .await
                }
                Err(_) => {
                    leave::TravelAnswer { minutes: None, leave_at: None, status: leave::TravelStatus::Unavailable }
                }
            };
            LeaveEstimate {
                id: event.id,
                start: event.start,
                minutes: answer.minutes,
                leave_at: answer.leave_at,
                status: answer.status,
            }
        }
    });
    Ok(futures::stream::iter(queries).buffer_unordered(4).collect().await)
}

/// Apple Maps from the Mac's location, for the time-to-leave switch when no
/// address is set. Elsewhere this is unused (`allow_device` is false).
pub(crate) async fn device_drive(app: &AppHandle, place: &str, arrive: chrono::DateTime<chrono::Local>) -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        travel::start(app);
        return travel::driving_minutes(app, place.to_string(), arrive).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, place, arrive);
        None
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaveQuery {
    id: String,
    start: String,
    location: String,
    #[serde(default)]
    leave_from: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaveEstimate {
    id: String,
    start: String,
    minutes: Option<u32>,
    leave_at: Option<String>,
    status: leave::TravelStatus,
}

/// Whether a Routes API key is available, and where it came from. The key
/// itself never leaves this side.
#[tauri::command]
fn routes_key_status() -> leave::RoutesKeyStatus {
    leave::key_status()
}

/// How many Routes attempts have been used today and this month (Pacific time).
#[tauri::command]
fn routes_usage() -> leave::UsageSnapshot {
    leave::usage_snapshot(chrono::Utc::now())
}

/// Saves a Routes API key in the keychain, or clears it when `key` is empty.
/// A key in the environment still wins over this one.
#[tauri::command]
fn set_routes_key(key: String) -> Result<()> {
    leave::set_api_key(&key)?;
    events_changed();
    Ok(())
}

/// Mac only: whether Minuteman may use the Mac's location, for time-to-leave
/// alerts ("notAsked", "granted" or "denied"; `null` elsewhere).
#[tauri::command]
fn location_access() -> Option<serde_json::Value> {
    #[cfg(target_os = "macos")]
    return serde_json::to_value(travel::access()).ok();
    #[cfg(not(target_os = "macos"))]
    None
}

/// Brings up the main window, e.g. from the menu bar window.
#[tauri::command]
fn show_main(app: AppHandle) {
    #[cfg(desktop)]
    desktop::show_main(&app);
    #[cfg(mobile)]
    let _ = app;
}

/// Opens the Contacts window (desktop), showing what matches `query` if
/// given. On a phone the page goes to contacts.html itself instead.
#[tauri::command]
fn show_contacts(app: AppHandle, query: Option<String>) {
    #[cfg(desktop)]
    desktop::show_contacts(&app, query.as_deref());
    #[cfg(mobile)]
    let _ = (app, query);
}

/// Detaches the menu bar window into a window of its own, or puts it back.
#[tauri::command]
fn set_flyout_detached(app: AppHandle, detached: bool) {
    #[cfg(desktop)]
    desktop::set_flyout_detached(&app, detached);
    #[cfg(mobile)]
    let _ = (app, detached);
}

fn parse_date(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| AppError::InvalidInput(format!("not a YYYY-MM-DD date: {s:?}")))
}

#[tauri::command]
fn todoist_status() -> Result<bool> {
    Ok(secrets::get(secrets::TODOIST_TOKEN)?.is_some())
}

/// Checks the personal API token with Todoist, then saves it in the keychain.
#[tauri::command]
async fn todoist_connect(state: State<'_, AppState>, token: String) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        return Err(AppError::InvalidInput("paste your Todoist API token first".into()));
    }
    todoist::verify_token(&state.http, token).await?;
    secrets::set(secrets::TODOIST_TOKEN, token)
}

/// Todoist projects to add tasks to, Inbox first.
#[tauri::command]
async fn todoist_projects(state: State<'_, AppState>) -> Result<Vec<todoist::ProjectInfo>> {
    todoist::projects(&state.http, &todoist_token()?).await
}

#[tauri::command]
async fn create_task(state: State<'_, AppState>, task: todoist::TaskDraft) -> Result<()> {
    todoist::create_task(&state.http, &todoist_token()?, &task).await
}

/// `id` is the task's own Todoist ID.
#[tauri::command]
async fn update_task(state: State<'_, AppState>, id: String, task: todoist::TaskDraft) -> Result<()> {
    todoist::update_task(&state.http, &todoist_token()?, &id, &task).await
}

/// Reschedules a task (dragging it).
#[tauri::command]
async fn set_task_due(state: State<'_, AppState>, id: String, due: todoist::TaskDue) -> Result<()> {
    todoist::set_task_due(&state.http, &todoist_token()?, &id, &due).await
}

#[tauri::command]
async fn delete_task(state: State<'_, AppState>, id: String) -> Result<()> {
    todoist::delete_task(&state.http, &todoist_token()?, &id).await
}

fn todoist_token() -> Result<String> {
    secrets::get(secrets::TODOIST_TOKEN)?.ok_or_else(|| AppError::Config("Todoist isn't connected".into()))
}

#[tauri::command]
fn todoist_disconnect(cache: State<'_, AgendaCache>) -> Result<()> {
    secrets::delete(secrets::TODOIST_TOKEN)?;
    cache.forget("todoist");
    Ok(())
}

/// `id` is the task's `AgendaItem` id ("todoist:…", or "apple-reminder:…" on a Mac).
#[tauri::command]
async fn set_task_completed(state: State<'_, AppState>, id: String, completed: bool) -> Result<()> {
    #[cfg(target_os = "macos")]
    if apple::is_reminder(&id) {
        return apple::set_reminder_completed(&id, completed).await;
    }
    todoist::set_completed(&state.http, &todoist_token()?, &id, completed).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = reqwest::Client::builder()
        .user_agent(concat!("Minuteman/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("failed to build HTTP client");

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Opening at login starts it in the menu bar, its window closed.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![desktop::OPENED_AT_LOGIN]),
        ));

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    builder
        .setup(|app| {
            let path = app.path().app_cache_dir().ok().map(|dir| dir.join("agenda.json"));
            app.manage(AgendaCache::load(path));
            let path = app.path().app_cache_dir().ok().map(|dir| dir.join("contacts.json"));
            app.manage(ContactsCache::load(path));
            prefs::init(app.path().app_config_dir().ok().map(|dir| dir.join("preferences.json")));
            leave::init_usage(app.path().app_config_dir().ok().map(|dir| dir.join("routes-usage.json")));
            app.manage(Interactions::load(app.path().app_config_dir().ok().map(|dir| dir.join("interactions.json"))));
            #[cfg(mobile)]
            listen_for_sign_in_redirects(app);
            #[cfg(desktop)]
            {
                desktop::setup(app)?;
                alerts::start(app.handle().clone());
            }
            #[cfg(target_os = "macos")]
            if prefs::get().uses_device_location() {
                travel::start(app.handle());
            }
            Ok(())
        })
        .manage(AppState { google_auth: GoogleAuth::new(http.clone()), http })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            sign_in,
            google_accounts,
            remove_google_account,
            get_agenda,
            get_saved_agenda,
            search,
            event_calendars,
            google_calendars,
            set_google_calendar_shown,
            create_event,
            update_event,
            event_recurrence,
            set_event_times,
            delete_event,
            get_contacts,
            get_saved_contacts,
            create_contact,
            update_contact,
            delete_contact,
            set_contact_starred,
            interactions,
            log_interaction,
            show_contacts,
            todoist_status,
            todoist_connect,
            todoist_disconnect,
            todoist_projects,
            create_task,
            update_task,
            set_task_due,
            delete_task,
            set_task_completed,
            show_main,
            set_flyout_detached,
            get_preferences,
            set_preferences,
            apple_status,
            apple_request_access,
            apple_calendars,
            location_access,
            current_location,
            leave_times,
            routes_key_status,
            routes_usage,
            set_routes_key,
            open_at_login,
            set_open_at_login,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Clicking the Dock icon with the window closed opens it again.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                desktop::show_main(_app);
            }
        });
}

/// iOS: Google's sign-in redirect comes back as a deep link (a custom URL
/// scheme that opens this app); pass it to the waiting sign-in.
#[cfg(mobile)]
fn listen_for_sign_in_redirects(app: &tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        let state = handle.state::<AppState>();
        for url in event.urls() {
            state.google_auth.handle_redirect_url(&url);
        }
    });
}
