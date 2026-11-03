# Extension setup

The extension is a Manifest V3 Chrome extension (Chrome **116+**; Chromium-based browsers that load unpacked extensions also work). It is **not on the Chrome Web Store**: you install it in Developer mode from a ZIP.

## Get the ZIP

- **From a GitHub release:** download `yt-watch-tracker-v<version>.zip` and `SHA256SUMS`. Verify it (`sha256sum -c SHA256SUMS --ignore-missing` on Linux/macOS, or `Get-FileHash` in Windows PowerShell, and compare). This generic build asks for your server address when pairing.
- **From your own server:** the installer already built one configured for your domain: `/var/lib/watch-ledger/extension/yt-watch-tracker-v<version>.zip` (copy it with `scp`).
- **Build it yourself:** `node tools/build-extension.mjs [--server https://your.domain]` → `dist/`.

## Install

1. Unzip into a **permanent** folder (not Downloads/Temp; do not move it later).
2. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose the folder that directly contains `manifest.json`.
3. Pin the icon from the puzzle-piece menu.

More detail, updating, and a stable extension ID: [INSTALL.md](INSTALL.md), [EXTENSION.md](EXTENSION.md).

## What it asks for

| Permission | Why |
|---|---|
| `storage` | settings and pairing state |
| `alarms` | sync timer and connection check (does nothing unless paired) |
| `https://www.youtube.com/*` | to observe playback on YouTube, and nothing else |
| optional: your server's origin | requested at pairing time, for that one server only, removed on unpair |

There is no remote code and no analytics. The tracking indicator (`REC` badge) is always visible.

Next: [pair the device](DEVICE_PAIRING.md).
