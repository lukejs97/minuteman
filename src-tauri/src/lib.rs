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
#[cfg(windows)]
mod winlocation;

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

/// Demo mode (Settings → Demo mode) on or off. On, with the demo's items and
/// its clock (`now`, RFC 3339): the menu bar shows its next event, and real
/// alerts wait. Off: back to the real calendar.
#[tauri::command]
fn set_demo(app: AppHandle, on: bool, items: Vec<agenda::AgendaItem>, now: Option<String>) {
    let now = now
        .as_deref()
        .and_then(|now| chrono::DateTime::parse_from_rfc3339(now).ok())
        .map(|now| now.with_timezone(&chrono::Local));
    #[cfg(desktop)]
    alerts::show_demo(&app, on, &items, now);
    #[cfg(mobile)]
    let _ = (app, on, items, now);
}

/// "This and following events": ends a series just before its occurrence at
/// `before`, and returns its rules for a new series from there. `None`: that's
/// its first occurrence, so change the whole series instead.
#[tauri::command]
async fn end_series_before(
    state: State<'_, AppState>,
    target: EventRef,
    before: String,
    all_day: bool,
) -> Result<Option<Vec<String>>> {
    let token = state.google_auth.access_token(&target.email).await?;
    let ended =
        google::calendar::end_series_before(&state.http, &token, &target.calendar_id, &target.event_id, &before, all_day)
            .await?;
    events_changed();
    Ok(ended)
}

/// Your reply to an invitation: "accepted", "declined" or "tentative". For a
/// repeating event, `target` is the one occurrence, or its series for all.
#[tauri::command]
async fn respond_to_event(state: State<'_, AppState>, target: EventRef, response: String) -> Result<()> {
    let token = state.google_auth.access_token(&target.email).await?;
    google::calendar::respond(&state.http, &token, &target.calendar_id, &target.event_id, &response).await?;
    events_changed();
    Ok(())
}

/// The largest file that can be attached (Google and Todoist allow more, but
/// it travels through the app as text).
const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

/// A file sent from the page to attach: its bytes (base64), checked for size,
/// and a type fit for a header ("image/png").
fn attachment_bytes(mime_type: &str, data: &str) -> Result<(String, Vec<u8>)> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| AppError::InvalidInput("the file didn't come through".into()))?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::InvalidInput("files can be up to 25 MB".into()));
    }
    let plain = |c: char| c.is_ascii_alphanumeric() || "/+.-_".contains(c);
    let mime = if !mime_type.is_empty() && mime_type.len() < 100 && mime_type.chars().all(plain) {
        mime_type.to_string()
    } else {
        "application/octet-stream".to_string()
    };
    Ok((mime, bytes))
}

/// Attaches a file to an event: put in the account's Drive, then linked on it.
#[tauri::command]
async fn attach_to_event(
    state: State<'_, AppState>,
    target: EventRef,
    name: String,
    mime_type: String,
    data: String,
) -> Result<agenda::Attachment> {
    let (mime, bytes) = attachment_bytes(&mime_type, &data)?;
    if !state.google_auth.can_attach_files(&target.email).await? {
        return Err(AppError::InvalidInput(format!(
            "To attach files, add {} again in Settings → Google accounts, so Google can ask to allow it",
            target.email
        )));
    }
    let token = state.google_auth.access_token(&target.email).await?;
    let name = name.trim();
    let name = if name.is_empty() { "Attachment" } else { name };
    let added = google::calendar::attach(&state.http, &token, &target.calendar_id, &target.event_id, name, &mime, bytes).await?;
    events_changed();
    Ok(added)
}

/// Takes an attachment off an event (the file stays in Drive).
#[tauri::command]
async fn remove_event_attachment(state: State<'_, AppState>, target: EventRef, url: String) -> Result<()> {
    let token = state.google_auth.access_token(&target.email).await?;
    google::calendar::remove_attachment(&state.http, &token, &target.calendar_id, &target.event_id, &url).await?;
    events_changed();
    Ok(())
}

/// A file copied in Finder (or sent by Universal Clipboard) is on the
/// clipboard only as its path; the page can't open a path, so it asks here.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CopiedFile {
    name: String,
    mime_type: String,
    /// The file's bytes, base64.
    data: String,
}

/// The file at a copied `file://` address, to attach it. Only a file (not a
/// folder), and at most 25 MB.
#[tauri::command]
async fn copied_file(url: String) -> Result<CopiedFile> {
    let not_file = || AppError::InvalidInput("what's on the clipboard isn't a file".into());
    let address = url::Url::parse(url.trim()).map_err(|_| not_file())?;
    if address.scheme() != "file" {
        return Err(not_file());
    }
    read_copied(&address.to_file_path().map_err(|_| not_file())?).await
}

/// The files copied in Finder or File Explorer (or handed over by Universal
/// Clipboard), read from the system clipboard: the web view only shows their names.
#[tauri::command]
async fn clipboard_files() -> Result<Vec<CopiedFile>> {
    let mut files = Vec::new();
    for path in clipboard::copied_paths() {
        files.push(read_copied(&path).await?);
    }
    Ok(files)
}

/// A copied file, if it's one that can be attached (a file, up to 25 MB).
async fn read_copied(path: &std::path::Path) -> Result<CopiedFile> {
    use base64::Engine as _;
    let size = tokio::fs::metadata(path)
        .await
        .map_err(|_| AppError::InvalidInput("what's on the clipboard isn't a file".into()))?;
    if !size.is_file() {
        return Err(AppError::InvalidInput("folders can't be attached, only files".into()));
    }
    if size.len() > MAX_ATTACHMENT_BYTES as u64 {
        return Err(AppError::InvalidInput("files can be up to 25 MB".into()));
    }
    let bytes = tokio::fs::read(path).await.map_err(|_| AppError::InvalidInput("couldn't read that file".into()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("Attachment").to_string();
    let mime_type = mime_for(&name).to_string();
    Ok(CopiedFile { name, mime_type, data: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

/// Where the files on the system clipboard are.
mod clipboard {
    use std::path::PathBuf;

    #[cfg(target_os = "macos")]
    pub fn copied_paths() -> Vec<PathBuf> {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
        let pasteboard = NSPasteboard::generalPasteboard();
        let Some(items) = pasteboard.pasteboardItems() else { return Vec::new() };
        items
            .iter()
            .filter_map(|item| item.stringForType(unsafe { NSPasteboardTypeFileURL }))
            .filter_map(|address| url::Url::parse(&address.to_string()).ok()?.to_file_path().ok())
            .collect()
    }

    #[cfg(windows)]
    pub fn copied_paths() -> Vec<PathBuf> {
        use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
        use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
        const CF_HDROP: u32 = 15;
        let mut paths = Vec::new();
        unsafe {
            if OpenClipboard(None).is_err() {
                return paths;
            }
            if let Ok(handle) = GetClipboardData(CF_HDROP) {
                let drop = HDROP(handle.0);
                for i in 0..DragQueryFileW(drop, u32::MAX, None) {
                    let mut name = vec![0u16; DragQueryFileW(drop, i, None) as usize + 1];
                    let length = DragQueryFileW(drop, i, Some(&mut name)) as usize;
                    paths.push(PathBuf::from(String::from_utf16_lossy(&name[..length])));
                }
            }
            let _ = CloseClipboard();
        }
        paths
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    pub fn copied_paths() -> Vec<PathBuf> {
        Vec::new()
    }
}

/// A file's type from its name's extension, for the common ones.
fn mime_for(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match extension.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "heic" => "image/heic",
        "webp" => "image/webp",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pages" | "numbers" | "key" => "application/octet-stream",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        _ => "application/octet-stream",
    }
}

/// Files on a task's comments.
#[tauri::command]
async fn task_attachments(state: State<'_, AppState>, id: String) -> Result<Vec<agenda::Attachment>> {
    todoist::task_attachments(&state.http, &todoist_token()?, &id).await
}

/// Attaches a file to a task, on a comment, as Todoist does.
#[tauri::command]
async fn attach_to_task(
    state: State<'_, AppState>,
    id: String,
    name: String,
    mime_type: String,
    data: String,
) -> Result<agenda::Attachment> {
    let (mime, bytes) = attachment_bytes(&mime_type, &data)?;
    let name = name.trim();
    let name = if name.is_empty() { "Attachment" } else { name };
    todoist::attach(&state.http, &todoist_token()?, &id, name, &mime, bytes).await
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

/// Sets a contact's photo (`data`: a JPEG or PNG, base64); returns them as saved.
#[tauri::command]
async fn set_contact_photo(
    state: State<'_, AppState>,
    cache: State<'_, ContactsCache>,
    target: ContactRef,
    data: String,
) -> Result<Contact> {
    use base64::Engine as _;
    let photo = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| AppError::InvalidInput("that isn't a picture".into()))?;
    let token = state.google_auth.access_token(&target.email).await?;
    let saved =
        google::contacts::set_photo(&state.http, &token, &target.email, &target.resource_name, &photo).await?;
    cache.put(&saved);
    Ok(saved)
}

/// Takes a contact's photo off; returns them as saved.
#[tauri::command]
async fn remove_contact_photo(
    state: State<'_, AppState>,
    cache: State<'_, ContactsCache>,
    target: ContactRef,
) -> Result<Contact> {
    let token = state.google_auth.access_token(&target.email).await?;
    let saved = google::contacts::remove_photo(&state.http, &token, &target.email, &target.resource_name).await?;
    cache.put(&saved);
    Ok(saved)
}

/// A contact's photo itself (base64), from Google, to adjust it: the page
/// can't read a picture from another site. Only Google's photo addresses.
#[tauri::command]
async fn contact_photo(state: State<'_, AppState>, url: String) -> Result<String> {
    use base64::Engine as _;
    let bytes = google::contacts::photo_bytes(&state.http, &url).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Merges duplicates into one, as Google Contacts' Merge does: `keep` gets
/// `contact` (everything of theirs together, worked out by the page),
/// `photo` (another's, when it has none) and Favorites if any was; the
/// others are deleted, and what's logged with them moves to it. All in the
/// same account. Returns the one kept, as saved.
// A Tauri command's arguments are what the page sends.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn merge_contacts(
    state: State<'_, AppState>,
    cache: State<'_, ContactsCache>,
    interactions: State<'_, Interactions>,
    keep: ContactRef,
    others: Vec<ContactRef>,
    contact: ContactDraft,
    photo: Option<String>,
    starred: bool,
) -> Result<Contact> {
    if others.is_empty() || others.iter().any(|o| o.email != keep.email || o.resource_name == keep.resource_name) {
        return Err(AppError::InvalidInput("only other contacts in the same account can be merged".into()));
    }
    let (http, email, name) = (&state.http, &keep.email, &keep.resource_name);
    let token = state.google_auth.access_token(email).await?;
    let mut saved = if contact.is_empty() {
        None
    } else {
        Some(google::contacts::update_contact(http, &token, email, name, keep.etag.as_deref(), &contact).await?)
    };
    if let Some(url) = photo {
        // A photo that can't be copied isn't worth stopping the merge for.
        if let Ok(bytes) = google::contacts::photo_bytes(http, &url).await {
            saved = google::contacts::set_photo(http, &token, email, name, &bytes).await.ok().or(saved);
        }
    }
    if starred && !saved.as_ref().is_some_and(|c| c.starred) {
        saved = Some(google::contacts::set_starred(http, &token, email, name, true).await?);
    }
    let mut moved = Vec::new();
    for other in &others {
        google::contacts::delete_contact(http, &token, &other.resource_name).await?;
        let id = format!("{}/{}", other.email, other.resource_name);
        cache.remove(&id);
        moved.push(id);
    }
    interactions.move_contacts(&moved, &format!("{email}/{name}"));
    let saved = match saved {
        Some(saved) => saved,
        // Nothing of theirs changed: them as they are, for the latest version.
        None => google::contacts::set_starred(http, &token, email, name, starred).await?,
    };
    cache.put(&saved);
    Ok(saved)
}

/// Saves a contact card (`text`, a vCard) as "<name>.vcf" in Downloads and
/// shows it in Finder or File Explorer; returns where.
#[tauri::command]
async fn save_contact_card(app: AppHandle, name: String, text: String) -> Result<String> {
    let folder = app.path().download_dir().map_err(|e| AppError::InvalidInput(format!("no Downloads folder: {e}")))?;
    if text.len() > 1024 * 1024 || !text.trim_start().starts_with("BEGIN:VCARD") {
        return Err(AppError::InvalidInput("that isn't a contact card".into()));
    }
    let path = free_path(&folder, &card_file_name(&name));
    tokio::fs::write(&path, text).await.map_err(|e| AppError::InvalidInput(format!("couldn't save it: {e}")))?;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().reveal_item_in_dir(&path);
    }
    Ok(path.display().to_string())
}

/// "Paul Revere.vcf": the name without characters a file name can't have.
fn card_file_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .filter(|word| !word.chars().all(|c| c == '.'))
        .collect::<Vec<_>>()
        .join(" ");
    let clean = clean.trim_matches('.').trim().chars().take(80).collect::<String>();
    format!("{}.vcf", if clean.is_empty() { "Contact" } else { &clean })
}

/// `name` in `folder`, or "name 2.vcf", "name 3.vcf"… if it's taken.
fn free_path(folder: &std::path::Path, name: &str) -> std::path::PathBuf {
    let (stem, extension) = name.rsplit_once('.').unwrap_or((name, "vcf"));
    let mut path = folder.join(name);
    let mut n = 2;
    while path.exists() {
        path = folder.join(format!("{stem} {n}.{extension}"));
        n += 1;
    }
    path
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

/// Where the Mac or PC is (`{latitude, longitude}`), from its location
/// service, or `null` if that isn't allowed or known. Elsewhere `null`: the
/// page asks the browser instead.
#[tauri::command]
async fn current_location(app: AppHandle) -> Option<serde_json::Value> {
    let (latitude, longitude) = device_location(&app).await?;
    Some(serde_json::json!({ "latitude": latitude, "longitude": longitude }))
}

/// The Mac's location (Core Location) or the PC's (Windows' location service).
#[allow(clippy::let_and_return)] // one of the three, per platform
pub(crate) async fn device_location(app: &AppHandle) -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    let here = travel::current_location(app).await;
    #[cfg(windows)]
    let here = {
        let _ = app;
        winlocation::current_location().await
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let here = {
        let _ = app;
        None
    };
    here
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
            end_series_before,
            respond_to_event,
            attach_to_event,
            remove_event_attachment,
            task_attachments,
            attach_to_task,
            copied_file,
            clipboard_files,
            set_demo,
            set_event_times,
            delete_event,
            get_contacts,
            get_saved_contacts,
            create_contact,
            update_contact,
            delete_contact,
            set_contact_starred,
            set_contact_photo,
            remove_contact_photo,
            contact_photo,
            merge_contacts,
            save_contact_card,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_attached_file_is_checked_before_it_goes_anywhere() {
        let (mime, bytes) = attachment_bytes("image/png", "aGVsbG8=").unwrap();
        assert_eq!((mime.as_str(), bytes.as_slice()), ("image/png", b"hello".as_slice()));
        // A type that could break the request header is replaced.
        assert_eq!(attachment_bytes("text/plain\r\nX-Evil: 1", "aGVsbG8=").unwrap().0, "application/octet-stream");
        assert_eq!(attachment_bytes("", "aGVsbG8=").unwrap().0, "application/octet-stream");
        assert!(attachment_bytes("text/plain", "not base64!").is_err());
    }

    #[test]
    fn a_contact_card_gets_a_safe_file_name() {
        assert_eq!(card_file_name("Paul Revere"), "Paul Revere.vcf");
        assert_eq!(card_file_name("../../etc/passwd"), "etc passwd.vcf");
        assert_eq!(card_file_name("  "), "Contact.vcf");
        assert_eq!(card_file_name("A: B?"), "A B.vcf");
        let dir = std::env::temp_dir().join(format!("minuteman-cards-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Sam.vcf"), "x").unwrap();
        assert_eq!(free_path(&dir, "Sam.vcf"), dir.join("Sam 2.vcf"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_copied_file_is_read_from_its_path() {
        let dir = std::env::temp_dir().join(format!("minuteman-copied-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Fall Retreat.pdf");
        std::fs::write(&file, b"%PDF").unwrap();
        let url = url::Url::from_file_path(&file).unwrap().to_string();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let copied = runtime.block_on(copied_file(url)).unwrap();
        assert_eq!((copied.name.as_str(), copied.mime_type.as_str(), copied.data.as_str()), ("Fall Retreat.pdf", "application/pdf", "JVBERg=="));
        // A folder, or not a file address: refused.
        let folder = url::Url::from_file_path(&dir).unwrap().to_string();
        assert!(runtime.block_on(copied_file(folder)).is_err());
        assert!(runtime.block_on(copied_file("https://example.com/a.pdf".into())).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
