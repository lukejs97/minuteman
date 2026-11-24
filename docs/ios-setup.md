# iPhone (iOS) setup — done on the Mac

The code is ready for iOS, but iPhone apps can only be built on a Mac with
Xcode. This guide is for you **and** for Claude Code running on the Mac.

## What's already done (on the Windows PC)

- **App ID** (bundle ID) is `com.lukesassa.calendar` (`src-tauri/tauri.conf.json`).
- **Google iOS sign-in client** "Calendar iOS" exists in the Google Cloud
  project `calendar-app-513002`, for bundle ID `com.lukesassa.calendar`.
  Client ID (not a secret):
  `454006958306-jt3q1gtalsp37n0r1bkkn6nputgu3ab4.apps.googleusercontent.com`
- **Sign-in flow for iOS** (`src-tauri/src/google/auth.rs`): opens Google in
  Safari; Google sends the browser to
  `com.googleusercontent.apps.454006958306-jt3q1gtalsp37n0r1bkkn6nputgu3ab4:/oauth2redirect`;
  iOS opens the app with that link (Tauri's deep-link plugin, configured under
  `plugins → deep-link` in `tauri.conf.json`), and the app finishes signing in.
  iOS clients have no client secret; PKCE protects the sign-in.
- **Phone layout**: safe areas for the notch/home bar, swipe left/right to
  move between days/weeks, larger tap targets, Agenda as the first view.

**Verified on the Mac** (Xcode 27.1, iPhone 18 Pro Simulator, 2026-10-28):

1. The iOS-only Rust code compiles with no changes.
2. `keyring`'s `apple-native` feature uses the iOS Keychain: after signing
   in, quitting and relaunching the app stays signed in.
3. The deep-link plugin writes the URL scheme into
   `src-tauri/gen/apple/calendar_iOS/Info.plist` (`CFBundleURLTypes`) during
   the build, and Google's redirect opens the app and finishes sign-in.

The Xcode project Tauri generated (`src-tauri/gen/apple/`) is committed;
`ios init` only needs re-running after changing the app ID or adding plugins.

**If the URL scheme goes missing from Info.plist** (sign-in opens Google but
"Open in Minuteman" never appears): the deep-link plugin only updates the
plist when its build script runs under the Tauri CLI. A plain
`cargo check --target aarch64-apple-ios-sim` caches a run without the
config. Fix: `cargo clean -p tauri-plugin-deep-link --target aarch64-apple-ios-sim`
(in `src-tauri/`), then `npm run tauri ios dev` again.

## 1. Install the tools (once)

1. **Xcode** from the Mac App Store (large download). Open it once, accept
   the license, and let it install its components. Also install an iOS
   Simulator if it offers (Xcode → Settings → Components).
2. **Homebrew** (a free package manager for macOS), if not installed:
   see <https://brew.sh>.
3. In Terminal:

   ```bash
   brew install node cocoapods gh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
   ```

   (Restart Terminal after installing Rust.) Full list:
   <https://tauri.app/start/prerequisites/#ios>

   Alternative used on this Mac: `brew install rustup`, then
   `rustup default stable` and the `rustup target add` line above. Homebrew's
   rustup isn't on the PATH by default, so add to `~/.zshrc`:
   `export PATH=/opt/homebrew/opt/rustup/bin:$PATH` (and
   `export LANG=en_US.UTF-8`, which CocoaPods wants).
4. Point the command-line tools at Xcode (not the standalone Command Line
   Tools): `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.

## 2. Get the code onto the Mac

The project is in a public GitHub repo, `lukejs97/minuteman` (a personal
account). On this Mac the **work** GitHub account stays the main one, so the
repo uses its own SSH key through a host alias, `github-personal`:

```bash
ssh-keygen -t ed25519 -C "you@example.com" -f ~/.ssh/id_ed25519_personal
printf '\nHost github-personal\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/id_ed25519_personal\n  IdentitiesOnly yes\n' >> ~/.ssh/config
pbcopy < ~/.ssh/id_ed25519_personal.pub
```

Add the copied key to the **lukejs97** account (GitHub → Settings → SSH and
GPG keys → New SSH key), then:

```bash
ssh -T git@github-personal          # should greet lukejs97
git clone git@github-personal:lukejs97/minuteman.git
cd minuteman
git config user.name "Luke Sassa"
git config user.email "you@example.com"
npm install
```

Don't use `gh` for this repo on the Mac (it's logged in to the work account);
plain `git` works through the alias.

## 3. Create `src-tauri/.env`

`.env` is deliberately not in GitHub. For iPhone builds it needs only the iOS
client ID:

```
GOOGLE_IOS_CLIENT_ID=454006958306-jt3q1gtalsp37n0r1bkkn6nputgu3ab4.apps.googleusercontent.com
```

To also run the **Mac desktop** version, copy the whole `.env` from the Windows
PC (it holds the desktop client secret, so move it privately, e.g. AirDrop or
a Bitwarden secure note, not email or GitHub).

## 4. Set up the Xcode project and signing

The Simulator needs no signing; steps 1–3 are only for running on your iPhone.
Step 4 is already done (the generated project is in the repo).

1. Xcode → Settings → Accounts → **+** → sign in with your Apple ID. This
   creates a free "Personal Team".
2. Find your **Team ID** (10 characters) there, or at
   <https://developer.apple.com/account> → Membership.
3. Add it to `src-tauri/tauri.conf.json` under `bundle → iOS`:

   ```json
   "iOS": { "minimumSystemVersion": "16.0", "developmentTeam": "ABCDE12345" }
   ```

4. Generate the Xcode project:

   ```bash
   npm run tauri ios init
   ```

## 5. Run it

- **Simulator** (free, no limits):

  ```bash
  npm run tauri ios dev
  ```

  Pick an iPhone simulator when asked.
- **Your iPhone**: plug it in, then on the phone turn on
  Settings → Privacy & Security → **Developer Mode** (it restarts). Run
  `npm run tauri ios dev` and pick the phone. The first time, trust the
  developer on the phone: Settings → General → VPN & Device Management.
  In dev mode the phone loads the UI from the Mac, so keep both on the same
  Wi-Fi. For a standalone install, build with `npm run tauri ios build`
  (see `npm run tauri ios build -- --help` for signing/export options).

With a free Apple ID, apps installed on a real iPhone **stop opening after
7 days**; rebuild/reinstall from the Mac to renew. Apple's paid developer
program ($99/year) removes that limit.

## 6. Test sign-in

1. Tap **Sign in with Google**. Safari opens Google's page.
2. Pick your Google account (a test user of the Google project), tap
   **Continue** on the "hasn't verified this app" screen, allow calendar access.
3. Safari asks to open "Minuteman"; tap **Open**. The agenda should load.

Then connect Todoist (top bar → Todoist) by pasting the API token.

## Prompt for Claude Code on the Mac

> Read docs/ios-setup.md. The iOS code was written on Windows and has never
> been built. Help me through steps 1–6: install what's missing, run
> `npm run tauri ios init`, fix any iOS build errors (especially the
> `#[cfg(mobile)]` code in src-tauri/src/google/auth.rs and lib.rs, keyring on
> iOS, and the deep-link URL scheme in Info.plist), and get it running in the
> Simulator, then on my iPhone. Don't change the desktop behavior.
