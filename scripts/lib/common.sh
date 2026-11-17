#!/usr/bin/env bash
# Watch Ledger: shared helpers for install.sh, update.sh, backup.sh, restore.sh and health-check.sh.
# Powered by SciLink Project. Source this file; do not run it.
#
# Rules this library follows:
#   * Secrets (passwords, MASTER_KEY, COOKIE_SECRET) are never printed, never logged, never put on a command line.
#   * Nothing here deletes a database, a backup or an encryption key.
#   * Every path can be moved under a test root with WL_ROOT, so the logic is testable without touching a real system.

# shellcheck shell=bash
set -Eeuo pipefail

WL_VERSION_SCRIPTS="1"
WL_ROOT="${WL_ROOT:-}"                              # empty on a real server; a temp dir in tests
WL_USER="${WL_USER:-watchledger}"
WL_PREFIX="${WL_ROOT}${WL_PREFIX_DIR:-/opt/watch-ledger}"
WL_ETC="${WL_ROOT}${WL_ETC_DIR:-/etc/watch-ledger}"
WL_VAR="${WL_ROOT}${WL_VAR_DIR:-/var/lib/watch-ledger}"
WL_ENV_FILE="${WL_ETC}/watch-ledger.env"
WL_STATE_FILE="${WL_VAR}/install.state"
WL_SERVICE="watch-ledger"
WL_PORT_DEFAULT="8787"
WL_REPO="NimeshPiyathissa/YT-WATCH-LEDGER"
WL_NODE_BIN="${WL_PREFIX}/node/bin/node"
WL_DRY_RUN="${WL_DRY_RUN:-0}"
WL_ASSUME_YES="${WL_ASSUME_YES:-0}"
WL_NONINTERACTIVE="${WL_NONINTERACTIVE:-0}"

# ---------- output ----------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi
say()   { printf '%s\n' "$*"; }
ok()    { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
done_ok() { if [ "$WL_DRY_RUN" = "1" ]; then printf '  %s○%s (dry run) %s
' "$C_DIM" "$C_RESET" "$*"; else printf '  %s✓%s %s
' "$C_GREEN" "$C_RESET" "$*"; fi; }
info()  { printf '  %s•%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail()  { printf '  %s✗ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; }
die()   { fail "$*"; exit 1; }
step()  { printf '\n%s%sSTEP %s: %s%s\n' "$C_BOLD" "$C_CYAN" "$1" "$2" "$C_RESET"; }

repeat_char() { local n="$1" c="$2" s="" i; for ((i = 0; i < n; i++)); do s+="$c"; done; printf '%s' "$s"; }
box_line() { local text="$1" w=44 pad left right; pad=$(( w - ${#text} )); left=$(( pad / 2 )); right=$(( pad - left )); printf '║%*s%s%*s║\n' "$left" "" "$text" "$right" ""; }
banner() { # banner "SUBTITLE"
  local w=44
  printf '%s╔%s╗\n' "$C_CYAN" "$(repeat_char "$w" ═)"
  box_line ""; box_line "WATCH LEDGER"; box_line ""; box_line "$1"; box_line ""; box_line "Powered by SciLink Project"; box_line ""
  printf '╚%s╝%s\n' "$(repeat_char "$w" ═)" "$C_RESET"
}

# ---------- running things ----------
# run <command...>: runs it, or only prints it with --dry-run. Never pass secrets as arguments.
run() {
  if [ "$WL_DRY_RUN" = "1" ]; then printf '  %s+ %s%s\n' "$C_DIM" "$*" "$C_RESET"; return 0; fi
  "$@"
}
need_root() { [ "$WL_DRY_RUN" = "1" ] || [ "${WL_ROOT}" != "" ] || [ "$(id -u)" = "0" ] || die "Run this with sudo (it installs system services)."; }
# make_dirs <mode> <owner> <group> <dir>...: creates directories with an owner on a real system (WL_ROOT empty); in a test sandbox only the mode.
make_dirs() {
  local mode="$1" owner="$2" group="$3"; shift 3
  if [ -n "$WL_ROOT" ]; then run mkdir -p "$@"; run chmod "$mode" "$@"; else run install -d -m "$mode" -o "$owner" -g "$group" "$@"; fi
}
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- validation (pure functions: unit-tested) ----------
valid_domain() { # a hostname with at least one dot; not an IP address; lowercase letters, digits, hyphens
  local d="$1"
  [ "${#d}" -le 253 ] || return 1
  [[ "$d" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || return 1
  return 0
}
looks_like_ip() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || [[ "$1" == *:* ]]; }
valid_email() { [[ "$1" =~ ^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$ ]]; }
# has_repeat4 <text>: true when any character repeats four or more times in a row (no regex back-references: they are not portable in bash).
has_repeat4() { local t="$1" i prev="" run=0 c; for ((i = 0; i < ${#t}; i++)); do c="${t:i:1}"; if [ "$c" = "$prev" ]; then run=$((run + 1)); else run=1; prev="$c"; fi; [ "$run" -ge 4 ] && return 0; done; return 1; }
# strong_password <password> [email]: >= 12 characters, upper + lower + digit + symbol, not the email, no 4 repeated characters, no trivial sequences.
strong_password() {
  local p="$1" email="${2:-}" lower
  [ "${#p}" -ge 12 ] || { PW_REASON="use at least 12 characters"; return 1; }
  [ "${#p}" -le 128 ] || { PW_REASON="use at most 128 characters"; return 1; }
  [[ "$p" =~ [a-z] ]] || { PW_REASON="add a lowercase letter"; return 1; }
  [[ "$p" =~ [A-Z] ]] || { PW_REASON="add an uppercase letter"; return 1; }
  [[ "$p" =~ [0-9] ]] || { PW_REASON="add a digit"; return 1; }
  [[ "$p" =~ [^A-Za-z0-9] ]] || { PW_REASON="add a symbol such as ! # % or -"; return 1; }
  has_repeat4 "$p" && { PW_REASON="avoid four repeated characters in a row"; return 1; }
  lower="$(printf '%s' "$p" | tr 'A-Z' 'a-z')"
  case "$lower" in *password*|*qwerty*|*123456*|*letmein*|*watchledger*|*admin123*) PW_REASON="avoid common words and sequences"; return 1;; esac
  if [ -n "$email" ]; then local local_part="${email%%@*}"; local_part="$(printf '%s' "$local_part" | tr 'A-Z' 'a-z')"
    if [ "${#local_part}" -ge 4 ] && [[ "$lower" == *"$local_part"* ]]; then PW_REASON="do not include your email name"; return 1; fi; fi
  PW_REASON=""; return 0
}
PW_REASON=""
# version_ge A B: true when A >= B. Dotted numeric versions, a leading v is ignored, and semver pre-releases are understood:
# 0.8.0-beta.1 < 0.8.0-rc.1 < 0.8.0 (a release outranks every pre-release of the same number).
_ver_core() { local v="${1#v}"; printf '%s' "${v%%-*}"; }
_ver_pre() { local v="${1#v}"; case "$v" in *-*) printf '%s' "${v#*-}";; esac; }
version_ge() {
  local ca cb pa pb; ca="$(_ver_core "$1")"; cb="$(_ver_core "$2")"; pa="$(_ver_pre "$1")"; pb="$(_ver_pre "$2")"
  if [ "$ca" != "$cb" ]; then [ "$(printf '%s\n%s\n' "$cb" "$ca" | sort -V | head -n1)" = "$cb" ]; return; fi
  [ -z "$pa" ] && return 0
  [ -z "$pb" ] && return 1
  [ "$(printf '%s\n%s\n' "$pb" "$pa" | sort -V | head -n1)" = "$pb" ]
}
valid_semver() { [[ "${1#v}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; }

# ---------- secrets ----------
gen_b64_key() { openssl rand -base64 32; }   # 32 random bytes: MASTER_KEY
gen_hex_secret() { openssl rand -hex 32; }   # 64 hex characters: COOKIE_SECRET
# read_secret <prompt> <varname>: no echo; reads from the terminal even when stdout is redirected.
read_secret() {
  local prompt="$1" __var="$2" v=""
  if [ -n "${!__var:-}" ] && [ "$WL_NONINTERACTIVE" = "1" ]; then return 0; fi
  [ -r /dev/tty ] || die "A secure prompt needs a terminal. For unattended installs set ${__var} in the environment."
  printf '%s' "$prompt" > /dev/tty; IFS= read -rs v < /dev/tty; printf '\n' > /dev/tty
  printf -v "$__var" '%s' "$v"
}
ask() { # ask <prompt> <varname> [default]
  local prompt="$1" __var="$2" def="${3:-}" v=""
  if [ -n "${!__var:-}" ]; then return 0; fi
  if [ "$WL_NONINTERACTIVE" = "1" ]; then [ -n "$def" ] && { printf -v "$__var" '%s' "$def"; return 0; }; die "Missing value for ${__var} (non-interactive mode)."; fi
  [ -r /dev/tty ] || die "No terminal available for the question '${prompt}'."
  printf '%s%s ' "$prompt" "${def:+ [$def]}" > /dev/tty; IFS= read -r v < /dev/tty
  printf -v "$__var" '%s' "${v:-$def}"
}
confirm() { # confirm <question> -> 0 for yes
  [ "$WL_ASSUME_YES" = "1" ] && return 0
  [ "$WL_NONINTERACTIVE" = "1" ] && return 1
  [ -r /dev/tty ] || return 1
  local a=""; printf '%s [y/N] ' "$1" > /dev/tty; IFS= read -r a < /dev/tty; [[ "$a" =~ ^[Yy]([Ee][Ss])?$ ]]
}

# ---------- resumable state ----------
state_done() { [ -f "$WL_STATE_FILE" ] && grep -qx "$1" "$WL_STATE_FILE"; }
state_mark() { [ "$WL_DRY_RUN" = "1" ] && return 0; mkdir -p "$(dirname "$WL_STATE_FILE")"; state_done "$1" || printf '%s\n' "$1" >> "$WL_STATE_FILE"; }
state_clear() { [ "$WL_DRY_RUN" = "1" ] || rm -f "$WL_STATE_FILE"; }

# ---------- templates ----------
# render_template <template> <KEY=value>...: replaces @KEY@ with value (values are validated by the caller; no secrets go through here).
render_template() {
  local tpl="$1" out; shift
  [ -f "$tpl" ] || die "Template not found: $tpl"
  out="$(cat "$tpl")"
  local kv k v
  for kv in "$@"; do k="${kv%%=*}"; v="${kv#*=}"; out="${out//@${k}@/${v}}"; done
  if printf '%s' "$out" | grep -qE '@[A-Z_]+@'; then die "Unreplaced placeholder in $tpl: $(printf '%s' "$out" | grep -oE '@[A-Z_]+@' | sort -u | tr '\n' ' ')"; fi
  printf '%s\n' "$out"
}

# ---------- environment file ----------
# env_get <KEY> reads a value from the env file without sourcing it (so nothing in the file is ever executed).
env_get() { [ -f "$WL_ENV_FILE" ] && sed -n "s/^${1}=//p" "$WL_ENV_FILE" | head -n1; }
# env_set_if_missing <KEY> <value>: adds a key only when absent; never changes an existing value (never touches MASTER_KEY).
env_set_if_missing() { grep -q "^${1}=" "$WL_ENV_FILE" 2>/dev/null || printf '%s=%s\n' "$1" "$2" >> "$WL_ENV_FILE"; }
env_port() { local p; p="$(env_get PORT)"; printf '%s' "${p:-$WL_PORT_DEFAULT}"; }

# ---------- release helpers ----------
# The release name is manifest.json's "version_name" when it has one (0.8.0-beta.1; Chrome itself only allows numbers in "version"), else "version".
manifest_version_of() { local f="$1" v; [ -f "$f" ] || return 0; v="$(sed -n 's/.*"version_name": *"\([^"]*\)".*/\1/p' "$f" | head -n1)"; [ -n "$v" ] || v="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$f" | head -n1)"; printf '%s' "$v"; }
installed_version() { manifest_version_of "${WL_PREFIX}/current/manifest.json"; }
# release_manifest_ok <dir> <version>: the release in <dir> is exactly <version>. Its manifest.json names it in "version_name" (or in
# "version" when there is no version_name), and its numeric "version" is that version's number (0.8.0 for 0.8.0-rc.1). Chrome only
# allows numbers in "version", so every 0.8.0 pre-release and the final 0.8.0 share "version": "0.8.0"; only version_name tells them apart.
release_manifest_ok() {
  local f="$1/manifest.json" num name want="${2#v}"
  [ -f "$f" ] && [ -n "$want" ] || return 1
  num="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$f" | head -n1)"; name="$(sed -n 's/.*"version_name": *"\([^"]*\)".*/\1/p' "$f" | head -n1)"
  [ -n "$num" ] && [ "${name:-$num}" = "$want" ] && [ "$num" = "$(_ver_core "$want")" ]
}
source_version() { manifest_version_of "$1/manifest.json"; }
latest_extension_zip() { local f; f="$(ls -1t "${WL_VAR}/extension"/yt-watch-tracker-v*.zip 2>/dev/null | head -n1 || true)"; printf '%s' "$f"; }
sha256_of() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# health_wait <seconds>: waits for the local health endpoint
health_wait() {
  local n="${1:-30}" port; port="$(env_port)"
  [ "$WL_DRY_RUN" = "1" ] && return 0
  while [ "$n" -gt 0 ]; do curl -fsS -m 3 "http://127.0.0.1:${port}/api/health" 2>/dev/null | grep -q '"ok":true' && return 0; sleep 1; n=$((n - 1)); done
  return 1
}
# service_user_run <command...>: runs as the service user (so files it creates are owned by it)
service_user_run() {
  if [ "$WL_DRY_RUN" = "1" ]; then printf '  %s+ (as %s) %s%s\n' "$C_DIM" "$WL_USER" "$*" "$C_RESET"; return 0; fi
  if [ -n "$WL_ROOT" ] || [ "$(id -u)" != "0" ]; then "$@"; else runuser -u "$WL_USER" -- "$@"; fi
}
# app_node <script> [args...]: runs the app's Node with the environment file loaded by Node itself (--env-file), as the service user.
# Secrets are read from the 0640 file; they never appear in a command line or in the process list.
app_node() { service_user_run "${WL_NODE:-$WL_NODE_BIN}" --env-file="$WL_ENV_FILE" "$@"; }

# deploy_release_dir <source dir>: copies a release into releases/<version>, installs its production dependencies as the service user,
# and sets REL_DIR. It does NOT switch the "current" link: the caller does that when it is ready (install: at once; update: after backup + migration).
# An existing finished release of the same version is reused, never overwritten.
REL_DIR=""
deploy_release_dir() {
  local src="$1" ver rel
  ver="$(source_version "$src")"; [ -n "$ver" ] || die "Cannot read the version from ${src}/manifest.json"
  valid_semver "$ver" || die "Unexpected version string: ${ver}"
  rel="${WL_PREFIX}/releases/${ver}"; REL_DIR="$rel"
  release_manifest_ok "$src" "$ver" || die "The release's manifest.json is inconsistent (version and version_name must name the same release). Nothing was changed."
  if [ -f "$rel/.install-complete" ] && [ -d "$rel/server/node_modules" ]; then
    # Reused only when it really holds this version (BUG_FIX_REPORT A29: v0.7.0's update.sh put a 0.8.0 pre-release into releases/0.8.0,
    # and the final 0.8.0 would then have "found" the pre-release already deployed and kept running it).
    if release_manifest_ok "$rel" "$ver" && [ "$(head -n1 "$rel/.install-complete" 2>/dev/null)" = "$ver" ]; then ok "Release ${ver} already deployed"; return 0; fi
    if [ -e "${WL_PREFIX}/current" ] && [ "$(readlink -f "$rel")" = "$(readlink -f "${WL_PREFIX}/current")" ]; then
      die "${rel} is the running release but holds $(source_version "$rel"), not ${ver}. Nothing was changed."
    fi
    warn "${rel} holds $(source_version "$rel"), not ${ver}: it is set aside and ${ver} is installed fresh."
    run mv -T "$rel" "${rel}.mismatch-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  info "Copying release ${ver}"
  run rm -rf "${rel}.partial"; run mkdir -p "${rel}.partial"
  if [ "$WL_DRY_RUN" = "1" ]; then info "(would copy the source tree, excluding .git, node_modules, dist and any data)"; else
    tar -C "$src" --exclude=.git --exclude=node_modules --exclude=dist --exclude=server/data --exclude='*.db' --exclude='*.db-*' --exclude='*.env' --exclude='*.pem' -cf - . | tar -C "${rel}.partial" -xf -
  fi
  run chown -R "$WL_USER:$WL_USER" "${rel}.partial"
  info "Installing dependencies (npm ci, production only)"
  if [ "$WL_DRY_RUN" = "1" ]; then run npm ci --omit=dev; else
    ( cd "${rel}.partial/server" && PATH="${WL_PREFIX}/node/bin:$PATH" HOME="$WL_VAR" npm_config_cache="${WL_VAR}/.npm" service_user_run "${WL_PREFIX}/node/bin/npm" ci --omit=dev --no-audit --no-fund ) || die "npm ci failed (see the messages above)."
    printf '%s\n' "$ver" > "${rel}.partial/.install-complete"
    [ -n "$WL_ROOT" ] || chown -R root:root "${rel}.partial"
    chmod -R go-w "${rel}.partial"
    rm -rf "$rel"; mv "${rel}.partial" "$rel"
  fi
  done_ok "Release ${ver} deployed with its dependencies"
}
# normalize_current_release: when the running release's folder is named after a different version than it holds, rename it after the
# version it really holds and point "current" at the new name, before anything else changes (BUG_FIX_REPORT A29). v0.7.0's update.sh
# named every 0.8.0 pre-release "0.8.0" (it only read the numeric "version"); without this, the real 0.8.0 could not get its own folder.
# Renaming the folder of a running service is safe on Linux (the running process keeps its files); "current" is re-pointed at once.
normalize_current_release() {
  local link="${WL_PREFIX}/current" cur name real dest rels
  [ -L "$link" ] || return 0
  cur="$(readlink -f "$link")"; name="$(basename "$cur")"; rels="$(readlink -f "${WL_PREFIX}/releases" 2>/dev/null || true)"
  [ -n "$rels" ] && [ "$(dirname "$cur")" = "$rels" ] || return 0
  real="$(manifest_version_of "$cur/manifest.json")"
  [ -n "$real" ] && valid_semver "$real" && [ "$real" != "$name" ] || return 0
  release_manifest_ok "$cur" "$real" || die "The running release ${name} has an inconsistent manifest.json; fix it by hand before updating. Nothing was changed."
  dest="${rels}/${real}"
  if [ -e "$dest" ]; then
    { release_manifest_ok "$dest" "$real" && [ -f "$dest/.install-complete" ] && [ -d "$dest/server/node_modules" ]; } || die "The running release folder ${name} holds ${real}, and ${dest} already exists with something else. Resolve it by hand before updating. Nothing was changed."
    warn "The running release folder ${name} holds ${real}; pointing the server at ${dest}, which holds the same release."
    [ "$WL_DRY_RUN" = "1" ] && return 0
    switch_current "$dest"; return 0
  fi
  warn "The running release folder ${name} holds ${real} (named by an older update.sh); renaming it to ${real}."
  [ "$WL_DRY_RUN" = "1" ] && return 0
  mv -T "$cur" "$dest"
  switch_current "$dest"
  printf '%s\n' "$real" > "$dest/.install-complete"
  ok "The running release is now ${dest}"
}
# verify_running <release dir> <version>: true only when "current" points at that release, its manifest and server/package.json both say
# that version and, on a real server, the running service's working folder is inside it. Never report an update as done otherwise.
verify_running() {
  local rel want="${2#v}" cur pv pid cwd
  rel="$(readlink -f "$1" 2>/dev/null || true)"; cur="$(readlink -f "${WL_PREFIX}/current" 2>/dev/null || true)"
  [ -n "$rel" ] && [ "$cur" = "$rel" ] || { fail "${WL_PREFIX}/current does not point at ${1}."; return 1; }
  release_manifest_ok "$cur" "$want" || { fail "The running release's manifest.json does not say ${want}."; return 1; }
  pv="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$cur/server/package.json" 2>/dev/null | head -n1)"
  [ "$pv" = "$want" ] || { fail "The running release's server/package.json says '${pv}', not ${want}."; return 1; }
  if [ -z "$WL_ROOT" ] && have systemctl; then
    pid="$(systemctl show -p MainPID --value "$WL_SERVICE" 2>/dev/null || true)"
    [ -n "$pid" ] && [ "$pid" != "0" ] || { fail "The service has no running process."; return 1; }
    cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
    case "$cwd" in "$cur"|"$cur"/*) ;; *) fail "The running service works in '${cwd}', not in ${cur}."; return 1;; esac
  fi
  return 0
}
# switch_current <release dir>: atomically points "current" at a release
switch_current() { run ln -sfn "$1" "${WL_PREFIX}/current.new"; run mv -T "${WL_PREFIX}/current.new" "${WL_PREFIX}/current"; }
