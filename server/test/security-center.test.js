// Security Center regressions (BUG_FIX_REPORT A13-A16) and the owner-only security APIs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login, enrollDevice, cookieNamed, cookieHeader, OWNER, PW } from "./helpers.js";
import { uuid, sha256 } from "../src/lib/crypto.js";

const post = (app, url, headers, payload) => app.inject({ method: "POST", url, headers, payload });
const audits = (db, action) => db.prepare("SELECT * FROM audit_log WHERE action=?").all(action);
const rt = res => "rt=" + encodeURIComponent(cookieNamed(res, "rt").value);

test("A13: a failed sign-in is written to the audit log (it used to leave no trace, so guessing was invisible)", async () => {
  const { app, db } = await makeApp(); await addOwner(db);
  await post(app, "/api/auth/login", {}, { email: OWNER, password: "wrong wrong wrong" });
  await post(app, "/api/auth/login", {}, { email: "nobody@example.com", password: "whatever whatever" });
  const rows = audits(db, "login_failed");
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => !/wrong wrong|whatever/.test(r.detail || "")), "the password is never recorded");
  assert.deepEqual(rows.map(r => JSON.parse(r.detail).known).sort(), [false, true]);
  assert.ok(rows.every(r => r.admin_id === db.prepare("SELECT id FROM admins").get().id), "attributed to the owner so the owner sees it");
});

test("A14: expired owner sign-in tokens are removed instead of accumulating for ever", async () => {
  const { app, db } = await makeApp(); const id = await addOwner(db);
  for (let i = 0; i < 5; i++) db.prepare("INSERT INTO refresh_tokens(id,admin_id,token_hash,expires_at,revoked,created_at) VALUES (?,?,?,?,?,?)").run(uuid(), id, sha256("t" + i), Date.now() - 1000 - i, i % 2, 1);
  db.prepare("INSERT INTO refresh_tokens(id,admin_id,token_hash,expires_at,revoked,created_at) VALUES (?,?,?,?,1,?)").run(uuid(), id, sha256("live-revoked"), Date.now() + 86400000, 1);
  await login(app);
  const left = db.prepare("SELECT token_hash,revoked,expires_at FROM refresh_tokens").all();
  assert.equal(left.filter(r => r.expires_at < Date.now()).length, 0, "expired ones are gone");
  assert.ok(left.some(r => r.token_hash === sha256("live-revoked")), "a revoked-but-unexpired token is kept so a replay is still detected");
  assert.equal(left.length, 2);
});

test("A15: the audit log is pruned by age and size, and pruning keeps the newest rows", async () => {
  const { pruneAudit } = await import("../src/lib/security.js");
  const { db } = await makeApp(); const day = 86400000, now = Date.now();
  const ins = db.prepare("INSERT INTO audit_log(id,admin_id,device_id,action,detail,ip,created_at) VALUES (?,?,?,?,?,?,?)");
  ins.run(uuid(), null, null, "old", null, null, now - 400 * day);
  for (let i = 0; i < 10; i++) ins.run(uuid(), null, null, "n" + i, null, null, now - i * 1000);
  const r = pruneAudit(db, { days: 365, maxRows: 6, now });
  assert.equal(r.removed, 5);
  assert.deepEqual(db.prepare("SELECT action FROM audit_log ORDER BY created_at DESC").all().map(x => x.action), ["n0", "n1", "n2", "n3", "n4", "n5"]);
});

test("A16: the audit log can be filtered and paged, so a flood of pairing failures cannot hide real events", async () => {
  const { app, db } = await makeApp(); await addOwner(db); const h = { cookie: await login(app) };
  const owner = db.prepare("SELECT id FROM admins").get().id, ins = db.prepare("INSERT INTO audit_log(id,admin_id,device_id,action,detail,ip,created_at) VALUES (?,?,?,?,?,?,?)");
  ins.run(uuid(), owner, null, "backup", null, "1.1.1.1", 1000);
  for (let i = 0; i < 300; i++) ins.run(uuid(), owner, null, "pairing_failed", null, "9.9.9.9", 2000 + i);
  const plain = (await app.inject({ method: "GET", url: "/api/audit", headers: h })).json();
  assert.equal(plain.length, 200, "the original shape and limit are unchanged for existing clients");
  assert.ok(!plain.some(r => r.action === "backup"), "...which is exactly how the flood hid it");
  const f = (await app.inject({ method: "GET", url: "/api/audit?action=backup", headers: h })).json();
  assert.deepEqual(f.map(r => r.action), ["backup"]);
  const page1 = (await app.inject({ method: "GET", url: "/api/audit?limit=100", headers: h })).json();
  const page2 = (await app.inject({ method: "GET", url: `/api/audit?limit=100&before=${page1.at(-1).created_at}`, headers: h })).json();
  assert.ok(page2.length > 0 && page2[0].created_at < page1.at(-1).created_at);
  assert.ok((await app.inject({ method: "GET", url: "/api/audit?limit=99999", headers: h })).json().length <= 500);
});

test("overview: owner-only, counts what matters, never returns secrets", async () => {
  const { app, db } = await makeApp(); await addOwner(db);
  assert.equal((await app.inject({ method: "GET", url: "/api/security/overview" })).statusCode, 401);
  const cookie = await login(app), h = { cookie };
  await enrollDevice(app, cookie, "Active one"); await enrollDevice(app, cookie, "Waiting", { approve: false });
  await post(app, "/api/auth/login", {}, { email: OWNER, password: "nope nope nope nope" });
  await post(app, "/api/enroll", {}, { code: "AAAA-BBBB" });
  await post(app, "/api/devices/enroll-code", h, {});
  const o = (await app.inject({ method: "GET", url: "/api/security/overview", headers: h })).json();
  assert.equal(o.owner.email, OWNER);
  assert.deepEqual([o.devices.total, o.devices.active, o.devices.pending], [2, 1, 1]);
  assert.equal(o.last24h.failedLogins, 1); assert.equal(o.last24h.failedPairings, 1); assert.ok(o.pairing.outstanding >= 1);
  assert.ok(o.findings.map(f => f.code).includes("pending_devices"));
  assert.ok(!/pw_hash|\$argon2|token_hash/i.test(JSON.stringify(o)), "no hashes in the response");
});

test("sessions: the list marks the current one; 'sign out others' keeps this browser signed in and ends the rest", async () => {
  const { app, db } = await makeApp(); await addOwner(db);
  const a = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } });
  const b = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } });
  const ha = { cookie: cookieHeader(a) };
  const list = (await app.inject({ method: "GET", url: "/api/auth/sessions", headers: ha })).json();
  assert.equal(list.length, 2); assert.deepEqual(list.map(s => s.current).sort(), [false, true]);
  assert.ok(list.every(s => !("token_hash" in s)));
  const r = await post(app, "/api/auth/sign-out-others", ha, {});
  assert.equal(r.json().signedOut, 1);
  // B5: the signed-out browser retrying must NOT be read as a stolen token (that would sign this browser out as well).
  assert.equal((await post(app, "/api/auth/refresh", { cookie: rt(b) }, {})).statusCode, 401, "the other browser is signed out");
  assert.equal((await post(app, "/api/auth/refresh", { cookie: rt(b) }, {})).statusCode, 401, "...however often it retries");
  assert.equal((await post(app, "/api/auth/refresh", { cookie: rt(a) }, {})).statusCode, 200, "this one is not");
  assert.equal(audits(db, "refresh_reuse_detected").length, 0);
  assert.equal(audits(db, "sign_out_others").length, 1);
});

test("sign out everywhere ends every session including this one", async () => {
  const { app, db } = await makeApp(); await addOwner(db);
  const a = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } });
  const r = await post(app, "/api/auth/sign-out-all", { cookie: cookieHeader(a) }, {});
  assert.equal(r.statusCode, 200);
  assert.equal((await post(app, "/api/auth/refresh", { cookie: rt(a) }, {})).statusCode, 401);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM refresh_tokens WHERE revoked=0").get().n, 0);
});

test("change password: needs the current password, enforces the policy, signs other sessions out, is audited, and the new one works", async () => {
  const { app, db } = await makeApp(); await addOwner(db);
  const a = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } });
  const b = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } });
  const ha = { cookie: cookieHeader(a) }, NEW = "a brand new passphrase 2026";
  assert.equal((await post(app, "/api/auth/password", {}, { current: PW, next: NEW })).statusCode, 401, "needs a session");
  assert.equal((await post(app, "/api/auth/password", ha, { current: "not it not it", next: NEW })).statusCode, 403);
  assert.equal((await post(app, "/api/auth/password", ha, { current: PW, next: "short" })).json().error, "weak_password");
  assert.equal((await post(app, "/api/auth/password", ha, { current: PW, next: PW })).json().error, "same_password");
  assert.equal((await post(app, "/api/auth/password", ha, { current: PW, next: NEW })).statusCode, 200);
  assert.equal((await post(app, "/api/auth/refresh", { cookie: rt(b) }, {})).statusCode, 401);
  assert.equal((await post(app, "/api/auth/refresh", { cookie: rt(a) }, {})).statusCode, 200);
  assert.equal((await post(app, "/api/auth/login", {}, { email: OWNER, password: PW })).statusCode, 401, "old password no longer works");
  assert.equal((await post(app, "/api/auth/login", {}, { email: OWNER, password: NEW })).statusCode, 200);
  assert.equal(audits(db, "password_changed").length, 1); assert.equal(audits(db, "password_change_failed").length, 1);
  assert.ok(!JSON.stringify(db.prepare("SELECT detail FROM audit_log").all()).includes(NEW), "passwords are never logged");
});

test("the dashboard refreshes and retries on the new /api/auth/ routes (only login, refresh and logout are exempt)", async () => {
  const fs = await import("node:fs"), path = await import("node:path"), { fileURLToPath } = await import("node:url");
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "app.js"), "utf8");
  assert.ok(!/path\.indexOf\("\/api\/auth\/"\) !== 0/.test(src), "a blanket /api/auth/ exemption would stop expired sessions refreshing on these routes");
});
