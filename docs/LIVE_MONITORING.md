# Live viewing, consent and transparency

Watch Ledger is built so that the person at a device always knows what is being shared and decides the most sensitive part: whether the owner may see **what is playing right now**.

## The rule

| | Live viewing **off** (the default) | Live viewing **on** |
|---|---|---|
| Who decides | The person at the device, in the extension popup. The owner has no control that changes it. | The same person, any time. |
| What the owner sees | History after each sync (every few minutes, or when a viewing ends): the viewings, the timeline, the totals. | Also what is playing right now: LIVE WATCHING / PAUSED / BUFFERING, and events arriving within seconds. |
| How the extension behaves | Events and running viewings upload on the regular sync schedule. A viewing that ends uploads after a few seconds. | Pause, resume, seek and similar events upload within about a second. |
| What the person at the device sees | The popup says "Live viewing is off". | The popup says **Live viewing is ON** and names the server; the toolbar badge says **LIVE** on the tab that is playing; hovering the icon explains it. |
| What the dashboard shows | Video Details says **LIVE VIEW OFF**; the Devices list says "Live viewing: Off". | A purple **Live viewing ON** chip on the device card and in the Device Control Center. |

History that has already been uploaded stays visible either way: live viewing controls *real-time* and *current state*, not what was recorded earlier.

## Turning it on and off

In the extension popup (only when the device is paired and approved): switch **Live viewing** on, read the explanation, and press **Turn on**. Turning it off needs no confirmation. The choice is reported to the server with the device's next upload (immediately, when you switch it) and recorded in the audit log as "Live viewing turned ON/OFF by the person at the device".

A new pairing always starts with live viewing **off**: the consent belongs to one pairing, not to the browser.

## What the server enforces

The server does not trust the dashboard to hide things. With live viewing off for a device:

- no real-time `video_event` message is sent to the owner's open pages for that device;
- `GET /api/video/:id/live` returns no current state for it (`liveView: false`, no session);
- the video page's device list says `liveView: false`.

Tests: `server/test/migration-007.test.js` ("live viewing is gated", "the owner cannot switch a device's consent", "a device can only ever report its own state").

## Other states the device reports

The same upload carries the other privacy switches, so the owner can see them but never change them: **Tracking** (on or paused) and **Collect watch detail** (on or off). They appear under *Device → Device Control Center → Permissions*. A device whose extension is older than v0.8 reports none of this; it shows "Not reported" and is treated as **not** having allowed live viewing.

## Known limitation

The owner can still send a `resume_tracking` command that turns tracking back on after the person at the device paused it. It is visible on the device and audited, but it conflicts with the principle that tracking is the device user's choice. It was kept by decision; see [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for how to remove it.
