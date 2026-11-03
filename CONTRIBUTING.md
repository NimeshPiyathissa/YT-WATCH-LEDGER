# Contributing

Thanks for your interest. Watch Ledger records viewing activity, so changes that weaken **visibility, consent, or security** will not be accepted: the tracking indicator, the visible connection state, the owner-only controls and the encryption at rest are part of the design.

## Setup

```bash
git clone https://github.com/NimeshPiyathissa/YT-WATCH-LEDGER.git
cd YT-WATCH-LEDGER/server && npm ci
```

Node.js 20+ (22 recommended). No database or services are needed; tests use in-memory or temporary databases.

## Tests

```bash
# extension (from the repository root)
for f in tests/*.test.js; do node "$f"; done
# server and installer suite
cd server && npm test            # uses --test-concurrency=1; the installer suite needs bash
# documentation links
node scripts/check-links.mjs
# shell scripts (if shellcheck is installed)
shellcheck -S warning scripts/*.sh scripts/lib/*.sh
```

Never run tests against a real database or with real keys.

## Shared code

`lib/playback.js`, `lib/util.js`, `lib/accounting.js` and a few others are copied into the server by `node server/scripts/sync-shared.js`. Edit the originals in `lib/`, then run the script; a test fails if the copies drift.

## Pull requests

- One topic per PR; add a test that fails without your change.
- Match the surrounding code style; keep comments short and explain *why*.
- Update the docs and `CHANGELOG.md` when behaviour changes.
- Never commit secrets, `.env` files, databases or backups. Report vulnerabilities privately per [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
