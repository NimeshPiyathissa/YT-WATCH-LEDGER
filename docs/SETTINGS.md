# Settings Studio

**Settings** (sidebar, owner only) is where you change how the server keeps data, backs up and admits devices. Every change is checked by the server, takes effect **immediately without a restart**, and is written to the audit log with the old and the new value.

## Where a value comes from

Each setting shows one of three labels:

| Label | Meaning |
|---|---|
| **Your setting** | you saved it here; it wins over everything else |
| **From the server's settings file** | the value of an environment variable (`.env`, or `/etc/watch-ledger/watch-ledger.env` with the installer) |
| **Built-in default** | nothing was set |

**Use the server default** removes your saved value, so the settings file (or the default) applies again. A value in the settings file that is not usable (for example `BACKUP_KEEP=fourteen`) is **ignored and reported** at the top of the page and in the server log; the default is used instead.

## What you can change here

| Setting | Allowed | Default | Variable it overrides |
|---|---|---|---|
| Keep watch history on the server for | 0 (forever) to 3650 days | 0 | none |
| Keep the audit log for | 30 to 3650 days (also capped at 100,000 entries) | 365 | none |
| Back up automatically every | 0 (off) to 720 hours | 24 | `BACKUP_INTERVAL_HOURS` |
| Keep the newest N automatic backups | 1 to 365 | 14 | `BACKUP_KEEP` |
| A pairing code stays valid for | 1 to 120 minutes | 15 | `PAIRING_CODE_TTL_MIN` |
| Lock out an address after N wrong pairing codes | 1 to 50 | 5 | `PAIRING_MAX_FAILS` |
| Notifications: on/off per kind, thresholds, how long resolved ones are kept | see [NOTIFICATIONS.md](NOTIFICATIONS.md) | | none |
| Updates: check GitHub for new releases | on / off | off | none |
| Updates: also offer newer pre-releases (only while this server runs a pre-release) | on / off | off | none |
| Open the dashboard on | Overview, Analytics, Reports, History, Videos, Devices, Notifications, Health | Overview | none |
| Compact tables | on / off | off | none |

- **Shortening the retention window deletes data**, so before saving you are shown how many sessions would be removed and must confirm that number. If the data changed meanwhile, you are asked again with the new number. Lengthening it, or a window that removes nothing, saves without a prompt. Backups made earlier still contain the removed sessions, and devices keep their own copy.
- **Backups.** The server checks every ten minutes whether an automatic backup is due under the current interval. `0` switches automatic backups off (you can still back up by hand from Data & backups). The keep count applies to the next backup.
- **Pairing.** The new lifetime applies to codes you create from then on; the new lock-out limit applies to the next wrong code. The lock-out list itself is held in memory and a restart clears it.
- A link to a specific page is never overridden by "Open the dashboard on".

## What needs a restart

Listed under **Needs a restart**, read-only, with their current non-secret value: `ACCESS_TTL`, `REFRESH_TTL`, `TRUST_PROXY`, `ENROLL_RATE_MAX`, `CORS_ORIGIN`, `BASE_URL`, `PORT`. To change one, edit the settings file and run `sudo systemctl restart watch-ledger`. `MASTER_KEY`, `COOKIE_SECRET`, database and backup folder paths are never shown or changed from the dashboard.

## API (owner session required)

`GET /api/settings/studio` (every setting with value, source, limits; read-only list; warnings; notification preferences), `PUT /api/settings/studio` with `{"changes": {"backup_keep": 7, "backup_interval_hours": null}, "confirmRemoveSessions": 3}` (`null` = server default; the whole request is rejected if any value is invalid; `409 confirmation_required` with `wouldRemove` when retention would delete data and the number was not confirmed), `GET /api/settings/retention-preview?days=30`. The older `GET`/`PUT /api/settings` (retention only) keep working unchanged, and `GET` now also returns `default_page` and `compact_tables`; the old `PUT` still deletes immediately, as it always did, so use the studio.
