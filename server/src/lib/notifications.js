// Notification Center: turns conditions that need the owner's attention into in-dashboard notifications. Nothing is sent anywhere.
//
// Conditions are computed from what the server already knows (devices, backups, disk, the audit log). evaluateNotifications() makes the
// notifications table match them: a new condition inserts one row; the same condition evaluated again does nothing; a condition that
// has ended is marked resolved. A dismissed notification stays dismissed for as long as its condition lasts.
import { uuid } from "./crypto.js";
import { collectHealth } from "./health.js";
import { audit } from "./helpers.js";

const H = 3600000, DAY = 86400000;

// Every kind can be switched off; some have a threshold. The owner edits these on the Notifications page (and later in Settings).
export const KINDS = {
  device_pending: { label: "A device is waiting for approval" },
  device_offline: { label: "A device has not been seen for a while", threshold: { field: "hours", min: 1, max: 720, def: 24 } },
  queue_overflow: { label: "A device could not queue all of its events" },
  sync_error: { label: "A device reports a sync error" },
  backup: { label: "No backup, or the newest one is old" },
  system: { label: "Disk or database problems on the server" },
  security: { label: "Failed sign-ins, wrong pairing codes, a copied sign-in token", threshold: { field: "failedLogins", min: 1, max: 100, def: 5 } },
  deletion_request: { label: "A device asked for its session to be deleted" }
};
export const DEFAULT_PREFS = {
  enabled: true,
  kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { on: true, ...(v.threshold ? { [v.threshold.field]: v.threshold.def } : {}) }])),
  retentionDays: 90
};
const clone = o => JSON.parse(JSON.stringify(o));

export function getPrefs(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='notification_prefs'").get();
    if (!row) return clone(DEFAULT_PREFS);
    const v = validatePrefs(JSON.parse(row.value), clone(DEFAULT_PREFS));
    return v.ok ? v.prefs : clone(DEFAULT_PREFS);
  } catch { return clone(DEFAULT_PREFS); }
}

// Merges a (partial) update into `base` and checks every field; returns { ok, prefs } or { ok:false, error }.
export function validatePrefs(input, base) {
  const bad = error => ({ ok: false, error });
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad("bad_prefs");
  const out = clone(base);
  for (const k of Object.keys(input)) {
    if (k === "enabled") { if (typeof input.enabled !== "boolean") return bad("bad_enabled"); out.enabled = input.enabled; }
    else if (k === "retentionDays") { const d = input.retentionDays; if (!Number.isInteger(d) || d < 7 || d > 365) return bad("bad_retention"); out.retentionDays = d; }
    else if (k === "kinds") {
      if (!input.kinds || typeof input.kinds !== "object" || Array.isArray(input.kinds)) return bad("bad_kinds");
      for (const kind of Object.keys(input.kinds)) {
        const def = KINDS[kind], v = input.kinds[kind];
        if (!def) return bad("unknown_kind");
        if (!v || typeof v !== "object" || Array.isArray(v)) return bad("bad_kind");
        for (const f of Object.keys(v)) {
          if (f === "on") { if (typeof v.on !== "boolean") return bad("bad_on"); out.kinds[kind].on = v.on; }
          else if (def.threshold && f === def.threshold.field) {
            const n = v[f]; if (!Number.isInteger(n) || n < def.threshold.min || n > def.threshold.max) return bad("bad_" + f); out.kinds[kind][f] = n;
          } else return bad("unknown_field");
        }
      }
    } else return bad("unknown_field");
  }
  return { ok: true, prefs: out };
}
export function savePrefs(db, prefs) {
  db.prepare("INSERT INTO settings(key,value) VALUES ('notification_prefs',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(prefs));
}

const cut = (s, n) => String(s == null ? "" : s).slice(0, n);

// The conditions that hold right now, for kinds the owner has switched on.
function conditions(db, adminId, prefs, { config, hub, now }) {
  const out = [], on = k => prefs.kinds[k] && prefs.kinds[k].on;
  const add = (kind, key, severity, title, body, deviceId = null) => { if (on(kind)) out.push({ kind, key, severity, title, body: cut(body, 280), deviceId }); };

  const devs = db.prepare("SELECT * FROM devices WHERE admin_id=?").all(adminId);
  const sess = db.prepare("SELECT device_id, MAX(last_seen) seen, COUNT(*) n FROM device_sessions WHERE status='active' GROUP BY device_id").all();
  const seenBy = new Map(sess.map(s => [s.device_id, s]));
  for (const d of devs) {
    const name = cut(d.label || "A device", 80);
    if (d.status === "pending") add("device_pending", `dev:${d.id}:pending`, "warn", "A device is waiting for your approval", `${name} paired and cannot sync until you approve it. Check its confirmation code before approving.`, d.id);
    if (d.status !== "active") continue;
    const s = seenBy.get(d.id), last = Math.max(d.last_seen || 0, d.last_push_at || 0, s ? s.seen || 0 : 0);
    const hours = on("device_offline") ? prefs.kinds.device_offline.hours : null;
    if (hours && s && s.n > 0 && last > 0 && now - last > hours * H) add("device_offline", `dev:${d.id}:offline`, "info", "A device has not been seen for a while", `${name} was last seen about ${Math.round((now - last) / H)} hours ago.`, d.id);
    if (d.queue_dropped > 0) add("queue_overflow", `dev:${d.id}:queue`, "warn", "A device could not queue all of its events", `${name}: ${d.queue_dropped} playback event(s) were not queued while it was offline. They are still on that device.`, d.id);
    if (d.last_error) add("sync_error", `dev:${d.id}:sync`, "warn", "A device reports a sync error", `${name}: ${d.last_error}`, d.id);
  }

  // server health (disk, database, backups): the Health Center's own thresholds, so the two pages never disagree
  const h = collectHealth({ db, config, hub, now });
  for (const w of h.warnings) {
    if (w.code === "backup_none") add("backup", "backup:none", "warn", "No backup exists yet", w.message);
    else if (w.code === "backup_stale") add("backup", "backup:stale", "warn", "The newest backup is old", w.message);
    else if (w.code === "disk_full") add("system", "sys:disk_full", "critical", "The disk is almost full", w.message);
    else if (w.code === "disk_low") add("system", "sys:disk_low", "warn", "The disk is getting full", w.message);
    else if (w.code === "database") add("system", "sys:database", "critical", "The database is not answering", w.message);
  }

  if (on("security")) {
    const since = now - DAY, n = (a, from) => db.prepare("SELECT COUNT(*) n FROM audit_log WHERE admin_id=? AND action=? AND created_at>=?").get(adminId, a, from).n;
    const limit = prefs.kinds.security.failedLogins, fl = n("login_failed", since), fp = n("pairing_failed", since);
    if (fl >= limit) add("security", "sec:failed_logins", "warn", "Failed sign-ins", `${fl} failed sign-in attempts in the last 24 hours.`);
    if (fp >= limit) add("security", "sec:failed_pairings", "warn", "Wrong pairing codes", `${fp} wrong pairing codes were tried in the last 24 hours.`);
    if (n("refresh_reuse_detected", now - 7 * DAY)) add("security", "sec:refresh_reuse", "critical", "A sign-in token was used twice", "That is what happens when a token is copied. Every session was signed out. Change your password if you did not cause it.");
  }
  const pend = db.prepare("SELECT COUNT(*) n FROM session_deletion_requests WHERE admin_id=? AND status='pending'").get(adminId).n;
  if (pend) add("deletion_request", "deletion:pending", "warn", "A device asked for its session to be deleted", `${pend} request${pend === 1 ? " is" : "s are"} waiting for you under Devices.`);
  return out;
}

// Makes the table match the conditions. Returns what changed.
export function evaluateNotifications(db, { config = {}, hub = null, now = Date.now() } = {}) {
  const owner = db.prepare("SELECT id FROM admins LIMIT 1").get();
  if (!owner) return { created: 0, resolved: 0 };
  const prefs = getPrefs(db);
  const want = prefs.enabled ? conditions(db, owner.id, prefs, { config, hub, now }) : [];
  const keys = new Set(want.map(c => c.key));
  let created = 0, resolved = 0;
  db.transaction(() => {
    const open = new Map(db.prepare("SELECT id, dedupe_key FROM notifications WHERE admin_id=? AND resolved_at IS NULL").all(owner.id).map(r => [r.dedupe_key, r.id]));
    const ins = db.prepare("INSERT INTO notifications(id,admin_id,kind,severity,dedupe_key,device_id,title,body,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    for (const c of want) if (!open.has(c.key)) { ins.run(uuid(), owner.id, c.kind, c.severity, c.key, c.deviceId, c.title, c.body, now); created++; }
    const res = db.prepare("UPDATE notifications SET resolved_at=? WHERE id=?");
    for (const [key, id] of open) if (!keys.has(key)) { res.run(now, id); resolved++; }
  })();
  if (created && hub) hub.toAdmin(owner.id, "notifications", { created });
  return { created, resolved };
}

// Resolved or dismissed notifications older than the owner's retention are removed; one that is still active never is.
export function pruneNotifications(db, { days = 90, now = Date.now(), maxRows = 2000 } = {}) {
  let removed = db.prepare("DELETE FROM notifications WHERE resolved_at IS NOT NULL AND resolved_at < ?").run(now - days * DAY).changes;
  const total = db.prepare("SELECT COUNT(*) n FROM notifications WHERE resolved_at IS NOT NULL").get().n;
  if (total > maxRows) removed += db.prepare("DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE resolved_at IS NOT NULL ORDER BY resolved_at ASC LIMIT ?)").run(total - maxRows).changes;
  return { removed };
}

export const shape = r => ({ id: r.id, kind: r.kind, severity: r.severity, key: r.dedupe_key, deviceId: r.device_id, title: r.title, body: r.body || "",
  createdAt: r.created_at, read: !!r.read_at, readAt: r.read_at, dismissedAt: r.dismissed_at, resolvedAt: r.resolved_at });
export { audit };
