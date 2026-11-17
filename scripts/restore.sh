#!/usr/bin/env bash
# Watch Ledger: restore the database from a backup.   Powered by SciLink Project.
#
#   sudo ./scripts/restore.sh /var/lib/watch-ledger/backups/manual/tracker-20261103T020000Z.db
#   sudo ./scripts/restore.sh --list                       show the backups found in the standard folders
#
# The backup is integrity-checked first. The server is stopped, the CURRENT database is copied aside (next to it, as
# tracker.db.pre-restore-<time>) before it is replaced, then the server is started again. Nothing is deleted.
# The restored data can only be read with the same MASTER_KEY that encrypted it. If it was made by an older version, the missing
# migrations run automatically at start. Full guide: docs/BACKUP_RECOVERY.md
# shellcheck shell=bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

FILE=""; LIST=0; STOPPED=0

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --list) LIST=1; shift;;
      --yes|-y) WL_ASSUME_YES=1; shift;;
      --dry-run) WL_DRY_RUN=1; shift;;
      -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
      -*) die "Unknown option: $1";;
      *) FILE="$1"; shift;;
    esac
  done
}
list_backups() {
  local d any=0
  for d in "${WL_VAR}/backups" "${WL_VAR}/backups/manual" "${WL_VAR}/backups/pre-update"; do
    [ -d "$d" ] || continue
    ls -1t "$d"/*.db 2>/dev/null | while IFS= read -r f; do printf '  %s  (%s bytes)\n' "$f" "$(wc -c < "$f")"; done
    any=1
  done
  [ "$any" = "1" ] || say "  (no backup folders found)"
}
restart_if_stopped() { if [ "$STOPPED" = "1" ] && [ -z "$WL_ROOT" ]; then systemctl start "$WL_SERVICE" || true; STOPPED=0; fi; }
trap restart_if_stopped EXIT

main() {
  parse_args "$@"
  need_root
  if [ "$LIST" = "1" ]; then say "Backups:"; list_backups; exit 0; fi
  [ -n "$FILE" ] || { say "usage: sudo ./scripts/restore.sh <backup file>   (or --list)"; say ""; say "Available backups:"; list_backups; exit 2; }
  [ -f "$FILE" ] || die "Backup file not found: ${FILE}"
  [ -f "$WL_ENV_FILE" ] || die "No configuration found at ${WL_ENV_FILE}; is Watch Ledger installed?"
  local abs; abs="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
  banner "RESTORE"
  say "  Backup:    ${abs} ($(wc -c < "$abs") bytes)"
  say "  Database:  $(env_get DB_PATH)"
  say "  The current database will be copied aside first, then replaced by this backup. The server is stopped for a moment."
  if [ "$WL_ASSUME_YES" != "1" ]; then
    [ -r /dev/tty ] || die "Run this from a terminal (or add --yes)."
    local typed=""; printf '  Type RESTORE to continue: ' > /dev/tty; IFS= read -r typed < /dev/tty
    [ "$typed" = "RESTORE" ] || die "Cancelled. Nothing was changed."
  fi
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would stop the service, restore, and start it again."; exit 0; fi

  # the service user must be able to read the file: use a private temporary copy if it cannot
  local use="$abs" tmp=""
  if [ -z "$WL_ROOT" ] && ! runuser -u "$WL_USER" -- test -r "$abs" 2>/dev/null; then
    tmp="${WL_VAR}/restore-tmp-$$.db"; cp "$abs" "$tmp"; chown "$WL_USER:$WL_USER" "$tmp"; chmod 0600 "$tmp"; use="$tmp"
  fi
  if [ -z "$WL_ROOT" ]; then systemctl stop "$WL_SERVICE"; STOPPED=1; fi
  local out
  if ! out="$( cd "${WL_PREFIX}/current/server" && app_node scripts/restore.js "$use" --yes 2>&1 )"; then
    [ -n "$tmp" ] && rm -f "$tmp"
    restart_if_stopped
    die "Restore failed; the current database was not replaced. ${out}"
  fi
  [ -n "$tmp" ] && rm -f "$tmp"   # only our temporary copy; the original backup is never touched
  ok "Restored. $(printf '%s' "$out" | tr '\n' ' ')"
  restart_if_stopped
  if [ -z "$WL_ROOT" ]; then if health_wait 60; then ok "The service is running with the restored database."; else fail "The service did not become healthy. Check: journalctl -u watch-ledger -n 80 --no-pager. The previous database is still next to the restored one (tracker.db.pre-restore-*)."; exit 1; fi; fi
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
