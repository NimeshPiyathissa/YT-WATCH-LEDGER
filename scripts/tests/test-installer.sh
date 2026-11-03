#!/usr/bin/env bash
# Tests for the install / update / backup / restore / health-check scripts. Runs in a throw-away sandbox root (WL_ROOT), so nothing
# outside a temporary folder is touched. It exercises the real logic (real migrations, real owner creation, real backups and
# restores, a real server for the health check). What it cannot do is run apt, systemd, nginx, certbot or ufw: those are
# REQUIRES REAL VPS and are reported as such in docs/. Output is TAP-like: "ok N - name" / "not ok N - name".
# shellcheck shell=bash disable=SC2034
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then TMPBASE="$(cygpath -m "$(mktemp -d)")"; else TMPBASE="$(mktemp -d)"; fi
export WL_ROOT="$TMPBASE/root"; mkdir -p "$WL_ROOT"
export NO_COLOR=1 WL_NODE="${WL_NODE:-node}"
N=0; FAILS=0
pass() { N=$((N + 1)); printf 'ok %d - %s\n' "$N" "$1"; }
flunk() { N=$((N + 1)); FAILS=$((FAILS + 1)); printf 'not ok %d - %s\n' "$N" "$1"; [ -n "${2:-}" ] && printf '#   %s\n' "$2"; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else flunk "$name" "command failed: $*"; fi; }
check_not() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then flunk "$name" "expected failure: $*"; else pass "$name"; fi; }
contains() { printf '%s' "$1" | grep -qF -- "$2"; }
cleanup() { [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$TMPBASE"; }
trap cleanup EXIT

# shellcheck source=../lib/common.sh
. "$REPO/scripts/lib/common.sh"
# shellcheck source=../install.sh
. "$REPO/scripts/install.sh"
set +e +E; trap - ERR       # the test harness reports failures itself; sourcing the scripts must not make it exit

echo "# --- validators"
check "domain: a normal subdomain is accepted" valid_domain tracker.example.com
check_not "domain: an IP address is rejected" valid_domain 203.0.113.7
check_not "domain: no dot (localhost) is rejected" valid_domain localhost
check_not "domain: uppercase / spaces / underscores are rejected" valid_domain "Bad_Name.example.com"
check_not "domain: a trailing dot or leading hyphen is rejected" valid_domain "-x.example.com"
check "email: a normal address is accepted" valid_email owner@example.com
check_not "email: missing @ is rejected" valid_email owner.example.com
check "password: strong one accepted" strong_password 'Tr0ub4dor&3xyz' owner@example.com
check_not "password: too short" strong_password 'Ab1!short'
check_not "password: no symbol" strong_password 'Abcdefghij12'
check_not "password: no digit" strong_password 'Abcdefghij!!'
check_not "password: contains the email name" strong_password 'ownerNAME-2026-xyz!' ownername@example.com
check_not "password: four repeated characters" strong_password 'Abcd1111!!zzzz'
check_not "password: a common word" strong_password 'MyPassword-2026!x'
check "version_ge: 0.7.1 >= 0.7.0" version_ge 0.7.1 0.7.0
check "version_ge: v0.10.0 >= 0.9.9 (numeric, not alphabetic)" version_ge v0.10.0 0.9.9
check_not "version_ge: 0.6.9 < 0.7.0" version_ge 0.6.9 0.7.0
valid_semver v1.2.3 && valid_semver 1.2.3-rc.1 && ! valid_semver "1.2" && pass "semver: validation" || flunk "semver: validation"
if has_repeat4 "aaaa" && ! has_repeat4 "abab"; then pass "has_repeat4 detects runs without regex back-references"; else flunk "has_repeat4"; fi

echo "# --- templates"
UNIT="$(render_template "$REPO/deploy/watch-ledger.service.tpl" USER=watchledger PREFIX=/opt/watch-ledger ETC=/etc/watch-ledger VAR=/var/lib/watch-ledger NODE=/opt/watch-ledger/node/bin/node)"
contains "$UNIT" "ExecStart=/opt/watch-ledger/node/bin/node src/server.js" && pass "service unit: ExecStart uses the private Node.js" || flunk "service unit ExecStart"
contains "$UNIT" "EnvironmentFile=/etc/watch-ledger/watch-ledger.env" && pass "service unit: secrets come from the environment file" || flunk "service unit env file"
for d in NoNewPrivileges=true ProtectSystem=strict PrivateTmp=true "ReadWritePaths=/var/lib/watch-ledger" User=watchledger Restart=on-failure; do contains "$UNIT" "$d" && pass "service unit: $d" || flunk "service unit: $d"; done
printf '%s' "$UNIT" | grep -qE '@[A-Z_]+@' && flunk "service unit: no unreplaced placeholder" || pass "service unit: no unreplaced placeholder"
HTTP="$(render_template "$REPO/deploy/nginx-http.conf.tpl" DOMAIN=tracker.example.com WEBROOT=/var/www/letsencrypt)"
contains "$HTTP" "server_name tracker.example.com;" && contains "$HTTP" "acme-challenge" && contains "$HTTP" "return 301 https://" && pass "nginx stage 1: ACME challenge + redirect to HTTPS" || flunk "nginx stage 1"
HTTPS="$(render_template "$REPO/deploy/nginx-https.conf.tpl" DOMAIN=tracker.example.com WEBROOT=/var/www/letsencrypt PORT=8787)"
for d in "ssl_certificate     /etc/letsencrypt/live/tracker.example.com/fullchain.pem" "proxy_pass http://127.0.0.1:8787;" 'proxy_set_header X-Forwarded-For $remote_addr;' "location = /api/events" "location = /api/device/ws" "proxy_buffering off;" "ssl_protocols TLSv1.2 TLSv1.3;" 'proxy_set_header Upgrade $http_upgrade;'; do contains "$HTTPS" "$d" && pass "nginx stage 2: $d" || flunk "nginx stage 2: $d"; done
contains "$HTTPS" '$proxy_add_x_forwarded_for' && flunk "nginx: X-Forwarded-For is overwritten, never appended (no spoofing)" || pass "nginx: X-Forwarded-For is overwritten, never appended (no spoofing)"
opens="$(printf '%s' "$HTTPS" | tr -cd '{' | wc -c)"; closes="$(printf '%s' "$HTTPS" | tr -cd '}' | wc -c)"; [ "$opens" = "$closes" ] && pass "nginx stage 2: braces balance ($opens)" || flunk "nginx braces" "$opens vs $closes"
( render_template "$REPO/deploy/nginx-http.conf.tpl" DOMAIN=x.example.com ) >/dev/null 2>&1 && flunk "a missing template value is an error" || pass "a missing template value is an error"

echo "# --- configuration and key preservation"
export DOMAIN=tracker.example.com
mkdir -p "$WL_ETC" "$WL_VAR/data" "$WL_VAR/backups"
configure_environment >/dev/null 2>&1
[ -f "$WL_ENV_FILE" ] && pass "env file is created" || flunk "env file is created"
MK="$(env_get MASTER_KEY)"; CS="$(env_get COOKIE_SECRET)"
[ "$(printf '%s' "$MK" | base64 -d 2>/dev/null | wc -c)" = "32" ] && pass "MASTER_KEY is 32 random bytes (base64)" || flunk "MASTER_KEY length"
[[ "$CS" =~ ^[0-9a-f]{64}$ ]] && pass "COOKIE_SECRET is 64 hex characters" || flunk "COOKIE_SECRET format"
[ "$(env_get BASE_URL)" = "https://tracker.example.com" ] && [ "$(env_get TRUST_PROXY)" = "true" ] && [ "$(env_get NODE_ENV)" = "production" ] && pass "production settings: https BASE_URL, TRUST_PROXY, NODE_ENV" || flunk "production settings"
case "$(env_get DB_PATH)" in "$WL_VAR"/data/tracker.db) pass "DB_PATH is inside the data directory";; *) flunk "DB_PATH" "$(env_get DB_PATH)";; esac
[ "$(uname -s)" = "Linux" ] && { [ "$(stat -c %a "$WL_ENV_FILE")" = "640" ] && pass "env file mode is 640" || flunk "env file mode"; } || echo "# SKIP env file mode (not Linux)"
SUM1="$(sha256_of "$WL_ENV_FILE")"
DOMAIN=other.example.org configure_environment >/tmp/wl-envout.txt 2>&1
[ "$(sha256_of "$WL_ENV_FILE")" = "$SUM1" ] && pass "RE-RUN: the existing env file (and so MASTER_KEY) is never changed" || flunk "re-run changed the env file"
grep -q "NOT changed" /tmp/wl-envout.txt && pass "RE-RUN with a different domain: warned, not silently rewritten" || flunk "domain change warning"
env_set_if_missing MASTER_KEY "attacker-controlled"; [ "$(env_get MASTER_KEY)" = "$MK" ] && pass "env_set_if_missing never overwrites MASTER_KEY" || flunk "env_set_if_missing overwrote a key"
env_set_if_missing NEW_SETTING 1; [ "$(env_get NEW_SETTING)" = "1" ] && pass "env_set_if_missing adds a missing setting" || flunk "env_set_if_missing add"
grep -q "$MK" /tmp/wl-envout.txt && flunk "secrets are never printed" || pass "secrets are never printed by the installer"
sed -i 's/^PORT=.*/PORT=8799/' "$WL_ENV_FILE"

echo "# --- real database setup through the installer"
mkdir -p "$WL_PREFIX"; ln -sfn "$REPO" "$WL_PREFIX/current"
export WL_NODE; WL_NODE_BIN="$WL_NODE"
ADMIN_EMAIL=owner@example.com; ADMIN_PASSWORD='Str0ng&Secret#2026'
setup_database >/tmp/wl-db1.txt 2>&1
[ -f "$WL_VAR/data/tracker.db" ] && pass "the database file is created" || flunk "database not created" "$(cat /tmp/wl-db1.txt | tail -3)"
q() { ( cd "$REPO/server" && "$WL_NODE" -e "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});console.log(JSON.stringify(d.prepare(process.argv[2]).all()))" "$WL_VAR/data/tracker.db" "$1" ); }
[ "$(q 'SELECT COUNT(*) n FROM schema_migrations' | tr -d '[]' | sed 's/.*:\([0-9]*\).*/\1/')" = "6" ] && pass "all 6 migrations are applied" || flunk "migrations" "$(q 'SELECT name FROM schema_migrations')"
contains "$(q 'SELECT email FROM admins')" "owner@example.com" && pass "the administrator account exists" || flunk "administrator account"
contains "$(q 'SELECT pw_hash FROM admins')" '$argon2' && pass "the password is stored as an argon2 hash, not in clear" || flunk "password hash"
contains "$(cat /tmp/wl-db1.txt)" "Str0ng" && flunk "the password is never printed" || pass "the password is never printed"
ADMIN_PASSWORD='Str0ng&Secret#2026'; setup_database >/tmp/wl-db2.txt 2>&1
[ "$(q 'SELECT COUNT(*) n FROM admins' | grep -o '[0-9]*')" = "1" ] && pass "RE-RUN: still exactly one administrator (an existing owner is left alone)" || flunk "second run changed admins" "$(tail -3 /tmp/wl-db2.txt)"
[ "$(env_get MASTER_KEY)" = "$MK" ] && pass "RE-RUN: MASTER_KEY unchanged" || flunk "MASTER_KEY changed"
state_mark alpha; state_mark alpha; state_mark beta
[ "$(grep -c '^alpha$' "$WL_STATE_FILE")" = "1" ] && state_done beta && ! state_done gamma && pass "resume state: marks are idempotent and queryable" || flunk "state file"

echo "# --- DNS check (stubbed network)"
SHIM="$TMPBASE/shim"; mkdir -p "$SHIM"
if command -v cygpath >/dev/null 2>&1; then SHIMP="$(cygpath -u "$SHIM")"; else SHIMP="$SHIM"; fi   # PATH entries must be POSIX paths (a drive-letter colon would split them)
printf '#!/bin/sh\ncase "$*" in *api.ipify.org*|*ifconfig.me*) echo 203.0.113.7;; *) exit 22;; esac\n' > "$SHIM/curl"
printf '#!/bin/sh\nif [ "$1" = "ahostsv4" ]; then echo "198.51.100.9 STREAM $2"; fi\n' > "$SHIM/getent"
chmod +x "$SHIM/curl" "$SHIM/getent"
out="$( PATH="$SHIMP:$PATH" bash -c ". '$REPO/scripts/install.sh'; set +e; DOMAIN=tracker.example.com WL_DRY_RUN=0; check_dns" 2>&1 )"; code=$?
[ "$code" = "3" ] && pass "DNS pointing elsewhere: exits 3 (resumable), no certificate requested" || flunk "DNS mismatch exit code" "code=$code"
contains "$out" "points to 198.51.100.9, not to this server (203.0.113.7)" && contains "$out" "--resume" && pass "DNS mismatch: clear instructions and the resume command" || flunk "DNS mismatch message" "$out"
printf '#!/bin/sh\nif [ "$1" = "ahostsv4" ]; then echo "203.0.113.7 STREAM $2"; fi\n' > "$SHIM/getent"
out="$( PATH="$SHIMP:$PATH" bash -c ". '$REPO/scripts/install.sh'; set +e; DOMAIN=tracker.example.com WL_DRY_RUN=0; check_dns" 2>&1 )"; code=$?
[ "$code" = "0" ] && contains "$out" "points to this server" && pass "DNS pointing here: check passes" || flunk "DNS match" "code=$code $out"
printf '#!/bin/sh\nif [ "$1" = "ahostsv4" ]; then echo "203.0.113.7 STREAM $2"; fi\nif [ "$1" = "ahostsv6" ]; then echo "2001:db8::1 STREAM $2"; fi\n' > "$SHIM/getent"
out="$( PATH="$SHIMP:$PATH" bash -c ". '$REPO/scripts/install.sh'; set +e; DOMAIN=tracker.example.com WL_DRY_RUN=0; check_dns" 2>&1 )"; code=$?
[ "$code" = "3" ] && contains "$out" "AAAA" && pass "a stray AAAA record that leads elsewhere is caught before Let's Encrypt fails" || flunk "AAAA mismatch" "code=$code"

echo "# --- the installer wizard (dry run)"
export WL_ADMIN_EMAIL=admin@example.com WL_ADMIN_PASSWORD='Str0ng&Secret#2026'
out="$(bash "$REPO/scripts/install.sh" --dry-run --non-interactive --yes --domain tracker.example.com --letsencrypt-email admin@example.com --agree-tos 2>&1)"; code=$?
[ "$code" = "0" ] && pass "dry run completes (exit 0)" || flunk "dry run exit" "code=$code"
for s in "STEP 1: SYSTEM CHECK" "STEP 2: ADMIN ACCOUNT" "STEP 3: DOMAIN SETUP" "STEP 4: DATABASE SETUP" "STEP 5: APPLICATION INSTALLATION" "STEP 6: SSL SETUP" "STEP 7: EXTENSION SETUP" "STEP 8: FINAL VERIFICATION" "Powered by SciLink Project"; do contains "$out" "$s" && pass "wizard shows: $s" || flunk "wizard: $s"; done
contains "$out" "certbot certonly --webroot" && pass "wizard plans a webroot certbot request" || flunk "certbot plan"
contains "$out" "Str0ng" && flunk "the password is not echoed" || pass "the wizard never echoes the password"
out="$(bash "$REPO/scripts/install.sh" --admin-password hunter2 2>&1)"; [ $? -ne 0 ] && contains "$out" "never accepted as arguments" && pass "a password on the command line is refused" || flunk "password argument"
out="$(WL_ROOT="$TMPBASE/fresh" WL_ADMIN_PASSWORD=short bash "$REPO/scripts/install.sh" --dry-run --non-interactive --domain tracker.example.com --agree-tos 2>&1)"; [ $? -ne 0 ] && contains "$out" "too weak" && pass "a weak password stops the wizard" || flunk "weak password" "$(printf '%s' "$out" | tail -4)"
out="$(bash "$REPO/scripts/install.sh" --dry-run --non-interactive --domain 203.0.113.7 --agree-tos 2>&1)"; [ $? -ne 0 ] && contains "$out" "not an IP address" && pass "an IP address is refused as the domain" || flunk "IP domain"
out="$(bash "$REPO/scripts/install.sh" --dry-run --non-interactive --domain tracker.example.com --agree-tos --port 80 2>&1)"; [ $? -ne 0 ] && contains "$out" "between 1024 and 65535" && pass "port 80 is refused" || flunk "port 80 refusal"
out="$(bash "$REPO/scripts/install.sh" --dry-run --non-interactive --domain tracker.example.com --agree-tos --port abc 2>&1)"; [ $? -ne 0 ] && contains "$out" "must be a number" && pass "a non-numeric port is refused" || flunk "port abc refusal"

echo "# --- backup, restore and update against the real database"
export WL_USER=nobody
BK="$(bash "$REPO/scripts/backup.sh" 2>&1)"; code=$?
[ "$code" = "0" ] && pass "backup.sh runs" || flunk "backup.sh" "$BK"
F1="$(ls -1t "$WL_VAR/backups/manual"/*.db 2>/dev/null | head -n1)"
[ -f "$F1" ] && pass "a verified backup file is written to the manual folder" || flunk "backup file"
sleep 1.1; bash "$REPO/scripts/backup.sh" --quiet >/dev/null 2>&1
[ "$(ls -1 "$WL_VAR/backups/manual"/*.db 2>/dev/null | wc -l | tr -d ' ')" = "2" ] && pass "a second backup does not replace or prune the first" || flunk "backups kept"
mkdir -p "$TMPBASE/offsite"; bash "$REPO/scripts/backup.sh" --quiet --dest "$TMPBASE/offsite" >/dev/null 2>&1
[ "$(ls -1 "$TMPBASE/offsite"/*.db 2>/dev/null | wc -l | tr -d ' ')" = "1" ] && pass "--dest copies the backup and verifies the copy" || flunk "--dest"
bash "$REPO/scripts/backup.sh" --with-keys >/dev/null 2>&1 && flunk "--with-keys without --dest is refused" || pass "--with-keys without --dest is refused"
bash "$REPO/scripts/backup.sh" --quiet --with-keys --dest "$TMPBASE/offsite" >/dev/null 2>&1
KF="$(ls -1 "$TMPBASE/offsite"/watch-ledger-keys-*.env 2>/dev/null | head -n1)"
[ -n "$KF" ] && grep -q "^MASTER_KEY=" "$KF" && ! grep -q "^BASE_URL" "$KF" && pass "--with-keys saves only the two secrets" || flunk "--with-keys"
# change the data, restore, and check the old state returns with the current database kept aside
( cd "$REPO/server" && "$WL_NODE" -e "const D=require('better-sqlite3');const d=new D(process.argv[1]);d.prepare(\"INSERT INTO settings(key,value) VALUES('marker','after-backup')\").run();d.close()" "$WL_VAR/data/tracker.db" )
contains "$(q "SELECT value FROM settings WHERE key='marker'")" "after-backup" && pass "(setup) data changed after the backup" || flunk "setup marker"
out="$(bash "$REPO/scripts/restore.sh" --yes "$F1" 2>&1)"; code=$?
[ "$code" = "0" ] && pass "restore.sh runs" || flunk "restore.sh" "$out"
contains "$(q "SELECT value FROM settings WHERE key='marker'")" "after-backup" && flunk "restore brought back the backed-up state" || pass "restore brings back the backed-up state"
ls "$WL_VAR/data"/tracker.db.pre-restore-* >/dev/null 2>&1 && pass "the database being replaced was kept aside (pre-restore copy)" || flunk "pre-restore copy"
bash "$REPO/scripts/restore.sh" --yes "$TMPBASE/does-not-exist.db" >/dev/null 2>&1 && flunk "a missing backup file is refused" || pass "a missing backup file is refused"
printf 'not a database' > "$TMPBASE/corrupt.db"; before="$(sha256_of "$WL_VAR/data/tracker.db")"
bash "$REPO/scripts/restore.sh" --yes "$TMPBASE/corrupt.db" >/dev/null 2>&1 && flunk "a corrupt backup is refused" || pass "a corrupt backup is refused"
q "SELECT 1 AS ok" >/dev/null 2>&1 && pass "…and the live database is still intact afterwards" || flunk "live database damaged by a refused restore"

echo "# --- update.sh version and integrity rules"
mkdir -p "$TMPBASE/newsrc/server"; printf '{ "version": "0.7.1" }\n' > "$TMPBASE/newsrc/manifest.json"
out="$(bash "$REPO/scripts/update.sh" --from-dir "$TMPBASE/newsrc" --dry-run --yes 2>&1)"; code=$?
[ "$code" = "0" ] && contains "$out" "Installed version: 0.7.0" && contains "$out" "Target version:    0.7.1" && pass "update dry run: 0.7.0 -> 0.7.1 plan" || flunk "update plan" "code=$code $out"
contains "$out" "Would take a verified backup" && pass "update plan: a backup comes before anything else" || flunk "update backup step"
mkdir -p "$TMPBASE/oldsrc/server"; printf '{ "version": "0.6.0" }\n' > "$TMPBASE/oldsrc/manifest.json"
out="$(bash "$REPO/scripts/update.sh" --from-dir "$TMPBASE/oldsrc" --dry-run --yes 2>&1)"; [ $? -ne 0 ] && contains "$out" "older than the installed" && pass "a downgrade is refused" || flunk "downgrade refusal"
out="$(bash "$REPO/scripts/update.sh" --from-dir "$REPO" --dry-run --yes 2>&1)"; code=$?; [ "$code" = "0" ] && contains "$out" "Already running" && pass "the same version is not reinstalled without --force" || flunk "same version" "$out"
tar --force-local -czf "$TMPBASE/rel.tar.gz" -C "$TMPBASE" newsrc
out="$(bash "$REPO/scripts/update.sh" --from-tarball "$TMPBASE/rel.tar.gz" --dry-run --yes 2>&1)"; [ $? -ne 0 ] && contains "$out" "--sha256" && pass "an unverified tarball is refused (checksum required)" || flunk "tarball needs checksum"
out="$(bash "$REPO/scripts/update.sh" --from-tarball "$TMPBASE/rel.tar.gz" --sha256 0000000000000000000000000000000000000000000000000000000000000000 --dry-run --yes 2>&1)"; [ $? -ne 0 ] && contains "$out" "Checksum mismatch" && pass "a tarball with the wrong checksum is refused, nothing changed" || flunk "bad checksum"
GOOD="$(sha256_of "$TMPBASE/rel.tar.gz")"
out="$(bash "$REPO/scripts/update.sh" --from-tarball "$TMPBASE/rel.tar.gz" --sha256 "$GOOD" --dry-run --yes 2>&1)"; [ $? -eq 0 ] && contains "$out" "Checksum verified" && pass "a tarball with the right checksum is accepted" || flunk "good checksum" "$out"
[ "$(env_get MASTER_KEY)" = "$MK" ] && pass "after all update runs: MASTER_KEY is still the original" || flunk "MASTER_KEY changed by update"

echo "# --- health check (with a real server)"
bash "$REPO/scripts/health-check.sh" --quiet >/dev/null 2>&1; code=$?
[ "$code" = "2" ] && pass "health check: a stopped server is CRITICAL (exit 2)" || flunk "health check on a stopped server" "code=$code"
( cd "$REPO/server" && exec "$WL_NODE" --env-file="$WL_ENV_FILE" src/server.js >"$TMPBASE/server.log" 2>&1 ) &
SERVER_PID=$!
health_wait 25 && pass "(setup) the server starts with the generated production configuration" || { flunk "server start" "$(tail -3 "$TMPBASE/server.log")"; }
# the disk check is not what this test is about, and a developer machine may genuinely be nearly full: answer it with a stub df
DFSHIM="$TMPBASE/dfshim"; mkdir -p "$DFSHIM"; printf '#!/bin/sh
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "stub 1000000 500000 500000 50%% /"
' > "$DFSHIM/df"; chmod +x "$DFSHIM/df"
if command -v cygpath >/dev/null 2>&1; then DFP="$(cygpath -u "$DFSHIM")"; else DFP="$DFSHIM"; fi
PATH="$DFP:$PATH" bash "$REPO/scripts/health-check.sh" --quiet >"$TMPBASE/hc.txt" 2>&1; code=$?
[ "$code" = "0" ] || [ "$code" = "1" ] && ! grep -q "NOT running\|does not answer" "$TMPBASE/hc.txt" && pass "health check: a running server passes the application check (exit $code)" || flunk "health check on a running server" "$(cat "$TMPBASE/hc.txt")"
out="$(cd "$REPO" && WL_ADMIN_EMAIL=owner@example.com WL_ADMIN_PASSWORD='Str0ng&Secret#2026' BASE_URL=x "$WL_NODE" scripts/smoke-test.mjs --url "http://127.0.0.1:8799" --anonymous 2>&1)"
contains "$out" "checks passed" && pass "the smoke test (anonymous) passes against the installer-configured server" || flunk "smoke test against the generated config" "$out"
kill "$SERVER_PID" 2>/dev/null; SERVER_PID=""

echo "1..$N"
echo "# $((N - FAILS)) passed, $FAILS failed"
[ "$FAILS" = "0" ]
