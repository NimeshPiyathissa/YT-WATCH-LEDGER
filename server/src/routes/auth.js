import argon2 from "argon2";
import { randomToken, sha256, uuid } from "../lib/crypto.js";
import { cookieOpts, signAccess } from "../lib/tokens.js";
import { audit } from "../lib/helpers.js";
import { MIN_PASSWORD, MAX_PASSWORD, purgeExpiredTokens } from "../lib/security.js";

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
    if (!row || !ok) {
      // Recorded against the owner (there is only one) so the failed attempt shows in their audit log; the password is never stored.
      const owner = db.prepare("SELECT id FROM admins LIMIT 1").get();
      if (owner) audit(db, owner.id, null, "login_failed", req.ip, { known: !!row });
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    purgeExpiredTokens(db);
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
    // revoked=2: the owner signed this browser out on purpose (sign out others / everywhere, password change). Its next refresh is
    // refused quietly. Treating it as theft would sign the owner's CURRENT browser out too, just for ending the other one.
    if (row.revoked === 2) { clearSession(reply); return reply.code(401).send({ error: "unauthorized" }); }
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
  // ---- the owner's own sign-ins. These live under /api/auth/ because only that path receives the refresh cookie, which is how
  // "this browser" is told apart from the others.
  const currentTokenHash = req => { const tok = readRefresh(req); return tok ? sha256(tok) : null; };
  const revokeOthers = (adminId, keepHash) => db.prepare("UPDATE refresh_tokens SET revoked=2 WHERE admin_id=? AND revoked=0 AND token_hash<>?").run(adminId, keepHash || "").changes;

  app.get("/api/auth/sessions", { preHandler: app.authAdmin }, req => {
    const mine = currentTokenHash(req);
    return db.prepare("SELECT id, token_hash, created_at, expires_at FROM refresh_tokens WHERE admin_id=? AND revoked=0 AND expires_at>? ORDER BY created_at DESC")
      .all(req.admin.id, Date.now()).map(r => ({ id: r.id, renewedAt: r.created_at, expiresAt: r.expires_at, current: r.token_hash === mine }));
  });

  app.post("/api/auth/sign-out-others", { preHandler: app.authAdmin }, req => {
    const signedOut = revokeOthers(req.admin.id, currentTokenHash(req));
    audit(db, req.admin.id, null, "sign_out_others", req.ip, { sessions: signedOut });
    return { ok: true, signedOut };
  });

  app.post("/api/auth/sign-out-all", { preHandler: app.authAdmin }, (req, reply) => {
    const signedOut = db.prepare("UPDATE refresh_tokens SET revoked=2 WHERE admin_id=? AND revoked=0").run(req.admin.id).changes;
    audit(db, req.admin.id, null, "sign_out_all", req.ip, { sessions: signedOut });
    clearSession(reply);
    return { ok: true, signedOut };
  });

  // Needs the current password even with a valid session, so a stolen cookie alone cannot lock the owner out. Every other
  // sign-in ends (a leaked cookie is the usual reason to change a password). Access cookies already issued expire on their own
  // within ACCESS_TTL (15 minutes by default).
  app.post("/api/auth/password", { preHandler: app.authAdmin, config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { current, next } = req.body || {};
    const row = db.prepare("SELECT * FROM admins WHERE id=?").get(req.admin.id);
    const ok = await argon2.verify(row.pw_hash, String(current || "")).catch(() => false);
    if (!ok) { audit(db, req.admin.id, null, "password_change_failed", req.ip); return reply.code(403).send({ error: "wrong_password" }); }
    const pw = typeof next === "string" ? next : "";
    if (pw.length < MIN_PASSWORD || pw.length > MAX_PASSWORD) return reply.code(400).send({ error: "weak_password", min: MIN_PASSWORD, max: MAX_PASSWORD });
    if (pw === current) return reply.code(400).send({ error: "same_password" });
    const hash = await argon2.hash(pw);
    const signedOut = db.transaction(() => {
      db.prepare("UPDATE admins SET pw_hash=? WHERE id=?").run(hash, row.id);
      return revokeOthers(row.id, currentTokenHash(req));
    })();
    audit(db, row.id, null, "password_changed", req.ip, { otherSessionsSignedOut: signedOut });
    return { ok: true, signedOut };
  });
}
