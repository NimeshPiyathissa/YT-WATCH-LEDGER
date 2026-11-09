# Releasing Watch Ledger

How a release is prepared, checked and published. Publishing (pushing, tagging, creating the GitHub release) is always a deliberate, manual step by the maintainer; no script here pushes, tags or uploads anything.

## 1. Version metadata

One version, written in four places that must agree (the release tool refuses to build otherwise):

| File | Field | Example (release candidate) | Example (final) |
|---|---|---|---|
| `manifest.json` | `"version_name"` | `0.8.0-rc.1` | `0.8.0` (or no `version_name`) |
| `manifest.json` | `"version"` (Chrome allows numbers only) | `0.8.0` | `0.8.0` |
| `server/package.json` | `"version"` | `0.8.0-rc.1` | `0.8.0` |
| `server/package-lock.json` | `"version"` and `packages[""].version` | `0.8.0-rc.1` | `0.8.0` |

`lib/sync.js` `FALLBACK_VERSION` equals `manifest.json`'s numeric `"version"`. Versions follow Semantic Versioning: `0.8.0-beta.1 < 0.8.0-rc.1 < 0.8.0-rc.2 < 0.8.0`. `update.sh` and the Updates page order them the same way, and `update.sh` installs every version into its own folder `releases/<version_name>`.

## 2. Build the assets

On a clean checkout of the commit to release (the tool refuses uncommitted changes):

```bash
cd server && npm ci && cd ..
node tools/build-release.mjs --out dist/release
```

It writes three files to `dist/release/` and checks them before it finishes:

| Asset | What it is |
|---|---|
| `watch-ledger-v<version>.tar.gz` | every file git tracks, under one top-level folder `watch-ledger-v<version>/`; what `update.sh --version` downloads and unpacks with `--strip-components=1`. File modes come from git (the scripts run directly are executable), owner root, timestamps from the commit, so the same commit builds the same bytes on any machine. |
| `yt-watch-tracker-v<version>.zip` | the Chrome extension, not tied to a server (the installer builds a configured copy on each server) |
| `SHA256SUMS` | `<sha256>  <file>` for both; read by `update.sh` and by `sha256sum -c SHA256SUMS` |

It refuses to build when the versions disagree, when a tracked file is something that must never ship (an `.env`, a key or certificate, a database, a backup, a log, `node_modules`, build output), when a file holds a private key or an access token, or when tracked files have uncommitted changes. `--allow-dirty` exists for the tests only; never publish such a build.

## 3. Check before publishing

- CI is green for the exact commit (see *CI* below).
- `cd dist/release && sha256sum -c SHA256SUMS`.
- On a test server (or the installer sandbox): `sudo bash scripts/update.sh --from-tarball dist/release/watch-ledger-v<version>.tar.gz --sha256 <hash from SHA256SUMS> --dry-run`. The installer suite already checks that both the current and v0.7.0's `update.sh` accept the tarball.
- The release checklist in the issue tracker (VPS install, update from the previous release, rollback, real Chrome) is done.

## 4. Publish (maintainer, by hand)

1. Tag the released commit: `git tag -a v<version> -m "v<version>"` and push the tag.
2. Create the GitHub release for that tag and upload exactly the three assets.
3. **Pre-release or not:** a release candidate (`-rc.N`, `-beta.N`) **must** be marked *pre-release*; a final version **must not** be. `update.sh --check` and the Updates page treat GitHub's pre-release flag as authoritative: a final release left marked as a pre-release is never offered to stable servers.
4. Release notes: from `CHANGELOG.md`, plus the upgrade notes in `docs/UPGRADING.md` (for v0.8.0: the v0.7.0 servers must run `sudo bash scripts/update.sh --version ...`).
5. Do not edit or re-upload assets of a published release: servers verify them against `SHA256SUMS`. Publish a new version instead.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, `master` and `release/**`, on pull requests, and by hand (*workflow_dispatch*). It runs the syntax checks, the extension tests, the server suite (which includes the installer suite with the Linux-only update and rollback runs, and the release packaging tests), the shell lint, the documentation links, the dependency audit and the extension ZIP check, on Ubuntu 24.04 with Node.js 22. A development branch such as `develop/v0.8.0` is checked by starting the workflow by hand on that branch (`gh workflow run ci.yml --ref develop/v0.8.0`).
