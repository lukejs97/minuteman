//! Google sign-in (OAuth 2.0 authorization code + PKCE).
//!
//! 1. Open Google's consent page in the browser, telling Google where to send
//!    the browser back to afterwards (the "redirect URI").
//! 2. Google redirects there with a one-time `code`; the app picks it up:
//!    - desktop ("Desktop app" client): a tiny web server on 127.0.0.1
//!      (see `loopback.rs`);
//!    - iPhone ("iOS" client): a custom URL scheme only this app answers to,
//!      which iOS hands to the app as a deep link (`handle_redirect_url`).
//! 3. Swap the code (plus the PKCE verifier) for tokens.
//!
//! Several Google accounts can be signed in at once. Each one's long-lived
//! refresh token goes to the OS keychain; the short-lived access tokens
//! (about an hour) only ever live in memory.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;
use url::Url;

use super::calendar;
use crate::error::{AppError, Result};
use crate::secrets;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";

/// Lets the app add events. Accounts added before the app asked for it don't
/// have it until they're added again.
const EVENTS_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events";
/// Older grants of the whole Calendar API. It includes adding and deleting events.
const CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar";
/// Lets the Contacts window read and change your Google Contacts. Accounts
/// added before it asked for this don't have it until they're added again.
const CONTACTS_SCOPE: &str = "https://www.googleapis.com/auth/contacts";
/// Lets the app put files you attach to events in your Drive, and see only
/// those (and ones you open with it): not the rest of your Drive. Accounts
/// added before it asked for this don't have it until they're added again.
const DRIVE_FILE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
/// Reading the calendar list needs `calendar.readonly`; `calendar.events`
/// alone only covers events.
const SCOPES: &[&str] =
    &["https://www.googleapis.com/auth/calendar.readonly", EVENTS_SCOPE, CONTACTS_SCOPE, DRIVE_FILE_SCOPE];

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh a little before Google's stated expiry so a request never races it.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

struct OAuthClient {
    id: &'static str,
    /// Google requires this for Desktop clients even with PKCE. It ships inside
    /// the app, so Google does not treat it as a real secret for this client
    /// type. iOS clients have none.
    secret: Option<&'static str>,
}

#[cfg(desktop)]
fn oauth_client() -> Result<OAuthClient> {
    match (option_env!("GOOGLE_CLIENT_ID"), option_env!("GOOGLE_CLIENT_SECRET")) {
        (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => {
            Ok(OAuthClient { id, secret: Some(secret) })
        }
        _ => Err(AppError::Config(
            "The Google OAuth client isn't configured. Copy src-tauri/.env.example to \
             src-tauri/.env, fill in your client ID and secret, then restart `npm run tauri dev`."
                .into(),
        )),
    }
}

#[cfg(mobile)]
fn oauth_client() -> Result<OAuthClient> {
    match option_env!("GOOGLE_IOS_CLIENT_ID") {
        Some(id) if !id.is_empty() => Ok(OAuthClient { id, secret: None }),
        _ => Err(AppError::Config(
            "The Google iOS client isn't configured. Add GOOGLE_IOS_CLIENT_ID to \
             src-tauri/.env and rebuild."
                .into(),
        )),
    }
}

/// Where Google sends an iOS app back to: the client ID reversed, as a URL
/// scheme ("1234-abc.apps.googleusercontent.com" becomes
/// "com.googleusercontent.apps.1234-abc:/oauth2redirect"). The same scheme is
/// registered for the app in tauri.conf.json (plugins → deep-link).
#[cfg(mobile)]
fn ios_redirect_uri(client_id: &str) -> String {
    let scheme: Vec<&str> = client_id.split('.').rev().collect();
    format!("{}:/oauth2redirect", scheme.join("."))
}

/// Reads Google's reply (the URL it redirected to). Returns `None` if the URL
/// isn't a reply at all, e.g. a browser asking for /favicon.ico.
pub(super) fn code_from_redirect(url: &Url, expected_state: &str) -> Option<Result<String>> {
    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    if let Some(error) = params.get("error") {
        // "access_denied" means the user clicked Cancel.
        return Some(Err(AppError::Auth(format!("Google returned \"{error}\""))));
    }
    let code = params.get("code")?;
    if params.get("state").map(String::as_str) != Some(expected_state) {
        return Some(Err(AppError::Auth("the sign-in response didn't match this request".into())));
    }
    Some(Ok(code.clone()))
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
    /// The permissions granted, separated by spaces. Absent when a refresh
    /// didn't change them (RFC 6749): that's not "no permissions".
    #[serde(default)]
    scope: String,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    error_description: Option<String>,
}

impl From<TokenError> for AppError {
    fn from(e: TokenError) -> Self {
        AppError::Auth(match e.error_description {
            Some(description) => format!("{} ({description})", e.error),
            None => e.error,
        })
    }
}

struct AccessToken {
    value: String,
    expires_at: Instant,
    scopes: Vec<String>,
}

impl AccessToken {
    fn new(value: String, expires_in: u64, scopes: Vec<String>) -> Self {
        AccessToken { value, expires_at: Instant::now() + Duration::from_secs(expires_in), scopes }
    }

    fn can_edit_events(&self) -> bool {
        has_scope(&self.scopes, EVENTS_SCOPE)
    }

    fn can_use_contacts(&self) -> bool {
        has_scope(&self.scopes, CONTACTS_SCOPE)
    }

    fn can_attach_files(&self) -> bool {
        has_scope(&self.scopes, DRIVE_FILE_SCOPE)
    }
}

/// A signed-in Google account, as saved in the keychain.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    email: String,
    refresh_token: String,
    /// What this account granted. Kept because a later refresh may omit `scope`.
    #[serde(default)]
    scopes: Vec<String>,
}

/// The scope strings in a token response (spaces, or the commas and pluses a
/// redirect sometimes uses).
fn parse_scopes(scope: &str) -> Vec<String> {
    scope
        .split(|c: char| c.is_whitespace() || c == ',' || c == '+')
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(str::to_string)
        .collect()
}

/// Scopes this access token carries. When the response leaves `scope` out,
/// the ones saved with the account still apply.
fn scopes_for(response_scope: &str, saved: &[String]) -> Vec<String> {
    let granted = parse_scopes(response_scope);
    if granted.is_empty() { saved.to_vec() } else { granted }
}

/// Whether `scopes` includes `scope`. The whole Calendar scope counts as
/// permission to edit events.
fn has_scope(scopes: &[String], scope: &str) -> bool {
    scopes.iter().any(|granted| granted == scope)
        || (scope == EVENTS_SCOPE && scopes.iter().any(|granted| granted == CALENDAR_SCOPE))
}

fn read_accounts() -> Result<Vec<Account>> {
    match secrets::get(secrets::GOOGLE_ACCOUNTS)? {
        Some(json) => serde_json::from_str(&json)
            .map_err(|e| AppError::Config(format!("the saved Google accounts couldn't be read: {e}"))),
        None => Ok(Vec::new()),
    }
}

fn write_accounts(accounts: &[Account]) -> Result<()> {
    if accounts.is_empty() {
        return secrets::delete(secrets::GOOGLE_ACCOUNTS);
    }
    secrets::set(secrets::GOOGLE_ACCOUNTS, &serde_json::to_string(accounts).expect("serializable"))
}

/// Owns the Google sessions: adds accounts, hands out a valid access token
/// for each on request (refreshing it when needed), and removes them.
pub struct GoogleAuth {
    http: reqwest::Client,
    /// By account email.
    access_tokens: Mutex<HashMap<String, AccessToken>>,
    /// Held while changing the saved account list, so two changes at once
    /// can't undo each other. Never taken while holding `access_tokens`.
    store: Mutex<()>,
    /// iOS: while a sign-in is waiting, where to deliver Google's redirect.
    #[cfg(mobile)]
    pending_redirect: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Url>>>,
}

impl GoogleAuth {
    pub fn new(http: reqwest::Client) -> Self {
        GoogleAuth {
            http,
            access_tokens: Mutex::new(HashMap::new()),
            store: Mutex::new(()),
            #[cfg(mobile)]
            pending_redirect: std::sync::Mutex::new(None),
        }
    }

    /// iOS: called with every URL the app is opened with (deep links). Passes
    /// Google's sign-in redirect to the waiting `sign_in`.
    #[cfg(mobile)]
    pub fn handle_redirect_url(&self, url: &Url) {
        if !url.path().ends_with("oauth2redirect") {
            return;
        }
        if let Some(waiting) = self.pending_redirect.lock().expect("not poisoned").take() {
            let _ = waiting.send(url.clone());
        }
    }

    /// True if any account is saved in the keychain. Doesn't touch the network.
    pub fn is_signed_in(&self) -> Result<bool> {
        Ok(!read_accounts()?.is_empty()
            || secrets::get(secrets::LEGACY_GOOGLE_REFRESH_TOKEN)?.is_some())
    }

    /// The signed-in accounts' email addresses, in the order they were added.
    pub async fn accounts(&self) -> Result<Vec<String>> {
        self.migrate_legacy_account().await?;
        Ok(read_accounts()?.into_iter().map(|account| account.email).collect())
    }

    /// Returns an access token for `email`'s account to put in API requests,
    /// refreshing it first if it's missing or about to expire.
    pub async fn access_token(&self, email: &str) -> Result<String> {
        let mut cached = self.access_tokens.lock().await;
        if let Some(token) = cached.get(email)
            && token.expires_at > Instant::now() + EXPIRY_MARGIN
        {
            return Ok(token.value.clone());
        }

        let account = read_accounts()?
            .into_iter()
            .find(|account| account.email == email)
            .ok_or(AppError::NotSignedIn)?;
        match self.refresh(&account.refresh_token).await? {
            Some(tokens) => {
                let scopes = self.granted_scopes(&tokens, &account.scopes).await;
                let token = AccessToken::new(tokens.access_token, tokens.expires_in, scopes.clone());
                let value = token.value.clone();
                cached.insert(email.to_string(), token);
                drop(cached);
                // The keychain lock is never taken while `access_tokens` is held.
                if scopes != account.scopes
                    && let Err(e) = self.remember_scopes(email, &scopes).await
                {
                    eprintln!("Couldn't save Google permissions: {e}");
                }
                Ok(value)
            }
            // Forget the account so the UI asks to add it again.
            None => {
                cached.remove(email);
                drop(cached);
                self.take_account(email).await?;
                Err(AppError::NotSignedIn)
            }
        }
    }

    /// Whether `email`'s account has allowed the app to add events.
    pub async fn can_edit_events(&self, email: &str) -> Result<bool> {
        self.access_token(email).await?;
        let cached = self.access_tokens.lock().await;
        Ok(cached.get(email).is_some_and(|token| token.can_edit_events()))
    }

    /// Whether `email`'s account has allowed the app to put attached files in its Drive.
    pub async fn can_attach_files(&self, email: &str) -> Result<bool> {
        self.access_token(email).await?;
        let cached = self.access_tokens.lock().await;
        Ok(cached.get(email).is_some_and(|token| token.can_attach_files()))
    }

    /// Whether `email`'s account has allowed the app to use its contacts.
    pub async fn can_use_contacts(&self, email: &str) -> Result<bool> {
        self.access_token(email).await?;
        let cached = self.access_tokens.lock().await;
        Ok(cached.get(email).is_some_and(|token| token.can_use_contacts()))
    }

    /// Scopes on `tokens`. A refresh that omits `scope` keeps `saved`; if
    /// nothing was saved yet (an account from before scopes were kept), ask
    /// Google what this access token can do.
    async fn granted_scopes(&self, tokens: &TokenResponse, saved: &[String]) -> Vec<String> {
        let scopes = scopes_for(&tokens.scope, saved);
        if !scopes.is_empty() {
            return scopes;
        }
        self.scopes_from_tokeninfo(&tokens.access_token).await
    }

    /// Writes `scopes` onto `email`'s saved account when they aren't there yet.
    async fn remember_scopes(&self, email: &str, scopes: &[String]) -> Result<()> {
        if scopes.is_empty() {
            return Ok(());
        }
        let _store = self.store.lock().await;
        let mut accounts = read_accounts()?;
        let Some(account) = accounts.iter_mut().find(|account| account.email == email) else {
            return Ok(());
        };
        if account.scopes == scopes {
            return Ok(());
        }
        account.scopes = scopes.to_vec();
        write_accounts(&accounts)
    }

    /// What `access_token` was granted, from Google's tokeninfo. Empty if
    /// that can't be reached: the calendar still loads, and the next refresh
    /// tries again.
    async fn scopes_from_tokeninfo(&self, access_token: &str) -> Vec<String> {
        #[derive(Deserialize)]
        struct Info {
            #[serde(default)]
            scope: String,
        }
        let Ok(response) = self
            .http
            .get("https://oauth2.googleapis.com/tokeninfo")
            .query(&[("access_token", access_token)])
            .send()
            .await
        else {
            return Vec::new();
        };
        if !response.status().is_success() {
            return Vec::new();
        }
        response.json::<Info>().await.ok().map(|info| parse_scopes(&info.scope)).unwrap_or_default()
    }

    /// Trades a refresh token for a new access token. `None` means Google no
    /// longer accepts the refresh token: it was revoked or expired (e.g. the
    /// app is still in "Testing" and 7 days passed).
    async fn refresh(&self, refresh_token: &str) -> Result<Option<TokenResponse>> {
        let client = oauth_client()?;
        match self
            .post_token(&client, &[("refresh_token", refresh_token), ("grant_type", "refresh_token")])
            .await?
        {
            Ok(tokens) => Ok(Some(tokens)),
            Err(e) if e.error == "invalid_grant" => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Versions that supported only one account kept its refresh token on its
    /// own. Moves it into the account list as the first account, which needs
    /// the network once to learn its email address.
    async fn migrate_legacy_account(&self) -> Result<()> {
        let _store = self.store.lock().await;
        let Some(refresh_token) = secrets::get(secrets::LEGACY_GOOGLE_REFRESH_TOKEN)? else {
            return Ok(());
        };
        if let Some(tokens) = self.refresh(&refresh_token).await? {
            let email = calendar::primary_email(&self.http, &tokens.access_token).await?;
            let scopes = self.granted_scopes(&tokens, &[]).await;
            let mut accounts = read_accounts()?;
            if !accounts.iter().any(|account| account.email == email) {
                accounts.insert(0, Account { email: email.clone(), refresh_token, scopes: scopes.clone() });
                write_accounts(&accounts)?;
            }
            self.access_tokens
                .lock()
                .await
                .insert(email, AccessToken::new(tokens.access_token, tokens.expires_in, scopes));
        }
        secrets::delete(secrets::LEGACY_GOOGLE_REFRESH_TOKEN)
    }

    /// Signs in to a Google account in the browser and adds it (or renews it,
    /// if it's already added). Returns its email address.
    pub async fn sign_in(&self, app: &AppHandle) -> Result<String> {
        let client = oauth_client()?;

        // PKCE ("pixie"): we keep a random `verifier` and send Google only its
        // SHA-256 hash (the `challenge`). When we later trade the code for
        // tokens we reveal the verifier, proving we're the app that started
        // this sign-in, so a code intercepted by another program is useless.
        let verifier = random_urlsafe(32);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        // Echoed back by Google; guards against a forged redirect.
        let state = random_urlsafe(16);

        #[cfg(desktop)]
        let loopback = super::loopback::Loopback::bind().await?;
        #[cfg(desktop)]
        let redirect_uri = loopback.redirect_uri.clone();
        #[cfg(mobile)]
        let redirect_uri = ios_redirect_uri(client.id);

        let mut auth_url = Url::parse(AUTH_URL).expect("valid URL");
        auth_url
            .query_pairs_mut()
            .append_pair("client_id", client.id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", &SCOPES.join(" "))
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            // "offline" = also give us a refresh token; "consent" makes Google
            // return one even if this account approved the app before;
            // "select_account" lets you pick which account to add, rather than
            // Google assuming the one the browser is signed in to.
            .append_pair("access_type", "offline")
            .append_pair("prompt", "select_account consent");

        #[cfg(mobile)]
        let redirect = {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            *self.pending_redirect.lock().expect("not poisoned") = Some(sender);
            receiver
        };

        app.opener()
            .open_url(auth_url.as_str(), None::<&str>)
            .map_err(|e| AppError::Auth(format!("couldn't open the browser: {e}")))?;

        #[cfg(desktop)]
        let waiting = loopback.wait_for_code(state);
        #[cfg(mobile)]
        let waiting = async {
            let url = redirect.await.map_err(|_| AppError::Auth("sign-in was interrupted".into()))?;
            code_from_redirect(&url, &state)
                .unwrap_or_else(|| Err(AppError::Auth("Google's reply had no sign-in code".into())))
        };
        let code = tokio::time::timeout(SIGN_IN_TIMEOUT, waiting)
            .await
            .map_err(|_| AppError::Auth("timed out waiting for the browser".into()))??;

        let tokens = self
            .post_token(
                &client,
                &[
                    ("code", code.as_str()),
                    ("code_verifier", verifier.as_str()),
                    ("grant_type", "authorization_code"),
                    ("redirect_uri", redirect_uri.as_str()),
                ],
            )
            .await??;

        let refresh_token = tokens
            .refresh_token
            .clone()
            .ok_or_else(|| AppError::Auth("Google didn't return a refresh token".into()))?;
        let email = calendar::primary_email(&self.http, &tokens.access_token).await?;
        let saved = read_accounts()?
            .into_iter()
            .find(|account| account.email == email)
            .map(|account| account.scopes)
            .unwrap_or_default();
        let scopes = self.granted_scopes(&tokens, &saved).await;
        {
            let _store = self.store.lock().await;
            let mut accounts = read_accounts()?;
            let account = Account { email: email.clone(), refresh_token, scopes: scopes.clone() };
            match accounts.iter_mut().find(|existing| existing.email == email) {
                Some(existing) => *existing = account,
                None => accounts.push(account),
            }
            write_accounts(&accounts)?;
        }
        self.access_tokens
            .lock()
            .await
            .insert(email.clone(), AccessToken::new(tokens.access_token, tokens.expires_in, scopes));

        // The browser has focus now; bring the app back to the front. (On iOS,
        // following the redirect already switched back to the app.)
        #[cfg(desktop)]
        if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        Ok(email)
    }

    /// Signs `email`'s account out of the app.
    pub async fn remove_account(&self, email: &str) -> Result<()> {
        self.access_tokens.lock().await.remove(email);
        if let Some(account) = self.take_account(email).await? {
            // Ask Google to invalidate the token too. Best effort: still
            // remove it locally when offline.
            let _ = self.http.post(REVOKE_URL).form(&[("token", account.refresh_token)]).send().await;
        }
        Ok(())
    }

    /// Deletes `email`'s account from the keychain and returns it.
    async fn take_account(&self, email: &str) -> Result<Option<Account>> {
        let _store = self.store.lock().await;
        let mut accounts = read_accounts()?;
        let Some(index) = accounts.iter().position(|account| account.email == email) else {
            return Ok(None);
        };
        let account = accounts.remove(index);
        write_accounts(&accounts)?;
        Ok(Some(account))
    }

    /// POSTs to Google's token endpoint, adding the client's ID (and secret,
    /// if it has one). The outer `Result` is for transport failures; the inner
    /// one is Google's answer.
    async fn post_token(
        &self,
        client: &OAuthClient,
        form: &[(&str, &str)],
    ) -> Result<std::result::Result<TokenResponse, TokenError>> {
        let mut fields = vec![("client_id", client.id)];
        if let Some(secret) = client.secret {
            fields.push(("client_secret", secret));
        }
        fields.extend_from_slice(form);

        let response = self.http.post(TOKEN_URL).form(&fields).send().await?;
        if response.status().is_success() {
            Ok(Ok(response.json().await?))
        } else {
            Ok(Err(response.json().await?))
        }
    }
}

fn random_urlsafe(num_bytes: usize) -> String {
    let mut bytes = vec![0u8; num_bytes];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved() -> Vec<String> {
        vec![
            "https://www.googleapis.com/auth/calendar.readonly".into(),
            EVENTS_SCOPE.into(),
            CONTACTS_SCOPE.into(),
        ]
    }

    #[test]
    fn a_refresh_that_omits_scope_keeps_the_grant() {
        // Google may leave `scope` out when it hasn't changed. That used to
        // look like "no permission", so Edit, Delete and Contacts disappeared
        // after the first refresh (every launch).
        let scopes = scopes_for("", &saved());
        assert!(has_scope(&scopes, EVENTS_SCOPE));
        assert!(has_scope(&scopes, CONTACTS_SCOPE));
    }

    #[test]
    fn a_refresh_that_names_scopes_replaces_what_was_saved() {
        let scopes = scopes_for(CONTACTS_SCOPE, &saved());
        assert!(!has_scope(&scopes, EVENTS_SCOPE));
        assert!(has_scope(&scopes, CONTACTS_SCOPE));
    }

    #[test]
    fn scopes_split_on_spaces_commas_and_pluses() {
        let scopes = parse_scopes(&format!(
            "{EVENTS_SCOPE}+{CONTACTS_SCOPE}, https://www.googleapis.com/auth/calendar.readonly"
        ));
        assert!(has_scope(&scopes, EVENTS_SCOPE));
        assert!(has_scope(&scopes, CONTACTS_SCOPE));
        assert_eq!(scopes.len(), 3);
    }

    #[test]
    fn the_full_calendar_scope_may_edit_events() {
        let scopes = vec![CALENDAR_SCOPE.into()];
        assert!(has_scope(&scopes, EVENTS_SCOPE));
        assert!(!has_scope(&scopes, CONTACTS_SCOPE));
    }

    #[test]
    fn an_account_saved_before_scopes_still_loads() {
        let accounts: Vec<Account> = serde_json::from_str(r#"[{"email":"a@b.c","refreshToken":"token"}]"#).unwrap();
        assert!(accounts[0].scopes.is_empty());
        assert_eq!(accounts[0].email, "a@b.c");
    }
}
