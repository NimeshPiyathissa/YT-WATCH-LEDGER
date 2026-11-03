#!/usr/bin/env bash
# Watch Ledger: health check for an installed server.   Powered by SciLink Project.
#
#   ./scripts/health-check.sh            human-readable report
#   ./scripts/health-check.sh --quiet    print only problems (for cron)
#
# Exit code: 0 = everything OK, 1 = warnings, 2 = a critical problem. Works for monitoring (cron mail, Uptime Kuma "push", etc.).
# Read-only: it changes nothing. Needs no root, except to read the certificate and the data folder (it says so when it cannot).
# shellcheck shell=bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

QUIET=0; WARNS=0; CRITS=0
for a in "$@"; do case "$a" in --quiet) QUIET=1;; -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;; *) die "Unknown option: $a";; esac; done

good() { [ "$QUIET" = "1" ] || ok "$*"; }
note() { WARNS=$((WARNS + 1)); warn "$*"; }
crit() { CRITS=$((CRITS + 1)); fail "$*"; }

main() {
  [ "$QUIET" = "1" ] || banner "HEALTH CHECK"
  local port domain days_left age_h free_pct newest f
  if [ ! -f "$WL_ENV_FILE" ]; then
    if [ -r "$WL_ETC" ] || [ ! -e "$WL_ETC" ]; then crit "No installation found (missing ${WL_ENV_FILE})"; else crit "Cannot read ${WL_ETC}: run this with sudo"; fi
    exit 2
  fi
  port="$(env_port)"; domain="$(env_get BASE_URL | sed 's#^https://##')"

  if [ -z "$WL_ROOT" ] && have systemctl; then
    if systemctl is-active --quiet "$WL_SERVICE"; then good "Service ${WL_SERVICE} is active"; else crit "Service ${WL_SERVICE} is NOT running (systemctl status ${WL_SERVICE})"; fi
    if systemctl is-enabled --quiet "$WL_SERVICE" 2>/dev/null; then good "Service starts automatically at boot"; else note "Service is not enabled at boot (systemctl enable ${WL_SERVICE})"; fi
    systemctl is-active --quiet nginx && good "nginx is active" || crit "nginx is NOT running"
  fi
  if curl -fsS -m 5 "http://127.0.0.1:${port}/api/health" 2>/dev/null | grep -q '"ok":true'; then good "Application health endpoint answers"; else crit "Application health endpoint does not answer on 127.0.0.1:${port}"; fi
  if [ -n "$domain" ] && [ -z "$WL_ROOT" ] && have curl; then
    if curl -fsS -m 10 "https://${domain}/api/health" 2>/dev/null | grep -q '"ok":true'; then good "HTTPS works: https://${domain}"; else crit "https://${domain}/api/health is not reachable (DNS, firewall, nginx or certificate)"; fi
  fi
  f="${WL_ROOT}/etc/letsencrypt/live/${domain}/fullchain.pem"
  if [ -n "$domain" ] && [ -r "$f" ] && have openssl; then
    days_left=$(( ( $(date -d "$(openssl x509 -enddate -noout -in "$f" | cut -d= -f2)" +%s) - $(date +%s) ) / 86400 ))
    if [ "$days_left" -lt 7 ]; then crit "Certificate expires in ${days_left} day(s): renewal is failing (certbot renew)"; elif [ "$days_left" -lt 21 ]; then note "Certificate expires in ${days_left} days"; else good "Certificate valid for ${days_left} more days"; fi
  elif [ -n "$domain" ]; then [ "$QUIET" = "1" ] || info "Certificate not checked (run with sudo to read it)"; fi
  free_pct="$(df -P "${WL_VAR}" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print 100-$5}')"
  if [ -n "$free_pct" ]; then if [ "$free_pct" -lt 5 ]; then crit "Disk almost full: ${free_pct}% free"; elif [ "$free_pct" -lt 15 ]; then note "Disk space is getting low: ${free_pct}% free"; else good "Disk space: ${free_pct}% free"; fi; fi
  newest="$(ls -1t "${WL_VAR}"/backups/*.db "${WL_VAR}"/backups/manual/*.db "${WL_VAR}"/backups/pre-update/*.db 2>/dev/null | head -n1 || true)"
  if [ -z "$newest" ]; then note "No backup found yet"
  else age_h=$(( ( $(date +%s) - $(date -r "$newest" +%s) ) / 3600 )); if [ "$age_h" -gt 72 ]; then note "Newest backup is ${age_h} hours old"; else good "Newest backup is ${age_h} hour(s) old"; fi; fi
  [ "$(stat -c %a "$WL_ENV_FILE" 2>/dev/null || echo 640)" -le 640 ] && good "Configuration file permissions are restrictive" || note "${WL_ENV_FILE} is more permissive than 640 (it holds the encryption keys): chmod 640"
  local v; v="$(installed_version || true)"; [ -n "$v" ] && [ "$QUIET" != "1" ] && info "Installed version: ${v}"

  if [ "$CRITS" -gt 0 ]; then say ""; fail "${CRITS} critical problem(s), ${WARNS} warning(s)"; exit 2; fi
  if [ "$WARNS" -gt 0 ]; then say ""; warn "${WARNS} warning(s)"; exit 1; fi
  [ "$QUIET" = "1" ] || { say ""; ok "All checks passed"; }
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
