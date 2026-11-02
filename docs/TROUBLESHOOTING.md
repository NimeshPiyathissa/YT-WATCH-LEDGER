# Troubleshooting

Start with the extension's **Admin console → Diagnostics** (last 80 events, with *Copy log*) and the dashboard's **Audit log**. For the known bug with the Admin console's Unpair button and other open items, see [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md).

## Pairing

| Symptom | Cause and fix |
|---|---|
| "That code is invalid, expired or already used." | Codes work once and expire (15 minutes by default). Generate a new one. Spaces, dashes and letter case don't matter; look-alike characters (`0/O`, `1/I/L`) are never used in codes. Check **Devices → Pairing history** to see whether the code was used, cancelled or expired. |
| "Too many attempts. Wait a few minutes and try again." | After 5 wrong codes from one address the server refuses further attempts from it for 15 minutes (even a correct code). Wait, or restart the server (the lockout is held in memory). Behind a proxy, make sure `TRUST_PROXY=true` so this applies to the real client address and not the proxy. |
| "Could not reach the server." | Wrong address, no internet, certificate problem, or the server is down. Open `https://your.domain/api/health` in the browser: it must answer `{"ok":true}`. Production needs `https://` (plain `http://` is accepted only for `localhost` and `127.0.0.1`). |
| "Permission to contact that server was not granted." | You dismissed Chrome's prompt. Click **Connect** again and accept. |
| Popup closes when Chrome shows the permission prompt, and the form is empty or half-filled | Chrome can close a popup that loses focus. The popup saves the server and code you typed and refills them when reopened; click **Connect** again. If it was not refilled, open the **Admin console → Private sync** page instead, which is a full tab and does not close. |
| Popup says **Waiting for approval** | The code was generated with *Require my approval*. Compare the confirmation code with the device card and click **Approve device**. |
| Device appears twice in the dashboard | A browser pairing again after its extension ID changed (for example it was loaded from a different folder) is a new device. Remove the old one. See [`EXTENSION.md`](EXTENSION.md#updating-an-installed-extension). |

## Connection and status

| Symptom | Cause and fix |
|---|---|
| Device shows **Offline** but the laptop is on | Chrome must be running. Check the popup (*Channel*: Live or Polling) and Diagnostics. The live connection needs Chrome 116+ and a proxy that passes WebSockets ([`ADMIN_DASHBOARD.md`](ADMIN_DASHBOARD.md#reverse-proxy-notes)). Extensions older than 0.5 show Online for up to 6 minutes after their last 5-minute sync. |
| Popup shows *Polling* instead of *Live* | The WebSocket is not connecting (proxy not forwarding upgrades, or the server's `/api/device/ws` is unreachable). Syncing still works every 5 minutes; commands wait for the next sync. |
| Dashboard indicator says *Updating every few seconds* | The event stream (`/api/events`) isn't connected, usually proxy buffering or a sign-out. The page polls instead. Reload the page; check the proxy settings. |
| Dashboard shows an old version number for a device | The device hasn't contacted the server since it was updated. Click **Sync** in its popup. |
| Pending uploads keep growing | The server is unreachable from that browser; events stay queued and upload when it connects. |

## Session deletion requests

| Symptom | Cause and fix |
|---|---|
| Popup shows **Waiting for Admin Approval** for a long time | Nothing happens until the admin decides: Dashboard → Devices → *Session deletion requests*. The session keeps syncing meanwhile. |
| Admin sees *already decided* when approving or denying | It was decided already (another tab, or the request was cancelled because the session or device was revoked). Refresh the page. |
| Popup says the request was denied | The session stays connected; click **Delete session** again to ask again. |
| After approval the extension shows *Not connected* | That is correct: the session was deleted. Pair again with a new code to reconnect (history is kept and the same device record is reused). |

## Installing and updating

| Symptom | Cause and fix |
|---|---|
| "Manifest file is missing or unreadable" | You selected the wrong folder. Choose the folder that directly contains `manifest.json`, not its parent. |
| "This extension requires Chrome 116" or it fails to load | Update Chrome. |
| After an update the extension forgot its pairing and settings | Its ID changed (loaded from a different folder). Reload from the original folder, or set up a stable ID: [`EXTENSION.md`](EXTENSION.md#setting-up-a-stable-extension-id-optional-recommended-before-sharing-builds). |
| "Build failed: version mismatch" | `manifest.json` `version` and `FALLBACK_VERSION` in `lib/sync.js` must be equal. |
| "Build failed: secret scan failed" | The named file in the output contains a private key, a `.env`/database file or credential-like text. Remove it from the source; don't bypass the scan. |
| "Build failed: --key-file contains a PRIVATE key" | Pass the **public** key (`openssl rsa -in key.pem -pubout -out public-key.pem`). |

## Server

| Symptom | Cause and fix |
|---|---|
| Server exits at start | The message names the missing or invalid variable (`COOKIE_SECRET`, `MASTER_KEY`, TLS settings). |
| Server won't start after upgrading, or old and new versions disagree about the database | Migration `004_device_sessions.sql` is one-way. Run the new version, or restore the pre-upgrade backup ([`OPERATIONS.md`](OPERATIONS.md)). |
| `npm test` runs out of memory | Run the files one at a time: `node --test --test-concurrency=1 "test/**/*.test.js"` from `server/`, or a single file such as `node --test test/sessions.test.js`. |
| Everyone is locked out of pairing at once | The proxy's address is being counted as the client. Set `TRUST_PROXY=true` and forward `X-Forwarded-For`. |
