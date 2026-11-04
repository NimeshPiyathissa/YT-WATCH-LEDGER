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

### A7. Several dashboard requests refreshing at once could sign the owner out
- **Where:** `server/web/app.js` (`refreshed()`), against the reuse detection in `server/src/routes/auth.js`.
- **Symptom (expected from the code; not reproduced in a browser):** when the 15-minute access cookie expires, a page that reads several endpoints at once gets several 401s. Each called `/api/auth/refresh` with the same refresh cookie. The server rotates on the first and treats the second as a replayed token, revoking every session, so the owner lands on the sign-in page.
- **Confirmed:** at the server, two simultaneous refreshes with one cookie give one 200 and one 401, and the freshly issued token is then also revoked (`session-refresh.test.js`, last test). Before the fix the browser code had no sharing at all (one `fetch` per caller), and the new module test failed because it did not exist.
- **Fix:** `server/web/session.js` gives callers one shared in-flight refresh; `app.js` uses it. The server's reuse detection is unchanged (it is the right behaviour for a stolen token).
- **Guard:** `server/test/session-refresh.test.js` (5 tests).
- **Verified in headless Chrome (rc.1 work):** `scripts/ui-check.mjs` deletes the access cookie and fires six requests at once. With the old `refreshed()` it fails 3 checks (0 of 6 succeed, the page lands on `#/login`); with the fix all 6 succeed and the session still works afterwards. This is headless Chrome on the development machine, not the installed extension and not a VPS.

### A8. A crashed backup left a `.partial` file behind for ever
- **Where:** `server/src/lib/backup.js` `createBackup`.
- **Confirmed:** the new test creates a stale `tracker-*.db.partial` (and `-wal`) and runs a backup; on the old code both were still there afterwards. Cleanup only ran when the failure was caught, so a power cut or kill during a backup was never cleaned.
- **Fix:** each backup first sweeps `.partial` files (and sidecars) older than an hour; a recent one is left alone because it may belong to a running backup.
- **Guard:** `server/test/backup-integrity.test.js` (A8).

### A9. A restore accepted a backup made by a NEWER release
- **Where:** `restoreBackup` / `checkIntegrity` only checked SQLite integrity and that a `devices` table existed.
- **Confirmed by reading the code** (no schema comparison anywhere); the old restore was not run against a doctored file. A server on older code would then run on a schema it does not understand.
- **Fix:** `inspectBackup` compares the backup's recorded migrations with the release's own list: `newer` is refused, `older` is accepted (the missing steps run at start), no migration history is refused.
- **Guard:** `backup-integrity.test.js` (A9, A9b).

### A10. A restore accepted a backup this server's key cannot decrypt
- **Where:** `restoreBackup`. **Confirmed by reading the code.** Restoring onto a server with a different `MASTER_KEY` would "succeed" and then show no history.
- **Fix:** sample encrypted records and refuse when they do not decrypt (overridable with `--allow-wrong-key`); a backup with no encrypted records yet reports the key as *unchecked*, not wrong.
- **Guard:** `backup-integrity.test.js` (A10, A10b).

### A11. A restore could leave the live database half-written
- **Where:** `restoreBackup` copied straight over the live file.
- **Confirmed by simulation, not by filling a real disk:** the test injects a copy that writes 100 bytes and throws (as ENOSPC would). The old code has no such step, so the test cannot fail the same way there; the point of the test is the new guarantee. **Unverified on a real full disk.**
- **Fix:** write to `<db>.restoring-<time>`, compare its SHA-256 and integrity with the backup, then rename into place; any failure removes the temporary file and leaves the live database byte-for-byte unchanged. The result is verified after the rename.
- **Guard:** `backup-integrity.test.js` (A11, "verified after it is written").

### A12. The pre-restore safety copy could miss recent writes
- **Where:** `restoreBackup` copied `tracker.db` with a plain file copy and then deleted its `-wal`.
- **Confirmed:** a database with a write that exists only in its `-wal` file (what a crashed server leaves) restored with the old code gives a safety copy without that write (the test fails on the old code, passes on the new).
- **Fix:** the safety copy is made with `VACUUM INTO`, which reads the WAL; if the file is too damaged for that, the raw files including `-wal` are kept instead.
- **Guard:** `backup-integrity.test.js` (A12).
- **Severity:** data loss only in the recovery path, after a crash, and only of the newest un-checkpointed writes in the copy that is kept as a last resort.

### A13. Failed sign-ins left no trace
- **Where:** `server/src/routes/auth.js`. **Confirmed:** the new test makes two wrong-password attempts; the old code wrote no audit row, so password guessing was invisible in the Audit log.
- **Fix:** `login_failed` is audited against the owner with only whether the email exists (never the password).
- **Guard:** `server/test/security-center.test.js` (A13).

### A14. Expired owner sign-in tokens were never deleted
- **Confirmed:** the test inserts expired tokens, signs in, and the old code keeps all of them. Growth is slow (one row per renewal) so the severity is low.
- **Fix:** expired tokens are removed at sign-in and hourly. A revoked but unexpired token is kept, because replaying it is how a stolen copy is detected.
- **Guard:** `security-center.test.js` (A14).

### A15. The audit log had an age limit but no size limit (hardening)
- **Where:** `purgeHousekeeping` already dropped rows older than a year. Anyone on the internet can add a row (a wrong pairing code writes one), so within a year the table is not bounded.
- **Status:** not reproduced as an actual disk problem; it is a missing bound. Added `pruneAudit` (age and 100,000 rows, newest kept), run hourly.
- **Guard:** `security-center.test.js` (A15).

### A16. A flood of one audit event hid every other event
- **Where:** `GET /api/audit` returned only the newest 200 rows with no filter.
- **Confirmed:** the test adds one `backup` row then 300 `pairing_failed` rows; the plain listing shows none of the backup row. (Combined with A15 this is how an anonymous visitor could push real events out of view.)
- **Fix:** `?action=`, `?before=` and `?limit=` (max 500). The default response is unchanged, so existing clients are unaffected.
- **Guard:** `security-center.test.js` (A16).

### A18. A seek that took long to finish was counted as playing time
- **Where:** `lib/playback.js` (recorder), with the same code mirrored in `server/src/lib/playback.cjs` and `server/web/vendor/playback.js`; `content/tracker.js`.
- **Found in:** real Chrome playing real YouTube (the first run of `server/test/ext-e2e.test.js`). Jumping 60 s ahead, past what is buffered, left the player in `seeking` for about 25 s. The recorder emitted nothing while seeking, so the stall stayed in the *playing* state and the server-side totals showed **36.4 s of active time in a viewing with about 10 s of real playback**. (The device's own session total, which does not use the event stream, was correct, so the two disagreed.)
- **Confirmed:** by sampling the player (`seeking: true, readyState: 1`, position frozen, for 25-30 s) and by the new unit test, which fails on the old code (no `VIDEO_BUFFERING_STARTED`, 60 s active instead of 30 s).
- **Fix:** an observation that is `seeking` while otherwise playing is treated as a stall (the same 400 ms debounce, so ordinary seeks are unchanged). It is recorded as buffering from the start of the seek and ends when the seek settles. `tracker.js` arms the debounce timer for seeking as well.
- **Guard:** `tests/playback.test.js` ("a seek that takes a long time to finish counts as buffering", "a quick seek ... no buffering") and the real-Chrome test (`bufferingMs > 5 s` when the jump hangs, and playing + paused + buffering must fit inside the time the page was open).
- **Verified:** in real Chrome after the fix: the same jump gave `activeMs` 7.7 s, `bufferingMs` 24.1 s, events `BUFFERING_STARTED ... SEEKED ... BUFFERING_ENDED`.

### A19. The end of a viewing was often lost, and sometimes nothing could ever close it
- **Where:** `content/tracker.js` (`endRecorder`) and `background.js`.
- **Measured in real Chrome on real YouTube** (6 to 10 viewings per way of leaving): the `VIDEO_SESSION_ENDED` message, sent while the page is going away, was lost in roughly 20 to 60 percent of cases (navigating to another site: 3 of 5 lost; to `about:blank`: 2 of 5; closing the tab: 1 of 5; going to youtube.com's home: 0 of 5). That alone is survivable, because the saved recorder state (`live_rec`) lets the worker close the viewing later as *interrupted*. But `endRecorder` cleared `live_rec` at the same moment, and in **2 of 4** trials of one way of leaving both were lost or only the message was: the viewing then had no end event and **nothing left to recover from**, so it stayed open for ever (shown as still playing, its pause never closed).
- **Fix:** the page no longer clears `live_rec`. The worker retires it only after it has stored the end event for that same viewing (a retried delivery also retires it; a different viewing's state is never touched). The worker also drops a second end event for a viewing that already has one, and recovery skips (and clears) a viewing that already ended; the page remembers which viewings it ended itself so the next viewing in the tab does not report them as interrupted.
- **Guard:** `tests/tracker-dom.test.js` (saved state kept at the end; no contradictory "interrupted" after a normal end) and `server/test/video-device.test.js` (retire on store, only for the same viewing; duplicate end dropped; recovery does not double-close). Each failed on the old code except the "no second end" case, which guards the fix itself.
- **Verified in real Chrome after the fix:** 10 viewings left by navigation: none stuck (`lost_STUCK` 0); the ones whose message was lost remained recoverable.
- **Still true:** the end message is still often lost, so a viewing that was left by navigation is closed *late* (when the saved heartbeat is 3 minutes old and the next check runs), not at once. A faster close would need the worker to notice the page disconnecting (a long-lived port); that is a design change, not done here.

### A20. A resume recorded about 7 s late (NOT reproduced, no fix)
- **Seen once** in roughly 45 pause/resume cycles of the real-YouTube end-to-end runs: a 3 s pause stored as 10.5 s, with the resume recorded by the periodic check. The recorded position (10.9 s) matched the moment of the player's `play` event, which suggests the periodic check and the `play` event coincided and the pause length came from somewhere else; the raw timestamps of that run were not kept, so this is not established.
- **Attempts to reproduce:** 10 cycles on real YouTube (all within 1 ms), then 100 cycles at 0.9 s / 1.1 s on a real `<video>` in real Chrome with the real content script and extension (a local stand-in page, `scripts/lib/mock-youtube.mjs`): **all 100 recorded within 50 ms, reason "user"**. A further 30-cycle run on real YouTube could not be completed because YouTube stopped serving the player to the automated browser (every video stuck at `readyState 0`, later in the day).
- **Status:** open. No code was changed. `server/test/ext-e2e.test.js` now has a 40-cycle accuracy test on the stand-in page (all 40 pass) and still reports an overlong pause on real YouTube as a warning, so it will show up if it recurs.

### A22. An invalid `BACKUP_KEEP` deleted every backup
- **Where:** `server/src/lib/backup.js` (`createBackup`) with `server/src/server.js` (`Number(env.BACKUP_KEEP || 14)`).
- **Found while auditing the existing settings.** `BACKUP_KEEP=abc` becomes `NaN`; `slice(Math.max(NaN, 1))` is `slice(NaN)`, which starts at 0, so pruning removed **every** backup, including the one just written, and the call then crashed with `ENOENT` (the new file was already gone).
- **Confirmed:** by running the old code with a `NaN` keep count: all backups deleted, the backup reported as failed.
- **Fix:** the keep count is sanitised where it is used (anything that is not a finite number becomes 14, fractions round down, at least 1, at most 365), and Settings Studio only accepts whole numbers in range. The same audit found that a non-numeric `BACKUP_INTERVAL_HOURS` made `backupEveryMs` `NaN`, so scheduled backups were **silently off** with no message; environment values are now validated, ignored and reported (log line at start, and a warning on the Settings page).
- **Guard:** `server/test/settings-studio.test.js` (A22, `resolveInt`, "a bad value in the server's environment...").

### A23. The Data page deleted data immediately when the retention window was shortened
- **Where:** `server/web/app.js` (Data & backups, "Retention on the server") and `PUT /api/settings`.
- **Confirmed by reading the code and the old UI:** choosing "30 days" and pressing Apply removed every older session at once (`purgeAll`) and only reported the number afterwards, with no confirmation. Backups still held the data, but a mis-click on a dropdown was an irreversible change on the live server.
- **Fix:** the control moved to Settings Studio: the server counts what would be removed (`GET /api/settings/retention-preview`), the page shows it in a confirmation, and `PUT /api/settings/studio` refuses with `409` unless the exact count is confirmed. The Data page now links to Settings. The old `PUT /api/settings` route is unchanged so existing callers keep working (it still deletes immediately).
- **Guard:** `settings-studio.test.js` (preview equals a real purge; 409 until the exact number is confirmed; a stale number is refused) and the click-through test in `ui-interact.test.js` (the dialog names the count; cancelling deletes nothing; confirming removes exactly those sessions).

### A24. Settings Studio overwrote the backup settings a caller passed to the app (regression, caught by the existing suite)
- **Where:** `server/src/lib/settings.js` (`applyRuntime`), called from `buildApp`.
- **Found by:** the full server suite after the power-outage recovery: `history.test.js` "on-demand backup ... pruning to the configured count" kept 5 backups instead of 3.
- **Cause:** `applyRuntime` always wrote the built-in default (14 backups, 24 h) into `config`, discarding `backupKeep` / `backupIntervalHours` given by the caller. Introduced by the uncommitted Settings Studio work; never in a commit or release.
- **Fix:** the caller's original values are remembered; the owner's saved value or a valid environment value wins, otherwise the caller's value stands, and only then the built-in default. "Use the server default" therefore returns to the caller's value. A22 (bad `BACKUP_KEEP` handling) and A23 (confirmed retention changes) are unchanged.
- **Guard:** `settings-studio.test.js` (A24: caller value stands; owner value wins at once; reset returns to the caller's value; environment beats the caller; a bare config gets 14 / 24).
- **Verified after the fix (2026-11-04):** server suite 356 tests, 354 pass, 0 fail, 2 skipped (the two real-Chrome-on-YouTube tests, which need `WL_EXT_E2E=1` and the internet); extension tests 70 of 70; `scripts/ui-check.mjs` 98 passed, 0 failed against a throwaway server with a temporary database.

### A21. The Security page asked for an icon that does not exist
- **Where:** `server/web/index.html`, `server/web/security.js` (my own work from the Security Center milestone, never released).
- **Confirmed:** the new `server/test/icons.test.js` listed `shield` as missing. An unknown icon name does not draw nothing: it draws the `circle-alert` fallback, so the sidebar entry showed a warning symbol.
- **Fix:** the Security entry and its empty state use `shield-check`. The test now checks every icon name used by the dashboard and the extension, and that the two copies of the icon set are identical; it also caught `bell`, which the Notification Center needed, and the icon was added.

## B. Defects found and fixed during development (never in a release)

| # | Defect | How it was found | Guard |
|---|---|---|---|
| B1 | **Stale popup render:** two overlapping refreshes (a storage change and the timer) could finish out of order, so the popup showed the older state (for example "Nothing waiting" while 418 events were queued). | Popup screenshot harness | `popup.js` drops a refresh when a newer one started |
| B2 | A failed sync run reported its error kind as "other" for ordinary network errors, so the popup could not say "you are offline". | `sync-engine.test.js` ("backoff") | `kindOfError` is shared by both paths |
| B3 | The ribbon on a shared time axis made a ten-minute viewing a sliver when viewings were days apart. | Real data on the demo server | `timeline.test.js` ("lane axis") |
| B4 | **`update.sh` could not tell a pre-release from its release.** It compared only `manifest.json`'s numeric `version` (the same `0.8.0` for beta.1, rc.1 and the final release) and `sort -V` ranks `0.8.0-beta.1` above `0.8.0`, so an update from a beta to the final release would have been refused as "already installed". | Found by the installer suite the moment the version was bumped to `0.8.0-beta.1` (3 failures) | `version_ge` now follows semver pre-release rules, the release name is read from `version_name`; 8 new assertions in `scripts/tests/test-installer.sh` |
| B5 | **Signing out another browser made that browser's retry look like theft**, so the reuse detection would have signed out the browser you were still using. | Found by the new "sign out others" test the first time it ran | Tokens ended on purpose are marked `revoked=2` and refused quietly; `security-center.test.js` (B5, plus "however often it retries") |

## C. Known and unchanged

- **`resume_tracking` can turn tracking back on after the person at the device paused it.** Kept by the owner's decision; documented in [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) and shown in the Permissions tab.
- Three moderate `npm audit` advisories in `glob`/`minimatch` via `@fastify/static` (not reachable: its wildcard option is not used and nothing user-controlled reaches `glob`).

## D. Verification results for the Backup Manager / Security Center work (2026-11-04, Windows 11 development machine)

| Check | Result |
|---|---|
| Server suite (`npm test`, includes migration, upgrade-from-v0.7.0, security and headless-Chrome UI tests) | 316 passed, 0 failed (292 before this work + 24 new) |
| Extension unit tests | 66 passed, 0 failed (unchanged: no extension code was touched) |
| Installer suite (`scripts/tests/test-installer.sh`) | 111 passed, 0 failed |
| Dashboard check in headless Chrome (`ui-check.mjs`: 9 pages x 3 sizes, fast navigation, expired-cookie burst) | 86 checks passed, 0 failed (the count is taken from the run with the old code: 83 passed + 3 failed) |
| Syntax check of every `.js`/`.mjs`, `bash -n`, `shellcheck -S warning` | clean |
| Documentation links | 189 checked, 0 problems |
| Extension build and ZIP validation | manifest v3 OK, 35 files present, secret scan clean, `unzip -t` clean |
| `npm audit --omit=dev --audit-level=high` | passes; 3 moderate advisories remain (`glob`/`minimatch` via `@fastify/static`, not reachable; see C) |
| Database migrations | no new migration in this work (`revoked=2` uses the existing column); existing migration tests, including a real v0.7.0 database upgrade, pass |

### Not verified
- **The installed Chrome extension** against a live YouTube page, and pairing a real extension with the server, were not exercised in this work. Extension code was not changed; its unit tests pass.
- **A real VPS** (nginx, Let's Encrypt, systemd, ufw): not exercised. The installer suite runs against a local stand-in.
- **Real full disk / power loss** during a backup or restore: simulated only (A11); the guarantee comes from the write-then-rename design and the injected-failure test.
- **A9 and A10** (newer-release and wrong-key restores) were confirmed by reading the old code, not by running it against a doctored file.
- **Backup Manager and Security Center screens** are covered by the headless-Chrome draw/overflow check (Security page) and API tests. The Verify button and the password form were not clicked through in a browser.
- Headless Chrome is Chrome, but not a headed, signed-in profile with the extension installed.

### Known limits introduced or left by this work
- Access cookies already issued stay valid up to 15 minutes after a sign-out or password change (they are stateless); renewal is refused at once.
- The command-line password reset (`create-owner.js --reset`) is not written to the audit log.
- The owner's sign-in list shows when a sign-in was last renewed, not a device name or address (the table stores neither).

## E. Verification results after A19 / A20 and the Notification Center (2026-11-04)

| Check | Result |
|---|---|
| Server suite (`npm test`; includes migrations, the headless-Chrome page check and the new click-through test) | 336 passed, 0 failed, 2 skipped (the opt-in real-Chrome tests) |
| Extension suite | 70 passed, 0 failed |
| Installer suite | 111 passed, 0 failed |
| Click-through of Notifications, Security and Backups in headless Chrome (`ui-interact.test.js`) | 21 of 21 checks passed (buttons, forms, confirmation dialogs, validation, persistence after leaving the page) |
| Real Chrome end-to-end (`WL_EXT_E2E=1`), real YouTube | 9 of 9 on the earlier runs; **YouTube later stopped serving the player to the automated browser** (every video stuck at `readyState 0`), so it could not be re-run against real YouTube after the A19 change |
| Real Chrome end-to-end with the local stand-in page (`WL_EXT_E2E=1 WL_E2E_MOCK=1`) | 9 of 9, plus the 40-cycle pause/resume accuracy test (40 of 40 recorded on time); this is the real extension on a real `<video>`, **not YouTube** |
| A19 in real Chrome after the fix | 10 viewings left by navigation: none stuck |
| Syntax, `shellcheck`, doc links (193), extension build and ZIP, `npm audit --omit=dev --audit-level=high` | clean / passing |

Two tests named specific migrations in a way that a new migration broke (the 007 test's "run again changes nothing", an older-backup list, and the installer's "7 migrations"). They were changed to name the migration they are about or to count the release's own files, so they keep their meaning and do not need editing for every future migration.

### Still unverified
- The installed extension through a real toolbar and permission prompt, ads, Shorts, several tabs, restart and sleep (manual checklist).
- A real VPS.
- The A19 fix against real YouTube after the change (YouTube blocked the automated browser); it is verified by unit tests, the device-harness tests and a real-Chrome run on real YouTube's page before YouTube refused service, plus the stand-in page.
- A20 is not reproduced and not fixed.
