# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [Semantic Versioning](https://semver.org/).

## [Unreleased] - v0.8.0 development (branch `develop/v0.8.0`)

### v0.8.0-rc.1 (release candidate, prepared 2026-11-09; not published)
Version metadata: `manifest.json` `version_name` `0.8.0-rc.1` (`version` stays `0.8.0`), `server/package.json` and `package-lock.json` `0.8.0-rc.1`. Database migrations since v0.7.0: `007` (device consents and sync diagnostics), `008` (notifications), `009` (saved reports), all additive. Upgrading from v0.7.0, the RC limits and rolling back: `docs/UPGRADING.md`.

#### Added
- **Release packaging** (`tools/build-release.mjs`): builds `watch-ledger-v<version>.tar.gz` (tracked files only, one top-level folder, file modes from git, owner root, reproducible), the extension ZIP and `SHA256SUMS`, and verifies them; refuses inconsistent versions, files that must never ship (secrets, keys, databases, backups, logs, `node_modules`), private keys or tokens in any file, and uncommitted changes. Procedure: `docs/RELEASING.md`.
- **Update Manager** (`#/updates`, under System): installed version and release channel, Node.js and uptime, the history of updates made with `scripts/update.sh`, pre-update backups with Verify, the releases kept for rollback, and copyable, version-specific update and rollback commands. Read-only: it never runs an update, rollback or restore, and no route can start a process (checked by a test). Opt-in release check (Settings → Updates, off by default; only on **Check now**; no credentials sent, no token read; 10 s, 1 MB, no redirects; strict SemVer; never a downgrade; stable servers are offered stable releases only, pre-release servers newer pre-releases of their line only when switched on). `GET /api/updates`, `POST /api/updates/check`, `POST /api/updates/backups/:name/verify`. `update.sh` now appends one JSON line per real update attempt to `/var/lib/watch-ledger/update-history.jsonl` (additive and isolated: its behaviour, options and exit codes are unchanged). See `docs/UPDATES.md`.
- **Reports Studio** (`#/reports`): daily, weekly (Monday to Sunday), monthly and custom (up to 366 days) watch reports on Sri Lanka days, from the Analytics engine (real playback only, overlapping playback counted once), with the previous period for comparison. Device, channel and video filters (a filtered total is the fair share, so it matches the unfiltered figure exactly). Saved report configurations (up to 50, encrypted, migration `009_saved_reports.sql`; day / week / month ones open on the current period). CSV (by day, viewings, videos, channels, devices, hours; formula-safe), JSON, and a print-ready page for Save as PDF; every export audited. Loading, empty and error states; responsive down to phone width; the report is part of the address. `GET /api/reports`, `GET /api/reports/export`, `GET|POST /api/reports/saved`, `PUT|DELETE /api/reports/saved/:id`, all owner-only and validated. "Reports" can be the page the dashboard opens on. See `docs/REPORTS.md`.
- **Settings Studio** (`#/settings`): retention, audit retention, backup schedule and keep count, pairing lifetime and lock-out, notification thresholds, and the owner's preferences (landing page, compact tables), all validated by the server, applied without a restart and audited with old and new values. Shortening retention shows how many sessions would be deleted and needs that number confirmed. Settings that need a restart are listed read-only. See `docs/SETTINGS.md`.
- **Notification Center** (in the dashboard only; nothing is sent anywhere): eight configurable kinds, thresholds, a sidebar count, Active and History views, mark read and dismiss, retention. Migration `008_notifications.sql`. See `docs/NOTIFICATIONS.md`.
- **Real-Chrome end-to-end test** (`WL_EXT_E2E=1 node --test server/test/ext-e2e.test.js`, `scripts/lib/chrome-ext.mjs`): the built extension in a temporary Chrome profile against real YouTube and a throwaway server. Guided manual list: `docs/MANUAL_TEST_CHECKLIST_EXTENSION.md`.
- **Backup Manager.** *Data & backups -> Verify* (and `restore.js --inspect`) checks a backup without changing anything: integrity, same / older / newer release, and whether this server's `MASTER_KEY` can read it. `GET /api/system/backups`, `POST /api/system/backups/:name/verify` (audited). See `docs/BACKUP_RECOVERY.md`.
- **Security Center** page and `GET /api/security/overview`: plain-language findings, where the owner is signed in, sign out everywhere else / everywhere, change password (`/api/auth/sessions`, `/sign-out-others`, `/sign-out-all`, `/password`). See `docs/SECURITY_CENTER.md`.
- Audit log filters and paging (`?action=`, `?before=`, `?limit=`); failed sign-ins are audited; the audit log is capped by size as well as age.

#### Fixed
- **Release candidate to final update kept running the release candidate (A29).** v0.7.0's `update.sh` installed a 0.8.0 pre-release into `releases/0.8.0`; the final 0.8.0's update would have found that folder "already deployed", reported success and kept running the release candidate, with no release to roll back to. `update.sh` now renames a running release folder after the version it really holds before anything else, reuses a folder only when its `manifest.json` (`version` and `version_name`) and `.install-complete` name the exact version, never reuses or replaces the running release for another version, refuses a release whose `version` and `version_name` disagree, and after the health check confirms that the intended version is the one running (link, manifest, `server/package.json`, and the service's working folder) or rolls back. The Updates page marks a folder named after another version.
- **Scripts were not executable in the release (A30).** v0.7.0's tarball had no executable bits, so `sudo ./scripts/update.sh` (and backup, restore, health-check) answered "command not found". The scripts are executable in git and in the release tarball; the Updates page's commands and the upgrade guide use `sudo bash scripts/...`, which works on v0.7.0 servers too.
- **The release archive's checksum depended on the build machine (A32).** zlib writes the build machine's operating system into the gzip header, so the same commit gave a different `.tar.gz` and `SHA256SUMS` on Windows and on Linux. The header is now fixed (OS byte "Unix"), so every machine builds byte-identical assets, and verification refuses a tarball without that header. Verified on 2026-11-09: release tests 12 / 12, server suite 406 pass / 0 fail / 2 skipped, installer suite 142 ok / 0 failed, extension tests 272 / 0; this machine's `.tar.gz` of `4fcd083` now equals the Linux CI build (`b4115526…`).
- **A release built on Windows was not the commit (A31).** The release was packaged from the working tree, which a Windows checkout (`core.autocrlf`) fills with CRLF line endings, so it shipped CRLF sources and docs (the shell scripts were kept LF by `.gitattributes`) and was not reproducible. The tarball and the extension ZIP are now built from the commit's exact bytes, and the build verifies every file against the commit. Verified on 2026-11-09: server suite 404 pass / 0 fail / 2 skipped, installer suite 142 ok / 0 failed (11 release-switch runs skipped here, Linux only), extension tests 272 checks / 0 failed, `ui-check.mjs` 122 / 0.
- Headless-Chrome test profiles could still be left half-deleted; removal now retries until the folder is gone (A26 follow-up). The dashboard check (`ui-check.mjs`) waits for rate-limit headroom instead of tripping the server's 300-requests-a-minute limit (A27). The installer test's time limit fits its run time under the full suite (A28).
- A print-ready report opened after the dashboard had been idle for more than 15 minutes showed only `{"error":"unauthorized"}`: the new tab has no script to renew the sign-in. The dashboard now renews it before opening the tab (Video Details and Reports) (A25).
- The test suites left every temporary folder behind (1,743 folders, 2.7 GB had piled up, enough to fill a nearly full disk); temporary folders and Chrome profiles are now removed when a test run ends (A26).
- An invalid `BACKUP_KEEP` (for example `abc`) deleted every backup including the new one, and a backup interval that was not a number silently switched scheduled backups off (A22). Bad environment values are now ignored, reported and replaced by the default.
- The Data page changed the retention window and deleted data immediately, without showing how much; the control now lives in Settings Studio with a count and a confirmation (A23). The old API route is unchanged.
- Settings Studio overwrote the backup keep count and interval a caller gave the app with the built-in defaults; an explicit owner or environment value still wins, otherwise the caller's value stands (A24). Re-verified on 2026-11-09: server suite 354 pass / 0 fail / 2 skipped, extension tests 272 checks / 0 failed, `ui-check.mjs` 104 / 0.
- The Security page's sidebar entry and empty state used an icon that does not exist (an unknown name draws a warning symbol); a test now checks every icon name the dashboard and the extension use (A21).
- The end of a viewing could be lost with nothing left to recover from: the saved recorder state is now kept until the service worker has stored the end event, duplicate end events are dropped, and recovery never closes a viewing twice (A19; measured in real Chrome).
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
