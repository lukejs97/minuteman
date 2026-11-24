# Minuteman on the web

The website version of Minuteman: the same screens as the desktop app, served
by one free **Cloudflare Worker** (a small server running on Cloudflare's
network), which also does what the desktop app's Rust side does.

```
browser ──► Worker (web/src) ──► Google Calendar, Todoist
  │           │
  │           └─ KV store: Google refresh tokens + Todoist token, encrypted
  └─ only an HttpOnly session cookie (page scripts can't read it)
```

- `src/index.ts`: routes, sign-in pages, sessions, security headers
- `src/commands.ts`: `/api/<command>`, same names and arguments as the desktop
  app's Rust commands (`src-tauri/src/lib.rs`)
- `src/google.ts`, `src/todoist.ts`, `src/agenda.ts`: ports of the Rust
  engine (`google/*.rs`, `todoist.rs`, `agenda.rs`, `search.rs`). Keep them in
  step when the desktop behavior changes.
- `src/zone.ts`: the server runs in UTC, so the browser sends its time zone
  (`X-Time-Zone`) and "today"/midnight are worked out in it.
- `src/users.ts`: who's who (the owner, people they invited), and each
  person's own part of the store; `src/shares.ts`: everyone's Routes and
  TomTom attempts kept inside the free tiers.
- `../src/web-bridge.ts`: in the browser, sends the app's commands here.

**Not on the web:** the menu bar window, the quick-add shortcut, and offline
mode. Signing out of one browser (Settings → This
browser → Sign out) doesn't affect other devices; removing an account under
Settings → Google accounts removes it everywhere.

**Free-plan limits:** Cloudflare's free plan allows 100,000 requests a day
and 50 outside requests per request. Each Google calendar is one outside
request, so a page needs roughly (calendars + 3) of them. If a view ever fails
with a limit error, the $5/month Workers plan raises it.

## Google sign-in client (once)

Google Cloud Console → project `calendar-app-513002` → Google Auth Platform →
Clients → **Create client** → **Web application**, named "Minuteman web".
Authorized redirect URIs:

- `http://localhost:8787/auth/google/callback` (testing on your PC)
- `https://minuteman.<your-subdomain>.workers.dev/auth/google/callback` (the live site)

Copy the client ID and secret.

## Run it on your PC

1. `cd web && npm install`
2. Put the client ID and secret in `web/.dev.vars` (git-ignored):

   ```
   GOOGLE_CLIENT_ID=…
   GOOGLE_CLIENT_SECRET=…
   TOKEN_KEY=…   # 32 random bytes, base64
   MINUTEMAN_ROUTES_API_KEY=…   # optional; leave-by traffic. Never commit this file.
   ```

   Make a TOKEN_KEY with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
3. `npm run dev`, then open <http://localhost:8787>.

## Put it online (once)

1. `npx wrangler login` signs in to your (free) Cloudflare account.
2. `npx wrangler kv namespace create STORE`, then put the id it prints in
   `wrangler.jsonc` (`kv_namespaces`).
3. Set the secrets; each command asks for the value:

   ```
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put TOKEN_KEY
   npx wrangler secret put ALLOWED_EMAILS
   npx wrangler secret put MINUTEMAN_ROUTES_API_KEY
   ```

   The Routes key is optional. Without it, Settings → Leave from still saves
   a default address, and leave-by times stay hidden. With it, the Worker
   asks Google for traffic and counts every attempt against the same free-tier
   cap as the desktop app (80 a day and 2,500 a month unless you lower them).
   Also set a per-day quota of 160 on the Routes API in Google Cloud so the
   desktop app and the website together cannot be billed
   ([docs/google-cloud-setup.md](../docs/google-cloud-setup.md)). The key is
   never sent to the browser.

   Use a **new** TOKEN_KEY for the live site, not the one in `.dev.vars`.
4. `npm run deploy`. It prints the site's address,
   `https://minuteman.<your-subdomain>.workers.dev`. Add that address's
   `/auth/google/callback` to the Google client's redirect URIs (above).

To update the site later: `npm run deploy` again, or let GitHub do it
(no computer needed): add a `CLOUDFLARE_API_TOKEN` repository secret, made
in Cloudflare → My Profile → API Tokens → Create Token → **Edit Cloudflare
Workers**, then Actions → **Deploy web app** → **Run workflow**
(`.github/workflows/deploy-web.yml`). It deploys the branch you pick.

The Google accounts in `ALLOWED_EMAILS` (comma-separated) sign in as the
site's **owner**. It's a secret, so your address isn't in the (public) code:
`npx wrangler secret put ALLOWED_EMAILS`, or Cloudflare → Workers & Pages →
minuteman → Settings → Variables and Secrets → Add → type **Secret**. (Once
you've signed in, your accounts are known to the site, so it keeps working
while it's being set.) Once signed in, you can add other Google accounts of yours
under Settings → Google accounts.

## Other people

The owner can invite others under Settings → **People**: type their Google
account's email, then send them the site's address. They sign in there with
that account and get a Minuteman of their own: their Google accounts,
calendars, contacts, Todoist, settings, history with people and alerts, kept
apart from everyone else's. No one sees anyone else's. Someone invited can add
more Google accounts of their own (not one already used by someone here), and
can delete everything of theirs (Settings → Your data on this site). The owner
can remove them (People → Remove), which does the same. Either way their
Google accounts' access is given back to Google; nothing in them is deleted.

How it's kept (`src/users.ts`): the owner's things are where they always were
(keys with no prefix), so nothing moved when other people came; each other
person's keys start `u:<id>:`; the site's own (`site:users`, `site:invites`,
which person a Google account belongs to, the totals below) start `site:`.
Every request and alert run sees only its person's part.

**Caps:** each person invited gets up to 20 leave-by lookups and 20 place
searches a day (300 a month), whatever their own Settings say, and everyone's
together count against the owner's caps (Settings → Leave-by; TomTom's 100 a
day), so the site as a whole stays inside the free tiers however many people
there are (`src/shares.ts`).

**Alerts:** every minute the Worker runs each person's alerts as a request to
itself (the `SELF` binding in `wrangler.jsonc`), so each has its own limits.

**Free-plan limits with more people:** the free plan allows about 1,000
writes to the store a day. Alerts write about 50 a day for each person who
has them on, and leave-by lookups a few more, so past roughly 10–15 people
with alerts on, the $5/month Workers plan is the next step. Google lets an
unverified app have 100 users ("Google hasn't verified this app" on sign-in);
more than that, or no warning, needs Google's verification of the Calendar and
Contacts permissions (docs/google-cloud-setup.md).

## A test copy

To try a change before it goes live: Actions → **Deploy test site** → Run
workflow → pick the branch (Actions → **Delete test site** removes it
again) (`.github/workflows/deploy-web-test.yml`). It puts
it on `https://minuteman-test.<your-subdomain>.workers.dev`: its own Worker
and its own empty store (`wrangler.test.jsonc`), so the live site and its
data aren't touched. The first run makes the store and the test site's own
TOKEN_KEY. Once, by hand:

1. Cloudflare → Workers & Pages → **minuteman-test** → Settings → Variables
   and Secrets → add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Secret),
   the same values as the live site's (Google Cloud → Clients → Minuteman
   web). Add `MINUTEMAN_ROUTES_API_KEY` and `MINUTEMAN_TOMTOM_API_KEY` too
   to try leave-by times and place search there.
2. Google Cloud → Clients → Minuteman web → add the redirect URI
   `https://minuteman-test.<your-subdomain>.workers.dev/auth/google/callback`.
