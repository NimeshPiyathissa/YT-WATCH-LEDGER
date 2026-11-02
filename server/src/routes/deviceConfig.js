import { uuid } from "../lib/crypto.js";
import { audit, ownDevice } from "../lib/helpers.js";
import { validateChanges, applyChanges, cleanStored, stateOf, SPEC } from "../lib/config.js";
import { purgeDevice } from "../lib/retention.js";

// Per-device managed configuration.
//   Owner routes (cookie session, ownership checked on every row): read, change, history.
//   Device routes (access token, approved devices only): fetch the current config, report applied/failed.
// Authorization is enforced here on the server; the dashboard's buttons are convenience, not the control.
export default async function (app, { db }) {
  const rowOf = id => db.prepare("SELECT * FROM device_config WHERE device_id=?").get(id);
  const view = (d, row) => {
    const state = stateOf(row);
    return { deviceId: d.id, config: row ? cleanStored(JSON.parse(row.config)) : {}, version: row ? row.version : 0, state,
      updatedAt: row ? row.updated_at : null, appliedVersion: row ? row.applied_version : 0, appliedAt: row ? row.applied_at : null,
      error: state === "failed" ? row.failed_error : null, deviceActive: d.status === "active", online: app.hub.isOnline(d.id), spec: SPEC };
  };
  const adminOnly = { preHandler: app.authAdmin };

  /* ---- owner ---- */
  app.get("/api/devices/:id/config", adminOnly, (req, reply) => ownDevice(db, req, reply, d => view(d, rowOf(d.id))));

  app.get("/api/devices/:id/config/history", adminOnly, (req, reply) => ownDevice(db, req, reply, d =>
    db.prepare("SELECT id,version,changes,actor_label,created_at,status,status_at,error FROM device_config_history WHERE device_id=? ORDER BY version DESC LIMIT 50").all(d.id)
      .map(h => ({ ...h, changes: JSON.parse(h.changes) }))));

  app.put("/api/devices/:id/config", { ...adminOnly, config: { rateLimit: { max: 60, timeWindow: "1 hour" } } }, (req, reply) => ownDevice(db, req, reply, d => {
    if (d.status !== "active") return reply.code(409).send({ error: "device_not_active" });
    const v = validateChanges(req.body && req.body.changes);
    if (!v.ok) return reply.code(400).send({ error: v.error, ...(v.setting ? { setting: v.setting } : {}) });
    const admin = db.prepare("SELECT email FROM admins WHERE id=?").get(req.admin.id);
    const now = Date.now();
    const out = db.transaction(() => {
      const cur = rowOf(d.id), { next, diff } = applyChanges(cur ? cleanStored(JSON.parse(cur.config)) : {}, v.clean);
      if (!Object.keys(diff).length) return { changed: false, version: cur ? cur.version : 0 };
      const version = (cur ? cur.version : 0) + 1;
      if (cur) db.prepare("UPDATE device_config SET config=?,version=?,updated_at=?,updated_by=? WHERE device_id=?").run(JSON.stringify(next), version, now, req.admin.id, d.id);
      else db.prepare("INSERT INTO device_config(device_id,config,version,updated_at,updated_by) VALUES (?,?,?,?,?)").run(d.id, JSON.stringify(next), version, now, req.admin.id);
      db.prepare("INSERT INTO device_config_history(id,device_id,version,changes,actor_id,actor_label,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(uuid(), d.id, version, JSON.stringify(diff), req.admin.id, admin ? admin.email : null, now);
      return { changed: true, version, diff };
    })();
    if (!out.changed) return { ok: true, changed: false, ...view(d, rowOf(d.id)) };
    audit(db, req.admin.id, d.id, "config_changed", req.ip, { version: out.version, changes: out.diff });
    app.hub.toDevice(d.id, "config", { version: out.version });           // a connected device fetches it now; otherwise at its next sync
    app.hub.toAdmin(req.admin.id, "config_updated", { deviceId: d.id, version: out.version });
    return { ok: true, changed: true, ...view(d, rowOf(d.id)) };
  }));

  /* ---- device ---- */
  app.get("/api/sync/config", { preHandler: app.authDevice }, req => {
    const row = rowOf(req.device.id);
    return { version: row ? row.version : 0, config: row ? cleanStored(JSON.parse(row.config)) : {} };
  });

  // The device reports what it did with a version. Only the current version counts: an answer for an older one is
  // reported as stale and changes nothing (the device then fetches the current version).
  app.post("/api/sync/config/ack", { preHandler: app.authDevice, config: { rateLimit: { max: 120, timeWindow: "1 hour" } } }, (req, reply) => {
    const b = req.body || {}, d = req.device, row = rowOf(d.id);
    if (!Number.isInteger(b.version) || (b.status !== "applied" && b.status !== "failed")) return reply.code(400).send({ error: "bad_request" });
    if (!row || b.version !== row.version) return { ok: true, stale: true, currentVersion: row ? row.version : 0 };
    const now = Date.now(), error = b.status === "failed" ? String(b.error || "could not apply").slice(0, 300) : null;
    db.transaction(() => {
      if (b.status === "applied") {
        db.prepare("UPDATE device_config SET applied_version=?,applied_at=?,failed_version=NULL,failed_error=NULL,failed_at=NULL WHERE device_id=?").run(row.version, now, d.id);
        db.prepare("UPDATE device_config_history SET status='applied',status_at=? WHERE device_id=? AND version=?").run(now, d.id, row.version);
        db.prepare("UPDATE device_config_history SET status='superseded',status_at=? WHERE device_id=? AND version<? AND status='pending'").run(now, d.id, row.version);
        const cfg = cleanStored(JSON.parse(row.config));
        // The server's copy follows the device's retention, exactly as it does for the older set_retention command.
        if (Object.hasOwn(cfg, "retention_days")) { db.prepare("UPDATE devices SET retention_days=? WHERE id=?").run(cfg.retention_days, d.id); purgeDevice(db, d.id); }
      } else {
        db.prepare("UPDATE device_config SET failed_version=?,failed_error=?,failed_at=? WHERE device_id=?").run(row.version, error, now, d.id);
        db.prepare("UPDATE device_config_history SET status='failed',status_at=?,error=? WHERE device_id=? AND version=?").run(now, error, d.id, row.version);
      }
    })();
    audit(db, d.admin_id, d.id, b.status === "applied" ? "config_applied" : "config_failed", req.ip, { version: row.version, ...(error ? { error } : {}) });
    app.hub.toAdmin(d.admin_id, "config_status", { deviceId: d.id, version: row.version, status: b.status });
    return { ok: true, version: row.version };
  });
}
