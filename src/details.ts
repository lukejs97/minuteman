// The details popup for an event or task: when and where, a button to join
// the video call, guests, and notes. Opens on click instead of the browser.
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  attachToEvent,
  attachToTask,
  deleteEvent,
  deleteTask,
  errorMessage,
  eventRef,
  removeEventAttachment,
  respondToEvent,
  taskAttachments,
  type AgendaItem,
  type Attachment,
  type Attendee,
} from "./api";
import { openContacts } from "./contacts/open";
import { el, setItemColor, showMenu } from "./dom";
import { deleteInSeries, inSeries } from "./series";
import { deleteWithUndo } from "./undo";
import { leaveDetail } from "./leave";
import { mapLink } from "./maps";
import { describeTimes, itemEnd, itemStart } from "./time";

const RESPONSES: Record<string, string> = {
  accepted: "Going",
  declined: "Not going",
  tentative: "Maybe",
  needsAction: "Hasn't replied",
};

export interface DetailActions {
  /** Completes a task, or un-completes it. */
  toggleTask(item: AgendaItem): void;
  /** Opens the Edit window. */
  edit(item: AgendaItem): void;
  /** Opens the New window filled in as a copy of it. */
  duplicate(item: AgendaItem): void;
  /** Runs once the item has been deleted. */
  deleted(item: AgendaItem): void;
  /** Runs once it has changed in place (a reply to an invitation). */
  changed(item: AgendaItem): void;
}

/** Whether `item` can be duplicated: any event (into a Google calendar), and Todoist tasks. */
const canDuplicate = (item: AgendaItem) => item.kind === "event" || item.source === "todoist";

/** Opens the popup. */
export function openDetails(item: AgendaItem, actions: DetailActions): void {
  const dialog = el("dialog", "dialog details");
  dialog.setAttribute("aria-labelledby", "details-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  // Clicking the dimmed area outside closes it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  const title = el("h2", "details-title", item.title);
  title.id = "details-title";
  setItemColor(title, item);
  if (item.completed) title.classList.add("completed");

  const rows = el("div", "details-rows");
  let when = describeTimes(itemStart(item), itemEnd(item), item.allDay);
  if (item.kind === "task") when = item.overdue ? `Overdue · shown on ${when}` : `Due ${when}`;
  if (item.recurring) when += " · Repeats";
  if (item.floating && !item.allDay) when += " · Same time in any time zone";
  rows.append(row("When", when));

  if (item.conferenceUrl) {
    const url = item.conferenceUrl;
    const join = el("button", "primary-button join-button", `Join ${callService(url)}`);
    join.addEventListener("click", () => openUrl(url));
    rows.append(row("Call", join));
  }
  if (item.location) {
    const place = el("span", undefined, item.location);
    const map = linkButton(isWebLink(item.location) ? "Open" : "Map", () =>
      openUrl(isWebLink(item.location!) ? item.location! : mapLink(item.location!)),
    );
    const where = el("span");
    where.append(place, " ", map);
    rows.append(row("Location", where));
    const leaveRow = row("Leave by", "…");
    leaveRow.hidden = true;
    rows.append(leaveRow);
    void leaveDetail(item).then((text) => {
      if (!text || !leaveRow.isConnected) return;
      leaveRow.hidden = false;
      const value = leaveRow.querySelector(".details-value");
      if (value) value.textContent = text;
    });
  }
  if (item.kind === "task") {
    const project = item.priority && item.priority < 4 ? `${item.listName} · P${item.priority}` : item.listName;
    rows.append(row("Project", project));
  } else {
    rows.append(row("Calendar", item.account ? `${item.listName} (${item.account})` : item.listName));
  }
  // Invited (not the organizer): your reply, as Google Calendar asks it.
  const you = item.kind === "event" && item.source === "google" ? item.attendees.find((a) => a.isSelf && !a.organizer) : null;
  if (you) rows.append(row("Going?", replyButtons(item, you.response, actions)));
  if (item.attendees.length > 0) rows.append(row("Guests", guestList(item.attendees)));
  const files = attachmentsRow(item, actions, dialog);
  if (files) rows.append(row("Attachments", files));
  if (item.description) {
    const notes = el("div", "details-notes");
    notes.append(...notesToNodes(item.description));
    rows.append(row("Notes", notes));
  }

  const buttons = el("div", "dialog-buttons");
  const error = el("p", "error");
  // Google events you may change, and Todoist tasks (Apple items are
  // changed in their own apps, for now).
  if (item.editable || (item.kind === "task" && item.source === "todoist")) {
    const remove = el("button", "text-button danger", "Delete");
    remove.addEventListener("click", async () => {
      error.textContent = "";
      try {
        if (await deleteItem(item, actions)) {
          dialog.close();
          actions.deleted(item);
        }
      } catch (e) {
        error.textContent = `Couldn't delete it: ${errorMessage(e)}`;
      }
    });
    const edit = el("button", "text-button", "Edit");
    edit.addEventListener("click", () => {
      actions.edit(item); // the form first, so the dimmed background stays
      dialog.close();
    });
    buttons.append(remove, edit);
  }
  if (canDuplicate(item)) {
    const copy = el("button", "text-button", "Duplicate");
    copy.addEventListener("click", () => {
      actions.duplicate(item); // the form first, so the dimmed background stays
      dialog.close();
    });
    buttons.append(copy);
  }
  if (item.kind === "task") {
    const toggle = el("button", "text-button", item.completed ? "Mark not done" : "Complete");
    toggle.addEventListener("click", () => {
      dialog.close();
      actions.toggleTask(item);
    });
    buttons.append(toggle);
  }
  if (item.url) {
    const url = item.url;
    const open = el("button", "text-button", item.source === "todoist" ? "Open in Todoist" : "Open in Google Calendar");
    open.addEventListener("click", () => openUrl(url));
    buttons.append(open);
  }
  const close = el("button", "primary-button", "Close");
  close.addEventListener("click", () => dialog.close());
  buttons.append(close);

  dialog.append(title, rows, error, buttons);
  dialog.showModal();
  close.focus();
}

/**
 * Quick actions for an item, at (x, y): right-click it, or press and hold on
 * a touch screen. The same choices as its details popup.
 */
export function showItemMenu(
  item: AgendaItem,
  x: number,
  y: number,
  actions: DetailActions & { open(item: AgendaItem): void },
): void {
  const changeable = item.editable || (item.kind === "task" && item.source === "todoist");
  const entries: [string, () => void][] = [["Open", () => actions.open(item)]];
  if (changeable) entries.push(["Edit", () => actions.edit(item)]);
  if (canDuplicate(item)) entries.push(["Duplicate", () => actions.duplicate(item)]);
  if (item.kind === "task") entries.push([item.completed ? "Mark not done" : "Complete", () => actions.toggleTask(item)]);
  if (item.url) {
    const url = item.url;
    entries.push([item.source === "todoist" ? "Open in Todoist" : "Open in Google Calendar", () => void openUrl(url)]);
  }
  if (changeable) {
    entries.push([
      "Delete…",
      async () => {
        try {
          if (await deleteItem(item, actions)) actions.changed(item);
        } catch (e) {
          await ask(`Couldn't delete “${item.title}”`, errorMessage(e), []);
        }
      },
    ]);
  }
  showMenu(x, y, entries);
}

/**
 * Asks before deleting, then deletes. For one occurrence of a repeating
 * event, asks whether to delete just it or the whole series. Resolves to
 * false if you cancelled.
 */
async function deleteItem(item: AgendaItem, actions: DetailActions): Promise<boolean> {
  /** Hides what's being deleted, with Undo; it's sent once the bar goes away. */
  const later = (message: string, matches: (i: AgendaItem) => boolean, send: () => Promise<unknown>) =>
    deleteWithUndo(message, matches, send, () => actions.deleted(item), (e) => {
      actions.changed(item);
      void ask(`Couldn't delete “${item.title}”`, errorMessage(e), []);
    });
  const same = (i: AgendaItem) => i.id === item.id;
  if (item.kind === "task") {
    if ((await ask(`Delete “${item.title}”?`, "It's deleted in Todoist too.", [["delete", "Delete task", true]])) !== "delete") {
      return false;
    }
    later(`Deleted “${item.title}”`, same, () => deleteTask(item.sourceId!));
    return true;
  }
  const guests = item.attendees.some((a) => !a.isSelf);
  const note = guests ? "Guests are emailed that it's cancelled." : "It's deleted in Google Calendar too.";
  if (inSeries(item)) {
    // As Google Calendar asks: this one, this and the ones after, or all.
    const choice = await ask(`Delete “${item.title}”?`, `This is a repeating event. ${note}`, [
      ["one", "This event", true],
      ["following", "This and following events", false],
      ["all", "All events", false],
    ]);
    if (choice !== "one" && choice !== "following" && choice !== "all") return false;
    const series = (i: AgendaItem) => same(i) || (!!item.seriesId && i.seriesId === item.seriesId);
    const matches =
      choice === "one" ? same : choice === "all" ? series : (i: AgendaItem) => series(i) && itemStart(i) >= itemStart(item);
    const message =
      choice === "one" ? `Deleted “${item.title}”` : choice === "all" ? `Deleted every “${item.title}”` : `Deleted “${item.title}” and the ones after`;
    later(message, matches, () => deleteInSeries(item, choice, guests));
    return true;
  }
  const choice = await ask(`Delete “${item.title}”?`, note, [["one", "Delete event", true]]);
  if (!choice) return false;
  later(`Deleted “${item.title}”`, same, () => deleteEvent(eventRef(item, false), guests));
  return true;
}

/**
 * A small question with a button per answer (plus Cancel). Resolves to the
 * chosen answer's value, or null for Cancel or Escape.
 */
export function ask(question: string, detail: string, answers: [string, string, boolean][]): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = el("dialog", "dialog");
    document.body.append(dialog);
    let answer: string | null = null;
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(answer);
    });
    const cancel = el("button", "text-button", "Cancel");
    cancel.addEventListener("click", () => dialog.close());
    const buttons = el("div", "dialog-buttons");
    const choose = (value: string) => () => {
      answer = value;
      dialog.close();
    };
    dialog.append(el("h2", undefined, question), el("p", undefined, detail));
    // A choice between answers ("This event", "This and following events",
    // "All events"): one under another, all alike, the usual one marked and
    // ready for Enter. Cancel below.
    if (answers.length >= 2) {
      const list = el("div", "ask-choices");
      list.setAttribute("role", "group");
      list.setAttribute("aria-label", question);
      for (const [value, label, usual] of answers) {
        const button = el("button", usual ? "ask-choice usual" : "ask-choice", label);
        button.type = "button";
        button.addEventListener("click", choose(value));
        list.append(button);
      }
      buttons.append(cancel);
      dialog.append(list, buttons);
      dialog.showModal();
      (list.querySelector<HTMLElement>(".usual") ?? list.querySelector<HTMLElement>(".ask-choice"))?.focus();
      return;
    }
    // One answer (Delete…): beside Cancel, which has the focus, so Enter
    // doesn't delete by mistake.
    buttons.append(cancel);
    for (const [value, label, danger] of answers) {
      const button = el("button", danger ? "primary-button danger" : "text-button", label);
      button.addEventListener("click", choose(value));
      buttons.append(button);
    }
    dialog.append(buttons);
    dialog.showModal();
    cancel.focus();
  });
}

function row(label: string, content: string | Node): HTMLElement {
  const node = el("div", "details-row");
  const value = el("div", "details-value");
  value.append(content);
  node.append(el("div", "details-label", label), value);
  return node;
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const button = el("button", "link-button", text);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

const isWebLink = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

function callService(url: string): string {
  if (url.includes("meet.google.com")) return "Google Meet";
  if (url.includes("zoom.us")) return "Zoom";
  if (url.includes("teams.microsoft.com") || url.includes("teams.live.com")) return "Teams";
  if (url.includes("webex.com")) return "Webex";
  return "call";
}

/**
 * Files on an event (Drive files) or a task (on its Todoist comments): each
 * opens; Add file… attaches more (an event's go to your Drive first); an
 * event's can be taken off (the file stays in Drive). Null when there's
 * nothing to show or add.
 */
function attachmentsRow(item: AgendaItem, actions: DetailActions, dialog: HTMLDialogElement): HTMLElement | null {
  const isEvent = item.kind === "event" && item.source === "google";
  const isTask = item.kind === "task" && item.source === "todoist";
  const canAdd = isTask || (isEvent && item.editable);
  if (!isEvent && !isTask) return null;
  if (!canAdd && !(item.attachments?.length)) return null;
  const box = el("div", "attachments");
  const list = el("ul", "attachment-list");
  const note = el("span", "reply-note");
  let shown: Attachment[] = [];
  const draw = () => {
    list.replaceChildren(
      ...shown.map((file) => {
        const li = el("li");
        const open = linkButton(file.title, () => void openUrl(file.url));
        open.classList.add("attachment-name");
        open.title = `Open ${file.title}`;
        li.append(open);
        if (isEvent && item.editable) {
          const remove = el("button", "icon-button attachment-remove", "×");
          remove.type = "button";
          remove.title = "Take it off this event (the file stays in your Drive)";
          remove.setAttribute("aria-label", `Remove ${file.title}`);
          remove.addEventListener("click", async () => {
            note.textContent = "";
            try {
              await removeEventAttachment(eventRef(item, false), file.url);
              shown = shown.filter((f) => f !== file);
              draw();
              actions.changed(item);
            } catch (e) {
              note.textContent = `Couldn't remove it: ${errorMessage(e)}`;
            }
          });
          li.append(remove);
        }
        return li;
      }),
    );
    list.hidden = shown.length === 0;
  };
  if (isEvent) shown = [...(item.attachments ?? [])];
  else {
    note.textContent = "…";
    void taskAttachments(item.sourceId!).then(
      (found) => {
        shown = found;
        note.textContent = "";
        draw();
      },
      () => (note.textContent = ""),
    );
  }
  draw();
  box.append(list);
  if (canAdd) {
    const picker = el("input");
    picker.type = "file";
    picker.multiple = true;
    picker.hidden = true;
    const add = el("button", "text-button attachment-add", "Add file…");
    add.type = "button";
    add.addEventListener("click", () => picker.click());
    const buttons: HTMLButtonElement[] = [add];
    /** Attaches `chosen` (picked, pasted or dropped), one after another. */
    const addFiles = async (chosen: File[]) => {
      if (!chosen.length || add.disabled) return;
      let all = false;
      if (isEvent && inSeries(item)) {
        const scope = await ask(`Attach to “${item.title}”?`, "This is a repeating event.", [
          ["one", "This event", true],
          ["all", "All events", false],
        ]);
        if (scope !== "one" && scope !== "all") return;
        all = scope === "all";
      }
      buttons.forEach((b) => (b.disabled = true));
      try {
        for (const file of chosen) {
          note.textContent = isEvent ? `Adding ${file.name} to your Drive…` : `Adding ${file.name}…`;
          shown.push(isEvent ? await attachToEvent(eventRef(item, all), file) : await attachToTask(item.sourceId!, file));
          draw();
        }
        note.textContent = "";
        actions.changed(item);
      } catch (e) {
        note.textContent = `Couldn't attach it: ${errorMessage(e)}`;
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    };
    picker.addEventListener("change", () => {
      const chosen = [...(picker.files ?? [])];
      picker.value = "";
      void addFiles(chosen);
    });
    // ⌘V / Ctrl+V with a file or a screenshot copied, while these details are open.
    dialog.addEventListener("paste", (e) => {
      const pasted = [...(e.clipboardData?.files ?? [])];
      if (!pasted.length) return; // text: left as it is
      e.preventDefault();
      void addFiles(pasted.map(named));
    });
    // Files dragged onto the details.
    dialog.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      dialog.classList.add("dropping");
    });
    dialog.addEventListener("dragleave", (e) => {
      if (e.target === dialog) dialog.classList.remove("dropping");
    });
    dialog.addEventListener("drop", (e) => {
      const dropped = [...(e.dataTransfer?.files ?? [])];
      dialog.classList.remove("dropping");
      if (!dropped.length) return;
      e.preventDefault();
      void addFiles(dropped);
    });
    // Paste: what's on the clipboard (a photo, a screenshot). On a phone
    // there's no ⌘V; the browser asks before it lets the page read it.
    if (navigator.clipboard && "read" in navigator.clipboard) {
      const paste = el("button", "text-button attachment-add", "Paste");
      paste.type = "button";
      paste.title = "Attach what's on the clipboard";
      paste.addEventListener("click", async () => {
        note.textContent = "";
        try {
          const found: File[] = [];
          for (const entry of await navigator.clipboard.read()) {
            const type = entry.types.find((t) => !t.startsWith("text/"));
            if (type) found.push(named(new File([await entry.getType(type)], "", { type })));
          }
          if (found.length) await addFiles(found);
          else note.textContent = "There's no file or picture on the clipboard.";
        } catch {
          note.textContent = "Couldn't read the clipboard. Allow it when asked, or use Add file….";
        }
      });
      buttons.push(paste);
    }
    const actionsLine = el("div", "attachment-actions");
    actionsLine.append(add, ...buttons.slice(1));
    box.append(actionsLine, picker);
  }
  box.append(note);
  return box;
}

/** A pasted file without a name (a screenshot) gets one: "Pasted 2026-11-06 13.20.05.png". */
function named(file: File): File {
  if (file.name && file.name !== "image.png") return file;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "bin";
  return new File([file], `Pasted ${stamp}.${extension}`, { type: file.type });
}

/**
 * Yes / Maybe / No for an invitation, showing the reply you've given. For a
 * repeating event, asks whether it's for this one or all of them. The
 * organizer is told.
 */
function replyButtons(item: AgendaItem, current: string | null, actions: DetailActions): HTMLElement {
  const box = el("div", "reply");
  const choices = el("div", "segmented");
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", "Your reply");
  const note = el("span", "reply-note");
  const answers: [reply: "accepted" | "tentative" | "declined", label: string][] = [
    ["accepted", "Yes"],
    ["tentative", "Maybe"],
    ["declined", "No"],
  ];
  const buttons = answers.map(([reply, label]) => {
    const button = el("button", undefined, label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(current === reply));
    button.addEventListener("click", async () => {
      if (button.getAttribute("aria-pressed") === "true") return;
      let all = false;
      if (inSeries(item)) {
        const scope = await ask(`Reply to “${item.title}”?`, "This is a repeating event.", [
          ["one", "This event", true],
          ["all", "All events", false],
        ]);
        if (scope !== "one" && scope !== "all") return;
        all = scope === "all";
      }
      note.textContent = "";
      buttons.forEach((b) => (b.disabled = true));
      try {
        await respondToEvent(eventRef(item, all), reply);
        buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
        note.textContent = "The organizer is told.";
        actions.changed(item);
      } catch (e) {
        note.textContent = `Couldn't reply: ${errorMessage(e)}`;
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    });
    return button;
  });
  choices.append(...buttons);
  box.append(choices, note);
  return box;
}

function guestList(attendees: Attendee[]): HTMLElement {
  const list = el("ul", "guest-list");
  // Organizer first, then everyone else in Google's order.
  const sorted = [...attendees].sort((a, b) => Number(b.organizer) - Number(a.organizer));
  for (const guest of sorted) {
    const name = guest.name ?? guest.email ?? "Unknown";
    const notes = [guest.isSelf ? "you" : "", guest.organizer ? "organizer" : ""].filter(Boolean);
    const li = el("li");
    const label = notes.length ? `${name} (${notes.join(", ")})` : name;
    // Someone else's name opens them in Contacts (or offers to add them).
    const email = guest.email;
    if (email && !guest.isSelf) {
      const person = linkButton(label, () => openContacts(email));
      person.classList.add("guest-name");
      person.title = `Show ${email} in Contacts`;
      li.append(person);
    } else li.append(el("span", undefined, label));
    const response = guest.response ? RESPONSES[guest.response] : undefined;
    if (response) li.append(el("span", `guest-response ${guest.response}`, response));
    list.append(li);
  }
  return list;
}

/**
 * Turns notes into text and link buttons. Google's notes can be HTML; it's
 * parsed into a detached document (where nothing runs or loads) and only its
 * text and link addresses are kept, so no HTML from an event reaches the page.
 */
function notesToNodes(notes: string): Node[] {
  if (!/<[a-z][\s\S]*>/i.test(notes)) return linkify(notes);
  const doc = new DOMParser().parseFromString(notes, "text/html");
  const out: Node[] = [];
  const BLOCKS = new Set(["P", "DIV", "LI", "UL", "OL", "TR", "H1", "H2", "H3", "H4", "H5", "H6"]);
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(...linkify(node.textContent ?? ""));
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") {
      out.push(document.createTextNode("\n"));
      return;
    }
    const href = node.tagName === "A" ? node.getAttribute("href") : null;
    if (href && isWebLink(href)) {
      out.push(linkButton(node.textContent?.trim() || href, () => openUrl(href)));
      return;
    }
    if (BLOCKS.has(node.tagName)) out.push(document.createTextNode("\n"));
    node.childNodes.forEach(walk);
    if (BLOCKS.has(node.tagName)) out.push(document.createTextNode("\n"));
  };
  doc.body.childNodes.forEach(walk);
  return tidyLines(out);
}

/** Joins neighbouring text and drops the extra blank lines HTML leaves. */
function tidyLines(nodes: Node[]): Node[] {
  const merged: Node[] = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (node instanceof Text && last instanceof Text) last.textContent += node.textContent ?? "";
    else merged.push(node);
  }
  merged.forEach((node, i) => {
    if (!(node instanceof Text)) return;
    let text = (node.textContent ?? "").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n");
    if (i === 0) text = text.trimStart();
    if (i === merged.length - 1) text = text.trimEnd();
    node.textContent = text;
  });
  return merged;
}

/** Plain text, with web addresses turned into link buttons. */
function linkify(text: string): Node[] {
  return text
    .split(/(https?:\/\/[^\s<>"]+)/)
    .filter((part) => part !== "")
    .flatMap((part) => {
      if (!/^https?:\/\//.test(part)) return [document.createTextNode(part)];
      // "See https://example.com." – the full stop isn't part of the address.
      const url = part.replace(/[.,;:!?)]+$/, "");
      return [linkButton(url, () => openUrl(url)), document.createTextNode(part.slice(url.length))];
    });
}
