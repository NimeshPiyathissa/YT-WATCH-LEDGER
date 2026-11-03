# Submission Index — YouTube Watch Tracker

> **Project notes.** This is background material from the project's academic origins, kept for reference. It is not needed to install or run Watch Ledger. Start at the [README](../../README.md).

A consent-aware YouTube activity monitor (local-first Chrome extension + optional
self-hosted admin backend), built to study a single question: **where can consent to
monitoring be enforced — in the software, or only in the deployment around it?**

**Headline result.** The authorised and unauthorised versions of this system are the
*same program*. Consent is a fact about the deployment that the code can neither hold nor
verify; durable enforcement must live in a layer the operator doesn't control (account
provider, OS, or law). The build demonstrates the engineering; the analysis argues the
limit; the demo runs against synthetic devices only, so no real person is ever a subject.

---

## Start here (suggested reading order for a marker)

1. **This file** — what's included and how to run it.
2. **[`ANALYSIS.md`](ANALYSIS.md)** — the core argument: why consent can't live inside the app, which controls partly help, and how real products (Family Link, MDM) differ.
3. **[`WRITEUP.md`](WRITEUP.md)** — the systems report: architecture, data model, sync protocol, security model, testing, limitations.
4. **[`DUAL_CONTROL.md`](DUAL_CONTROL.md)** — future-work *design study* (not implemented): making the subject a required cryptographic party to enrolment, and why even that leans on an out-of-band root of trust (evidence *for* the thesis).
5. **[`SECURITY.md`](../../SECURITY.md)** — controls the code enforces and tests vs. assurances only the operator can provide.
6. **[`VIVA.md`](VIVA.md)** — the live-demo / presentation script and Q&A prep.

---

## Deliverables

| Artifact | What it is | Why it matters |
|---|---|---|
| `manifest.json`, `background.js`, `content/`, `lib/`, `popup/`, `dashboard/`, `settings/`, `admin/` | The Chrome extension (MV3): content-script tracker, service worker, local dashboard, settings, local admin console | The working, local-first monitor; runs with no server |
| `server/` | Node/Fastify backend: admin accounts, enrolment, idempotent sync, command queue, encrypted-at-rest storage, web dashboard (`server/web/`) | The optional remote-admin layer; subject of the security and consent analysis |
| `server/scripts/sim-device.js` | Synthetic device client (fabricated sessions, `--hostile` HTML/script payloads) | Lets the demo show a fleet, sync, commands and escaping with **no real data** |
| `server/scripts/demo.js` | One-command local demo server (temporary DB and secrets, first admin, enrolment code) | Reproducible demo setup; deletes its data on exit |
| `docs/DEMO.md` | Runbook for enrolling your own browser against the local demo server | Reproduce the extension-side flow on one machine |
| `VIVA.md` | 10–12 min presentation script + Q&A prep | Maps each demo step to a concept and a report section |
| `WRITEUP.md` | Systems-level report | The engineering write-up |
| `ANALYSIS.md` | Consent / threat-model analysis | The academic contribution |
| `DUAL_CONTROL.md` | Dual-control enrolment design study | Strongest in-app answer to the consent gap, with honest limits |
| `SECURITY.md` | Security checklist | Separates what the code guarantees from what it can't |
| `README.md` | Project overview, permissions, data flow, limitations | Entry point for the code |

## How to run

All commands from this folder (the one containing `manifest.json`).

**Tests** (offline; no network, no real data):
```bash
node tests/session-logic.test.js          # tracking core: 53 assertions
node tests/sync-queue.test.js             # sync selection and validation: 33 assertions
cd server && npm install && npm test      # auth, authz, sync, commands, retention, rotation, device-client e2e: 43 cases
```
(On Node 24, `node --test server/test` no longer works; use `npm test` inside `server/`.)
Counts above were last confirmed in the final development session; re-run to confirm on your machine.

**Demo** (one machine, synthetic fleet), two terminals in `server/`:
```bash
node scripts/demo.js        # terminal A: starts the server, creates the first admin, prints a login and an enrolment code
node scripts/sim-device.js --server http://127.0.0.1:8451 --code <CODE> --label "Lab laptop 1" --sessions 8   # terminal B
```
`demo.js` does the setup (secrets, migrations, first admin, closing registration) itself; the
port defaults to 8443, so use `PORT=8451` or adjust `--server`. Then walk the dashboard per
`VIVA.md`. Ctrl+C in terminal A deletes the temporary database; delete `sim-devices.json`
afterwards. To enrol your own browser instead, follow `docs/DEMO.md`.

**Extension**: `chrome://extensions` → Developer mode → Load unpacked → select this folder.

## What's covered / not covered

- **Covered by automated tests:** tracking accounting, stats and utilities; sync selection,
  cursor and validation logic; authentication (including refresh-token reuse detection);
  authorisation boundaries (cross-admin access denied, device/admin token separation,
  revoked and deleted devices refused); idempotent sync and recomputed rollups; encryption at
  rest; the command lifecycle; retention mirroring; key rotation; and the real extension sync
  client against the real server (with faked browser storage).
- **Checked manually in Chrome:** the web dashboard (sign-in, device list and page, controls,
  audit log, inert rendering of hostile titles) against a locally seeded server.
- **Not run in a browser:** the extension itself (content script, service worker, popup,
  admin console, enrolment screen and permission prompt, the IndexedDB v1→v2 upgrade).
  Rehearse once live before presenting.
- **Not implemented:** dual-control enrolment (design study only), periodic re-consent,
  2FA / password reset, a tested production TLS path, Postgres.

## Methodology note

Evaluation used synthetic device clients (a test harness and the simulator) over localhost;
the demo database is temporary and deleted on exit. No third party's data was collected — a
deliberate choice that applies the analysis's thesis to the project's own method.

## Before submitting

- [ ] Rehearse `VIVA.md` once as a single timed run (timing was not validated end to end).
- [ ] Verify the citations in `WRITEUP.md` and `ANALYSIS.md` — they were drafted from memory.
- [ ] Re-run the three test suites and paste the counts into the viva.
- [ ] Rehearse any extension-in-browser steps you plan to show live (they were never executed during development).
- [ ] Leave `server/node_modules/` out of the archive (recreate with `npm install`); this folder is not a git repository, so there is no `.gitignore` protecting it.
- [ ] Confirm no demo database, `.env`, or `sim-devices.json` is included (none were present at last check) and `ALLOW_REGISTRATION=false` in any `.env` you ship.
