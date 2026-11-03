# Video Details and playback analytics (v0.7.0)

Every video the extension records has a **Video Details** page in the dashboard (`#/video/<videoId>`, opened from **Videos** in the sidebar or **History → a session → Open Video Details**). It shows an event-level history of each viewing: every pause, resume, seek, buffering interval, completion, tab switch and viewing end, with exact timestamps, plus live status, analytics and export.

Design record: [`superpowers/specs/2026-11-03-video-details-design.md`](superpowers/specs/2026-11-03-video-details-design.md).

## What is recorded (and what is not)

Per event: id, video id, viewing (session) id, device, type, UTC timestamp (ms), playback position, playback speed, previous and new state, and a few whitelisted details (reason, jump-from position, buffering length). **No title, channel, URL or page content is in an event.** Event payloads are encrypted at rest like sessions; only ids, type and timestamps are in the clear so they can be ordered and filtered.

Types: `VIDEO_STARTED`, `VIDEO_PLAYING` (only a playback-speed change), `VIDEO_PAUSED`, `VIDEO_RESUMED`, `VIDEO_SEEKED`, `VIDEO_BUFFERING_STARTED`, `VIDEO_BUFFERING_ENDED`, `VIDEO_COMPLETED`, `VIDEO_REPLAYED`, `VIDEO_TAB_HIDDEN`, `VIDEO_TAB_VISIBLE`, `VIDEO_SESSION_ENDED`, `VIDEO_SESSION_INTERRUPTED`.

**Consent and privacy are unchanged.** No event is created while *Track watch time* is off or *Collect watch detail* is off; when either is switched off mid-viewing the stream stops at once and only the closing marker is kept. Turning detail collection back on never starts an event stream in the middle of a viewing, and nothing here re-enables tracking. Sessions recorded before 0.7 (or with detail off) have **no event history**: they appear as *Summary only* and nothing is back-filled or invented.

## How events are captured

The content script listens to the player's own events (`play`, `pause`, `seeking`, `seeked`, `waiting`, `playing`, `ratechange`, `ended`) plus tab visibility and YouTube's navigation events, and records a pause or resume at the instant it happens. A **5-second fallback tick** only notices a state change whose event was missed (marked `reason: reconcile`), keeps the heartbeat used to recognise a crash, and credits watch time; it never duplicates an event because the recorder only emits when the player state really differs from the recorded one. Buffering shorter than 400 ms is ignored. Ads are not playback: an ad break is a pause-like marker that is excluded from pause counts and paused time.

Events are stored in IndexedDB and queued in the same transaction while the device is paired. A pause, resume, seek, completion or viewing end is uploaded about **one second** later (a debounced fast path, `POST /api/sync/events`); other events within about five seconds. Offline, the queue keeps order and is retried with back-off, on every reconnect and every minute; an id is removed from the queue only when the server acknowledges it, and the server stores an id once, so retries never duplicate. A pause longer than 30 minutes ends the viewing (the pause is kept, closed at that end time). After the video ends the viewing stays open for two minutes so a replay is `VIDEO_REPLAYED`.

**Crash / shutdown:** the content script stores the recorder state every ~5 s. If the browser or tab vanishes, the next service-worker start (or the next viewing) closes that viewing with `VIDEO_SESSION_INTERRUPTED` stamped with the **last heartbeat, never "now"**. An open pause becomes **unresolved** (shown as "at least N" with no end time). Active time stops at the heartbeat and is flagged uncertain.

## How the numbers are calculated

All metrics are one pure function of the events (`lib/playback.js` `fold`, shared by the extension, server and page), so late or re-ordered delivery converges to the same result.

| Metric | Rule |
|---|---|
| Active watch time | Real elapsed time in state *playing*. Background-tab playback counts. Paused, buffering and ad time never do. Speed does not change it (see unique content). |
| Total paused time | Sum of **completed** pauses (closed by a resume, the viewing's end, or an ad break). Current pause is shown separately and ticks live. Unresolved pauses are listed separately as "at least". |
| Buffering / ad time | Wall-clock time in those states. |
| Elapsed | Viewing start to end (or last event while open; for an interrupted viewing, to the last confirmed activity — flagged). |
| Time to complete | Completion timestamp − viewing start, interruptions included. |
| Progress % | Furthest position ÷ duration. |
| Unique content | Union of the video ranges actually played, from the player's own positions at each run's start and end — speed changes and seeks are handled without assuming a rate; skipped content is never counted. |
| Rewatch time | Content already in the union when played again, ÷ speed. Approximate. |

Reaching 100% does **not** prove everything was watched: the page shows *unique content* and a coverage strip next to *progress*. A position span larger than wall time × speed allows is capped and flagged `implausible_span`.

## Time zones

Stored in UTC. The page shows them in the zone chosen in the header (default: the browser's; remembered). Exact date and time to the second in lists, milliseconds in an event's expanded view. Date and time-of-day filters are read in the selected zone (daylight saving handled). A device whose clock is wrong is corrected with the offset measured at upload (the same mechanism as sessions); durations always come from the device's own single clock. Sub-second accuracy is **not** claimed: delivery latency, browser throttling of background tabs and suspension all limit it, and the page says "confirmed" only for what the server has stored.

## The page

A header (thumbnail, title, channel, URL, duration, status, completion badge, connection indicator); a full information grid; live statistic cards; filters (date, time, device, viewing, event type, completion status); the activity timeline (newest first, expandable events, up to 300 shown at a time of the latest 2000); pause/resume table with count, total, average, longest and shortest; viewing history with expandable per-viewing timelines; five charts from recorded data (watch activity, playback progress, pause distribution, time breakdown, session comparison).

**Live status:** `LIVE WATCHING`, `PAUSED — hh:mm:ss`, `BUFFERING`, `AD PLAYING`, `COMPLETED`, `DEVICE OFFLINE` (the device has no real-time connection; timers freeze, nothing is extrapolated). **Connection indicator:** `LIVE` (event stream open), `SYNCING` (loading or catching up), `RECONNECTING`, `OFFLINE` (this browser is offline), with the last successful sync time. The page adds each server-confirmed event to the timeline as soon as the server stores it, re-folds the viewing, and ticks timers locally twice a second; it reconnects automatically (back-off up to 15 s) and re-reads everything after a drop. Events a device records while offline appear when it reconnects.

## Export

*Export* offers events CSV, pauses CSV, viewings CSV, a complete JSON, and a print-ready report (**Save as PDF** from the browser's print dialog; no PDF library is bundled). The active filters and time zone apply. CSV cells that start with `= + - @` are neutralised. Every export is recorded in the audit log.

## API (owner session cookie; every query is scoped to the owner's own devices)

`GET /api/videos`, `GET /api/video/:videoId` (details, totals, live), `/live`, `/events`, `/sessions`, `/pauses`, `/analytics`, `/export?format=csv|json|print&scope=events|pauses|sessions`. Filters: `device`, `session`, `from`, `to` (ms), `type` (comma list), `completed=yes|no`, `tz`, `limit` (≤ 2000), `offset`, `order`. Unknown video or someone else's device → `404`. Device side: `POST /api/sync/events` (≤ 200 events, idempotent, validated, ≤ 5000 per viewing, 240 requests/minute). Live: the existing `/api/events` stream carries `video_event` plus presence events.

## Database (migration `006_video_events.sql`, additive)

`video_playback_events`, `video_sessions`, `video_pause_intervals`, `video_watch_segments`, `video_analytics`, and `devices.last_events_at`. Nothing existing is altered or rewritten. The derived tables can be rebuilt from the events. Retention and *Delete server data* also remove the event history of the affected sessions. Backups include everything (it is one SQLite file). The IndexedDB schema moves from v3 to v4 additively on the device.

## Behaviour changes to be aware of

- Watch-time snapshots are now stepped by player events plus the 5-second tick (was a 1-second poll) with a media-position cap, so a sleeping laptop cannot credit the sleep.
- A paused viewing now ends after **30 minutes** (was 5), so long pauses stay in one viewing.
- After a video ends, the viewing stays open for 2 minutes (was: ended immediately).
- A viewing left without an end (crash) is closed at its last heartbeat, which also gives the History row an end time.
- Sessions snapshots may carry a validated channel link (`channelUrl`, `channelId`).
