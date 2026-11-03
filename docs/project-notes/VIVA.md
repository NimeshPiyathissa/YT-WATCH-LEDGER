# Demo & Viva Script — YouTube Watch Tracker

> **Project notes.** This is background material from the project's academic origins, kept for reference. It is not needed to install or run Watch Ledger. Start at the [README](../../README.md).

A ~10–12 minute presentation plan. Each demo step says **what to show**, **the point it proves**, and **where it's argued** (`ANALYSIS.md` / `WRITEUP.md` §). Everything runs on your own machine against **synthetic devices** (`server/scripts/sim-device.js`, which sends fabricated sessions and never reads anyone's browsing). State that up front.

---

## Before you present: rehearsal checklist

- [ ] `cd server && npm install` done; Node ≥ 20.
- [ ] Two terminals open in `server/`: **A** for the server, **B** for simulated devices.
- [ ] Run the whole demo sequence once end to end (it takes ~3 minutes).
- [ ] Delete any old `sim-devices.json` so enrolment starts clean.
- [ ] Have `docs/ANALYSIS.md` §4–5 open for the argument slides.
- [ ] **If you also want to show your own browser:** the extension-side steps in `DEMO.md` (loading unpacked, the enrolment screen, the permission prompt, the REC badge) were **not** executed during development. Rehearse them first, or keep them out of the live demo. The synthetic devices cover every server-side mechanism without that risk.

---

## Slide 0 — Framing (30s)
> "This is a YouTube watch-activity monitor: a local-first extension plus an optional self-hosted dashboard for enrolled devices. The engineering is a tested tracking core and a secure sync protocol. The real finding is that **authorised and unauthorised monitoring are the same program** — so I built it, then studied where consent can and can't live in code. I demo it against synthetic devices only."

Put the thesis on screen. It frames every later choice as deliberate.

## Slide 1 — Architecture (1 min)
```
YouTube player ─▶ content script ─▶ service worker ─▶ IndexedDB (device)
                                                   └─opt-in▶ sync ─▶ server DB (encrypted)
admin browser ─▶ web dashboard ─▶ server API ─▶ reads device data / enqueues commands
```
Talking points: local-first (works with no server); the pure `accounting.js` core is reused on the server, so local and remote numbers are computed by identical code (a test fails if the copies drift); sync is opt-in and revocable. (WRITEUP §2.)

## Slide 2 — Tests are green (30s)
```
node tests/session-logic.test.js      # 53 assertions: tracking core, stats, utils
node tests/sync-queue.test.js         # 33 assertions: sync selection, URL + command validation
cd server && npm test                 # 43 cases: auth, authz boundaries, sync, commands, retention, key rotation, device-client e2e
```
(On Node 24, `node --test server/test` no longer works; use `npm test` in `server/`.) Point: the core logic and the **authorisation boundaries** are tested, not assumed. Name the negative tests: cross-admin access denied on all six device routes, a device token can't reach admin routes, a revoked token is refused. (WRITEUP §6.)

---

## Live demo — ordered sequence

> Preface: "Nothing here is a real person. The devices are simulated and send fabricated sessions."

| # | Do this | Proves | Ref |
|---|---------|--------|-----|
| 1 | **Terminal A:** `node scripts/demo.js`. Note the printed dashboard address, demo login and first enrolment code. Open the dashboard, sign in. Mention: registration is closed as soon as an admin exists (`ALLOW_REGISTRATION=false` by default) | Bootstrap, then no one else can self-register | SECURITY.md; ANALYSIS §7 |
| 2 | Dashboard → Devices → **Generate code** (shown once; in terminal A, Enter prints another) | One-time, 15-minute enrolment code: a capability, not a password; stored hashed | WRITEUP §4.2 |
| 3 | **Terminal B:** `node scripts/sim-device.js --server http://127.0.0.1:8451 --code <CODE> --label "Lab laptop 1" --sessions 8` — repeat with fresh codes and labels for 2–3 devices; add `--hostile` to one | Enrolment issues a hashed device token; a small fleet appears | WRITEUP §4.2, §4.5 |
| 4 | Dashboard → **Devices** list: label, platform, status, last sync, video and session counts | Per-device identity and last-sync time | WRITEUP §4.3 |
| 5 | Open a device → totals, 14-day chart, top channels, history; click a video for its **session list** (start, end, watched) | The viewing layer; the same rollup math as the extension | WRITEUP §4.1, §4.3 |
| 6 | Queue **Pause tracking** (or **Set retention**) on that device | Command is *enqueued*, status `pending` | WRITEUP §4.4 |
| 7 | **Terminal B:** `node scripts/sim-device.js --label "Lab laptop 1"` — it pulls, applies and acks the command; table flips to `acked / ok`. Run it once more: with tracking paused it generates **no new sessions** | The command takes effect on the device and is acknowledged | WRITEUP §4.4 |
| 7a | Say it: "commands are **best-effort / polled** — next sync, not instant" | An honest limit, not a bug | WRITEUP §7; ANALYSIS §9 |
| 8 | Open the device that used `--hostile`: the title `<img … onerror=…>` and channel `<b>Evil</b>` render as **plain text** | Output escaping; injected markup is inert | WRITEUP §4.5 |
| 9 | Dashboard → device → **Revoke access** (two clicks), then re-run its `sim-device.js` → "server returned 403 (revoked)… forgetting its token" | Token invalidation stops sync immediately, and the device is told rather than left guessing | WRITEUP §4.5, §6 |
| 10 | Open the **audit log**: register, login, enrol-code, enrol, enqueue, revoke | Accountability trail | SECURITY.md |
| 11 | Teardown: Ctrl+C in terminal A (deletes the temporary DB); `rm sim-devices.json` | No data persisted; no subject involved | ANALYSIS §7 |

Keep 3→9 as the spine; drop 8/10 if short on time.

---

## Slide 3 — Security model (1 min)
Two columns:
- **Enforced & tested in code:** argon2id passwords; signed, `HttpOnly`, short-lived access cookie plus rotating refresh (reuse detection); device tokens stored hashed; **per-request ownership checks**; AES-256-GCM at rest with a tested rotation script; per-route rate limits; CORS lock, CSP and `Origin` check; output escaping; audit log.
- **Operator must provide (can't be enforced in code):** valid TLS certificate, encrypted disk, strong secrets, backups, creating the first admin immediately.

Point: `SECURITY.md` deliberately separates these. (WRITEUP §4.5.)

## Slide 4 — The core argument (2 min, the marks slide)
> "Transparency features inform the *subject*; they don't bind the *operator*, because the operator is the app's principal. The unenrol button only helps if the subject controls the device — which, in the abusive case, they don't. The software receives a code and an install ID; it can't know a human agreed, is the device's user, or still agrees. So consent isn't a value the program holds — it's a fact about the deployment."

| Control | Status | Why it's not enough |
|---|---|---|
| Visible indicator + unenrol | implemented | assumes the subject controls the device |
| Narrow scope + retention + opt-in history upload | implemented | harm reduction, not consent |
| Subject-readable log | partly (device's admin console shows server, last sync, last command) | useless if the subject doesn't know it exists |
| Periodic re-consent | not implemented | operator can automate past it |
| Dual-control enrolment | not implemented | moves a secret to the subject; key management is hard |
| Principal attestation (account/OS) | not implemented | works only *below* the app — the platform approach |

Land the line: **effective consent enforcement must live in a layer the operator doesn't control.** (ANALYSIS §4–5.)

## Slide 5 — Why real products differ (45s)
Family Link (account-level, provider-mediated supervised child account), MDM / Chrome Enterprise (device ownership + disclosed policy + acknowledgement), YouTube's supervised experiences. In each, authority sits **above or below** the app — account provider, device management, or law. A free-form self-hosted server has none of that, which is exactly why it's the risky form. (ANALYSIS §6; described at a general level, not a feature comparison.)

## Slide 6 — Ethics & methodology (45s)
> "I evaluated against synthetic clients, a test harness and a seeded dashboard, over localhost, and the demo database is deleted on exit. I didn't enrol a second person even with consent — because the system can't itself hold or verify that consent, the safe demonstration keeps a human subject out of it. That choice is the thesis applied to my own method."

Legality varies and is serious; lawful monitoring rests on ownership, a guardian relationship over a minor, or disclosed workplace policy. Not legal advice. (ANALYSIS §7.)

## Slide 7 — Limitations & future work (30s)
Player events ≠ attention; polled commands; consent stays external; the extension itself was not run in an automated browser test. Strongest next step isn't more features — it's prototyping dual-control enrolment and a subject-readable transparency mirror to measure how much they raise the bar against covert use. (ANALYSIS §9.)

---

## Q&A prep (anticipated questions → crisp answers)

- **"Couldn't someone use this as spyware?"** — Yes, and that's the point of the analysis: the code is identical for the consenting and non-consenting case. Consent must be enforced outside the app; §4–6 argue exactly that, which is why platform tools are the right vehicle for real supervision.
- **"Why not just use Family Link?"** — For real-world supervision you should; it binds the subject's role at the account layer. This project studies *why* an app can't, by building one and showing the gap.
- **"How do you know watch time is accurate?"** — It isn't validated against ground truth. It's measured from player state (playing, not ended, not an ad), with each one-second tick clamped, and the accounting is unit-tested. It doesn't track tab visibility and can't prove a human was watching; that caveat is in the README and ANALYSIS, not yet in the dashboards.
- **"Is the data safe on the server?"** — Records are encrypted at rest, authorisation is checked per request, tokens are hashed. But metadata isn't encrypted, and TLS, disk encryption, secrets and backups are operator responsibilities that the code can't provide; there's also no 2FA or password reset.
- **"Why synthetic data?"** — Methodological integrity: enrolling a real subject would make me the operator of the thing I'm critiquing. Synthetic devices demonstrate every server-side mechanism with no one's data.
- **"Did you test the extension in a browser?"** — The sync client logic ran end to end against the real server with faked browser storage, and the dashboard was checked in Chrome. The extension's own pages, content script and IndexedDB upgrade were not run in an automated browser test; that's listed as not covered.
- **"What would you change with more time?"** — Dual-control enrolment, a fuller subject mirror, 2FA and reset, Postgres, per-account rate limits, a tested TLS path, and a real-browser test of the extension.

---

### One-line takeaway to close on
> "The system works — but its safety doesn't come from the code. The same program serves a consenting lab and a non-consenting victim; the only difference lives in the deployment, not the software. Recognising that is the result."
