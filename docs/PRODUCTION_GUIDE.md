# Production operations guide

Task-by-task procedures for a server installed with `scripts/install.sh` (layout in [VPS_DEPLOYMENT.md](VPS_DEPLOYMENT.md#5-where-things-live)).

> **How "verified" these are.** The scripts behind these commands are tested in a sandbox (see [VPS_DEPLOYMENT.md](VPS_DEPLOYMENT.md)). The *expected output* shown below describes what the code prints; it has **not been observed on a real VPS yet**. Wording may differ slightly. Commands that act on `systemd`, `nginx`, `certbot` and `ufw` are standard Ubuntu usage.

Shorthand: `ENV=/etc/watch-ledger/watch-ledger.env`, app directory `/opt/watch-ledger/current/server`.

## Fresh installation
[VPS_DEPLOYMENT.md](VPS_DEPLOYMENT.md): `sudo bash install.sh`.

## Update an existing installation
```bash
sudo ./scripts/update.sh --check              # is a newer release available?
sudo ./scripts/update.sh --version v0.8.0     # backup → install beside old → migrate → switch → health check
```
Expected: a "BACKUP" line naming a file in `backups/pre-update/`, "Migrations applied", "The service is healthy". On failure the previous **code** is switched back automatically and the message names the pre-update backup. Details: [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md#updating).

## Database migration
Migrations are applied automatically at service start, by the installer and by `update.sh`. To run them by hand (take a backup first; migrations are one-way):
```bash
sudo ./scripts/backup.sh
cd /opt/watch-ledger/current/server && sudo -u watchledger /opt/watch-ledger/node/bin/node --env-file=/etc/watch-ledger/watch-ledger.env src/migrate.js
```

## Backups and restore
`sudo ./scripts/backup.sh`, `sudo ./scripts/restore.sh <file>`: see [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md). Also available: the dashboard's *Data & backups* page.

## Change the administrator password
```bash
cd /opt/watch-ledger/current/server
sudo -u watchledger /opt/watch-ledger/node/bin/node --env-file=/etc/watch-ledger/watch-ledger.env scripts/create-owner.js you@example.com --reset
```
It prompts for the new password (hidden, 12+ characters), then signs out **every** session. The installer never resets an existing administrator on re-run; the email address of the single owner is fixed once created.

## Change the domain
1. Point the new name's DNS at the server ([DOMAIN_SETUP.md](DOMAIN_SETUP.md)).
2. Get a certificate: `sudo certbot certonly --webroot -w /var/www/letsencrypt -d new.example.com`.
3. In `/etc/nginx/sites-available/watch-ledger` replace the old domain with the new one (`server_name` and the two `/etc/letsencrypt/live/<domain>/` paths), then `sudo nginx -t && sudo systemctl reload nginx`.
4. In `/etc/watch-ledger/watch-ledger.env` set `BASE_URL=https://new.example.com` and `CORS_ORIGIN=https://new.example.com`, then `sudo systemctl restart watch-ledger`.
5. **Re-pair or rebuild extensions.** An extension built with `--server` for the old domain, and paired devices, point at the old address. Build a new ZIP (`node tools/build-extension.mjs --server https://new.example.com`) and re-pair.

Do not touch `MASTER_KEY` or the database.

## Renew SSL certificates
Automatic (certbot timer). Manual check: `sudo certbot renew --dry-run` (expected: "Congratulations, all simulated renewals succeeded"). Force: `sudo certbot renew --force-renewal && sudo systemctl reload nginx`. See [SSL_SETUP.md](SSL_SETUP.md).

## Update the Chrome extension
Build a new ZIP (`update.sh` does it for you into `/var/lib/watch-ledger/extension/`), unzip over the **same folder** the extension was loaded from, then `chrome://extensions` → reload. Keep the folder path stable or the extension ID changes and pairing is lost: [EXTENSION.md](EXTENSION.md).

## Check the logs
```bash
journalctl -u watch-ledger -n 100 --no-pager      # application
journalctl -u watch-ledger -f                      # follow
sudo tail -n 50 /var/log/nginx/error.log           # nginx
sudo tail -n 50 /var/log/watch-ledger-install.log  # installer
```
Look for `Server listening`, `backup (startup) written`, and `BACKUP FAILED:` / `housekeeping failed`.

## Diagnose a server failure
```bash
./scripts/health-check.sh                 # exit 0 ok, 1 warnings, 2 critical; names the failing check
systemctl status watch-ledger --no-pager
sudo nginx -t
curl -s http://127.0.0.1:8787/api/health   # expected: {"ok":true}  (use your PORT)
df -h /var/lib/watch-ledger; free -m
```
Common causes: full disk, a missing or invalid setting in the env file (the log names it), an expired certificate, port 80/443 blocked. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Recover after a power outage or crash
The service is `Restart=on-failure` and enabled at boot, nginx and certbot's timer are enabled too, and SQLite recovers its journal on start. After the machine is back:
```bash
systemctl is-active watch-ledger nginx    # expected: active, active
./scripts/health-check.sh
```
If the service did not start, read `journalctl -u watch-ledger -n 80`. If the database reports corruption, restore the newest backup ([BACKUP_RECOVERY.md](BACKUP_RECOVERY.md#restore)). Browsers queue their data offline and upload it after the server returns.

## Uninstall
This removes the application. **It deletes your data if you include the last step, so take a backup and copy it off the server first.**
```bash
sudo ./scripts/backup.sh --dest /some/other/disk      # keep a copy, and keep MASTER_KEY somewhere safe
sudo systemctl disable --now watch-ledger
sudo rm /etc/systemd/system/watch-ledger.service /etc/nginx/sites-enabled/watch-ledger /etc/nginx/sites-available/watch-ledger
sudo systemctl daemon-reload && sudo nginx -t && sudo systemctl reload nginx
sudo rm -rf /opt/watch-ledger                          # code and private Node.js only
# Only when you are certain you no longer need the data or the keys:
# sudo rm -rf /var/lib/watch-ledger /etc/watch-ledger && sudo userdel watchledger
# Optional: sudo certbot delete --cert-name your.domain ; sudo ufw delete allow 80/tcp ; sudo ufw delete allow 443/tcp
```
There is no uninstall script on purpose: nothing destructive runs unattended.
