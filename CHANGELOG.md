# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [Semantic Versioning](https://semver.org/).

## [0.7.0] - 2026-11-03

### Added
- **Video Details.** A per-video page with live status (`LIVE WATCHING`, `PAUSED`, `COMPLETED`, `DEVICE OFFLINE`), an event timeline, a pause/resume table, viewing history, five charts and CSV / JSON / printable-report export. A **Videos** list page links to it.
- **Event-driven playback capture** in the extension (pause, resume, seek, buffering, completion, tab switch, viewing end), with an IndexedDB event outbox, crash recovery and exactly-once upload. A *Collect watch detail* switch turns detail off.
- **Server:** playback-event ingest, migration `006`, derived analytics tables, read APIs, live state over SSE.
- **Guided VPS installer** (`scripts/install.sh`): Ubuntu 22.04/24.04, interactive, resumable, with DNS verification, nginx, Let's Encrypt, `systemd`, `ufw`, a strong-password policy and generated keys. Plus `update.sh` (backup first, automatic code rollback), `backup.sh`, `restore.sh` and `health-check.sh`.
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
