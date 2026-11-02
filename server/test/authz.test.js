import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login, enrollDevice, accessFor, session } from "./helpers.js";
import { signDeviceAccess } from "../src/lib/tokens.js";

async function setup() {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev = await enrollDevice(app, A);
  return { app, db, A, dev };
}
const as = (app, cookie, method, url, payload) => app.inject({ method, url, headers: { cookie }, payload });
const push = (app, dev, sessions = [session("s1", "v1")]) => app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions } });

test("every owner route refuses an unauthenticated caller", async () => {
  const { app, dev } = await setup();
  const id = dev.deviceId;
  for (const [m, u] of [["GET", "/api/devices"], ["GET", `/api/devices/${id}/videos`], ["GET", `/api/devices/${id}/sessions`], ["GET", `/api/devices/${id}/commands`],
    ["POST", `/api/devices/${id}/commands`], ["POST", `/api/devices/${id}/revoke`], ["POST", `/api/devices/${id}/approve`], ["PATCH", `/api/devices/${id}`], ["DELETE", `/api/devices/${id}`],
    ["POST", "/api/devices/enroll-code"], ["GET", "/api/history"], ["GET", "/api/stats"], ["GET", "/api/export"], ["POST", "/api/data/delete"],
    ["GET", "/api/settings"], ["PUT", "/api/settings"], ["GET", "/api/system"], ["POST", "/api/system/backup"], ["GET", "/api/audit"]]) {
    const r = await app.inject({ method: m, url: u, payload: m === "GET" ? undefined : {} });
    assert.equal(r.statusCode, 401, m + " " + u);
  }
});

test("a device's credentials never open owner routes, and the owner's cookie never opens device routes", async () => {
  const { app, A, dev } = await setup();
  for (const headers of [dev.auth, { authorization: "Bearer " + dev.refresh }]) {
    assert.equal((await app.inject({ method: "GET", url: "/api/devices", headers })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/history", headers })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/devices/enroll-code", headers, payload: {} })).statusCode, 401);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/sync/commands", headers: { cookie: A } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/sync/push", headers: { authorization: "Bearer garbage" }, payload: { sessions: [] } })).statusCode, 401);
});

test("the long-lived refresh credential is useless for syncing; only a short-lived access token works", async () => {
  const { app, dev } = await setup();
  const r = await app.inject({ method: "POST", url: "/api/sync/push", headers: { authorization: "Bearer " + dev.refresh }, payload: { sessions: [] } });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error, "token_invalid");
  assert.equal((await push(app, dev)).statusCode, 200);
});

test("expired, forged and unknown-device access tokens are 401; the client is told to refresh", async () => {
  const { app, dev } = await setup();
  const call = token => app.inject({ method: "POST", url: "/api/sync/push", headers: { authorization: "Bearer " + token }, payload: { sessions: [] } });
  assert.equal((await call(signDeviceAccess(dev.deviceId, dev.sessionId, Date.now() - 3600 * 1000))).json().error, "token_invalid");
  assert.equal((await call(signDeviceAccess(dev.deviceId, dev.sessionId) + "x")).json().error, "token_invalid");
  assert.equal((await call(signDeviceAccess("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000"))).json().error, "bad_token");
});

test("token endpoint: wrong credential is 401; a valid one returns a short-lived token", async () => {
  const { app, dev } = await setup();
  assert.equal((await app.inject({ method: "POST", url: "/api/device/token" })).statusCode, 401);
  const bad = await app.inject({ method: "POST", url: "/api/device/token", headers: { authorization: "Bearer not-a-real-credential" } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error, "bad_credential");
  const ok = (await accessFor(app, dev.refresh)).res.json();
  assert.equal(ok.status, "active");
  assert.equal(ok.expiresIn, 900);
});

test("revoking takes effect immediately: a still-valid access token is refused at once, and a new one cannot be obtained", async () => {
  const { app, A, dev } = await setup();
  assert.equal((await push(app, dev)).statusCode, 200);
  assert.equal((await as(app, A, "POST", `/api/devices/${dev.deviceId}/revoke`)).statusCode, 200);
  const p = await push(app, dev, [session("s2", "v1")]);
  assert.equal(p.statusCode, 403);
  assert.equal(p.json().error, "revoked");
  assert.equal((await app.inject({ method: "GET", url: "/api/sync/commands", headers: dev.auth })).statusCode, 403);
  const t = await accessFor(app, dev.refresh);
  assert.equal(t.res.statusCode, 403);
  assert.equal(t.res.json().error, "revoked");
});

test("a revoked device cannot read back synced data either (no device route returns history)", async () => {
  const { app, A, dev } = await setup();
  await push(app, dev);
  await as(app, A, "POST", `/api/devices/${dev.deviceId}/revoke`);
  for (const [m, u] of [["GET", "/api/sync/commands"], ["GET", "/api/device/status"], ["GET", `/api/devices/${dev.deviceId}/sessions`], ["GET", "/api/history"]]) {
    const r = await app.inject({ method: m, url: u, headers: dev.auth });
    assert.ok([401, 403].includes(r.statusCode), m + " " + u + " -> " + r.statusCode);
  }
});

test("removing a device invalidates its credentials and deletes its data", async () => {
  const { app, db, A, dev } = await setup();
  await push(app, dev);
  await as(app, A, "DELETE", `/api/devices/${dev.deviceId}`);
  assert.equal((await app.inject({ method: "GET", url: "/api/sync/commands", headers: dev.auth })).statusCode, 401);
  assert.equal((await accessFor(app, dev.refresh)).res.statusCode, 401);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM videos").get().n, 0);
});

test("two devices can use identical session ids without touching each other's rows", async () => {
  const { app, A, dev } = await setup();
  const dev2 = await enrollDevice(app, A, "Second");
  await push(app, dev, [session("same", "v1", { title: "from one" })]);
  await push(app, dev2, [session("same", "v1", { title: "from two" })]);
  const s1 = (await as(app, A, "GET", `/api/devices/${dev.deviceId}/sessions`)).json();
  const s2 = (await as(app, A, "GET", `/api/devices/${dev2.deviceId}/sessions`)).json();
  assert.deepEqual([s1.length, s1[0].title, s2.length, s2[0].title], [1, "from one", 1, "from two"]);
});

test("pairing codes are single-use and expire", async () => {
  const { app, db, A, dev } = await setup();
  assert.equal((await app.inject({ method: "POST", url: "/api/enroll", payload: { code: dev.code } })).statusCode, 400);
  const code = (await as(app, A, "POST", "/api/devices/enroll-code", {})).json().code;
  db.prepare("UPDATE enroll_codes SET expires_at=?").run(Date.now() - 1);
  assert.equal((await app.inject({ method: "POST", url: "/api/enroll", payload: { code } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/enroll", payload: { code: "NOPE" } })).statusCode, 400);
});

test("audit log records pairing, approval, revoke, command enqueue and failed pairing attempts", async () => {
  const { app, A, dev } = await setup();
  const pending = await enrollDevice(app, A, "Needs approval", { approve: false });
  await as(app, A, "POST", `/api/devices/${pending.deviceId}/approve`);
  await as(app, A, "POST", `/api/devices/${dev.deviceId}/commands`, { type: "pause_tracking" });
  await as(app, A, "POST", `/api/devices/${dev.deviceId}/revoke`);
  await app.inject({ method: "POST", url: "/api/enroll", payload: { code: "WRONG-CODE" } });
  const actions = (await as(app, A, "GET", "/api/audit")).json().map(r => r.action);
  for (const a of ["login", "pairing_code_created", "pair_completed", "pair_requested", "approve", "enqueue:pause_tracking", "revoke", "pairing_failed"]) assert.ok(actions.includes(a), a);
});
