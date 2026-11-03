# Manual browser test checklist: Video Details (v0.7.0)

Automated tests cover the logic (extension recorder against a fake player, sync/offline queue against the real server, migration, APIs, authorization, charts). These checks need a **real YouTube player and a real browser**. Use a throwaway database and a throwaway `MASTER_KEY` (see [`MANUAL_TEST_CHECKLIST.md`](MANUAL_TEST_CHECKLIST.md) Part C), never your real data.

Setup: build (`node tools/build-extension.mjs`), load `dist\extension` unpacked, run the throwaway server, pair a browser profile with a code from **Devices**, open the dashboard in a second window on `#/videos`.

## 1. Recording

- [ ] Play a normal video (no ad). A **Videos** row appears within ~10 s; open it. Status shows **LIVE WATCHING**, indicator **LIVE**.
- [ ] Pause the player. Within ~2 s the status becomes **PAUSED — 00:00:0x** and the timer counts up. A *Pause #1* item appears with the date, time and position.
- [ ] Resume. The timeline shows *Resume #1 … after N seconds paused*; the paused total updates; the timers resume.
- [ ] Repeat pause/resume **10 times** (vary the lengths). Ten pause and ten resume items; the table lists ten rows with the right durations.
- [ ] Seek forward 2 minutes: one *Seeked* item ("Jumped from … to …"). Active time did not jump; the coverage strip shows the gap.
- [ ] Change speed to 2×: a *Playback speed changed* item.
- [ ] Throttle the network in DevTools (Slow 3G) and seek: *Buffering started/ended* appear only for stalls over ~0.4 s.
- [ ] Switch to another tab for a minute, then back: *Tab hidden / Tab visible*; the video kept counting as active time while in the background.
- [ ] Let an ad play (a video that has ads): no *Paused/Resumed* noise, the ad time is not in active time.
- [ ] Let the video finish: *Completed* item, **COMPLETED** status, completion timestamp in the info grid. Press replay within two minutes: *Replayed*.
- [ ] Open another video from the sidebar (SPA navigation): the first viewing ends (*Viewing ended*, reason navigated away) and a new one starts. Also try a **Short**.

## 2. Live updates

- [ ] With the details page open (do not refresh), every action above appears without a refresh, newest first; the new item flashes briefly.
- [ ] Close the player tab: after the device's connection drops the status becomes **DEVICE OFFLINE** and timers stop (they must not keep counting).
- [ ] Stop the server for 20 s then restart it: the indicator goes **RECONNECTING**, then **SYNCING**, then **LIVE**, and the page catches up without a reload.
- [ ] Put the *dashboard* browser offline (DevTools → Offline): indicator **OFFLINE**; back online → it recovers.
- [ ] **Device offline queue:** disconnect the recording laptop from the network, pause/resume a few times, reconnect. The events appear on the page in the right order, once each (no duplicates), with their original times.

## 3. Crash / shutdown

- [ ] While **paused**, kill the browser from Task Manager. Start the browser again, wait ~1–2 minutes. The viewing shows **Interrupted**, the pause shows **Unresolved** with "at least …" and **no invented end time**.
- [ ] Same while **playing**: the viewing is interrupted at its last confirmed time, flagged uncertain.

## 4. Consent and privacy

- [ ] Popup → turn *Track watch time* off mid-viewing: the viewing ends; nothing further appears. Turn it on: a new viewing starts only when playback does.
- [ ] Turn *Collect watch detail* off: watch time still records, **no** events appear for new viewings.
- [ ] A remotely paused device (owner command) records nothing, and nothing re-enables it by itself.

## 5. Page features

- [ ] Time zone selector: change it; every date and time changes consistently (spot-check with a known offset). Reload: the choice is remembered.
- [ ] Filters: a date range, time-of-day range, device, viewing, event types (e.g. only Paused) and completion status each narrow the timeline, table, sessions and charts; the filter count badge updates; *Clear* resets.
- [ ] Expand a timeline item and a viewing; both show details (event id, UTC and local time with milliseconds, position, speed, state change, "confirmed and stored").
- [ ] A viewing recorded before 0.7 is labelled **Summary only** with no timeline.
- [ ] Charts: five charts with real data; hover shows values; the progress chart's viewing selector works.
- [ ] Export: events/pauses/viewings CSV (open in a spreadsheet: times in the chosen zone, a title starting with `=` is shown literally), JSON, and **Report for PDF** (print dialog → Save as PDF; the report has the summary, pauses, viewings and events).
- [ ] Keyboard only: Tab reaches filters, timeline items (Enter/Space expands), export menu; focus rings are visible. Turn on *Reduce motion* in the OS: pulsing and bump animations stop.
- [ ] **Phone layout** (DevTools device toolbar ≈ 390 px wide): single column, no horizontal page scroll, the pause table becomes labelled rows, the timeline stays readable.

## 6. Performance (4 GB laptop)

- [ ] In Chrome Task Manager (Shift+Esc), play a video for 10 minutes with the details page open in another tab: the YouTube tab and the extension's service worker stay at ~0% CPU while playing; the dashboard tab stays under ~150 MB with ~500 timeline events.
- [ ] No console errors on the dashboard or the YouTube tab (extension content script).

## Authorization (from the browser)

- [ ] Signed out, open `…/api/video/<id>` and `…/#/video/<id>`: redirected to sign-in / `401`.
- [ ] A bogus id (`#/video/nope`) shows "No such video", not an error trace.
