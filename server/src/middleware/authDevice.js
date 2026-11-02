import { verifyDeviceSession } from "../lib/tokens.js";
import { revokedError } from "../lib/sessions.js";

// Device requests carry a short-lived access token (obtained from POST /api/device/token by presenting the
// session's long-lived refresh credential). The device's AND the session's status are re-read from the database on
// EVERY request, so revoking either takes effect immediately, not when the token expires.
//   401 token_invalid    -> access token missing/expired/forged: the client should refresh and retry
//   401 bad_token        -> the device or session no longer exists (removed by the owner)
//   403 revoked          -> the owner revoked the device or this session
//   403 session_deleted  -> the owner approved this session's deletion request
//   403 pending_approval -> paired but not yet approved by the owner
export function authDevice(db, { allowPending = false } = {}) {
  return async (req, reply) => {
    const h = req.headers.authorization || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!tok) return reply.code(401).send({ error: "no_token" });
    const t = verifyDeviceSession(tok);
    if (!t) return reply.code(401).send({ error: "token_invalid" });
    const res = checkDeviceSession(db, t);
    if (res.error) return reply.code(res.code).send({ error: res.error });
    if (res.device.status === "pending" && !allowPending) return reply.code(403).send({ error: "pending_approval" });
    const now = Date.now();
    db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(now, res.device.id);
    db.prepare("UPDATE device_sessions SET last_seen=? WHERE id=?").run(now, res.session.id);
    req.device = res.device;
    req.deviceSession = res.session;
  };
}

// Shared with the WebSocket handshake: { device, session } or { code, error }.
export function checkDeviceSession(db, { deviceId, sessionId }) {
  const device = db.prepare("SELECT * FROM devices WHERE id=?").get(deviceId);
  const session = db.prepare("SELECT * FROM device_sessions WHERE id=? AND device_id=?").get(sessionId, deviceId);
  if (!device || !session) return { code: 401, error: "bad_token" };
  if (device.status === "revoked") return { code: 403, error: "revoked" };
  if (session.status !== "active") return { code: 403, error: revokedError(session) };
  return { device, session };
}
