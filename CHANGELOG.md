# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [Semantic Versioning](https://semver.org/).

## [Unreleased] - v0.8.0 development (branch `develop/v0.8.0`)

### v0.8.0-rc.1 work in progress (Backup Manager and Security Center)
#### Added
- **Real-Chrome end-to-end test** (`WL_EXT_E2E=1 node --test server/test/ext-e2e.test.js`, `scripts/lib/chrome-ext.mjs`): the built extension in a temporary Chrome profile against real YouTube and a throwaway server. Guided manual list: `docs/MANUAL_TEST_CHECKLIST_EXTENSION.md`.
- **Backup Manager.** *Data & backups -> Verify* (and `restore.js --inspect`) checks a backup without changing anything: integrity, same / older / newer release, and whether this server's `MASTER_KEY` can read it. `GET /api/system/backups`, `POST /api/system/backups/:name/verify` (audited). See `docs/BACKUP_RECOVERY.md`.
- **Security Center** page and `GET /api/security/overview`: plain-language findings, where the owner is signed in, sign out everywhere else / everywhere, change password (`/api/auth/sessions`, `/sign-out-others`, `/sign-out-all`, `/password`). See `docs/SECURITY_CENTER.md`.
- Audit log filters and paging (`?action=`, `?before=`, `?limit=`); failed sign-ins are audited; the audit log is capped by size as well as age.

#### Fixed
- A seek that was slow to finish was counted as playing time in the event-based totals (A18; found by driving real Chrome on real YouTube). Mirrored in all three copies of `playback.js`.
- Several simultaneous dashboard requests refreshing with one cookie could sign the owner out (A7; now also reproduced and verified in headless Chrome).
- Restore: refuses backups from a newer release or that this key cannot read; writes atomically (a failed copy leaves the live database untouched); the safety copy keeps un-merged write-ahead-log data; verifies the result. Crashed backups leave no permanent `.partial` files. Details in `BUG_FIX_REPORT.md` (A8-A12).
- Expired owner sign-in tokens are deleted. Ending another browser no longer makes its retry look like theft (A14, B5).

#### Not verified
The installed extension on a live YouTube page, a real VPS, and a real full disk during restore. See `BUG_FIX_REPORT.md` section D.

### v0.8.0-beta.1 (this milestone; includes everything under alpha)
#### Added
- **Device Control Center** on every device page: Diagnostics (plain checks with fixes), Activity (merged history), Permissions (consent as reported by the device; the owner cannot change it). Confirmation dialogs for destructive actions.
- **Live viewing consent.** Per pairing, off by default, switched only in the extension popup, visible there and on the toolbar badge, enforced by the server (no stream and no current state without it), audited. See `docs/LIVE_MONITORING.md`.
- **Extension popup v2**: status hero, plain-language errors, retry countdown, queue and limit, manual Reconnect, connection details, live-viewing switch.
- **Smart sync engine**: failures classified, backoff with jitter and `Retry-After`, a few quick retries then the alarm, a rejected batch narrowed to the one bad item, a bounded event queue (events stay on the device), consent and queue state reported to the server. See `docs/SYNC_ENGINE.md`.
- **Timeline v2**: interactive overview ribbon, quick filters, viewing boundary rows, one tested ordering and de-duplication module.
- Migration `007_device_consents_sync_diagnostics.sql` (additive, tested against a real v0.7.0 database); `device_sync_errors` history; Health Center warns about queue overflow.
- `docs/UPGRADING.md` (upgrade and rollback), `BUG_FIX_REPORT.md`.
- The extension's `manifest.json` now carries `version_name` (`0.8.0-beta.1`); the ZIP is named after it.

#### Changed (privacy)
- Without live viewing, uploads of a running viewing wait for the regular sync (the end of a viewing still uploads after a few seconds) instead of going out about every 5-10 seconds. Devices on an older extension cannot enable live viewing until updated.

#### Fixed
- Events that share a timestamp are no longer interleaved between viewings; duplicates are shown once.
- A rejected upload batch no longer blocks the queue for ever; the offline queue is bounded; retries no longer loop. See `BUG_FIX_REPORT.md` for each defect, how it was confirmed and its test.
- The popup could show stale state when two refreshes overlapped.

### v0.8.0-alpha
#### Added
- **Analytics** page and `GET /api/analytics`: today / 7 / 30 / 90 days or a custom range, day / week / month grouping, comparison with the previous period, watch time by hour and weekday, time per device, top videos and channels. Time comes from recorded playback runs; overlapping playback on one device is counted once; days follow Sri Lanka time.
- **Health Center** page and owner-only `GET /api/system/health`: uptime, CPU, memory, disk, database, devices online, sync errors and backup age, with explainable warnings.
- Dashboard v2 layer (`ui.css`): grouped sidebar, KPI tiles, rings, entrance transitions (reduced-motion aware), light glass on the sidebar only.
- Overview shows the change against the previous period.
- `scripts/ui-check.mjs` and a test: a real headless Chrome checks every page at phone, tablet and desktop widths for drawing, error states and sideways scroll.
- GitHub Actions: `actions/checkout@v7` and `actions/setup-node@v7`.

#### Fixed
- **Navigation race:** a slow page (for example Overview) could finish loading after the owner had moved to another page and draw over it. Page reads from an earlier page are now dropped.
- The installer test suite no longer fails on a host whose disk is nearly full.

#### Not in this milestone yet
Device Control Center upgrades, Timeline V2 filters, real-time device monitoring, extension popup V2, sync hardening, Diagnostics, Notifications, Reports Studio, Update Manager, Security Center, Backup Manager and Settings Studio are planned for the beta and release-candidate milestones.

## [0.7.0] - 2026-11-03

### Added
- **Video Details.** A per-video page with live status (`LIVE WATCHING`, `PAUSED`, `COMPLETED`, `DEVICE OFFLINE`), an event timeline, a pause/resume table, viewing history, five charts and CSV / JSON / printable-report export. A **Videos** list page links to it.
- **Event-driven playback capture** in the extension (pause, resume, seek, buffering, completion, tab switch, viewing end), with an IndexedDB event outbox, crash recovery and exactly-once upload. A *Collect watch detail* switch turns detail off.
- **Server:** playback-event ingest, migration `006`, derived analytics tables, read APIs, live state over SSE.
- **Guided VPS installer** (`scripts/install.sh`): Ubuntu 22.04/24.04, interactive, resumable, with DNS verification, nginx, Let's Encrypt, `systemd`, `ufw`, a strong-password policy and generated keys. Plus `update.sh` (backup first, automatic code rollback), `backup.sh`, `restore.sh` and `health-check.sh`.
- Root `install.sh` entry point (`sudo bash install.sh`), `--port` option, and a production operations guide (`docs/PRODUCTION_GUIDE.md`).
- GitHub Actions CI (`.github/workflows/ci.yml`): tests, syntax and shell lint, link check, dependency audit, extension build and ZIP validation. Read-only permissions; publishes nothing.
- `scripts/smoke-test.mjs` (HTTP smoke test for a deployed server), `scripts/check-links.mjs` (documentation link checker).
- Documentation: installation, VPS deployment, domain, SSL, extension setup, device pairing, backup and recovery.
- MIT licence, third-party notices, contributing guide.

### Changed
- Every date and time is shown in Sri Lanka Standard Time (Asia/Colombo); storage stays UTC.
- Student/academic documents moved to `docs/project-notes/`.
- `server/package.json` version aligned with the extension (it was still `0.1.0`).

### Fixed
- **Key rotation** (`server/scripts/rotate-key.js`) re-encrypted only `videos` and `sessions`; the event tables added in 0.7.0 would have become unreadable after a rotation. It now re-encrypts every table that has an encrypted column (regression test added).

### Known limitations
- The installer's system steps (`apt`, `systemd`, `nginx`, `certbot`, `ufw`) have not been run on a real VPS by the author; see [docs/VPS_DEPLOYMENT.md](docs/VPS_DEPLOYMENT.md).
- Real-browser YouTube playback with the real extension was not exercised automatically; see [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md).
- The extension is installed in Developer mode; it is not published on the Chrome Web Store.

## [0.6.0] - 2026-11-02
- Read-only extension Settings and Device info pages; server-managed device configuration (retention, sync interval) pushed live and confirmed by the extension.

## [0.5.0] and earlier
- Device sessions, approval flow, revocation, deletion requests, real-time channels (SSE and WebSocket), ZIP build with secret scan, API authorization sweep, dashboard design system and responsive layouts.
