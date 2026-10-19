# YouTube Watch Tracker

A Manifest V3 Chrome extension that records how long you watch YouTube videos, **on this device**, with an optional, opt-in private sync to a server you run, so you can see all your own devices' history in one dashboard.

## Ground rules (please read)

- **Tracking is visible.** The toolbar shows a `REC` badge while a video is being recorded, the popup shows tracking state, and once sync is enabled the popup and Settings permanently say *"Syncing YouTube watch data to <server>."*
- **YouTube only.** The content script runs on `youtube.com`; nothing else is observed.
- **No covert collection.** Sync is off by default. It starts only when someone at the browser enters a server address and a one-time pairing code and grants the permission prompt, and nothing is uploaded until the owner approves the device. They can unpair at any time.
- **Lawful, consensual use only.** The operator is responsible for using this lawfully and with the knowledge and agreement of every person whose browsing is recorded (for example, a parent with a child's informed awareness, or your own devices). It is not designed or supported for monitoring people who don't know about it.

## What it records

Per watched video: video id, title, channel, start/end time, seconds actually playing (ads excluded), and duration. Nothing about other sites, page contents, comments, or account details.

## Install (development)

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
2. Open a YouTube video; the toolbar badge shows `REC` while it plays.
3. Popup → **Dashboard** (history, charts), **Settings**, or **Admin console**.

### Permissions

| Permission | Why |
|---|---|
| `storage` | Settings and local state (`chrome.storage.local`); history lives in IndexedDB. |
| `alarms` | A 5-minute timer for sync (and a 1-minute check while waiting for approval). Does nothing unless paired. |
| host `https://www.youtube.com/*` | Run the tracker on YouTube. |
| optional hosts (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`) | **Not granted at install.** The browser asks for the one server origin you pair with, and it is removed again on unpair. The localhost entries are for development. |

## Local features

- **Admin console** (`admin/`): install identity, live "tracking now" indicator, tracking on/off, retention (7–180 days or forever), theme, export (all / date range / channel) and delete (range / channel / all) with confirmation, an optional admin password, and diagnostics.
- **Admin password**: a convenience lock for the admin pages only. History is still readable through developer tools and the extension can be removed from `chrome://extensions`. It is not strong security.

## Private sync (optional)

For use across **your own** devices, with one owner and one server you run. Full setup: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md); backups and recovery: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

```
Laptop 1 (extension) ─┐
                      ├── HTTPS ── private API ── SQLite ── owner dashboard
Laptop 2 (extension) ─┘
```

- **Pairing:** the owner generates a one-time code (15 minutes, single use) in the dashboard; the laptop enters the server address and code. The laptop then shows a confirmation code and waits as **pending**: it cannot upload or read anything until the owner checks the same code in the dashboard and **approves** it.
- **Credentials:** the device keeps one random long-lived credential, sent only to `/api/device/token`, which returns a 15-minute access token used for everything else. Device status is checked on every request, so **revoking takes effect immediately**, even for an unexpired access token. There are no shared passwords or secrets in the extension.
- **Reliable upload:** every session snapshot is queued in IndexedDB in the same transaction that stores it (event id `sessionId:revision`), uploaded in batches, and removed from the queue only when the server acknowledges that exact revision. Offline periods, dropped connections, expired tokens and browser restarts do not lose events; resending never duplicates (the server keeps the highest revision per session). Pending uploads and the last successful sync are shown in the popup, the Admin console and the dashboard.
- **Clocks:** devices report their time on each upload; the server measures the offset and places every record on its own timeline, and conflict resolution uses revision counters, not clocks.
- **What leaves the device:** the session records above (video id, URL, title, channel, start/end, seconds watched, progress, seeks/pauses). History recorded before pairing is not uploaded unless the box is ticked.
- **What the owner can do remotely:** pause/resume tracking, set retention, delete data stored on the device. These are visible on the device and apply on its next sync.
- **Revoke / unpair:** the owner can revoke or remove a device from the dashboard; the device then stops, clears its credential and queue, and says so. The person at the device can unpair too. Data already uploaded stays on the server until the owner deletes it.

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
- The extension's own screens (popup, Admin console) were not run in Chrome against a live server after the latest changes. The sync code behind them is tested through simulated devices, and the dashboard was checked in Chrome against a local dev server. A run of the real extension through your own HTTPS deployment is still to do.
- Player events cannot prove a human was watching; "active" means the player was in a playing, non-ad state.
- The extension remains removable from `chrome://extensions`. Forced installation needs enterprise policy (`ExtensionInstallForcelist`) and is out of scope here.
- The person at the device can re-enable tracking after a remote pause, and can unenroll.
- Local deletions (retention, remote delete) don't remove the copy already on the server, except via the server's retention mirror or *Delete device and synced data*.
- The extension and dashboard were tested in Chrome against a local development server only; no Chrome Web Store build or HTTPS-proxy test is included.

## Layout

```
manifest.json  background.js  content/tracker.js
lib/      util accounting db stats charts lock diag sync  theme.css theme-init.js
popup/ dashboard/ settings/ admin/
tests/    session-logic.test.js  sync-queue.test.js
server/   Fastify + SQLite API, web dashboard (web/), migrations, tests
```
