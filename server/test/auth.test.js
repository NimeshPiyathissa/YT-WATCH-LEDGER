import { test } from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { makeApp, addOwner, login, cookieHeader, cookieNamed, PW, OWNER } from "./helpers.js";
import { signAccess, verifyAccess, signDeviceAccess, verifyDeviceAccess } from "../src/lib/tokens.js";
import { uuid } from "../src/lib/crypto.js";

test("wrong password and unknown email both give 401", async () => {
  const { app, db } = await makeApp();
  await addOwner(db);
  for (const body of [{ email: OWNER, password: "nope" }, { email: "ghost@example.com", password: PW }]) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: body });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error, "invalid_credentials");
  }
});

test("good login sets httpOnly/secure/strict at+rt cookies and grants access", async () => {
  const { app, db } = await makeApp();
  await addOwner(db);
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER.toUpperCase(), password: PW } });
  assert.equal(r.statusCode, 200);
  for (const n of ["at", "rt"]) {
    const c = cookieNamed(r, n);
    assert.ok(c, n + " cookie set");
    assert.equal(c.httpOnly, true); assert.equal(c.secure, true); assert.equal(c.sameSite, "Strict");
  }
  const ok = await app.inject({ method: "GET", url: "/api/devices", headers: { cookie: cookieHeader(r) } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/devices" })).statusCode, 401);
});

test("tampered or expired access cookie is rejected", async () => {
  const { app, db } = await makeApp();
  const id = await addOwner(db);
  const bad = await app.inject({ method: "GET", url: "/api/devices", headers: { cookie: "at=" + encodeURIComponent(signAccess(id) + "x") } });
  assert.equal(bad.statusCode, 401);
  assert.equal(verifyAccess(signAccess(id, Date.now() - 3600 * 1000)), null);
  assert.equal(verifyAccess(signAccess(id)), id);
});

test("owner and device tokens are not interchangeable", () => {
  const id = uuid();
  assert.equal(verifyDeviceAccess(signAccess(id)), null, "owner token is not a device token");
  assert.equal(verifyAccess(signDeviceAccess(id)), null, "device token is not an owner token");
  assert.equal(verifyDeviceAccess(signDeviceAccess(id, Date.now() - 3600 * 1000)), null, "expired device token");
  assert.equal(verifyDeviceAccess(signDeviceAccess(id)), id);
});

test("refresh rotates the token; replaying the old one revokes the whole family", async () => {
  const { app, db } = await makeApp();
  await addOwner(db);
  const l = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } });
  const rt1 = cookieNamed(l, "rt");
  const r1 = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: "rt=" + encodeURIComponent(rt1.value) } });
  assert.equal(r1.statusCode, 200);
  const rt2 = cookieNamed(r1, "rt");
  assert.notEqual(rt2.value, rt1.value);
  assert.ok(cookieNamed(r1, "at"));
  const replay = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: "rt=" + encodeURIComponent(rt1.value) } });
  assert.equal(replay.statusCode, 401);
  const after = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: "rt=" + encodeURIComponent(rt2.value) } });
  assert.equal(after.statusCode, 401, "new token revoked after reuse detection");
});

test("logout revokes the refresh token", async () => {
  const { app, db } = await makeApp();
  await addOwner(db);
  const l = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } });
  const rt = "rt=" + encodeURIComponent(cookieNamed(l, "rt").value);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: rt } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: rt } })).statusCode, 401);
});

test("there is no public registration: the route does not exist, with or without an owner", async () => {
  const { app, db } = await makeApp();
  const body = { email: "intruder@example.com", password: "a-perfectly-good-password" };
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/register", payload: body })).statusCode, 404, "no owner yet");
  await addOwner(db);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/register", payload: body })).statusCode, 404, "owner exists");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM admins").get().n, 1);
});

test("the database itself refuses a second owner", async () => {
  const { db } = await makeApp();
  await addOwner(db);
  assert.throws(() => db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES (?,?,?,?)").run(uuid(), "second@example.com", "x", Date.now()), /UNIQUE/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM admins").get().n, 1);
});

test("cross-origin state-changing request with a valid session is refused", async () => {
  const { app, db } = await makeApp();
  await addOwner(db);
  const cookie = await login(app);
  const evil = await app.inject({ method: "POST", url: "/api/devices/enroll-code", headers: { cookie, origin: "https://evil.example" }, payload: {} });
  assert.equal(evil.statusCode, 403);
  const own = await app.inject({ method: "POST", url: "/api/devices/enroll-code", headers: { cookie, origin: "https://tracker.test" }, payload: {} });
  assert.equal(own.statusCode, 200);
});

test("security headers are present", async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.match(r.headers["strict-transport-security"], /max-age/);
  assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
});

test("errors never leak internals: bad JSON is a plain 400, unknown API route a plain 404", async () => {
  const { app } = await makeApp();
  const bad = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: "{not json" });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json(), { error: "bad_request" });
  const nf = await app.inject({ method: "GET", url: "/api/nope" });
  assert.equal(nf.statusCode, 404);
  assert.ok(!/stack|at |node_modules/i.test(nf.body));
});

test("an unexpected server error is a generic 500 with no stack trace", async () => {
  const { app, db } = await makeApp();
  await addOwner(db);
  const cookie = await login(app);
  db.exec("DROP TABLE settings"); // break something the route needs
  const r = await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } });
  assert.equal(r.statusCode, 500);
  assert.equal(r.json().error, "internal_error");
  assert.ok(!/settings|SQLITE|stack|node_modules/i.test(r.body), "no internal detail in the response");
});

test("owner password helper creates exactly one owner and reset signs sessions out", async () => {
  const { createOwner, resetOwnerPassword } = await import("../scripts/create-owner.js");
  const { app, db } = await makeApp();
  await assert.rejects(createOwner(db, "bad", "long-enough-password"), /valid email/);
  await assert.rejects(createOwner(db, "me@example.com", "short"), /password must be/);
  await createOwner(db, "Me@Example.com", "long-enough-password");
  await assert.rejects(createOwner(db, "other@example.com", "long-enough-password"), /already exists/);
  assert.equal(db.prepare("SELECT email FROM admins").get().email, "me@example.com");
  const l = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "me@example.com", password: "long-enough-password" } });
  const rt = "rt=" + encodeURIComponent(cookieNamed(l, "rt").value);
  await resetOwnerPassword(db, "a-brand-new-password!");
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: rt } })).statusCode, 401, "old session signed out");
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "me@example.com", password: "long-enough-password" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "me@example.com", password: "a-brand-new-password!" } })).statusCode, 200);
  assert.ok(await argon2.verify(db.prepare("SELECT pw_hash FROM admins").get().pw_hash, "a-brand-new-password!"));
});
