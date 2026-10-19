import argon2 from "argon2";
import { randomToken, sha256, uuid } from "../lib/crypto.js";
import { cookieOpts, signAccess } from "../lib/tokens.js";
import { audit } from "../lib/helpers.js";

let dummyHash = null; // real argon2 hash so unknown emails cost the same as wrong passwords
const getDummy = async () => (dummyHash ||= await argon2.hash("not-a-real-password"));

function issueSession(db, reply, adminId) {
  const refresh = randomToken();
  db.prepare("INSERT INTO refresh_tokens(id,admin_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)")
    .run(uuid(), adminId, sha256(refresh), Date.now() + Number(process.env.REFRESH_TTL) * 1000, Date.now());
  reply.setCookie("rt", refresh, { ...cookieOpts(process.env.REFRESH_TTL), path: "/api/auth" });
  reply.setCookie("at", signAccess(adminId), cookieOpts(process.env.ACCESS_TTL));
}
function clearSession(reply) {
  reply.clearCookie("rt", { path: "/api/auth" });
  reply.clearCookie("at", { path: "/" });
}
function readRefresh(req) {
  const raw = req.cookies && req.cookies.rt;
  const un = raw ? req.unsignCookie(raw) : null;
  return un && un.valid ? un.value : null;
}

export default async function (app, { db }) {
  // There is deliberately NO registration route: the single owner account is created from the server's shell
  // with scripts/create-owner.js, and the database refuses a second one (see migrations/003).

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { email, password } = req.body || {};
    const row = db.prepare("SELECT * FROM admins WHERE email=?").get(String(email || "").trim().toLowerCase());
    // always run a verify so response time doesn't reveal whether the email exists
    const ok = await argon2.verify(row ? row.pw_hash : await getDummy(), String(password || "")).catch(() => false);
    if (!row || !ok) return reply.code(401).send({ error: "invalid_credentials" });
    issueSession(db, reply, row.id);
    audit(db, row.id, null, "login", req.ip);
    return { ok: true, admin: { id: row.id, email: row.email } };
  });

  // Rotates the refresh token. Presenting an already-revoked token means it leaked
  // (or was replayed), so every session for that admin is revoked.
  app.post("/api/auth/refresh", { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const tok = readRefresh(req);
    const row = tok && db.prepare("SELECT * FROM refresh_tokens WHERE token_hash=?").get(sha256(tok));
    if (!row) { clearSession(reply); return reply.code(401).send({ error: "unauthorized" }); }
    if (row.revoked) {
      db.prepare("UPDATE refresh_tokens SET revoked=1 WHERE admin_id=?").run(row.admin_id);
      audit(db, row.admin_id, null, "refresh_reuse_detected", req.ip);
      clearSession(reply);
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (row.expires_at < Date.now()) { clearSession(reply); return reply.code(401).send({ error: "unauthorized" }); }
    db.prepare("UPDATE refresh_tokens SET revoked=1 WHERE id=?").run(row.id);
    issueSession(db, reply, row.admin_id);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const tok = readRefresh(req);
    if (tok) {
      const row = db.prepare("SELECT admin_id FROM refresh_tokens WHERE token_hash=?").get(sha256(tok));
      db.prepare("UPDATE refresh_tokens SET revoked=1 WHERE token_hash=?").run(sha256(tok));
      if (row) audit(db, row.admin_id, null, "logout", req.ip);
    }
    clearSession(reply);
    return { ok: true };
  });
}
