# Deployment guide

A single-owner, private YouTube viewing ledger: your laptops' browser extensions upload to one small server you run, and you read everything in one dashboard.

```
Laptop 1 (extension) ─┐
                      ├── HTTPS ── Caddy ── Node API (127.0.0.1:8443) ── SQLite file ── dashboard (same origin)
Laptop 2 (extension) ─┘
```

Nothing is public: there is no sign-up, every API route needs either the owner's session or an approved device's token, and the database is only reachable through the API.

## What you need

- A small always-on machine with a **persistent disk**: a $4–6/month VPS, or a machine at home (add a Cloudflare Tunnel instead of opening a port). SQLite is a single file, so this does not suit serverless platforms such as Vercel.
- A domain name pointing at it (for the TLS certificate).
- Node.js 20 or newer, and Caddy (or nginx) for HTTPS.

## 1. Install the server

```bash
git clone <your copy of this repo> /opt/watch-ledger && cd /opt/watch-ledger/server
npm ci --omit=dev
cp .env.example .env && chmod 600 .env
```

## 2. Fill in `.env`

Edit `.env` (every variable is explained inside it). Generate the two secrets yourself:

```bash
openssl rand -hex 32        # -> COOKIE_SECRET
openssl rand -base64 32     # -> MASTER_KEY
```

Set `BASE_URL` and `CORS_ORIGIN` to `https://your.domain`. **Copy `MASTER_KEY` to a password manager now**: every record is encrypted with it, and backups are useless without it.

## 3. Database migrations

Migrations are plain SQL files in `server/migrations/` and run automatically when the server starts. To run them by hand (for example before an upgrade):

```bash
npm run migrate
```

Upgrading an existing install: **back up first** (`node scripts/backup.js`), pull the new code, `npm ci --omit=dev`, restart. Migrations are additive. A device paired under extension v0.3 keeps working after the extension is updated; it adopts its existing credential and uploads anything not yet sent.

## 4. Create the owner account

There is no registration page or endpoint. The owner is created on the server, once; the database refuses a second one.

```bash
node --env-file=.env scripts/create-owner.js you@example.com      # prompts for a password (12+ characters)
node --env-file=.env scripts/create-owner.js --reset               # later: set a new password and sign out every session
```

## 5. Run it as a service

`/etc/systemd/system/watch-ledger.service`:

```ini
[Unit]
Description=Watch Ledger
After=network-online.target

[Service]
WorkingDirectory=/opt/watch-ledger/server
ExecStart=/usr/bin/node --env-file=.env src/server.js
Restart=on-failure
User=ledger
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/watch-ledger/server/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/watch-ledger ledger && sudo chown -R ledger /opt/watch-ledger/server
sudo systemctl enable --now watch-ledger
journalctl -u watch-ledger -f        # logs; look for "Server listening" and "backup (startup) written"
```

## 6. HTTPS with Caddy

`/etc/caddy/Caddyfile` (Caddy obtains and renews the certificate itself):

```
your.domain {
  reverse_proxy 127.0.0.1:8443
}
```

`.env` must have `TRUST_PROXY=true`. In production the server refuses to start without TLS or `TRUST_PROXY`, and it only listens on loopback behind the proxy. Open only ports 80 and 443 in the firewall.

Check it: `curl https://your.domain/api/health` should print `{"ok":true}`, and `curl -i https://your.domain/api/history` should be `401`.

## 7. Sign in

Open `https://your.domain`, sign in with the owner account. Overview will be empty until a device is paired.

## 8. Connect your first laptop, then the second

Do this once per laptop.

1. **Get the extension onto the laptop.** It is a Chrome extension loaded from this folder (there is no Web Store build). Copy the repo's top-level folder (the one containing `manifest.json`) to the laptop, open `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, and pick that folder.
2. **Make a pairing code.** Dashboard → **Devices** → name the device (for example "Laptop 2") → **Generate pairing code**. It works once and expires in 15 minutes.
3. **Pair.** On the laptop: extension icon → **Admin console** → **Private sync**. Enter `https://your.domain` and the code. Chrome asks permission to contact that one address; accept. Leave "also upload history already recorded" unticked unless you want older history on the server too.
4. **Approve.** The laptop now says *Waiting for the owner to approve this device* and shows a confirmation code like `5841-BB6A`. In the dashboard, the device appears at the top of Devices as **Awaiting approval** with the same code. Check they match, then **Approve device**. Nothing is uploaded before this.
5. **Verify.** Within about a minute the laptop's Admin console shows *Approved — syncing*, and the device card in the dashboard shows **Synced**. Watch a video for a minute and pause it: the session appears in **History** with the device's name.

To remove a laptop: Devices → **Revoke access** (cuts it off at once, keeps its data) or **Remove device** (also deletes its data). On the laptop, **Unpair** in the Admin console does the same from its side.

## What is protected, and what is not

- Records are AES-256-GCM encrypted in the database with `MASTER_KEY`; a copy of the database or a backup alone cannot be read. Timestamps, video ids and device names are not encrypted. Put the data directory on an encrypted disk if that matters to you.
- The extension holds one random per-device credential, in `chrome.storage.local`. Anyone who can read that browser profile can use it until you revoke the device. It holds no passwords, database credentials or shared secrets.
- Details and limits: [`SECURITY.md`](../SECURITY.md). Backup, restore and recovery: [`OPERATIONS.md`](OPERATIONS.md).
