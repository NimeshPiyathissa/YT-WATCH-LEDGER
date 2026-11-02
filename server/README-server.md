# Watch Tracker server

Fastify + SQLite (better-sqlite3). Serves the sync API for enrolled extensions and the admin web dashboard (`web/`). Requires Node ≥ 20.

## Run

```bash
cd server
npm install
cp .env.example .env           # then fill in COOKIE_SECRET, MASTER_KEY, BASE_URL, CORS_ORIGIN
npm run migrate                # optional: the server also migrates on start
node --env-file=.env src/server.js
```

Create the single owner account on the server: `node --env-file=.env scripts/create-owner.js you@example.com` (there is no registration page or endpoint). Open `BASE_URL`, sign in, then *Devices → Generate pairing code*, and enter the server address and code in the extension's Admin console → Private sync. The device appears as *Awaiting approval*; approve it after checking the confirmation code. Full guide: [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

### Local development (plain http, loopback only)

```bash
NODE_ENV=development BASE_URL=http://127.0.0.1:8443 CORS_ORIGIN=http://127.0.0.1:8443 \
COOKIE_SECRET=$(openssl rand -hex 32) MASTER_KEY=$(openssl rand -base64 32) DB_PATH=./data/dev.db \
node src/server.js
node scripts/seed-dev.js        # demo owner + two approved devices + sample data (throwaway credentials, dev only)
```

### Production TLS

`NODE_ENV=production` refuses to start without TLS. Either:

- **Reverse proxy (recommended):** set `TRUST_PROXY=true`; the server listens on `127.0.0.1` only. Caddy:
  ```
  tracker.example.com {
    reverse_proxy 127.0.0.1:8443
  }
  ```
  nginx: `proxy_pass http://127.0.0.1:8443;` with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and `proxy_set_header X-Forwarded-Proto https;` inside a TLS `server` block.
- **Direct:** set `TLS_CERT` and `TLS_KEY` to PEM file paths.

## Scripts

| Command | Purpose |
|---|---|
| `npm test` | All server tests (includes the real extension sync client against the real server). |
| `node scripts/sync-shared.js [--check]` | Copy the extension's shared modules into `web/vendor/` and `src/lib/accounting.cjs`; `--check` fails if they drifted. Run after editing `../lib/{util,accounting,stats,charts,theme*}`. |
| `node scripts/rotate-key.js` | Re-encrypt data under a new `MASTER_KEY` (see `../SECURITY.md`). |
| `node scripts/seed-dev.js` | Dev-only demo data. |

## API

```
Owner (HttpOnly cookie session; there is no registration route)
POST /api/auth/login|refresh|logout
POST /api/devices/enroll-code {label,requireApproval?} -> {id,code,expiresAt}  one-time, 15 min (PAIRING_CODE_TTL_MIN), shown once
GET  /api/devices                                      -> devices with sync status (last_push_at, pending_count, last_error, clock_skew_ms, confirm_code while pending)
POST /api/devices/:id/approve   PATCH /api/devices/:id {label}   POST /api/devices/:id/revoke (ends all its sessions)   DELETE /api/devices/:id
GET  /api/sessions[?status=all&device=]                -> sessions (id, device, status, last_seen, live)    POST /api/sessions/:id/revoke
GET  /api/session-requests[?status=]                   -> deletion requests    POST /api/session-requests/:id/approve|deny {note?}   (owner only, decided once)
GET  /api/pairing-codes                                -> code history (status, used by, mode)   POST /api/pairing-codes/:id/revoke
GET  /api/events                                       Server-Sent Events for the dashboard (owner cookie)
GET|PUT /api/devices/:id/config {changes:{retention_days?,sync_interval_minutes?}}  GET /api/devices/:id/config/history   (owner only; values validated, versioned, audited; null clears a setting)
POST /api/devices/:id/commands {type,payload}          pause_tracking|resume_tracking|set_retention|delete_all|delete_range
GET  /api/history?device=&from=&to=&q=&url=&limit=&offset=    combined, every record tagged with its source device
GET  /api/stats?device=&from=&to=&tz=                  totals + daily/weekly/monthly series
GET  /api/export?format=csv|json&...filters            POST /api/data/delete {confirm:true,device?,from?,to?}
GET|PUT /api/settings   GET /api/system   POST /api/system/backup   GET /api/audit
Device (no cookies)
POST /api/enroll {code,installId,platform,clientVersion}  public; one-time code -> {deviceId,sessionId,refreshToken,status:"active"|"pending",confirmCode?}; 5 wrong codes lock the address out 15 min
POST /api/device/token    Authorization: Bearer <refreshToken>        -> {accessToken (15 min, names the session), status, sessionId}   403 revoked | session_deleted
GET  /api/device/status   GET /api/device/session      access token; work while pending (session + latest deletion request)
POST /api/device/session/deletion-request {reason?}    files a REQUEST (201; 200 if one is already open); nothing is deleted until the owner approves
GET  /api/device/ws                                    WebSocket; first message {type:"auth",token}; hints only
GET  /api/sync/config -> {version,config}   POST /api/sync/config/ack {version,status:"applied"|"failed",error?}   access token; only the device's own config; stale versions change nothing
POST /api/sync/push {sessions,clientNow,pending,lastError,clientVersion}   -> {acked:[{sessionId,rev}], rejected:[...], skewMs}
GET  /api/sync/commands   POST /api/sync/commands/ack  POST /api/sync/unenroll (files a deletion request; kept for extensions older than 0.5)      access token; approved devices only
```
