/** What the Worker gets from wrangler.jsonc and its secrets. */
export interface Env {
  /** The website's files (../dist). */
  ASSETS: Fetcher;
  /** Encrypted tokens and sessions. */
  STORE: KVNamespace;
  /** Google "Web application" OAuth client (secrets). */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** 32 random bytes, base64: encrypts the stored tokens (secret). */
  TOKEN_KEY: string;
  /** The site owner's Google accounts, comma-separated: they may sign in, and invite others (users.ts). */
  ALLOWED_EMAILS: string;
  /** The whole store, whoever's request this is (set by users.ts `forUser`; STORE is then theirs alone). */
  SITE?: KVNamespace;
  /** Whose request this is: "owner" or a person's id (users.ts). */
  USER?: string;
  /** This Worker, to run each person's alerts as a request of its own (wrangler.jsonc, index.ts). */
  SELF?: Fetcher;
  /**
   * Routes API key for leave-by times. A Worker secret, never sent to the
   * browser. Absent until `wrangler secret put MINUTEMAN_ROUTES_API_KEY`.
   */
  MINUTEMAN_ROUTES_API_KEY?: string;
  /**
   * TomTom key for place search when OpenStreetMap doesn't know a place
   * (places.ts). A Cloudflare secret; never sent to the browser. Absent
   * until `wrangler secret put MINUTEMAN_TOMTOM_API_KEY`.
   */
  MINUTEMAN_TOMTOM_API_KEY?: string;
}

/** Per-request details every command needs. */
export interface Context {
  env: Env;
  /** The viewer's IANA time zone (from the browser), for "today" and midnights. */
  zone: string;
}
