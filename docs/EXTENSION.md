# Extension build, update and stable ID

## Building

```bash
node tools/build-extension.mjs [--out dist] [--server https://tracker.example.com] [--key-file public-key.pem]
```

| Option | What it does |
|---|---|
| `--out` | Output folder (default `dist/`, git-ignored). |
| `--server` | Bakes one server address into `lib/build-config.js`; the popup then only asks for the pairing code. https only (plain http for `localhost`). |
| `--key-file` | A **public** key (PEM or bare base64) that becomes the manifest `key`, giving a stable extension ID. A private key is refused and nothing is written. |

The build:

- packages only an allowlist (`manifest.json`, `background.js`, `content/`, `lib/`, `popup/`, `dashboard/`, `settings/`, `admin/`, `icons/`), never `server/`, tests, docs, databases or `.env` files;
- fails if the manifest is not Manifest V3, if its version differs from the version in `lib/sync.js` (what the extension reports to the server), or if any file the manifest, the background script or a page refers to is missing;
- scans the output for private keys, `.env`/database/key files and credential-like text, and fails if it finds any;
- is reproducible: the same sources and options give a byte-identical ZIP (the `.sha256` file lets you check a copy).

**Releasing a new version:** change `"version"` in `manifest.json` **and** `FALLBACK_VERSION` in `lib/sync.js` to the same value (the build refuses to continue if they differ), then run the build. The dashboard shows each device's version, so you can see which laptops have updated.

Test commands (run one at a time on a low-memory machine):

```bash
node tests/session-logic.test.js
node tests/sync-queue.test.js
cd server && node --test --test-concurrency=1 "test/**/*.test.js"
```

## Updating an installed extension

Settings, the pairing and the recorded history live in the browser profile's extension storage (`chrome.storage.local` and IndexedDB), which is **kept when the extension is reloaded or updated, as long as its ID stays the same**.

1. Build the new version.
2. Unzip it **over the same folder** the extension is loaded from (replace the files; don't create a new folder).
3. Open `chrome://extensions` and click the reload icon on the extension.
4. The extension keeps its pairing, reconnects, and reports its new version; the device card in the dashboard updates within a minute. The Admin console's Diagnostics log shows *extension updated*.

For an unpacked extension, Chrome derives the ID from the **folder path**. If you load it from a different folder, Chrome treats it as a **different extension**: its storage starts empty, including the pairing, settings and local history, and the dashboard sees a new device (the old one still shows, offline). To avoid that, keep the folder path fixed, or give the extension a stable ID as below.

## Setting up a stable extension ID (optional, recommended before sharing builds)

No key is configured in this repository. To add one yourself:

```bash
# 1. Make a key pair. Keep key.pem PRIVATE: store it in a password manager or secure drive, never in this repo.
openssl genrsa -out key.pem 2048
# 2. Extract the public key (this is the only part the build uses).
openssl rsa -in key.pem -pubout -out public-key.pem
# 3. Build with it. The command prints the resulting extension ID.
node tools/build-extension.mjs --key-file public-key.pem
```

The ID printed by the build is the same on every machine and every rebuild, so updates keep settings and the pairing regardless of the install folder. `*.pem` is already git-ignored here; do not commit either file. Only the public key goes into the build, and the build refuses a private key. Whoever holds `key.pem` can publish packages with your extension's ID, so treat it like a signing key. (Switching an existing install to a keyed build changes its ID once, so that one install starts with empty storage and must pair again.)

## Servers and the baked address

A build made with `--server` only changes the popup's first-time screen. The extension still asks Chrome for permission to contact that address when pairing, and the server still needs a valid pairing code. Don't bake an address into a build you give to someone else's server.

## What the extension stores

`chrome.storage.local` holds the pairing credential for the current session (`device_refresh`, readable by anyone with access to the browser profile until the admin revokes it), the server address, the device name, the session id, the state of any session-deletion request, and the last managed configuration the owner pushed (`managed_config`: version, values, applied or failed). It also briefly holds what you typed while pairing (`pair_draft`, including the one-time code) so it survives Chrome closing the popup for the permission prompt; it is removed after a successful pairing but remains if you never retry. None of these are included in a build.
