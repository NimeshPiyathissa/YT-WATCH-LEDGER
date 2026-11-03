# Known issues and incomplete work

Last reviewed for extension/server version 0.7.0.

## 1. Remote `resume_tracking` can override the user's pause (known conflict, kept by decision)

The server can still queue a `resume_tracking` command. When the extension next syncs (or immediately, over its live connection) it sets tracking back on, even if the person at the device had paused it. That conflicts with the principle that tracking should never be re-enabled without the user's consent. The owner chose to keep the command as it is.

What is in place instead: it is never silent. The popup shows a banner (*"Tracking was resumed by your administrator"*), Settings lists it under *Administrator activity*, the popup's pause switch is always available to turn it off again, and the action is in the server's audit log. Server-managed configuration (retention, sync interval) deliberately contains **no** tracking setting.

**To remove the conflict**, delete `resume_tracking` from `COMMANDS` in `server/src/lib/helpers.js` and `lib/sync.js` (and its dashboard button and tests); the user then resumes tracking only from the popup. The older `pause_tracking`, `set_retention`, `delete_all` and `delete_range` commands remain; `delete_all` and `delete_range` remove history stored on the device, visible on the device the same way.

## 2. The Admin console's Unpair button (former bug, resolved in 0.6.0)

In 0.5.0 the Admin console's *Unpair* button called `S.unenroll()`, which had been removed, so a second click threw an error and nothing happened. During development an attempt to repair it was interrupted by the assistant tooling's automated safety check and left unchanged by decision; no restriction in the application caused it.

In 0.6.0 the Admin console was replaced by the read-only **Device information** page, so the button and its call no longer exist. A session is ended by the person at the device *asking* (popup → **Delete session**, which files a request) and the admin approving it, or by the admin revoking it. No local "unpair without the admin" was added. An older extension (0.4 or earlier) calling `/api/sync/unenroll` still only files a request.

## 3. Not yet verified by hand

The automated tests (95 + 37 extension tests, 134 server tests) cover the API, the real-time channels, the real extension sync code running against the real server, and the build. They do **not** cover:

- how the **Devices page, Configuration panel, popup, Settings page, Device information page and Your data card** look and behave in Chrome (no browser run on the development machine, which was out of memory);
- loading the built ZIP with *Load unpacked*;
- the permission prompt shown while pairing from the popup (Chrome may close the popup; the draft-restore workaround is untested);
- the HTTPS / reverse-proxy path, including WebSocket and event-stream pass-through.

Run the check in [`INSTALL.md`](INSTALL.md#4-connect-the-browser-to-the-dashboard) before depending on it, and report anything off.

## 3b. Video Details (0.7.0): limits and decisions

- **Not yet verified on a real YouTube player by hand.** The recorder is tested against a scripted player and the page against a real browser with synthetic events; the checks that need a real player (ads, Shorts, scrubbing, throttled background tabs, crash recovery) are in [`MANUAL_TEST_CHECKLIST_VIDEO_DETAILS.md`](MANUAL_TEST_CHECKLIST_VIDEO_DETAILS.md).
- **Timing is not sub-second.** Event times are the browser's clock at the instant the player fired the event; upload latency, background-tab throttling and service-worker suspension limit how fresh the page can be. Nothing claims better.
- **Older history has no events.** Sessions from before 0.7 show *Summary only*. Nothing is reconstructed.
- **Interrupted viewings are approximate by design.** A closed browser leaves the end unknown: the pause is *unresolved* ("at least N") and active time stops at the last heartbeat (written about every 5 s, a viewing is considered gone after 3 minutes without one).
- **Rewatch time is approximate** (replayed content ÷ speed). Unique content is exact to the player's reported positions.
- **Pause #N numbering is per viewing** in the timeline and global in the pause table.
- **Behaviour changes:** a pause ends the viewing after 30 minutes (was 5); a finished video keeps its viewing open for 2 minutes so a replay is recognised; the content script ticks every 5 s instead of every second.
- **Display time zone is fixed** to Sri Lanka time (`Asia/Colombo`): there is no per-user zone setting. CSV/JSON keep the UTC instant next to the SLST text so other tools can convert.
- **PDF export** is a print-ready page you save as PDF from the browser (no PDF library).
- **A device that is offline** holds its events and shows `DEVICE OFFLINE`; the page cannot see events that have not been delivered yet.
- **The event stream per viewing is capped at 5000**; the page shows the latest 2000 events of a video and says when more exist (export has up to 20000).
- Mobile layout, keyboard use and reduced-motion were reviewed in CSS and a desktop browser, not on a phone.

## 4. Other limits

- **No stable extension ID** is configured (no key was available). Unpacked installs get an ID from their folder path; see [`EXTENSION.md`](EXTENSION.md#setting-up-a-stable-extension-id-optional-recommended-before-sharing-builds).
- **Developer-mode install only.** No Chrome Web Store package or signed CRX.
- **Single node.** Live connections are held in one server process.
- **Pairing lockout is in memory** and resets on restart; the per-hour rate limit is separate.
- **Deleting a session does not delete its uploaded history**; use Data & backups or Remove device.
- **After a session ends**, the extension keeps the browser permission to contact the server address until you remove it at `chrome://extensions` → Details → Site access.
- **Migration 004 is one-way** (see [`INSTALL.md`](INSTALL.md#1-run-the-server)): back up before upgrading.
- Existing limits from earlier versions still apply (see README, *Limitations*).
