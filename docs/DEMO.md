# Local self-enrolled demo

A walkthrough you can run on your own machine, with your own browser, in about ten minutes. Everything stays on `127.0.0.1`, uses throwaway secrets and a temporary database, and is deleted when you stop it. It demonstrates the consent model: you are both the person being tracked and the admin.

## 0. Prerequisites

- Chrome (or another Chromium browser) and Node ≥ 20.
- `cd server && npm install` (once).

## 1. Start the demo server

```bash
cd server
node scripts/demo.js          # PORT=8451 node scripts/demo.js to use another port
```

It prints the dashboard address, a throwaway demo admin login, and a 15-minute enrollment code. Leave it running. (Press Enter for a fresh code; Ctrl+C stops the server and deletes the data.)

## 2. Load the extension and look at the local-only behaviour

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → select the `yt-watch-tracker` folder.
2. Open the popup. It says *"Tracking YouTube watch time on this device only."* No server is involved yet.
3. Play a YouTube video for a minute. The toolbar shows a red **REC** badge while it plays.
4. Popup → **Dashboard** shows today's time, the 14-day chart and the history. Popup → **Admin console** shows the live pill ("Tracking a video now"), the install id and the diagnostics log.

## 3. Enroll (the consent step)

1. Admin console → **Remote sync**. Read the consent text.
2. Enter the server address and the code from the terminal. Leave *"also upload history already recorded"* **unchecked** to see that only new activity is sent (check it to see the upload-history path).
3. Click **Enroll this device**. Chrome asks for permission to contact that one address; accept.
4. Observe what changed:
   - The popup and Settings now show **"Syncing YouTube watch data to 127.0.0.1:…"** permanently.
   - The Remote sync section shows the server, the last successful sync and any last remote command.
   - The extension now holds the permission for that origin only.

## 4. See the data arrive

1. Play another minute of video; within about 5–10 seconds the session is pushed (or click **Sync now**).
2. Open the dashboard address and sign in with the demo admin login. **Devices → My own browser** shows the totals, chart and history that match the local dashboard.
3. **Audit log** shows `register`, `login`, `enroll_code_created` and `enroll`.

## 5. Remote controls, and what the device owner sees

1. On the device page click **Pause tracking**. It appears under *Recent commands* as `pending`.
2. In the extension click **Sync now** (or wait ≤ ~5 min). The command becomes `acked / ok` on the dashboard; the Admin console shows *Last remote command: pause_tracking* and the tracking toggle is off; the diagnostics log records `remote command applied`.
3. Click **Resume tracking** and repeat. Then try **Set retention → 7 days**: after the device confirms, the server trims its own copy to the same window.
4. Try turning tracking back on yourself in the Admin console: the person at the device always has the last word locally.

## 6. Ending sync, from either side

- **Admin revokes:** dashboard → device → **Revoke access** (two clicks). On the next sync the extension drops its token, stops sending, and shows *"The server revoked this device. Nothing is being sent any more."* The popup note disappears.
- **User unenrolls:** re-enroll with a new code, then Admin console → **Unenroll** (two clicks). The server marks the device revoked and records `device_unenrolled`; the extension forgets the credentials and removes the host permission.
- **Delete server data:** dashboard → device → **Delete device and synced data**.

## 7. Clean up

Ctrl+C in the terminal: the server stops and the temporary database is deleted. Remove the extension from `chrome://extensions` if you no longer want it.

## What to look for (links to the write-up)

| You'll see | Design property |
|---|---|
| REC badge, "Syncing to …" note | Tracking and data egress are visible on the device (§4.1) |
| Permission prompt for one origin | Least privilege, opt-in network access (§4.2) |
| Pre-enrollment history not uploaded by default | Data minimisation at the consent boundary |
| Command pending → acked, shown on device | Remote control is auditable by both parties (§4.4) |
| Revoke/unenroll from either side | Consent is revocable by the tracked person (§4.1) |
