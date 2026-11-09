#!/usr/bin/env bash
# Watch Ledger: safe in-place update.   Powered by SciLink Project.
#
#   sudo ./scripts/update.sh --check                          is a newer release available?
#   sudo ./scripts/update.sh --version v0.8.0                 download that GitHub release (SHA-256 verified) and update
#   sudo ./scripts/update.sh --from-dir /path/to/checkout     update from a local checkout of a newer version
#   sudo ./scripts/update.sh --from-tarball FILE --sha256 H   update from a release tarball you downloaded yourself
#
# What it does, in this order:  check versions -> BACKUP the database -> install the new release beside the old one -> stop the
# service -> apply migrations -> switch -> start -> health check.  If the health check fails it switches back to the previous
# release automatically and tells you exactly how to restore the pre-update backup if you need it.
# What it never does: replace MASTER_KEY or COOKIE_SECRET, touch the configuration file, delete a database, or delete a backup.
# Full guide: docs/BACKUP_RECOVERY.md
# shellcheck shell=bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

TARGET_TAG=""; FROM_DIR=""; FROM_TARBALL=""; EXPECT_SHA=""; CHECK_ONLY=0; FORCE=0; ALLOW_DOWNGRADE=0; KEEP_RELEASES=3
TMP_DIR=""; PREVIOUS_REL=""; BACKUP_FILE=""; STAGE="start"

usage() { sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; cat <<'EOF'

Options:  --check  --version TAG  --from-dir DIR  --from-tarball FILE  --sha256 HASH
          --yes (no confirmation)  --force (reinstall the same version)  --allow-downgrade  --dry-run
EOF
}
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) CHECK_ONLY=1; shift;;
      --version) TARGET_TAG="${2:-}"; shift 2;;
      --from-dir) FROM_DIR="${2:-}"; shift 2;;
      --from-tarball) FROM_TARBALL="${2:-}"; shift 2;;
      --sha256) EXPECT_SHA="${2:-}"; shift 2;;
      --yes|-y) WL_ASSUME_YES=1; shift;;
      --force) FORCE=1; shift;;
      --allow-downgrade) ALLOW_DOWNGRADE=1; shift;;
      --dry-run) WL_DRY_RUN=1; shift;;
      -h|--help) usage; exit 0;;
      *) die "Unknown option: $1 (see --help)";;
    esac
  done
}
on_error() {
  local code=$?
  trap - ERR
  case "$STAGE" in
    "migrating and switching"|"verifying") rollback "The update stopped unexpectedly while ${STAGE} (exit code ${code}).";;
    *) fail "The update stopped while ${STAGE} (exit code ${code}). The running release was not changed."; [ -n "$BACKUP_FILE" ] && say "  Pre-update backup: ${BACKUP_FILE}"; exit "$code";;
  esac
}
trap on_error ERR
cleanup() { [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] && rm -rf "$TMP_DIR"; return 0; }
trap cleanup EXIT

latest_tag() { curl -fsS -m 15 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${WL_REPO}/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1 || true; }

fetch_release() { # fetch_release <tag>: downloads and verifies the release tarball; sets SRC
  local tag="$1" base asset sums want got
  valid_semver "$tag" || die "'${tag}' is not a release tag like v0.8.0"
  base="https://github.com/${WL_REPO}/releases/download/${tag}"; asset="watch-ledger-${tag}.tar.gz"
  info "Downloading ${asset} and its checksums from the GitHub release"
  curl -fsSL -m 600 "${base}/${asset}" -o "${TMP_DIR}/${asset}" || die "Could not download ${base}/${asset}"
  sums="$(curl -fsSL -m 30 "${base}/SHA256SUMS")" || die "Could not download the release checksum list (SHA256SUMS)."
  want="$(printf '%s\n' "$sums" | awk -v f="$asset" '$2 == f || $2 == "*" f {print $1; exit}')"
  [ -n "$want" ] || die "${asset} is not listed in the release's SHA256SUMS."
  got="$(sha256_of "${TMP_DIR}/${asset}")"
  [ "$want" = "$got" ] || die "Checksum mismatch for ${asset}: the download is corrupt or not the published release. Nothing was changed."
  ok "Checksum verified (${got:0:12}...)"
  extract_tarball "${TMP_DIR}/${asset}"
}
extract_tarball() {
  mkdir -p "${TMP_DIR}/src"; tar --force-local -xzf "$1" -C "${TMP_DIR}/src" --strip-components=1 || die "Could not unpack $1"
  SRC="${TMP_DIR}/src"
}

rollback() {
  local why="$1"
  fail "${why}"
  if [ -n "$PREVIOUS_REL" ] && [ -d "$PREVIOUS_REL" ]; then
    warn "Switching back to the previous release: $(basename "$PREVIOUS_REL")"
    switch_current "$PREVIOUS_REL"
    [ -z "$WL_ROOT" ] && { systemctl restart "$WL_SERVICE" || true; }
    if health_wait 40; then ok "The previous release is running again."; else fail "The previous release did not start either. Check: journalctl -u watch-ledger -n 80 --no-pager"; fi
  fi
  say ""
  say "  Your data is safe: a backup was taken before anything changed."
  [ -n "$BACKUP_FILE" ] && say "  Pre-update backup: ${BACKUP_FILE}"
  say "  The database schema is only ever extended by migrations, so the previous release normally works with it."
  say "  If you must return the database to exactly how it was before this update (this discards anything written since):"
  say "      sudo ./scripts/restore.sh ${BACKUP_FILE:-<backup file>}"
  exit 1
}

main() {
  parse_args "$@"
  need_root
  banner "UPDATE"
  [ "$WL_DRY_RUN" = "1" ] && warn "DRY RUN: nothing will be changed."
  local installed; installed="$(installed_version)"
  [ -n "$installed" ] || die "No Watch Ledger installation found under ${WL_PREFIX}. Install first: sudo ./scripts/install.sh"
  [ -f "$WL_ENV_FILE" ] || die "The configuration file ${WL_ENV_FILE} is missing. Refusing to continue (the encryption keys live there)."
  info "Installed version: ${installed}"

  TMP_DIR="$(mktemp -d)"
  if [ "$CHECK_ONLY" = "1" ]; then
    local latest; latest="$(latest_tag)"
    [ -n "$latest" ] || die "Could not query the latest release (no network, or no release has been published yet)."
    info "Latest release:    ${latest}"
    if version_ge "$installed" "$latest"; then ok "You are up to date."; exit 0; else warn "A newer release is available. Update with: sudo ./scripts/update.sh --version ${latest}"; exit 10; fi
  fi

  # ---- 1. find and verify the target
  STAGE="verifying the target release"; step 1 "VERIFY THE TARGET RELEASE"
  local SRC=""
  if [ -n "$FROM_DIR" ]; then SRC="$(cd "$FROM_DIR" && pwd)"; [ -f "$SRC/manifest.json" ] && [ -d "$SRC/server" ] || die "${FROM_DIR} is not a Watch Ledger checkout."
  elif [ -n "$FROM_TARBALL" ]; then
    [ -f "$FROM_TARBALL" ] || die "File not found: ${FROM_TARBALL}"
    [ -n "$EXPECT_SHA" ] || die "Give the expected checksum with --sha256 (from the release's SHA256SUMS). An unverified tarball is not installed."
    [ "$(sha256_of "$FROM_TARBALL")" = "$EXPECT_SHA" ] || die "Checksum mismatch: ${FROM_TARBALL} is not the release you expect. Nothing was changed."
    ok "Checksum verified"; extract_tarball "$FROM_TARBALL"
  elif [ -n "$TARGET_TAG" ]; then fetch_release "$TARGET_TAG"
  else die "Say what to install: --version vX.Y.Z, --from-dir DIR or --from-tarball FILE (or --check)."; fi
  local target; target="$(source_version "$SRC")"
  valid_semver "$target" || die "The target has no valid version."
  info "Target version:    ${target}"
  if [ "$target" = "$installed" ] && [ "$FORCE" = "0" ]; then ok "Already running ${installed}. Use --force to reinstall it."; exit 0; fi
  if ! version_ge "$target" "$installed" && [ "$ALLOW_DOWNGRADE" = "0" ]; then die "${target} is older than the installed ${installed}. A downgrade can be incompatible with the migrated database; use --allow-downgrade only if you know it is safe."; fi
  confirm "Update Watch Ledger ${installed} -> ${target}? A backup is taken first." || die "Cancelled. Nothing was changed."
  PREVIOUS_REL="$(readlink -f "${WL_PREFIX}/current" 2>/dev/null || true)"

  # ---- 2. backup (a separate folder that nothing ever prunes)
  STAGE="backing up"; step 2 "BACKUP"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would take a verified backup into ${WL_VAR}/backups/pre-update"; else
    local out
    out="$( cd "${WL_PREFIX}/current/server" && BACKUP_DIR="${WL_VAR}/backups/pre-update" BACKUP_KEEP=1000000 app_node scripts/backup.js 2>&1 )" || die "The pre-update backup failed, so nothing was changed: ${out}"
    BACKUP_FILE="${WL_VAR}/backups/pre-update/$(printf '%s' "$out" | sed -n 's#.*backup written: [^ ]*/\([^/ ]*\) .*#\1#p' | head -n1)"
    [ -f "$BACKUP_FILE" ] || BACKUP_FILE="$(ls -1t "${WL_VAR}/backups/pre-update"/*.db 2>/dev/null | head -n1 || true)"
    [ -f "$BACKUP_FILE" ] || die "The backup file was not found after the backup ran; stopping before any change."
    ok "Verified backup: ${BACKUP_FILE} ($(sha256_of "$BACKUP_FILE" | cut -c1-16)...)"
  fi

  # ---- 3. install beside the old release
  STAGE="installing the new release"; step 3 "INSTALL THE NEW RELEASE (beside the old one)"
  deploy_release_dir "$SRC"
  local new_rel="$REL_DIR"

  # ---- 4. migrate and switch
  STAGE="migrating and switching"; step 4 "MIGRATE AND SWITCH"
  [ -z "$WL_ROOT" ] && run systemctl stop "$WL_SERVICE"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would apply migrations with the new release, then switch and start"; else
    if ! ( cd "${new_rel}/server" && app_node src/migrate.js ); then
      [ -z "$WL_ROOT" ] && { systemctl start "$WL_SERVICE" || true; }
      rollback "The database migration failed. The migration runs inside a transaction, so the database was not partly changed."
    fi
    ok "Migrations applied"
  fi
  switch_current "$new_rel"
  if [ -z "$WL_ROOT" ]; then run systemctl start "$WL_SERVICE"; fi

  # ---- 5. verify
  STAGE="verifying"; step 5 "HEALTH CHECK"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would wait for the health endpoint"; else
    health_wait 60 || rollback "The new release did not become healthy within 60 seconds."
    ok "The service is healthy on ${target}"
  fi

  # ---- 6. tidy: old release CODE only (never data, keys or backups)
  if [ "$WL_DRY_RUN" != "1" ]; then
    local old
    while IFS= read -r old; do
      case "$old" in "${WL_PREFIX}"/releases/[0-9]*) ;; *) continue;; esac   # only ever a release directory, never anything else
      [ "$old" != "$new_rel" ] && [ "$old" != "$PREVIOUS_REL" ] && { info "Removing old release code: $(basename "$old")"; rm -rf "$old"; }
    done < <(ls -1dt "${WL_PREFIX}"/releases/[0-9]* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)))
    # the extension ZIP for the new version, configured for this server
    local domain; domain="$(env_get BASE_URL | sed 's#^https://##')"
    if [ -n "$domain" ] && ( cd "${WL_PREFIX}/current" && service_user_run "$WL_NODE_BIN" tools/build-extension.mjs --out "${WL_VAR}/extension" --server "https://${domain}" >/dev/null 2>&1 ); then ok "New extension ZIP: $(latest_extension_zip)"; else warn "The extension ZIP was not rebuilt; run: node tools/build-extension.mjs --server https://YOUR-DOMAIN"; fi
  fi
  say ""; say "  ${C_GREEN}Update complete: ${installed} -> ${target}${C_RESET}"
  say "  Previous release kept for rollback: ${PREVIOUS_REL:-n/a}"
  [ -n "$BACKUP_FILE" ] && say "  Pre-update backup (kept): ${BACKUP_FILE}"
  say "  Browsers: reload the extension (chrome://extensions) to pick up the new version."
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
