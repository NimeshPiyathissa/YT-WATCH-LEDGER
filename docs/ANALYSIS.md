# A Consent-Aware YouTube Activity Monitor: Architecture, Security, and the Limits of Technical Enforcement

*Academic write-up accompanying the YouTube Watch Tracker project. For the systems-level report (protocol, test tables) see [WRITEUP.md](WRITEUP.md); for a runnable walkthrough see [DEMO.md](DEMO.md). This document is the analytical companion: it uses the build to examine where consent can and cannot be enforced in code.*

---

## Abstract

This project implements a system for recording YouTube watch activity on one device
and reviewing it from another, built as two layers: a local-first Chrome extension
(Manifest V3) that tracks and stores activity on-device, and an optional self-hosted
backend that lets an administrator view enrolled devices through a web dashboard. The
engineering contribution is a small, well-tested tracking core and a security-conscious
sync protocol. The **analytical contribution**, and the focus of this write-up, is an
honest examination of a problem the software surfaces but cannot solve: *authorised*
and *unauthorised* remote monitoring are the **same artifact**. Consent lives outside
the program, the operator is structurally unconstrained, and the technical controls that
could bind consent are all partial. The system was exercised only against synthetic
clients (a test harness and a seeded demo device) and the author's own browser, and was
never pointed at a third party. That constraint is itself a finding.

---

## 1. Introduction and goals

Activity monitoring on shared or supervised devices is common and often legitimate —
parental controls, workplace device management, lab/kiosk auditing. It is also the
mechanism of stalkerware [1, 2]. The two differ not in what the software does but in
whether the person being observed has agreed and can meaningfully withdraw. This project
set out to (1) build a working, transparent monitor for a narrow data type (YouTube
watch activity only), and (2) use the build to interrogate where consent can and cannot
be enforced in code.

Design commitments, fixed up front:

- **Transparency by construction.** The tracked device shows that tracking is on (a
  toolbar `REC` badge while recording, a status pill in the popup) and, once syncing,
  that data leaves the device and to whom (a persistent "Syncing YouTube watch data to
  *host*" line in the popup and Settings).
- **Data minimisation.** YouTube watch activity only — no keystrokes, passwords, or
  other browsing. Narrow scope is a privacy control, not a feature limit. History
  recorded before enrolment is not uploaded unless the user explicitly opts in.
- **No covert persistence.** The extension never hides itself or resists removal.
- **Opt-in remote sync.** The backend is optional; enrolment is explicit and revocable
  from the device.

---

## 2. System architecture

### 2.1 On-device layer (Chrome extension, MV3)

- A **content script** runs on `youtube.com` and polls the HTML5 `<video>` element once
  per second, handling the site's single-page navigation. Watch time accrues only while
  the video is playing, has not ended, and is not showing an advertisement; each tick's
  wall-clock delta is clamped (2.5 s) so a suspended laptop cannot credit hours. A
  session ends on navigation to another video, page hide, the video ending, tracking
  being switched off, or five minutes paused. There is **no** separate accounting for
  background-tab or paused time, and **no** completion classification beyond a
  per-video `percent` (watched time over duration, capped at 100).
- It flushes a session snapshot to the service worker every ~5 s while playing, on a
  pause, and when the session ends.
- A **service worker** owns persistence. It merges each snapshot with the stored session
  (watched time never decreases; the earliest start is kept), writes it to **IndexedDB**,
  and recomputes the per-video rollup. It also drives retention, a diagnostics ring
  buffer, and — when enrolled — sync.
- **UI pages**: a popup (status, today / last-7-days totals), a dashboard (14-day chart,
  top channels, searchable history), a settings page, and an optional-password-gated
  local **admin console** (install identity, live "tracking now" indicator, export and
  delete by range or channel, diagnostics, enrolment).

The accounting and rollup logic is isolated in a dependency-free module
(`accounting.js`) so it can be unit-tested in Node and **reused unchanged on the
server** (§2.3). The numbers shown locally and remotely are computed by identical code,
and a test fails if the server's copy drifts from the extension's.

### 2.2 Data model

IndexedDB (schema v2) holds `videos` (one rollup per video: totals, session count,
first/last watched, duration, percent) and `sessions` (one upsertable record per
viewing session: video id, title, channel, start/end, watched milliseconds, duration,
`updatedAt`). Sessions carry a client-generated `sessionId`, making flushes idempotent
across worker restarts. Sessions do **not** store an event timeline; charts and reports
are derived from these records. The v2 upgrade adds an `updatedAt` index and back-fills
it for existing sessions so that history recorded before the upgrade remains syncable.

### 2.3 Optional backend and sync

The backend (Node/Fastify, SQLite behind a single swappable module) provides admin
accounts, device enrolment, a sync endpoint, a command queue, and a web dashboard.

- **Enrolment.** The admin generates a one-time code (hashed at rest, 15-minute expiry,
  claimed atomically). The device posts the code plus an install ID; the server issues a
  per-device bearer token (stored only as a hash) and records the device. The extension
  requests network permission for that one origin only at this moment, and releases it on
  unenrolment.
- **Sync.** The device pushes sessions whose `updatedAt` exceeds a local cursor, in
  batches; the cursor advances only after a successful response. The server upserts
  idempotently by `(device_id, sessionId)`, ignores an older snapshot of a session it
  already has, and recomputes each touched video's rollup with the shared
  `accounting.js`. Re-sending is therefore safe.
- **Command queue.** The admin enqueues `pause_tracking`, `resume_tracking`,
  `set_retention`, `delete_all` or `delete_range`; the device pulls, validates (against
  the same whitelist as the server), applies and acknowledges them on its next sync.
  This is deliberately **best-effort and polled** — there is no push to an extension.
  Unacknowledged commands are re-sent, so every command is idempotent.

### 2.4 Data flow (summary)

```
YouTube player ─▶ content script ─▶ service worker ─▶ IndexedDB (on device)
                                                   └─(opt-in)▶ sync push ─▶ server DB (encrypted)
admin browser ─▶ web dashboard ─▶ server API ─▶ (reads device data / enqueues commands)
```

---

## 3. Security model

Because the backend concentrates sensitive data about people's behaviour, its security
is load-bearing rather than incidental. The implemented and tested controls:

- **Authentication.** Admin passwords hashed with argon2id [3]; sessions via signed,
  `HttpOnly; Secure; SameSite=Strict` cookies [4]: a 15-minute access cookie plus a
  rotating, revocable refresh token (replaying a rotated token revokes the whole
  family). Device tokens are 256-bit random values stored as SHA-256 hashes.
- **Authorisation (ownership).** Every admin route that names a device checks that it
  belongs to the requesting admin; every device route touches only that device's own
  rows. These boundaries are covered by negative tests (admin A cannot read, command,
  revoke or delete admin B's device; a device token cannot reach admin routes; a revoked
  token is refused with 403 and a deleted one with 401).
- **Encryption at rest.** Stored session and video records are AES-256-GCM [5]
  ciphertext under a key supplied by the environment, in addition to recommended
  full-disk encryption. Metadata (ids, timestamps, device labels, the audit log) is not
  encrypted. A tested key-rotation script re-encrypts all records in one transaction and
  changes nothing if the old key is wrong.
- **Transport.** HTTPS only in production: the server refuses to start in production
  without TLS certificates or a declared TLS-terminating proxy, and sends HSTS. The
  extension refuses non-`https` server addresses (plain `http` only for loopback).
- **Hardening.** Per-route rate limits (login, registration, refresh, enrolment, push),
  CORS locked to the dashboard origin, security headers and a strict
  content-security policy, rejection of foreign-`Origin` state-changing requests,
  prepared statements throughout, size-bounded and whitelisted inputs, an audit log of
  security-relevant actions, and a dashboard that escapes all device-supplied text
  (verified in a browser with a seeded video title and channel containing HTML/script
  payloads, which rendered as inert text).

`SECURITY.md` separates controls the code **enforces and tests** from assurances only
the operator can provide (valid certificates, an encrypted disk, strong secrets,
backups, creating the first admin immediately). Known gaps are stated plainly: no
password reset or 2FA, per-IP rate limits, SQLite only, and local deletions that do not
remove the server copy except through the retention mirror or an explicit admin delete.

---

## 4. The core problem: consent cannot be located in the software

The project's central finding is uncomfortable for anyone building this category:
**the authorised and unauthorised versions of this system are byte-for-byte the same
program.** A supervised lab machine and a covertly monitored partner's laptop run the
identical extension, enrol through the identical flow, and stream to the identical
dashboard. Nothing in the artifact distinguishes the two cases, because the thing that
distinguishes them — the subject's informed, revocable agreement — is a fact about the
world, not a value the program holds or checks.

This has three structural consequences.

**1. The operator is unconstrained by the design.** Every "transparency" feature is
advisory to the *subject*, not binding on the *operator*. The on-device notice informs
whoever looks at the device; it does not prevent an operator who controls the device
from installing silently, nor does it compel them to leave the notice visible. The
unenrol button empowers the subject only if the subject has physical and administrative
control of the device — which, in exactly the adversarial case, they do not. Controls
aimed at the subject assume the subject is the device's principal; the dangerous case is
precisely when they are not.

**2. Consent is unverifiable from inside the system.** The software receives an
enrolment code and an install ID. It cannot know whether a human agreed, whether that
human is the device's user, whether they understood what they agreed to, or whether
they still agree five minutes later. "This should only run with permission" is a
statement about intended use; software cannot enforce intent.

**3. Narrow scope reduces harm but does not change category.** Restricting collection to
YouTube activity is a genuine mitigation — less is captured, so less can be misused. But
a log of exactly what someone watched and when is itself sensitive (it can reveal
health, politics, sexuality, routine). Minimisation lowers the stakes; it does not turn
surveillance into something else.

---

## 5. What technical controls *could* bind consent — and why each is partial

If consent cannot be read from inside the program, can it be approximated by design?
Several mechanisms help; none closes the gap. The status of each in this project is
noted.

- **Subject-controlled unenrolment and a visible indicator.** *Implemented.* Necessary.
  Fails in the adversarial case because it presupposes the subject controls the device.
- **Subject-readable transparency.** *Partly implemented.* The device's own admin
  console shows the server, last successful sync, last error and last remote command,
  and its diagnostics log records every applied command. It is not a full mirror of what
  was sent, and it is useless if the subject never opens it or does not know the system
  exists.
- **Periodic re-consent.** *Not implemented.* A recurring on-device prompt the subject
  must affirm would raise the cost of covert use and create a record, but an operator
  with device control can dismiss or automate past it.
- **Dual-control / co-signed enrolment.** *Not implemented.* Requiring a credential held
  by the *subject* (not just the admin) to enrol, and again to continue, moves a secret
  into the subject's hands. Key management is hard, and the subject can be coerced or
  deceived into signing.
- **Attestation of principal.** *Not implemented, and not implementable at this layer.*
  Tying enrolment to an OS/account identity that proves *who* the device's user is
  (e.g. the monitored account is a known supervised child account) is essentially what
  platform solutions do (§6), and it works only because it is enforced *below* the
  application.
- **Scope and retention limits.** *Implemented* (YouTube-only, configurable retention,
  server-side trimming that mirrors the device's setting, opt-in upload of earlier
  history). Harm reduction, not consent.

The pattern is consistent: controls that live **inside** an application the operator
installs cannot bind that operator, because the operator is the application's principal.
Effective consent enforcement must come from a **layer the operator does not control** —
the operating system, the account provider, or the law.

---

## 6. How real products handle it — and why they can

Production monitoring tools do not try to enforce consent inside a user-installed app.
They relocate the control to a layer with authority over the device or account:

- **Google Family Link / supervised accounts.** Consent and authority are mediated by
  the *account provider*. A guardian links a supervised child account; the provider
  enforces rules at the account level and surfaces activity to the guardian. The
  subject's status (a minor under a linked guardian) is established outside any single
  app.
- **Enterprise MDM / Chrome Enterprise.** Authority comes from *device ownership* and an
  employment relationship. The organisation owns or formally manages the device, policies
  are pushed through device management (for example forced extension installation), and
  users acknowledge a monitoring policy as a condition of use. The legitimacy rests on
  ownership plus disclosed policy, not on a checkbox in an app.
- **YouTube's supervised experiences.** Platform-side settings on the account itself,
  again mediated by the provider and tied to account age and role.

In every case the enforceable part of consent sits **above or below** the application:
in the account system, the device-management layer, or contract and law. A self-hosted
server enrolling arbitrary devices has none of that scaffolding, which is exactly why it
is the risky form — and why, for the real-world goal of supervising a minor's viewing,
the platform tools are not just safer but *more capable*: they can bind the subject's
role in a way an app cannot. (This section describes these products at a general level
from their public positioning; it is not a feature-by-feature comparison.)

---

## 7. Ethical and legal considerations

- **Legality varies and is serious.** In many jurisdictions, installing monitoring on
  another adult's device without their knowledge is a criminal offence (computer-misuse,
  interception and anti-stalkerware statutes). Lawful monitoring generally requires
  ownership, a guardian relationship over a minor, or disclosed workplace policy with
  acknowledgement. This document is not legal advice.
- **Minors.** Monitoring a child is often legitimate for a guardian, but the appropriate
  mechanism is a platform supervised account, not a bespoke server, both for safety and
  because the guardian relationship is what confers authority.
- **Data-subject rights.** A responsible deployment would honour access, export and
  deletion for the subject and apply strict retention. The project implements local
  export, retention and deletion; server-side deletion of the synced copy is
  admin-driven, which is itself a power asymmetry worth flagging.
- **Evaluation ethics.** The system was exercised only against synthetic device clients
  (a test harness with a faked browser-storage layer, and a seeded demo device) and the
  author's own browser, over localhost; the demo database lives in a temporary directory
  deleted on exit. No third party's data was ever collected. A self-enrolled demo with
  the author's own browser is documented in `DEMO.md`; its extension-side steps were not
  executed during development. The decision not to enrol a real second person — even a
  consenting one — reflects the thesis of §4: because the system cannot itself hold or
  verify that consent, the safe demonstration keeps any other subject out of it.

---

## 8. Testing and evaluation

- **Pure-logic unit tests (53 + 33 assertions).** The tracking core (`accounting.js`),
  aggregation (`stats.js`) and utilities: delta clamping, snapshot merging (monotonic
  watched time, earliest start, end timestamp preserved), per-video rollup (totals,
  percent, ordering, no input mutation), per-day totals, formatting and HTML escaping.
  The sync logic (`sync.js`): changed-session selection and cursor advance (including
  that equal timestamps at a batch boundary are never split), backoff bounds,
  server-address validation (https required, loopback http allowed, credentials refused),
  command validation, and the "syncing to …" notice text.
- **Server tests (43 cases).** Authentication (bad/good login, token tampering, refresh
  rotation and reuse detection, logout, registration rules, cross-origin refusal,
  security headers); **authorisation boundaries** (cross-admin access denied on all
  device-scoped routes, device-token privilege limits, revoked and deleted device
  handling, single-use and expiring enrolment codes); idempotent sync, correct recomputed
  rollups, stale-snapshot rejection, field whitelisting, and encryption at rest; the
  command lifecycle (enqueue → delivered → acked, redelivery, non-whitelisted and
  malformed commands rejected); retention mirroring; key rotation; and a check that the
  shared browser/server code matches the extension's originals.
- **Device-client end to end.** The real extension `sync.js` was run against the real
  server over HTTP with a faked `chrome.storage` and a faked IndexedDB layer: enrol,
  push, apply and acknowledge commands, admin revoke and delete, user unenrol, and an
  offline retry that loses nothing.
- **Manual browser check (dashboard only).** In Chrome against a locally seeded server:
  unauthenticated redirect, sign-in, device list, a device page with totals, chart,
  history and controls, a queued command appearing as pending, the audit log, and
  inert rendering of a hostile title and channel name.
- **Not covered.** The extension itself (content script, service worker, popup, admin
  console, the enrolment screen and permission prompt, and the IndexedDB v1→v2 upgrade)
  was not run in a browser; there is no performance or accuracy measurement against
  ground truth; no HTTPS or reverse-proxy path testing; no usability study of whether
  users understand the disclosures; and no penetration test. The tests show the
  implementation matches its specification, not that the specification is sufficient.

---

## 9. Limitations and future work

- **Player events ≠ attention.** "Active" is a measured player state (playing, not an
  ad); it cannot prove a person watched the screen. This caveat is currently stated in
  the README and this document, **not** in the dashboards; adding it to every report is
  an easy improvement.
- **Best-effort control.** Remote commands apply on the next sync (up to roughly five
  minutes), not instantly, and the person at the device can undo pause and retention
  changes locally.
- **Consent remains external.** The strongest improvement is not more features but moving
  enforcement to a layer the operator doesn't control — integrating with an account/OS
  supervision model rather than free-form device enrolment. Future work could prototype
  periodic re-consent, dual-control enrolment and a fuller subject-readable mirror, and
  study how much they actually raise the bar against covert use. A design study of
  dual-control enrolment, including what it would change in this codebase, is in
  [DUAL_CONTROL.md](DUAL_CONTROL.md).
- **Operational hardening.** 2FA, password reset, Postgres, and per-account (not per-IP)
  rate limiting are left as production work.

---

## 10. Conclusion

The system works as specified: it tracks a defined player state, syncs idempotently,
authorises correctly, and presents cleanly. But the most useful thing the project
produced is the clarity that its safety does **not** come from any of that. The same
code serves a consenting lab and a non-consenting victim; the difference is entirely in
facts the software can neither see nor enforce. Consent, for this class of tool, is not
a feature you can ship — it is a property of the deployment, guaranteed (if at all) by a
layer above the application. Recognising that, and designing the evaluation so no real
person was ever the subject, is the responsible way to study monitoring software without
becoming an operator of it.

---

## References

1. R. Chatterjee et al., "The Spyware Used in Intimate Partner Violence," *IEEE Symposium on Security and Privacy*, 2018.
2. K. Roundy et al., "The Many Kinds of Creepware Used for Interpersonal Attacks," *IEEE Symposium on Security and Privacy*, 2020.
3. A. Biryukov, D. Dinu, D. Khovratovich, S. Josefsson, "Argon2 Memory-Hard Function for Password Hashing and Proof-of-Work Applications," RFC 9106, 2021.
4. A. Barth, "HTTP State Management Mechanism," RFC 6265, 2011.
5. M. Dworkin, "Recommendation for Block Cipher Modes of Operation: Galois/Counter Mode (GCM) and GMAC," NIST SP 800-38D, 2007.

*Citations are given from memory of the published works; verify them before formal submission.*
