# Manual test checklist: the Chrome extension (v0.8.0)

`server/test/ext-e2e.test.js` already drives a **real Chrome** with the **built extension**, a throwaway local server and **real YouTube** (see [Automated real-Chrome test](#automated-real-chrome-test)). This list is only for what a script cannot do. Use a separate Chrome profile and a throwaway server (see [MANUAL_TEST_CHECKLIST.md](MANUAL_TEST_CHECKLIST.md), Part C); never your real YouTube profile or your real server.

## What the automated test already covers
Extension loads without manifest errors, the service worker runs, pairing with a one-time code (single use), popup state and the live-viewing switch (with its confirmation), real YouTube playback (pause, resume, a short seek, a long seek that stalls), upload to the server with correct watch time, a server outage with queueing and delivery afterwards, and a revoke that unpairs the device but keeps local history.

## What only a person can check
- [ ] **Install the real way.** `chrome://extensions` -> Developer mode -> Load unpacked -> the extracted ZIP. No red *Errors* button. (The automated test loads it through the DevTools protocol.)
- [ ] **Permission prompt.** When pairing with an `https://` server, Chrome asks for permission to contact that server. Allow it; pairing continues. Decline it; the popup says so and nothing is paired. (The automated test pre-grants the local address, because a script cannot answer the prompt.)
- [ ] **Toolbar.** The icon is visible, the popup opens at a readable size, and the badge reads **LIVE** only while live viewing is on.
- [ ] **Ads.** On a video that starts with an ad, the ad time is not counted as watch time (Video Details shows it as ad time).
- [ ] **Shorts.** Scroll through three Shorts; each is a separate viewing.
- [ ] **Two tabs.** Play a video in one tab and open another YouTube tab; only the playing one is recorded.
- [ ] **Browser restart.** Close Chrome in the middle of a viewing and reopen it; within a few minutes the interrupted viewing is closed (it shows as *interrupted*, not as still playing).
- [ ] **Sleep / lid close.** Close the laptop lid during a viewing; the time asleep is not counted.
- [ ] **Real domain.** Pair with the real HTTPS server only when you are ready to use it for real, and repeat *pairing, a short viewing, revoke* once.

## Automated real-Chrome test
```bash
cd server
WL_EXT_E2E=1 node --test test/ext-e2e.test.js        # about 1.5 minutes; needs Chrome and the internet
```
- Everything runs in a **temporary Chrome profile** and a temporary database with a made-up owner; nothing of yours is touched or installed.
- Chrome 137 and later ignore `--load-extension`, so the harness (`scripts/lib/chrome-ext.mjs`) loads the extension with the DevTools command `Extensions.loadUnpacked`. It copies the build to a temporary folder and adds `http://127.0.0.1/*` to `host_permissions` there (the one difference from the shipped manifest; see the permission prompt above).
- If YouTube refuses to play in the automated browser the playback steps are reported **BLOCKED**, not passed; use this checklist for them. Another public video can be chosen with `WL_E2E_VIDEO=<id>`.
- Steps that behaved differently from run to run are reported as **WARN** with the reason, so they are visible rather than hidden.
