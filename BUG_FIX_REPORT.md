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
