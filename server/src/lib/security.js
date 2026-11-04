// Security Center: housekeeping for the tables an anonymous visitor can make grow, and the owner's security overview.
const DAY = 86400000;
export const MIN_PASSWORD = 12, MAX_PASSWORD = 256;

// Owner sign-in tokens that have expired can never be used again, so they are not worth keeping. A token that is revoked but not yet
// expired IS kept: presenting it again is how a stolen copy is detected.
export function purgeExpiredTokens(db, now = Date.now()) {
  return db.prepare("DELETE FROM refresh_tokens WHERE expires_at < ?").run(now).changes;
}

// Anyone on the internet can add audit rows (a wrong pairing code writes one), so the log is bounded by age and by size.
// The newest rows always survive.
export function pruneAudit(db, { days = 365, maxRows = 100000, now = Date.now() } = {}) {
  let removed = db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(now - days * DAY).changes;
  const total = db.prepare("SELECT COUNT(*) n FROM audit_log").get().n;
  if (total > maxRows) {
    removed += db.prepare("DELETE FROM audit_log WHERE rowid IN (SELECT rowid FROM audit_log ORDER BY created_at ASC, rowid ASC LIMIT ?)").run(total - maxRows).changes;
  }
  return { removed };
}

// What the owner should look at, in plain terms. Counts only; never a hash, token or password.
export function securityOverview(db, adminId, { now = Date.now(), trustProxy = false, baseUrl = "" } = {}) {
  const owner = db.prepare("SELECT email, created_at FROM admins WHERE id=?").get(adminId);
  const since = now - DAY, week = now - 7 * DAY;
  const n = (action, from) => db.prepare("SELECT COUNT(*) n FROM audit_log WHERE admin_id=? AND action=? AND created_at>=?").get(adminId, action, from).n;
  const dev = status => db.prepare("SELECT COUNT(*) n FROM devices WHERE admin_id=? AND status=?").get(adminId, status).n;
  const devices = {
    total: db.prepare("SELECT COUNT(*) n FROM devices WHERE admin_id=?").get(adminId).n, active: dev("active"), pending: dev("pending"), revoked: dev("revoked"),
    liveViewOn: db.prepare("SELECT COUNT(*) n FROM devices WHERE admin_id=? AND status='active' AND live_view=1").get(adminId).n,
    stale: db.prepare("SELECT COUNT(*) n FROM devices WHERE admin_id=? AND status='active' AND COALESCE(last_seen, enrolled_at) < ?").get(adminId, now - 30 * DAY).n,
    activeSessions: db.prepare("SELECT COUNT(*) n FROM device_sessions s JOIN devices d ON d.id=s.device_id WHERE d.admin_id=? AND s.status='active'").get(adminId).n
  };
  const last24h = { logins: n("login", since), failedLogins: n("login_failed", since), failedPairings: n("pairing_failed", since) };
  const reuse7d = n("refresh_reuse_detected", week);
  const pairing = { outstanding: db.prepare("SELECT COUNT(*) n FROM enroll_codes WHERE admin_id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?").get(adminId, now).n };
  const signedIn = db.prepare("SELECT COUNT(*) n FROM refresh_tokens WHERE admin_id=? AND revoked=0 AND expires_at>?").get(adminId, now).n;

  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });
  if (devices.pending) add("warn", "pending_devices", `${devices.pending} device${devices.pending === 1 ? " is" : "s are"} waiting for your approval. Approve only a device you recognise, by its confirmation code.`);
  if (reuse7d) add("warn", "refresh_reuse", "A sign-in token was used twice in the last 7 days, which is what happens when one is copied. Every session was signed out; change your password if you did not cause this.");
  if (last24h.failedLogins >= 5) add("warn", "failed_logins", `${last24h.failedLogins} failed sign-ins in the last 24 hours.`);
  if (last24h.failedPairings >= 5) add("warn", "failed_pairings", `${last24h.failedPairings} wrong pairing codes in the last 24 hours.`);
  if (pairing.outstanding) add("info", "open_pairing_codes", `${pairing.outstanding} pairing code${pairing.outstanding === 1 ? " is" : "s are"} still valid. Cancel any you are not about to use.`);
  if (devices.stale) add("info", "stale_devices", `${devices.stale} connected device${devices.stale === 1 ? " has" : "s have"} not been seen for 30 days. Revoke what you no longer use.`);
  if (/^https:/i.test(baseUrl) && !trustProxy && !process.env.TLS_CERT) add("warn", "trust_proxy_off", "TRUST_PROXY is not set, so behind a reverse proxy every visitor looks like one address: one person's wrong guesses can lock everybody out. See docs/TROUBLESHOOTING.md.");
  return { owner: { email: owner ? owner.email : null, createdAt: owner ? owner.created_at : null }, signedIn, devices, last24h, reuse7d, pairing, trustProxy, findings };
}
