# YouTube Watch Tracker

A Manifest V3 Chrome extension that records how long you watch YouTube videos, **on this device**, with an optional, opt-in private sync to a server you run, so you can see all your own devices' history in one dashboard.

## Ground rules (please read)

- **Tracking is visible.** The toolbar shows a `REC` badge while a video is being recorded, the popup shows tracking state, and once sync is enabled the popup and Settings permanently say *"Syncing YouTube watch data to <server>."*
- **YouTube only.** The content script runs on `youtube.com`; nothing else is observed.
- **No covert collection.** Sync is off by default. It starts only when someone at the browser enters a server address and a one-time pairing code and grants the permission prompt. The person at the device can see the connection in the popup at any time, and cannot end it on their own: they can only ask the admin to delete the session. Lawful, informed use is still the operator's responsibility (below).
- **Lawful, consensual use only.** The operator is responsible for using this lawfully and with the knowledge and agreement of every person whose browsing is recorded (for example, a parent with a child's informed awareness, or your own devices). It is not designed or supported for monitoring people who don't know about it.

## What it records

Per watched video: video id, title, channel (and its link), start/end time, seconds actually playing (ads excluded), and duration. Since 0.7.0, also an **event history** of each viewing (every pause, resume, seek, buffering interval, completion, tab switch and viewing end, with exact timestamps and positions), unless *Collect watch detail* is off. Nothing about other sites, page contents, comments, or account details. See [`docs/VIDEO_DETAILS.md`](docs/VIDEO_DETAILS.md).

## Install

**Build a package and install it manually** (Chrome 116+): `node tools/build-extension.mjs`, unzip `dist/yt-watch-tracker-v<version>.zip` into a permanent folder, then `chrome://extensions` → Developer mode → **Load unpacked**. Step-by-step: [`docs/INSTALL.md`](docs/INSTALL.md); updating and a stable ID: [`docs/EXTENSION.md`](docs/EXTENSION.md); dashboard: [`docs/ADMIN_DASHBOARD.md`](docs/ADMIN_DASHBOARD.md); problems: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

### From source (development)

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
2. Open a YouTube video; the toolbar badge shows `REC` while it plays.
3. Popup → **Dashboard** (history, charts, and *Your data*: export or delete), **Settings** (read-only status) or **Device info** (read-only).

### Permissions

| Permission | Why |
|---|---|
| `storage` | Settings and local state (`chrome.storage.local`); history lives in IndexedDB. |
| `alarms` | A 5-minute timer for sync and a 1-minute check that restores the live connection. Does nothing unless paired. |
| host `https://www.youtube.com/*` | Run the tracker on YouTube. |
| optional hosts (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`) | **Not granted at install.** The browser asks for the one server origin you pair with, and it is removed again on unpair. The localhost entries are for development. |

## Local features

- **Popup:** pair with a code, see the connection, **pause or resume tracking** with the *Track watch time* switch (always yours to use), and ask the admin to delete your session.
- **Settings** (`settings/`): read-only status: tracking, server connection, synchronization and last sync, current configuration (each value marked *Local* or *Managed by administrator*), device and version. It has no controls.
- **Device information** (`admin/`): read-only: installation ID, extension version, browser and OS, connection, tracking, pairing and deletion-request status, last activity and sync, storage used, and a diagnostics log you can copy. It replaced the old Admin console.
- **Dashboard → Your data** (`dashboard/`): review your history, export it (all, date range, channel) and delete it (date range, channel, all, each with a second confirmation). This is the user's own control over the data stored on this device.
- These pages are display only. They cannot stop you from pausing tracking, deleting your data, clearing the extension's storage or removing the extension at `chrome://extensions`, and neither can the administrator. The old local admin-password lock was removed with the editing controls it protected.

## Private sync (optional)

For use across **your own** devices, with one owner and one server you run. Full setup: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md); backups and recovery: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

```
Laptop 1 (extension) ─┐
                      ├── HTTPS ── private API ── SQLite ── owner dashboard
Laptop 2 (extension) ─┘
```

- **Pairing:** the admin generates a one-time code (`XXXX-XXXX`, 15 minutes, single use, stored hashed) in the dashboard's **Devices** page; the browser enters the server address and code in the popup. By default the device is connected at once and the popup says *Connected Successfully*. If the admin ticks *Require my approval*, the device instead waits as **pending** (it cannot upload or read anything) until the admin checks the confirmation code and approves it. Wrong codes lock the sender's address out for 15 minutes after 5 attempts. Every pairing is a **session** that can be listed and revoked on its own.
- **Credentials:** the device keeps one random long-lived credential, sent only to `/api/device/token`, which returns a 15-minute access token used for everything else. Device status is checked on every request, so **revoking takes effect immediately**, even for an unexpired access token. There are no shared passwords or secrets in the extension.
- **Reliable upload:** every session snapshot is queued in IndexedDB in the same transaction that stores it (event id `sessionId:revision`), uploaded in batches, and removed from the queue only when the server acknowledges that exact revision. Offline periods, dropped connections, expired tokens and browser restarts do not lose events; resending never duplicates (the server keeps the highest revision per session). Pending uploads and the last successful sync are shown in the popup, the Admin console and the dashboard.
- **Clocks:** devices report their time on each upload; the server measures the offset and places every record on its own timeline, and conflict resolution uses revision counters, not clocks.
- **What leaves the device:** the session records above (video id, URL, title, channel, start/end, seconds watched, progress, seeks/pauses) and, since 0.7.0, the playback events of each viewing (type, time, position, speed; no title, channel or URL). They are encrypted at rest on the server. History recorded before pairing is not uploaded unless the box is ticked.
- **What the owner can do remotely:** from the dashboard's device page, **Configuration**: set *Keep history for* and *Sync every* (server-validated, saved, audited, pushed live, applied and confirmed by the extension, with status and history). Also the older commands: pause or resume tracking, delete local history. Everything the owner changes is shown on the device (Settings marks managed values; the popup shows a banner after a remote pause, resume or delete). **Known conflict:** `resume_tracking` lets the admin turn tracking back on after the user paused it; see [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).
- **Revoke / delete session:** the admin can revoke a session, revoke a device, or remove it from the dashboard; the device is cut off on its very next request (immediately if its live connection is open), clears its credential and queue, and says so. The person at the device cannot delete their session: the popup's **Delete session** sends a **request**, the popup shows *Waiting for Admin Approval*, and the session keeps working until the admin approves (the device is then disconnected) or denies (it stays connected). Data already uploaded stays on the server until the owner deletes it.
- **Video Details (0.7.0):** the dashboard's **Videos** page opens a per-video page with live status (`LIVE WATCHING`, `PAUSED — hh:mm:ss`, `COMPLETED`, `DEVICE OFFLINE`), a timeline of every event, a table of every pause and resume, viewing history, five charts and CSV/JSON/PDF-report export, updating without a refresh. How events are captured, the exact duration rules, unresolved intervals and the API are in [`docs/VIDEO_DETAILS.md`](docs/VIDEO_DETAILS.md); the browser test list is [`docs/MANUAL_TEST_CHECKLIST_VIDEO_DETAILS.md`](docs/MANUAL_TEST_CHECKLIST_VIDEO_DETAILS.md).
- **Real time:** the dashboard receives live updates (Server-Sent Events) for device connected/disconnected, pairing, deletion requests and decisions, and revocations; connected extensions hold a WebSocket so they show as *Online* and receive commands and decisions at once. Both fall back to polling.

## Server

See [`server/README-server.md`](server/README-server.md) to run it, [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) to deploy it, and [`SECURITY.md`](SECURITY.md) for the security checklist (what the code enforces and what the operator must do). A backend greatly enlarges the privacy surface: do not run it on a server you don't control and secure.

## Demo and write-up

**Marking / submission:** start at [`SUBMISSION.md`](SUBMISSION.md) for the reading order, how to run everything, and what is and isn't covered.

- [`docs/DEMO.md`](docs/DEMO.md): a ten-minute local demo where you enroll your own browser against a throwaway loopback server (`cd server && node scripts/demo.js`).
- [`docs/WRITEUP.md`](docs/WRITEUP.md): an academic-style report on the design, threat model, implementation and evaluation.
- [`docs/DUAL_CONTROL.md`](docs/DUAL_CONTROL.md): a design study (not implemented) of making the monitored person a required cryptographic party to enrolment, with its limits.
- [`docs/VIVA.md`](docs/VIVA.md): a 10–12 minute presentation script with a live demo against synthetic devices (`server/scripts/sim-device.js`) and prepared Q&A.
- [`docs/ANALYSIS.md`](docs/ANALYSIS.md): the analytical companion: why consent can't be enforced inside this kind of software, and which controls partly help.
- This is an educational project: use it on your own devices, or with the informed agreement of everyone it records. No warranty.

## Tests

```
node tests/session-logic.test.js     # tracking core: accounting, stats, util
node tests/sync-queue.test.js        # outbox batching, auth classification, pairing state
cd server && npm install && npm test # server + end-to-end: two simulated devices running the real extension code
```

## Limitations

- Remote commands are polled, so they apply on the device's next sync (up to ~5 minutes), not instantly.
- **Not yet verified by hand:** the new Devices page, the new popup, loading the built ZIP, the permission prompt during popup pairing, and the HTTPS/proxy path (including WebSocket and event-stream pass-through) were not run in a browser. The API, the real-time channels, the sync client and the build are covered by automated tests (extension and server tests, run one file at a time). See [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).
- Player events cannot prove a human was watching; "active" means the player was in a playing, non-ad state.
- The extension remains removable from `chrome://extensions`. Forced installation needs enterprise policy (`ExtensionInstallForcelist`) and is out of scope here.
- The person at the device can re-enable tracking after a remote pause. They cannot end their own session (they can request it), but they can still remove the extension at `chrome://extensions`; the server then shows the device as offline until you revoke it.
- Local deletions (retention, remote delete) don't remove the copy already on the server, except via the server's retention mirror or *Delete device and synced data*.
- **Unpair:** the old Admin console's Unpair button (which called a removed function) is gone with that page. The person at the device ends a session by *asking* (popup → Delete session) and the admin approves; history of this is in [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md). Developer-mode install only: no Chrome Web Store package, and no stable extension ID until you add a key ([`docs/EXTENSION.md`](docs/EXTENSION.md)).

## Layout

```
manifest.json  background.js  content/tracker.js
lib/      util accounting db stats charts lock diag sync realtime build-config  theme.css theme-init.js
popup/ dashboard/ settings/ admin/ icons/
tools/    build-extension.mjs (package + ZIP)  make-icons.mjs
tests/    session-logic.test.js  sync-queue.test.js
server/   Fastify + SQLite API, web dashboard (web/), migrations, tests
```
