//! Todoist (API v1): reads active tasks that have a due date; adds, edits,
//! reschedules and deletes tasks; completes or reopens them. Authenticates with the user's personal API token (Todoist →
//! Settings → Integrations → Developer), kept in the OS keychain.

use std::collections::HashMap;

use chrono::{DateTime, Days, Local, NaiveDate, NaiveDateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use serde::de::DeserializeOwned;
use url::Url;

use crate::agenda::{AgendaItem, ItemKind, Source};
use crate::error::{AppError, Result};

const API: &str = "https://api.todoist.com/api/v1";
/// The most items Todoist returns per page.
const PAGE_SIZE: &str = "200";

#[derive(Deserialize)]
struct Page<T> {
    #[serde(default = "Vec::new")]
    results: Vec<T>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct Project {
    id: String,
    name: String,
    color: Option<String>,
    #[serde(default)]
    inbox_project: bool,
}

/// A project to add tasks to.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub inbox: bool,
}

/// A task as the New or Edit form filled it in.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDraft {
    pub content: String,
    #[serde(default)]
    pub description: Option<String>,
    /// `None` for the Inbox when adding; when editing, leaves it where it is.
    pub project_id: Option<String>,
    /// `None` leaves an existing task's due date as it is (and adds none).
    pub due: Option<TaskDue>,
    /// 1 (most urgent) to 4, as numbered in the Todoist app.
    pub priority: Option<u8>,
}

/// A task's due date: none; a day ("YYYY-MM-DD") or time (RFC 3339); or
/// words Todoist reads itself, such as a repeat ("every Monday at 7am").
/// `Move`: a repeating task's next date moves there and it keeps repeating,
/// as rescheduling one does in Todoist's own apps.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "at")]
pub enum TaskDue {
    None,
    At(String),
    Words(String),
    Move(String),
}

impl TaskDraft {
    fn to_json(&self) -> Result<serde_json::Value> {
        let content = self.content.trim();
        if content.is_empty() {
            return Err(AppError::InvalidInput("the task needs a name".into()));
        }
        let mut body = json!({ "content": content });
        if let Some(description) = &self.description {
            body["description"] = json!(description.trim());
        }
        if let Some(priority) = self.priority {
            // Todoist's API counts the other way: 4 is P1.
            body["priority"] = json!(5 - priority.clamp(1, 4));
        }
        // A move is its own request (`reschedule`), after this one.
        if let Some(due) = self.due.as_ref().filter(|due| !matches!(due, TaskDue::Move(_))) {
            set_due(&mut body, due)?;
        }
        Ok(body)
    }
}

/// Puts a due date or time into a request, or removes it.
fn set_due(body: &mut serde_json::Value, due: &TaskDue) -> Result<()> {
    match due {
        TaskDue::None => body["due_string"] = json!("no date"),
        TaskDue::Words(words) => body["due_string"] = json!(words.trim()),
        TaskDue::At(day) | TaskDue::Move(day) if NaiveDate::parse_from_str(day, "%Y-%m-%d").is_ok() => {
            body["due_date"] = json!(day)
        }
        TaskDue::At(time) | TaskDue::Move(time) => {
            let time = DateTime::parse_from_rfc3339(time)
                .map_err(|_| AppError::InvalidInput(format!("not a date or time: {time:?}")))?;
            // Todoist wants a fixed time in UTC.
            body["due_datetime"] = json!(time.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string());
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct Task {
    id: String,
    content: String,
    #[serde(default)]
    description: String,
    project_id: String,
    due: Option<Due>,
    duration: Option<Duration>,
    /// 4 = most urgent ("P1" in the app) … 1 = normal ("P4").
    priority: u8,
    #[serde(default)]
    checked: bool,
}

/// `date` is "YYYY-MM-DD" for a due day, or a date and time: with a trailing
/// "Z" (fixed time, in UTC) or without (a "floating" time that follows you
/// across time zones).
#[derive(Deserialize)]
struct Due {
    date: String,
    datetime: Option<String>,
    #[serde(default)]
    is_recurring: bool,
    /// In words: "every Monday at 9am".
    string: Option<String>,
    /// Set for a fixed time; none for one that follows you across time zones.
    timezone: Option<String>,
    lang: Option<String>,
}

#[derive(Deserialize)]
struct Duration {
    amount: u32,
    /// "minute" or "day"
    unit: String,
}

enum DueAt {
    Day(NaiveDate),
    Time(DateTime<Local>),
}

fn parse_due(due: &Due) -> Option<DueAt> {
    let s = due.datetime.as_deref().unwrap_or(&due.date);
    if let Ok(day) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(DueAt::Day(day));
    }
    if let Ok(time) = DateTime::parse_from_rfc3339(s) {
        return Some(DueAt::Time(time.with_timezone(&Local)));
    }
    let floating = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    floating.and_local_timezone(Local).earliest().map(DueAt::Time)
}

/// Todoist's named project colors.
fn color_hex(name: &str) -> Option<&'static str> {
    Some(match name {
        "berry_red" => "#b8255f",
        "red" => "#db4035",
        "orange" => "#ff9933",
        "yellow" => "#fad000",
        "olive_green" => "#afb83b",
        "lime_green" => "#7ecc49",
        "green" => "#299438",
        "mint_green" => "#6accbc",
        "teal" => "#158fad",
        "sky_blue" => "#14aaf5",
        "light_blue" => "#96c3eb",
        "blue" => "#4073ff",
        "grape" => "#884dff",
        "violet" => "#af38eb",
        "lavender" => "#eb96eb",
        "magenta" => "#e05194",
        "salmon" => "#ff8d85",
        "charcoal" => "#808080",
        "grey" => "#b8b8b8",
        "taupe" => "#ccac93",
        _ => return None,
    })
}

fn api_url(segments: &[&str]) -> Url {
    let mut url = Url::parse(API).expect("valid URL");
    // Escapes anything unusual in IDs, so they can't change the path.
    url.path_segments_mut().expect("base URL").extend(segments);
    url
}

async fn check(response: reqwest::Response) -> Result<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let message = match status.as_u16() {
        401 | 403 => "Todoist rejected the API token. Reconnect Todoist with a current token.".to_string(),
        _ => response.text().await.unwrap_or_default(),
    };
    Err(AppError::Api { status: status.as_u16(), message })
}

/// Fetches every page of a list endpoint ("tasks", "projects").
async fn get_all<T: DeserializeOwned>(http: &reqwest::Client, token: &str, resource: &str) -> Result<Vec<T>> {
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut url = api_url(&[resource]);
        url.query_pairs_mut().append_pair("limit", PAGE_SIZE);
        if let Some(c) = &cursor {
            url.query_pairs_mut().append_pair("cursor", c);
        }
        let response = check(http.get(url).bearer_auth(token).send().await?).await?;
        let page: Page<T> = response.json().await?;
        all.extend(page.results);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return Ok(all),
        }
    }
}

/// Makes one small request to confirm the token works before saving it.
pub async fn verify_token(http: &reqwest::Client, token: &str) -> Result<()> {
    let mut url = api_url(&["projects"]);
    url.query_pairs_mut().append_pair("limit", "1");
    check(http.get(url).bearer_auth(token).send().await?).await?;
    Ok(())
}

/// Active tasks due between `from` and `to` (exclusive). Overdue tasks are
/// placed on today, when today is in range, so they can't be missed.
pub async fn tasks_between(
    http: &reqwest::Client,
    token: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<AgendaItem>> {
    // Todoist has no "due between" listing, so fetch all active tasks (a few
    // pages at most) and filter here.
    let (projects, tasks) = tokio::try_join!(
        get_all::<Project>(http, token, "projects"),
        get_all::<Task>(http, token, "tasks"),
    )?;
    let projects: HashMap<&str, &Project> = projects.iter().map(|p| (p.id.as_str(), p)).collect();
    let today = Local::now().date_naive();

    Ok(tasks
        .into_iter()
        .filter_map(|task| to_agenda_item(task, &projects, from, to, today))
        .collect())
}

fn to_agenda_item(
    task: Task,
    projects: &HashMap<&str, &Project>,
    from: NaiveDate,
    to: NaiveDate,
    today: NaiveDate,
) -> Option<AgendaItem> {
    if task.checked {
        return None;
    }
    let due = parse_due(task.due.as_ref()?)?;
    let due_day = match &due {
        DueAt::Day(day) => *day,
        DueAt::Time(time) => time.date_naive(),
    };
    let overdue = due_day < today;
    let shown_day = if overdue { today } else { due_day };
    if shown_day < from || shown_day >= to {
        return None;
    }

    let (start, end, all_day) = match due {
        // Shown as an all-day item on today, whenever it was due.
        _ if overdue => (today.to_string(), (today + Days::new(1)).to_string(), true),
        DueAt::Day(day) => {
            let days = match &task.duration {
                Some(d) if d.unit == "day" => d.amount.max(1),
                _ => 1,
            };
            (day.to_string(), (day + Days::new(days.into())).to_string(), true)
        }
        DueAt::Time(time) => {
            let minutes = match &task.duration {
                Some(d) if d.unit == "minute" => d.amount,
                _ => 0,
            };
            let end = time + TimeDelta::minutes(minutes.into());
            (time.to_rfc3339(), end.to_rfc3339(), false)
        }
    };

    let project = projects.get(task.project_id.as_str());
    let recurring = task.due.as_ref().is_some_and(|d| d.is_recurring);
    let repeat = task.due.as_ref().filter(|d| d.is_recurring).and_then(|d| d.string.clone());
    Some(AgendaItem {
        url: Some(format!("https://app.todoist.com/app/task/{}", task.id)),
        id: format!("todoist:{}", task.id),
        source: Source::Todoist,
        kind: ItemKind::Task,
        title: task.content,
        start,
        end: Some(end),
        all_day,
        location: None,
        color: project.and_then(|p| p.color.as_deref()).and_then(color_hex).map(String::from),
        list_name: project.map_or_else(|| "Todoist".to_string(), |p| p.name.clone()),
        completed: false,
        overdue,
        // Flip to Todoist's on-screen numbering: 1 = P1 (most urgent).
        priority: Some(5 - task.priority.clamp(1, 4)),
        account: None,
        list_id: Some(task.project_id),
        source_id: Some(task.id),
        series_id: None,
        // Repeating ones too: a new date moves the next one (`TaskDue::Move`).
        editable: true,
        recurring,
        description: Some(task.description).filter(|d| !d.trim().is_empty()),
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
        repeat,
    })
}

/// Your projects, Inbox first.
pub async fn projects(http: &reqwest::Client, token: &str) -> Result<Vec<ProjectInfo>> {
    let mut projects: Vec<ProjectInfo> = get_all::<Project>(http, token, "projects")
        .await?
        .into_iter()
        .map(|p| ProjectInfo {
            color: p.color.as_deref().and_then(color_hex).map(String::from),
            id: p.id,
            name: p.name,
            inbox: p.inbox_project,
        })
        .collect();
    projects.sort_by_key(|p| !p.inbox);
    Ok(projects)
}

/// Adds a task. Without a project, it goes to the Inbox.
pub async fn create_task(http: &reqwest::Client, token: &str, task: &TaskDraft) -> Result<()> {
    let mut body = task.to_json()?;
    if let Some(project) = &task.project_id {
        body["project_id"] = json!(project);
    }
    check(http.post(api_url(&["tasks"])).bearer_auth(token).json(&body).send().await?).await?;
    Ok(())
}

/// Saves an edited task, moving it to `task.project_id` if that's set.
pub async fn update_task(http: &reqwest::Client, token: &str, task_id: &str, task: &TaskDraft) -> Result<()> {
    let body = task.to_json()?;
    check(http.post(api_url(&["tasks", task_id])).bearer_auth(token).json(&body).send().await?).await?;
    if let Some(TaskDue::Move(at)) = &task.due {
        reschedule(http, token, task_id, at).await?;
    }
    if let Some(project) = &task.project_id {
        let move_to = json!({ "project_id": project });
        check(http.post(api_url(&["tasks", task_id, "move"])).bearer_auth(token).json(&move_to).send().await?)
            .await?;
    }
    Ok(())
}

/// Changes only a task's due date or time (dragging it).
pub async fn set_task_due(http: &reqwest::Client, token: &str, task_id: &str, due: &TaskDue) -> Result<()> {
    if let TaskDue::Move(at) = due {
        return reschedule(http, token, task_id, at).await;
    }
    let mut body = json!({});
    set_due(&mut body, due)?;
    check(http.post(api_url(&["tasks", task_id])).bearer_auth(token).json(&body).send().await?).await?;
    Ok(())
}

/// Moves a repeating task's next date to `at` (a day, or an RFC 3339 time)
/// and keeps it repeating, as Todoist's own apps do: its due is sent back
/// with the same words ("every Monday") and only the date changed (Sync
/// API `item_update`; a plain date update would end the repeat). A new day
/// alone keeps the time it had. Not repeating: an ordinary new date.
async fn reschedule(http: &reqwest::Client, token: &str, task_id: &str, at: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Current {
        due: Option<Due>,
    }
    let current: Current = check(http.get(api_url(&["tasks", task_id])).bearer_auth(token).send().await?)
        .await?
        .json()
        .await?;
    let Some(due) = current.due.filter(|due| due.is_recurring) else {
        let mut body = json!({});
        set_due(&mut body, &TaskDue::At(at.to_string()))?;
        check(http.post(api_url(&["tasks", task_id])).bearer_auth(token).json(&body).send().await?).await?;
        return Ok(());
    };
    let date = rescheduled_date(at, &due)?;
    let uuid = format!("{:032x}", rand::random::<u128>());
    let command = json!([{
        "type": "item_update",
        "uuid": uuid,
        "args": {
            "id": task_id,
            "due": { "date": date, "string": due.string, "is_recurring": true, "timezone": due.timezone, "lang": due.lang },
        },
    }]);
    let reply: Value = check(
        http.post(api_url(&["sync"])).bearer_auth(token).form(&[("commands", command.to_string())]).send().await?,
    )
    .await?
    .json()
    .await?;
    match &reply["sync_status"][&uuid] {
        Value::String(ok) if ok == "ok" => Ok(()),
        other => Err(AppError::Config(format!("Todoist didn't move the task: {other}"))),
    }
}

/// The date Todoist keeps for a repeating task moved to `at`: a day alone
/// keeps the time it had; a time is fixed (UTC, "Z") if the task's was, or
/// else a clock time ("09:00:00") that follows you across time zones.
fn rescheduled_date(at: &str, due: &Due) -> Result<String> {
    // The time it had: in its date ("2026-11-09T09:00:00"), or given apart.
    let with_time = if due.date.len() > 10 { Some(due.date.as_str()) } else { due.datetime.as_deref() };
    let had_time = with_time.and_then(|d| d.get(10..)).filter(|rest| rest.starts_with('T'));
    if NaiveDate::parse_from_str(at, "%Y-%m-%d").is_ok() {
        return Ok(format!("{at}{}", had_time.unwrap_or("")));
    }
    let time = DateTime::parse_from_rfc3339(at).map_err(|_| AppError::InvalidInput(format!("not a date or time: {at:?}")))?;
    Ok(if due.timezone.is_some() {
        time.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string()
    } else {
        time.naive_local().format("%Y-%m-%dT%H:%M:%S").to_string()
    })
}

pub async fn delete_task(http: &reqwest::Client, token: &str, task_id: &str) -> Result<()> {
    check(http.delete(api_url(&["tasks", task_id])).bearer_auth(token).send().await?).await?;
    Ok(())
}

/// Completes (closes) or reopens a task. `item_id` is an `AgendaItem` id,
/// "todoist:<task id>".
pub async fn set_completed(http: &reqwest::Client, token: &str, item_id: &str, completed: bool) -> Result<()> {
    let task_id = item_id
        .strip_prefix("todoist:")
        .ok_or_else(|| AppError::InvalidInput(format!("not a Todoist task: {item_id:?}")))?;
    let action = if completed { "close" } else { "reopen" };
    check(http.post(api_url(&["tasks", task_id, action])).bearer_auth(token).send().await?).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repeating_task_moved_keeps_its_time_and_kind_of_time() {
        let due = |date: &str, timezone: Option<&str>| Due {
            date: date.into(),
            datetime: None,
            is_recurring: true,
            string: Some("every Monday at 9am".into()),
            timezone: timezone.map(String::from),
            lang: Some("en".into()),
        };
        // A new day alone keeps its 9 AM, floating or fixed.
        assert_eq!(rescheduled_date("2026-11-10", &due("2026-11-09T09:00:00", None)).unwrap(), "2026-11-10T09:00:00");
        assert_eq!(rescheduled_date("2026-11-10", &due("2026-11-09T14:00:00Z", Some("America/New_York"))).unwrap(), "2026-11-10T14:00:00Z");
        assert_eq!(rescheduled_date("2026-11-10", &due("2026-11-09", None)).unwrap(), "2026-11-10");
        // A time: fixed in UTC if it was fixed, else the clock time.
        assert_eq!(rescheduled_date("2026-11-10T10:30:00-05:00", &due("2026-11-09T09:00:00", None)).unwrap(), "2026-11-10T10:30:00");
        assert_eq!(
            rescheduled_date("2026-11-10T10:30:00-05:00", &due("2026-11-09T14:00:00Z", Some("America/New_York"))).unwrap(),
            "2026-11-10T15:30:00Z"
        );
    }

    #[test]
    fn due_dates_and_times() {
        let due = |json: serde_json::Value| -> serde_json::Value {
            let mut body = json!({});
            set_due(&mut body, &serde_json::from_value(json).unwrap()).unwrap();
            body
        };
        assert_eq!(due(json!({ "kind": "at", "at": "2026-11-04" })), json!({ "due_date": "2026-11-04" }));
        assert_eq!(
            due(json!({ "kind": "at", "at": "2026-11-04T16:00:00+01:00" })),
            json!({ "due_datetime": "2026-11-04T15:00:00Z" })
        );
        assert_eq!(due(json!({ "kind": "none" })), json!({ "due_string": "no date" }));
        assert_eq!(due(json!({ "kind": "words", "at": "every Monday" })), json!({ "due_string": "every Monday" }));
    }

    #[test]
    fn priority_is_flipped_for_the_api() {
        let task = TaskDraft {
            content: "Pay rent".into(),
            description: None,
            project_id: None,
            due: None,
            priority: Some(1),
        };
        assert_eq!(task.to_json().unwrap()["priority"], 4);
        // Not given: the due date is left alone.
        assert!(task.to_json().unwrap().get("due_date").is_none());
    }
}
