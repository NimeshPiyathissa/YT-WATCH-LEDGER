import { verifyAccess } from "../lib/tokens.js";

// Verifies the signed access cookie and attaches req.admin = { id }.
// Cookie auth is also guarded against cross-site writes: a state-changing request
// carrying an Origin header must come from this server's own origin.
export function authAdmin(db) {
  return async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin) {
      const allowed = process.env.BASE_URL ? new URL(process.env.BASE_URL).origin : null;
      if (req.headers.origin !== allowed) return reply.code(403).send({ error: "bad_origin" });
    }
    const raw = req.cookies && req.cookies.at;
    const un = raw ? req.unsignCookie(raw) : null;
    const adminId = un && un.valid ? verifyAccess(un.value) : null;
    if (!adminId) return reply.code(401).send({ error: "unauthorized" });
    if (!db.prepare("SELECT 1 FROM admins WHERE id=?").get(adminId)) return reply.code(401).send({ error: "unauthorized" });
    req.admin = { id: adminId };
  };
}
