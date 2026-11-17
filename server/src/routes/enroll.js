import { sha256, uuid } from "../lib/crypto.js";
import { audit, confirmCodeFor, normalizePairingCode } from "../lib/helpers.js";
import { createSession } from "../lib/sessions.js";

const FAIL_WINDOW_MS = 15 * 60 * 1000;

// Public, but only usable with a one-time pairing code the owner created (single use, short expiry, stored hashed).
// Redeeming it creates a device session. By default the device is connected at once (the owner-issued code is the
// authorisation); a code generated with "require approval" leaves the device PENDING until the owner approves it.
export default async function (app, { db }) {
  const maxFails = () => Number(process.env.PAIRING_MAX_FAILS) || 5; // read per request: the owner can change it without a restart
  const fails = new Map(); // ip -> { n, first, lockedUntil }: wrong codes lock that address out for a while

  function failed(ip) {
    const now = Date.now(), f = fails.get(ip);
    const cur = f && now - f.first < FAIL_WINDOW_MS ? f : { n: 0, first: now, lockedUntil: 0 };
    cur.n++;
    if (cur.n >= maxFails()) cur.lockedUntil = now + FAIL_WINDOW_MS;
    fails.set(ip, cur);
    if (fails.size > 10000) for (const [k, v] of fails) if (now - v.first > FAIL_WINDOW_MS && v.lockedUntil < now) fails.delete(k);
  }
  const ownerId = () => (db.prepare("SELECT id FROM admins LIMIT 1").get() || {}).id || null;

  app.post("/api/enroll", { config: { rateLimit: { max: Number(process.env.ENROLL_RATE_MAX) || 20, timeWindow: "1 hour" } } }, async (req, reply) => {
    const lock = fails.get(req.ip);
    if (lock && lock.lockedUntil > Date.now()) return reply.code(429).send({ error: "too_many_attempts", retryAfter: Math.ceil((lock.lockedUntil - Date.now()) / 1000) });
    const { code, installId, label, platform, clientVersion } = req.body || {};
    const norm = normalizePairingCode(code);
    const row = norm && db.prepare("SELECT * FROM enroll_codes WHERE code_hash=?").get(sha256(norm));
    const reject = why => {
      failed(req.ip);
      audit(db, row ? row.admin_id : ownerId(), null, "pairing_failed", req.ip, { reason: why });
      return reply.code(400).send({ error: "bad_code" });
    };
    if (!row) return reject("unknown_code");
    if (row.used_at) return reject("already_used");
    if (row.revoked_at) return reject("cancelled");
    if (row.expires_at < Date.now()) return reject("expired");

    const now = Date.now(), inst = String(installId || "").slice(0, 64) || null;
    const version = typeof clientVersion === "string" ? clientVersion.slice(0, 32) : null;
    const status = row.require_approval ? "pending" : "active";
    const name = String(row.label || label || "Device").slice(0, 200);
    let result = null;
    db.transaction(() => {
      // Atomic claim: only one concurrent request can flip used_at, so a code works exactly once.
      if (db.prepare("UPDATE enroll_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND revoked_at IS NULL").run(now, row.code_hash).changes !== 1) return;
      // The same browser pairing again (e.g. after its session was deleted) gets its device back, with its history, as long
      // as that device has no live session; otherwise this is treated as a new device.
      let dev = inst && db.prepare(`SELECT * FROM devices d WHERE admin_id=? AND install_id=?
          AND NOT EXISTS (SELECT 1 FROM device_sessions s WHERE s.device_id=d.id AND s.status='active') ORDER BY enrolled_at DESC LIMIT 1`).get(row.admin_id, inst);
      const reused = !!dev;
      if (dev) {
        db.prepare("UPDATE devices SET status=?, approved_at=CASE WHEN ?='active' THEN ? ELSE approved_at END, label=COALESCE(?,label), platform=COALESCE(?,platform), client_version=COALESCE(?,client_version) WHERE id=?")
          .run(status, status, now, row.label || null, String(platform || "").slice(0, 64) || null, version, dev.id);
      } else {
        const id = uuid();
        db.prepare("INSERT INTO devices(id,admin_id,label,install_id,platform,status,enrolled_at,approved_at,client_version) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(id, row.admin_id, name, inst, String(platform || "").slice(0, 64) || null, status, now, status === "active" ? now : null, version);
        dev = { id };
      }
      const s = createSession(db, dev.id, { ip: req.ip, clientVersion: version, now });
      db.prepare("UPDATE enroll_codes SET device_id=?, session_id=?, used_ip=? WHERE code_hash=?").run(dev.id, s.id, req.ip, row.code_hash);
      result = { deviceId: dev.id, sessionId: s.id, refresh: s.refresh, reused };
    })();
    if (!result) return reject("already_used");
    fails.delete(req.ip);
    const device = db.prepare("SELECT * FROM devices WHERE id=?").get(result.deviceId);
    audit(db, row.admin_id, device.id, status === "pending" ? "pair_requested" : "pair_completed", req.ip, { session: result.sessionId, reused: result.reused });
    const ev = { codeId: row.id, deviceId: device.id, sessionId: result.sessionId, label: device.label, status };
    app.hub.toAdmin(row.admin_id, "pairing_completed", ev);
    if (status === "active") app.hub.toAdmin(row.admin_id, "device_connected", ev);
    // refreshToken is the session's long-lived credential: shown once, stored hashed, and only ever sent to /api/device/token
    return { deviceId: device.id, sessionId: result.sessionId, refreshToken: result.refresh, status,
      confirmCode: status === "pending" ? confirmCodeFor(device) : null, label: device.label };
  });
}
