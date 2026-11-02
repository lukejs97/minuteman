//! Settings the Rust side needs while no window is open (the menu bar's next
//! event, time-to-leave alerts, Apple Calendar and Reminders), kept in
//! `preferences.json` in the app's config folder. The window's own settings
//! (e.g. the multi-day view's days) stay in its local storage.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// Show the next event's name and time beside the menu bar icon (macOS).
    pub menu_bar_next: bool,
    /// Alert when it's time to leave for events with a place that don't set
    /// their own leave alert. With a leave-from address this uses Routes;
    /// on a Mac with no address it uses the Mac's location.
    pub time_to_leave: bool,
    /// Default starting address for leave-by times. An event can override it.
    pub leave_from: String,
    /// Start drives from where the device is, when that's known (the address
    /// is then the fallback). An event's own address still wins.
    pub leave_from_here: bool,
    /// Routes attempts allowed per Pacific day. Clamped; never unlimited.
    pub routes_daily_limit: u32,
    /// Routes attempts allowed per Pacific month. Clamped; never unlimited.
    pub routes_monthly_limit: u32,
    /// Show events from the Mac's Calendar app (EventKit).
    pub apple_calendar: bool,
    /// Show reminders from the Mac's Reminders app (EventKit).
    pub apple_reminders: bool,
    /// Apple calendars and reminder lists shown (true) or left out (false),
    /// by identifier, where chosen in Settings. Others follow apple.rs's
    /// default: shown, unless they look like a Google account's (already
    /// shown from Google directly).
    pub apple_calendars_shown: BTreeMap<String, bool>,
    /// Google calendars hidden in Settings, by account email, then calendar
    /// ID. Every other calendar is shown.
    pub google_calendars_hidden: BTreeMap<String, BTreeSet<String>>,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            menu_bar_next: true,
            time_to_leave: false,
            leave_from: String::new(),
            leave_from_here: false,
            routes_daily_limit: crate::leave::DEFAULT_DAILY,
            routes_monthly_limit: crate::leave::DEFAULT_MONTHLY,
            apple_calendar: false,
            apple_reminders: false,
            apple_calendars_shown: BTreeMap::new(),
            google_calendars_hidden: BTreeMap::new(),
        }
    }
}

static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static PREFS: Mutex<Option<Prefs>> = Mutex::new(None);

/// Reads the file at `path` once at startup; missing or unreadable means defaults.
pub fn init(path: Option<PathBuf>) {
    let prefs = path
        .as_ref()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    *PREFS.lock().expect("not poisoned") = Some(prefs);
    let _ = PATH.set(path);
}

pub fn get() -> Prefs {
    PREFS.lock().expect("not poisoned").clone().unwrap_or_default()
}

impl Prefs {
    /// The Mac's location is only followed for time-to-leave when no starting
    /// address is set. An address is looked up from Routes instead.
    pub fn uses_device_location(&self) -> bool {
        self.time_to_leave && self.leave_from.trim().is_empty()
    }
}

/// Whether the Google calendar `id` of `account` is shown (not hidden in Settings).
pub fn google_calendar_shown(account: &str, id: &str) -> bool {
    !get().google_calendars_hidden.get(account).is_some_and(|hidden| hidden.contains(id))
}

/// Shows or hides one Google calendar.
pub fn set_google_calendar_shown(account: &str, id: &str, shown: bool) {
    let mut prefs = get();
    let hidden = prefs.google_calendars_hidden.entry(account.to_string()).or_default();
    if shown {
        hidden.remove(id);
    } else {
        hidden.insert(id.to_string());
    }
    if hidden.is_empty() {
        prefs.google_calendars_hidden.remove(account);
    }
    set(prefs);
}

/// Saves `prefs` (best effort: if the file can't be written, they last until quit).
pub fn set(prefs: Prefs) {
    if let Some(Some(path)) = PATH.get()
        && let Ok(json) = serde_json::to_vec_pretty(&prefs)
    {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let temporary = path.with_extension("json.tmp");
        if std::fs::write(&temporary, json).is_ok() {
            let _ = std::fs::rename(&temporary, path);
        }
    }
    *PREFS.lock().expect("not poisoned") = Some(prefs);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_calendars_can_be_hidden_and_shown_again() {
        assert!(google_calendar_shown("me@example.com", "work"));
        set_google_calendar_shown("me@example.com", "work", false);
        assert!(!google_calendar_shown("me@example.com", "work"));
        assert!(google_calendar_shown("other@example.com", "work"));
        set_google_calendar_shown("me@example.com", "work", true);
        assert!(google_calendar_shown("me@example.com", "work"));
        // Nothing left hidden for the account: no empty entry kept.
        assert!(!get().google_calendars_hidden.contains_key("me@example.com"));
    }

    #[test]
    fn missing_fields_take_their_defaults() {
        let prefs: Prefs = serde_json::from_str(r#"{"timeToLeave": true}"#).unwrap();
        assert!(prefs.time_to_leave);
        assert!(prefs.menu_bar_next);
        assert!(!prefs.apple_calendar);
        assert!(prefs.leave_from.is_empty());
        assert!(prefs.uses_device_location());
        assert_eq!(prefs.routes_daily_limit, crate::leave::DEFAULT_DAILY);
        assert_eq!(prefs.routes_monthly_limit, crate::leave::DEFAULT_MONTHLY);
    }
}
