import { sha256 } from "../lib/crypto.js";
import { signDeviceAccess, deviceAccessTtl, verifyDeviceSession } from "../lib/tokens.js";
import { confirmCodeFor } from "../lib/helpers.js";
import { revokedError, sessionPublic, requestPublic, fileDeletionRequest } from "../lib/sessions.js";
import { checkDeviceSession } from "../middleware/authDevice.js";

const WS_AUTH_TIMEOUT_MS = 5000, WS_PING_MS = 30000;
const version = req => (typeof req.headers["x-client-version"] === "string" ? req.headers["x-client-version"].slice(0, 32) : null);

// Device-facing routes that are not about uploading: exchanging the session credential for an access token, the
// session's own status, asking for the session to be deleted, and the real-time socket.
export default async function (app, { db }) {
  const latestRequest = sessionId => db.prepare("SELECT * FROM session_deletion_requests WHERE session_id=? ORDER BY requested_at DESC LIMIT 1").get(sessionId);

  // The refresh credential is only ever sent here.
  app.post("/api/device/token", { config: { rateLimit: { max: 120, timeWindow: "1 hour" } } }, async (req, reply) => {
    const h = req.headers.authorization || "";
    const cred = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!cred) return reply.code(401).send({ error: "no_token" });
    const s = db.prepare("SELECT * FROM device_sessions WHERE token_hash=?").get(sha256(cred));
    const dev = s && db.prepare("SELECT * FROM devices WHERE id=?").get(s.device_id);
    if (!s || !dev) return reply.code(401).send({ error: "bad_credential" });
    if (dev.status === "revoked") return reply.code(403).send({ error: "revoked" });
    if (s.status !== "active") return reply.code(403).send({ error: revokedError(s) });
    const now = Date.now(), v = version(req);
    db.prepare("UPDATE devices SET last_seen=?, client_version=COALESCE(?,client_version) WHERE id=?").run(now, v, dev.id);
    db.prepare("UPDATE device_sessions SET last_seen=?, ip=?, client_version=COALESCE(?,client_version) WHERE id=?").run(now, req.ip, v, s.id);
    return { accessToken: signDeviceAccess(dev.id, s.id), expiresIn: deviceAccessTtl(), status: dev.status, sessionId: s.id,
      confirmCode: dev.status === "pending" ? confirmCodeFor(dev) : null, serverNow: now };
  });

  // Reachable while pending (and when active). Revoked devices/sessions get 403 from the middleware.
  app.get("/api/device/status", { preHandler: app.authDeviceAny }, async req =>
    ({ status: req.device.status, confirmCode: req.device.status === "pending" ? confirmCodeFor(req.device) : null, label: req.device.label, sessionId: req.deviceSession.id, serverNow: Date.now() }));

  app.get("/api/device/session", { preHandler: app.authDeviceAny }, async req =>
    ({ device: { id: req.device.id, label: req.device.label, status: req.device.status }, session: sessionPublic(req.deviceSession),
       deletionRequest: requestPublic(latestRequest(req.deviceSession.id)), serverNow: Date.now() }));

  // The person at the device asks for this session to be deleted; the owner decides (see fileDeletionRequest).
  app.post("/api/device/session/deletion-request", { preHandler: app.authDeviceAny, config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req, reply) => {
    const r = fileDeletionRequest(db, app.hub, { device: req.device, session: req.deviceSession, reason: req.body && req.body.reason, ip: req.ip });
    return reply.code(r.created ? 201 : 200).send({ request: requestPublic(r.request), duplicate: !r.created });
  });

  // Real-time channel for the extension. Browsers can't put headers on a WebSocket, so the first message must be
  // {type:"auth", token:<access token>}; anything else, or nothing within 5 s, closes the socket. Revocation is checked
  // at the handshake and pushed while connected; the socket carries hints only, never watch data.
  app.get("/api/device/ws", { websocket: true }, (socket, req) => {
    let unsub = null, ctx = null, alive = true;
    const send = (type, data) => { if (socket.readyState === 1) socket.send(JSON.stringify({ type, ...data })); };
    const authTimer = setTimeout(() => socket.close(4401, "auth_timeout"), WS_AUTH_TIMEOUT_MS);
    const ping = setInterval(() => { if (!alive) return socket.terminate(); alive = false; try { socket.ping(); } catch { /* closing */ } }, WS_PING_MS);
    socket.on("pong", () => { alive = true; });

    socket.on("message", raw => {
      alive = true;
      let msg; try { msg = JSON.parse(String(raw).slice(0, 4096)); } catch { return socket.close(4400, "bad_message"); }
      if (!ctx) {
        if (!msg || msg.type !== "auth") return socket.close(4401, "auth_required");
        const t = verifyDeviceSession(msg.token);
        if (!t) return socket.close(4401, "token_invalid");
        const res = checkDeviceSession(db, t);
        if (res.error) { send("session_revoked", { reason: res.error }); return socket.close(4403, res.error); }
        clearTimeout(authTimer);
        ctx = { device: res.device, session: res.session };
        const first = !app.hub.isOnline(ctx.device.id);
        unsub = app.hub.subscribeDevice(ctx.device.id, { sessionId: ctx.session.id, send, close: (code, reason) => socket.close(code, reason) });
        const now = Date.now();
        db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(now, ctx.device.id);
        db.prepare("UPDATE device_sessions SET last_seen=?, ip=? WHERE id=?").run(now, req.ip, ctx.session.id);
        send("ready", { deviceId: ctx.device.id, sessionId: ctx.session.id, status: ctx.device.status,
          deletionRequest: requestPublic(latestRequest(ctx.session.id)), serverNow: now });
        if (first) app.hub.toAdmin(ctx.device.admin_id, "device_presence", { deviceId: ctx.device.id, online: true });
        return;
      }
      if (msg.type === "ping") {
        db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(Date.now(), ctx.device.id);
        db.prepare("UPDATE device_sessions SET last_seen=? WHERE id=?").run(Date.now(), ctx.session.id);
        return send("pong", { serverNow: Date.now() });
      }
    });
    socket.on("close", () => {
      clearTimeout(authTimer); clearInterval(ping);
      if (unsub) {
        unsub();
        if (!app.hub.isOnline(ctx.device.id)) app.hub.toAdmin(ctx.device.admin_id, "device_presence", { deviceId: ctx.device.id, online: false });
      }
    });
  });
}
