# Consent-Preserving Watch-Time Tracking for YouTube: Design and Implementation of a Browser Extension with Opt-In Remote Administration

*Educational project report.*

*See also [ANALYSIS.md](ANALYSIS.md) for the analytical companion on consent and the limits of technical enforcement.*

## Abstract

Watch-time analytics and parental or self-monitoring tools are often built on designs that are indistinguishable, technically, from stalkerware: collection that is hidden from the person observed and data that flows to someone else without their ongoing awareness. This report describes a small system that deliberately takes the opposite approach. A Manifest V3 browser extension records how long a user actually watches YouTube videos, entirely on the device by default. An optional backend lets a second party (an "admin") view the synced history and issue a small set of settings commands, but only after the person at the browser enrols the device with a one-time code, and with persistent on-device disclosure of where data goes. We describe the requirements, the architecture, the synchronisation and authorisation protocols, and the test strategy, report what was and was not verified, and discuss the limits of the design. The contribution is not a new technique but a worked, tested example of building consent, visibility and revocability into the data path rather than adding them afterwards.

## 1. Introduction

Browser extensions are well placed to measure media consumption, and the same capability can serve self-quantification, parental guidance or institutional oversight. Prior work on intimate-partner-violence spyware and "creepware" shows that the harmful cases share structural features: concealment, removal that is difficult or invisible to the observed person, and data flowing to a party who is not the device owner [1, 2]. Benign tools can end up resembling these systems simply by omitting disclosure.

We therefore treat the question *"what must be true of the system so that the observed person always knows, and can stop, the observation?"* as a first-class requirement, and ask how far a small, ordinary web stack can go toward it. The intended audience is students of secure system design; the system is for use on one's own devices or with the informed agreement of everyone recorded.

## 2. Scope and ethical framing

- **In scope:** YouTube watch time (video id, title, channel, start and end time, seconds in a playing non-ad state, duration); local storage and analytics; opt-in sync; a small command set; an admin web dashboard.
- **Out of scope:** other sites, page content, keystrokes, covert installation, stealth, anti-removal measures, and any identification of the person.
- **Use condition:** operators must have lawful grounds and the knowledge and agreement of those recorded. The system is deliberately *not* hardened against its own user: they can disable tracking, unenrol, or remove the extension.

## 3. Requirements and threat model

**Functional.** F1 measure active watch time per video and session. F2 local history, charts, export and deletion. F3 optional multi-device sync to an admin. F4 admin view and limited remote control. F5 retention limits on both ends.

**Consent and transparency (the distinguishing requirements).** C1 tracking is visibly indicated on the device. C2 sync is off by default and begins only through a user-initiated enrolment. C3 while enrolled, every UI surface states that data is being sent and to which server. C4 the user can end sync at any time, and a server-side revocation is surfaced to the user rather than silently ignored. C5 remote commands are visible to the user and cannot lock them out.

**Adversaries considered.** (A1) a different admin account trying to read another admin's devices; (A2) a malicious or stolen device token; (A3) a network attacker; (A4) a malicious web page exploiting the admin session (CSRF/XSS), including through attacker-controlled video titles; (A5) theft of the database file. **Not defended against:** a compromised server operator, physical access to an unlocked browser profile, and a malicious extension update.

## 4. Design

### 4.1 Device

The content script observes the `<video>` element once per second and accrues wall-clock time only while the player is playing, not ended, and not showing an advertisement; each tick is clamped so a suspended laptop cannot credit hours. Snapshots are sent to the service worker, which merges them with the stored session (watched time is monotonic, the earliest start is kept) and recomputes a per-video rollup. All accounting logic lives in one pure module with no browser dependencies so it can be unit-tested in Node and reused on the server.

Visibility (C1, C3): a toolbar badge shows `REC` during recording; the popup and Settings display "Syncing YouTube watch data to *host*" whenever enrolment is active. The local admin console shows the live state, the last successful sync, the last error and the last remote command. An optional admin password is documented as a convenience lock only; the data remains readable through developer tools.

### 4.2 Enrolment and least privilege

An admin generates a 40-bit one-time code (stored hashed, 15-minute expiry, claimed atomically so concurrent redemption cannot succeed twice). The user enters the server address and code in the extension. The network permission for that single origin is requested at that moment through Chrome's optional-host-permission mechanism and released again on unenrolment. Server addresses must be `https` (plain `http` only for loopback development). Pre-enrolment history is not uploaded unless the user ticks an explicit box, because enrolment is the moment of consent and silently exporting past data would exceed it.

### 4.3 Synchronisation

The device keeps a cursor equal to the largest `updatedAt` it has pushed. It sends sessions with `updatedAt` greater than the cursor in batches of 200 and advances the cursor only after a successful response. Delivery is therefore at-least-once; the server upserts by `(device, sessionId)` so duplicates are harmless, and ignores a snapshot older than the stored one. Rows that share a timestamp at a batch boundary are kept together: otherwise advancing the cursor to that timestamp would silently skip the remainder. The server recomputes each touched video's rollup from its stored sessions using the same accounting module the device uses.

### 4.4 Remote control

Commands are polled, not pushed: `pause_tracking`, `resume_tracking`, `set_retention`, `delete_all`, `delete_range`. Both server and device validate type and payload against the same whitelist. A command is `pending`, then `delivered`, then `acked`; commands that were delivered but not acknowledged are re-sent after a delay, so every command is idempotent. The device records each applied command locally (C5), and the user can re-enable tracking at any time. When a device confirms a `set_retention` change, the server applies the same window to its copy so that remote retention is not weaker than local retention.

### 4.5 Server and authorisation

Admin passwords use Argon2id [3]. Admin sessions use a 15-minute HMAC-signed access cookie and a rotating refresh cookie, both `HttpOnly; Secure; SameSite=Strict` [4]; presenting a refresh token that was already rotated revokes all of that admin's sessions, on the assumption that it was stolen. Device credentials are 256-bit random bearer tokens stored only as SHA-256. Every admin route that names a device passes through one ownership check (404 unknown, 403 foreign). Stored session and video records are encrypted with AES-256-GCM [5] under an environment-supplied key, with a documented and tested rotation procedure; all inputs are whitelisted and size-bounded; per-route rate limits cover login, registration, refresh, enrolment and push. State-changing requests that carry a foreign `Origin` are rejected as defence in depth. The web dashboard is a static page that sets no inline script or style under a strict content-security policy and escapes every device-supplied string.

## 5. Implementation

Extension: Manifest V3, plain JavaScript, IndexedDB (schema v2 adds an `updatedAt` index and back-fills existing sessions so that history recorded before the upgrade is still syncable), `chrome.alarms` for a five-minute sync timer plus a five-second debounce after activity, and exponential backoff capped at 60 s with a bounded number of retries per cycle. Server: Node, Fastify, SQLite (behind a single `db.js` seam), Argon2, with two SQL migrations. Approximate sizes (`wc -l`): extension code and UI ≈ 990 lines; server source ≈ 540; dashboard ≈ 180; tests ≈ 770.

## 6. Evaluation

**Method.** Verification is by automated tests plus one manual browser session, not by user study.

| Suite | Scope | Result |
|---|---|---|
| `session-logic` | pure accounting, stats and utilities | 53 assertions pass |
| `sync-queue` | cursor/batch selection, URL and command validation, notice text | 33 assertions pass |
| server tests | authentication, authorisation, sync idempotency, commands, retention, encryption at rest, key rotation | 43 test cases pass |
| end-to-end device client | the real extension `sync.js` against the real server over HTTP: enrol, push, apply and acknowledge commands, revoke, delete, unenrol, offline retry | included in the 43 |

Security-relevant behaviours that are asserted rather than assumed: admin B is refused (403) on all six device-scoped routes for admin A's device; device tokens do not work on admin routes and vice versa; a revoked device receives 403 and a deleted one 401, after which the client stops and informs the user; replayed refresh tokens revoke the family; the stored blobs contain no plaintext titles; stale snapshots do not overwrite newer ones; a wrong rotation key changes nothing; shared browser/server code cannot silently drift from the extension's copy.

A manual session in Chrome against a local development server confirmed that the dashboard redirects unauthenticated visitors, signs in, renders totals, chart and history, queues a command that appears as pending, and records it in the audit log. A seeded video title and channel name containing HTML/script payloads rendered as inert text with no script execution.

**Not evaluated.** The extension itself was not run in a browser by the automated suite (the client logic was exercised with a faked `chrome.storage` and a faked IndexedDB layer); no performance or battery measurement; no HTTPS or reverse-proxy path testing; no usability study of whether users understand the disclosures; no adversarial penetration test; no measurement of tracking accuracy against ground truth. The tests establish that the implementation matches its specification, not that the specification is sufficient.

## 7. Discussion and limitations

- **Visibility is not comprehension.** A permanent notice satisfies C3 mechanically, but whether the observed person understands and agrees is a social fact the software cannot establish.
- **Asymmetry.** The admin can see history; the device owner can unenrol or remove the extension. The design chooses the observed person's control over the admin's, which makes it unsuitable for enforcement scenarios by construction.
- **Residual server copy.** Local deletions do not delete the server copy except through the retention mirror or an explicit admin deletion.
- **Operational security is load-bearing.** A server holding watch histories is a high-value target; application-level encryption does not protect metadata, and key custody, TLS and disk encryption are operator responsibilities.
- **Weak "attention" signal.** Player state is a proxy; it cannot show that a person was watching.
- **Account hygiene.** There is no password reset, second factor or per-account lockout.

### Engineering lessons

Several defects were found by reasoning about edge cases rather than by failing tests, which argues for writing the edge-case tests first: a batch cursor that could skip same-timestamp rows; sessions created before a schema upgrade being invisible to a new index; a login path that leaked account existence through timing; and a test-runner change that made a documented command invalid on newer Node versions.

## 8. Future work

Server-sent notifications to shorten command latency; per-device end-to-end encryption so the server cannot read histories; second-factor admin login; a periodic "this device is being monitored" reminder; usability testing of the disclosures; and a Postgres backend with row-level isolation.

## 9. Conclusion

Consent, visibility and revocability can be treated as protocol and data-path properties with ordinary tools: opt-in enrolment through a one-time code, least-privilege permissions, persistent disclosure, device-side validation of remote commands, and symmetric termination of sync. The accompanying implementation and tests show these properties are cheap to build and straightforward to verify, while the limitations above show where technical measures stop and responsible use begins.

## References

1. R. Chatterjee et al., "The Spyware Used in Intimate Partner Violence," *IEEE Symposium on Security and Privacy*, 2018.
2. K. Roundy et al., "The Many Kinds of Creepware Used for Interpersonal Attacks," *IEEE Symposium on Security and Privacy*, 2020.
3. A. Biryukov, D. Dinu, D. Khovratovich, S. Josefsson, "Argon2 Memory-Hard Function for Password Hashing and Proof-of-Work Applications," RFC 9106, 2021.
4. A. Barth, "HTTP State Management Mechanism," RFC 6265, 2011.
5. M. Dworkin, "Recommendation for Block Cipher Modes of Operation: Galois/Counter Mode (GCM) and GMAC," NIST SP 800-38D, 2007.
6. OWASP, *Application Security Verification Standard*.
7. Google, *Chrome Extensions: Manifest V3* documentation (optional host permissions, service workers, alarms).

## Appendix: reproducing the results

```
node tests/session-logic.test.js
node tests/sync-queue.test.js
cd server && npm install && npm test
node scripts/demo.js        # then follow docs/DEMO.md
```
