// Todoist (API v1): a port of src-tauri/src/todoist.rs. Reads active tasks
// with a due date; adds, edits, reschedules, deletes, completes and reopens
// tasks, using the personal API token kept (encrypted) on the server.
import type { AgendaItem, TaskDraft, TaskDue, TodoistProject } from "../../src/api";
import { AppError, fetchOrFail, invalidInput } from "./errors";
import { addDays, dayOf, parseDay, wallToInstant } from "./zone";

const API = "https://api.todoist.com/api/v1";
/** The most items Todoist returns per page. */
const PAGE_SIZE = "200";

interface Project {
  id: string;
  name: string;
  color?: string;
  inbox_project?: boolean;
}

interface Task {
  id: string;
  content: string;
  description?: string;
  project_id: string;
  /** "YYYY-MM-DD" for a due day; a time with "Z" (fixed, UTC) or without ("floating", your local time). */
  due?: {
    date: string;
    datetime?: string | null;
    is_recurring?: boolean;
    /** In words: "every Monday at 9am". */
    string?: string | null;
    /** Set for a fixed time; none for one that follows you across time zones. */
    timezone?: string | null;
    lang?: string | null;
  } | null;
  duration?: { amount: number; unit: "minute" | "day" } | null;
  /** 4 = most urgent ("P1" in the app) … 1 = normal ("P4"). */
  priority: number;
  checked?: boolean;
}

/** Todoist's named project colors. */
const COLORS: Record<string, string> = {
  berry_red: "#b8255f",
  red: "#db4035",
  orange: "#ff9933",
  yellow: "#fad000",
  olive_green: "#afb83b",
  lime_green: "#7ecc49",
  green: "#299438",
  mint_green: "#6accbc",
  teal: "#158fad",
  sky_blue: "#14aaf5",
  light_blue: "#96c3eb",
  blue: "#4073ff",
  grape: "#884dff",
  violet: "#af38eb",
  lavender: "#eb96eb",
  magenta: "#e05194",
  salmon: "#ff8d85",
  charcoal: "#808080",
  grey: "#b8b8b8",
  taupe: "#ccac93",
};

const url = (...segments: string[]) => `${API}/${segments.map(encodeURIComponent).join("/")}`;

async function todoist(token: string, target: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetchOrFail(target, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  if (response.ok) return response;
  const message =
    response.status === 401 || response.status === 403
      ? "Todoist rejected the API token. Reconnect Todoist with a current token."
      : await response.text();
  throw new AppError("api", `Todoist error (${response.status}): ${message}`, 502);
}

/** Every page of a list ("tasks", "projects"). */
async function getAll<T>(token: string, resource: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  do {
    const target = new URL(url(resource));
    target.searchParams.set("limit", PAGE_SIZE);
    if (cursor) target.searchParams.set("cursor", cursor);
    const page = (await (await todoist(token, target.toString())).json()) as { results?: T[]; next_cursor?: string | null };
    all.push(...(page.results ?? []));
    cursor = page.next_cursor ?? null;
  } while (cursor);
  return all;
}

/** One small request, to check a token works before saving it. */
export async function verifyToken(token: string): Promise<void> {
  await todoist(token, `${url("projects")}?limit=1`);
}

/**
 * Active tasks due between `from` and `to` (exclusive), in `zone`. Overdue
 * tasks are shown on today, when today is in range, so they can't be missed.
 */
export async function tasksBetween(token: string, from: string, to: string, zone: string): Promise<AgendaItem[]> {
  // Todoist has no "due between" listing: fetch all active tasks and filter here.
  const [projects, tasks] = await Promise.all([getAll<Project>(token, "projects"), getAll<Task>(token, "tasks")]);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const today = dayOf(new Date(), zone);
  return tasks.flatMap((task) => {
    const item = toAgendaItem(task, byId, from, to, today, zone);
    return item ? [item] : [];
  });
}

type DueAt = { day: string } | { time: Date };

function parseDue(due: NonNullable<Task["due"]>, zone: string): DueAt | null {
  const s = due.datetime ?? due.date;
  if (parseDay(s)) return { day: s };
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : { time: new Date(t) };
  }
  // Floating: the same wall-clock time wherever you are.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  return { time: wallToInstant({ year, month, day, hour, minute, second }, zone) };
}

function toAgendaItem(
  task: Task,
  projects: Map<string, Project>,
  from: string,
  to: string,
  today: string,
  zone: string,
): AgendaItem | null {
  if (task.checked || !task.due) return null;
  const due = parseDue(task.due, zone);
  if (!due) return null;
  const dueDay = "day" in due ? due.day : dayOf(due.time, zone);
  const overdue = dueDay < today;
  const shownDay = overdue ? today : dueDay;
  if (shownDay < from || shownDay >= to) return null;

  let start: string;
  let end: string;
  let allDay: boolean;
  if (overdue) {
    // Shown as an all-day item on today, whenever it was due.
    [start, end, allDay] = [today, addDays(today, 1), true];
  } else if ("day" in due) {
    const days = task.duration?.unit === "day" ? Math.max(1, task.duration.amount) : 1;
    [start, end, allDay] = [due.day, addDays(due.day, days), true];
  } else {
    const minutes = task.duration?.unit === "minute" ? task.duration.amount : 0;
    [start, end, allDay] = [due.time.toISOString(), new Date(due.time.getTime() + minutes * 60_000).toISOString(), false];
  }

  const project = projects.get(task.project_id);
  const recurring = !!task.due.is_recurring;
  const repeat = recurring ? (task.due.string ?? null) : null;
  const description = task.description?.trim() ? task.description : null;
  return {
    id: `todoist:${task.id}`,
    source: "todoist",
    kind: "task",
    title: task.content,
    start,
    end,
    allDay,
    location: null,
    color: (project?.color && COLORS[project.color]) || null,
    listName: project?.name ?? "Todoist",
    url: `https://app.todoist.com/app/task/${task.id}`,
    completed: false,
    overdue,
    // Flip to Todoist's on-screen numbering: 1 = P1 (most urgent).
    priority: 5 - Math.min(4, Math.max(1, task.priority)),
    account: null,
    listId: task.project_id,
    sourceId: task.id,
    seriesId: null,
    // Repeating ones too: a new date moves the next one ("move").
    editable: true,
    recurring,
    repeat,
    description,
    attendees: [],
    conferenceUrl: null,
    reminders: [],
  };
}

/** Your projects, Inbox first. */
export async function projects(token: string): Promise<TodoistProject[]> {
  return (await getAll<Project>(token, "projects"))
    .map((p) => ({ id: p.id, name: p.name, color: (p.color && COLORS[p.color]) || null, inbox: !!p.inbox_project }))
    .sort((a, b) => Number(b.inbox) - Number(a.inbox));
}

/** Puts a due date or time into a request, or removes it. */
function setDue(body: Record<string, unknown>, due: TaskDue): void {
  if (due.kind === "none") body.due_string = "no date";
  else if (due.kind === "move") setDue(body, { kind: "at", at: due.at });
  else if (due.kind === "words") body.due_string = due.at.trim();
  else if (parseDay(due.at)) body.due_date = due.at;
  else {
    const t = Date.parse(due.at);
    if (Number.isNaN(t)) throw invalidInput(`not a date or time: ${JSON.stringify(due.at)}`);
    // Todoist wants a fixed time in UTC.
    body.due_datetime = new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}

function draftJson(task: TaskDraft): Record<string, unknown> {
  const content = task.content.trim();
  if (!content) throw invalidInput("the task needs a name");
  const body: Record<string, unknown> = { content };
  if (task.description !== null && task.description !== undefined) body.description = task.description.trim();
  // Todoist's API counts the other way: 4 is P1.
  if (task.priority) body.priority = 5 - Math.min(4, Math.max(1, task.priority));
  // A move is its own request (`reschedule`), after this one.
  if (task.due && task.due.kind !== "move") setDue(body, task.due);
  return body;
}

/** Adds a task. Without a project, it goes to the Inbox. */
export async function createTask(token: string, task: TaskDraft): Promise<void> {
  const body = draftJson(task);
  if (task.projectId) body.project_id = task.projectId;
  await todoist(token, url("tasks"), { method: "POST", body: JSON.stringify(body) });
}

/** Saves an edited task, moving it to `task.projectId` if that's set. */
export async function updateTask(token: string, id: string, task: TaskDraft): Promise<void> {
  await todoist(token, url("tasks", id), { method: "POST", body: JSON.stringify(draftJson(task)) });
  if (task.due?.kind === "move") await reschedule(token, id, task.due.at);
  if (task.projectId) {
    await todoist(token, url("tasks", id, "move"), { method: "POST", body: JSON.stringify({ project_id: task.projectId }) });
  }
}

/** Changes only a task's due date or time (dragging it). */
export async function setTaskDue(token: string, id: string, due: TaskDue): Promise<void> {
  if (due.kind === "move") return reschedule(token, id, due.at);
  const body: Record<string, unknown> = {};
  setDue(body, due);
  await todoist(token, url("tasks", id), { method: "POST", body: JSON.stringify(body) });
}

/**
 * Moves a repeating task's next date to `at` (a day, or an ISO time) and
 * keeps it repeating, as Todoist's own apps do: its due goes back with the
 * same words and only the date changed (Sync API `item_update`; a plain date
 * update would end the repeat). As `reschedule` in todoist.rs.
 */
async function reschedule(token: string, id: string, at: string): Promise<void> {
  const task = (await (await todoist(token, url("tasks", id))).json()) as Task;
  const due = task.due;
  if (!due?.is_recurring) return setTaskDue(token, id, { kind: "at", at });
  const uuid = crypto.randomUUID();
  const commands = JSON.stringify([
    {
      type: "item_update",
      uuid,
      args: {
        id,
        due: { date: rescheduledDate(at, due), string: due.string, is_recurring: true, timezone: due.timezone ?? null, lang: due.lang ?? null },
      },
    },
  ]);
  const reply = (await (
    await todoist(token, url("sync"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ commands }).toString(),
    })
  ).json()) as { sync_status?: Record<string, unknown> };
  if (reply.sync_status?.[uuid] !== "ok") {
    throw new AppError("api", `Todoist didn't move the task: ${JSON.stringify(reply.sync_status?.[uuid] ?? null)}`, 502);
  }
}

/** As `rescheduled_date` in todoist.rs: a day keeps the time it had; a time is fixed (UTC) if it was, else a clock time. */
export function rescheduledDate(at: string, due: NonNullable<Task["due"]>): string {
  const withTime = due.date.length > 10 ? due.date : (due.datetime ?? "");
  const hadTime = withTime.slice(10).startsWith("T") ? withTime.slice(10) : "";
  if (parseDay(at)) return `${at}${hadTime}`;
  const t = Date.parse(at);
  if (Number.isNaN(t)) throw invalidInput(`not a date or time: ${JSON.stringify(at)}`);
  if (due.timezone) return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  // The clock time as written ("2026-11-10T10:30:00-05:00" → 10:30).
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(at) ? `${at.slice(0, 16)}:00` : new Date(t).toISOString().slice(0, 19);
}

export async function deleteTask(token: string, id: string): Promise<void> {
  await todoist(token, url("tasks", id), { method: "DELETE" });
}

/** Completes (closes) or reopens a task. `itemId` is "todoist:<task id>". */
export async function setCompleted(token: string, itemId: string, completed: boolean): Promise<void> {
  if (!itemId.startsWith("todoist:")) throw invalidInput(`not a Todoist task: ${JSON.stringify(itemId)}`);
  const id = itemId.slice("todoist:".length);
  await todoist(token, url("tasks", id, completed ? "close" : "reopen"), { method: "POST" });
}
