// One event of a repeating series, changed the way Google Calendar asks:
// "This event", "This and following events", or "All events". The form
// (event-form.ts) asks when you save; dragging and deleting ask here.
//
// "This and following" is done as Google does it: the series ends just
// before this event (`endSeriesBefore`), and a new series starts from it.
// For the series' first event that's all of them, so they're all changed.
import {
  type AgendaItem,
  createEvent,
  deleteEvent,
  type EventDraft,
  type EventTimes,
  endSeriesBefore,
  eventRef,
  setEventTimes,
  updateEvent,
} from "./api";
import { ask } from "./details";
import { floatingZone, itemStart, localTimeZone, sameClockIn, toDateString } from "./time";

export type SeriesChoice = "one" | "following" | "all";

/** Whether `item` is one event of a repeating Google series. */
export const inSeries = (item: AgendaItem) => item.kind === "event" && item.recurring && !!item.seriesId;

/** Asks which events of the series a change is for. Null: cancelled. */
export async function askSeriesChoice(question: string, allowOne = true): Promise<SeriesChoice | null> {
  const answers: [string, string, boolean][] = [
    ["following", "This and following events", !allowOne],
    ["all", "All events", false],
  ];
  if (allowOne) answers.unshift(["one", "This event", true]);
  const answer = await ask(question, "This is a repeating event.", answers);
  return answer === "one" || answer === "following" || answer === "all" ? answer : null;
}

/**
 * When this event was meant to be, as Google keeps it: the time to end the
 * series before (or its day, all day). A floating event's clock time is in
 * its own zone.
 */
export function occurrenceStart(item: AgendaItem): string {
  if (item.allDay) return toDateString(itemStart(item));
  const zone = floatingZone(item);
  return (zone ? sameClockIn(itemStart(item), zone) : itemStart(item)).toISOString();
}

/** `item` as it is, at `times`: everything a new series made from it needs. */
function copyOf(item: AgendaItem, times: EventTimes): EventDraft {
  return {
    ...times,
    title: item.title,
    location: item.location,
    description: item.description,
    recurrence: null,
    floating: item.floating || null,
    alerts: {
      kind: "custom",
      alerts: [
        ...item.reminders.map((minutes) => ({ kind: "relative" as const, minutes, method: "popup" as const })),
        ...(item.emailReminders ?? []).map((minutes) => ({ kind: "relative" as const, minutes, method: "email" as const })),
        ...(item.alertAt ?? []).map((at) => ({ kind: "absolute" as const, at })),
        ...(item.leaveAlerts ?? []).map((bufferMinutes) => ({ kind: "leave" as const, bufferMinutes })),
      ],
    },
    guests: item.attendees.filter((a) => a.email).map((a) => ({ email: a.email!, response: a.response })),
    leaveFrom: item.leaveFrom ?? "",
    colorId: item.colorId ?? null,
  };
}

/** Moves one event of a series to `times` (dragged there): it alone, it and the ones after, or all. */
export async function moveInSeries(item: AgendaItem, times: EventTimes, choice: SeriesChoice, notify: boolean): Promise<void> {
  if (choice === "one") return setEventTimes(eventRef(item), times, notify);
  if (choice === "following") {
    const rules = await endSeriesBefore(eventRef(item, true), occurrenceStart(item), item.allDay);
    if (rules) return createEvent(item.account!, item.listId!, { ...copyOf(item, times), recurrence: rules });
  }
  // All of them move by as much as this one did.
  const zone = floatingZone(item);
  const at = (iso: string) => (zone ? sameClockIn(new Date(iso), zone).toISOString() : iso);
  const occurrence = { start: at(item.start), end: at(item.end ?? item.start), allDay: item.allDay, timeZone: zone ?? localTimeZone() };
  // Only the times change: the rest is left as it is (null, or left out).
  const draft: EventDraft = {
    ...times,
    title: item.title,
    location: item.location,
    description: item.description,
    recurrence: null,
    alerts: null,
    guests: null,
  };
  await updateEvent(eventRef(item, true), draft, null, notify, occurrence);
}

/** Deletes one event of a series: it alone, it and the ones after, or all. */
export async function deleteInSeries(item: AgendaItem, choice: SeriesChoice, notify: boolean): Promise<void> {
  if (choice === "following" && (await endSeriesBefore(eventRef(item, true), occurrenceStart(item), item.allDay))) return;
  await deleteEvent(eventRef(item, choice !== "one"), notify);
}
