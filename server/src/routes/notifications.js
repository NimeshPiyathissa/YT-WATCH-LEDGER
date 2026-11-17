import { evaluateNotifications, getPrefs, savePrefs, validatePrefs, pruneNotifications, shape, KINDS } from "../lib/notifications.js";
import { audit } from "../lib/helpers.js";

const EVAL_EVERY_MS = 30000;

// Owner-only. Evaluation happens when the page asks (at most every 30 s), so there is no timer to keep alive and the numbers are fresh.
export default async function (app, { db, config }) {
  app.addHook("preHandler", app.authAdmin);
  let lastEval = 0;
  const evalDue = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEval < EVAL_EVERY_MS) return;
    lastEval = now;
    evaluateNotifications(db, { config, hub: app.hub, now });
    pruneNotifications(db, { days: getPrefs(db).retentionDays, now });
  };
  const own = (req, reply) => {
    const r = db.prepare("SELECT * FROM notifications WHERE id=? AND admin_id=?").get(req.params.id, req.admin.id);
    if (!r) { reply.code(404).send({ error: "not_found" }); return null; }
    return r;
  };
  const unread = adminId => db.prepare("SELECT severity, COUNT(*) n FROM notifications WHERE admin_id=? AND resolved_at IS NULL AND dismissed_at IS NULL AND read_at IS NULL GROUP BY severity").all(adminId);

  app.get("/api/notifications/summary", req => {
    evalDue();
    const by = Object.fromEntries(unread(req.admin.id).map(r => [r.severity, r.n]));
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    return { unread: total, bySeverity: { critical: by.critical || 0, warn: by.warn || 0, info: by.info || 0 }, evaluatedAt: lastEval };
  });

  // ?status=active (default: not resolved, not dismissed) | all | resolved ; ?kind= ; ?limit= (default 100, at most 200) ; ?before=<ms>
  app.get("/api/notifications", req => {
    evalDue();
    const q = req.query || {}, limit = Math.min(Math.max(Math.floor(Number(q.limit)) || 100, 1), 200);
    const where = ["admin_id=?"], args = [req.admin.id];
    if (q.status === "all") { /* everything */ } else if (q.status === "resolved") where.push("resolved_at IS NOT NULL");
    else where.push("resolved_at IS NULL", "dismissed_at IS NULL");
    if (typeof q.kind === "string" && KINDS[q.kind]) { where.push("kind=?"); args.push(q.kind); }
    if (q.before !== undefined && q.before !== "" && Number.isFinite(Number(q.before))) { where.push("created_at<?"); args.push(Number(q.before)); }
    const items = db.prepare(`SELECT * FROM notifications WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, limit).map(shape);
    return { items, kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.label])) };
  });

  app.post("/api/notifications/evaluate", req => { evalDue(true); return { ok: true }; });
  app.post("/api/notifications/read-all", req => ({ ok: true, changed: db.prepare("UPDATE notifications SET read_at=? WHERE admin_id=? AND read_at IS NULL AND resolved_at IS NULL").run(Date.now(), req.admin.id).changes }));
  app.post("/api/notifications/:id/read", (req, reply) => { const r = own(req, reply); if (!r) return; db.prepare("UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?").run(Date.now(), r.id); return { ok: true }; });
  app.post("/api/notifications/:id/dismiss", (req, reply) => { const r = own(req, reply); if (!r) return; db.prepare("UPDATE notifications SET dismissed_at=COALESCE(dismissed_at,?), read_at=COALESCE(read_at,?) WHERE id=?").run(Date.now(), Date.now(), r.id); return { ok: true }; });

  app.get("/api/notifications/preferences", () => getPrefs(db));
  app.put("/api/notifications/preferences", (req, reply) => {
    const v = validatePrefs(req.body, getPrefs(db));
    if (!v.ok) return reply.code(400).send({ error: v.error });
    savePrefs(db, v.prefs);
    audit(db, req.admin.id, null, "notification_prefs_changed", req.ip, { enabled: v.prefs.enabled });
    evalDue(true); // the new thresholds apply at once
    return { ok: true, prefs: v.prefs };
  });
}
