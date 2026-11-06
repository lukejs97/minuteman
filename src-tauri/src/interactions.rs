//! Your history with people in Contacts: calls, messages, emails and
//! FaceTimes started from Minuteman, meetings set up with them, notes, and
//! ones you log yourself ("called Sam about the lease"). It's what the
//! Contacts window's Recent list and each card's History are made from.
//!
//! Kept in interactions.json in the app's config folder (beside
//! preferences.json): it's yours, not a cache, so it isn't in the cache folder.

use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Local;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// The most kept; the oldest go first.
const MAX_ENTRIES: usize = 5000;
/// The longest detail kept (a note, an email's subject).
const MAX_DETAIL: usize = 2000;
/// What can be logged (see `KIND_WORDS` in src/contacts/history.ts).
const KINDS: &[&str] = &["call", "message", "email", "facetime", "meeting", "met", "note", "added"];

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Interaction {
    /// The contact's ID, "<account>/<resourceName>".
    pub contact_id: String,
    /// One of `KINDS`.
    pub kind: String,
    /// When (RFC 3339).
    pub at: String,
    /// A note's text, an email's subject, what a meeting was…
    pub detail: Option<String>,
}

/// An interaction to log; it's stamped with the time here.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewInteraction {
    pub contact_id: String,
    pub kind: String,
    pub detail: Option<String>,
}

pub struct Interactions {
    path: Option<PathBuf>,
    entries: Mutex<Vec<Interaction>>,
}

impl Interactions {
    /// Reads the file at `path`. A missing or unreadable file means no history yet.
    pub fn load(path: Option<PathBuf>) -> Self {
        let entries = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Interactions { path, entries: Mutex::new(entries) }
    }

    /// Everything logged, oldest first.
    pub fn all(&self) -> Vec<Interaction> {
        self.entries.lock().expect("not poisoned").clone()
    }

    /// Logs one now; returns it as kept.
    pub fn log(&self, new: NewInteraction) -> Result<Interaction> {
        if !KINDS.contains(&new.kind.as_str()) {
            return Err(AppError::InvalidInput(format!("not a kind of interaction: {:?}", new.kind)));
        }
        if !new.contact_id.contains("/people/") {
            return Err(AppError::InvalidInput(format!("not a contact: {:?}", new.contact_id)));
        }
        let detail = new
            .detail
            .map(|d| d.trim().chars().take(MAX_DETAIL).collect::<String>())
            .filter(|d| !d.is_empty());
        let entry = Interaction { contact_id: new.contact_id, kind: new.kind, at: Local::now().to_rfc3339(), detail };
        let mut entries = self.entries.lock().expect("not poisoned");
        entries.push(entry.clone());
        if entries.len() > MAX_ENTRIES {
            let extra = entries.len() - MAX_ENTRIES;
            entries.drain(..extra);
        }
        self.write(&entries);
        Ok(entry)
    }

    /// Forgets a deleted contact's history.
    pub fn forget_contact(&self, contact_id: &str) {
        self.retain(|e| e.contact_id != contact_id);
    }

    /// Gives what's logged with contacts merged into another to that one.
    pub fn move_contacts(&self, from: &[String], to: &str) {
        let mut entries = self.entries.lock().expect("not poisoned");
        let mut moved = false;
        for entry in entries.iter_mut().filter(|e| from.contains(&e.contact_id)) {
            entry.contact_id = to.to_string();
            moved = true;
        }
        if moved {
            self.write(&entries);
        }
    }

    /// Forgets the history with a removed account's contacts.
    pub fn forget_account(&self, account: &str) {
        let prefix = format!("{account}/");
        self.retain(|e| !e.contact_id.starts_with(&prefix));
    }

    fn retain(&self, keep: impl Fn(&Interaction) -> bool) {
        let mut entries = self.entries.lock().expect("not poisoned");
        let before = entries.len();
        entries.retain(|e| keep(e));
        if entries.len() != before {
            self.write(&entries);
        }
    }

    /// Best effort, written whole each time (it's small); a failed write is ignored.
    fn write(&self, entries: &[Interaction]) {
        let Some(path) = &self.path else { return };
        let Ok(json) = serde_json::to_vec(entries) else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let temporary = path.with_extension("json.tmp");
        if std::fs::write(&temporary, json).is_ok() {
            let _ = std::fs::rename(&temporary, path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(contact_id: &str, kind: &str) -> NewInteraction {
        NewInteraction { contact_id: contact_id.into(), kind: kind.into(), detail: Some("  hi  ".into()) }
    }

    #[test]
    fn logs_and_forgets() {
        let log = Interactions::load(None);
        let entry = log.log(new("a@x.com/people/c1", "call")).unwrap();
        assert_eq!(entry.detail.as_deref(), Some("hi"));
        log.log(new("b@x.com/people/c2", "note")).unwrap();
        log.log(new("a@x.com/people/c3", "met")).unwrap();
        log.forget_contact("a@x.com/people/c1");
        assert_eq!(log.all().len(), 2);
        log.forget_account("a@x.com");
        assert_eq!(log.all().iter().map(|e| e.contact_id.as_str()).collect::<Vec<_>>(), ["b@x.com/people/c2"]);
    }

    #[test]
    fn refuses_unknown_kinds_and_ids() {
        let log = Interactions::load(None);
        assert!(log.log(new("a@x.com/people/c1", "hug")).is_err());
        assert!(log.log(new("../etc/passwd", "call")).is_err());
    }
}
