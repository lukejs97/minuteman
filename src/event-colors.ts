// Google Calendar's event colors, by `colorId`, as its apps show them (the
// API's own color list has older, paler ones). An event with none is its
// calendar's color. Kept in step with `EVENT_COLORS` in google/calendar.rs.
export const EVENT_COLORS: { id: string; name: string; color: string }[] = [
  { id: "11", name: "Tomato", color: "#d50000" },
  { id: "4", name: "Flamingo", color: "#e67c73" },
  { id: "6", name: "Tangerine", color: "#f4511e" },
  { id: "5", name: "Banana", color: "#f6bf26" },
  { id: "2", name: "Sage", color: "#33b679" },
  { id: "10", name: "Basil", color: "#0b8043" },
  { id: "7", name: "Peacock", color: "#039be5" },
  { id: "9", name: "Blueberry", color: "#3f51b5" },
  { id: "1", name: "Lavender", color: "#7986cb" },
  { id: "3", name: "Grape", color: "#8e24aa" },
  { id: "8", name: "Graphite", color: "#616161" },
];

/** The color an event's `colorId` stands for, or null for none (or one Google doesn't have). */
export const eventColor = (id: string | null | undefined): string | null =>
  EVENT_COLORS.find((c) => c.id === id)?.color ?? null;
