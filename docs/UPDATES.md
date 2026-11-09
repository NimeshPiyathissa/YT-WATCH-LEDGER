# Update Manager

**Updates** (sidebar → System; owner only) shows which version this server runs, how its past updates went, the backups taken before them, and exactly how to update or roll back. **It never installs, updates, rolls back or restores anything.** Those are run on the server, over SSH, with the scripts that come with every release. No web request can start them: the Update Manager has no such route, and a test checks its source for anything that could run a command or change a file.

## What the page shows

| Section | Contents |
|---|---|
| **Installed version** | the version (for example `0.8.0-beta.1`), its release channel (Stable, Release candidate, Beta, Alpha), the Node.js version, how long the server has been running, and whether it runs from the installer's layout or a development checkout. A warning appears if the server and the release files disagree about the version. |
| **New releases** | the release check (off by default, see below) |
| **Update history** | every real update attempt made with `scripts/update.sh` since v0.8.0, newest first: from and to versions, the result (**Updated**, **Rolled back**, **Failed**, **Cancelled**), where it stopped, whether anything had been changed, and the name of its pre-update backup |
| **Pre-update backups** | the backups `update.sh` takes into `backups/pre-update/` before every update (never pruned). **Verify** checks one without changing anything: integrity, which release made it, and whether this server's key can read it (audited) |
| **How to update** | copyable commands, filled in with the release the check found (or `vX.Y.Z`) |
| **How to roll back** | the releases still installed (`update.sh` keeps the last three) and copyable commands to switch back to the previous one, and, only if needed, to restore the pre-update backup |

Commands use the installer's standard locations (`/opt/watch-ledger`, `/var/lib/watch-ledger`, service `watch-ledger`). They are built only from values checked to be real version numbers or backup file names, so nothing from the network or from a file can end up in a command. A test checks that every script and option they name exists.

## Checking for new releases

Off by default. To use it, switch on **Settings → Updates → Check GitHub for new releases**. Then **Check now** on the Updates page asks GitHub's public list of this project's releases (`api.github.com/repos/NimeshPiyathissa/YT-WATCH-LEDGER/releases`):

- only when you press the button; never in the background;
- **no account, token, cookie or data of yours is sent**, and no token is read from the server's environment; GitHub sees this server's IP address;
- 10-second time limit, at most 1 MB read, no redirects; anything that is not a valid release list is refused;
- a successful answer is reused for 10 minutes (GitHub allows 60 unauthenticated requests per hour per address); every check is written to the audit log (`update_check`).

What is offered:

| This server runs | Offered |
|---|---|
| a **stable** release | newer **stable** releases only, always |
| a **pre-release** (beta, rc) | newer stable releases; and newer pre-releases **of the same release line** (same major version, or same `0.x` minor) only if **Also offer newer pre-releases** is switched on |

**A downgrade is never offered**, nor the version already running. Release tags are parsed strictly as Semantic Versions and ordered by SemVer precedence (`0.8.0-beta.2 < 0.8.0-beta.10 < 0.8.0-rc.1 < 0.8.0`), the same order `update.sh` uses. Only the release's version, name, date and a link to its GitHub page are kept; release notes are opened on GitHub, never shown in the dashboard.

`sudo ./scripts/update.sh --check` asks GitHub for the newest **stable** release only (GitHub's "latest release" excludes pre-releases). To move from one pre-release to a newer one, name it: `sudo ./scripts/update.sh --version v0.8.0-rc.1`.

## Updating

```bash
cd /opt/watch-ledger/current
sudo ./scripts/update.sh --version vX.Y.Z --dry-run   # what would happen; changes nothing
sudo ./scripts/update.sh --version vX.Y.Z             # checksum → backup → install beside → migrate → switch → health check
sudo ./scripts/health-check.sh
```

If the new release does not become healthy, `update.sh` switches the code back to the previous release by itself and names the pre-update backup. Details: [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md#updating).

## Rolling back

1. **Code only (the usual case).** Migrations only ever add to the database, so the previous release normally runs on it.
   ```bash
   ls /opt/watch-ledger/releases
   sudo ln -sfn /opt/watch-ledger/releases/<previous version> /opt/watch-ledger/current
   sudo systemctl restart watch-ledger
   cd /opt/watch-ledger/current && sudo ./scripts/health-check.sh
   ```
2. **Database too**, only if the data must return to exactly how it was before the update (this discards everything recorded since). Roll the code back first, then:
   ```bash
   cd /opt/watch-ledger/current && sudo ./scripts/restore.sh /var/lib/watch-ledger/backups/pre-update/<backup file>
   ```

There is no rollback button and no rollback script: rolling back stays a deliberate step on the server.

## The update history file

`update.sh` appends one JSON line per real update attempt to `/var/lib/watch-ledger/update-history.jsonl` (mode 0644, no secrets): time (UTC), from and to versions, result, the step it reached, the source (GitHub, a tarball or a folder), the pre-update backup's file name, the previous release's name and the exit code. File names only, never paths. Checks (`--check`), dry runs and "already running" are not recorded. Writing it is best effort and isolated: if it cannot be written, the update and its rollback behave exactly as before and the exit code is the same.

The dashboard reads the last 256 KB, shows at most 200 entries, checks every field again and skips (and counts) any line that is not a valid entry. A different location can be given with `UPDATE_HISTORY_FILE` in the server's environment; by default it is the folder above the database's folder (the installer's layout). The file sits in a folder the service account can write to, so it is a record for the owner, not tamper-proof evidence; the audit log and the backups are not affected by it.

## API (owner session required)

| Method and path | Purpose |
|---|---|
| `GET /api/updates` | installed version, channel, Node.js, uptime, history, pre-update backups, installed releases, the last check, instructions |
| `POST /api/updates/check` | the release check; `409 check_disabled` while it is switched off; rate-limited |
| `POST /api/updates/backups/:name/verify` | verify a pre-update backup by its file name (`400 bad_name`, `404 not_found`) |

Writes from another site are refused (`403 bad_origin`), as everywhere in the dashboard.
