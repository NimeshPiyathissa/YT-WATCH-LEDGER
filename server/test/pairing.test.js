import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login, enrollDevice, accessFor, session } from "./helpers.js";
import { expirePending } from "../src/lib/retention.js";

async function setup() {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  return { app, db, A };
}
const owner = (app, A, method, url, payload) => app.inject({ method, url, headers: { cookie: A }, payload });
const devices = async (app, A) => (await owner(app, A, "GET", "/api/devices")).json();

test("a redeemed pairing code creates a PENDING device that can do nothing until the owner approves", async () => {
  const { app, A } = await setup();
  const dev = await enrollDevice(app, A, "New laptop", { approve: false });
  const list = await devices(app, A);
  assert.equal(list[0].status, "pending");
  assert.equal(list[0].approved_at, null);

  const { res, auth } = await accessFor(app, dev.refresh);
  assert.equal(res.json().status, "pending", "a pending device may obtain a token (to poll its status)");
  const push = await app.inject({ method: "POST", url: "/api/sync/push", headers: auth, payload: { sessions: [session("s1", "v1")] } });
  assert.equal(push.statusCode, 403);
  assert.equal(push.json().error, "pending_approval");
  assert.equal((await app.inject({ method: "GET", url: "/api/sync/commands", headers: auth })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/sync/unenroll", headers: auth, payload: {} })).statusCode, 403);
  // the only thing it may do is ask what its own status is
  const st = await app.inject({ method: "GET", url: "/api/device/status", headers: auth });
  assert.deepEqual([st.statusCode, st.json().status], [200, "pending"]);
  assert.equal((await app.inject({ method: "GET", url: "/api/history", headers: auth })).statusCode, 401);
});

test("the owner sees the same confirmation code the device was shown, and codes differ per device", async () => {
  const { app, A } = await setup();
  const d1 = await enrollDevice(app, A, "One", { approve: false });
  const d2 = await enrollDevice(app, A, "Two", { approve: false });
  const list = await devices(app, A);
  const byId = Object.fromEntries(list.map(d => [d.id, d]));
  assert.equal(byId[d1.deviceId].confirm_code, d1.confirmCode);
  assert.equal(byId[d2.deviceId].confirm_code, d2.confirmCode);
  assert.notEqual(d1.confirmCode, d2.confirmCode);
  assert.match(d1.confirmCode, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  const st = (await app.inject({ method: "GET", url: "/api/device/status", headers: (await accessFor(app, d1.refresh)).auth })).json();
  assert.equal(st.confirmCode, d1.confirmCode);
});

test("approving activates the device; only a pending device can be approved", async () => {
  const { app, A } = await setup();
  const dev = await enrollDevice(app, A, "Laptop", { approve: false });
  assert.equal((await owner(app, A, "POST", `/api/devices/${dev.deviceId}/commands`, { type: "pause_tracking" })).statusCode, 409, "no commands for a device that isn't active");
  assert.equal((await owner(app, A, "POST", `/api/devices/${dev.deviceId}/approve`)).statusCode, 200);
  const { auth } = await accessFor(app, dev.refresh);
  assert.equal((await app.inject({ method: "POST", url: "/api/sync/push", headers: auth, payload: { sessions: [session("s1", "v1")] } })).statusCode, 200);
  const d = (await devices(app, A))[0];
  assert.equal(d.status, "active"); assert.ok(d.approved_at > 0); assert.equal(d.confirm_code, null);
  assert.equal((await owner(app, A, "POST", `/api/devices/${dev.deviceId}/approve`)).statusCode, 409, "already active");
  assert.equal((await owner(app, A, "POST", "/api/devices/nope/approve")).statusCode, 404);
});

test("rejecting a pending device (removing it) invalidates its credentials", async () => {
  const { app, A } = await setup();
  const dev = await enrollDevice(app, A, "Stranger", { approve: false });
  assert.equal((await owner(app, A, "DELETE", `/api/devices/${dev.deviceId}`)).statusCode, 200);
  assert.equal((await accessFor(app, dev.refresh)).res.statusCode, 401);
  assert.equal((await devices(app, A)).length, 0);
});

test("a pending device that is never approved expires; approved devices are untouched", async () => {
  const { app, db, A } = await setup();
  const stale = await enrollDevice(app, A, "Stale", { approve: false });
  const fresh = await enrollDevice(app, A, "Fresh", { approve: false });
  const ok = await enrollDevice(app, A, "Approved");
  db.prepare("UPDATE devices SET enrolled_at=? WHERE id IN (?,?)").run(Date.now() - 25 * 3600 * 1000, stale.deviceId, ok.deviceId);
  assert.equal(expirePending(db), 1);
  const ids = (await devices(app, A)).map(d => d.id);
  assert.deepEqual(ids.sort(), [fresh.deviceId, ok.deviceId].sort());
});

test("the owner can rename a device, with validation, and it is audited", async () => {
  const { app, A } = await setup();
  const dev = await enrollDevice(app, A, "Old name");
  assert.equal((await owner(app, A, "PATCH", `/api/devices/${dev.deviceId}`, { label: "  Work laptop  " })).statusCode, 200);
  assert.equal((await devices(app, A))[0].label, "Work laptop");
  for (const label of ["", "   ", "x".repeat(81), 42, undefined]) assert.equal((await owner(app, A, "PATCH", `/api/devices/${dev.deviceId}`, { label })).statusCode, 400, JSON.stringify(label));
  assert.equal((await owner(app, A, "PATCH", "/api/devices/nope", { label: "x" })).statusCode, 404);
  assert.ok((await owner(app, A, "GET", "/api/audit")).json().some(r => r.action === "rename"));
});

test("revoking a device keeps its data until the owner removes it; removing it deletes the data", async () => {
  const { app, db, A } = await setup();
  const dev = await enrollDevice(app, A, "Laptop");
  await app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions: [session("s1", "v1")] } });
  await owner(app, A, "POST", `/api/devices/${dev.deviceId}/revoke`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1, "revoke stops sync but does not delete history");
  assert.equal((await owner(app, A, "GET", "/api/history")).json().total, 1, "the owner can still see it in the combined history");
  await owner(app, A, "DELETE", `/api/devices/${dev.deviceId}`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0);
});
