# Operations: backups, restore, recovery

All commands run in `server/` on the server, with the same `.env` as the service (`node --env-file=.env ...`).

## Backups

- **Automatic:** the server writes a verified backup at start-up (if the newest is older than `BACKUP_INTERVAL_HOURS`) and then every `BACKUP_INTERVAL_HOURS` (default 24), keeping the newest `BACKUP_KEEP` (default 14) in `BACKUP_DIR`.
- **On demand:** dashboard → **Data & backups** → **Back up now**, or `node --env-file=.env scripts/backup.js`. Both are safe while the server is running (they use SQLite's online backup API, then integrity-check the copy).
- Each backup is **one self-contained `.db` file** (`tracker-YYYYMMDDTHHMMSSZ.db`). Its records are still encrypted with `MASTER_KEY`.

**Copy backups off the machine.** `BACKUP_DIR` defaults to the same disk as the database, which does not protect you from losing the disk. Pick one:

```bash
# nightly, from another machine you own (cron):
rsync -a --delete you@your.domain:/opt/watch-ledger/server/data/backups/ ~/watch-ledger-backups/
# or from the server to object storage:
rclone sync /opt/watch-ledger/server/data/backups remote:watch-ledger-backups
```

Store `MASTER_KEY` separately (password manager). **A backup without its `MASTER_KEY` cannot be read, and that is by design.**

## Restore

1. Stop the service: `sudo systemctl stop watch-ledger`.
2. List backups and restore one (the backup is integrity-checked first, and the current database is copied aside as `<db>.pre-restore-<time>`):

   ```bash
   node --env-file=.env scripts/restore.js                       # lists backups
   node --env-file=.env scripts/restore.js ./data/backups/tracker-20261019T060000Z.db --yes
   ```
3. Start the service: `sudo systemctl start watch-ledger`. If the backup came from an older version, the missing migrations run automatically.
4. The `.env` must hold the **same `MASTER_KEY`** the backup was written under; otherwise the dashboard shows errors instead of history.

Devices need no action after a restore. Anything they uploaded after the backup was taken is gone from the server, but each laptop still has its own local copy; to re-upload it, unpair and pair again with "upload history" ticked.

**Practise this once** on a throwaway copy before you need it. (It was exercised on a dev database during development: 161 sessions wiped, restored, 161 back.)

## Rotate `MASTER_KEY`

See "Key rotation procedure" in [`SECURITY.md`](../SECURITY.md) (`scripts/rotate-key.js`). Take a backup first.

## Forgot the owner password

On the server: `node --env-file=.env scripts/create-owner.js --reset`. It signs out every session.

## A laptop is lost or stolen

Dashboard → Devices → **Revoke access**. The next request from that laptop, even with a token that has not expired, is refused with 403. Nothing more can be uploaded and nothing can be read through its credential. Then **Remove device** if you also want the data it uploaded deleted.

## Retention

- Server copy: dashboard → Data & backups → **Retention on the server** (or per-device retention commands). Older sessions are removed immediately and re-checked hourly.
- Never-approved pairing requests expire automatically; pairing codes expire after 15 minutes.
- Backups are pruned by count (`BACKUP_KEEP`), not age. Note that a backup can still contain data you later deleted from the live database, until it is pruned.

## Health checks

- `GET /api/health` → `{"ok":true}`.
- Dashboard → Devices shows each device's last upload and how many events are still waiting on it. **Offline** only means no upload in the last 15 minutes (a closed laptop looks like this). A device that stays Offline while its laptop is open: check the extension's Admin console, which shows the last error.
- `journalctl -u watch-ledger` shows `BACKUP FAILED:` and `housekeeping failed` lines if those jobs break.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Laptop stuck on "Waiting for the owner to approve" | Approve it in Devices. The confirmation codes must match. |
| "That code is invalid, expired or already used" | Codes work once and last 15 minutes. Generate a new one. |
| Laptop shows "The owner revoked/removed this device" | You did. Pair again with a new code if intended. |
| Pending uploads keep growing | The server is unreachable from that laptop; events stay queued on the laptop and upload when it can connect. |
| Server exits at start | The message names the missing or invalid variable (`COOKIE_SECRET`, `MASTER_KEY`, TLS settings). |
