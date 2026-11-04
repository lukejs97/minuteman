// Repeat → Custom… in the New and Edit form: every N days, weeks, months or
// years; which weekdays; which day of the month (the 12th, the second
// Tuesday, the last Friday); and when it ends (never, on a date, or after a
// number of times). Builds the RRULE Google keeps, and reads one back to
// change it.
import { el } from "./dom";
import { describeRecurrence } from "./recurrence";

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINALS = ["first", "second", "third", "fourth", "fifth"];
type Unit = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export class RepeatEditor {
  readonly root = el("div", "repeat-editor");
  private interval = el("input", "text-input repeat-interval");
  private unit = el("select", "text-input repeat-unit");
  private weekdays = el("div", "repeat-weekdays");
  private dayButtons: HTMLButtonElement[] = [];
  private monthly = el("select", "text-input repeat-monthly");
  private ends = el("select", "text-input repeat-ends");
  private until = el("input", "text-input repeat-until");
  private count = el("input", "text-input repeat-count");
  private summary = el("div", "form-notes repeat-summary");
  /** Weekdays chosen by hand: the start date's no longer decides. */
  private daysChosen = false;

  constructor(
    private changed: () => void,
    private start: () => Date | null,
    private allDay: () => boolean,
  ) {
    this.root.hidden = true;
    this.interval.type = "number";
    this.interval.min = "1";
    this.interval.max = "99";
    this.interval.value = "1";
    this.interval.inputMode = "numeric";
    this.interval.setAttribute("aria-label", "Every how many");
    for (const [value, words] of [
      ["DAILY", "days"],
      ["WEEKLY", "weeks"],
      ["MONTHLY", "months"],
      ["YEARLY", "years"],
    ]) {
      this.unit.append(new Option(words, value));
    }
    this.unit.value = "WEEKLY";
    this.unit.setAttribute("aria-label", "Days, weeks, months or years");
    this.weekdays.setAttribute("role", "group");
    this.weekdays.setAttribute("aria-label", "On these days");
    DAYS.forEach((_, i) => {
      const button = el("button", "repeat-day", DAY_NAMES[i][0]);
      button.type = "button";
      button.title = DAY_NAMES[i];
      button.setAttribute("aria-label", DAY_NAMES[i]);
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        const on = button.getAttribute("aria-pressed") !== "true";
        // At least one day: the last one can't be turned off.
        if (!on && this.chosenDays().length === 1) return;
        button.setAttribute("aria-pressed", String(on));
        this.daysChosen = true;
        this.update();
      });
      this.dayButtons.push(button);
      this.weekdays.append(button);
    });
    this.monthly.setAttribute("aria-label", "Which day of the month");
    this.ends.append(new Option("Never ends", "never"), new Option("Ends on", "on"), new Option("Ends after", "after"));
    this.ends.setAttribute("aria-label", "When it ends");
    this.until.type = "date";
    this.until.setAttribute("aria-label", "Last day");
    this.count.type = "number";
    this.count.min = "1";
    this.count.max = "999";
    this.count.value = "10";
    this.count.inputMode = "numeric";
    this.count.setAttribute("aria-label", "How many times");
    const times = el("span", "repeat-times", "times");

    const every = el("div", "repeat-line");
    every.append(el("span", undefined, "Every"), this.interval, this.unit);
    const end = el("div", "repeat-line");
    end.append(this.ends, this.until, this.count, times);
    this.root.append(every, this.weekdays, this.monthly, end, this.summary);
    for (const control of [this.interval, this.unit, this.monthly, this.ends, this.until, this.count]) {
      control.addEventListener("input", () => this.update());
      control.addEventListener("change", () => this.update());
    }
    this.update();
  }

  show(): void {
    this.root.hidden = false;
    this.refresh();
  }

  hide(): void {
    this.root.hidden = true;
  }

  /** The start date changed: its weekday and day of the month, where not chosen by hand. */
  refresh(): void {
    const start = this.start();
    if (start && !this.daysChosen) {
      this.dayButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === start.getDay())));
    }
    this.fillMonthly();
    if (!this.until.value && start) this.until.value = toDay(addMonths(start, 3));
    this.update(false);
  }

  /** Starts from a series' rules, to change them. False if they're not ones this can show. */
  setFromRules(rules: string[]): boolean {
    const rule = rules.find((r) => /^RRULE:/i.test(r));
    if (!rule) return false;
    const p = Object.fromEntries(
      rule
        .replace(/^RRULE:/i, "")
        .split(";")
        .map((part) => part.split("=").map((s) => s.toUpperCase())),
    ) as Record<string, string>;
    if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(p.FREQ)) return false;
    this.unit.value = p.FREQ;
    this.interval.value = String(Math.max(1, Number(p.INTERVAL || 1)));
    const days = (p.BYDAY ?? "").split(",").filter(Boolean);
    if (p.FREQ === "WEEKLY" && days.length) {
      this.dayButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(days.includes(DAYS[i]))));
      this.daysChosen = true;
    }
    this.fillMonthly();
    if (p.FREQ === "MONTHLY") {
      const nth = /^(-?\d)([A-Z]{2})$/.exec(days[0] ?? "");
      if (nth) this.monthly.value = nth[1] === "-1" ? "last" : "nth";
      else this.monthly.value = "day";
    }
    if (p.COUNT) {
      this.ends.value = "after";
      this.count.value = p.COUNT;
    } else if (p.UNTIL) {
      this.ends.value = "on";
      this.until.value = `${p.UNTIL.slice(0, 4)}-${p.UNTIL.slice(4, 6)}-${p.UNTIL.slice(6, 8)}`;
    } else this.ends.value = "never";
    this.update(false);
    return true;
  }

  /** The rule as Google keeps it: "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=10". */
  rule(): string {
    const start = this.start() ?? new Date();
    const unit = this.unit.value as Unit;
    const parts = [`FREQ=${unit}`];
    const every = Math.min(99, Math.max(1, Math.round(Number(this.interval.value) || 1)));
    if (every > 1) parts.push(`INTERVAL=${every}`);
    if (unit === "WEEKLY") parts.push(`BYDAY=${(this.chosenDays().length ? this.chosenDays() : [DAYS[start.getDay()]]).join(",")}`);
    if (unit === "MONTHLY") {
      const day = DAYS[start.getDay()];
      if (this.monthly.value === "nth") parts.push(`BYDAY=${Math.ceil(start.getDate() / 7)}${day}`);
      else if (this.monthly.value === "last") parts.push(`BYDAY=-1${day}`);
      else parts.push(`BYMONTHDAY=${start.getDate()}`);
    }
    if (this.ends.value === "after") parts.push(`COUNT=${Math.min(999, Math.max(1, Math.round(Number(this.count.value) || 1)))}`);
    if (this.ends.value === "on" && this.until.value) {
      const [y, m, d] = this.until.value.split("-").map(Number);
      // All day: the date itself. Timed: the end of that day here, in UTC.
      const until = this.allDay()
        ? this.until.value.replaceAll("-", "")
        : new Date(y, m - 1, d, 23, 59, 59).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      parts.push(`UNTIL=${until}`);
    }
    return `RRULE:${parts.join(";")}`;
  }

  private chosenDays(): string[] {
    return this.dayButtons.flatMap((b, i) => (b.getAttribute("aria-pressed") === "true" ? [DAYS[i]] : []));
  }

  /** "On day 12", "On the second Tuesday", and "On the last Tuesday" when it's in a month's last week. */
  private fillMonthly(): void {
    const start = this.start() ?? new Date();
    const kept = this.monthly.value || "day";
    const name = DAY_NAMES[start.getDay()];
    const nth = Math.ceil(start.getDate() / 7);
    const lastWeek = start.getDate() + 7 > new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    this.monthly.replaceChildren(
      new Option(`On day ${start.getDate()}`, "day"),
      ...(nth <= 4 ? [new Option(`On the ${ORDINALS[nth - 1]} ${name}`, "nth")] : []),
      ...(lastWeek ? [new Option(`On the last ${name}`, "last")] : []),
    );
    this.monthly.value = [...this.monthly.options].some((o) => o.value === kept) ? kept : "day";
  }

  private update(notify = true): void {
    const unit = this.unit.value as Unit;
    this.weekdays.hidden = unit !== "WEEKLY";
    this.monthly.hidden = unit !== "MONTHLY";
    this.until.hidden = this.ends.value !== "on";
    this.count.hidden = this.ends.value !== "after";
    this.root.querySelector<HTMLElement>(".repeat-times")!.hidden = this.ends.value !== "after";
    // "days" or "day", as the number says.
    const one = Number(this.interval.value) === 1;
    for (const option of this.unit.options) {
      const words: Record<string, string> = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" };
      option.text = one ? words[option.value] : `${words[option.value]}s`;
    }
    const start = this.start();
    this.summary.textContent = start ? (describeRecurrence([this.rule()], start) ?? "") : "";
    if (notify) this.changed();
  }
}

const toDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function addMonths(d: Date, months: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + months, d.getDate());
}
