import { sha256, randomToken, uuid } from "../lib/crypto.js";
import { audit, confirmCodeFor } from "../lib/helpers.js";

// Public, but only usable with a one-time pairing code the owner created. Redeeming it creates a PENDING
// device: it cannot upload or read anything until the owner explicitly approves it in the dashboard.
export default async function (app, { db }) {
  app.post("/api/enroll", { config: { rateLimit: { max: Number(process.env.ENROLL_RATE_MAX) || 20, timeWindow: "1 hour" } } }, async (req, reply) => {
    const { code, installId, label, platform } = req.body || {};
    const row = db.prepare("SELECT * FROM enroll_codes WHERE code_hash=?").get(sha256(String(code || "").trim().toUpperCase()));
    if (!row || row.used_at || row.expires_at < Date.now()) return reply.code(400).send({ error: "bad_code" });
    const refresh = randomToken();
    const deviceId = uuid();
    const claimed = db.transaction(() => {
      // atomic claim: only one concurrent request can flip used_at
      if (db.prepare("UPDATE enroll_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL").run(Date.now(), row.code_hash).changes !== 1) return false;
      db.prepare("INSERT INTO devices(id,admin_id,label,install_id,platform,token_hash,status,enrolled_at) VALUES(?,?,?,?,?,?,'pending',?)")
        .run(deviceId, row.admin_id, String(label || row.label || "Device").slice(0, 200), String(installId || "").slice(0, 64) || null,
          String(platform || "").slice(0, 64) || null, sha256(refresh), Date.now());
      return true;
    })();
    if (!claimed) return reply.code(400).send({ error: "bad_code" });
    audit(db, row.admin_id, deviceId, "pair_requested", req.ip);
    const device = db.prepare("SELECT * FROM devices WHERE id=?").get(deviceId);
    // refreshToken is the device's long-lived credential: shown once, stored hashed, and only ever sent to /api/device/token
    return { deviceId, refreshToken: refresh, status: "pending", confirmCode: confirmCodeFor(device), label: row.label || null };
  });
}
