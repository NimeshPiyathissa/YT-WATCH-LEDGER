# Manual test checklist: Chrome extension v0.7.0

Purpose: confirm by hand what the automated tests cannot (how the screens look and behave in a real Chrome). Tick each box; note anything that differs from "Expected".

**Legend.** **[OFFLINE]** needs no server and can be done with the network off. **[BACKEND]** needs a running server, which is the only part that uses significant memory.

**Safety rules for this checklist**
- Use a **separate Chrome profile** (Chrome → profile icon → *Add*), so your real YouTube history, settings and any real pairing are never touched.
- Use a **throwaway local server and database** (Part C), never your real server. Everything below only affects that throwaway database.
- Run **one** server process at a time. Close other heavy programs first on a low-memory PC.
- The old **Admin console** and its Unpair button no longer exist (replaced by the read-only **Device info** page in 0.6.0, see [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md)). Settings and Device info have no controls: if you find one that changes anything, that is a bug.

---

## Part A: Install the package **[OFFLINE]**

### A1. Check the ZIP
- [ ] The file exists: `dist\yt-watch-tracker-v0.7.0.zip` (about 140 KB), next to `yt-watch-tracker-v0.7.0.zip.sha256`.
- [ ] Verify its checksum (PowerShell):
  ```powershell
  cd "C:\YT VIDEO TRACKER\yt-watch-tracker\dist"
  (Get-FileHash .\yt-watch-tracker-v0.7.0.zip -Algorithm SHA256).Hash.ToLower()
  Get-Content .\yt-watch-tracker-v0.7.0.zip.sha256
  ```
  Expected: the two hashes are identical. (If you rebuilt since, the `.sha256` file is the reference.)

### A2. Extract
- [ ] Pick a **permanent** folder in the **test** setup, for example `C:\Tools\yt-test\`. Not Downloads or Temp, and don't move it later: for an unpacked extension Chrome derives the extension ID from this path.
- [ ] Extract: right-click the ZIP → *Extract All…* → that folder, **or**
  ```powershell
  Expand-Archive -Path "C:\YT VIDEO TRACKER\yt-watch-tracker\dist\yt-watch-tracker-v0.7.0.zip" -DestinationPath "C:\Tools\yt-test"
  ```
- [ ] `C:\Tools\yt-test\manifest.json` exists **directly** in that folder (not inside an extra subfolder), alongside `background.js`, `popup\`, `lib\`, `icons\`.
- [ ] There is **no** `server`, `docs`, `tests`, `.env` or `.db` file in the folder.

### A3. Load in Chrome (Developer mode)
- [ ] Switch to your **test profile**. Open `chrome://extensions`.
- [ ] Turn on **Developer mode** (top right).
- [ ] Click **Load unpacked** and choose `C:\Tools\yt-test` (the folder that contains `manifest.json`).
- [ ] Expected: a card named **YouTube Watch Tracker** appears with **no red "Errors" button** and no "Failed to load" message. (A "Disable developer mode extensions" notice at the next Chrome start is normal.)
- [ ] If it will not load, note the exact message: "Manifest file is missing" means the wrong folder; "requires Chrome 116" means update Chrome.

### A4. Check version, icon and permissions
- [ ] The card shows **Version 0.7.0**.
- [ ] Click **Details**: *Permissions* lists only reading/changing data on `www.youtube.com` (and storage is implicit). No "all sites" access is granted at install. Note the **ID** (32 letters); it will change if you reload from a different folder.
- [ ] Open a new tab to `chrome-extension://<the ID>/manifest.json`. Expected: `"manifest_version": 3`, `"version": "0.7.0"`, `"minimum_chrome_version": "116"`, `permissions` = `storage`, `alarms`, and **no** `"key"` field.
- [ ] The toolbar icon (pin it via the puzzle-piece menu) is a **verdigris rounded square with three white bars**, crisp at toolbar size; the card in `chrome://extensions` shows the larger version of the same mark.

---

## Part B: Popup and extension pages, offline **[OFFLINE]**

Turn off Wi-Fi or just don't start a server.

### B1. Open the popup
- [ ] Click the toolbar icon. The popup opens about 360 px wide, no horizontal scrollbar, no cut-off content.
- [ ] Header: **Watch Tracker** with the mark, and a pill reading **Tracking on**.
- [ ] A **Not connected** card with *Server address* and *Pairing code* fields and a **Connect** button; the note says nothing is sent before you pair.
- [ ] Two tiles **Today** and **Last 7 days** (values like `0s` on a fresh profile).
- [ ] Buttons **Open dashboard**, **Settings**, **Device info**; footer reads **Version 0.7.0**.
- [ ] A **Track watch time** switch (on). Turn it **off**: the pill changes to *Tracking paused* and the hint says nothing is being recorded; turn it on again. This is the user's own pause control and must always work.
- [ ] Switch your OS between light and dark: the popup follows it and stays readable (there is no theme selector any more).

### B2. Form validation (these errors appear before any network call)
- [ ] Leave both fields empty, click **Connect** → red message *Enter a valid https:// server address.*
- [ ] Server `http://example.com`, any code → same message (plain http is refused except localhost).
- [ ] Server `https://tracker.example.com`, code `ABC` → *Enter the 8-character pairing code from the dashboard.*
- [ ] Type `abcd efgh` in the code field and click **Connect** with a valid-looking server: nothing is lost on screen (the code is normalised to `ABCD-EFGH`).

### B3. The other pages open
- [ ] **Settings** opens in a tab and is **read-only**: cards for *Tracking*, *Server connection*, *Synchronization*, *Current configuration* (each value tagged *Local*) and *This device*; no switches, selects, buttons that change anything, or password section. A note says the page cannot stop you pausing, deleting or uninstalling.
- [ ] **Device info** opens and is read-only: *This installation* (installation ID, version 0.7.0, browser/OS), *Status*, *Activity* (last activity, last sync, videos, sessions, storage used), and a **Diagnostics** log with only a **Copy log** button (no Clear).
- [ ] On the local **Dashboard**, scroll to **Your data**: **Export all (JSON)** downloads a file; **Delete date range…**, **Delete channel…** and **Delete all** each need a second click ("Click again…") before anything is removed. Cancel at the confirmation and check nothing was deleted.
- [ ] (Needs internet, but not the server.) Open the YouTube site with tracking on, watch a few seconds, and confirm Today/Last 7 days on the popup change and the video appears in the Dashboard history.
- [ ] **Open dashboard** (the local one) opens and renders.
- [ ] If an admin password is set, the pages ask for it.

### B4. Offline connection failure (optional, shows the permission prompt)
- [ ] Server `https://127.0.0.1:9` (nothing listens there), code `ABCD-EFGH`, **Connect**. Chrome asks for permission to contact that address: accept. Expected: red message *Could not reach the server.* and the popup remains usable.
- [ ] **Chrome may close the popup while the permission prompt is open.** Reopen it: the server and code you typed should be **refilled**. Note whether they were (this behaviour has not been tested before).

---

## Part C: Start the throwaway backend **[BACKEND]**

Do this once, from Git Bash. It is a local, loopback-only development server with its own empty database, and it does not touch any real data.

```bash
cd "/c/YT VIDEO TRACKER/yt-watch-tracker/server"
export MASTER_KEY="$(openssl rand -base64 32)"          # keep this shell open: a restart needs the same key
export COOKIE_SECRET="$(openssl rand -hex 32)"
export NODE_ENV=development BASE_URL=http://127.0.0.1:8443 CORS_ORIGIN=http://127.0.0.1:8443
export ACCESS_TTL=900 REFRESH_TTL=2592000 DB_PATH=./data/manual-test.db BACKUP_INTERVAL_HOURS=0
node scripts/create-owner.js tester@example.test         # type a throwaway password when asked (hidden)
node src/server.js
```

- [ ] If the hidden password prompt fails in Git Bash ("not a tty"), run that one command as `winpty node scripts/create-owner.js tester@example.test`, or run Part C from PowerShell (set the same variables with `$env:NAME="value"`). Don't pass the password on the command line.
- [ ] The server prints a line with `Server listening` (address `127.0.0.1:8443`) and no error. `data/` is git-ignored.
- [ ] In a browser (test profile) `http://127.0.0.1:8443/api/health` → `{"ok":true}`.
- [ ] To stop it later: press Ctrl+C in that window. To start clean again, delete `server/data/manual-test.db*`.

---

## Part D: Pairing UI **[BACKEND]**

### D1. Dashboard side
- [ ] Open `http://127.0.0.1:8443`, sign in as `tester@example.test` with the password you chose.
- [ ] Go to **Devices**. Expected: overview strip (0 online, 0 devices, 0 sessions, 0 requests), the **Pair a device** panel, four tabs (*Devices, Session deletion requests, Active sessions, Pairing history*), and an empty-state card *No devices yet*.
- [ ] The indicator beside the title says **Live** within a couple of seconds (if it says *Updating every few seconds*, the event stream is not connected: note it).
- [ ] Type a name (for example `Test PC`), leave *Require my approval* **unticked**, click **Generate pairing code**.
- [ ] Expected: a code like `K7Q2-M9XD` (8 characters, no `0 O 1 I L`), a **countdown** from about 15:00 running down once per second with a shrinking bar, **Copy code** and **Cancel code** buttons.
- [ ] **Copy code** → the toast says *Code copied.*

### D2. Extension side, normal pairing
- [ ] Popup → Server `http://127.0.0.1:8443`, Code = the code, **Connect**. Chrome asks to allow access to `127.0.0.1`: accept.
- [ ] Expected in the popup: green banner **Connected Successfully**, a **Connected** card (server, device `Test PC`, session id, *Channel* **Live** within a few seconds, last sync, pending uploads 0), and the pill/notes updated. Buttons **Sync** and **Delete session** are present.
- [ ] Expected in the dashboard **without reloading**: the code panel turns green **Connected** with the device name; the device card appears with **Online**, **Extension v0.7.0**, *Last active* "now", **1 active** session, channel **Live**; the overview shows 1 online / 1 device / 1 session; the **Active sessions** tab lists one row; **Pairing history** shows the code as *Used* with its mode *Connects at once*.
- [ ] Try the same (used) code again from the popup of a second profile, or watch the Pairing history: a reused code must be refused (*That code is invalid, expired or already used.*).

### D3. Code states
- [ ] Generate another code and **Cancel code**: **Pairing history** lists it as *Cancelled*, and entering it in the popup fails (*That code is invalid, expired or already used.*). **Known gap:** the code panel on the Devices page keeps showing that code with a running countdown after you cancel it, instead of switching to a cancelled state. Record whether you see this; it is cosmetic (the server has cancelled the code), and *Dismiss* clears the panel.
- [ ] Generate a code and let the countdown reach **0:00** (15 minutes; set `PAIRING_CODE_TTL_MIN=1` before starting the server to make this quick): the panel switches to **Expired**, and the code is refused.
- [ ] **Do not** enter wrong codes more than 4 times: the 5th wrong code locks your address out for 15 minutes (*Too many attempts*). If you want to see that message, do it on purpose last, then restart the server to clear it.

### D4. Approval-required pairing
- [ ] Disconnect first (see Part E, approving a deletion) or use a second test profile. In the dashboard tick **Require my approval**, generate a code, and enter it in the popup.
- [ ] Expected: popup banner *Waiting for the admin to approve this device* and a **Waiting for approval** card with a confirmation code like `5841-BB6A`; the dashboard shows an **Awaiting approval** card with the **same** code and **Approve device** / **Reject** buttons; nothing has uploaded (Pending uploads may grow, uploads 0).
- [ ] Click **Approve device**: the popup flips to **Connected** (and *Connected Successfully*) on its own within seconds; the card goes **Online**.

---

## Part E: Approval and denial, without touching real sessions **[BACKEND]**

Only the test pairing from Part D is involved. It is a throwaway session in a throwaway database.

### E1. Request
- [ ] Popup → **Delete session**. Expected: an inline question *Ask the admin to delete this session? It stays connected and keeps syncing until the admin approves.* with **Send request** and **Cancel**. **Cancel** closes it without sending anything.
- [ ] **Delete session** → **Send request**. Expected: banner **Waiting for Admin Approval** (with a spinner) and the button becomes a disabled **Waiting for Admin Approval**. The popup stays **Connected**; **Sync** still works.
- [ ] Dashboard (no reload): the **Session deletion requests** tab badge shows **1** (orange), the overview shows *1 waiting for your decision*, the sidebar badge on **Devices** shows 1, and the device card has a *Session deletion requested* notice. The table lists device name, a short **session id**, the request time, status **Pending**, and **Approve** / **Deny** buttons.

### E2. Deny
- [ ] Click **Deny** → a dialog *Deny this request?* (press **Esc** to confirm it cancels; focus returns to the button). Click **Deny** then **Deny request**.
- [ ] Expected: the request moves to *Decided* with status **Denied**; the device stays **Online**; the popup shows a red-toned *Your deletion request was denied. The session stays connected.* and **Delete session** is available again; syncing still works.

### E3. Approve
- [ ] Popup → **Delete session** → **Send request** again (a new request).
- [ ] Dashboard → **Approve** → dialog *Delete this session?* naming the device and session → **Approve and delete**.
- [ ] Expected: toast *Approved. The session was deleted and the device disconnected.*; the request shows **Approved**; the **Active sessions** tab no longer lists it; the device card shows **Disconnected** (0 active sessions).
- [ ] Expected in the popup within a few seconds (no manual action): back to the **Not connected** card with the notice *Session deleted: the admin approved your request. Nothing is being sent any more.* (dismiss with ×). Its history on the server remains.
- [ ] Pair again with a new code: the device record and its history come back (one device card, **2 pairings**), not a duplicate.

### E4. Revocation
- [ ] While connected, dashboard → **Active sessions** → **Revoke** → confirm. Expected: the popup becomes *Not connected* with *The owner revoked this device…* within seconds; the session disappears from the list.

### E5. Audit trail
- [ ] Dashboard → **Audit log** lists, in order: `pairing_code_created`, `pair_completed`, `session_deletion_requested`, `session_deletion_denied`, `session_deletion_requested`, `session_deletion_approved`, and (if done) `session_revoked`, with the device name.

---

## Part F: Inspect errors **[OFFLINE and BACKEND]**

- [ ] **Extension errors list:** `chrome://extensions` → the extension card → if an **Errors** button is shown, open it and copy anything listed. After all the steps above there should be none beyond the known Unpair `TypeError` if you pressed it.
- [ ] **Service worker console:** on the card click **service worker** (under *Inspect views*). In the Console look for red errors; during Part D you should see network requests to `127.0.0.1:8443` in the **Network** tab (`/api/device/token`, `/api/sync/push`, a **WS** connection to `/api/device/ws` with status **101**). If the worker shows *(inactive)* click the link again.
- [ ] **Popup console:** right-click the popup → **Inspect**. Check Console for errors while clicking through states (the popup closes when focus is lost; keep DevTools docked).
- [ ] **Dashboard console:** F12 on the dashboard tab → Console should be free of red errors, and **Network → Fetch/XHR** should show `/api/events` as an open request of type *eventsource* receiving events when you pair or request.
- [ ] **Diagnostics:** extension **Device info → Diagnostics** (and **Copy log**) should show `paired`, `sync ok`, `session deletion requested`, `unenrolled` with a reason, and no `error` rows. After Part G also `managed config applied`.
- [ ] **Server log:** the terminal running the server should show no stack traces (`unhandled`/`uncaught`).
- [ ] **Updates:** to test updating, change nothing in the code, rebuild (`node tools/build-extension.mjs`), extract **over the same folder**, click the reload icon on the card, and confirm the pairing and settings are **kept** and the Diagnostics log shows *extension updated*.

If anything fails, send: the step number, what you saw, the Errors list / console text, and the server log lines at that moment.

---

## Part G: Server-managed configuration and read-only status **[BACKEND]**

Needs a paired, connected test device (Part D) with the throwaway server running.

### G1. Set and apply
- [ ] Dashboard → **Devices** → the device card → **Controls**. A **Configuration** card is above *Controls* with *Keep history for* and *Sync every*, both on *Device's own setting*, a status of *Not managed*, and an empty history. The old "Retention on the device" row is gone.
- [ ] Choose **Keep history for = 30 days** and **Sync every = 15 minutes**, **Save changes**. Expected: toast *Saved. The device will apply it now.* (it is connected); the badge goes *Waiting for the device* then **Applied** by itself within seconds; history shows version 1 with both changes, by `tester@example.test`, result **Applied**; the message line says *Applied … (version 1)*.
- [ ] Audit log has `config_changed` (with the before/after) and `config_applied`.
- [ ] Extension **Settings** now shows *Keep history for: 30 days* and *Sync every: 15 minutes*, each tagged **Managed by administrator**, a *Managed* badge, and *Configuration version 1 · just now*. *Tracking* is still **Local**.
- [ ] Extension **Device info → Diagnostics** shows `managed config applied`.

### G2. Offline and failure behaviour
- [ ] Turn Wi-Fi off (or close Chrome), change **Keep history for** to 90 days in the dashboard, Save. Expected: badge **Waiting: device offline**, message says it applies when the device reconnects.
- [ ] Turn the network back on / reopen Chrome: within a minute (or after **Sync** in the popup) the badge becomes **Applied** and Settings shows 90 days.
- [ ] Choose *Device's own setting* for **Sync every** and Save: the card records the change, and after the device reports back Settings shows *Sync every: 5 minutes* tagged **Local**.
- [ ] Try saving without changing anything: toast *Nothing to change.* and no new history row.

### G3. Authorization, from the browser
- [ ] In a private window (not signed in) open `http://127.0.0.1:8443/api/devices/<a device id>/config`. Expected: `{"error":"unauthorized"}`. Same for `/api/session-requests` and `/api/events`.
- [ ] In the dashboard tab's DevTools console run `fetch("/api/devices/<id>/config",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({changes:{tracking_enabled:false}})}).then(r=>r.status)`. Expected: **400** (tracking is not a setting). With `{changes:{retention_days:99999}}` also **400**.
- [ ] Sign out, then repeat the first fetch: **401**.

### G4. The user stays in control
- [ ] With a managed value applied, turn **Track watch time** off in the popup: it stays off, the dashboard does not change it, and no configuration push turns it on.
- [ ] Dashboard → device **Controls** → **Resume tracking** (the older remote command) with tracking paused. Expected: the device resumes at the next sync **and** the popup shows a banner *Tracking was resumed by your administrator*, Settings shows *Administrator activity*, and the Audit log records it. (This is the known conflict in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md); the check is that it is never silent. The user can pause again with the switch.)
- [ ] The extension can still be disabled or removed from `chrome://extensions` at any time while configuration is managed.

---

## What needs a backend, at a glance

| Needs a running server | Works offline |
|---|---|
| Part C (starting it), Part D, Part E, Part G, the *Live* indicator, version shown on the device card, the Network checks in F, the *extension updated* check after reload (needs a pairing to be meaningful) | Part A (ZIP, extract, load, version, icon, permissions), Part B (popup layout and pause switch, validation, read-only Settings and Device info, Your data, offline error), the Errors list and service-worker console in F |

## Still not covered by any test

Behind a real HTTPS domain and reverse proxy (WebSocket and event-stream pass-through), and on any machine other than the one you test on.
