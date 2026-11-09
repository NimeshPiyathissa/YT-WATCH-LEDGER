# Upgrading from v0.7.0 to v0.8.0 (release candidate v0.8.0-rc.1)

> **Status.** v0.8.0-rc.1 is a **release candidate**: published (when it is) as a GitHub *pre-release*, for testing before v0.8.0. Everything below is what the code does and what the automated tests check in a sandbox. Updating a real server and rolling it back have **not** been done on a VPS yet. Take an off-server copy of your backups first.

## What changes for you

- **Database:** three migrations, all additive. No existing row or column is changed or removed; each runs in a transaction and is applied once, at the first start of the new release (or by `update.sh` before it switches).

  | Migration | Adds | For |
  |---|---|---|
  | `007_device_consents_sync_diagnostics.sql` | consent and queue columns on `devices`; a `device_sync_errors` table | Device Center, live-viewing consent, sync diagnostics |
  | `008_notifications.sql` | a `notifications` table | Notification Center |
  | `009_saved_reports.sql` | a `saved_reports` table (name and filters stored encrypted) | Reports Studio |

  Tests build a database exactly as v0.7.0 left it, with data, upgrade it, and check the existing rows are unchanged (007, 008) and that 009 adds only its table.
- **New dashboard pages:** Reports, Updates, Settings, Notifications, Security, Health. The release check on the Updates page is **off** until you switch it on.
- **Privacy default:** live viewing is **off** for every device until the person at it turns it on in the extension. History keeps working.
- **Extension:** update it on each browser (see below).

## Server: from v0.7.0

A v0.7.0 server runs v0.7.0's own `update.sh`. Two things about it matter:

1. **Run it with `bash`.** The v0.7.0 release was packed without executable bits ([A30](../BUG_FIX_REPORT.md)), so `sudo ./scripts/update.sh` answers "command not found". `sudo bash scripts/update.sh` works.
2. **`--check` will not find a release candidate.** It asks GitHub for the latest *full* release, and both v0.7.0 and v0.8.0-rc.1 are pre-releases. Name the version instead.

```bash
cd /opt/watch-ledger/current
sudo bash scripts/update.sh --version v0.8.0-rc.1 --dry-run   # what would happen; changes nothing
sudo bash scripts/update.sh --version v0.8.0-rc.1             # checksum → backup → install beside → migrate → switch → health check
sudo bash scripts/health-check.sh
```

What you will see: v0.7.0's script names the release by the number in `manifest.json`'s `"version"`, so it says **0.8.0** (not 0.8.0-rc.1) and installs it in `/opt/watch-ledger/releases/0.8.0`. The release is the right one; only the folder name is wrong. **v0.8.0-rc.1's own `update.sh` repairs this on the next update**: it renames the folder to `0.8.0-rc.1` and points `current` at it before anything else, so the final v0.8.0 gets its own folder and really runs ([A29](../BUG_FIX_REPORT.md)). Nothing to do by hand. The Updates page shows the real version (0.8.0-rc.1) from the start.

## Server: from v0.8.0-rc.1 onwards

From rc.1 on, the scripts are executable and `update.sh` knows pre-releases:

```bash
cd /opt/watch-ledger/current
sudo ./scripts/update.sh --version v0.8.0            # or the next rc; --check only reports full releases
```

It verifies the download against the release's `SHA256SUMS`, refuses a release whose `manifest.json` is inconsistent, takes a backup into `backups/pre-update/`, installs into `releases/<exact version>` (a folder that already exists but holds another version is set aside, never reused), migrates, switches, waits for the health check, and then confirms that the version it installed is the one the service is running. If any of that fails it switches the code back to the previous release and says so; it never reports success otherwise. The dashboard's **Updates** page shows the same steps filled in for your versions, the pre-update backups and the update history: [UPDATES.md](UPDATES.md).

## Extension

Download `yt-watch-tracker-v0.8.0-rc.1.zip` and `SHA256SUMS` from the release, check it (`sha256sum -c SHA256SUMS --ignore-missing`), unzip it **over the folder the extension was loaded from**, then `chrome://extensions` → reload. Do not load it from a different folder: the extension ID would change and the pairing would be lost. Details: [EXTENSION_SETUP.md](EXTENSION_SETUP.md).

## Rolling back

1. **Code only (the usual case).** `update.sh` already does this when the update fails. By hand:
   ```bash
   ls /opt/watch-ledger/releases
   sudo ln -sfn /opt/watch-ledger/releases/<previous version> /opt/watch-ledger/current
   sudo systemctl restart watch-ledger
   cd /opt/watch-ledger/current && sudo bash scripts/health-check.sh
   ```
   After a v0.7.0 → rc.1 update the previous release is `/opt/watch-ledger/releases/0.7.0`. v0.7.0 ignores tables and columns it does not know and does not refuse a database that has newer migrations, so it should start on the migrated database. **This downgrade has not been tested on a real server yet**; if in doubt, also restore the database (2).
2. **Database too**, only if the data must return to exactly how it was before the update (this discards everything recorded since). Roll the code back first, then:
   ```bash
   cd /opt/watch-ledger/current && sudo bash scripts/restore.sh /var/lib/watch-ledger/backups/pre-update/<backup file>
   ```
   Migrations cannot be undone in place; the pre-update backup is the way back. It can only be read with the same `MASTER_KEY`.
3. **Extension:** load the previous ZIP over the same folder. Settings stored by v0.8 are ignored by v0.7.0.

## Limitations of the release candidate

- The real update path (switching releases, the rollback, the folder repair for v0.7.0 → rc → final) is tested automatically on Linux only; it has not been run on a VPS.
- A v0.7.0 server's first update uses v0.7.0's `update.sh`, which records no update history and names the folder `0.8.0` (see above). History starts with the first update made by rc.1's `update.sh`.
- Saved reports and the update-check settings are new data; a rollback to v0.7.0 keeps them in the database, unused.

## Check it worked

- `sudo bash scripts/health-check.sh` exits 0; the dashboard's **Updates** page shows `0.8.0-rc.1`, channel *Release candidate*.
- **Devices → Diagnostics & controls** shows each device's checks; **Reports** opens on the current week.
