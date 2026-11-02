import { audit } from "../lib/helpers.js";
import { revokeSessions, requestPublic } from "../lib/sessions.js";

// Owner-only: device sessions, the device's requests to delete its session, and pairing-code history.
// Every route is behind the owner's cookie session (authAdmin, which also rejects cross-site writes), and every row is
// checked against req.admin.id before it is read or changed.
export default async function (app, { db }) {
  app.addHook("preHandler", app.authAdmin);

  const ownSession = (req, reply) => {
    const s = db.prepare("SELECT s.*, d.admin_id, d.label FROM device_sessions s JOIN devices d ON d.id=s.device_id WHERE s.id=?").get(req.params.id);
    if (!s) { reply.code(404).send({ error: "not_found" }); return null; }
    if (s.admin_id !== req.admin.id) { reply.code(403).send({ error: "forbidden" }); return null; }
    return s;
  };
  const ownRequest = (req, reply) => {
    const r = db.prepare("SELECT r.*, d.label FROM session_deletion_requests r JOIN devices d ON d.id=r.device_id WHERE r.id=?").get(req.params.id);
    if (!r) { reply.code(404).send({ error: "not_found" }); return null; }
    if (r.admin_id !== req.admin.id) { reply.code(403).send({ error: "forbidden" }); return null; }
    return r;
  };

  /* ---- sessions ---- */
  app.get("/api/sessions", req => {
    const status = req.query?.status === "all" ? null : "active";
    const device = typeof req.query?.device === "string" && req.query.device !== "all" ? req.query.device.slice(0, 64) : null;
    return db.prepare(`SELECT s.id,s.device_id,s.status,s.created_at,s.last_seen,s.ip,s.client_version,s.revoked_at,s.revoked_reason,d.label
        FROM device_sessions s JOIN devices d ON d.id=s.device_id
        WHERE d.admin_id=? AND (? IS NULL OR s.status=?) AND (? IS NULL OR s.device_id=?) ORDER BY s.created_at DESC LIMIT 200`)
      .all(req.admin.id, status, status, device, device)
      .map(s => ({ ...s, live: app.hub.liveSessions(s.device_id).has(s.id) }));
  });

  app.post("/api/sessions/:id/revoke", (req, reply) => {
    const s = ownSession(req, reply); if (!s) return;
    if (s.status !== "active") return reply.code(409).send({ error: "session_not_active" });
    revokeSessions(db, { deviceId: s.device_id, sessionId: s.id, reason: "admin_revoked" });
    audit(db, req.admin.id, s.device_id, "session_revoked", req.ip, { session: s.id });
    app.hub.toDevice(s.device_id, "session_revoked", { reason: "revoked" }, { sessionId: s.id });
    app.hub.disconnect(s.device_id, { sessionId: s.id, reason: "revoked" });
    app.hub.toAdmin(req.admin.id, "session_revoked", { sessionId: s.id, deviceId: s.device_id, label: s.label });
    return { ok: true };
  });

  /* ---- session deletion requests ---- */
  app.get("/api/session-requests", req => {
    const status = ["pending", "approved", "denied", "cancelled"].includes(req.query?.status) ? req.query.status : null;
    return db.prepare(`SELECT r.*, d.label, s.status AS session_status FROM session_deletion_requests r
        JOIN devices d ON d.id=r.device_id LEFT JOIN device_sessions s ON s.id=r.session_id
        WHERE r.admin_id=? AND (? IS NULL OR r.status=?) ORDER BY (r.status='pending') DESC, r.requested_at DESC LIMIT 200`)
      .all(req.admin.id, status, status)
      .map(r => ({ ...requestPublic(r), label: r.label, sessionStatus: r.session_status, requestIp: r.request_ip }));
  });

  // Approve: the request must still be pending (checked and flipped atomically, so a double click or two open
  // dashboards can't approve twice), then the session is revoked and the device is told and disconnected.
  app.post("/api/session-requests/:id/approve", (req, reply) => {
    const r = ownRequest(req, reply); if (!r) return;
    const now = Date.now();
    const ok = db.transaction(() => {
      if (db.prepare("UPDATE session_deletion_requests SET status='approved',decided_at=?,decided_by=? WHERE id=? AND status='pending'").run(now, req.admin.id, r.id).changes !== 1) return false;
      db.prepare("UPDATE device_sessions SET status='revoked',revoked_at=?,revoked_reason='deletion_approved' WHERE id=? AND status='active'").run(now, r.session_id);
      return true;
    })();
    if (!ok) return reply.code(409).send({ error: "already_decided" });
    audit(db, req.admin.id, r.device_id, "session_deletion_approved", req.ip, { session: r.session_id, request: r.id });
    const request = requestPublic(db.prepare("SELECT * FROM session_deletion_requests WHERE id=?").get(r.id));
    app.hub.toDevice(r.device_id, "session_request", { request }, { sessionId: r.session_id });
    app.hub.toDevice(r.device_id, "session_revoked", { reason: "session_deleted" }, { sessionId: r.session_id });
    app.hub.disconnect(r.device_id, { sessionId: r.session_id, reason: "session_deleted" });
    app.hub.toAdmin(req.admin.id, "session_request_approved", { requestId: r.id, deviceId: r.device_id, sessionId: r.session_id, label: r.label });
    app.hub.toAdmin(req.admin.id, "session_revoked", { sessionId: r.session_id, deviceId: r.device_id, label: r.label });
    return { ok: true, request };
  });

  // Deny: the session stays active; the device is told so it stops showing "waiting".
  app.post("/api/session-requests/:id/deny", (req, reply) => {
    const r = ownRequest(req, reply); if (!r) return;
    const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim().slice(0, 300) : null;
    const changed = db.prepare("UPDATE session_deletion_requests SET status='denied',decided_at=?,decided_by=?,decision_note=? WHERE id=? AND status='pending'")
      .run(Date.now(), req.admin.id, note, r.id).changes;
    if (changed !== 1) return reply.code(409).send({ error: "already_decided" });
    audit(db, req.admin.id, r.device_id, "session_deletion_denied", req.ip, { session: r.session_id, request: r.id });
    const request = requestPublic(db.prepare("SELECT * FROM session_deletion_requests WHERE id=?").get(r.id));
    app.hub.toDevice(r.device_id, "session_request", { request }, { sessionId: r.session_id });
    app.hub.toAdmin(req.admin.id, "session_request_denied", { requestId: r.id, deviceId: r.device_id, sessionId: r.session_id, label: r.label });
    return { ok: true, request };
  });

  /* ---- pairing history ---- */
  app.get("/api/pairing-codes", req => {
    const now = Date.now();
    return db.prepare(`SELECT c.id,c.label,c.created_at,c.expires_at,c.used_at,c.revoked_at,c.require_approval,c.device_id,c.session_id,c.used_ip,d.label AS device_label
        FROM enroll_codes c LEFT JOIN devices d ON d.id=c.device_id WHERE c.admin_id=? ORDER BY c.created_at DESC LIMIT 100`).all(req.admin.id)
      .map(c => ({ ...c, require_approval: !!c.require_approval,
        status: c.used_at ? "used" : c.revoked_at ? "cancelled" : c.expires_at < now ? "expired" : "active" }));
  });

  app.post("/api/pairing-codes/:id/revoke", (req, reply) => {
    const c = db.prepare("SELECT * FROM enroll_codes WHERE id=?").get(req.params.id);
    if (!c) return reply.code(404).send({ error: "not_found" });
    if (c.admin_id !== req.admin.id) return reply.code(403).send({ error: "forbidden" });
    if (db.prepare("UPDATE enroll_codes SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL").run(Date.now(), c.id).changes !== 1)
      return reply.code(409).send({ error: "code_not_active" });
    audit(db, req.admin.id, null, "pairing_code_cancelled", req.ip, { code: c.id });
    app.hub.toAdmin(req.admin.id, "pairing_code_cancelled", { codeId: c.id });
    return { ok: true };
  });
}
