# Deploy on an Ubuntu VPS (guided installer)

`scripts/install.sh` turns a fresh Ubuntu 22.04 / 24.04 server into a running, HTTPS-protected Watch Ledger. It is interactive, can be re-run safely, and can resume if interrupted.

> **Tested vs. not tested.** The installer's logic (validation, key generation, configuration, database setup, backup/restore/update rules, DNS check, dry-run plan) is covered by an automated sandbox suite (`server/test/installer.test.js`, 102 checks). The steps that need a real machine (`apt`, `systemd`, `nginx`, `certbot`, `ufw`) are shell-checked and dry-run planned but **have not been executed on a real VPS by the project's author**. Run `--dry-run` first, and report any problem.

## 1. Prepare

1. Create the server and note its public IP.
2. Point your domain at it and wait for DNS to update: [Domain setup](DOMAIN_SETUP.md). (The installer checks this itself before asking Let's Encrypt for a certificate, and tells you what is wrong if it isn't ready.)
3. SSH in as a user with `sudo`.

## 2. Get the code

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/NimeshPiyathissa/YT-WATCH-LEDGER.git
cd YT-WATCH-LEDGER
```

To pin a release instead of the latest default branch: `git checkout v0.7.0`.

## 3. Preview, then install

```bash
sudo ./scripts/install.sh --dry-run     # prints what it would do; changes nothing
sudo ./scripts/install.sh               # the wizard
```

The wizard has eight steps:

| # | Step | What happens |
|---|---|---|
| 1 | System check | OS, root, memory, disk |
| 2 | Admin account | Your email (also your login) and a strong password. Typed hidden, never echoed, never put on a command line. |
| 3 | Domain | The domain you pointed at the server |
| 4 | Database | Creates the encrypted SQLite database and the owner account |
| 5 | Application | Installs Node.js 22 (checksum-verified, private copy), the app, and a hardened `systemd` service that restarts automatically |
| 6 | SSL | nginx + DNS verification + a Let's Encrypt certificate with automatic renewal; optional `ufw` firewall (SSH, 80, 443 only) |
| 7 | Extension | Builds the Chrome extension already configured for your domain |
| 8 | Verification | Health checks, then a summary with the dashboard URL |

Password rules: at least 12 characters, upper and lower case, a digit and a symbol, no long repeated runs. The installer generates `MASTER_KEY` and `COOKIE_SECRET` itself.

### Non-interactive (automation)

```bash
sudo WL_ADMIN_EMAIL=you@example.com WL_ADMIN_PASSWORD='your-strong-password' \
  ./scripts/install.sh --non-interactive --domain tracker.example.com \
  --letsencrypt-email you@example.com --agree-tos
```

Passwords are accepted only through the environment (or stdin), never as an option.

## 4. If it stops

- **DNS not ready** (exit code 3): fix the record, wait, then `sudo ./scripts/install.sh --resume`. Nothing is lost.
- **Any other failure**: the message says which step failed and why. Fix it and run `--resume`. The log is `/var/log/watch-ledger-install.log`.
- Re-running is safe: an existing `MASTER_KEY`, configuration or database is **never** regenerated or overwritten.

## 5. Where things live

| Path | Contents |
|---|---|
| `/opt/watch-ledger/releases/<version>/` | application code (the `current` symlink points at the active one) |
| `/opt/watch-ledger/node/` | the private Node.js |
| `/etc/watch-ledger/watch-ledger.env` | configuration and secrets (mode 0640, root:watchledger) |
| `/var/lib/watch-ledger/data/tracker.db` | the database |
| `/var/lib/watch-ledger/backups/` | the server's rolling daily backups (`manual/` and `pre-update/` are never pruned) |
| `/var/lib/watch-ledger/update-history.jsonl` | one line per update attempt made with `update.sh` (no secrets); shown on the dashboard's Updates page |
| `/var/lib/watch-ledger/extension/` | the built extension ZIP and unpacked folder |

Service: `systemctl status watch-ledger`, logs: `journalctl -u watch-ledger -f`.

## 6. Day-two operations

| Task | Command |
|---|---|
| Health check | `./scripts/health-check.sh` |
| Backup now | `sudo ./scripts/backup.sh` |
| Restore | `sudo ./scripts/restore.sh --list`, then `sudo ./scripts/restore.sh <file>` |
| Update | `sudo ./scripts/update.sh --check`, then `sudo ./scripts/update.sh --version vX.Y.Z` |

Details and recovery scenarios: [Backup & recovery](BACKUP_RECOVERY.md). Certificates: [SSL setup](SSL_SETUP.md).
