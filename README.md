# application tracker

A private, local application tracker for your full-time software engineering search. Capture applications from a text file or the UI, save job descriptions, and connect your own Gmail account to collect hiring updates.

## macOS desktop app

Build on a Mac with Node.js 22.13+, npm, and Xcode Command Line Tools (`xcode-select --install`). Node's `include/node` headers are needed for the small native notification-permission bridge; standard Node installations include them. If yours does not, set `FIELDWORK_NODE_HEADERS` to that directory. The resulting app bundles its runtime and native bridge; recipients do not need Node or developer tools.

```sh
npm ci
npm run desktop:make
```

Find `application tracker.app` in `out/application tracker-darwin-arm64/` on Apple Silicon (`x64` on Intel). A drag-to-Applications installer is created at `out/make/application-tracker-<version>-arm64.dmg`, alongside a ZIP in `out/make/`. Open the DMG and drag the app into Applications, or copy the `.app` there. Launch it from Finder, Spotlight, or the Dock. No terminal or `npm run dev` is needed afterward.

The build targets the architecture of the Mac doing the build. Build/test the Intel version on an Intel Mac before sharing it with Intel users. This is not a universal binary.

**Settings → Desktop app → Keep running in the menu bar** is optional and off by default. Enable it to keep file scanning and scheduled Gmail polling running after closing the window. The menu-bar icon or Dock reopens the window. **Quit / ⌘Q always stops the app**, regardless of this setting. With the option off, closing the window quits. It does not automatically launch at login or prevent sleep; scheduled work resumes after waking while the app is running.

The desktop has a native text-file picker and opens Gmail authorization in your default browser, not an embedded Google login. Each person still configures their own Gmail client and AI key. Exports show a native Save dialog.

### Desktop data and existing web records

- Installed app: `~/Library/Application Support/Fieldwork/tracker.sqlite` (the folder keeps the app's original name).
- Development app: `~/Library/Application Support/Fieldwork Dev/tracker.sqlite` (separate, intentional).
- Browser/CLI mode: the existing `.data/tracker.sqlite`, unchanged.

The desktop stores credentials in `secrets.enc` with an AES key wrapped by macOS Keychain in `vault-key.enc`; it does **not** write a plaintext `secrets.key`. Application records themselves are not encrypted. Protect your macOS account and disk. Settings includes **Open data folder**. Do not share these folders. Unsigned/ad-hoc builds can trigger Keychain permission prompts when replaced; consistent Developer ID signing is recommended for distribution. If Keychain access fails, the app stops with an error instead of falling back to plaintext.

To move existing web records: download a full JSON backup in the browser version's Settings, then restore it into the empty desktop app using Settings. Reconfigure the watched-file path, Gmail, and AI separately. No records are automatically moved or overwritten. Do not copy `.data` into the desktop folder; its credential protection is different.

### What happens when source code changes?

An installed `.app` is a **snapshot**, not a live view of this repository. Run `npm run desktop:make` again, quit the installed app, and replace it with the new build. Its Application Support data folder remains in place. Back up before updates, particularly if a future version changes the database schema. There is no automatic updater or release service configured.

For development:

```sh
npm run desktop:dev       # Rebuild/restart on src, server, shared, and desktop edits
npm run desktop:start     # Build and run production assets in a development app
npm run desktop:package   # Build a .app only (no DMG/ZIP)
npm run test:desktop      # Real Electron lifecycle and persistence tests
npm run test:packaged     # Same lifecycle test against the built .app, isolated data
```

`desktop:dev` restarts the window after source edits; saved records persist, but unsaved form edits do not. Restart the command after changing dependencies, build scripts, package metadata, or Vite configuration. Stop the watcher with Ctrl+C. Development does not load `.env` automatically; use the in-app settings. `TRACKER_DESKTOP_DATA_DIR` can isolate an unpackaged test/development instance; packaged apps ignore that override.

For an isolated recovery/test profile, the desktop executable also accepts `--fieldwork-data-dir=/absolute/path/to/a/new/private-folder`. This works in packaged builds and is used by the packaged smoke test; ordinary launches always use Application Support. The build uses Electron Packager plus the macOS `ditto`, `hdiutil`, and `iconutil` tools.

### Sharing with friends

Local packages are ad-hoc code-signed by the packaging recipe so macOS can identify the bundle for notifications; they are not Developer ID signed or notarized. macOS may block or warn about downloaded copies; it is not a frictionless distribution build. Ad-hoc identity/permission behavior can change when a build is replaced. For stable identity and normal distribution, configure your own Apple Developer ID identity and notarization API credentials through environment variables:

- `APPLE_SIGN_IDENTITY`: your Developer ID Application signing identity.
- `APPLE_API_KEY`: absolute path to your private App Store Connect API key, kept **outside this repository**.
- `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`: the key's identifiers.

Then run `npm run desktop:make`. Never put signing keys into source or share your user-data folder. Automatic updates would be a separate feature requiring release hosting, signing, and an update feed. See [Electron's macOS signing guide](https://www.electronforge.io/guides/code-signing/code-signing-macos).

## Run locally

Requires Node.js **22.13 or newer** and npm. SQLite is built into Node; no database server or Docker is needed.

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:3210**. For development, use `npm run dev` (refresh the browser after frontend changes).

The app starts empty. You can add applications and paste descriptions without connecting anything. There is no shared service, hard-coded email identity, or bundled API key. Each person runs their own copy.

## First-time setup

1. Open **Settings**.
2. Create a text file in a location you control and enter its **absolute path**. Save settings.
3. Optionally configure Google OAuth and connect Gmail using the instructions below.
4. Optionally enable AI extraction with your own API key. Review the destination and data-sharing explanation first.

### Text-file capture

```text
# A bare link means applied today
https://example.com/careers/software-engineer

# Supply the date when importing older applications
2026-09-20 | https://example.com/jobs/123
```

The app polls the saved path every two seconds while its process is running, after writes have settled. It leaves your file unchanged. Duplicate lines, file reordering, and rescans do not duplicate applications; removing a line does not delete its record.

A bare link uses the local date it is **first imported**, labeled “file default.” The app cannot know when you added a link while it was stopped. Correct that date in the role details or supply an explicit date in the file. An explicit **new application to a previously tracked posting** checkbox supports reapplications from the Add dialog.

### Connect Gmail

Each user supplies their own Google project/client configuration:

1. Create/select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Gmail API** for that project.
3. Configure the OAuth consent screen for personal testing; add your Gmail address as a test user. Configure `https://www.googleapis.com/auth/gmail.readonly`.
4. Create an OAuth client of type **Desktop app**. Copy its client ID and client secret into the app's settings, then save.
5. Click **connect gmail** and authorize in your normal browser. The app uses PKCE and a one-time state value with a loopback callback at `http://127.0.0.1:3210/oauth/callback` (or your configured port). The desktop app automatically chooses an available loopback port, supported by Desktop OAuth clients.

Read-only authorization permits reading the mailbox; the app’s Gmail search selects candidate hiring messages. It never marks messages read, sends mail, or modifies Gmail. [Google’s scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes)

Testing-mode Google OAuth projects generally receive Gmail refresh tokens that expire after **seven days**. The app will ask you to reconnect when authorization expires. Workspace administrators may also restrict access. Private local use does not itself determine which Google verification requirements apply. [Google’s OAuth guide](https://developers.google.com/identity/protocols/oauth2), [Desktop authorization](https://developers.google.com/identity/protocols/oauth2/native-app)

The initial window defaults to 90 days. Subsequent polling overlaps the last successful scan by one day; failed fetches preserve the previous checkpoint. Use **Rescan saved date range** after widening the date range/query or importing old messages into Gmail. This is local polling, not an always-running cloud subscription. Archived mail is included; spam and trash are excluded.

### AI extraction

The default adapter uses OpenAI-compatible `/chat/completions` JSON mode. The initial model is `gpt-4.1-mini`; the model and public HTTPS API base URL are configurable. Compatibility requires that the chosen provider support JSON mode and the configured model. Supply your personal API key, check **Enable hosted AI extraction**, then save.

Relevant email subjects, received dates, excerpts (up to 18,000 characters), and job descriptions (up to 45,000 characters per extraction) may be sent to that provider. Unrelated emails, Gmail credentials, and attachments are not sent as extraction inputs. Your provider bills you directly and applies its own data handling terms. Verify that your chosen service and configuration meet the applicable Gmail-data use requirements before enabling it.

Without AI, the app still captures applications, reads accessible job-page structured metadata, and recognizes explicit hiring phrases. Unsupported details remain blank. A failed AI request preserves the captured record and description; use manual editing or retry. Results are cached by source text, endpoint, model, and extraction version to avoid repeated paid work. Requests are capped at 3,000 output tokens and paid extraction is not automatically retried.

The adapter validates output against an application schema. [OpenAI JSON mode documentation](https://developers.openai.com/api/docs/guides/structured-outputs)

## Everyday use

**Mac notification permission:** in Discover, **save filters** (with notifications checked) or **test notification** requests macOS alert/sound/badge permission if it has not been decided. The app stores the observed permission status and request/check timestamps in the local SQLite settings; it re-reads the OS state rather than treating a cached approval as permanent. Saving with notifications disabled does not prompt. If access was denied, use **open notification settings**; macOS will not show the original consent dialog repeatedly. Returning to the app refreshes the status. Allowed permission does not override Focus mode or disabled banners/sounds. The development Electron app and installed app have different bundle identities and permissions. Older unsigned packages need a newly signed build before the native notification APIs can work reliably. See [Electron's notification requirements](https://www.electronjs.org/docs/latest/api/notification).

- **My applications:** searchable, filterable table; summary counts; 14-day activity chart; current-stage distribution. `/` focuses search and `n` opens Add.
- **find jobs:** monitor Simplify’s SWE new-grad list and public Greenhouse/Lever/Ashby boards, filter by location/experience/salary/keywords, and receive native Mac alerts for newly detected matches. Start monitoring explicitly; the first check establishes a quiet baseline. Opening a role does not mark it applied—use **I applied** after submitting.
- **Role details:** edit dates, status, compensation, work arrangement, responsibilities, technologies, and notes. Manual edits take priority over extraction.
- **Timeline:** inspect events and their email evidence. A delayed confirmation does not move an interviewing application back to Applied.
- **Saved description:** inspect older snapshots, paste a description, or refresh a public posting. Blocked, login-required, or expired pages have a paste fallback.
- **emails to sort:** inspect extracted email events, match them to a role, create a new application, dismiss unrelated mail, or retry a failed extraction. Company-name matches alone never automatically select a role.
- **to do:** pending assessments and interviews, including missing-date/time-zone indicators. Edit timing, complete, or dismiss actions here.

Conservative automation: explicit rule-based events can attach automatically to an exact job identity or uniquely associated thread. AI results require review by default. Settings includes an opt-in for strong AI matches, but confidence values are **heuristic scores, not calibrated probabilities**. Multi-role and conflicting terminal-status changes go to review. New email-only roles are created through review so speculative classifications do not silently grow your application list.

Accepted, rejected, withdrawn, and closed records are not automatically reopened. Attaching an event to one preserves its status; edit the role status explicitly to reopen it. “No response” is never automatically treated as rejection. Unknown application dates stay unknown until you supply one or an application confirmation provides a labeled estimate.

Interview/offer reach uses event history, including applications later rejected. Response rate excludes automatic receipts; the numerator is applications with a later employer event and the denominator is the dated application cohort. Date filters change that cohort. Other summary cards cover the whole search. Estimated/defaulted dates are included and labeled; unknown dates are excluded.

## Storage, backup, and sharing

For **always-on Telegram phone alerts while your Mac is off**, deploy the separate discovery-only worker. See [CLOUD-WORKER.md](CLOUD-WORKER.md) for bot setup, cloud/container deployment, configuration export, and limitations. Telegram messaging is free within its normal limits; cloud hosting may cost money. This worker does not have Gmail access or synchronize local application history.

In browser/CLI mode, default data lives in `.data/` in the working directory (desktop paths are listed above):

- `tracker.sqlite` plus SQLite WAL files: applications, evidence, settings, import markers, and extraction cache.
- `secrets.enc`: encrypted OAuth configuration, tokens, and AI key.
- `secrets.key`: local encryption key, protected with owner-only permissions.

The portable credential fallback is AES-256-GCM with private directory/file permissions. **It is not OS Keychain storage**: the key and encrypted credentials are on the same disk, so it does not protect against someone with access to your OS account or a complete disk copy. Use your OS account protections and disk encryption. On platforms without POSIX permission semantics, protect the data directory with the operating system’s access controls.

**Settings → Download full backup** exports the application data and evidence as JSON, excluding settings, discovery caches/boards, cached AI responses, keys, and tokens. Export discovery preferences separately from Discover. Treat backups as private because they contain hiring correspondence. CSV exports only application fields and neutralizes spreadsheet formula prefixes.

Restore a JSON backup through Settings in an **empty instance**, for example one started with a fresh `TRACKER_DATA_DIR`. Reconfigure accounts separately. Do not copy a live SQLite file alone while WAL writes are active; use the in-app backup or stop the process before copying the entire data directory privately.

Merge duplicates from a role’s details. The destination’s current status wins and both histories are retained. Undo is available only before further record changes; the pre-merge backup remains downloadable. Deletion clears local role evidence and remembers ignored Gmail/file source IDs, so ordinary sync does not recreate that role. A previously downloaded backup is the recovery path for deleted records.

Share the source code and lockfile with friends. **Do not share `.data/`, `.env`, credentials, or your applications text file.** These paths are ignored by Git.

## Configuration

Optional environment variables (or copy `.env.example` to a private `.env`):

| Variable               | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `PORT`                 | Local port, default `3210`                                       |
| `TRACKER_DATA_DIR`     | Absolute or working-directory-relative data directory            |
| `TRACKER_LINKS_FILE`   | Initial watched-file path for a new instance                     |
| `GOOGLE_CLIENT_ID`     | Overrides saved OAuth client ID                                  |
| `GOOGLE_CLIENT_SECRET` | Overrides saved OAuth client secret                              |
| `OPENAI_API_KEY`       | Overrides saved AI key; does not enable AI consent automatically |

Example: `TRACKER_DATA_DIR=/absolute/path/to/private-fieldwork npm start`. The server binds only to `127.0.0.1`. Keep it on loopback; this project is not a hosted multi-user service. Local API changes require a per-process request token, expected host, and same-origin browser context. Job-page requests reject private/reserved destinations, validate each redirect, and pin validated DNS addresses. Production serves a restrictive Content Security Policy; Vite development permits inline scripts/styles required by its development tooling.

## Development and verification

```sh
npm test                  # Domain, ingestion, storage, OAuth, API and security tests
npm run build             # TypeScript check + production frontend build
npx playwright install chromium
npm run test:e2e          # Build + real-browser workflows on an isolated temporary instance
npm run test:desktop      # Electron lifecycle, Keychain-backed persistence, and source watching
npm run test:packaged     # Verify an already-built .app using an isolated temporary profile
npm run verify            # Unit/integration tests + build
npm audit
```

The browser suite uses port `3221` and temporary fixture data; API tests use `3219`. Desktop tests use ephemeral loopback ports and temporary profiles, never your real records. They exercise actual macOS Keychain encryption with dummy credentials; OS file dialogs are stubbed to use the test directory. Tests never connect to a real mailbox or call a paid AI service. Screenshots/traces are written to ignored `test-results/`.

Implementation: React + TypeScript + Vite frontend; Express local server; built-in Node SQLite; Google OAuth library; local background file scanning and Gmail polling. `shared/model.ts` defines the data contracts. `server/tracker.ts` owns ingestion and lifecycle decisions. See [PRD.md](PRD.md) for the product requirements.

Live Google consent/refresh and paid AI extraction require your configuration and have not been validated against your personal accounts. The test suite verifies their surrounding contracts with fixtures. Extraction precision/recall targets and the two-week personal-use target in the PRD require real labeled examples and a user trial; they are not claimed as achieved. JavaScript-only or protected job sites may require pasted descriptions. OS packaging outside the development machine has not been certified.
