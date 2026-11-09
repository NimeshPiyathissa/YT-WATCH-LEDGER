# Backup & recovery

## What to protect

| Item | Why | Where |
|---|---|---|
| **`MASTER_KEY`** | Every stored record is encrypted with it. **Lose it and the data is unreadable, even from a perfect backup.** | `/etc/watch-ledger/watch-ledger.env` |
| `COOKIE_SECRET` | signs login cookies (losing it only signs everyone out) | same file |
| The database | the data | `/var/lib/watch-ledger/data/tracker.db` |

Keep a copy of `MASTER_KEY` in a password manager, **separately from the backups**. The installer never prints it.

## Backups

- **Automatic:** the server writes a verified daily backup to `/var/lib/watch-ledger/backups/` and keeps the newest 30.
- **On demand:** `sudo ./scripts/backup.sh` writes to `/var/lib/watch-ledger/backups/manual/` (never pruned). `--dest /mnt/usb` also copies it elsewhere with a checksum check.
- **Before every update:** `update.sh` backs up into `backups/pre-update/` (never pruned). The dashboard's **Updates** page lists them and can verify each one ([UPDATES.md](UPDATES.md)).
- Safe while the server runs. No script ever deletes a backup.
- `--with-keys --dest D` additionally writes the two secrets to `D` (mode 0600). Do this only onto storage you trust; it defeats the separation above.

Copy backups off the server regularly (`scp`, `rsync`, object storage).

## Restore

```bash
sudo ./scripts/restore.sh --list
sudo ./scripts/restore.sh /var/lib/watch-ledger/backups/manual/<backup-file>.db
```

The backup is integrity-checked, you must type `RESTORE`, the service is stopped, the **current database is copied aside** (`tracker.db.pre-restore-<time>`), the backup is put in place, and the service restarts. It can only be read with the `MASTER_KEY` that wrote it.

### Checking a backup before you restore it

In the dashboard, **Data & backups -> Verify** next to a backup checks it without changing anything: SQLite's integrity check, whether it was made by the same, an older or a **newer** release, and whether this server's `MASTER_KEY` can read it. From a terminal: `node server/scripts/restore.js <file> --inspect` (exit code 0 when it can be restored).

`restore.sh` runs the same checks and **refuses** a backup that:
- fails the integrity check;
- was made by a newer release than the one installed (upgrade first; an older backup is fine and its missing upgrade steps run at start);
- holds records this server's `MASTER_KEY` cannot decrypt (restoring it would look successful and show nothing). Pass `--allow-wrong-key` to `server/scripts/restore.js` only if you are about to put the right key back.

The restore itself is written next to the database under a temporary name, checked against the backup, and only then renamed into place, so a full disk or a crash part-way leaves the current database as it was. The safety copy (`tracker.db.pre-restore-<time>`) includes writes that had not yet been merged from the write-ahead log. Restoring stays an offline command: the dashboard can verify backups but never replaces the live database.

Interrupted backups: a crash can leave `tracker-<time>.db.partial`. These are never listed as backups and are removed automatically once they are over an hour old.

### Restoring onto a new server

1. Run the installer on the new server (so the app, nginx and certificate exist).
2. Stop it: `sudo systemctl stop watch-ledger`.
3. Put the **old `MASTER_KEY`** into `/etc/watch-ledger/watch-ledger.env`, replacing the generated one. This is the one time you edit it by hand.
4. Copy the backup over and run `restore.sh`.
5. Start the service and run `./scripts/health-check.sh`.

## Updating

```bash
sudo ./scripts/update.sh --check
sudo ./scripts/update.sh --version v0.8.0
```

Order: verify the release checksum → **backup** → install beside the old release → stop → migrate → switch → start → health check. If the health check fails, the **code** rolls back to the previous release automatically (the last 3 are kept). The database is never restored automatically; if a migration had completed and you need the old data layout, restore the `pre-update` backup (migrations are one-way).

## If something was interrupted

| Situation | Do this |
|---|---|
| Installer stopped midway | `sudo ./scripts/install.sh --resume` (nothing is overwritten) |
| Update failed and rolled back | Read the message; the service is on the previous release. Fix the cause and retry. |
| Update failed and the service is down | `journalctl -u watch-ledger -n 80`; `ls /opt/watch-ledger/releases`; point `current` at the previous release (`sudo ln -sfn /opt/watch-ledger/releases/<old> /opt/watch-ledger/current`) and `sudo systemctl restart watch-ledger`; restore the pre-update backup only if the database is damaged |
| Database damaged | `restore.sh` with the newest good backup |
| Lost `MASTER_KEY` and no copy | The encrypted data cannot be recovered. Start fresh. |

Rotating the key (optional, advanced): `server/scripts/rotate-key.js` re-encrypts every table; take a backup first.
