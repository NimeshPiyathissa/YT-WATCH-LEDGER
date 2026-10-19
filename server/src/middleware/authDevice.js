import { verifyDeviceAccess } from "../lib/tokens.js";

// Device requests carry a short-lived access token (obtained from POST /api/device/token by presenting the
// device's long-lived refresh credential). The device's status is re-read from the database on EVERY request,
// so revoking a device takes effect immediately, not when its token expires.
//   401 token_invalid  -> access token missing/expired/forged: the client should refresh and retry
//   401 bad_token      -> the device no longer exists (removed by the owner)
//   403 revoked        -> the owner revoked the device
//   403 pending_approval -> paired but not yet approved by the owner
export function authDevice(db, { allowPending = false } = {}) {
  return async (req, reply) => {
    const h = req.headers.authorization || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!tok) return reply.code(401).send({ error: "no_token" });
    const deviceId = verifyDeviceAccess(tok);
    if (!deviceId) return reply.code(401).send({ error: "token_invalid" });
    const dev = db.prepare("SELECT * FROM devices WHERE id=?").get(deviceId);
    if (!dev) return reply.code(401).send({ error: "bad_token" });
    if (dev.status === "revoked") return reply.code(403).send({ error: "revoked" });
    if (dev.status === "pending" && !allowPending) return reply.code(403).send({ error: "pending_approval" });
    db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(Date.now(), dev.id);
    req.device = dev;
  };
}
