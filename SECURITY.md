# Security checklist (remote sync server)

The server stores a record of what someone watched. Treat the items below as load-bearing.
Each item says **how it is met** and whether that is **enforced by code (and tested)** or **your responsibility as the operator**. Nothing here is a certification; it is what the code does today.

Run the tests with `cd server && npm test`.

## Enforced by code

- [x] **Consent is the device's, and the server enforces it (v0.8).** Live viewing, tracking and watch-detail switches are *reported* by the device and recorded; no owner route changes them. With live viewing off, no real-time stream and no current state reach the owner (checked by the server, not just hidden in the page). Every change is audited. Only booleans are accepted; junk is ignored. *Tests: migration-007, sync-engine.*
- [x] **Device diagnostics and activity are owner-only and credential-free (v0.8).** Both routes answer 401 without the owner's cookie and with a device token; the output is built from an allowlist and fields that look like secrets are dropped. *Tests: device-center, route-auth sweep.*
- [x] **Reported values are bounded (v0.8).** Queue counts are clamped, error text is truncated to 300 characters and shown only through HTML escaping, error kinds are an allowlist. *Tests: migration-007.*

- [x] **HTTPS only.** `server.js` refuses to start with `NODE_ENV=production` unless it holds `TLS_CERT`/`TLS_KEY` or `TRUST_PROXY=true` (TLS terminated by a proxy, server bound to loopback), and requires an `https://` `BASE_URL`. Responses carry HSTS. The extension refuses non-https server addresses (plain http only for `localhost`/`127.0.0.1` during development). *Operator: obtain the certificate and keep the proxy correct, see below.*
- [x] **Password and token storage.** The owner password: argon2id. Device credentials and refresh tokens: 256-bit random, stored only as SHA-256. Device access tokens: HMAC-signed, 15 minutes. Pairing codes: stored hashed, single-use (claimed atomically), 15-minute expiry. Login always performs a hash verification so unknown emails are not distinguishable by timing. *Tests: auth, authz.*
- [x] **Sessions.** 15-minute HMAC-signed access cookie plus a rotating, revocable refresh cookie (`HttpOnly; Secure; SameSite=Strict`, signed; refresh cookie scoped to `/api/auth`). Replaying an already-rotated refresh token revokes all of that admin's sessions. Logout revokes. *Tests: auth.*
- [x] **Ownership on every admin route.** `ownDevice()` returns 404 for unknown ids and 403 when `device.admin_id !== req.admin.id`, on every device-scoped read, command, revoke and delete. *Tests: authz (admin B against admin A's device on all six routes).*
- [x] **Device routes touch only the authenticated device's rows.** Every query is keyed by `req.device.id`; device tokens do not work on admin routes and admin cookies do not work on device routes; a revoked device gets 403 and a deleted one 401. *Tests: authz.*
- [x] **Encrypted at rest (application level).** Every stored video and session record is AES-256-GCM encrypted with `MASTER_KEY`. Only whitelisted, length-bounded fields are stored. *Tests: sync ("encrypted at rest", "whitelisted fields"). Rotation: below.*
- [x] **Input validation and rate limits.** Session, command, enrollment, registration and ack payloads are validated (type, size, format; batches capped at 500; body capped at 2 MB). Per-route limits: login 10/15 min, register 5/h, refresh 30/15 min, enroll 20/h, push 120/min, 300/min global (per IP). *Tests: sync, commands.*
- [x] **CORS and headers.** CORS limited to `CORS_ORIGIN`; CSP (`default-src 'self'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on the API. The web dashboard uses no inline script or style and escapes all device-supplied text (checked in a browser with a hostile video title). *Tests: auth.*
- [x] **CSRF.** Cookies are `SameSite=Strict`, and a state-changing admin request carrying a foreign `Origin` is rejected. *Tests: auth.*
- [x] **Audit log.** Login, logout, refresh-reuse, pairing-code creation and cancellation, completed and requested pairing, **failed pairing attempts**, approve, revoke, session revoke, session deletion requested/approved/denied, device delete, command enqueue (with payload), viewable by the owner. *Tests: authz, sessions, sync.*
- [x] **Retention mirrors the device.** When a device confirms a `set_retention` command, the server applies the same window to its synced copy and re-trims hourly; videos left with no sessions are removed and rollups rebuilt. *Tests: retention.*
- [x] **Single owner, no registration.** There is no register route. The one owner is created on the server (`scripts/create-owner.js`) and the database itself refuses a second row. *Tests: auth.*
- [x] **Device sessions, optional approval and immediate revocation.** Each pairing is a session with its own credential. A code used normally connects the device; a code generated with *Require my approval* creates a `pending` device that every sync route refuses (403) until the owner approves it. Device **and session** status are re-read from the database on every request, so a revoked device or session is refused even with an unexpired access token, and its credential can no longer obtain new ones. A live WebSocket is closed when its session is revoked. *Tests: pairing, sessions, device-client (two simulated devices running the real extension code), realtime.*
- [x] **Session deletion needs the owner.** A device can only file a deletion *request* (at most one open per session, enforced by a unique index; asking twice returns the same request). Approve and deny are owner-only routes behind the cookie session and cross-site-write guard, check ownership of the row, and flip the request atomically from `pending`, so a request is decided exactly once (a second approve or a deny after approve returns 409). Approval revokes the session and disconnects the device; denial leaves it active. The old self-revoking `/api/sync/unenroll` now only files a request. *Tests: sessions, device-client, sync.*
- [x] **Pairing codes.** 8 characters from a 31-character alphabet without look-alikes (~8.5e11 combinations), stored only as SHA-256, single use (claimed atomically; four simultaneous attempts yield one winner), 15-minute life, cancellable, with history. Per address: 20 attempts/hour and a 15-minute lockout after 5 wrong codes; every failure is audited. The lockout is in memory (cleared on restart) and keys on the client address, so `TRUST_PROXY=true` is required behind a proxy. *Tests: sessions.*
- [x] **Real-time channels.** The dashboard's `/api/events` (Server-Sent Events) requires the owner's cookie session; the device WebSocket `/api/device/ws` requires an access token in its first message (5-second deadline, 4 KB message cap, forged/expired/revoked refused), carries hints only (never watch data), and is checked against the database at connect time. *Tests: realtime.*
- [x] **Extension build contains no secrets.** `tools/build-extension.mjs` packages an allowlist of extension files only, refuses private keys, and fails if its output contains key material, `.env`/database files or credential-like text. *Tests: build.*
- [x] **Server-managed configuration.** Owner-only routes to read, change and list history of a device's settings (cookie session, ownership of the row checked, cross-site writes refused); the device routes only return the device's own config and accept acknowledgements for the current version (stale or foreign ones change nothing). Values are limited to an allowlist of bounded integers (`retention_days`, `sync_interval_minutes`) and validated again in the extension, which reports applied or failed. Every change is versioned, kept in history and audited with before/after values; it is delivered over the live channel when connected and otherwise at the next sync. There is no tracking setting and nothing executable. *Tests: config, config-sync, route-auth.*
- [x] **Read-only extension pages.** Settings and Device information only display state (no storage writes); this is display, not a security boundary (see below). *Tests: status.*
- [x] **No loss, no duplicates on the wire.** Uploads are acknowledged per event (`sessionId` + `rev`); the server keeps the highest revision per session, so retries are idempotent. *Tests: sync, device-client (offline, lost response, restart, token expiry).*
- [x] **No secrets in the client.** `web/` contains no keys; sessions live in HttpOnly cookies. Shared browser/server code is kept identical to the extension's by `scripts/sync-shared.js --check` (also a test).
- [x] **Key rotation is documented and tested** (`scripts/rotate-key.js`, procedure below).

## Your responsibility (cannot be enforced by this code)

- [ ] **Create the owner account straight after deploying** (`scripts/create-owner.js`). Nothing can sign in until it exists.
- [ ] **Strong secrets.** `COOKIE_SECRET` ≥ 32 random chars (`openssl rand -hex 32`), `MASTER_KEY` 32 random bytes (`openssl rand -base64 32`), supplied via the environment or a secrets manager. `.env` is git-ignored; never commit it. Back up `MASTER_KEY` separately from the database — losing it makes the data unrecoverable.
- [ ] **Encrypted volume.** Put the database (and its WAL files) on an encrypted disk. Application-level encryption protects record contents but not metadata (timestamps, video ids, device labels, audit log).
- [ ] **Certificates and proxy.** Valid TLS certificate; if behind nginx/Caddy set `TRUST_PROXY=true`, forward `X-Forwarded-For`, and expose only the proxy publicly.
- [ ] **Backups** are encrypted and tested; restore requires the matching `MASTER_KEY`.
- [ ] **Updates.** Keep Node and dependencies patched (`npm audit`).

## Key rotation procedure

1. Stop the server and copy the database file (and `-wal`/`-shm`) somewhere safe.
2. Generate a new key: `openssl rand -base64 32`.
3. `OLD_MASTER_KEY=<current> MASTER_KEY=<new> DB_PATH=./data/tracker.db node scripts/rotate-key.js`
   It re-encrypts every record in one transaction and changes nothing if any record fails to decrypt (e.g. wrong old key).
4. Set `MASTER_KEY=<new>` in the server's environment and start the server.
5. Keep the old key and the pre-rotation backup until you've verified the dashboard, then destroy them.

## Known gaps and limits (so you can decide whether they matter to you)

- **No second factor and no per-account lockout** (rate limiting is per IP). Password reset is done on the server: `scripts/create-owner.js --reset`.
- **SQLite, single node.** `src/db.js` is the seam for moving to Postgres; nothing else is tied to SQLite.
- The audit log and device records are not encrypted, and the audit log records client IPs.
- **Deletions on the device do not delete the server copy**, except through retention. Use *Delete device and synced data* in the dashboard to remove server-side data.
- Device credentials live in `chrome.storage.local`, readable by anyone with access to the browser profile. The extension's admin password only hides its pages; it is not a security boundary.
- Remote commands are polled, so they apply on the device's next sync (≈5 minutes), and the person at the device can undo pause/retention changes locally.
- The web dashboard and sync client were exercised in Chrome only against a local development server (http://127.0.0.1); the HTTPS/proxy path is not covered by automated tests.
- **Not yet verified by hand:** the new Devices page, popup, the built extension package in Chrome, and WebSocket/event-stream pass-through behind HTTPS and a reverse proxy are covered by automated tests of the API and sync code but were not exercised in a browser or a real deployment.
- **Unpair** (resolved in 0.6.0): the broken Admin console button was removed with that page; sessions end by admin approval of a request or by revocation.
- **Remote `resume_tracking` can turn tracking back on after the user paused it** (kept by the owner's decision; it is visible on the device and audited). See `docs/KNOWN_ISSUES.md` for the risk and how to remove it.
- **Read-only pages do not enforce anything.** Anyone using the browser can still read or change extension storage with developer tools, pause tracking, delete data or uninstall the extension; administrator settings cannot prevent that and the code does not try to.
- **Anyone holding a device's credential** (readable in the browser profile) can act as that session until it is revoked. A stable extension ID needs a key you generate and keep private (`docs/EXTENSION.md`); none is configured.
- **Migration 004 is one-way**; take a backup before upgrading.

## Reporting

If you find a vulnerability, please report it privately to the project owner rather than opening a public issue.
