# Google Cloud Console setup

This is a one-time setup, and it's free. You don't need a billing account: the
Google Calendar and People APIs have no charge, and a personal app stays far below its
usage limits.

You'll end up with a **client ID** and a **client secret**. They identify *your
app* to Google; they are not your password. Google's menus move around, so if a
label differs slightly, look for the closest match.

Sign in to the Cloud Console with the same Google account whose calendars you
want to see. Google Cloud requires **2-Step Verification** on that account. If
the console says "Google Cloud access blocked", turn it on at
<https://myaccount.google.com/signinoptions/twosv>, wait a few minutes, and
refresh.

---

## 1. Create a project

A *project* is Google Cloud's container for one app's settings and API access.

1. Open <https://console.cloud.google.com/>.
2. Click the project picker at the top left (it may say "Select a project"), then **New project**.
3. Name: `Calendar App` (anything works). Location/Organization: leave as is ("No organization" is fine).
4. Click **Create**, wait a few seconds, then make sure the new project is selected in the picker.

## 2. Enable the Google Calendar, People and Drive APIs

APIs are switched off by default in a new project. The People API is Google
Contacts, for Minuteman's Contacts window; the Drive API is for files
attached to events (they go to your Drive, as in Google Calendar).

1. Open <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
   (or **APIs & Services → Library**, search for "Google Calendar API").
2. Check that your project is selected at the top, then click **Enable**.
3. Do the same for <https://console.cloud.google.com/apis/library/people.googleapis.com>
   ("Google People API").
4. And for <https://console.cloud.google.com/apis/library/drive.googleapis.com>
   ("Google Drive API"). Until it's on, its permission (`drive.file`, step 4)
   isn't listed to add.

## 3. Configure the OAuth consent screen

The *consent screen* is the Google page that says "Minuteman wants to access your
Google Account". Here you give it a name and decide who can use it. In the
console this section is called **Google Auth Platform**.

1. Open <https://console.cloud.google.com/auth/overview> and click **Get started**.
2. **App information**
   - App name: `Minuteman` (it's what Google's sign-in page shows). Google
     rejects names that contain "Google".
   - User support email: your email.
3. **Audience**: choose **External**.
   ("Internal" only exists for Google Workspace organizations and only allows
   people inside that organization.)
4. **Contact information**: your email.
5. **Finish**: tick the box to agree to the Google API Services User Data Policy, then **Continue** and **Create**.

## 4. Add the Calendar, Contacts and Drive scopes

A *scope* is one specific permission the app asks for. The app asks for four:
reading your calendars, adding events to them, using your contacts, and
putting files you attach to events in your Drive (only those: not the rest
of your Drive).

1. In Google Auth Platform, open **Data Access**.
2. Click **Add or remove scopes**.
3. In the filter box, type `calendar.readonly` and tick
   `https://www.googleapis.com/auth/calendar.readonly` ("See and download any calendar you can access").
4. Clear the filter, type `calendar.events` and tick
   `https://www.googleapis.com/auth/calendar.events` ("View and edit events on all your calendars").
5. Clear the filter, type `auth/contacts` and tick
   `https://www.googleapis.com/auth/contacts` ("See, edit, download, and permanently delete your contacts").
6. Clear the filter, type `drive.file` and tick
   `https://www.googleapis.com/auth/drive.file` ("See, edit, create, and delete only the specific
   Google Drive files you use with this app"). It isn't a sensitive scope, so it needs no review.
7. Click **Update**, then **Save** at the bottom of the page.

Accounts added before the app could create events only gave permission to
read. To add events to one, add it again (**Settings → Google accounts → Add account**, pick the
same account) and allow both on Google's page.

The same goes for contacts: accounts added before the Contacts window existed
didn't allow it. The Contacts window says so, with an **Allow…** button that
adds the account again; tick the contacts box on Google's page.

## 5. Create the "Desktop app" OAuth client

1. In Google Auth Platform, open **Clients** and click **Create client**.
2. Application type: **Desktop app**. Name: `Calendar desktop`.
3. Click **Create**.
4. A dialog shows the **Client ID** and **Client secret**. Click **Download JSON**
   or copy both values now. Google may not show the secret again. If you lose
   it, open the client and add a new secret.

Why "Desktop app": this client type lets the app receive Google's reply at
`http://127.0.0.1:<any port>` on your own machine. That's called a *loopback
redirect*. You don't register any redirect URLs for it.

About the "secret": a desktop app ships to users' computers, so anything inside
it can be read. Google knows this, and for Desktop clients it doesn't treat the
secret as truly secret. PKCE is what protects the sign-in. Google still requires
the value to be sent, so the app needs it. Keep it out of public repos anyway
(`.env` is git-ignored).

## 6. Publish the app ("In production")

1. In Google Auth Platform, open **Audience**.
2. Under **Publishing status** it says **Testing**. Click **Publish app**, then **Confirm**.
3. The status now says **In production**.

Why this matters:

- **In Testing**, Google expires refresh tokens after **7 days**. You'd have to
  sign in again every week, and only accounts listed as "test users" could sign in.
- **In production**, refresh tokens last until you revoke them, sign out, or
  change your Google password. (Google can also expire a token that goes
  unused for 6 months.)

### If "Publish app" is greyed out

As of October 2026, Google sometimes keeps **Publish app** disabled with "To
publish your app, you must complete your configuration on the Branding page",
even when Branding shows no errors. Many personal-app developers are reporting
this, and Google hasn't explained it yet. The scope list isn't the cause; removing it doesn't help.

Workaround: stay in **Testing** and add yourself as a test user:

1. **Audience → Test users → Add users**, enter your Gmail address, press
   Enter so it becomes a chip, then **Save**. Add every Google account you'll
   use in the app (Settings → Google accounts → Add account); one that isn't listed gets
   `Error 403: access_denied`.
2. Use the app normally. About every 7 days Google ends the sign-in, and the app
   shows "Your Google session ended" (or, for one of several accounts, "Google
   signed this account out"). Sign in again, or add the account again under
   **Settings → Google accounts**.

Try **Publish app** again now and then. Once it works, go to **Settings → Google
accounts → Add account** and pick each account again, to get tokens without the 7-day limit.

Filling in Branding's **App domain** section unlocks it (this project was
published that way on 2026-10-29). The repo's `site/` folder is a small home page
and privacy policy for that, published with GitHub Pages:

1. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub
   Actions**. Then **Actions → Publish website → Run workflow**. The pages are
   at `https://lukejs97.github.io/minuteman/` (the repo's name is the last part).
2. On Branding, under **App domain**: **Application home page**
   `https://lukejs97.github.io/minuteman/`, **Application privacy policy link**
   `https://lukejs97.github.io/minuteman/privacy.html`; leave Terms of service
   empty. Under **Authorized domains**, add `lukejs97.github.io`. **Save**.
3. On **Audience**, click **Publish app**. If it's still greyed out, hover over
   it: its tooltip may say what's still missing. Ignore the "Your app requires
   verification" banner that appears afterwards (see below).
4. Re-add each account in the app (Settings → Google accounts → Add account),
   since sign-ins made in Testing still expire after 7 days. Don't upload an
   app logo on Branding: that would make verification required.

You do **not** need to submit the app for Google's verification. Unverified
production apps work. Google limits them to 100 users in total and shows a
warning screen at sign-in, which is fine for a personal app. If the console
says verification is needed, you can ignore it.

## 7. Give the client ID and secret to the app

1. Copy `src-tauri/.env.example` to `src-tauri/.env`.
2. Paste your values:

   ```
   GOOGLE_CLIENT_ID=1234567890-xxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
   ```

3. Start, or restart, `npm run tauri dev`. The values are built into the app,
   so a running app won't see changes until it rebuilds.

## 8. First sign-in

1. Click **Sign in with Google**. Your browser opens Google's sign-in page.
2. Pick your account. Because the app is unverified, Google shows
   **"Google hasn't verified this app"**. In production, click **Advanced**, then
   **Go to Minuteman (unsafe)** (or whatever app name you set on Branding). In Testing, just click **Continue**. It's your
   own app, so this is expected.
3. Tick the boxes to let the app see your calendars and contacts, and click **Continue**.
4. The browser tab says "You're signed in". Close it. The app shows your agenda.

If you signed in while the app was still in **Testing**, add each account again
after publishing (**Settings → Google accounts → Add account**; picking an account that's already
there renews it). Otherwise the old token still expires after 7 days.

## Troubleshooting

| Message | Meaning / fix |
| --- | --- |
| "The Google OAuth client isn't configured" | `src-tauri/.env` is missing or empty. Fix it, then restart `npm run tauri dev`. |
| `Error 400: redirect_uri_mismatch` in the browser | The client isn't a **Desktop app** type. Create a new client with the Desktop app type. |
| `Error 403: access_denied` / "has not completed the Google verification process" | The app is still in **Testing** and your account isn't a test user. Publish it (step 6). |
| "Google Calendar API has not been used in project … or it is disabled" | Do step 2 in the same project as your client. |
| "People API has not been used in project … or it is disabled" (in Contacts) | Enable the People API (step 2, item 3) in the same project. |
| "Google Drive API has not been used in project … or it is disabled" (attaching a file) | Enable the Drive API (step 2, item 4) in the same project. |
| `drive.file` isn't in the list under Data Access | Enable the Drive API (step 2, item 4) and reload the page, or paste `https://www.googleapis.com/auth/drive.file` under "Manually add scopes". |
| "Your Google session ended" after a week | The token was issued while in Testing. Publish the app, then sign in again. |
| `invalid_client` | The client ID or secret in `.env` has a typo, or the secret was deleted. |
| Leave-by times never appear | No Routes API key, or Routes API isn't enabled. See below. A video link isn't a place, so those events don't get one. |

## Leave-by times (Routes API)

This is separate from the OAuth client above. Minuteman asks Google's Routes
API how long a drive takes, with traffic, from a starting address to the
event's place. The key is not an OAuth token and it is not built into the app.

1. In the same Google Cloud project (or any project on a billing account —
   Routes requires billing, though a personal calendar stays inside the free
   monthly credit for most people), go to **APIs & Services → Library**,
   search for **Routes API**, and enable it.
2. **APIs & Services → Credentials → Create credentials → API key**.
3. Restrict the key (recommended): **Application restrictions** can stay
   **None** for a desktop app, since the key is used from the app itself.
   Under **API restrictions**, choose **Restrict key** and select **Routes API**.
4. Give the key to Minuteman in either of these ways:
   - **Settings → Leave from**, paste it under **Routes API key**, and Save.
     It's stored in the keychain (with your other sign-ins), not in a file
     the window can read.
   - Or set the environment variable `MINUTEMAN_ROUTES_API_KEY` before
     launching the app. That wins over a key saved in Settings.
   - In a development build only, you can also uncomment that line in
     `src-tauri/.env`. It's read when the app runs, not compiled in. A key
     saved in Settings wins over the file.

Then set **Leave from** to the address you usually start from. An event can
name a different one (its **Leave from** field). Events at a real place, in
the next two days, show **Leave by** once a drive comes back. Add a
notification of **before leaving** (0 for the leave-by time itself, or 10 for
ten minutes earlier).

Nothing is shown, and nothing breaks, when the key is missing, the address is
missing, the place is a video call, the event is too far away, or Google
doesn't answer. A failed lookup is tried again after a couple of minutes.
Successful ones are reused, and asked again more often as the event gets
closer.

To check it: set the address and key, make an event an hour from now at a
street address, and confirm the day view says **Leave by** a time. Add
**before leaving** with **0** minutes and leave the app running (the window
can be closed). A notification **Time to leave for …** should appear at that
leave-by time. `cargo test --lib leave::` checks the time math without a key.

### Staying inside the free tier

Traffic-aware routing (`TRAFFIC_AWARE`) is billed as **Routes: Compute Routes
Pro**. As of the [pricing list](https://developers.google.com/maps/billing-and-pricing/pricing)
checked on 2026-10-31, that SKU includes **5,000 free successful requests per
month**. The free cap resets at midnight Pacific time on the first of the
month. Above it, requests are charged (about $10 per 1,000).

Google's own advice for a daily quota that cannot exceed a monthly free cap
is: divide the cap by 31 (the longest month) and round down. 5,000 / 31 is
161.2, so **161 per day** stays at or under 5,000 even if every day hits it
(161 × 31 = 4,991). They also say to set the quota a little lower than the
absolute maximum, because the quota system and the bill don't always count
the same requests.

Minuteman counts **every** Routes attempt, including failures and the second
request it sometimes sends to refine a departure time, and stops before
Google would have billed that many successes. The defaults, in
**Settings → Leave from**, are:

- **80 per day.** 80 × 31 = 2,480, under half of 5,000.
- **2,500 per month.** Half the free cap, so raising the daily limit still
  cannot spend the whole allowance.

Neither can be set to unlimited. The highest the app will keep is **160 a
day** (160 × 31 = 4,960, just under 5,000) and **4,000 a month** (1,000 of
the free requests left unused, for the quota and the bill disagreeing). A
blank or nonsense number is left as it was. Counts are saved on disk and
reset at midnight Pacific time, the same clock as Google's quota. When a
limit is reached, new lookups stop: no leave-by time is fetched, and a
"before leaving" alert fires only if a drive was already saved. The Mac's
Apple Maps fallback is unchanged, and only runs when there is no leave-from
address.

Set a hard cap in Google Cloud as well, so Google refuses the request
instead of billing it. Daily quotas reset at midnight Pacific time.

1. Open [APIs & Services → Routes API → Quotas](https://console.cloud.google.com/apis/api/routes.googleapis.com/quotas)
   (the same page as **Google Maps Platform → Quotas**, with Routes API
   selected).
2. Find the **per day** quota for Compute Routes requests (not the per-minute
   rate limit, which is 3,000). Select it, click **Edit**, and set it to
   **160** or less. **Submit**. A decrease is a quota change; it can take a
   few minutes to apply.
3. When the project reaches that number, Routes requests fail for the rest
   of the day. Minuteman treats a failed lookup like any other miss: it
   shows no new leave-by time.

The Quotas page is not the bill. Check **Billing** if you want to confirm
nothing was charged. Successful requests and server errors count against the
Cloud quota; a rejected API key does not. Minuteman's own counter counts
those too.

The desktop app and the website each keep their own count. Set the Cloud
quota above anyway: it is the one limit that covers both, so the two counts
cannot add up past the free tier.

### Leave-by on the website

The phone site can save a default **Leave from** address (Settings → Leave
from) without a key. Live traffic does not run until the Worker has the
Routes key. The key is a Cloudflare secret. It is not in the git repo, and
the page never receives it.

1. Create the API key as in the steps above, restricted to the Routes API.
2. Set the per-day Cloud quota to **160** (the section above). That cap is
   shared by the desktop app and the website.
3. From the `web` folder, with Wrangler logged in:

   ```
   npx wrangler secret put MINUTEMAN_ROUTES_API_KEY
   ```

   Paste the key when asked. Wrangler stores it on the Worker. A deploy is
   not required for the secret to take effect. To try it on your computer
   first, add the same line to `web/.dev.vars` (that file is git-ignored).
4. Open the site, Settings → Leave from, and save an address. The screen
   should say live traffic is on, and an event at a street address should
   show **Leave by**.

Without the secret, Settings still saves the address and says traffic is
off. The event form says leave-by times stay hidden. Lookups, once the
secret is set, use the same 80-per-day and 2,500-per-month defaults, and
the same ceilings (160 and 4,000). They count every attempt, including
failures, in the Worker's store, and reset at midnight Pacific time.
