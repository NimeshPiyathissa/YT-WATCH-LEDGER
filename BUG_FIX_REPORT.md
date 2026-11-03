# Bug fix report: v0.8.0 development

Every entry says how it was **confirmed** (a reproduction, not a suspicion), what was changed, and which test now guards it. Where a defect existed in the published v0.7.0 release this is stated; defects that only ever existed in unreleased v0.8.0 work are listed separately so the two are not mixed up.

Nothing in this file claims real-browser or real-VPS testing that was not done; see [CHANGELOG.md](CHANGELOG.md) for what remains untested.

## A. Defects in the published v0.7.0

### A1. A slow dashboard page could draw over the page you had moved to
- **Where:** `server/web/app.js` router.
- **Symptom:** open Overview, then quickly click Analytics or Devices: whichever page finished loading last replaced the screen, so you could land on a page you did not ask for.
- **Confirmed:** the new real-Chrome check (`scripts/ui-check.mjs`, "fast navigation") fails with the fix disabled (it ended on *Analytics* after clicking *Health Center*) and passes with it enabled.
- **Fix:** every navigation bumps a counter; a page read that finishes after you moved on is dropped.
- **Guard:** `server/test/ui.test.js` (headless Chrome; skipped where no Chrome is installed).

### A2. One event the server refuses blocked the whole upload queue for ever
- **Where:** `lib/sync.js` (extension).
- **Symptom:** if the server answered a batch with a permanent 4xx (for example 400 or 413), the device treated it as a transient failure and retried the *same batch* every time, so every other event queued behind it never uploaded.
- **Confirmed:** against the v0.7.0 code (checked out in a throw-away worktree) three queued events, one of which the server refuses: five consecutive upload attempts all failed, all 3 events stayed queued and 0 reached the server.
- **Fix:** failures are classified (network, server, quota are retried with backoff; a permanent rejection is halved until the single bad item is found and set aside, counted, and kept on the device). Session updates get the same treatment.
- **Guard:** `server/test/sync-engine.test.js` ("a poisoned batch", "a poisoned session update"), `tests/syncpolicy.test.js`.
- **Severity:** low in normal use (the server reports per-event rejections without failing the batch), but a server upgrade that tightens limits could trigger it.

### A3. The upload queue was unbounded and retried without a ceiling
- **Where:** `background.js`.
- **Symptom:** a device offline for a long time queued every event with no limit, and retried every minute for ever (the minute alarm re-armed uploads regardless of earlier failures).
- **Confirmed:** by reading the code path (no limit anywhere between `putEvents` and the upload, and an unconditional minute-alarm retry). I did **not** reproduce it by queueing 20,000 events against the old code; the new tests prove the new limit works (`sync-engine.test.js`: with a small limit the queue stops at the limit, the newest events stay queued, and nothing is deleted from the device).
- **Fix:** a bounded queue (20,000 events; the *oldest queue entries* are set aside, the events themselves stay on the device and the count is reported to the server and shown in the popup and the Device Control Center); backoff with jitter and a ceiling; only a few quick retries before the periodic alarm takes over; the server's `Retry-After` is honoured.
- **Guard:** `sync-engine.test.js` ("the queue limit", "backoff", "Retry-After"), `tests/syncpolicy.test.js`.

### A4. Real-time viewing was available without anyone at the device having agreed to it
- **Where:** extension upload cadence and `server/src/routes/videos.js`, `videoIngest.js`.
- **Symptom:** every paired device streamed what it was playing to the owner's dashboard within about a second, and the page showed LIVE WATCHING, with no switch for the person at the device.
- **Confirmed:** the v0.7.0 tests for live status passed with no consent of any kind.
- **Fix (a decision, approved):** live viewing is a per-pairing consent that starts **off**. With it off the owner gets no real-time stream and no current-state view (the page says LIVE VIEW OFF), and the extension uploads on its regular schedule. Only the person at the device can turn it on, from the popup; the toolbar badge then says LIVE; every change is written to the audit log.
- **Guard:** `server/test/migration-007.test.js` ("live viewing is gated", "the owner cannot switch a device's consent"), `sync-engine.test.js` ("consent", "cadence"), `tests/status.test.js`.
- **Note:** an extension older than v0.8 cannot turn it on, so after the server is upgraded such a device shows LIVE VIEW OFF until its extension is updated. History keeps working.

### A5. The installer test suite failed on a machine with a nearly full disk
- **Where:** `scripts/tests/test-installer.sh` ("health check on a running server").
- **Symptom:** the health-check script correctly reported CRITICAL (less than 5% disk free), so a developer laptop at 97% disk use made an unrelated test fail.
- **Confirmed:** it failed on the development machine (3.6 GB free of 119 GB).
- **Fix:** the test answers the disk question with a stub `df`; the disk check itself is tested separately.

### A6. Events from different viewings with equal timestamps could be interleaved by sequence number
- **Where:** `server/web/video.js` (client-side merge of live events).
- **Symptom:** when two viewings produced events at the same millisecond, the page ordered them by the per-viewing sequence number alone, mixing the two viewings' events.
- **Confirmed:** by running the old comparator (`tsAdj`, then `seq`) over four events at the same instant: it ordered them `a:e1 b:e2 a:e2 a:e3`, placing viewing b's event inside viewing a. The new ordering gives `a:e1 a:e2 a:e3 b:e2` (`server/test/timeline.test.js`).
- **Fix:** one tested ordering everywhere: time, then viewing, then sequence; duplicates (same id) are kept once.
- **Severity:** cosmetic; no data was wrong.

## B. Defects found and fixed during development (never in a release)

| # | Defect | How it was found | Guard |
|---|---|---|---|
| B1 | **Stale popup render:** two overlapping refreshes (a storage change and the timer) could finish out of order, so the popup showed the older state (for example "Nothing waiting" while 418 events were queued). | Popup screenshot harness | `popup.js` drops a refresh when a newer one started |
| B2 | A failed sync run reported its error kind as "other" for ordinary network errors, so the popup could not say "you are offline". | `sync-engine.test.js` ("backoff") | `kindOfError` is shared by both paths |
| B3 | The ribbon on a shared time axis made a ten-minute viewing a sliver when viewings were days apart. | Real data on the demo server | `timeline.test.js` ("lane axis") |
| B4 | **`update.sh` could not tell a pre-release from its release.** It compared only `manifest.json`'s numeric `version` (the same `0.8.0` for beta.1, rc.1 and the final release) and `sort -V` ranks `0.8.0-beta.1` above `0.8.0`, so an update from a beta to the final release would have been refused as "already installed". | Found by the installer suite the moment the version was bumped to `0.8.0-beta.1` (3 failures) | `version_ge` now follows semver pre-release rules, the release name is read from `version_name`; 8 new assertions in `scripts/tests/test-installer.sh` |

## C. Known and unchanged

- **`resume_tracking` can turn tracking back on after the person at the device paused it.** Kept by the owner's decision; documented in [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) and shown in the Permissions tab.
- Three moderate `npm audit` advisories in `glob`/`minimatch` via `@fastify/static` (not reachable: its wildcard option is not used and nothing user-controlled reaches `glob`).
