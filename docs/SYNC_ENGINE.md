# How the extension syncs (v0.8)

The extension stores every viewing and every playback event on the device first, then uploads them. Nothing is deleted from the device by the sync engine. This page describes the rules in `lib/syncpolicy.js` and `lib/sync.js`; they are covered by `tests/syncpolicy.test.js` and the end-to-end `server/test/sync-engine.test.js` (the real extension against the real server).

## What is uploaded, and when

- **Viewing updates** (one row per viewing, with a revision number) and **playback events** (each with a stable id like `<viewing>:e7`) wait in two queues in the browser's IndexedDB.
- Uploads happen on the periodic alarm (every 5 minutes, or the interval the owner manages), when a viewing ends, when the browser starts, after a manual **Reconnect**, and, only while **live viewing** is on, within about a second of an event. See [LIVE_MONITORING.md](LIVE_MONITORING.md).
- Each item is removed from its queue only when the server acknowledges that exact id or revision.

## No duplicates

An event id is stored once; sending it again is acknowledged and ignored. So a lost response, a browser restart in the middle of an upload, or a replay can never create a duplicate. Viewing updates keep the highest revision.

## Failures are classified

| What happened | Meaning | What the device does |
|---|---|---|
| No network, timeout | `network` | Keep everything queued; retry with backoff. |
| 5xx, 408 | `server` | Retry with backoff. |
| 429 | `quota` | Retry, waiting at least the server's `Retry-After` (up to 10 minutes). |
| 401 / 403 | `auth` | The existing revoked / pending / removed handling (never retried as data). |
| Other 4xx (400, 413, 422...) | `rejected` | The batch will **never** succeed as it is: halve it until the one offending item stands alone, set that item aside, and carry on with the rest. |

The set-aside count is shown in the popup and kept; the item stays on the device. This is why one bad record can no longer block the queue.

## Backoff without a loop

After a failed run the wait doubles each time (about 1-2 s, 2-4 s, ... capped at 5 minutes), randomised over its upper half so many devices do not return together. After six quick retries the engine stops retrying in the foreground; the periodic alarm (and the one-minute connection alarm for events, which respects the backoff) takes over. The popup shows "Retrying in 38 s" or "Will try again automatically in a few minutes".

## The queue is bounded

At most 20,000 events wait for upload. Beyond that the **oldest queue entries** are set aside (the events themselves stay in local storage, nothing is deleted); the device reports the number, the popup shows "N events kept on this device only (queue limit)", the owner's Device Control Center shows a warning, and the server's Health page flags it. Viewing summaries still upload.

## Order and recovery

Events leave oldest first and in sequence per viewing; the server orders by time, viewing and sequence. A viewing whose browser vanished is closed at its last recorded heartbeat, never at "now". After a browser restart the queues are read from IndexedDB and uploading resumes.

## Manual reconnect

The popup's **Reconnect** drops the cached access token and the live channel, clears the backoff, opens a fresh live channel and syncs at once.
