# Admin dashboard: setup and use

The dashboard ("Watch Ledger") is served by the same Node server as the API, at its `BASE_URL`. There is one owner account, created on the server; there is no sign-up page.

## Setup

1. Deploy or start the server ([`DEPLOYMENT.md`](DEPLOYMENT.md), [`../server/README-server.md`](../server/README-server.md)).
2. Create the owner: `node --env-file=.env scripts/create-owner.js you@example.com`.
3. Open `BASE_URL` and sign in. Sessions use HttpOnly cookies; the dashboard holds no secrets.

Optional settings in `.env` (all have safe defaults):

| Variable | Default | Meaning |
|---|---|---|
| `PAIRING_CODE_TTL_MIN` | `15` | How long a pairing code stays valid. |
| `PAIRING_MAX_FAILS` | `5` | Wrong codes from one address (within 15 minutes) before that address is locked out for 15 minutes. |
| `ENROLL_RATE_MAX` | `20` | Pairing attempts per address per hour. |
| `TRUST_PROXY` | `false` | **Set to `true` behind a reverse proxy.** Otherwise every request appears to come from the proxy's address, so one attacker's failed attempts would lock out everybody, and per-address limits would be shared. |

The pairing lockout is held in memory: restarting the server clears it. The per-hour rate limit is separate.

## The Devices page

**Overview strip.** Devices online now, total devices, active sessions, and session-deletion requests waiting for you. The sidebar badge counts devices awaiting approval plus requests awaiting a decision.

**Pair a device.** Enter a name (optional), choose whether the device needs your approval after it uses the code, and click *Generate pairing code*. The code (`XXXX-XXXX`, no look-alike characters) is shown **once**, with Copy, a countdown, and Cancel. When a browser uses it the panel switches to *Connected* by itself. Codes are stored only as hashes: you can never retrieve one later, only generate a new one.

**Tabs.**

| Tab | What it shows | What you can do |
|---|---|---|
| Devices | One card per device: *Online / Offline / Disconnected / Revoked / Awaiting approval*, extension version, last active, active sessions, whether the live connection or polling is in use, last upload, pending events, clock offset, number of pairings. | Approve or reject a pending device, rename, view history, send commands (Controls), **Revoke access** (ends every session of the device immediately), **Remove device** (also deletes what it synced). |
| Session deletion requests | Device name, session ID, when it was requested, status, optional reason. Decided requests are listed underneath. | **Approve** (confirmation dialog): the session is revoked, the device is told and disconnects, and the request is marked approved. **Deny**: the session stays active and the device is told. |
| Active sessions | One row per pairing that is still valid. | **Revoke** one session without touching the device's other sessions. |
| Pairing history | Every code: created, status (active / used / expired / cancelled), which device used it, from which address, and whether it needed approval. | Cancel a code that is still unused. |

**Online/offline.** A device is *Online* while its extension holds the live connection, or for a short grace period after it was last heard from (45 seconds for extension 0.5 and newer, 6 minutes for older ones that only poll). A laptop with Chrome closed shows *Offline*. A device with no active session shows *Disconnected*.

**Live updates.** The page listens to `GET /api/events` (Server-Sent Events) and refreshes within a fraction of a second of any change: device connected or disconnected, pairing completed, deletion requested, approved or denied, session revoked. The indicator beside the title reads *Live*; if the stream drops it reads *Updating every few seconds* and the page polls every 10 seconds until the stream returns. The server closes each stream after 10 minutes and the page reconnects, so a signed-out session cannot keep listening.

## Device configuration (server-managed settings)

Open a device (**Devices → Controls**). The **Configuration** card lets the owner set, per device:

| Setting | Values | Notes |
|---|---|---|
| Keep history for | forever, 7, 30, 90, 180, 365, 730 days | The extension deletes older sessions on that device, and the server's copy follows once the device confirms. |
| Sync every | 5, 10, 15, 30, 60 minutes | Changes the extension's sync timer. |

Choosing *Device's own setting* / *Device default* stops managing that value. There is intentionally **no** tracking on/off or "what to collect" setting here.

**What happens when you press Save changes:** the server checks you are the signed-in owner and that the device is yours and active, validates every value against the allowlist, saves a new version, writes the before/after to the Audit log (`config_changed`), and shows the change in the card's history. A connected extension is told at once and fetches it; otherwise it picks it up at its next sync. The extension validates the values again, applies only what it can, and reports **applied** or **failed** (with a reason); the card shows *Waiting for the device* (and whether it is offline), *Applied*, or *Could not apply*, and updates live. A failure is shown, not retried forever; saving a new version tries again. If you change something again before the device reports, the older version is marked *Replaced*.

**Authorization.** Every configuration route is enforced on the server (owner session, ownership of the device, same-site check); the extension can only read its own device's config. There is one owner account by design, so there is one role. Hiding or disabling a button is not the control. See `server/test/config.test.js` and `server/test/route-auth.test.js`.

**What this does not do.** It executes nothing on the device and cannot override the person using the browser: they can still pause tracking, delete their data (Dashboard → Your data), clear the extension's storage or remove the extension. The extension's Settings page labels each managed value *Managed by administrator*.

## What approval and revocation do

- A session deletion request is only a request. Nothing changes until you approve it. On approval the server marks the session revoked **and** the device is refused on its very next request even if its short-lived access token has not expired, and a connected extension is told over its live connection and disconnects at once. Its already-uploaded history stays on the server; delete it from *Data & backups* if you want it gone.
- A request can be decided once. Approving or denying it again returns an error, and opening the dashboard in two tabs cannot approve twice.
- Revoking a device (or a single session) while it has a request open closes that request as *cancelled*.
- A browser whose session was deleted can pair again with a new code; if it has no active session it gets its old device record (and history) back instead of appearing as a second device.

Every one of these actions is recorded in **Audit log** (`pairing_code_created`, `pair_completed`, `pair_requested`, `pairing_failed`, `pairing_code_cancelled`, `approve`, `session_deletion_requested`, `session_deletion_approved`, `session_deletion_denied`, `session_revoked`, `revoke`, `delete_device`).

## Reverse proxy notes

The live features use WebSockets (`/api/device/ws`) and a long-lived streaming response (`/api/events`).

- **Caddy**: `reverse_proxy 127.0.0.1:8443` handles both with no extra settings.
- **nginx**:

```nginx
location /api/device/ws {
    proxy_pass http://127.0.0.1:8443;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
}
location /api/events {
    proxy_pass http://127.0.0.1:8443;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 120s;
}
```

If a proxy blocks either, nothing breaks: the dashboard falls back to polling and extensions fall back to their 5-minute sync, but devices will not show as live and commands wait for the next sync.

## Limits

- The real-time hub lives inside one server process. Running two server instances behind one address would split the live connections; this deployment is single-node by design.
- The dashboard's Devices page and the live updates were checked by automated tests of the API and the real-time channels, not yet by hand in a browser against a real HTTPS deployment ([Known issues](KNOWN_ISSUES.md)).
