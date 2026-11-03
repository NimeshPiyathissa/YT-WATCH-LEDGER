# Video Details & Real-Time Playback Analytics (v0.7.0) — design

Status: approved by the owner on 2026-11-03. Branch: `feat/video-details` (from `feat/managed-config` @ v0.6.0).
Baseline before changes: server 157/157 tests pass, extension `tests/*.test.js` 3/3 pass.

## 1. Goals and non-goals

Goal: a per-video **Video Details** page in the owner dashboard backed by an event-level playback log: every pause, resume,
seek, buffering interval, completion, tab-visibility change and session end, with exact timestamps, accurate duration
metrics, live updates and export.

Non-goals: no change to pairing, device authorisation, `MASTER_KEY`, retention rules or the consent model; no back-filling of
event history for sessions recorded before 0.7 (they show "summary only"); no new runtime dependencies; no push/deploy.

## 2. Architecture

```
<video> events ─► content/tracker.js ─► lib/playback.js (Recorder) ─► VIDEO_EVENT msg ─► background.js
                       │ 5 s reconcile (fallback only)                      │ IndexedDB v4: events + evoutbox (atomic)
                                                                            ▼
                              lib/sync.js pushEvents ── POST /api/sync/events (idempotent, ≤200/req, ~1 s debounce)
                                                                            ▼
        server: validate ─► INSERT OR IGNORE video_playback_events ─► recompute touched sessions (fold) ─► derived tables
                                                                            └► hub.toAdmin("video_event") ─► SSE ─► Video Details page
```

Existing session snapshots (`/api/sync/push`, `sessions`, `videos`) are untouched: they keep producing the History and
Overview numbers. The event log is additive and joins to them by `(device_id, session_id)`.

## 3. Event model

Types (exactly the required set): VIDEO_STARTED, VIDEO_PLAYING, VIDEO_PAUSED, VIDEO_RESUMED, VIDEO_SEEKED,
VIDEO_BUFFERING_STARTED, VIDEO_BUFFERING_ENDED, VIDEO_COMPLETED, VIDEO_REPLAYED, VIDEO_TAB_HIDDEN, VIDEO_TAB_VISIBLE,
VIDEO_SESSION_ENDED, VIDEO_SESSION_INTERRUPTED.

Event: `{ id, videoId, sessionId, seq, type, ts, pos, rate, prev, next, meta }`; the server adds `deviceId` (from the
authenticated device, never from the payload).
- `id = "<sessionId>:e<seq>"` — stable, so re-sending is a no-op (`INSERT OR IGNORE`). `seq` is a per-session counter kept by the recorder.
- `ts`: device clock, UTC ms. The server stores `ts` and `ts_adj = ts + skew` (the same clock-offset measurement `/api/sync/push` already makes).
  Durations are always computed from device `ts` (one clock); `ts_adj` is for cross-device ordering and display.
- `pos`: playback position (s, 0.1 precision). `rate`: playback speed. `prev`/`next`: `none|playing|paused|buffering|ad|ended`.
- `meta` (whitelisted, bounded): `from` (position before a seek), `reason` (`user|ad_break|ad_break_end|recovered|navigation|pagehide|tracking_off|reconcile`), `dur` (buffering ms), `lastKnownTs`, `rateFrom`.
- Ad playback never produces play/pause noise: an ad break is `VIDEO_PAUSED{reason:ad_break}` … `VIDEO_RESUMED{reason:ad_break_end}`, state `ad`,
  excluded from pause counts and paused time (kept as `adMs`).
- `VIDEO_PLAYING` is emitted only for a playback-rate change while playing (`meta.rateFrom`) and for the first frame after a session starts if not already implied by STARTED; it is never emitted periodically.
- Buffering shorter than 400 ms is not recorded (debounced), the start keeps its original timestamp.
- Privacy gate: no events are created while `tracking_enabled === false` or `collect_detail === false`. Events carry no title, channel or URL.

## 4. Pure metrics engine (`lib/playback.js`, shared with the server as `playback.cjs` and the web as `vendor/playback.js`)

`fold(events, { now, live, duration })` → `{ sessionMetrics, pauses[], segments[], uncertain[] }` is a pure function of the ordered events
(sorted by `seq`), so late or out-of-order arrival converges to the same result.

| Metric | Rule |
|---|---|
| Active watch time | Wall-clock ms in state `playing`. Background-tab playback counts (the media element really plays). Paused, buffering and ad never count. |
| Paused time | Sum of **closed** pause intervals (+ the open one shown separately as *current pause*). |
| Buffering / ad time | Wall-clock ms in `buffering` / `ad`. |
| Elapsed | `endTs (or last event, or now if live) − startTs`. |
| Time to complete | `completedTs − startTs`, interruptions included. |
| Content range of a playing interval | `[start.pos, end.meta.from ?? end.pos]` — the player's own positions, so speed changes and seeks are handled without assuming rate. Implausible spans (> wall dt × 2× max rate + 2 s) are capped and flagged uncertain. |
| Unique content watched | Length of the union of all playing content ranges (no double counting). |
| Rewatch time | Content already in the union when replayed, ÷ rate → wall ms. Approximate; labelled as such. |
| Progress % | furthest position ÷ duration. Completed ≠ everything watched: `uniqueContent ÷ duration` is shown separately. |
| Seeks | Skipped content is never added to any range. |

Pause interval: opened by `VIDEO_PAUSED` (not ad), closed by `VIDEO_RESUMED` (`status: resumed`), by `VIDEO_SESSION_ENDED`
(`session_ended`, end = the recorded end timestamp), or **left unresolved** when the session was `INTERRUPTED`
(`unresolved`, `endTs: null`; the known lower bound `minDurationMs` is `lastKnownTs − pausedAt`, labelled "at least").
No timestamp is ever invented. If a session has no end event and the device is offline, the page freezes its timers at the
last event and shows DEVICE OFFLINE rather than extrapolating.

## 5. Extension capture

- Listeners on the main `<video>`: `play`, `pause`, `seeking`, `seeked`, `waiting`, `playing`, `ratechange`, `ended`; plus `visibilitychange`,
  `pagehide`, `yt-navigate-finish`. A MutationObserver is not used; the `<video>` element is re-resolved on navigation.
- `pause` and `play` are recorded at the instant the browser fires them (`Date.now()` at the handler). A `pause` immediately followed by `seeking` is
  YouTube's scrubbing behaviour: pauses with `video.seeking` true are not recorded as user pauses.
- Reconciliation tick: every 5 s (was 1 s) only while a session exists and the tab is visible (1 per 30 s hidden). It compares the player state with the recorder state
  and emits an event only on a real mismatch (`meta.reason: reconcile`); it also writes `last_heartbeat` (the `lastKnownTs` source).
  Watch-time snapshots (`accounting.js`) still integrate per tick, with the per-tick clamp scaled to the longer interval.
- Shutdown/crash: on service-worker or browser start, any local session without an end event gets `VIDEO_SESSION_INTERRUPTED` stamped with the last heartbeat (`meta.recovered`).
- Offline: events are written to IndexedDB (`events`, `evoutbox`) in one transaction and removed from the outbox only when the server acks that id. Order is by `(sessionId, seq)`; retry uses the existing backoff.
- Paired devices push events ~1 s after a pause/resume/seek/complete (debounced batch) and every 5 s otherwise; unpaired devices store events locally only (history stays on the device exactly like sessions).
- Memory: no per-tick allocation growth; events are small flat objects; the content script keeps only the current session's counters.

## 6. Database (migration `006_video_events.sql`, additive only)

- `video_playback_events(id PK, device_id, session_id, video_id, type, seq, ts, ts_adj, enc, received_at)` — `enc` = AES-GCM JSON `{pos,rate,prev,next,meta}`;
  UNIQUE `(device_id, id)`; indexes `(device_id, video_id, ts_adj)`, `(device_id, session_id, seq)`, `(device_id, type, ts_adj)`.
- `video_sessions(device_id, session_id PK, video_id, started_at, ended_at, last_event_at, state, skew_ms, has_events, enc)` — `enc` = folded session metrics.
- `video_pause_intervals(device_id, session_id, n, paused_at, resumed_at, status, duration_ms, enc)` PK `(device_id, session_id, n)`.
- `video_watch_segments(device_id, session_id, video_id, enc)` PK `(device_id, session_id)` — merged content ranges with play counts.
- `video_analytics(device_id, video_id PK, last_event_at, enc)` — per-device/video rollup.
- `sessions` gains nothing; `devices.last_events_at` is added (nullable) for the live indicator. Session snapshots additionally accept optional `channelUrl`, `channelId`
  (validated against YouTube channel URL shapes) which are stored inside the existing encrypted `enc` blob.
- All foreign keys `ON DELETE CASCADE` from `devices`. Derived tables are rebuilt from events by `recomputeSession`, so they can always be regenerated.
  Deleting server data (`/api/data/delete`) and retention purge also remove these rows.
- The migration runner is unchanged; `006` contains no `DROP`/destructive statements and no data rewrite.

## 7. API (all behind `authAdmin`; ownership via `devices.admin_id = req.admin.id`)

Ingest (device auth): `POST /api/sync/events` — ≤200 events, per-event validation (id/type/seq/ts/pos/rate/state/meta whitelist, ts within [2015, now+1 day]),
≤5000 events per session, rate limit 240/min. Returns `{acked:[ids], rejected:[ids], serverNow, skewMs}`.

Read: `GET /api/videos` (list, filters q/channel/completed/device/from/to), `GET /api/video/:videoId` (details + metrics + live state),
`/events`, `/sessions`, `/pauses`, `/analytics`, `/live`, `/export?format=csv|json|print`. Another owner's data → 404 (no existence leak) — there is one owner today; checks stay as defence in depth.
Live: the existing `/api/events` SSE gains `video_event` (new events, max 50 per message), `video_session` (state change) and reuses `device_connected/disconnected`.

## 8. Video Details page (`#/video/:videoId`, `server/web/video.js` + `video.css`)

Sections A–F as specified: header, live stat cards, real-time timeline (expandable events), pause/resume table + stats, session history (expandable),
analytics (SVG: watch activity, progress timeline, pause distribution, time breakdown, session comparison — real data only).
Live indicator LIVE / SYNCING / OFFLINE / RECONNECTING (SSE state + last sync time). Status banner: LIVE WATCHING / PAUSED — hh:mm:ss / COMPLETED / DEVICE OFFLINE.
The live timers tick locally from the last confirmed server state (`asOf`) and re-anchor on every event; no sub-second accuracy is claimed.
Timezone selector (default: browser zone; stored in `localStorage`); all times stored UTC. Respects `prefers-reduced-motion`. Mobile: single column, cards stack, tables become labelled rows.
PDF export = print-optimised report page (`format=print`) opened in a new tab for "Save as PDF" (owner's choice; no PDF dependency).

## 9. Risks and mitigations

- **MV3 service worker suspension** → the content script retries a failed `sendMessage` once and otherwise keeps the event in a small in-page buffer; whatever is still lost is covered by the heartbeat/recovery path, which marks the gap `unresolved` instead of guessing.
- **YouTube SPA quirks** (pause before seeking, ad reuse of `<video>`) → handled by the seeking guard and the `ad` state; covered by the manual checklist since they need a real player.
- **Event volume** → debounce buffering, no periodic events, cap per session, 4 GB-RAM friendly: server recompute reads one session's events (≤5000) per touched session.
- **Large decrypts on read** → pages query derived tables first, events only on demand with limit/offset.

## 10. Test plan

`tests/playback.test.js` (pure fold + recorder), `tests/events-queue.test.js` (outbox/offline/reconnect/dup with fake-indexeddb),
`server/test/video-events.test.js` (ingest, idempotency, validation, limits), `video-api.test.js` (read APIs, filters, export, authorization sweep incl. `route-auth`),
`video-migration.test.js` (v5 DB with data → 006, data intact), `video-realtime.test.js` (SSE delivery). Existing suites run after every stage.

## 11. Stages

1. Spec + metrics engine and recorder (pure) + tests.  2. Migration + ingest + recompute + tests.  3. Extension wiring (IndexedDB v4, tracker, sync) + tests.
4. Read APIs + export + realtime + tests.  5. Video Details UI.  6. Docs, checklist, version 0.7.0, ZIP, summary.
