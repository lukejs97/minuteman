<img src="src-tauri/icons/128x128@2x.png" alt="Minuteman's logo: a flag calendar, its navy canton of stars above red and white stripes" width="128" height="128">

# Minuteman

A free, personal calendar app in the style of Fantastical, on top of Google
Calendar (and, optionally, Todoist), for the Mac and Windows. An iPhone
version is in progress ([docs/ios-setup.md](docs/ios-setup.md)). Built with
[Tauri v2](https://tauri.app/): a Rust core plus a TypeScript web UI.

Website: [lukejs97.github.io/minuteman](https://lukejs97.github.io/minuteman/)
([privacy policy](https://lukejs97.github.io/minuteman/privacy.html)).

## Features

- **Views:** Day, a few days (3 unless you change it in Settings), Week,
  Month, Year and Agenda, for all your Google accounts' calendars together.
  The multi-day and week views slide through the days (two fingers on a
  trackpad, or a finger on a phone), as in Apple's Calendar. Day, multi-day
  and week views zoom to fit the days on screen: from just before their
  first event to just after their last (at least 8 hours), again as you
  slide to other days. Pinch to zoom yourself.
- **Add in a sentence:** click **+** (or press `N`), or double-click a day, a
  day's heading or a time (right-click for New Event or New Task), and type
  something like
  "Meeting with Paul Revere tomorrow 1pm at Green Dragon Tavern", "Muster
  every weekday at 9:30 with samuel.adams@example.com" or "First Continental
  Congress Sep 5 to Oct 26 in Philadelphia, remind me 1 day before". The fields
  below fill in as you type; change any of them by hand (title, times, all
  day, place, repeat, alert, guests, notes, calendar). Switch to **Task** to
  add a Todoist task ("Boston Tea Party Dec 16 p1", "Paul Revere's ride Apr 18
  p1", "Lexington and Concord Apr 19 p1", "Muster every month on the 1st").
  A place in the sentence ("at Old North Church", or lowercase like "at
  starbucks" when there's one nearby by that name) fills in the place, with
  its full address when one is found.
- **Place suggestions:** start typing in a place or address field (an
  event's Location or Leave from, Settings → Leave from, a contact's address)
  for matching places and addresses; pick one to fill it in. A contact's
  name ("sam ad") suggests their addresses from Google Contacts, first; the
  sentence box knows them too ("Dinner at Samuel Adams tomorrow 6pm"). From
  [Photon](https://photon.komoot.io), a free OpenStreetMap search with no
  account or key, so it never costs anything. What you type there is sent
  to it (from 3 letters); places near you come first. An address outside
  any town's limits gets its mailing town from its ZIP code (Zippopotam.us,
  also free; only the ZIP is sent, once).
- **Quick actions:** right-click an event or task (on a phone, press and
  hold it) for Open, Edit, Duplicate, Complete, Open in Google Calendar or
  Todoist, and Delete. On a phone, press and hold a day's heading, an empty time, or an
  hour down the side (for the leftmost day), for a new event there.
- **Same time in any time zone:** tick it on a timed event and it keeps its
  clock time wherever you are (a 9 AM muster stays 9 AM when you travel),
  while other events move to show the same moment in your new time zone.
  Google has no such events, so it's saved as a private mark on the event
  that Minuteman reads; Google's own apps still show it fixed.
- **Edit and delete:** click an event or task, then **Edit** or **Delete**.
  For a repeating event, saving, dragging or deleting asks, as Google
  Calendar does: **This event**, **This and following events**, or **All
  events** ("this and following" ends the series there and starts a new one
  from this event). Its repeat shows in words ("Every Monday", "Monthly on
  the second Tuesday"), and you can change it or stop it after this one.
  Guests are emailed about changes if you tick the box.
- **Duplicate:** an event's or task's details (or its right-click menu) →
  **Duplicate** opens New filled in like it, to change (the day, say) and add.
- **Event colors:** Google Calendar's eleven, or the calendar's own, in
  New or Edit (Color). For a repeating event, the question above says
  whether it's for this event, the ones after it, or all.
- **Details:** time, place (a map link; Apple Maps on a phone, Google Maps
  on a computer), a **Join** button for Google Meet, Zoom, Teams or Webex
  calls, guests and their replies, and notes.
- **Drag to move:** in Day and Week view, drag an event to another time or
  day, or its bottom edge to change its length (15-minute steps). In Month view
  and the all-day row, drag anything to another day. Tasks move too; a repeating one moves
  just its next date and keeps repeating, as in Todoist.
- **Choose calendars** (Settings → Calendars): hide any of your Google
  calendars; their events stay out of every view, search, alerts and the menu
  bar.
- **Weather** (Settings → Weather): use your current location, or pick a
  town, and each day shows its
  forecast (icon, high and low) for about two weeks ahead, from
  [Open-Meteo](https://open-meteo.com/), free and without an account.
- **Search** (magnifier, `/` or Cmd/Ctrl+F): events and tasks from a year back
  to a year ahead.
- **Contacts**, Minuteman's Cardhop: your Google contacts in a window of their
  own (the person button, `C`, the menu bar icon's menu, or `⌥⌘K` / Ctrl+Alt+K
  from any app; on a phone or the website, its own page). One box does
  everything, and the line under it says what Enter will do:
  - type a name, company, email or part of a number to **find** someone;
  - type someone new, like "Abigail Adams abigail@example.com 555-0100 Writer
    at Braintree birthday November 22", to **add** them (phones, emails,
    addresses, websites, a nickname in brackets, "note: …" are all picked out);
  - type someone you have with something new ("Paul Revere mobile 555-0101") to
    **add it to them**;
  - or say what to do: "call Paul", "text Paul", "email Paul about the ride",
    "facetime Paul" (Mac), "map Paul", "note Paul: two if by sea" (a dated
    note), or "meet Paul tomorrow 3pm" (New event, with them invited);
  - or log what you did: "called Paul about the lanterns", "met Abigail for tea".

  Each card has buttons to message, call, email, FaceTime, meet or map them,
  their details (click a number to call it, an address to map it), birthdays
  (with age; click one to see that day in the calendar), notes, upcoming
  events with them, and their **History**: calls, messages, emails and
  FaceTimes started here, meetings set up, notes, what you log (the card's
  **Log…**, or the box), and past events with them, latest first. **Recent**
  (who you were last in touch with), upcoming birthdays and Favorites sit at
  the top of the list. Settings opens from here too. In an event's details, click a
  guest's name to see them in Contacts (or add them). Contacts need the
  People API and one more permission
  ([docs/google-cloud-setup.md](docs/google-cloud-setup.md)); accounts added
  earlier get an **Allow…** button.
- **Menu bar** (notification area on Windows): the Minuteman icon opens a
  small month calendar with the next few days, and **+** to add. `⌥⌘N`
  (Ctrl+Alt+N on Windows) adds an event from any app. Closing the window keeps
  Minuteman running there; quit from the icon's right-click menu or with ⌘Q.
  What's next shows beside the icon ("Lexington and Concord in 12 min", "○ Paul Revere's ride at
  10:00 PM" for a task), or what's on now if nothing starts before it ends
  ("Congress until 5:00 PM"); turn it off in Settings. **Open at login** (Settings) starts Minuteman there when you log in, its window closed. Resize the small window from its edges; drag it (or click its
  detach button) to keep it open as a window of its own.
- **Stays in sync:** changes made elsewhere (Google Calendar, Todoist, your
  phone) show up within a minute while Minuteman is open, and as soon as you
  come back to it.
- **Alerts** at each event's reminder times from Google Calendar, also with
  the window closed. An event can have several, including an exact time and
  "before leaving".
- **Alerts on your phone** (Settings → Alerts on this device, on the
  website): the same alerts, sent by Minuteman's server even while it's
  closed. On an iPhone, add Minuteman to the Home Screen (Share → Add to
  Home Screen), open it from there, and turn alerts on (iOS 16.4 or later).
  **Send a test** checks it. The desktop apps keep alerting too, so both
  get them. "Before leaving" alerts start from the address in Settings.
- **Leave by** (Settings → Leave from): a default starting address (in
  separate street, town, state and ZIP fields, so AutoFill fills it all), or
  **Start from where I am** to use the device's location, with the address
  as a fallback (on Windows, turn on Settings → Privacy & security →
  Location → "Let desktop apps access your location"). An event can set its own starting place. Events at a real place show when to leave, from live
  traffic (Google's Routes API). Add **before leaving** as an alert — for
  example 10 minutes before that time, or 0 to be told at the leave-by time
  itself. The API key goes in Settings or in `MINUTEMAN_ROUTES_API_KEY` on
  the desktop, and on the website it is a Cloudflare secret (the page never
  sees it). It is never built into the app. Lookups stop at a daily and monthly limit
  (80 and 2,500 by default, changeable in Settings, never unlimited) so a
  month stays inside the free tier. With no key, no address, a full limit,
  or a failed lookup,
  the calendar still works and just doesn't show a time. On a Mac, Settings →
  Time to leave still alerts for events that don't set their own, using that
  address, or Apple Maps from the Mac's location when no address is set.
- **Apple Calendar and Reminders** (Mac; Settings): events from the Calendar
  app (iCloud, Exchange, anything added on the Mac) and reminders with a due
  date, alongside the rest. Tick reminders off here; other changes happen in
  Apple's apps for now. Calendars from your Google accounts start switched off
  (Settings → Choose calendars…), so they aren't shown twice.
- **Offline:** opens straight away with what it last loaded, and shows (and
  searches) it without internet.
- **Demo mode** (Settings → Demo mode): made-up events, tasks and people
  (Paul Revere's calendar: the militia muster, the Sons of Liberty, the
  midnight ride; its clock starts at 9:45 PM on April 18, 1775) in place of yours, for screenshots, screen recordings and copied text that
  show nothing real. Nothing is sent to Google, Todoist or the server while
  it's on, and settings changed in it are kept apart from your real ones. On
  the website it's just that tab (or add `?demo` to the address, e.g. in a
  second tab); in the desktop app it's every window until you turn it off.
- **Settings** (the gear, or `,`): Google accounts, Todoist, how many days
  the multi-day view shows (2 to 7; each device remembers its own), the
  leave-from address and Routes API key, which map opens a place, and on the
  desktop the menu bar, time to leave, and Apple Calendar and Reminders.
- **Several Google accounts:** Settings → Google accounts → **Add account**. While the
  Google project is in **Testing**, add the extra account as a test user first
  ([docs/google-cloud-setup.md](docs/google-cloud-setup.md#6-publish-the-app-in-production)).
- **Todoist** (optional): Settings → Todoist, then paste your API token
  from Todoist → Settings → Integrations → Developer. Tasks with a due date
  appear with a checkbox in every view, overdue ones on today. Repeating
  ones work as in Todoist's app: change the name, notes, priority or project
  freely; a new date moves just the next one; Edit → Repeat holds the repeat
  in Todoist's words ("every Monday"), to change it or (emptied) stop it.

**Keyboard:** `D` `X` `W` `M` `Y` `A` switch views (`X` is the multi-day one), `T` jumps to today, `N` adds
an event or task, `/` searches, `C` opens Contacts, `,` opens Settings, `←` `→` go back and forward (or swipe sideways
with two fingers). Click a date in the week header, month grid or year view to
open that day.

## Installing on a Mac

GitHub builds the Mac app (`.github/workflows/build-macos.yml`); no developer
tools needed.

1. Once: do the Google setup in
   [docs/google-cloud-setup.md](docs/google-cloud-setup.md). Then on GitHub,
   Settings → Secrets and variables → Actions → **New repository secret**: add
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
2. Recommended, once: add your own signing certificate as a third secret
   ([docs/mac-signing.md](docs/mac-signing.md)), so Calendar, Reminders and
   Location permissions last across updates.
3. Actions tab → **Build macOS app** → **Run workflow** (about 10 minutes).
4. Open the finished run, download **Minuteman-macOS** under Artifacts, unzip
   it, open the `.dmg` and drag Minuteman to Applications, replacing the old
   one. Then eject the `.dmg`. (Versions before the rename were called
   Calendar: delete that one. Your sign-ins carry over.)
5. The first time, macOS blocks it because it isn't notarized (Apple's paid
   check): System Settings → Privacy & Security → **Open Anyway**.
6. When asked whether Minuteman may use its keychain items, enter your
   password and choose **Always Allow**.

The build runs on Apple Silicon and Intel Macs. GitHub Actions is free for
public repositories.

## Installing on Windows

GitHub builds the Windows app too (`.github/workflows/build-windows.yml`),
with the same two Google secrets.

1. Actions tab → **Build Windows app** → **Run workflow** (about 15 minutes).
2. Open the finished run, download **Minuteman-Windows** under Artifacts,
   unzip it and run `Minuteman_…_x64-setup.exe`. It installs for your Windows
   account only (no administrator needed) and replaces an older version.
3. The first time each version runs, Windows SmartScreen warns that it's from
   an unknown publisher (the installer isn't signed with a paid certificate):
   **More info** → **Run anyway**.

## Developing

You need Node.js 20+, Rust ([rustup](https://rustup.rs/)), and on macOS the
Xcode Command Line Tools (`xcode-select --install`); on Windows, Microsoft C++
Build Tools ("Desktop development with C++") and WebView2 (built into Windows
11). Details: <https://tauri.app/start/prerequisites/>.

1. Do the Google setup in [docs/google-cloud-setup.md](docs/google-cloud-setup.md).
2. Copy `src-tauri/.env.example` to `src-tauri/.env` and fill in your client ID and secret.
3. Install and run:

   ```bash
   npm install
   npm run tauri dev
   ```

   The first run compiles all the Rust dependencies, which takes a few minutes.

`npm run tauri build` makes an installer in `src-tauri/target/release/bundle/`.

To work on the UI without the Rust side, run `npm run dev` and open
<http://localhost:1420> in a browser. It shows sample events (from
`src/dev-mock.ts`, the same data as Demo mode); add `?flyout` to the address
for the menu bar window, or open <http://localhost:1420/contacts.html> for
Contacts. How the code is organized:
[docs/architecture.md](docs/architecture.md).

## Where things are stored

- **Refresh tokens** (one per Google account) **and the Todoist token:** in
  your OS keychain under the service `com.mycalendar.app`. On Windows that's
  Credential Manager → Windows Credentials (`google-accounts.com.mycalendar.app`
  and `todoist-token.com.mycalendar.app`). On macOS, Keychain Access, all in one
  item, `secrets`, so macOS asks for your password once after an update rather
  than once per item; older versions' separate items are moved into it the
  first time.
- **Access tokens:** in memory only.
- **Removing an account** (Settings → Google accounts → Remove) deletes its token from the
  keychain and asks Google to revoke it.
- These names (`com.mycalendar.app`, `com.lukesassa.calendar`) are from before
  the app was called Minuteman. They stay as they are on purpose: changing
  them would sign you out and lose saved settings.
- **Contacts history** (Recent and each card's History): `interactions.json`
  in the app's config folder (on macOS `~/Library/Application Support/com.lukesassa.calendar`,
  on Windows `%APPDATA%\com.lukesassa.calendar`); on the website, encrypted
  on its server. It stays on that device or site, isn't sent to Google, and
  goes when you delete the contact or remove the account.
- **Saved events and contacts for offline use:** `agenda.json` and `contacts.json` in the app's cache folder
  (on macOS `~/Library/Caches/com.lukesassa.calendar`, on Windows
  `%LOCALAPPDATA%\com.lukesassa.calendar`). Deleting them is safe; the app just
  fetches again. Removing an account or disconnecting Todoist deletes its
  saved items (and an account's saved contacts).

On macOS, builds that aren't signed with your certificate (including
`npm run tauri dev`) ask for keychain access again after each rebuild
([docs/mac-signing.md](docs/mac-signing.md)).

## Glossary

- **OAuth**: the standard way for an app to get permission to use your Google
  account without ever seeing your password. You sign in on Google's own page,
  and Google gives the app tokens.
- **Client ID / client secret**: identify *the app* (not you) to Google.
- **Scope**: one specific permission, e.g. "read your calendars".
- **Consent screen**: Google's "Minuteman wants to access your account" page
  (the name is set in Google Auth Platform → Branding).
- **Access token**: a short-lived (about 1 hour) pass sent with each API request.
- **Refresh token**: a long-lived key the app uses to get new access tokens
  without asking you to sign in again. Treat it like a password, which is why
  it goes in the keychain.
- **PKCE** ("pixie", Proof Key for Code Exchange): before sign-in the app makes
  a random secret and sends Google only its hash. When the app trades Google's
  one-time code for tokens, it reveals the secret. Another program that
  intercepted the code can't use it, because it doesn't have the secret.
- **Loopback redirect**: after you approve, Google sends your browser to
  `http://127.0.0.1:<port>`. That's your own computer, where the app is briefly
  listening, so the app receives the one-time code.
- **Keychain**: the operating system's encrypted password store.
- **Tauri command**: a Rust function the TypeScript UI can call. `invoke("get_agenda")` runs `get_agenda` in `src-tauri/src/lib.rs`.
- **Web view**: the built-in browser engine that draws the UI (WebView2 on
  Windows, WebKit on macOS). It's why Tauri apps are small.
