// Server-managed device configuration: who may change it, what is accepted, how versions, history and device
// acknowledgements behave, and what offline and failed devices look like.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login, enrollDevice } from "./helpers.js";
import { uuid } from "../src/lib/crypto.js";
import { validateChanges, applyChanges, stateOf } from "../src/lib/config.js";

async function setup(opts) {
  const { app, db } = await makeApp(); await addOwner(db);
  const A = await login(app), dev = await enrollDevice(app, A, "Cfg device", opts);
  return { app, db, A, dev };
}
const own = (app, A, method, url, payload, extra) => app.inject({ method, url, headers: { cookie: A, ...extra }, payload });
const put = (app, A, id, changes) => own(app, A, "PUT", `/api/devices/${id}/config`, { changes });
const ack = (app, dev, payload) => app.inject({ method: "POST", url: "/api/sync/config/ack", headers: dev.auth, payload });

/* ---- pure rules ---- */
test("validation: only allowlisted integer settings within bounds; null clears; tracking is not a setting", () => {
  assert.deepEqual(validateChanges({ retention_days: 90, sync_interval_minutes: 15 }), { ok: true, clean: { retention_days: 90, sync_interval_minutes: 15 } });
  assert.deepEqual(validateChanges({ retention_days: null }), { ok: true, clean: { retention_days: null } });
  for (const bad of [null, [], "x", {}, { tracking_enabled: false }, { collect_title: false }, { retention_days: -1 }, { retention_days: 3651 }, { retention_days: 1.5 }, { retention_days: "30" },
    { sync_interval_minutes: 4 }, { sync_interval_minutes: 61 }, { sync_interval_minutes: NaN }, { retention_days: 1, sync_interval_minutes: 5, extra: 1 }, { __proto__: { retention_days: 5 } }])
    assert.equal(validateChanges(bad).ok, false, JSON.stringify(bad));
  assert.equal(validateChanges({ tracking_enabled: true }).error, "unknown_setting");
});

test("diff and state: only real changes count; states are none, pending, applied, failed", () => {
  assert.deepEqual(applyChanges({ retention_days: 30 }, { retention_days: 30 }).diff, {});
  assert.deepEqual(applyChanges({ retention_days: 30 }, { retention_days: 90 }), { next: { retention_days: 90 }, diff: { retention_days: { from: 30, to: 90 } } });
  assert.deepEqual(applyChanges({ retention_days: 30 }, { retention_days: null }), { next: {}, diff: { retention_days: { from: 30, to: null } } });
  assert.deepEqual(applyChanges({}, { retention_days: null }).diff, {}, "clearing something never set is no change");
  assert.deepEqual([stateOf(null), stateOf({ version: 0 }), stateOf({ version: 2, applied_version: 1 }), stateOf({ version: 2, applied_version: 2 }), stateOf({ version: 2, applied_version: 1, failed_version: 2 })], ["none", "none", "pending", "applied", "failed"]);
});

/* ---- authorization (server-side; the buttons are not the control) ---- */
test("only the signed-in owner can read or change a device's config; devices cannot, other owners' devices are 403, foreign Origin is 403", async () => {
  const { app, db, A, dev } = await setup(), url = `/api/devices/${dev.deviceId}/config`;
  for (const [m, u, p] of [["GET", url], ["PUT", url, { changes: { retention_days: 7 } }], ["GET", url + "/history"]]) {
    assert.equal((await app.inject({ method: m, url: u, payload: p })).statusCode, 401, "no cookie: " + m + " " + u);
    assert.equal((await app.inject({ method: m, url: u, payload: p, headers: dev.auth })).statusCode, 401, "device token: " + m + " " + u);
  }
  assert.equal((await own(app, A, "PUT", url, { changes: { retention_days: 7 } }, { origin: "https://evil.example" })).statusCode, 403);
  assert.equal((await own(app, A, "GET", "/api/devices/nope/config")).statusCode, 404);
  db.pragma("foreign_keys = OFF"); // test only: a device owned by an admin id that is not ours (the one-owner rule would otherwise forbid a second admin row)
  db.prepare("UPDATE devices SET admin_id=? WHERE id=?").run(uuid(), dev.deviceId);
  db.pragma("foreign_keys = ON");
  for (const [m, u, p] of [["GET", url], ["PUT", url, { changes: { retention_days: 7 } }], ["GET", url + "/history"]]) assert.equal((await own(app, A, m, u, p)).statusCode, 403, "other owner: " + m);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_config").get().n, 0, "nothing was written by any refused call");
});

test("a device can read only its own config, and only while approved and not revoked", async () => {
  const { app, A, dev } = await setup();
  await put(app, A, dev.deviceId, { retention_days: 14 });
  const mine = await app.inject({ method: "GET", url: "/api/sync/config", headers: dev.auth });
  assert.deepEqual([mine.statusCode, mine.json()], [200, { version: 1, config: { retention_days: 14 } }]);
  const other = await enrollDevice(app, A, "Other");
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/sync/config", headers: other.auth })).json(), { version: 0, config: {} }, "another device sees nothing of it");
  const waiting = await enrollDevice(app, A, "Waiting", { approve: false });
  assert.equal((await app.inject({ method: "GET", url: "/api/sync/config", headers: waiting.auth })).json().error, "pending_approval");
  await own(app, A, "POST", `/api/devices/${dev.deviceId}/revoke`);
  assert.equal((await app.inject({ method: "GET", url: "/api/sync/config", headers: dev.auth })).statusCode, 403);
});

/* ---- changing, versioning, history, audit ---- */
test("a change is validated, versioned, stored, audited with before/after, and shown as pending", async () => {
  const { app, A, dev } = await setup();
  for (const [body, status] of [[{ tracking_enabled: false }, 400], [{ retention_days: 99999 }, 400], [{}, 400]]) {
    const r = await put(app, A, dev.deviceId, body);
    assert.equal(r.statusCode, status, JSON.stringify(body));
  }
  assert.equal((await own(app, A, "PUT", `/api/devices/${dev.deviceId}/config`, { nope: 1 })).statusCode, 400);
  const r = await put(app, A, dev.deviceId, { retention_days: 90, sync_interval_minutes: 15 });
  const j = r.json();
  assert.deepEqual([r.statusCode, j.changed, j.version, j.state, j.config], [200, true, 1, "pending", { retention_days: 90, sync_interval_minutes: 15 }]);
  assert.deepEqual(j.spec.retention_days.max, 3650);

  const same = (await put(app, A, dev.deviceId, { retention_days: 90 })).json();
  assert.deepEqual([same.changed, same.version], [false, 1], "setting the same value changes nothing and adds no history");
  const two = (await put(app, A, dev.deviceId, { retention_days: 30 })).json();
  assert.deepEqual([two.version, two.config.retention_days, two.config.sync_interval_minutes], [2, 30, 15], "other settings are kept");

  const hist = (await own(app, A, "GET", `/api/devices/${dev.deviceId}/config/history`)).json();
  assert.deepEqual(hist.map(h => [h.version, h.status, h.actor_label]), [[2, "pending", "owner@example.com"], [1, "pending", "owner@example.com"]]);
  assert.deepEqual(hist[0].changes, { retention_days: { from: 90, to: 30 } });
  const audit = (await own(app, A, "GET", "/api/audit")).json().filter(x => x.action === "config_changed");
  assert.equal(audit.length, 2);
  assert.deepEqual(JSON.parse(audit[0].detail), { version: 2, changes: { retention_days: { from: 90, to: 30 } } });
});

test("clearing a setting hands it back to the device; a device that is not active cannot be configured", async () => {
  const { app, A, dev } = await setup();
  await put(app, A, dev.deviceId, { retention_days: 7 });
  const cleared = (await put(app, A, dev.deviceId, { retention_days: null })).json();
  assert.deepEqual([cleared.version, cleared.config], [2, {}]);
  const waiting = await enrollDevice(app, A, "Waiting", { approve: false });
  assert.equal((await put(app, A, waiting.deviceId, { retention_days: 7 })).statusCode, 409);
  await own(app, A, "POST", `/api/devices/${dev.deviceId}/revoke`);
  assert.equal((await put(app, A, dev.deviceId, { retention_days: 7 })).statusCode, 409);
});

/* ---- device acknowledgements ---- */
test("device reports applied: state becomes applied, history and audit record it, retention is mirrored on the server", async () => {
  const { app, db, A, dev } = await setup();
  await put(app, A, dev.deviceId, { retention_days: 30 });
  await put(app, A, dev.deviceId, { retention_days: 60 });
  assert.deepEqual((await ack(app, dev, { version: 1, status: "applied" })).json(), { ok: true, stale: true, currentVersion: 2 }, "an answer for an old version changes nothing");
  assert.equal((await own(app, A, "GET", `/api/devices/${dev.deviceId}/config`)).json().state, "pending");
  assert.equal((await ack(app, dev, { version: 2, status: "applied" })).statusCode, 200);
  const s = (await own(app, A, "GET", `/api/devices/${dev.deviceId}/config`)).json();
  assert.deepEqual([s.state, s.appliedVersion, s.error], ["applied", 2, null]);
  assert.ok(s.appliedAt > 0);
  const hist = (await own(app, A, "GET", `/api/devices/${dev.deviceId}/config/history`)).json();
  assert.deepEqual(hist.map(h => [h.version, h.status]), [[2, "applied"], [1, "superseded"]]);
  assert.equal(db.prepare("SELECT retention_days FROM devices WHERE id=?").get(dev.deviceId).retention_days, 60);
  assert.ok((await own(app, A, "GET", "/api/audit")).json().some(x => x.action === "config_applied"));
});

test("device reports failure: the error is shown, nothing is claimed as applied, a new version can recover", async () => {
  const { app, db, A, dev } = await setup();
  await put(app, A, dev.deviceId, { sync_interval_minutes: 10 });
  assert.equal((await ack(app, dev, { version: 1, status: "failed", error: "x".repeat(900) })).statusCode, 200);
  const s = (await own(app, A, "GET", `/api/devices/${dev.deviceId}/config`)).json();
  assert.deepEqual([s.state, s.appliedVersion, s.error.length], ["failed", 0, 300], "error is bounded");
  assert.equal(db.prepare("SELECT retention_days FROM devices WHERE id=?").get(dev.deviceId).retention_days, 0, "a failure changes nothing on the server's mirror");
  assert.ok((await own(app, A, "GET", "/api/audit")).json().some(x => x.action === "config_failed"));
  await put(app, A, dev.deviceId, { sync_interval_minutes: 20 });
  assert.equal((await own(app, A, "GET", `/api/devices/${dev.deviceId}/config`)).json().state, "pending", "the new version starts pending");
  await ack(app, dev, { version: 2, status: "applied" });
  const s2 = (await own(app, A, "GET", `/api/devices/${dev.deviceId}/config`)).json();
  assert.deepEqual([s2.state, s2.error], ["applied", null]);
});

test("acknowledgements are validated and cannot touch another device", async () => {
  const { app, A, dev } = await setup(), other = await enrollDevice(app, A, "Other");
  await put(app, A, dev.deviceId, { retention_days: 5 });
  for (const bad of [{}, { version: "1", status: "applied" }, { version: 1, status: "maybe" }, { version: 1.5, status: "applied" }, { status: "applied" }])
    assert.equal((await ack(app, dev, bad)).statusCode, 400, JSON.stringify(bad));
  assert.equal((await ack(app, other, { version: 1, status: "applied" })).json().stale, true, "another device's ack is ignored: it has no config");
  assert.equal((await own(app, A, "GET", `/api/devices/${dev.deviceId}/config`)).json().state, "pending");
  assert.equal((await app.inject({ method: "POST", url: "/api/sync/config/ack", payload: { version: 1, status: "applied" } })).statusCode, 401);
});

test("an offline device keeps the config pending (and is shown as offline) until it reports; removing the device removes its config", async () => {
  const { app, db, A, dev } = await setup();
  await put(app, A, dev.deviceId, { retention_days: 45 });
  const s = (await own(app, A, "GET", `/api/devices/${dev.deviceId}/config`)).json();
  assert.deepEqual([s.state, s.online, s.deviceActive], ["pending", false, true], "no socket open: saved, waiting for the device");
  await own(app, A, "DELETE", `/api/devices/${dev.deviceId}`);
  assert.deepEqual([db.prepare("SELECT COUNT(*) n FROM device_config").get().n, db.prepare("SELECT COUNT(*) n FROM device_config_history").get().n], [0, 0]);
});
