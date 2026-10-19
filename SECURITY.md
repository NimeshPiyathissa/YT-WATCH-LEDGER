# Security checklist (remote sync server)

The server stores a record of what someone watched. Treat the items below as load-bearing.
Each item says **how it is met** and whether that is **enforced by code (and tested)** or **your responsibility as the operator**. Nothing here is a certification; it is what the code does today.

Run the tests with `cd server && npm test`.

## Enforced by code

- [x] **HTTPS only.** `server.js` refuses to start with `NODE_ENV=production` unless it holds `TLS_CERT`/`TLS_KEY` or `TRUST_PROXY=true` (TLS terminated by a proxy, server bound to loopback), and requires an `https://` `BASE_URL`. Responses carry HSTS. The extension refuses non-https server addresses (plain http only for `localhost`/`127.0.0.1` during development). *Operator: obtain the certificate and keep the proxy correct, see below.*
- [x] **Password and token storage.** The owner password: argon2id. Device credentials and refresh tokens: 256-bit random, stored only as SHA-256. Device access tokens: HMAC-signed, 15 minutes. Pairing codes: stored hashed, single-use (claimed atomically), 15-minute expiry. Login always performs a hash verification so unknown emails are not distinguishable by timing. *Tests: auth, authz.*
- [x] **Sessions.** 15-minute HMAC-signed access cookie plus a rotating, revocable refresh cookie (`HttpOnly; Secure; SameSite=Strict`, signed; refresh cookie scoped to `/api/auth`). Replaying an already-rotated refresh token revokes all of that admin's sessions. Logout revokes. *Tests: auth.*
- [x] **Ownership on every admin route.** `ownDevice()` returns 404 for unknown ids and 403 when `device.admin_id !== req.admin.id`, on every device-scoped read, command, revoke and delete. *Tests: authz (admin B against admin A's device on all six routes).*
- [x] **Device routes touch only the authenticated device's rows.** Every query is keyed by `req.device.id`; device tokens do not work on admin routes and admin cookies do not work on device routes; a revoked device gets 403 and a deleted one 401. *Tests: authz.*
- [x] **Encrypted at rest (application level).** Every stored video and session record is AES-256-GCM encrypted with `MASTER_KEY`. Only whitelisted, length-bounded fields are stored. *Tests: sync ("encrypted at rest", "whitelisted fields"). Rotation: below.*
- [x] **Input validation and rate limits.** Session, command, enrollment, registration and ack payloads are validated (type, size, format; batches capped at 500; body capped at 2 MB). Per-route limits: login 10/15 min, register 5/h, refresh 30/15 min, enroll 20/h, push 120/min, 300/min global (per IP). *Tests: sync, commands.*
- [x] **CORS and headers.** CORS limited to `CORS_ORIGIN`; CSP (`default-src 'self'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on the API. The web dashboard uses no inline script or style and escapes all device-supplied text (checked in a browser with a hostile video title). *Tests: auth.*
- [x] **CSRF.** Cookies are `SameSite=Strict`, and a state-changing admin request carrying a foreign `Origin` is rejected. *Tests: auth.*
- [x] **Audit log.** Register, login, logout, refresh-reuse, enroll-code creation, enroll, revoke, device delete, command enqueue (with payload) and device-initiated unenroll, viewable per admin. *Tests: authz, sync.*
- [x] **Retention mirrors the device.** When a device confirms a `set_retention` command, the server applies the same window to its synced copy and re-trims hourly; videos left with no sessions are removed and rollups rebuilt. *Tests: retention.*
- [x] **Single owner, no registration.** There is no register route. The one owner is created on the server (`scripts/create-owner.js`) and the database itself refuses a second row. *Tests: auth.*
- [x] **Device approval and immediate revocation.** A paired device is `pending` and every sync route refuses it (403) until the owner approves it. Device status is re-read from the database on every request, so a revoked device is refused even with an unexpired access token, and its credential can no longer obtain new ones. *Tests: pairing, device-client (two simulated devices running the real extension code).*
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

## Reporting

If you find a vulnerability, please report it privately to the project owner rather than opening a public issue.
