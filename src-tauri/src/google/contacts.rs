//! Google People API v1: the contacts in an account (what Google Contacts
//! shows), and adding, changing, starring and deleting them, and their photos.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use url::Url;

use super::calendar::send;
use crate::error::{AppError, Result};

const API: &str = "https://people.googleapis.com/v1";

/// The parts of a contact the app shows and edits.
const PERSON_FIELDS: &str = "names,nicknames,emailAddresses,phoneNumbers,addresses,organizations,birthdays,\
                             biographies,urls,photos,memberships,metadata,relations";

/// The group Google Contacts calls "Favorites".
const STARRED: &str = "contactGroups/starred";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionsPage {
    #[serde(default)]
    connections: Vec<Person>,
    next_page_token: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Person {
    resource_name: String,
    etag: Option<String>,
    metadata: Option<PersonMetadata>,
    names: Vec<Name>,
    nicknames: Vec<Text>,
    email_addresses: Vec<Field>,
    phone_numbers: Vec<Field>,
    addresses: Vec<Address>,
    organizations: Vec<Organization>,
    birthdays: Vec<GoogleBirthday>,
    biographies: Vec<Text>,
    urls: Vec<Field>,
    photos: Vec<Photo>,
    memberships: Vec<Membership>,
    relations: Vec<Relation>,
}

/// Someone they're related to: a name, and how ("spouse", "child"…, or your own word).
#[derive(Deserialize, Default)]
#[serde(default)]
struct Relation {
    person: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

/// What Google sends back after a photo is changed.
#[derive(Deserialize, Default)]
#[serde(default)]
struct PhotoResponse {
    person: Option<Person>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PersonMetadata {
    deleted: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Name {
    display_name: Option<String>,
    given_name: Option<String>,
    family_name: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Text {
    value: Option<String>,
}

/// An email address, phone number or web address, with its label.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Field {
    value: Option<String>,
    /// "home", "work", "mobile"… or a label of your own.
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Address {
    formatted_value: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Organization {
    name: Option<String>,
    title: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct GoogleBirthday {
    date: Option<Birthday>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Photo {
    url: Option<String>,
    /// Google's own letter picture, for contacts without a photo.
    default: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Membership {
    contact_group_membership: Option<GroupMembership>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct GroupMembership {
    contact_group_resource_name: Option<String>,
}

/// A value with its label: `label` is Google's type ("home", "work",
/// "mobile"…, or one of your own).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Labeled {
    pub value: String,
    pub label: Option<String>,
}

/// A birthday; Google allows one without a year.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Birthday {
    pub year: Option<i32>,
    pub month: u32,
    pub day: u32,
}

/// One person in an account's contacts.
// Deserialize: contacts are also saved to disk for offline use (contacts.rs).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    /// Unique across accounts: "<account>/<resourceName>".
    pub id: String,
    /// The Google account it's in.
    pub account: String,
    /// Google's ID for it, "people/c123…".
    pub resource_name: String,
    /// Google's version of it; saving a change needs the latest.
    pub etag: Option<String>,
    /// As Google shows it ("Sam Lee"); empty if it has no name.
    pub name: String,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
    pub nickname: Option<String>,
    pub organization: Option<String>,
    pub job_title: Option<String>,
    pub emails: Vec<Labeled>,
    pub phones: Vec<Labeled>,
    pub addresses: Vec<Labeled>,
    pub urls: Vec<Labeled>,
    pub birthday: Option<Birthday>,
    pub notes: Option<String>,
    /// A photo you or they added (not Google's letter picture).
    pub photo: Option<String>,
    /// In Favorites.
    pub starred: bool,
    /// People they're related to: `value` a name, `label` how ("spouse", "child"…).
    #[serde(default)]
    pub relations: Vec<Labeled>,
}

/// A new contact, or changes to one. For changes, a field left out (null)
/// stays as it is; an empty one is cleared.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ContactDraft {
    /// Names are saved together: give both, or neither.
    pub given_name: Option<String>,
    pub family_name: Option<String>,
    pub nickname: Option<String>,
    /// Saved together with `job_title`.
    pub organization: Option<String>,
    pub job_title: Option<String>,
    pub emails: Option<Vec<Labeled>>,
    pub phones: Option<Vec<Labeled>>,
    pub addresses: Option<Vec<Labeled>>,
    pub urls: Option<Vec<Labeled>>,
    /// Empty clears the birthday.
    pub birthdays: Option<Vec<Birthday>>,
    pub notes: Option<String>,
    pub relations: Option<Vec<Labeled>>,
}

impl ContactDraft {
    /// The People API's person, and which of its fields are given (for
    /// `updatePersonFields`).
    fn to_json(&self) -> (Value, Vec<&'static str>) {
        let mut person = Map::new();
        let mut fields = Vec::new();
        let mut put = |field: &'static str, value: Value| {
            person.insert(field.to_string(), value);
            fields.push(field);
        };
        let text = |s: &Option<String>| s.as_deref().map(str::trim).unwrap_or_default().to_string();

        if self.given_name.is_some() || self.family_name.is_some() {
            let (given, family) = (text(&self.given_name), text(&self.family_name));
            let names = if given.is_empty() && family.is_empty() {
                json!([])
            } else {
                json!([{ "givenName": given, "familyName": family }])
            };
            put("names", names);
        }
        if let Some(nickname) = &self.nickname {
            let nickname = nickname.trim();
            put("nicknames", if nickname.is_empty() { json!([]) } else { json!([{ "value": nickname }]) });
        }
        if self.organization.is_some() || self.job_title.is_some() {
            let (name, title) = (text(&self.organization), text(&self.job_title));
            let organizations =
                if name.is_empty() && title.is_empty() { json!([]) } else { json!([{ "name": name, "title": title }]) };
            put("organizations", organizations);
        }
        if let Some(emails) = &self.emails {
            put("emailAddresses", labeled_json(emails, "value"));
        }
        if let Some(phones) = &self.phones {
            put("phoneNumbers", labeled_json(phones, "value"));
        }
        if let Some(addresses) = &self.addresses {
            put("addresses", labeled_json(addresses, "formattedValue"));
        }
        if let Some(urls) = &self.urls {
            put("urls", labeled_json(urls, "value"));
        }
        if let Some(birthdays) = &self.birthdays {
            let dates: Vec<Value> = birthdays
                .iter()
                .filter(|b| (1..=12).contains(&b.month) && (1..=31).contains(&b.day))
                .map(|b| match b.year {
                    Some(year) => json!({ "date": { "year": year, "month": b.month, "day": b.day } }),
                    None => json!({ "date": { "month": b.month, "day": b.day } }),
                })
                .collect();
            put("birthdays", Value::Array(dates));
        }
        if let Some(notes) = &self.notes {
            let notes = notes.trim();
            let biographies =
                if notes.is_empty() { json!([]) } else { json!([{ "value": notes, "contentType": "TEXT_PLAIN" }]) };
            put("biographies", biographies);
        }
        if let Some(relations) = &self.relations {
            put("relations", labeled_json(relations, "person"));
        }
        (Value::Object(person), fields)
    }

    /// Whether it changes anything.
    pub fn is_empty(&self) -> bool {
        self.to_json().1.is_empty()
    }
}

/// `[{ <key>: value, type: label }]`, leaving out empty values.
fn labeled_json(values: &[Labeled], key: &str) -> Value {
    Value::Array(
        values
            .iter()
            .filter(|v| !v.value.trim().is_empty())
            .map(|v| {
                let mut entry = Map::new();
                entry.insert(key.into(), Value::String(v.value.trim().into()));
                if let Some(label) = v.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
                    entry.insert("type".into(), Value::String(label.into()));
                }
                Value::Object(entry)
            })
            .collect(),
    )
}

/// Every contact in `account`'s Google Contacts.
pub async fn all_contacts(http: &reqwest::Client, token: &str, account: &str) -> Result<Vec<Contact>> {
    let mut contacts = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let mut url = api_url(&["people", "me", "connections"]);
        url.query_pairs_mut()
            .append_pair("personFields", PERSON_FIELDS)
            .append_pair("pageSize", "1000")
            .append_pair("sortOrder", "FIRST_NAME_ASCENDING");
        if let Some(t) = &page_token {
            url.query_pairs_mut().append_pair("pageToken", t);
        }
        let page: ConnectionsPage = send(http.get(url).bearer_auth(token)).await?;
        contacts.extend(page.connections.into_iter().filter_map(|person| to_contact(account, person)));
        match page.next_page_token {
            Some(next) => page_token = Some(next),
            None => return Ok(contacts),
        }
    }
}

/// Adds a contact to `account`; returns it as Google saved it.
pub async fn create_contact(
    http: &reqwest::Client,
    token: &str,
    account: &str,
    draft: &ContactDraft,
) -> Result<Contact> {
    let (person, _) = draft.to_json();
    let mut url = api_url(&["people:createContact"]);
    url.query_pairs_mut().append_pair("personFields", PERSON_FIELDS);
    let saved: Person = send(http.post(url).bearer_auth(token).json(&person)).await?;
    to_contact(account, saved).ok_or_else(|| AppError::Api { status: 500, message: "Google lost the contact".into() })
}

/// Saves changes to a contact (`etag`: the version they were made to);
/// returns it as Google saved it.
pub async fn update_contact(
    http: &reqwest::Client,
    token: &str,
    account: &str,
    resource_name: &str,
    etag: Option<&str>,
    draft: &ContactDraft,
) -> Result<Contact> {
    let (mut person, fields) = draft.to_json();
    if fields.is_empty() {
        return Err(AppError::InvalidInput("nothing to change".into()));
    }
    // Google turns down a change made to an older version than it has.
    person["etag"] = json!(etag);
    let mut url = person_url(resource_name, "updateContact")?;
    url.query_pairs_mut()
        .append_pair("updatePersonFields", &fields.join(","))
        .append_pair("personFields", PERSON_FIELDS);
    let saved: Person = send(http.patch(url).bearer_auth(token).json(&person)).await?;
    to_contact(account, saved).ok_or_else(|| AppError::Api { status: 500, message: "Google lost the contact".into() })
}

pub async fn delete_contact(http: &reqwest::Client, token: &str, resource_name: &str) -> Result<()> {
    let url = person_url(resource_name, "deleteContact")?;
    match send::<Value>(http.delete(url).bearer_auth(token)).await {
        // Already gone, which is what was wanted.
        Err(AppError::Api { status: 404, .. }) => Ok(()),
        other => other.map(|_| ()),
    }
}

/// Adds a contact to Favorites, or takes it out; returns it as it is now
/// (its version changes, which the next edit needs).
pub async fn set_starred(
    http: &reqwest::Client,
    token: &str,
    account: &str,
    resource_name: &str,
    starred: bool,
) -> Result<Contact> {
    let mut person = person_url(resource_name, "")?;
    let url = api_url(&["contactGroups", "starred", "members:modify"]);
    let key = if starred { "resourceNamesToAdd" } else { "resourceNamesToRemove" };
    send::<Value>(http.post(url).bearer_auth(token).json(&json!({ key: [resource_name] }))).await?;
    person.query_pairs_mut().append_pair("personFields", PERSON_FIELDS);
    let saved: Person = send(http.get(person).bearer_auth(token)).await?;
    to_contact(account, saved).ok_or_else(|| AppError::Api { status: 404, message: "the contact was deleted".into() })
}

/// Most a contact's photo can be (Google's limit is larger; the app sends a small square).
pub const MAX_PHOTO_BYTES: usize = 5 * 1024 * 1024;

/// Sets a contact's photo (`photo`: a JPEG or PNG); returns them as they are now.
pub async fn set_photo(
    http: &reqwest::Client,
    token: &str,
    account: &str,
    resource_name: &str,
    photo: &[u8],
) -> Result<Contact> {
    use base64::Engine as _;
    if photo.is_empty() || photo.len() > MAX_PHOTO_BYTES {
        return Err(AppError::InvalidInput("a photo can be up to 5 MB".into()));
    }
    let url = person_url(resource_name, "updateContactPhoto")?;
    let body = json!({
        "photoBytes": base64::engine::general_purpose::STANDARD.encode(photo),
        "personFields": PERSON_FIELDS,
    });
    let saved: PhotoResponse = send(http.patch(url).bearer_auth(token).json(&body)).await?;
    photo_result(http, token, account, resource_name, saved).await
}

/// Takes a contact's photo off; returns them as they are now.
pub async fn remove_photo(http: &reqwest::Client, token: &str, account: &str, resource_name: &str) -> Result<Contact> {
    let mut url = person_url(resource_name, "deleteContactPhoto")?;
    url.query_pairs_mut().append_pair("personFields", PERSON_FIELDS);
    let saved: PhotoResponse = send(http.delete(url).bearer_auth(token)).await?;
    photo_result(http, token, account, resource_name, saved).await
}

/// The person Google sent back, or (if it didn't) them as they are now.
async fn photo_result(
    http: &reqwest::Client,
    token: &str,
    account: &str,
    resource_name: &str,
    saved: PhotoResponse,
) -> Result<Contact> {
    let person = match saved.person {
        Some(person) => person,
        None => {
            let mut url = person_url(resource_name, "")?;
            url.query_pairs_mut().append_pair("personFields", PERSON_FIELDS);
            send(http.get(url).bearer_auth(token)).await?
        }
    };
    to_contact(account, person).ok_or_else(|| AppError::Api { status: 404, message: "the contact was deleted".into() })
}

/// A contact's photo, from where Google keeps it (to give it to another
/// contact when two are merged). Only Google's own photo addresses.
pub async fn photo_bytes(http: &reqwest::Client, photo_url: &str) -> Result<Vec<u8>> {
    let response = http.get(google_photo(photo_url)?).send().await?;
    if !response.status().is_success() {
        return Err(AppError::Api { status: response.status().as_u16(), message: "couldn't get the photo".into() });
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_PHOTO_BYTES {
        return Err(AppError::InvalidInput("the photo is too big".into()));
    }
    Ok(bytes.to_vec())
}

/// `photo_url`, if it's one of Google's photos (https, on googleusercontent.com).
fn google_photo(photo_url: &str) -> Result<Url> {
    let url = Url::parse(photo_url).map_err(|_| AppError::InvalidInput("not a photo address".into()))?;
    let google = url.host_str().is_some_and(|h| h == "googleusercontent.com" || h.ends_with(".googleusercontent.com"));
    if url.scheme() != "https" || !google {
        return Err(AppError::InvalidInput("not one of Google's photos".into()));
    }
    Ok(url)
}

fn api_url(segments: &[&str]) -> Url {
    let mut url = Url::parse(API).expect("valid URL");
    url.path_segments_mut().expect("base URL").extend(segments);
    url
}

/// ".../people/c123:<method>". The name comes from the web view, so it's
/// checked to be a person's ID, not some other path.
fn person_url(resource_name: &str, method: &str) -> Result<Url> {
    let id = resource_name
        .strip_prefix("people/")
        .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .ok_or_else(|| AppError::InvalidInput(format!("not a contact: {resource_name:?}")))?;
    let last = if method.is_empty() { id.to_string() } else { format!("{id}:{method}") };
    Ok(api_url(&["people", &last]))
}

fn to_contact(account: &str, person: Person) -> Option<Contact> {
    if person.resource_name.is_empty() || person.metadata.as_ref().is_some_and(|m| m.deleted) {
        return None;
    }
    let name = person.names.first();
    let organization = person.organizations.first();
    let labeled = |fields: Vec<Field>| -> Vec<Labeled> {
        fields
            .into_iter()
            .filter_map(|f| Some(Labeled { value: f.value.filter(|v| !v.trim().is_empty())?, label: f.kind }))
            .collect()
    };
    Some(Contact {
        id: format!("{account}/{}", person.resource_name),
        account: account.to_string(),
        name: name.and_then(|n| n.display_name.clone()).unwrap_or_default(),
        given_name: name.and_then(|n| n.given_name.clone()),
        family_name: name.and_then(|n| n.family_name.clone()),
        nickname: person.nicknames.into_iter().find_map(|n| n.value),
        organization: organization.and_then(|o| o.name.clone()).filter(|s| !s.is_empty()),
        job_title: organization.and_then(|o| o.title.clone()).filter(|s| !s.is_empty()),
        emails: labeled(person.email_addresses),
        phones: labeled(person.phone_numbers),
        addresses: person
            .addresses
            .into_iter()
            .filter_map(|a| Some(Labeled { value: a.formatted_value.filter(|v| !v.trim().is_empty())?, label: a.kind }))
            .collect(),
        urls: labeled(person.urls),
        birthday: person.birthdays.into_iter().find_map(|b| b.date.filter(|d| d.month > 0 && d.day > 0)),
        notes: person.biographies.into_iter().find_map(|b| b.value).filter(|s| !s.trim().is_empty()),
        photo: person.photos.into_iter().find(|p| !p.default).and_then(|p| p.url),
        starred: person.memberships.iter().any(|m| {
            m.contact_group_membership.as_ref().and_then(|g| g.contact_group_resource_name.as_deref()) == Some(STARRED)
        }),
        relations: person
            .relations
            .into_iter()
            .filter_map(|r| Some(Labeled { value: r.person.filter(|v| !v.trim().is_empty())?, label: r.kind }))
            .collect(),
        etag: person.etag,
        resource_name: person.resource_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_person() {
        let person: Person = serde_json::from_value(json!({
            "resourceName": "people/c42",
            "etag": "%abc",
            "names": [{ "displayName": "Sam Lee", "givenName": "Sam", "familyName": "Lee" }],
            "emailAddresses": [{ "value": "sam@example.com", "type": "work" }, { "value": " " }],
            "phoneNumbers": [{ "value": "+1 555 0100", "type": "mobile" }],
            "organizations": [{ "name": "Acme", "title": "Designer" }],
            "birthdays": [{ "date": { "month": 3, "day": 4 } }],
            "photos": [{ "url": "https://lh3.googleusercontent.com/a", "default": true }],
            "memberships": [{ "contactGroupMembership": { "contactGroupResourceName": "contactGroups/starred" } }]
        }))
        .unwrap();
        let contact = to_contact("me@example.com", person).unwrap();
        assert_eq!(contact.id, "me@example.com/people/c42");
        assert_eq!(contact.name, "Sam Lee");
        assert_eq!(contact.emails.len(), 1);
        assert_eq!(contact.emails[0].label.as_deref(), Some("work"));
        assert_eq!(contact.organization.as_deref(), Some("Acme"));
        assert!(contact.birthday.as_ref().is_some_and(|b| b.year.is_none() && b.month == 3));
        assert!(contact.photo.is_none(), "Google's letter picture isn't a photo");
        assert!(contact.starred);
    }

    #[test]
    fn reads_and_sends_relations() {
        let person: Person = serde_json::from_value(json!({
            "resourceName": "people/c7",
            "relations": [{ "person": "Rachel Revere", "type": "spouse" }, { "person": " " }]
        }))
        .unwrap();
        let contact = to_contact("me@example.com", person).unwrap();
        assert_eq!(contact.relations.len(), 1);
        assert_eq!(contact.relations[0].value, "Rachel Revere");
        assert_eq!(contact.relations[0].label.as_deref(), Some("spouse"));

        let draft = ContactDraft {
            relations: Some(vec![Labeled { value: "Paul Revere Jr.".into(), label: Some("child".into()) }]),
            ..Default::default()
        };
        let (json, fields) = draft.to_json();
        assert_eq!(fields, ["relations"]);
        assert_eq!(json["relations"], json!([{ "person": "Paul Revere Jr.", "type": "child" }]));
        assert!(!draft.is_empty());
        assert!(ContactDraft::default().is_empty());
    }

    #[test]
    fn copies_only_googles_photos() {
        assert!(google_photo("https://lh3.googleusercontent.com/a/xyz=s100").is_ok());
        for url in ["http://lh3.googleusercontent.com/a", "https://example.com/a.jpg", "https://googleusercontent.com.evil.test/a"] {
            assert!(google_photo(url).is_err(), "{url}");
        }
    }

    #[test]
    fn skips_deleted_people() {
        let person: Person =
            serde_json::from_value(json!({ "resourceName": "people/c1", "metadata": { "deleted": true } })).unwrap();
        assert!(to_contact("me@example.com", person).is_none());
    }

    #[test]
    fn sends_only_changed_fields() {
        let draft = ContactDraft {
            emails: Some(vec![Labeled { value: " jo@example.com ".into(), label: Some("home".into()) }]),
            notes: Some(String::new()),
            ..Default::default()
        };
        let (person, fields) = draft.to_json();
        assert_eq!(fields, ["emailAddresses", "biographies"]);
        assert_eq!(person["emailAddresses"], json!([{ "value": "jo@example.com", "type": "home" }]));
        assert_eq!(person["biographies"], json!([]));
    }

    #[test]
    fn checks_resource_names() {
        let url = person_url("people/c123", "deleteContact").unwrap();
        assert!(url.as_str().ends_with("/v1/people/c123:deleteContact"));
        assert!(person_url("people/../contactGroups/x", "deleteContact").is_err());
        assert!(person_url("contactGroups/starred", "").is_err());
    }
}
