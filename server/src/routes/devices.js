import { randomCode, sha256, uuid } from "../lib/crypto.js";
import { audit, counts, ownDevice, cleanCommand, confirmCodeFor, normalizePairingCode } from "../lib/helpers.js";
import { revokeSessions, connectionOf } from "../lib/sessions.js";

export const PAIRING_TTL_MS = () => (Number(process.env.PAIRING_CODE_TTL_MIN) || 15) * 60 * 1000;

export default async function (app, { db }) {
  app.addHook("preHandler", app.authAdmin);

  // Pairing code: one-time, short-lived. By default redeeming it connects the device at once; with requireApproval
  // the device waits as pending until the owner approves it here.
  app.post("/api/devices/enroll-code", async (req) => {
    const code = randomCode(), id = uuid(), now = Date.now();
    const expiresAt = now + PAIRING_TTL_MS();
    const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim().slice(0, 80) : null;
    const requireApproval = req.body?.requireApproval === true;
    db.prepare("INSERT INTO enroll_codes(id,code_hash,admin_id,label,expires_at,created_at,require_approval) VALUES (?,?,?,?,?,?,?)")
      .run(id, sha256(normalizePairingCode(code)), req.admin.id, label, expiresAt, now, requireApproval ? 1 : 0);
    audit(db, req.admin.id, null, "pairing_code_created", req.ip, { code: id, label, requireApproval });
    return { id, code, expiresAt, label, requireApproval }; // the code itself is shown once and stored only as a hash
  });

  app.get("/api/devices", req => {
    const now = Date.now();
    const sess = db.prepare("SELECT COUNT(*) n, MAX(last_seen) seen FROM device_sessions WHERE device_id=? AND status='active'");
    const pendingReq = db.prepare("SELECT COUNT(*) n FROM session_deletion_requests WHERE device_id=? AND status='pending'");
    const pairings = db.prepare("SELECT COUNT(*) n FROM enroll_codes WHERE device_id=?");
    return db.prepare(`SELECT id,label,platform,status,enrolled_at,approved_at,last_seen,last_push_at,pending_count,last_error,clock_skew_ms,
                       client_version,retention_days,install_id FROM devices WHERE admin_id=? ORDER BY enrolled_at`).all(req.admin.id)
      .map(({ install_id, ...d }) => {
        const s = sess.get(d.id), live = app.hub.isOnline(d.id);
        const conn = connectionOf(d, { live, activeSessions: s.n, now });
        return { ...d, counts: counts(db, d.id), confirm_code: d.status === "pending" ? confirmCodeFor({ id: d.id, install_id }) : null,
          connection: conn.state, online: conn.online, realtime: live, active_sessions: s.n,
          pending_requests: pendingReq.get(d.id).n, pairings: pairings.get(d.id).n, last_active: Math.max(d.last_seen || 0, s.seen || 0) || null };
      });
  });

  app.post("/api/devices/:id/approve", (req, reply) => ownDevice(db, req, reply, d => {
    if (d.status !== "pending") return reply.code(409).send({ error: "not_pending" });
    db.prepare("UPDATE devices SET status='active', approved_at=? WHERE id=?").run(Date.now(), d.id);
    audit(db, req.admin.id, d.id, "approve", req.ip);
    app.hub.toDevice(d.id, "device_status", { status: "active" });
    app.hub.toAdmin(req.admin.id, "device_connected", { deviceId: d.id, label: d.label });
    return { ok: true };
  }));

  app.patch("/api/devices/:id", (req, reply) => ownDevice(db, req, reply, d => {
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    if (!label || label.length > 80) return reply.code(400).send({ error: "bad_label" });
    db.prepare("UPDATE devices SET label=? WHERE id=?").run(label, d.id);
    audit(db, req.admin.id, d.id, "rename", req.ip, { from: d.label, to: label });
    app.hub.toAdmin(req.admin.id, "device_updated", { deviceId: d.id });
    return { ok: true };
  }));

  // Revoking the device ends every session it has; it is told at once if it is connected.
  app.post("/api/devices/:id/revoke", (req, reply) => ownDevice(db, req, reply, d => {
    db.prepare("UPDATE devices SET status='revoked' WHERE id=?").run(d.id);
    const ids = revokeSessions(db, { deviceId: d.id, reason: "device_revoked" });
    audit(db, req.admin.id, d.id, "revoke", req.ip, { sessions: ids.length });
    app.hub.toDevice(d.id, "session_revoked", { reason: "revoked" });
    app.hub.disconnect(d.id, { reason: "revoked" });
    app.hub.toAdmin(req.admin.id, "device_disconnected", { deviceId: d.id, label: d.label, reason: "revoked" });
    return { ok: true, sessionsRevoked: ids.length };
  }));

  app.delete("/api/devices/:id", (req, reply) => ownDevice(db, req, reply, d => {
    app.hub.toDevice(d.id, "session_revoked", { reason: "removed" });
    app.hub.disconnect(d.id, { reason: "removed" });
    db.prepare("DELETE FROM devices WHERE id=?").run(d.id); // cascades sessions, requests, videos, watch sessions, commands
    audit(db, req.admin.id, d.id, "delete_device", req.ip, { label: d.label });
    app.hub.toAdmin(req.admin.id, "device_disconnected", { deviceId: d.id, label: d.label, reason: "removed" });
    return { ok: true };
  }));

  app.post("/api/devices/:id/commands", (req, reply) => ownDevice(db, req, reply, d => {
    if (d.status !== "active") return reply.code(409).send({ error: "device_not_active" });
    const payload = cleanCommand(req.body?.type, req.body?.payload);
    if (payload === null) return reply.code(400).send({ error: "bad_command" });
    db.prepare("INSERT INTO commands(id,device_id,type,payload,created_at) VALUES (?,?,?,?,?)")
      .run(uuid(), d.id, req.body.type, JSON.stringify(payload), Date.now());
    audit(db, req.admin.id, d.id, "enqueue:" + req.body.type, req.ip, payload);
    app.hub.toDevice(d.id, "commands", {}); // a connected device fetches it now instead of at its next 5-minute sync
    return { ok: true, delivered: app.hub.isOnline(d.id) ? "now" : "next_sync" };
  }));
}
