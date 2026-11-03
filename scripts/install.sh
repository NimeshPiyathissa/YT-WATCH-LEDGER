#!/usr/bin/env bash
# Watch Ledger: production installer for Ubuntu 22.04 / 24.04 LTS.   Powered by SciLink Project.
#
#   sudo ./scripts/install.sh                       interactive wizard
#   sudo ./scripts/install.sh --resume              continue an interrupted or DNS-pending installation
#   sudo ./scripts/install.sh --dry-run             show what would be done; change nothing
#   sudo WL_ADMIN_EMAIL=... WL_ADMIN_PASSWORD=... ./scripts/install.sh --non-interactive --domain tracker.example.com \
#        --letsencrypt-email you@example.com --agree-tos
#
# Safe to run again: every step checks what already exists. It NEVER regenerates an existing MASTER_KEY, never overwrites an
# existing database, never deletes a backup, and never prints a secret. Full guide: docs/VPS_DEPLOYMENT.md
# shellcheck shell=bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${WL_SOURCE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

DOMAIN="${WL_DOMAIN:-}"; ADMIN_EMAIL="${WL_ADMIN_EMAIL:-}"; ADMIN_PASSWORD="${WL_ADMIN_PASSWORD:-}"; LE_EMAIL="${WL_LE_EMAIL:-}"
SKIP_SSL=0; SKIP_FIREWALL=0; STAGING_CERT=0; AGREE_TOS=0; RESUME=0; FORCE_OS=0; NODE_MAJOR="${WL_NODE_MAJOR:-22}"
CURRENT_STEP="start"; EXIT_DNS_PENDING=3
LOG_FILE="${WL_ROOT}/var/log/watch-ledger-install.log"

usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; cat <<'EOF'

Options:
  --domain NAME            the domain or subdomain, e.g. tracker.example.com
  --letsencrypt-email MAIL address Let's Encrypt uses for expiry notices
  --agree-tos              accept the Let's Encrypt Subscriber Agreement (required with --non-interactive)
  --non-interactive        never prompt; take everything from options and WL_* environment variables
  --yes                    answer yes to confirmations (the firewall question, the unsupported-OS warning)
  --resume                 continue where the last run stopped
  --dry-run                print the actions without performing them
  --skip-ssl               stop after the HTTP stage (the dashboard will not work without HTTPS; for testing only)
  --skip-firewall          do not touch ufw
  --staging-cert           use Let's Encrypt's staging CA (test certificates; avoids rate limits while experimenting)
  --force-os               continue on an operating system that is not Ubuntu 22.04 / 24.04
  --source DIR             install from DIR instead of this checkout
  -h, --help               this help
Environment (non-interactive): WL_DOMAIN, WL_ADMIN_EMAIL, WL_ADMIN_PASSWORD, WL_LE_EMAIL
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) DOMAIN="${2:-}"; shift 2;;
      --letsencrypt-email) LE_EMAIL="${2:-}"; shift 2;;
      --agree-tos) AGREE_TOS=1; shift;;
      --non-interactive) WL_NONINTERACTIVE=1; shift;;
      --yes|-y) WL_ASSUME_YES=1; shift;;
      --resume) RESUME=1; shift;;
      --dry-run) WL_DRY_RUN=1; shift;;
      --skip-ssl) SKIP_SSL=1; shift;;
      --skip-firewall) SKIP_FIREWALL=1; shift;;
      --staging-cert) STAGING_CERT=1; shift;;
      --force-os) FORCE_OS=1; shift;;
      --source) SRC_DIR="${2:-}"; shift 2;;
      -h|--help) usage; exit 0;;
      --admin-password|--password) die "Passwords are never accepted as arguments (they would appear in your shell history and process list). Use the prompt, or WL_ADMIN_PASSWORD in the environment.";;
      *) die "Unknown option: $1 (see --help)";;
    esac
  done
}

on_error() {
  local code=$?
  fail "The installation stopped during: ${CURRENT_STEP} (exit code ${code})."
  say "  Nothing has been deleted. Fix the problem above and re-run:  sudo ./scripts/install.sh --resume"
  [ -f "$LOG_FILE" ] && say "  Log: ${LOG_FILE}"
  say "  Help: docs/TROUBLESHOOTING.md"
  exit "$code"
}
trap on_error ERR

# ---------------------------------------------------------------- STEP 1
step_system_check() {
  CURRENT_STEP="system check"; step 1 "SYSTEM CHECK"
  need_root; ok "Required permissions"
  local os_id="" os_ver=""
  if [ -r /etc/os-release ]; then os_id="$(. /etc/os-release; printf '%s' "${ID:-}")"; os_ver="$(. /etc/os-release; printf '%s' "${VERSION_ID:-}")"; fi
  if [ "$os_id" = "ubuntu" ] && { [ "$os_ver" = "22.04" ] || [ "$os_ver" = "24.04" ]; }; then ok "Operating system: Ubuntu ${os_ver} LTS"
  elif [ "$FORCE_OS" = "1" ] || [ -n "$WL_ROOT" ] || [ "$WL_DRY_RUN" = "1" ]; then warn "Operating system: ${os_id:-unknown} ${os_ver} is not a tested target (Ubuntu 22.04 / 24.04); continuing"
  elif confirm "This is ${os_id:-unknown} ${os_ver}, not Ubuntu 22.04 / 24.04 LTS. Continue anyway?"; then warn "Continuing on an untested system"
  else die "Unsupported operating system. Use Ubuntu 22.04 or 24.04 LTS (or --force-os at your own risk)."; fi
  case "$(uname -m)" in x86_64|aarch64) ok "CPU architecture: $(uname -m), $(nproc 2>/dev/null || echo '?') core(s)";; *) die "Unsupported CPU architecture: $(uname -m)";; esac
  local mem_kb; mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if [ "${mem_kb:-0}" -lt 500000 ] && [ -z "$WL_ROOT" ]; then die "Not enough memory: $((mem_kb / 1024)) MB (at least 1 GB recommended, 512 MB minimum)."
  elif [ "${mem_kb:-0}" -lt 900000 ] && [ -z "$WL_ROOT" ]; then warn "Memory: $((mem_kb / 1024)) MB. It works, but 1 GB or more is recommended."; else ok "Memory: $((mem_kb / 1024)) MB"; fi
  local free_mb; free_mb="$(df -Pm "${WL_ROOT:-/}" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  if [ "${free_mb:-0}" -lt 2500 ] && [ -z "$WL_ROOT" ]; then die "Not enough disk space: ${free_mb} MB free (at least 2.5 GB needed)."; else ok "Storage: ${free_mb:-?} MB free"; fi
  if [ "$WL_DRY_RUN" = "1" ] || have curl; then
    if [ "$WL_DRY_RUN" = "1" ] || curl -fsS -m 10 -o /dev/null https://nodejs.org/dist/index.json 2>/dev/null; then ok "Network: can reach nodejs.org"; else die "Cannot reach https://nodejs.org (outbound HTTPS is required for the installation)."; fi
  else info "Network: curl is not installed yet; it is checked after the packages are installed"; fi
  local busy=""; if have ss; then busy="$(ss -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ && $0 !~ /nginx/ {print $4}' | tr '\n' ' ')"; fi
  if [ -z "$busy" ]; then ok "Ports 80 and 443 are free or used by nginx"; else warn "Something other than nginx is listening on: ${busy}. nginx may fail to start; stop that service first."; fi
  [ -d "$SRC_DIR/server" ] && [ -f "$SRC_DIR/manifest.json" ] || die "This does not look like a Watch Ledger checkout: ${SRC_DIR}"
  ok "Source: Watch Ledger $(source_version "$SRC_DIR")"
  state_mark system_check
}

# ---------------------------------------------------------------- STEP 2 + 3
step_questions() {
  CURRENT_STEP="admin account and domain"
  local db="${WL_VAR}/data/tracker.db"
  step 2 "ADMIN ACCOUNT"
  if [ -f "$db" ]; then
    ok "An existing database was found (${db}). It is kept untouched, and its administrator account stays as it is."
    ADMIN_EMAIL=""; ADMIN_PASSWORD=""
  else
    say "  Watch Ledger has one administrator. You sign in with an email address (there is no separate username)."
    ask "  Administrator email:" ADMIN_EMAIL
    valid_email "$ADMIN_EMAIL" || die "That is not a valid email address."
    if [ -z "$ADMIN_PASSWORD" ]; then
      local again=""
      while :; do
        read_secret "  Administrator password (hidden, 12+ characters): " ADMIN_PASSWORD
        if ! strong_password "$ADMIN_PASSWORD" "$ADMIN_EMAIL"; then warn "Password too weak: ${PW_REASON}"; ADMIN_PASSWORD=""; [ "$WL_NONINTERACTIVE" = "1" ] && die "Weak password."; continue; fi
        read_secret "  Confirm password: " again
        [ "$again" = "$ADMIN_PASSWORD" ] && break
        warn "The passwords do not match. Try again."; ADMIN_PASSWORD=""
      done
      again=""
    else
      strong_password "$ADMIN_PASSWORD" "$ADMIN_EMAIL" || die "WL_ADMIN_PASSWORD is too weak: ${PW_REASON}"
    fi
    ok "Administrator account: ${ADMIN_EMAIL}"
  fi

  step 3 "DOMAIN SETUP"
  if [ -z "$DOMAIN" ] && [ -f "$WL_ENV_FILE" ]; then DOMAIN="$(env_get BASE_URL | sed 's#^https://##')"; [ -n "$DOMAIN" ] && info "Using the domain from the existing installation: ${DOMAIN}"; fi
  say "  Enter the domain or subdomain that will point at this server, for example: tracker.example.com"
  ask "  Domain:" DOMAIN
  DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
  looks_like_ip "$DOMAIN" && die "Use a domain name, not an IP address (HTTPS certificates need a name). See docs/DOMAIN_SETUP.md"
  valid_domain "$DOMAIN" || die "'${DOMAIN}' is not a valid domain name."
  ok "Domain: ${DOMAIN}"
  if [ "$SKIP_SSL" = "0" ]; then
    [ -n "$LE_EMAIL" ] || LE_EMAIL="${ADMIN_EMAIL:-}"
    ask "  Email for Let's Encrypt expiry notices:" LE_EMAIL "${ADMIN_EMAIL:-}"
    valid_email "$LE_EMAIL" || die "That is not a valid email address."
    if [ "$AGREE_TOS" = "0" ]; then
      say "  Certificates come from Let's Encrypt. Subscriber Agreement: https://letsencrypt.org/repository/"
      confirm "  Do you agree to the Let's Encrypt Subscriber Agreement?" || die "The Let's Encrypt agreement must be accepted to obtain a certificate (or use --skip-ssl for a test install)."
      AGREE_TOS=1
    fi
  fi
}

# ---------------------------------------------------------------- STEP 4 part 1: packages, node, user, directories
install_packages() {
  CURRENT_STEP="installing packages"
  state_done packages && { ok "System packages already installed"; return 0; }
  info "Installing system packages (nginx, certbot, build tools). This can take a few minutes."
  run env DEBIAN_FRONTEND=noninteractive apt-get update -y
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates openssl nginx certbot ufw build-essential python3 xz-utils tar gzip zip unzip
  state_mark packages; done_ok "System packages"
}
install_node() {
  CURRENT_STEP="installing Node.js"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would install the official Node.js ${NODE_MAJOR}.x LTS tarball (SHA-256 verified) into ${WL_PREFIX}/node"; return 0; fi
  if [ -x "$WL_NODE_BIN" ] && "$WL_NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then ok "Node.js $("$WL_NODE_BIN" -v) (already installed for Watch Ledger)"; return 0; fi
  local plat base sums file hash tmp
  case "$(uname -m)" in x86_64) plat="linux-x64";; aarch64) plat="linux-arm64";; *) die "Unsupported architecture";; esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums="$(curl -fsS -m 30 "${base}/SHASUMS256.txt")" || die "Could not download the Node.js checksum list."
  file="$(printf '%s\n' "$sums" | awk -v a="$plat" '$2 ~ ("-" a "\\.tar\\.xz$") {print $2; exit}')"
  hash="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1; exit}')"
  [ -n "$file" ] && [ -n "$hash" ] || die "Could not find a Node.js ${NODE_MAJOR}.x build for ${plat}."
  tmp="$(mktemp -d)"
  info "Downloading ${file}"
  curl -fsSL -m 600 "${base}/${file}" -o "${tmp}/${file}" || die "Download failed."
  [ "$(sha256_of "${tmp}/${file}")" = "$hash" ] || die "The Node.js download does not match its published SHA-256 checksum. Aborting."
  ok "Checksum verified"
  mkdir -p "${WL_PREFIX}/node.new"; tar -xJf "${tmp}/${file}" -C "${WL_PREFIX}/node.new" --strip-components=1
  [ -d "${WL_PREFIX}/node" ] && mv "${WL_PREFIX}/node" "${WL_PREFIX}/node.previous.$(date +%s)"   # kept, never deleted automatically
  mv "${WL_PREFIX}/node.new" "${WL_PREFIX}/node"; rm -rf "$tmp"
  ok "Node.js $("$WL_NODE_BIN" -v) installed for Watch Ledger (separate from any system Node.js)"
}
create_user_and_dirs() {
  CURRENT_STEP="creating the service account and directories"
  if ! id -u "$WL_USER" >/dev/null 2>&1; then run useradd --system --home-dir "$WL_VAR" --shell /usr/sbin/nologin --user-group "$WL_USER"; fi
  make_dirs 0755 root root "$WL_PREFIX" "${WL_PREFIX}/releases" "${WL_ROOT}/var/www/letsencrypt"
  make_dirs 0750 root "$WL_USER" "$WL_ETC"
  make_dirs 0750 "$WL_USER" "$WL_USER" "$WL_VAR" "${WL_VAR}/data" "${WL_VAR}/backups" "${WL_VAR}/extension" "${WL_VAR}/backups/manual" "${WL_VAR}/backups/pre-update"
  done_ok "Service account '${WL_USER}' and data directories"
}

# ---------------------------------------------------------------- STEP 4 part 2: application
deploy_release() {
  CURRENT_STEP="deploying the application"
  deploy_release_dir "$SRC_DIR"
  switch_current "$REL_DIR"
  state_mark "release_$(source_version "$SRC_DIR")"
}

# ---------------------------------------------------------------- STEP 4 part 3: configuration and database
configure_environment() {
  CURRENT_STEP="writing the configuration"
  if [ -f "$WL_ENV_FILE" ]; then
    ok "Existing configuration kept: ${WL_ENV_FILE} (MASTER_KEY and COOKIE_SECRET are never regenerated)"
    local have_base; have_base="$(env_get BASE_URL)"
    [ -n "$DOMAIN" ] && [ "$have_base" != "https://${DOMAIN}" ] && warn "The configured address is ${have_base}, but you entered ${DOMAIN}. It was NOT changed; edit BASE_URL and CORS_ORIGIN in ${WL_ENV_FILE} yourself if you are moving the site."
    return 0
  fi
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would create ${WL_ENV_FILE} (mode 0640) with new random MASTER_KEY and COOKIE_SECRET"; return 0; fi
  local old_umask; old_umask="$(umask)"; umask 077
  {
    printf '# Watch Ledger configuration. Created by scripts/install.sh. Mode 0640 root:%s.\n' "$WL_USER"
    printf '# BACK UP MASTER_KEY SEPARATELY FROM THE DATABASE BACKUPS. If it is lost, the stored watch data cannot be read.\n'
    printf 'NODE_ENV=production\nPORT=%s\n' "$WL_PORT_DEFAULT"
    printf 'BASE_URL=https://%s\nCORS_ORIGIN=https://%s\nTRUST_PROXY=true\n' "$DOMAIN" "$DOMAIN"
    printf 'COOKIE_SECRET=%s\nMASTER_KEY=%s\n' "$(gen_hex_secret)" "$(gen_b64_key)"
    printf 'ACCESS_TTL=900\nREFRESH_TTL=2592000\nDEVICE_ACCESS_TTL=900\n'
    printf 'DB_PATH=%s/data/tracker.db\nBACKUP_DIR=%s/backups\nBACKUP_KEEP=30\nBACKUP_INTERVAL_HOURS=24\n' "$WL_VAR" "$WL_VAR"
  } > "$WL_ENV_FILE"
  umask "$old_umask"
  chown "root:${WL_USER}" "$WL_ENV_FILE" 2>/dev/null || true; chmod 0640 "$WL_ENV_FILE"
  ok "Configuration written with new random encryption keys (${WL_ENV_FILE}, mode 0640)"
  warn "Copy MASTER_KEY somewhere safe and separate from your backups (password manager). Without it the data cannot be decrypted."
}
setup_database() {
  CURRENT_STEP="database setup"; step 4 "DATABASE SETUP"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would apply the database migrations (existing databases are migrated in place, never replaced)"
  elif ! ( cd "${WL_PREFIX}/current/server" && app_node src/migrate.js ); then die "The database migrations failed. The existing database (if any) was not modified beyond the migration transaction; see the message above."; fi
  [ "$WL_DRY_RUN" = "1" ] || ok "Database initialised and migrations applied"
  if [ -n "$ADMIN_EMAIL" ]; then
    local out
    if [ "$WL_DRY_RUN" = "1" ]; then info "Would create the administrator account ${ADMIN_EMAIL}"; else
      out="$( cd "${WL_PREFIX}/current/server" && printf '%s\n' "$ADMIN_PASSWORD" | app_node scripts/create-owner.js "$ADMIN_EMAIL" --password-stdin 2>&1 )" || {
        if printf '%s' "$out" | grep -q "already exists"; then ok "An administrator account already exists; left unchanged"; else die "Could not create the administrator account: ${out}"; fi; }
      printf '%s' "$out" | grep -q "created" && ok "Administrator account created: ${ADMIN_EMAIL}"
    fi
  fi
  ADMIN_PASSWORD_USED="$ADMIN_PASSWORD"; ADMIN_PASSWORD=""
  done_ok "Encryption configured (AES-256-GCM, key in ${WL_ENV_FILE})"
  done_ok "Backups: a verified backup is taken at every start and then daily (kept in ${WL_VAR}/backups)"
  state_mark database
}

# ---------------------------------------------------------------- STEP 5: services and nginx (HTTP stage)
install_service() {
  CURRENT_STEP="configuring the service"; step 5 "APPLICATION INSTALLATION"
  done_ok "Dependencies and build (release $(source_version "$SRC_DIR"))"
  local unit="${WL_ROOT}/etc/systemd/system/watch-ledger.service"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would install ${unit} and start the service"; else
    mkdir -p "$(dirname "$unit")"
    render_template "$SRC_DIR/deploy/watch-ledger.service.tpl" "USER=${WL_USER}" "PREFIX=${WL_PREFIX_DIR:-/opt/watch-ledger}" "ETC=${WL_ETC_DIR:-/etc/watch-ledger}" "VAR=${WL_VAR_DIR:-/var/lib/watch-ledger}" "NODE=${WL_PREFIX_DIR:-/opt/watch-ledger}/node/bin/node" > "$unit"
    chmod 0644 "$unit"
  fi
  if [ -z "$WL_ROOT" ]; then run systemctl daemon-reload; run systemctl enable "$WL_SERVICE"; run systemctl restart "$WL_SERVICE"
    if health_wait 40; then ok "Service started and healthy (systemd, restarts automatically, starts at boot)"; else fail "The service did not become healthy. Look at: journalctl -u watch-ledger -n 50 --no-pager"; return 1; fi
  fi
  state_mark service
}
configure_nginx_http() {
  CURRENT_STEP="configuring nginx"
  local site="${WL_ROOT}/etc/nginx/sites-available/watch-ledger" link="${WL_ROOT}/etc/nginx/sites-enabled/watch-ledger"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would write ${site} (HTTP stage) and reload nginx"; return 0; fi
  mkdir -p "$(dirname "$site")" "$(dirname "$link")"
  if [ ! -f "${WL_ROOT}/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
    render_template "$SRC_DIR/deploy/nginx-http.conf.tpl" "DOMAIN=${DOMAIN}" "WEBROOT=/var/www/letsencrypt" > "$site"
  fi
  ln -sfn "$site" "$link"
  if [ -z "$WL_ROOT" ]; then nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx rejected the configuration."; }; systemctl enable nginx >/dev/null 2>&1 || true; systemctl reload nginx 2>/dev/null || systemctl restart nginx; fi
  done_ok "nginx reverse proxy configured"
  state_mark nginx_http
}

# ---------------------------------------------------------------- STEP 6: DNS + SSL
public_ipv4() { curl -4fsS -m 8 https://api.ipify.org 2>/dev/null || curl -4fsS -m 8 https://ifconfig.me 2>/dev/null || true; }
public_ipv6() { curl -6fsS -m 6 https://api64.ipify.org 2>/dev/null || true; }
dns_ipv4() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u; }
dns_ipv6() { getent ahostsv6 "$1" 2>/dev/null | awk '{print $1}' | grep -v '^::ffff:' | sort -u || true; }
dns_instructions() {
  say ""
  say "  ${C_BOLD}DNS is not ready yet.${C_RESET} Let's Encrypt must be able to reach this server by name. Nothing is wrong with the installation."
  say "  1. In your domain provider's DNS panel create an  A  record:   ${DOMAIN}  ->  ${1:-<the public IPv4 address of this server>}"
  say "  2. If you have an AAAA (IPv6) record for ${DOMAIN}, it must point to this server too, or be removed."
  say "  3. Wait a few minutes (up to an hour) and check:   getent hosts ${DOMAIN}"
  say "  4. Then continue where you stopped:   sudo ./scripts/install.sh --resume"
  say "  Details and troubleshooting: docs/DOMAIN_SETUP.md"
}
check_dns() {
  CURRENT_STEP="checking DNS"; step 6 "SSL SETUP"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would check that ${DOMAIN} resolves to this server before requesting a certificate"; return 0; fi
  local mine ours theirs
  mine="$(public_ipv4)"
  if [ -n "$mine" ]; then info "Public IPv4 address of this server: ${mine}"; else warn "Could not detect the public IPv4 address of this server automatically."; fi
  ours="$(dns_ipv4 "$DOMAIN" | tr '\n' ' ' | sed 's/ *$//')"
  if [ -z "${ours// /}" ]; then fail "${DOMAIN} does not resolve to any IPv4 address yet."; dns_instructions "$mine"; exit "$EXIT_DNS_PENDING"; fi
  info "${DOMAIN} resolves to: ${ours}"
  if [ -n "$mine" ] && ! printf '%s\n' "$ours" | tr ' ' '\n' | grep -qx "$mine"; then fail "${DOMAIN} points to ${ours}, not to this server (${mine})."; dns_instructions "$mine"; exit "$EXIT_DNS_PENDING"; fi
  ok "DNS check: ${DOMAIN} points to this server"
  theirs="$(dns_ipv6 "$DOMAIN" | tr '\n' ' ' | sed 's/ *$//')"
  if [ -n "${theirs// /}" ]; then
    local mine6; mine6="$(public_ipv6)"
    if [ -n "$mine6" ] && printf '%s\n' "$theirs" | tr ' ' '\n' | grep -qx "$mine6"; then ok "IPv6 (AAAA) record points to this server too"
    else fail "${DOMAIN} has an IPv6 (AAAA) record (${theirs}) that does not lead to this server. Let's Encrypt would try IPv6 first and fail."; dns_instructions "$mine"; exit "$EXIT_DNS_PENDING"; fi
  fi
  state_mark dns
}
setup_ssl() {
  CURRENT_STEP="obtaining the SSL certificate"
  local cert="${WL_ROOT}/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  if [ -f "$cert" ]; then ok "A certificate for ${DOMAIN} already exists"; else
    local extra=(); [ "$STAGING_CERT" = "1" ] && extra+=(--staging) && warn "Using Let's Encrypt STAGING: browsers will not trust this certificate."
    info "Requesting a certificate from Let's Encrypt"
    run certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" -m "$LE_EMAIL" --agree-tos --no-eff-email --non-interactive --deploy-hook "systemctl reload nginx" "${extra[@]}" \
      || { fail "Let's Encrypt could not issue the certificate. Common causes: DNS not propagated, port 80 blocked by a cloud firewall, rate limit. See docs/SSL_SETUP.md"; exit "$EXIT_DNS_PENDING"; }
  fi
  done_ok "SSL certificate installed"
  local site="${WL_ROOT}/etc/nginx/sites-available/watch-ledger"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would switch nginx to the HTTPS configuration"; else
    render_template "$SRC_DIR/deploy/nginx-https.conf.tpl" "DOMAIN=${DOMAIN}" "WEBROOT=/var/www/letsencrypt" "PORT=$(env_port)" > "$site"
    if [ -z "$WL_ROOT" ]; then nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx rejected the HTTPS configuration."; }; systemctl reload nginx; fi
  fi
  done_ok "HTTPS configured with an automatic redirect from HTTP"
  if [ -z "$WL_ROOT" ] && [ "$WL_DRY_RUN" != "1" ]; then
    if systemctl list-timers 2>/dev/null | grep -q certbot; then ok "Automatic renewal: certbot's systemd timer is active"; else warn "No certbot renewal timer found; enable it with: systemctl enable --now certbot.timer"; fi
    certbot renew --dry-run >/dev/null 2>&1 && ok "Renewal test passed" || warn "The renewal test did not pass (this can be a temporary Let's Encrypt limit). Check later: sudo certbot renew --dry-run"
  fi
  state_mark ssl
}
configure_firewall() {
  CURRENT_STEP="configuring the firewall"
  [ "$SKIP_FIREWALL" = "1" ] && { info "Firewall: skipped (--skip-firewall)"; return 0; }
  have ufw || [ "$WL_DRY_RUN" = "1" ] || { warn "ufw is not installed; skipping the firewall"; return 0; }
  local ssh_ports; ssh_ports="$( (ss -ltnp 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]}' | sort -u | tr '\n' ' ') || true )"; [ -n "${ssh_ports// /}" ] || ssh_ports="22"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would allow SSH (${ssh_ports}), 80 and 443 in ufw and enable it"; return 0; fi
  if confirm "Allow SSH (port ${ssh_ports}), HTTP (80) and HTTPS (443) and turn the firewall on? Everything else will be blocked."; then
    local p; for p in $ssh_ports; do run ufw allow "${p}/tcp" >/dev/null; done
    run ufw allow 80/tcp >/dev/null; run ufw allow 443/tcp >/dev/null; run ufw --force enable >/dev/null
    done_ok "Firewall enabled: SSH (${ssh_ports}), 80, 443"
  else warn "Firewall left unchanged. Only ports 80 and 443 need to be open to the internet."; fi
  state_mark firewall
}

# ---------------------------------------------------------------- STEP 7: extension
build_extension() {
  CURRENT_STEP="building the Chrome extension"; step 7 "EXTENSION SETUP"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would build the extension with the server address https://${DOMAIN}"; return 0; fi
  ( cd "${WL_PREFIX}/current" && service_user_run "$WL_NODE_BIN" tools/build-extension.mjs --out "${WL_VAR}/extension" --server "https://${DOMAIN}" >/dev/null ) || die "The extension build failed."
  local zip; zip="$(latest_extension_zip)"
  [ -n "$zip" ] || die "The extension ZIP was not created."
  ok "Chrome extension built and configured for https://${DOMAIN}"
  ok "Extension ZIP: ${zip}"
  info "SHA-256: $(sha256_of "$zip")"
  info "Copy it to your computer:  scp root@${DOMAIN}:${zip} ."
  state_mark extension
}

# ---------------------------------------------------------------- STEP 8: verification
final_verification() {
  CURRENT_STEP="final verification"; step 8 "FINAL VERIFICATION"
  if [ "$WL_DRY_RUN" = "1" ]; then info "Would run the health, authentication, database, dashboard, pairing API and HTTPS checks"; return 0; fi
  local port url="https://${DOMAIN}" fails=0 args=(--quiet)
  port="$(env_port)"
  curl -fsS -m 5 "http://127.0.0.1:${port}/api/health" 2>/dev/null | grep -q '"ok":true' && ok "Server health" || { fail "Server health"; fails=$((fails + 1)); }
  if [ "$SKIP_SSL" = "1" ]; then warn "HTTPS checks skipped (--skip-ssl)"; else
    if [ -n "${ADMIN_PASSWORD_USED:-}" ]; then
      if WL_ADMIN_EMAIL="$ADMIN_EMAIL" WL_ADMIN_PASSWORD="$ADMIN_PASSWORD_USED" "$WL_NODE_BIN" "${WL_PREFIX}/current/scripts/smoke-test.mjs" --url "$url" "${args[@]}"; then
        ok "Authentication, database, dashboard, device pairing API and HTTPS (smoke test passed)"; else fail "The smoke test reported a problem; run it without --quiet:  node scripts/smoke-test.mjs --url ${url}"; fails=$((fails + 1)); fi
    else
      if "$WL_NODE_BIN" "${WL_PREFIX}/current/scripts/smoke-test.mjs" --url "$url" --anonymous "${args[@]}"; then ok "Dashboard, security headers, HTTPS and API protection (anonymous checks passed)"; else fail "Anonymous smoke test failed"; fails=$((fails + 1)); fi
    fi
  fi
  ADMIN_PASSWORD_USED=""
  [ "$fails" = "0" ] || die "${fails} verification check(s) failed. Nothing was removed; see docs/TROUBLESHOOTING.md"
  state_mark verify
}

summary() {
  say ""; printf '%s' "$C_GREEN"; if [ "$WL_DRY_RUN" = "1" ]; then banner "DRY RUN COMPLETE (NO CHANGES)"; else banner "INSTALLATION COMPLETE!"; fi; printf '%s' "$C_RESET"
  say ""; say "  Dashboard:   ${C_BOLD}https://${DOMAIN}${C_RESET}"
  say "  Sign in with ${ADMIN_EMAIL:-your administrator email}."
  say "  Extension:   $(latest_extension_zip)"
  say "  Config:      ${WL_ENV_FILE}   (contains MASTER_KEY: back it up separately from the database backups)"
  say "  Next steps:  docs/EXTENSION_SETUP.md, docs/DEVICE_PAIRING.md, docs/BACKUP_RECOVERY.md"
  say "  Health:      sudo ./scripts/health-check.sh"
  say ""; say "  Powered by SciLink Project"
}

main() {
  parse_args "$@"
  if [ "$WL_DRY_RUN" != "1" ] && [ -z "$WL_ROOT" ]; then
    # keep a log of what the installer printed (it never prints a secret); readable by root only
    install -m 0600 /dev/null "$LOG_FILE" 2>/dev/null && exec > >(tee -a "$LOG_FILE") 2>&1
  fi
  banner "PRODUCTION INSTALLATION"
  [ "$WL_DRY_RUN" = "1" ] && warn "DRY RUN: nothing will be changed."
  [ "$RESUME" = "1" ] && info "Resuming: steps that already completed are skipped or re-verified."
  step_system_check
  step_questions
  CURRENT_STEP="preparing the system"; printf '
%sPREPARING THE SYSTEM%s
' "$C_BOLD" "$C_RESET"
  install_packages; install_node; create_user_and_dirs
  deploy_release; configure_environment; setup_database
  install_service; configure_nginx_http
  if [ "$SKIP_SSL" = "1" ]; then step 6 "SSL SETUP"; warn "SSL skipped. The dashboard needs HTTPS to sign in (its cookies are secure-only)."; else check_dns; setup_ssl; fi
  configure_firewall
  build_extension
  final_verification
  summary
}
# Run only when executed; sourcing this file (the test suite does) just defines the functions.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
