import { sha256 } from "../lib/crypto.js";
import { signDeviceAccess, deviceAccessTtl } from "../lib/tokens.js";
import { confirmCodeFor } from "../lib/helpers.js";

// Exchange a device's refresh credential for a short-lived access token, and let a not-yet-approved device
// poll its own status. The refresh credential is only ever sent to /api/device/token.
export default async function (app, { db }) {
  app.post("/api/device/token", { config: { rateLimit: { max: 120, timeWindow: "1 hour" } } }, async (req, reply) => {
    const h = req.headers.authorization || "";
    const cred = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!cred) return reply.code(401).send({ error: "no_token" });
    const dev = db.prepare("SELECT * FROM devices WHERE token_hash=?").get(sha256(cred));
    if (!dev) return reply.code(401).send({ error: "bad_credential" });
    if (dev.status === "revoked") return reply.code(403).send({ error: "revoked" });
    db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(Date.now(), dev.id);
    return { accessToken: signDeviceAccess(dev.id), expiresIn: deviceAccessTtl(), status: dev.status, confirmCode: confirmCodeFor(dev), serverNow: Date.now() };
  });

  // Reachable while pending (and when active). Revoked devices get 403 from the middleware.
  app.get("/api/device/status", { preHandler: app.authDeviceAny }, async req =>
    ({ status: req.device.status, confirmCode: confirmCodeFor(req.device), label: req.device.label, serverNow: Date.now() }));
}
