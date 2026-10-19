# Design Study — Dual-Control Enrollment

*Future-work chapter for the YouTube Watch Tracker project. Companion to [ANALYSIS.md](ANALYSIS.md)
(§4–5) and [WRITEUP.md](WRITEUP.md) (§8). **This is a design analysis, not an implemented feature:**
nothing described here exists in the code, and §5.5 lists what building it would touch.*

---

## 1. Problem this addresses

ANALYSIS.md §4 establishes the project's central limitation: the authorised and
unauthorised versions of the system are the same artifact, because consent is a fact
about the deployment that the software neither holds nor verifies. In the current
enrolment flow, that gap is concrete and visible:

- Enrolment requires **only an admin-issued one-time code**. The admin generates it in the
  dashboard; whoever is at the monitored browser enters it in the extension and accepts the
  browser's permission prompt. Nothing in the exchange proves that person is the *subject*
  whose activity will be recorded, and the subject is not a required party.
- Every "transparency" control (the on-device notice, the unenrol button) is addressed to
  whoever controls the device. In the adversarial case the operator controls the device, so
  those controls bind no one.

**Dual-control enrolment** asks a narrower, answerable question: *can we make the subject
a cryptographically required party to enrolment and to continued sync, using a secret the
operator does not control?* It cannot manufacture genuine consent, but it can move the
system from "consent is invisible to the software" toward "one-sided or covert enrolment
is harder, time-bounded, and leaves the subject holding evidence."

## 2. Threat model

**Defends against:** an operator with administrative access to the device who wants to
enrol and keep syncing **without the subject's genuine, ongoing agreement** — including the
common pattern of obtaining a one-time "yes" and then retaining access indefinitely.

**Does not defend against (stated plainly):**
- An operator who also controls the subject's second channel (their phone, their email).
- Sustained coercion ("sign, or else").
- Key theft from the subject's device.
- A subject who signs without understanding what they're signing.

The honest claim is therefore *bar-raising and evidence-producing*, not *consent-proving*.
Where it still fails, it fails toward the platform/attestation approach (§6).

## 3. Design goals

1. The subject must actively participate in enrolment with a secret held **off the
   monitored device** (a channel the operator doesn't administer).
2. Continued sync must require **periodic re-affirmation**, so a single past "yes" does not
   grant perpetual access.
3. The subject must be able to **revoke from their own channel**, independent of whether
   they control the monitored device.
4. The subject must retain a **signed receipt** of exactly what they agreed to (scope,
   retention, admin identity), so later they can prove what was and wasn't authorised.
5. Failure is **fail-closed**: if re-affirmation lapses, the server stops accepting data.

## 4. Participants and keys

- **Admin (A):** runs the server, generates enrolment codes. Has an account (today: email +
  argon2id password).
- **Subject (S):** holds a keypair `(S_pub, S_priv)` created on a **companion app** on a
  device S controls (e.g. a phone). `S_priv` never touches the monitored device.
- **Monitored device (D):** the browser/extension that will record activity. Generates a
  device keypair at enrolment (today it holds only a bearer token).
- **Server:** verifies signatures, stores consent receipts, issues short-lived sync grants.

Key establishment: S installs a small companion app once and registers `S_pub` with the
server (out-of-band, e.g. S logs in to a subject portal, or scans a QR the server shows and
the app posts `S_pub`). This step is what plants a secret outside the operator's control;
its integrity is the whole scheme's foundation (and its weakest point — §7).

## 5. Protocol sketch

Signatures would use a standard scheme such as Ed25519 over a canonical serialisation of
the request (for example JSON Canonicalization Scheme, RFC 8785), so that what the subject
reads is exactly what is signed and verified.

### 5.1 Enrolment (co-signed)

```
A: dashboard → generate enrolment code C (one-time, short TTL)
D: builds an enrolment request
     R = {code:C, installId, devicePub, audience:<server origin>, scopeVersion,
          retention, adminId, adminLabel, nonce, ts}
D: displays R as a QR / short code for the subject's companion app
S (companion app): shows R in plain language ("Admin <label> at <server> will record your
       YouTube watch activity on <device>, kept <retention>"), then signs:
       consentSig = Sign(S_priv, canonical(R))
S → server (from S's own device): { R, consentSig }
Server:
   - verify C is valid, unused, unexpired and matches R.adminId      (admin side)
   - verify R.audience is this server and the nonce is fresh          (replay)
   - verify consentSig against the registered S_pub                   (subject side)
   - require BOTH → else reject
   - create device; store a CONSENT RECEIPT = {R, consentSig, S_pub, serverTs}, signed by server
   - issue device credentials to D (as today) AND return a signed receipt copy to S's app
```

Neither party alone can enrol: the admin code without `consentSig` is refused, and a
`consentSig` without a valid admin code has nothing to attach to. Binding `audience` and a
nonce into `R` stops a signature given for one server or one enrolment being replayed
elsewhere.

**Scope must be enforced, not just declared.** A receipt that says "YouTube watch activity,
kept N days" is decorative unless the server rejects anything outside that scope. The
current server already stores only a whitelisted, length-bounded set of session fields; a
`scopeVersion` would name that exact schema (and retention) so the receipt refers to
something checkable.

### 5.2 Continued sync (re-affirmation)

The device credential no longer grants open-ended sync. Instead:

```
Server issues SYNC GRANTS: short-lived (e.g. 7-day) tokens bound to the device.
Each grant renewal requires a fresh subject signature:
   S (companion app, on a schedule): Sign(S_priv, {deviceId, periodStart, periodEnd})
   → server validates against S_pub, issues the next grant
If no valid re-affirmation arrives before the current grant expires:
   → server refuses /api/sync/push (fail-closed) and flags the device "lapsed"
```

A one-time deception yields at most one grant window of data, not indefinite access. The
companion app (not the monitored device) is responsible for prompting S, since the operator
controls D.

### 5.3 Subject-initiated revocation

```
S (companion app) → server: Sign(S_priv, {revoke:deviceId, ts})
Server: mark device revoked; all device credentials/grants refused (device push → 403, as today)
```

This works **even if S has lost control of the monitored device**, because revocation is
issued from S's own channel — the property the current unenrol button lacks.

### 5.4 Data structures (server)

```
subjects(id, s_pub, created_at)
consent_receipts(id, device_id, subject_id, request_json, consent_sig, server_sig, created_at)
sync_grants(id, device_id, period_start, period_end, subject_sig, issued_at, status)
-- devices table gains: subject_id, consent_receipt_id
```

### 5.5 What this would touch in the current code

- **Server:** a new migration for the tables above; `POST /api/enroll` would take `{R,
  consentSig}` in addition to the code; `authDevice` would also check for a current,
  unexpired grant; new subject routes for key registration, grant renewal and revocation.
- **Distinguishing "lapsed" from "revoked".** Today the extension treats *any* 401/403 as
  "the server revoked or removed this device" and permanently discards its token. A lapsed
  grant must **not** do that, or one missed re-affirmation would silently unenrol the
  device. The server would need a distinct response (for example 403 with
  `error: "grant_lapsed"`) and the client a "paused — waiting for re-affirmation" state that
  keeps the credential and shows a clear on-device notice.
- **Extension UI:** the enrolment screen would display the request `R` (QR/short code)
  instead of only accepting a code, and the persistent "syncing to …" line would also show
  grant status.
- **Companion app:** the large new piece (key storage, plain-language rendering of `R`,
  signing, scheduled re-affirmation prompts). It is outside this repository.
- **Tests:** the existing end-to-end device-client harness could drive the new flows with
  synthetic subject keys, preserving the "no human subject" evaluation approach.

## 6. How this maps onto real products

Family Link and MDM succeed precisely by doing a stronger version of this at a layer the
operator doesn't control: the **account provider or OS** attests *who the principal is* (a
supervised child account; a managed corporate device + accepted policy). Dual-control
enrolment is an application-layer approximation of that idea — it imports a subject-held key
as the "layer the operator doesn't control." It is weaker than platform attestation because
the companion-app registration (§4) is bootstrapped by software the operator may still
influence, whereas the platform binds identity below the app entirely. The design is
therefore best read as *evidence for* ANALYSIS.md's conclusion: even a serious in-app
consent mechanism ends up leaning on an out-of-band root of trust.

## 7. Residual gaps (do not oversell this)

- **Bootstrap integrity.** If the operator controls S's companion-app setup or the QR
  channel, they can register their own key as "the subject." The scheme is only as good as
  that first out-of-band step, including how the subject portal authenticates S.
- **Coercion and social engineering.** A subject can be pressured or tricked into signing.
  Cryptography can't distinguish a coerced signature from a free one.
- **Companion-device compromise.** Key theft from S's phone defeats it.
- **Declared vs. real scope.** Without server-side enforcement of the scope named in the
  receipt, the receipt proves what was *shown*, not what was *collected*.
- **Usability cost.** Periodic re-signing is friction; too much and legitimate supervised
  setups abandon it, too little and the re-affirmation window is meaninglessly long. A
  subject who is simply unavailable (lost phone) also stops sync, by design.
- **Still the same artifact at the edges.** For a legitimately owned device with a willing
  subject it adds assurance; for a determined abuser with full control of the subject's
  life, it raises cost without closing the door. That's the honest ceiling.

## 8. Evaluation plan (if implemented later)

- **Unit/integration:** signature verification on enrolment (reject code-only and sig-only);
  replay of a signature to another audience or with a reused nonce rejected; grant expiry →
  fail-closed push; lapsed grant does not unenrol the device; subject-channel revocation →
  device 403; tamper tests (modified `R` fails verification).
- **Threat-model walkthrough:** table each §2 attacker against each §5 mechanism, marking
  *blocked / raised-cost / not-addressed* — the same honest triage used in ANALYSIS.md §5.
- **Usability study (synthetic):** measure re-affirmation friction against window length; no
  human subject required — model it.

## 9. Conclusion

Dual-control enrolment is the strongest in-application answer to the consent gap, and
studying it sharpens the project's thesis rather than overturning it: making the subject a
required cryptographic party **helps** — it time-bounds access, enables independent
revocation, and produces a receipt the subject holds — but it ultimately relies on an
out-of-band root of trust the operator must not control. That is the same place the
analysis lands: durable consent enforcement lives in a layer above the application, which
is why platform supervision, not a self-hosted monitor, is the right tool for real-world
use.
