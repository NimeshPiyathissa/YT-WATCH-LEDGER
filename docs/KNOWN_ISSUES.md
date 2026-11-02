# Known issues and incomplete work

Last reviewed for extension/server version 0.5.0.

## 1. The Admin console's "Unpair" button does not work (bug, left unchanged)

**What happens.** In the extension's Admin console → Private sync, **Unpair** asks you to click twice. The second click runs `S.unenroll()` at `admin/admin.js:73`. That function was removed from `lib/sync.js` in this version, so the click throws an error in the page's console and **nothing else happens**: the device is not unpaired, no request is sent, the pairing stays active. Nothing is lost or corrupted.

**Why it exists.** Version 0.5.0 changed the rule that the person at a device can no longer end its own session; they can only *ask* (the popup's **Delete session** button, which sends a request that the admin approves or denies). The old `unenroll()` did the opposite (revoked the device on the spot), so it was removed from the sync client, but the Admin console button that called it was not updated.

**Decision.** Left unchanged on purpose. During development, an attempt to repair it was interrupted by the assistant tooling's automated safety check, and the owner chose not to retry it or work around it. No restriction in the application itself caused this.

**Workarounds today.**
- Use the popup's **Delete session**: it files a request, the popup shows *Waiting for Admin Approval*, and the admin decides.
- Or ask the admin to **Revoke access** / **Remove device** in the dashboard.
- Or remove the extension at `chrome://extensions` (the server keeps showing the device until you revoke it).

**Safe fix, when you decide to do it** (not applied):
1. In `admin/admin.js`, replace the `S.unenroll()` call with `S.requestSessionDeletion()` and relabel the button *Request session deletion*, with the same two-click confirmation.
2. Do **not** call `unenrollLocal` or remove the host permission at that point: the session must stay active until the admin approves. The sync client already clears the credentials and the upload queue when the server reports the session deleted or revoked.
3. Optionally remove the server's host permission at that moment (`chrome.permissions.remove`), which today is not done anywhere after a revocation either.
4. Show the request state (pending / denied) in the Private sync card, as the popup already does.

This keeps the admin's approval in the loop. Re-adding a local "unpair that works without the admin" would reverse the new rule and should be a deliberate decision.

The Admin console's *Private sync* card also still carries pre-0.5 wording (it describes owner approval as always required, and its "Paired" toast says "waiting for approval" even when the device connected at once). The popup is the up-to-date interface.

An older extension (0.4 or earlier) that calls `/api/sync/unenroll` no longer revokes itself on the server: the server turns that call into a deletion request for the admin.

## 2. Not yet verified by hand

The automated tests (95 + 37 extension tests, 134 server tests) cover the API, the real-time channels, the real extension sync code running against the real server, and the build. They do **not** cover:

- how the new **Devices page** and **popup** look and behave in Chrome (no browser run on the development machine, which was out of memory);
- loading the built ZIP with *Load unpacked*;
- the permission prompt shown while pairing from the popup (Chrome may close the popup; the draft-restore workaround is untested);
- the HTTPS / reverse-proxy path, including WebSocket and event-stream pass-through.

Run the check in [`INSTALL.md`](INSTALL.md#4-connect-the-browser-to-the-dashboard) before depending on it, and report anything off.

## 3. Other limits

- **No stable extension ID** is configured (no key was available). Unpacked installs get an ID from their folder path; see [`EXTENSION.md`](EXTENSION.md#setting-up-a-stable-extension-id-optional-recommended-before-sharing-builds).
- **Developer-mode install only.** No Chrome Web Store package or signed CRX.
- **Single node.** Live connections are held in one server process.
- **Pairing lockout is in memory** and resets on restart; the per-hour rate limit is separate.
- **Deleting a session does not delete its uploaded history**; use Data & backups or Remove device.
- **After a session ends**, the extension keeps the browser permission to contact the server address until you remove it at `chrome://extensions` → Details → Site access.
- **Migration 004 is one-way** (see [`INSTALL.md`](INSTALL.md#1-run-the-server)): back up before upgrading.
- Existing limits from earlier versions still apply (see README, *Limitations*).
