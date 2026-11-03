# Architecture and roadmap

## How the pieces fit

```
┌──────────── Web view (TypeScript, src/) ────────────┐
│ main.ts    shell: sign-in, toolbar, navigation,     │
│            keyboard shortcuts, cache of ranges      │
│ views/     index.ts (range/step/title per view),    │
│            timeline.ts (day+week), month.ts,        │
│            year.ts, agenda.ts                       │
│ time.ts    date helpers shared by all views         │
│ api.ts     typed invoke() wrappers                  │
│ settings.ts Settings, Google accounts, Todoist      │
│ preferences.ts settings kept on this device         │
│ maps.ts    where a place opens                      │
│ event-form.ts New/Edit event or task form;          │
│            quick-parse.ts reads the sentence        │
│ details.ts event/task details, Edit and Delete      │
│ search.ts  search window                            │
│ flyout.ts  the menu bar window (desktop)            │
│ contacts/  Contacts (contacts.html): main.ts shell, │
│            parse.ts the box, card.ts, form.ts       │
│ boot.ts    what every page does first               │
│ sync.ts    tells the other window about changes     │
│ dev-mock.ts sample data for `npm run dev` and Demo  │
│            mode; demo.ts turns Demo mode on and off │
└───────────────────────┬─────────────────────────────┘
                        │ invoke("get_agenda") etc. (Tauri IPC)
┌───────────────────────┴──── Rust (src-tauri/src/) ──┐
│ lib.rs             commands + shared state          │
│ agenda.rs          AgendaItem model, merge + sort   │
│ google/auth.rs     OAuth PKCE + loopback, tokens    │
│ google/calendar.rs Calendar API v3 client           │
│ google/contacts.rs People API v1 (Google Contacts)  │
│ contacts.rs        all accounts' contacts + saved   │
│ interactions.rs    Contacts' Recent and History     │
│ todoist.rs         Todoist API v1: tasks, add, done │
│ search.rs          search across accounts/Todoist   │
│ cache.rs           saved items for offline use      │
│ desktop.rs         menu bar icon + window, ⌥⌘N      │
│ alerts.rs          notifications, time to leave,    │
│                    the menu bar's next event        │
│ prefs.rs           settings kept for the Rust side  │
│ apple.rs           Mac: Calendar + Reminders apps   │
│ leave.rs           leave-by time: Routes, cache     │
│ travel.rs          Mac: location, Apple Maps times  │
│ secrets.rs         OS keychain                      │
│ error.rs           AppError → { kind, message }     │
└─────────────────────────────────────────────────────┘
```

Design rules:

1. **Tokens never reach the web view.** Every network call and secret lives in
   Rust. The web view gets only agenda data. If a malicious event title ever
   ran script in the web view (the UI only uses `textContent`, so it shouldn't),
   it still couldn't read your tokens.
2. **One model for everything on the agenda.** `AgendaItem` has `source`
   (`google`, `todoist`) and `kind` (`event`, `task`). New sources
   add items to the list; the UI doesn't need to know where they came from.
3. **Views are plain functions.** Each view takes a `ViewContext` (items plus
   date range) and draws into an element. The menu bar window reuses
   `renderAgenda`.
4. **The backend serves any date range.** `get_agenda(from, to)` takes local
   dates. Each view decides its own range (a week, six weeks for a month grid,
   a year).

## Menu bar, quick add shortcut, background alerts (done)

Desktop only (`#[cfg(desktop)]`), in `desktop.rs` and `alerts.rs`:

- A `TrayIconBuilder` icon (`icons/tray.png`: the logo in colour, rendered
  from `icons/source/tray.svg`, the icon artwork cropped to its tile, at 60
  of 72 px so the menu bar's 18 pt shows a 15 pt tile, 1 pt above centre to
  sit level with the text beside it, with a thin gold ring (the brand gold, `--gold`) so the navy shows
  on a dark menu bar). Left click toggles the `flyout` window; right click shows
  Open / New Event… / Quit.
- The `flyout` window is built in `setup` (380×600, resizable, no frame,
  always on top, hidden) and loads the same page with
  `window.__MINUTEMAN_FLYOUT__` set, so `main.ts` hands over to
  `flyout.ts`. `place_under_icon` puts it under the icon, on the screen the
  icon is on (its last click or hover gives its place, in that screen's
  pixels; on a Mac, where windows are placed in points and screens can
  differ in scale, the screen is the one the pointer is on); it hides when
  it loses focus or on Esc.
- Detaching (its header's button, or dragging it: a `Moved` event the app
  didn't cause) makes it an ordinary window that stays where you put it and
  stays open; the header then has put-back and close buttons.
- `tauri-plugin-autostart` (a LaunchAgent on the Mac, the registry's Run key
  on Windows) for Settings → Open at login; it passes `--hidden`, and
  `desktop::setup` then hides the main window, so it starts in the menu bar.
- `tauri-plugin-global-shortcut` registers ⌥⌘N, which shows the flyout
  and emits `flyout-new` to open New event in it.
- Closing the main window hides it (`CloseRequested` → `prevent_close`);
  `RunEvent::Reopen` (Dock click) shows it again.
- `sync.ts`: each window emits `agenda-changed` after a change, and the
  other reloads.

Mac only (`#[cfg(target_os = "macos")]`), through the `objc2-*` crates:

- **Apple Calendar and Reminders** (`apple.rs`): EventKit on one background
  thread that owns the `EKEventStore`. Events and reminders become
  `AgendaItem { source: Apple }` (read-only; reminders can be ticked off via
  `set_task_completed`). `agenda::load` adds them when turned on in Settings
  (`prefs.rs`). Calendars whose account looks like one of your Google ones
  start hidden, to avoid doubles.
- **Leave by** (`leave.rs`, used by `alerts.rs` and the `leave_times`
  command): a starting address (Settings, or the event's own
  `minutemanLeaveFrom` property) and Google's Routes API
  (`routingPreference: TRAFFIC_AWARE`). The key is the environment variable
  `MINUTEMAN_ROUTES_API_KEY`, else the keychain, else (development builds) a
  `.env` line read at run time — never compiled in. Driving traffic is asked
  at a departure time, then once more if that drive would change when you
  leave. Every attempt, including a failure, counts toward a daily and a
  monthly cap (`routes-usage.json`, reset at midnight Pacific time) so a
  month of traffic-aware requests stays inside the free 5,000. The website
  uses the same cap: the address is saved on the Worker, and lookups run
  there only when `MINUTEMAN_ROUTES_API_KEY` is a Cloudflare secret (it never
  reaches the browser). At the cap,
  nothing new is asked; a drive already saved is still used, and a leave
  alert without one waits. A drive longer than 4 hours (`MAX_PLAUSIBLE_DRIVE`,
  `MAX_PLAUSIBLE_DRIVE_MINUTES`) is taken as an address matched in the wrong
  town, the usual cause being a street with no town or ZIP: status
  `implausible`, no leave-by time or alert, and the details say how long
  Google's drive was and to fix the address. Settings warns when the address
  has no comma or ZIP (`looksComplete`). It asks for the address in four
  fields (`address-line1`, `address-level2`, `address-level1`,
  `postal-code`), so AutoFill fills the whole saved address, not just the
  street; `joinAddress` and `splitAddress` (`routes-budget.ts`) turn them
  into one "street, town, ST zip" string and back. **Start from where I am**
  (`leaveFromHere`) starts from the device's location instead: the page
  sends it as `here` ("@lat,lng" to 3 decimals, about 100 m, so the cache
  still hits) to `leave_times`, and Google gets it as a `latLng` waypoint
  (`spot_origin`, `pick_origin`, `waypoint`). The Mac app finds it with
  Core Location, also for background alerts (`alerts.rs` `here_now`,
  re-found every 5 minutes); the website and Windows use the browser's or
  WebView's location for what's on screen, and Windows' background alerts
  use the address. The event's own Leave from still wins, and with no
  location the address is used. Answers are cached, and refreshed sooner as the
  event gets closer
  (5 minutes inside 45 minutes, up to 4 hours when it's more than 12 hours
  away). Nothing is asked until the event is inside 48 hours, or when there's
  no key, no address, no real place, or the lookup fails. "Before leaving" is
  an alert stored with the others Minuteman keeps (`minutemanAlerts`, a
  `leave` list of buffer minutes). It fires at leave-by minus that buffer,
  once, while the event hasn't started.
- **Time to leave** (the older switch, still in Settings): for events that
  don't set their own leave alert, within 3 hours, plus 5 minutes. With an
  address it uses the same Routes path. With none, on a Mac, `travel.rs`
  follows the location (`CLLocationManager`) and asks Apple Maps
  (`MKDirections`) for the drive. The time math is the same either way.
- Permissions: the prompts' texts are in `Info.macos.plist`, and the hardened
  runtime's calendar and location entitlements in `Entitlements.macos.plist`
  (`tauri.conf.json` → bundle → macOS).
- To check Mac code compiles on Linux: `rustup target add
  aarch64-apple-darwin`, then `cargo check --target aarch64-apple-darwin`
  with `CC_aarch64_apple_darwin` set to a stand-in compiler that writes empty
  object files (a check never links).

The multi-day view ("3 Days", `days` in `views/index.ts`) works the same
way with fewer columns across: `multiDayCount()` from `preferences.ts`, set
in Settings (`settings.ts`) and kept in local storage per device.

Week view slides: it draws six weeks (`WEEK_DRAWN_DAYS`) with columns a
seventh of the width, in one box that scrolls both ways (headers and hours
are `position: sticky`), with `scroll-snap-type: x mandatory` so it settles
on a day. `ViewContext.slid` reports the first day shown; once it settles in
another week, `main.ts` draws six weeks around it. Arrows and Today slide
there with `slideTimeline` when it's among the days drawn. While a slide is
on its way, `heading` (main.ts) is where it's going, and ‹ › count on from
there, so quick taps each move a week.

On a touch screen (`pointer: coarse`) the sliding views are **split**
(`.timeline.split`): `.tl-scroll` only slides the days, and the hours scroll
up and down in `.tl-body` inside it. Browsers can't lock one box that
scrolls both ways to one direction per swipe, but with two boxes the phone
gives each swipe to one of them, so it never goes diagonally. The hours
aren't sticky to the outer box any more, so they move along with it: a
scroll-driven animation (`animation-timeline: --days`, by `--days-scroll`,
how far the days can slide), or a `scroll` listener where that's
unsupported. `.tl-body` has `overscroll-behavior-x: auto` (everything else
is `none`): otherwise a sideways swipe on the hours isn't passed on to the
outer box. With a mouse or trackpad it stays one box, as the hours' scroll
bar would otherwise be at the far right of the six weeks.

**Place suggestions** (`place-suggest.ts`): `enablePlaceSuggestions(field)`
puts a list under a field (in its dialog, `position: fixed`) from Photon
(`photon.komoot.io`, free OpenStreetMap search, no key; in both CSPs'
`connect-src`), from 3 letters after a 250 ms pause. Near you first
(`nearYou`, never asking for anything new): the weather's place, else the
town of the Leave from address (only "town, ST ZIP" is looked up, once, and
kept), else the device's location if already allowed; sent rounded to about
a kilometre, and results more than 150 km away come after nearer ones.
OpenStreetMap often has a street but not its house numbers, so a typed
number goes in front of a street found without one ("20 Nora Drive"). The
list is placed in the field's own box (`.place-suggest-host`), so it moves
with the field; it goes above the field when there's more room there than
below, measured against `visualViewport` (above a phone's keyboard). US states are shortened ("MA") so a picked address reads like one
typed. `findPlace(text)` is for places in the sentence: `parseEvent` finds
capitalised ones ("at Old North Church"); the form looks up lowercase ones
it can't tell from words (`placeAtEnd`: "coffee at starbucks", not "look at
the house") and keeps them only if a place nearby has that name; either way
the Location field gets the full address once found.

**Repeating events** (`series.ts`): saving (the form), dragging and deleting
one event of a Google series ask "This event / This and following events /
All events". "This and following" is `end_series_before`: the series gets
an UNTIL just before this event (`occurrenceStart`, the time Google keeps),
and the rules come back for a new series created from this event (COUNT
dropped, as what's left of it isn't known). For the series' first event,
nothing comes before it, so it's all events instead.

**Event colors** (`event-colors.ts`, `EVENT_COLORS` in calendar.rs): an
event's `colorId` ("1" to "11", Google's names and the colors its apps show)
becomes `AgendaItem.color` (else the calendar's) and `colorId`.
`EventDraft.colorId`: missing leaves it, "" clears it (sent as null in the
PATCH), an id sets it.

**Demo mode** (`demo.ts`, Settings → Demo mode, or `?demo`): `boot()` starts
it before anything else, with `dev-mock.ts`'s sample data. On the website
and in `npm run dev` it stands in for the server or Rust side (`mockIPC`);
in the desktop app, where Tauri's `invoke` can't be replaced, `api.ts`
asks it first (`answerCommandsHere`), and windows, events, location and
open-at-login still go to the app. `localStorage` is swapped for a view of
it whose keys start with `demo:`, so the demo's settings stay apart. The
switch is kept per tab on the website (`sessionStorage`) and for every
window in the app (`localStorage`, with an event that reloads them).
Its clock starts at 9:45 PM on April 18, 1775 (`DEMO_START`): `Date` is
replaced when demo.ts loads, before the pages' own code runs, and its
weather is made up (`demoWeather`). Before 1883 a place kept its own local
time, seconds off the hour, which an ISO offset can't say, so `toLocalIso`
gives such times in UTC.

## Contacts (done)

Minuteman's Cardhop: a second page, `contacts.html` (Vite builds both pages,
`vite.config.ts`), on top of Google Contacts.

- **Where it opens:** on the desktop, its own window (`desktop::show_contacts`,
  label `contacts`, made the first time and hidden on close), from the main
  window's person button or `C`, the tray menu, or the global `⌥⌘K`
  (`CONTACTS_SHORTCUT`). `show_contacts(query)` passes a query: the first time
  as `window.__MINUTEMAN_CONTACTS_QUERY__`, later as a `contacts-shown` event.
  On a phone and the website, `contacts/open.ts` goes to `contacts.html?q=…`
  instead. An event's guest names (`details.ts`) open them there.
- **Google:** the `contacts` scope (`CONTACTS_SCOPE` in google/auth.rs and
  web/src/google.ts; `can_use_contacts`, like `can_edit_events`) and the
  People API: `people/me/connections` (all pages), `people:createContact`,
  `people/{id}:updateContact` with `updatePersonFields` listing only the
  fields in the `ContactDraft` (left out = unchanged, empty = cleared) and the
  `etag` it was read at, `:deleteContact`, and `contactGroups/starred/members:modify`
  for Favorites. Resource names from the page are checked to be `people/<id>`.
  Addresses are read and written as Google's `formattedValue`, so an address
  is only sent back when it was edited. Accounts without the scope come back
  with `canUse: false`, and the page offers **Allow…** (`sign_in` again).
- **Offline** (`contacts.rs`): `contacts.json` beside `agenda.json`, replaced
  per account on each fetch, updated on each change made here; used when no
  account is reachable, and by `get_saved_contacts` to draw at once.
- **The box** (`contacts/parse.ts`, no page code, so it can run anywhere):
  `interpret()` turns the text into an `Intent`: a verb first ("call",
  "text", "email", "facetime", "meet", "note", "map") and the longest run of
  up to 4 words that finds someone is an action; otherwise
  `parseDetails()` picks out notes, a birthday, emails, websites, addresses,
  phone numbers, a nickname and "Job at Company", leaving the name. Details
  nobody has are a new contact, or more for someone named in full; anything
  else is a search (`model.ts` `matchScore`: each word starts a name word,
  or is in a company, email or phone number). "meet Sam tomorrow 3pm" opens
  New event with `eventSentence` (`openNew`'s `sentence`), so quick-parse.ts
  reads the time and invites them.
- **History and Recent** (`interactions.rs`, `contacts/history.ts`): a log of
  `{ contactId, kind, at, detail }` (kinds: call, message, email, facetime,
  meeting, met, note, added), stamped on the Rust side, at most 5000, in
  `interactions.json` in the config folder (on the web, KV `interactions`,
  encrypted). Logged when an action is started from Contacts (not when the
  call happens: there's no way to know), a meeting saved from "meet…", a
  note added, a contact added, or by hand ("called Sam about…", **Log…**).
  Deleting a contact or removing an account drops its entries. Recent is
  the 6 people with the latest entries; a card's History merges its entries
  with past events found by `search`, a repeating event once (its latest).
- **Birthdays → calendar:** clicking one calls `openCalendar(day)`
  (`contacts/open.ts`): on the desktop `show_main`, then the
  `calendar-go-to-day` event that main.ts listens for; elsewhere
  `./?date=YYYY-MM-DD`, read once at start. Either shows Day view.
- **The card** (`contacts/card.ts`): quick actions open `sms:`, `tel:`,
  `mailto:`, `facetime:` (allowed in `capabilities/default.json`) or a maps
  link (`maps.ts`: Apple Maps on a phone, Google Maps on a computer, unless
  Settings chose one); several numbers give a menu. "With Sam" searches the calendars
  (`search`) for their email addresses, after the card has been up 300 ms.
  Photos load from `*.googleusercontent.com` (allowed in both CSPs);
  without one, initials on a colour. Notes added here are dated lines.

## Todoist (done)

- Uses Todoist's API v1 with the personal API token, stored in the keychain
  under `todoist-token` (`settings.ts` is the connect dialog).
- `todoist.rs` fetches all active tasks and projects, keeps tasks with a due
  date in the requested range, and maps them to
  `AgendaItem { source: Todoist, kind: Task, … }`. Overdue tasks are shown on
  today. Project colors and P1–P4 priorities carry over.
- `agenda::load` fetches Google and Todoist at the same time. A Todoist
  failure becomes a warning banner instead of hiding the calendar.
- Ticking a checkbox calls `set_task_completed` (Todoist's close/reopen).
  Done tasks stay visible, struck through, until the app restarts.
- Limits for now: recurring tasks show only their next occurrence (that's all
  the API returns), and tasks completed elsewhere aren't shown.

## Adding and editing (done)

- **+** in the top bar (or `N`) opens `event-form.ts`. The sentence box at
  the top is read locally by `quick-parse.ts` with
  [`chrono-node`](https://github.com/wanasit/chrono) (English only): date and
  time, a range ("9-10:30am", "Nov 12-14"), a length ("for 30 min", default
  1 hour), a place ("at Cafe Roma", "in Berlin"), a repeat ("every weekday",
  "every 2 weeks", "monthly on the 1st"), an alert ("remind me 30 min
  before", "no alert") and guests (email addresses). It fills the fields
  below, except ones edited by hand. A bare hour from 1 to 7 means pm.
- Events: `create_event` POSTs to `calendars/{id}/events` (with
  `recurrence` RRULEs, `reminders` and `attendees`; guests are emailed).
  `update_event` PATCHes only the fields that changed and can move the event
  to another calendar first; `delete_event` DELETEs. For one occurrence of
  a repeating event, "all events" uses `seriesId`; editing all events
  (`update_series`) shifts the series' own start by as much as the edited
  occurrence moved, so it keeps its first date. Editing a repeating event,
  the form fetches the series' rules (`event_recurrence`) and shows them in
  words (`recurrence.ts`); "Doesn't repeat after this one" sends them back
  with `UNTIL` set to that occurrence (`endAfter`). The `calendar.events`
  scope is in `google/auth.rs`; accounts added before need adding again
  once.
- Tasks go to Todoist (`create_task`, `update_task`, `delete_task`), into
  the chosen project (Inbox first). Repeats are sent as Todoist's own words
  (`due_string`, e.g. "every month on the 1st"); "p1"–"p4" set the priority.
  Repeating tasks can't be moved or have their date changed here (Todoist
  would end the repeat).

## Details, moving, search, alerts, offline (done)

- **Details** (`details.ts`): clicking any item opens a popup instead of the
  browser. Google's HTML notes are parsed with `DOMParser` into a detached
  document; only text and link addresses are shown (no HTML reaches the
  page). The video link comes from `conferenceData`/`hangoutLink`, or a
  Zoom/Meet/Teams/Webex address in the location or notes.
- **Moving** (`views/timeline.ts`): mouse/trackpad drag in day and week
  views, in 15-minute steps; the bottom 7px resize. Pointer moves are
  listened for on the window, because moving the block to another day's
  column ends pointer capture. `set_event_times` PATCHes start and end; one
  occurrence of a repeating event changes only that occurrence. Month view
  and the all-day row move items by whole days (`views/drag.ts`); tasks use
  `set_task_due`.
  `AgendaItem.editable` = account granted `calendar.events` + calendar
  owner/writer + organized by you (or `guestsCanModify`).
- **Search** (`search.rs`): Google's `q` per calendar for a year either
  side; Todoist tasks matched locally on every word; the offline cache
  when nothing is reachable. 50 results each side of now.
- **Alerts** (`alerts.rs`): a background task checks every 30 s today's and
  tomorrow's timed events against their popup reminders (the event's own,
  or the calendar's defaults), reloading every 5 minutes or after a change
  made in the app. Alerts more than 2 minutes late are skipped (after
  sleep). It runs in Rust, so it keeps going with no window open. Desktop
  only via `tauri-plugin-notification`; iPhone alerts would need scheduling
  ahead with iOS.
- **Hidden calendars**: `prefs.rs` `google_calendars_hidden` on the desktop
  (and in KV, `hiddenCalendars`, on the web). `find_events` skips those
  calendars, so views, search, alerts and the menu bar all leave them out,
  and the offline cache filters them too. Settings → Calendars lists every
  calendar (`google_calendars`) and flips one (`set_google_calendar_shown`).
- **Weather** (`weather.ts`): Open-Meteo's forecast (16 days, plus the past
  7) for a place chosen in Settings, found with Open-Meteo's geocoding, or
  the current location, found again at each fetch (the Mac app asks Core
  Location through `current_location` in `travel.rs`; elsewhere the page
  asks the browser, `navigator.geolocation`);
  fetched by the page itself (the CSPs in `tauri.conf.json` and
  `web/src/index.ts` allow its two hosts), kept in local storage and fetched
  again after 3 hours. The views ask `weatherOn(day)` when they draw.
- **Sync** (`main.ts` `sync`, `flyout.ts`): the open window fetches its
  range again every minute, and on focus, `visibilitychange` and `online`;
  it redraws only if the answer differs from what's drawn, and skips while
  hidden, dragging or with a menu open. (Google push notifications need a
  public web address to call, which a desktop app doesn't have.)
- **Same time in any time zone** ("floating"): Google events have no such
  thing, so it's a private extended property, `minutemanFloating: "true"`
  (`FLOATING` in google/calendar.rs and web/src/google.ts). Loading one, its
  start and end are read as clock times in the event's own zone (its
  `timeZone`, else its calendar's) and given as those clock times here
  (`float_here`; on the web, in the browser's zone), so views, alerts and
  the menu bar all see them where they belong. Saving or dragging one turns
  the clock time shown back into an instant in its own zone
  (`sameClockIn` in time.ts). Apple Calendar's own floating events (no time
  zone) are marked too.
- **Press and hold** (`dom.ts` `onLongPress`): a finger resting 500 ms
  without moving more than 10 px. On items (`makeOpenable`) it, like a
  right-click, shows quick actions (`details.ts` `showItemMenu`, through
  `setItemMenu`); on day headings and empty spots (`views/create.ts`) it opens
  New event there. The innermost element takes the press; the tap and the
  system's own long-press menu that follow are swallowed. `#app` has no text
  selection or callout, so iOS doesn't start one.
- **iPhone page offset** (`main.ts` `keepPageInPlace`): after the keyboard
  closes, iOS can leave the never-scrolling page scrolled, so fixed buttons
  (the ☰ menu) stop answering taps where they're drawn; it's scrolled back
  to the top when the keyboard, a popup or focus goes.
- **Popups**: opening one popup from another (details → Edit, Settings and
  its screens) opens the new one before closing the old, so the dimmed
  background never drops for a frame; the background isn't redrawn while a
  popup is open (sync and weather wait until it closes).
- **Zoom to fit** (`views/timeline.ts` `busyHours`, `fit`): when other days
  come on screen (opening a view, or once a slide settles, animated), the
  hour height is set so their timed items fill the hours' height (between
  `MIN_HOUR_HEIGHT` and 96 px, at least 8 hours, 8 AM–6 PM if none; the
  small hours of last night's late event don't count; the phone's floating
  buttons are left clear). A pinch or scroll of your own keeps until other
  days come on screen, and so does resizing the window (once it stops
  changing; zoomed yourself, the hours are at least made to fill it).
  `fitted` remembers what was fitted, so redraws for the same days don't
  jump.
- **All-day row scrolling**: a gesture that starts up or down on it scrolls
  only it (`touchmove` is prevented, so the hours and days don't move too);
  one that starts sideways slides the days. A trackpad swipe keeps scrolling
  whichever it started on (`wheelGesture`), momentum included.
- **Creating from the grid** (`views/create.ts`): double-click a day or a
  time (snapped to 15 minutes) for New event there; right-click for a menu
  of New Event / New Task. `openNew` takes the place clicked as `At`.
- **Overlaps** (`views/timeline.ts` `layoutColumns`): events starting
  within a title's height of each other share the width side by side;
  a later one starting inside another is drawn over it, indented, as in
  Apple's Calendar.
- **Offline** (`cache.rs`): each successful fetch replaces the saved items
  in its range for the sources that loaded; `get_agenda` falls back to them
  on network errors (`offlineSince` drives the banner), and
  `get_saved_agenda` lets a view draw instantly before the fetch.

## Later: branding and design

- **Logo (done):** the sources are in `src-tauri/icons/source/`:
  `icon-mac.svg` (rounded tile with Apple's margins), `icon-windows.svg` (the
  same tile, nearly filling the square, so it isn't small in the Windows
  taskbar) and `icon-ios.svg` (full square; iOS rounds the corners itself).
  After editing, run `npm run tauri icon src-tauri/icons/source/icon-mac.svg`;
  then generate `icon-windows.svg` into a scratch folder
  (`npx tauri icon src-tauri/icons/source/icon-windows.svg -o <folder>`) and
  copy its `icon.ico`, `Square*Logo.png` and `StoreLogo.png` over; then copy
  the `ios/` images generated from `icon-ios.svg` into
  `src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/` (iOS icons must
  not have transparency).
  The website's icons are in `public/` (copied into the build as they are):
  `favicon.svg` is `icons/source/tray.svg` (the rounded tile);
  `apple-touch-icon.png` (180px), `icon-192.png` and `icon-512.png` are
  `icon-ios.svg` rendered full square without transparency, for phones' home
  screens and `manifest.webmanifest`.
- **Name (done): Minuteman.** It's `productName` and the window `title` in
  `src-tauri/tauri.conf.json`, the page title and heading in `index.html`
  and `main.ts`, the sign-in page in `google/loopback.rs`, and
  `PRODUCT_NAME` in the iOS project (`gen/apple/project.yml` and
  `project.pbxproj`). The `identifier` stays `com.lukesassa.calendar`:
  changing it would move the app's data folder and keychain access, so
  you'd sign in again.
- **Visual design (done):** taken from the icon. A navy header like the
  flag's canton (`--chrome`) over a thin red/ivory/red stripe band, ivory
  backgrounds, flag-red accent, and today as a star in a red square.
  Headings use Libre Caslon (Caslon was the type of the first printed
  Declaration of Independence), bundled from `@fontsource/libre-caslon-text`
  so it works offline. Dark mode is navy throughout with ivory text. All
  colors are CSS variables at the top of `src/styles.css`, with the dark
  block just below.
- **Google consent screen:** the app name, and a logo if you want one, on
  Google Auth Platform → Branding. Uploading a logo requires Google's brand
  verification once the app is published.

## iPhone (in progress)

Code is prepared; building happens on a Mac. See [ios-setup.md](ios-setup.md).
Sign-in uses Google's "iOS" client with a custom URL scheme (deep link)
instead of the desktop loopback server; `#[cfg(desktop)]` / `#[cfg(mobile)]`
pick the right path at compile time.

## Mobile later

- **Tauri v2 mobile:** the Rust core and the web UI are reused as they are. `keyring`'s
  `apple-native` feature also covers iOS. Android needs a different secure
  store (Android Keystore), e.g. via a Tauri plugin, behind the same
  `secrets.rs` functions. The loopback sign-in is replaced by a custom URL scheme or
  app link redirect with an "iOS" or "Android" OAuth client type.
- **PWA alternative:** the TypeScript UI could run in a browser, but OAuth
  and token storage would have to move to browser-safe flows (no client
  secret, no keychain). That's a bigger change, so Tauri mobile is the
  smoother path.
