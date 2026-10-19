import { randomCode, sha256, uuid } from "../lib/crypto.js";
import { audit, counts, ownDevice, cleanCommand, confirmCodeFor } from "../lib/helpers.js";

export default async function (app, { db }) {
  app.addHook("preHandler", app.authAdmin);

  // Pairing code: one-time, 15 minutes. It only lets a device *ask* to join; the owner still has to approve it.
  app.post("/api/devices/enroll-code", async (req) => {
    const code = randomCode();
    const expiresAt = Date.now() + 15 * 60 * 1000;
    const label = typeof req.body?.label === "string" ? req.body.label.slice(0, 80) : null;
    db.prepare("INSERT INTO enroll_codes(code_hash,admin_id,label,expires_at) VALUES (?,?,?,?)").run(sha256(code), req.admin.id, label, expiresAt);
    audit(db, req.admin.id, null, "pairing_code_created", req.ip);
    return { code, expiresAt }; // shown once
  });

  app.get("/api/devices", req =>
    db.prepare(`SELECT id,label,platform,status,enrolled_at,approved_at,last_seen,last_push_at,pending_count,last_error,clock_skew_ms,
                       client_version,retention_days,install_id FROM devices WHERE admin_id=? ORDER BY enrolled_at`).all(req.admin.id)
      .map(({ install_id, ...d }) => ({ ...d, counts: counts(db, d.id), confirm_code: d.status === "pending" ? confirmCodeFor({ id: d.id, install_id }) : null })));

  app.post("/api/devices/:id/approve", (req, reply) => ownDevice(db, req, reply, d => {
    if (d.status !== "pending") return reply.code(409).send({ error: "not_pending" });
    db.prepare("UPDATE devices SET status='active', approved_at=? WHERE id=?").run(Date.now(), d.id);
    audit(db, req.admin.id, d.id, "approve", req.ip);
    return { ok: true };
  }));

  app.patch("/api/devices/:id", (req, reply) => ownDevice(db, req, reply, d => {
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    if (!label || label.length > 80) return reply.code(400).send({ error: "bad_label" });
    db.prepare("UPDATE devices SET label=? WHERE id=?").run(label, d.id);
    audit(db, req.admin.id, d.id, "rename", req.ip, { from: d.label, to: label });
    return { ok: true };
  }));

  app.post("/api/devices/:id/revoke", (req, reply) => ownDevice(db, req, reply, d => {
    db.prepare("UPDATE devices SET status='revoked' WHERE id=?").run(d.id);
    audit(db, req.admin.id, d.id, "revoke", req.ip);
    return { ok: true };
  }));

  app.delete("/api/devices/:id", (req, reply) => ownDevice(db, req, reply, d => {
    db.prepare("DELETE FROM devices WHERE id=?").run(d.id); // cascades videos/sessions/commands
    audit(db, req.admin.id, d.id, "delete_device", req.ip);
    return { ok: true };
  }));

  app.post("/api/devices/:id/commands", (req, reply) => ownDevice(db, req, reply, d => {
    if (d.status !== "active") return reply.code(409).send({ error: "device_not_active" });
    const payload = cleanCommand(req.body?.type, req.body?.payload);
    if (payload === null) return reply.code(400).send({ error: "bad_command" });
    db.prepare("INSERT INTO commands(id,device_id,type,payload,created_at) VALUES (?,?,?,?,?)")
      .run(uuid(), d.id, req.body.type, JSON.stringify(payload), Date.now());
    audit(db, req.admin.id, d.id, "enqueue:" + req.body.type, req.ip, payload);
    return { ok: true };
  }));
}
