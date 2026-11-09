//! Thin wrapper over the OS keychain (Windows Credential Manager, macOS
//! Keychain). Each secret is stored under this app's service name plus a key.
//!
//! On a Mac, all of them share one keychain item, read once per launch: the
//! keychain asks for your password after each update (a self-signed app has
//! no Apple Team ID for it to recognise updates by; see docs/mac-signing.md),
//! and once per item, so one item means one prompt.

use keyring::Entry;

use crate::error::Result;

/// The app's original identifier. Kept after the app ID changed to
/// com.lukesassa.calendar so existing sign-ins stay where they are.
const SERVICE: &str = "com.mycalendar.app";

/// JSON list of the signed-in Google accounts and their refresh tokens.
pub const GOOGLE_ACCOUNTS: &str = "google-accounts";
/// Where the one Google account's refresh token lived before the app
/// supported several. Moved into `GOOGLE_ACCOUNTS` on first use.
pub const LEGACY_GOOGLE_REFRESH_TOKEN: &str = "google-refresh-token";
pub const TODOIST_TOKEN: &str = "todoist-token";
/// Google Routes API key for traffic-aware leave-by times. Not the OAuth client.
pub const ROUTES_API_KEY: &str = "routes-api-key";
/// TomTom API key for place search, when OpenStreetMap doesn't know a place.
pub const TOMTOM_API_KEY: &str = "tomtom-api-key";

#[cfg(not(target_os = "macos"))]
pub fn get(key: &str) -> Result<Option<String>> {
    read(key)
}

#[cfg(not(target_os = "macos"))]
pub fn set(key: &str, value: &str) -> Result<()> {
    Entry::new(SERVICE, key)?.set_password(value)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn delete(key: &str) -> Result<()> {
    remove(key)
}

fn read(key: &str) -> Result<Option<String>> {
    match Entry::new(SERVICE, key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn remove(key: &str) -> Result<()> {
    match Entry::new(SERVICE, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(target_os = "macos")]
pub use combined::{delete, get, set};

/// Mac: every secret in one keychain item, `SECRETS`, as a JSON object.
#[cfg(target_os = "macos")]
mod combined {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use super::*;

    const SECRETS: &str = "secrets";
    /// The separate items from before, moved into `SECRETS` the first time.
    const OLD_ITEMS: [&str; 3] = [GOOGLE_ACCOUNTS, LEGACY_GOOGLE_REFRESH_TOKEN, TODOIST_TOKEN];

    /// The item's contents once read, so it's read once per launch.
    static CACHE: Mutex<Option<BTreeMap<String, String>>> = Mutex::new(None);

    pub fn get(key: &str) -> Result<Option<String>> {
        with_secrets(|secrets| Ok((secrets.get(key).cloned(), false)))
    }

    pub fn set(key: &str, value: &str) -> Result<()> {
        with_secrets(|secrets| {
            let changed = secrets.get(key).map(String::as_str) != Some(value);
            secrets.insert(key.to_string(), value.to_string());
            Ok(((), changed))
        })
    }

    pub fn delete(key: &str) -> Result<()> {
        with_secrets(|secrets| Ok(((), secrets.remove(key).is_some())))
    }

    /// Runs `f` on the secrets (loading them first if need be), and saves
    /// them if it says it changed them.
    fn with_secrets<T>(f: impl FnOnce(&mut BTreeMap<String, String>) -> Result<(T, bool)>) -> Result<T> {
        let mut cache = CACHE.lock().expect("not poisoned");
        if cache.is_none() {
            *cache = Some(load()?);
        }
        let secrets = cache.as_mut().expect("loaded above");
        let (result, changed) = f(secrets)?;
        if changed {
            save(secrets)?;
        }
        Ok(result)
    }

    fn load() -> Result<BTreeMap<String, String>> {
        if let Some(json) = read(SECRETS)? {
            return Ok(serde_json::from_str(&json).unwrap_or_default());
        }
        // First run with one item: move the old ones in (macOS asks for each
        // one this once), then remove them.
        let mut secrets = BTreeMap::new();
        for key in OLD_ITEMS {
            if let Some(value) = read(key)? {
                secrets.insert(key.to_string(), value);
            }
        }
        if !secrets.is_empty() {
            save(&secrets)?;
            for key in OLD_ITEMS {
                let _ = remove(key);
            }
        }
        Ok(secrets)
    }

    fn save(secrets: &BTreeMap<String, String>) -> Result<()> {
        if secrets.is_empty() {
            return remove(SECRETS);
        }
        let json = serde_json::to_string(secrets).expect("serializable");
        Entry::new(SERVICE, SECRETS)?.set_password(&json)?;
        Ok(())
    }
}
