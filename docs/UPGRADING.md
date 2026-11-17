# Upgrading from v0.7.0 to v0.8.0

> **Status.** v0.8.0 is the final release of the code published on 2026-11-17 as the release candidate v0.8.0-rc.1; only the version number changed. Tested on a real server with the rc.1 assets: the update from v0.7.0 below, a rollback to v0.7.0 **with the database restored**, and a second update, with no data lost ([BUG_FIX_REPORT.md](../BUG_FIX_REPORT.md) section K); a fresh `install.sh` install with nginx and HTTPS (section L); and, with the published v0.8.0 assets, the update from rc.1 to v0.8.0 with rc.1's own `update.sh` (section M). Not yet run on a server: the code-only rollback (1) below. Known issues: [KNOWN_ISSUES.md](KNOWN_ISSUES.md) section 12 (A33 has a one-line workaround). Take an off-server copy of your backups first.

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
2. **`--check` finds v0.8.0** once it is published as a full release (it asks GitHub for the latest full release, which excludes release candidates). Name the version when you update.

```bash
cd /opt/watch-ledger/current
sudo bash scripts/update.sh --version v0.8.0 --dry-run   # what would happen; changes nothing
sudo bash scripts/update.sh --version v0.8.0             # checksum → backup → install beside → migrate → switch → health check
sudo bash scripts/health-check.sh
```

What you will see: v0.7.0's script names the release by the number in `manifest.json`'s `"version"` and installs it in `/opt/watch-ledger/releases/0.8.0`, which is the right name for v0.8.0. **If you installed v0.8.0-rc.1 with v0.7.0's script earlier**, that folder `0.8.0` holds rc.1: update from rc.1 with rc.1's own `update.sh` (next section), which renames the folder to `0.8.0-rc.1` and points `current` at it before anything else, so the final v0.8.0 gets its own folder and really runs ([A29](../BUG_FIX_REPORT.md)). Nothing to do by hand.

## Server: from v0.8.0-rc.1 onwards

From rc.1 on, the scripts are executable and `update.sh` knows pre-releases:

```bash
cd /opt/watch-ledger/current
sudo ./scripts/update.sh --version v0.8.0            # --check reports full releases only
```

**If rc.1 runs from a folder named `0.8.0`** (it was installed by v0.7.0's script; `readlink /opt/watch-ledger/current` shows `…/releases/0.8.0`), **skip `--dry-run`**. rc.1's dry run stops with "…is the running release but holds 0.8.0-rc.1, not 0.8.0" and changes nothing, because it does not simulate the folder rename. The real update renames the folder first and works ([A36](KNOWN_ISSUES.md#13-updating-rc1--v080-skip---dry-run-when-rc1-is-in-a-folder-named-080-a36)).

It verifies the download against the release's `SHA256SUMS`, refuses a release whose `manifest.json` is inconsistent, takes a backup into `backups/pre-update/`, installs into `releases/<exact version>` (a folder that already exists but holds another version is set aside, never reused), migrates, switches, waits for the health check, and then confirms that the version it installed is the one the service is running. If any of that fails it switches the code back to the previous release and says so; it never reports success otherwise. The dashboard's **Updates** page shows the same steps filled in for your versions, the pre-update backups and the update history: [UPDATES.md](UPDATES.md).

## Extension

Download `yt-watch-tracker-v0.8.0.zip` and `SHA256SUMS` from the release, check it (`sha256sum -c SHA256SUMS --ignore-missing`), unzip it **over the folder the extension was loaded from**, then `chrome://extensions` → reload. Do not load it from a different folder: the extension ID would change and the pairing would be lost. Details: [EXTENSION_SETUP.md](EXTENSION_SETUP.md).

## Rolling back

1. **Code only (the usual case).** `update.sh` already does this when the update fails. By hand:
   ```bash
   ls /opt/watch-ledger/releases
   sudo ln -sfn /opt/watch-ledger/releases/<previous version> /opt/watch-ledger/current
   sudo systemctl restart watch-ledger
   cd /opt/watch-ledger/current && sudo bash scripts/health-check.sh
   ```
   After a v0.7.0 → v0.8.0 update the previous release is `/opt/watch-ledger/releases/0.7.0`. v0.7.0 ignores tables and columns it does not know and does not refuse a database that has newer migrations, so it should start on the migrated database. **This code-only downgrade has not been tested on a real server yet**; if in doubt, also restore the database (2), which has been.
2. **Database too**, only if the data must return to exactly how it was before the update (this discards everything recorded since). Tested on the staging server: the database came back equal to the pre-update backup in every table, and v0.7.0 started healthy. Roll the code back first, then:
   ```bash
   cd /opt/watch-ledger/current && sudo bash scripts/restore.sh /var/lib/watch-ledger/backups/pre-update/<backup file>
   ```
   Migrations cannot be undone in place; the pre-update backup is the way back. It can only be read with the same `MASTER_KEY`.
3. **Extension:** load the previous ZIP over the same folder. Settings stored by v0.8 are ignored by v0.7.0.

## What has been tested

- Run on a real server (staging VPS, with the rc.1 assets): the v0.7.0 → rc.1 update, the rollback to v0.7.0 with the pre-update backup restored, and updating again afterwards. A fresh `install.sh` install with nginx and HTTPS (Let's Encrypt *staging* certificate) on a new Ubuntu 24.04 VM. The update rc.1 → v0.8.0 with rc.1's own `update.sh`, including the folder repair, on the same staging server with the published v0.8.0 assets. Tested automatically on Linux only, not on a server: the code-only rollback.
- A v0.7.0 server's first update uses v0.7.0's `update.sh`, which records no update history and names the folder `0.8.0` (see above). History starts with the first update made by rc.1's `update.sh`.
- Saved reports and the update-check settings are new data; a rollback to v0.7.0 keeps them in the database, unused.

## Check it worked

- `sudo bash scripts/health-check.sh` exits 0; the dashboard's **Updates** page shows `0.8.0`, channel *Stable*.
- **Devices → Diagnostics & controls** shows each device's checks; **Reports** opens on the current week.
