#!/usr/bin/env bash
# Watch Ledger: take a verified backup of the database right now.   Powered by SciLink Project.
#
#   sudo ./scripts/backup.sh                       backup into /var/lib/watch-ledger/backups/manual
#   sudo ./scripts/backup.sh --dest /mnt/usb       also copy it somewhere else (another disk, a mounted share)
#   sudo ./scripts/backup.sh --with-keys --dest D  also save MASTER_KEY + COOKIE_SECRET to D (read the warning first)
#
# Safe while the server is running. Backups made here go to their own folder, which nothing ever prunes: this script never
# deletes a backup. (The server also makes its own rolling daily backups in .../backups; see docs/BACKUP_RECOVERY.md.)
# The backup is the encrypted database. Without MASTER_KEY it cannot be read, so keep the key somewhere else.
# shellcheck shell=bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

DEST=""; WITH_KEYS=0; QUIET=0
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dest) DEST="${2:-}"; shift 2;;
      --with-keys) WITH_KEYS=1; shift;;
      --quiet) QUIET=1; shift;;
      --dry-run) WL_DRY_RUN=1; shift;;
      -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
      *) die "Unknown option: $1";;
    esac
  done
}

main() {
  parse_args "$@"
  need_root
  [ -f "$WL_ENV_FILE" ] || die "No configuration found at ${WL_ENV_FILE}; is Watch Ledger installed?"
  local dir="${WL_VAR}/backups/manual" out file
  make_dirs 0750 "$WL_USER" "$WL_USER" "$dir"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would write a verified backup into ${dir}"; exit 0; fi
  out="$( cd "${WL_PREFIX}/current/server" && BACKUP_DIR="$dir" BACKUP_KEEP=1000000 app_node scripts/backup.js 2>&1 )" || die "Backup failed: ${out}"
  file="$(ls -1t "$dir"/*.db 2>/dev/null | head -n1 || true)"
  [ -f "$file" ] || die "The backup file was not found after the backup ran."
  [ "$QUIET" = "1" ] || ok "Backup written: ${file}"
  [ "$QUIET" = "1" ] || info "Size $(wc -c < "$file") bytes, SHA-256 $(sha256_of "$file")"
  if [ -n "$DEST" ]; then
    [ -d "$DEST" ] || die "Destination folder does not exist: ${DEST}"
    cp -p "$file" "$DEST/"
    [ "$(sha256_of "$file")" = "$(sha256_of "$DEST/$(basename "$file")")" ] || die "The copy in ${DEST} does not match the original."
    [ "$QUIET" = "1" ] || ok "Copied and verified: ${DEST}/$(basename "$file")"
  fi
  if [ "$WITH_KEYS" = "1" ]; then
    [ -n "$DEST" ] || die "--with-keys needs --dest (a safe place that is NOT next to the database backups)."
    local keyfile; keyfile="${DEST}/watch-ledger-keys-$(date -u +%Y%m%dT%H%M%SZ).env"
    ( umask 077; { printf '# Watch Ledger encryption keys. Anyone holding these AND a database backup can read the watch data.\n'; grep -E '^(MASTER_KEY|COOKIE_SECRET)=' "$WL_ENV_FILE"; } > "$keyfile" )
    warn "Keys written to ${keyfile} (mode 0600). Move it to a password manager or an offline drive, and keep it away from the database backups."
  fi
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
