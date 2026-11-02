# Installation guide

Three parts: run the server, build the extension, connect a browser. Allow about 30 minutes the first time.

> **Status.** The code and automated tests are in place. The Devices page, the new popup, loading the built ZIP in Chrome, and the HTTPS/proxy path have **not** yet been run by hand in a browser (see [Known issues](KNOWN_ISSUES.md)). Do the checks in step 4 before relying on it.

## 1. Run the server

Follow [`DEPLOYMENT.md`](DEPLOYMENT.md) for a real deployment (HTTPS is required in production) or [`../server/README-server.md`](../server/README-server.md) for a local development server. Requirements: Node 20+, a persistent disk, a domain with a TLS certificate.

Upgrading an existing server to this version:

1. **Back up first**: dashboard → Data & backups → *Back up now* (or `node scripts/backup.js`). Migration `004_device_sessions.sql` runs automatically on start and is **one-way**: it moves device credentials into a new `device_sessions` table and drops `devices.token_hash`. Going back to an older server version means restoring the backup.
2. `cd server && npm ci --omit=dev` (this version adds `@fastify/websocket`).
3. Restart the server. Devices paired before the upgrade keep working without re-pairing.
4. Behind a reverse proxy, make sure WebSocket upgrades and streaming responses pass through (Caddy does by default; for nginx see [Reverse proxy notes](ADMIN_DASHBOARD.md#reverse-proxy-notes)).

## 2. Build the extension

```bash
node tools/build-extension.mjs                                  # entered in the extension when pairing
node tools/build-extension.mjs --server https://tracker.example.com   # this build is for one server
```

Output (in `dist/`, which is git-ignored): `extension/` (the folder to load), `yt-watch-tracker-v<version>.zip`, and a `.sha256` file. Options, update steps and the stable-ID setup are in [`EXTENSION.md`](EXTENSION.md).

Chrome **116 or newer** is required (the manifest enforces it).

## 3. Install it in Chrome (Developer mode)

1. Unzip `yt-watch-tracker-v<version>.zip` into a **permanent** folder, for example `C:\Tools\yt-watch-tracker\`. Do not use a temporary or Downloads folder you may clean up, and do not move it later (see the update guide for why).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the folder that directly contains `manifest.json`.
5. Pin the extension from the puzzle-piece menu so its icon is always visible.

Chrome may show a "Disable developer mode extensions" notice at start-up. That is normal for unpacked extensions; dismiss it.

## 4. Connect the browser to the dashboard

1. Dashboard → **Devices** → name the device → **Generate pairing code**. A code like `K7Q2-M9XD` appears with a 15-minute countdown. It works once.
2. Click the extension icon. Enter the server address (skipped if you built with `--server`) and the code, then **Connect**.
3. Chrome asks permission to contact that one server address. Accept.
4. The popup shows **Connected Successfully** and the device appears in the dashboard as **Online**.

If you ticked *Require my approval* when generating the code, the popup instead shows **Waiting for approval** with a confirmation code. Check that it matches the one on the device card, then click **Approve device**.

**Check it end to end** (about two minutes): watch a YouTube video for a minute and pause it; open Dashboard → History and confirm the session appears with the device's name. In the popup click **Delete session** → **Send request**; confirm the dashboard's **Session deletion requests** tab shows it; click **Deny** and confirm the popup says it was denied and stays connected. Then repeat and **Approve**, and confirm the popup returns to *Not connected* with the notice that the session was deleted.

## The extension's pages

| Where | What it is |
|---|---|
| Toolbar popup | Pair with a code, connection status, the **Track watch time** pause switch, ask the admin to delete your session. |
| Settings | Read-only status: tracking, connection, sync, current configuration (managed values are labelled), device and version. |
| Device info | Read-only: installation ID, version, browser/OS, connection, tracking, pairing, last activity and sync, storage, diagnostics log. |
| Dashboard | Your local history and charts, and **Your data**: export or delete it. |

Settings and Device info cannot change anything. What the administrator can change from the web dashboard is described in [`ADMIN_DASHBOARD.md`](ADMIN_DASHBOARD.md#device-configuration-server-managed-settings).

## What gets installed, and the permissions it asks for

| Permission | Why |
|---|---|
| `storage` | Settings, the pairing credential and the sync state (`chrome.storage.local`); history is in IndexedDB. |
| `alarms` | A 5-minute sync timer and a 1-minute check that brings the live connection back. |
| host `https://www.youtube.com/*` | Run the tracker on YouTube only. |
| optional hosts | **Not granted at install.** Chrome asks for the single server address you pair with. |

This version adds **no new permissions**. The new `minimum_chrome_version` of 116 is not a permission: it exists because a service worker with an open WebSocket is only kept alive from Chrome 116.

## Uninstalling

Remove the extension at `chrome://extensions`. To disconnect first, ask the admin to revoke the device (or approve your session-deletion request). Data already uploaded stays on the server until the owner deletes it (dashboard → Data & backups, or Devices → Remove device).
