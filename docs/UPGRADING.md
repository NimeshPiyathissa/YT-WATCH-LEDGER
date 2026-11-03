# Upgrading from v0.7.0 to v0.8.0

> **Status.** v0.8.0 is in development (`develop/v0.8.0`, milestone *beta.1*). The steps below are what the code does and what is tested in a sandbox. They have **not** been run on a real server yet.

## What changes for you

- **Database:** one additive migration (`007_device_consents_sync_diagnostics.sql`) adds consent and queue columns to `devices` and a small `device_sync_errors` table. No existing row is changed. A test builds a real v0.7.0 database with data, upgrades it, and checks every table is byte-for-byte unchanged.
- **Privacy default:** live viewing is **off** for every device until the person at it turns it on in the extension. Until a device's extension is updated, Video Details shows *LIVE VIEW OFF* for it. History keeps working.
- **Extension:** update it on each browser (see below). Pairings and history survive an update when you load the new build from the **same folder**.

## Server

```bash
sudo ./scripts/update.sh --check                 # a newer release is available?
sudo ./scripts/update.sh --version vX.Y.Z        # backs up first, migrates, switches, checks health
```

`update.sh` takes a verified backup into `backups/pre-update`, installs the new release beside the old one, applies migrations, switches and health-checks; on a failed health check it switches the **code** back automatically. For a manual path see [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md#updating).

## Extension

Build or download the new ZIP ([EXTENSION_SETUP.md](EXTENSION_SETUP.md)), unzip it **over the folder the extension was loaded from**, then `chrome://extensions` → reload. Do not load it from a different folder: the extension ID would change and the pairing would be lost.

## Rolling back

1. **Code only (the usual case):** `update.sh` already did this if the health check failed. To do it by hand: `sudo ln -sfn /opt/watch-ledger/releases/<previous> /opt/watch-ledger/current && sudo systemctl restart watch-ledger`. The v0.7.0 code does not reference the new columns or the new table, so it should run on a migrated database (this exact downgrade has **not** been tested; restore the pre-update backup if in doubt).
2. **Database:** only needed if the data is damaged: `sudo ./scripts/restore.sh <pre-update backup>` (this also puts back the v0.7.0 schema). Migration `007` cannot be undone in place; the backup is the way back.
3. **Extension:** load the previous ZIP over the same folder. Live-viewing and queue settings stored by v0.8 are ignored by v0.7.0.

## Check it worked

- `./scripts/health-check.sh` exits 0; the dashboard's **Health** page shows the new version.
- **Devices → Diagnostics & controls** shows the device's checks; the *Permissions* tab shows what each device reports.
