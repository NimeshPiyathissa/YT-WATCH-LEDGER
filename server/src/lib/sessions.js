// Device sessions: one per pairing. Shared by the owner's routes, the device routes and the real-time hub.
import { sha256, randomToken, uuid } from "./crypto.js";
import { audit } from "./helpers.js";

// A device without a live socket still counts as online if it talked to the server this recently. Extensions from 0.5
// keep a socket open, so for them a short grace covers a reconnect; older ones only poll, every 5 minutes.
export const ONLINE_WINDOW_MS = 6 * 60 * 1000, REALTIME_GRACE_MS = 45 * 1000;
export const realtimeCapable = v => { const m = /^(\d+)\.(\d+)/.exec(String(v || "")); return !!m && (Number(m[1]) > 0 || Number(m[2]) >= 5); };

export function createSession(db, deviceId, { ip = null, clientVersion = null, now = Date.now() } = {}) {
  const refresh = randomToken(), id = uuid();
  db.prepare("INSERT INTO device_sessions(id,device_id,token_hash,status,created_at,last_seen,ip,client_version) VALUES (?,?,?,'active',?,?,?,?)")
    .run(id, deviceId, sha256(refresh), now, now, ip, clientVersion);
  return { id, refresh };
}

// Revokes one session, or every active session of a device. Open deletion requests for those sessions are closed as
// "cancelled" (there is nothing left to delete). Returns the ids that were revoked.
export function revokeSessions(db, { deviceId, sessionId = null, reason, now = Date.now() }) {
  const ids = db.prepare("SELECT id FROM device_sessions WHERE device_id=? AND status='active' AND (? IS NULL OR id=?)").all(deviceId, sessionId, sessionId).map(r => r.id);
  const rev = db.prepare("UPDATE device_sessions SET status='revoked',revoked_at=?,revoked_reason=? WHERE id=? AND status='active'");
  const cancel = db.prepare("UPDATE session_deletion_requests SET status='cancelled',decided_at=?,decision_note=? WHERE session_id=? AND status='pending'");
  db.transaction(() => { for (const id of ids) { rev.run(now, reason, id); cancel.run(now, "session " + reason.replace(/_/g, " "), id); } })();
  return ids;
}

// What the device is told when its session no longer works. "session_deleted" lets the extension say that the owner
// approved its own deletion request, rather than that it was cut off.
export const revokedError = s => (s && s.revoked_reason === "deletion_approved" ? "session_deleted" : "revoked");

export function sessionPublic(s) {
  return s && { id: s.id, deviceId: s.device_id, status: s.status, createdAt: s.created_at, lastSeen: s.last_seen,
    clientVersion: s.client_version, revokedAt: s.revoked_at, revokedReason: s.revoked_reason };
}
export function requestPublic(r) {
  return r && { id: r.id, deviceId: r.device_id, sessionId: r.session_id, status: r.status, reason: r.reason,
    requestedAt: r.requested_at, decidedAt: r.decided_at, decisionNote: r.decision_note };
}

// Connection state shown in the dashboard: derived from the device's status, its sessions and its presence.
export function connectionOf(d, { live, activeSessions, now = Date.now() }) {
  const window = realtimeCapable(d.client_version) ? REALTIME_GRACE_MS : ONLINE_WINDOW_MS;
  const online = live || (!!d.last_seen && now - d.last_seen < window);
  if (d.status === "revoked") return { state: "revoked", online: false };
  if (d.status === "pending") return { state: "pending", online };
  if (!activeSessions) return { state: "disconnected", online: false };
  return { state: online ? "online" : "offline", online };
}

// The person at a device asks for its session to be deleted. Nothing is deleted here: the session stays active until
// the owner approves. Asking again while a request is open returns that request ({created:false}), never a second one.
export function fileDeletionRequest(db, hub, { device, session, reason, ip }) {
  const open = () => db.prepare("SELECT * FROM session_deletion_requests WHERE session_id=? AND status='pending'").get(session.id);
  const existing = open();
  if (existing) return { request: existing, created: false };
  const id = uuid(), now = Date.now();
  try {
    db.prepare("INSERT INTO session_deletion_requests(id,admin_id,device_id,session_id,status,reason,requested_at,request_ip) VALUES (?,?,?,?,'pending',?,?,?)")
      .run(id, device.admin_id, device.id, session.id, typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 300) : null, now, ip || null);
  } catch (e) {
    // Two requests raced: the partial unique index let only one in; return that one.
    if (String(e.code).startsWith("SQLITE_CONSTRAINT")) return { request: open(), created: false };
    throw e;
  }
  const request = db.prepare("SELECT * FROM session_deletion_requests WHERE id=?").get(id);
  audit(db, device.admin_id, device.id, "session_deletion_requested", ip, { session: session.id, request: id });
  hub.toAdmin(device.admin_id, "session_deletion_requested", { requestId: id, deviceId: device.id, sessionId: session.id, label: device.label });
  hub.toDevice(device.id, "session_request", { request: requestPublic(request) }, { sessionId: session.id });
  return { request, created: true };
}
