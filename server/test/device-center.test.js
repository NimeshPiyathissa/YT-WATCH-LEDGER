import "./env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose, compareVersions } from "../src/lib/deviceDiagnostics.js";
import { makeApp, addOwner, login, enrollDevice, session, allowLiveView } from "./helpers.js";

const MIN = 60000, NOW = Date.UTC(2026, 10, 4, 6, 0, 0);
const dev = (o = {}) => ({ status: "active", last_seen: NOW - MIN, last_push_at: NOW - MIN, pending_count: 0, queue_events: 0, queue_dropped: 0, last_error: null, clock_skew_ms: 0, client_version: "0.8.0", live_view: 0, ...o });
const facts = (o = {}) => ({ device: dev(o.device), connection: "online", realtime: true, activeSessions: 1, errors: [], serverVersion: "0.8.0", syncIntervalMin: 5, now: NOW, config: null, ...o, device: dev(o.device) });
const by = (r, id) => r.checks.find(c => c.id === id);

test("versions compare numerically, ignore pre-release tags, and tolerate junk", () => {
  assert.equal(compareVersions("0.7.0", "0.8.0"), -1); assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.8.0-beta.1", "0.8.0"), 0); assert.equal(compareVersions("", "0.1.0"), -1); assert.equal(compareVersions("x", "y"), 0);
});

test("a healthy, connected device passes every check", () => {
  const r = diagnose(facts());
  assert.equal(r.level, "ok");
  for (const id of ["access", "connection", "sync", "queue", "errors", "version"]) assert.equal(by(r, id).level, "ok", id);
  assert.equal(by(r, "consent").title, "Live viewing is off");
});

test("access: revoked is bad, pending asks for approval, no session is bad", () => {
  assert.equal(by(diagnose(facts({ device: { status: "revoked" } })), "access").level, "bad");
  const p = diagnose(facts({ device: { status: "pending" } }));
  assert.equal(by(p, "access").level, "warn"); assert.match(by(p, "access").fix, /confirmation code/);
  assert.equal(by(diagnose(facts({ activeSessions: 0 })), "access").level, "bad");
  assert.equal(by(diagnose(facts({ device: { status: "revoked" } })), "sync"), undefined, "nothing else is judged for a revoked device");
});

test("connection: live, recently seen, never connected, offline", () => {
  assert.equal(by(diagnose(facts()), "connection").title, "Connected live");
  assert.equal(by(diagnose(facts({ realtime: false })), "connection").title, "Reachable");
  const never = diagnose(facts({ realtime: false, connection: "offline", device: { last_seen: null, last_push_at: null } }));
  assert.equal(by(never, "connection").title, "Never connected");
  const off = diagnose(facts({ realtime: false, connection: "offline", device: { last_seen: NOW - 3 * 3600000, last_push_at: NOW - 3 * 3600000 } }));
  assert.equal(by(off, "connection").level, "warn"); assert.match(by(off, "connection").detail, /3 h ago/);
});

test("sync freshness follows the device's own interval: on time, late, and over a day", () => {
  assert.equal(by(diagnose(facts({ device: { last_push_at: NOW - 14 * MIN } })), "sync").level, "ok");
  assert.equal(by(diagnose(facts({ device: { last_push_at: NOW - 16 * MIN } })), "sync").level, "warn");
  assert.equal(by(diagnose(facts({ device: { last_push_at: NOW - 16 * MIN }, syncIntervalMin: 30 })), "sync").level, "ok", "a managed 30-minute interval is respected");
  assert.equal(by(diagnose(facts({ device: { last_push_at: NOW - 30 * 3600000 } })), "sync").level, "bad");
  assert.equal(by(diagnose(facts({ device: { last_push_at: null } })), "sync").title, "Nothing uploaded yet");
});

test("queue: dropped events and long queues are explained, with reassurance that nothing was lost on the device", () => {
  const d = diagnose(facts({ device: { queue_dropped: 40, queue_events: 20000 } }));
  assert.equal(by(d, "queue").level, "warn"); assert.match(by(d, "queue").detail, /40 playback events stayed on the device/); assert.match(by(d, "queue").fix, /not lost/);
  assert.equal(by(diagnose(facts({ device: { pending_count: 900 } })), "queue").level, "warn");
});

test("errors, clock skew, old extension, refused settings", () => {
  assert.equal(by(diagnose(facts({ device: { last_error: "push 500" } })), "errors").level, "warn");
  const c = by(diagnose(facts({ device: { clock_skew_ms: 7 * MIN } })), "clock"); assert.equal(c.level, "info"); assert.match(c.detail, /7 min/);
  assert.equal(by(diagnose(facts({ device: { clock_skew_ms: 30000 } })), "clock"), undefined);
  assert.equal(by(diagnose(facts({ device: { client_version: "0.7.0" } })), "version").level, "info");
  assert.equal(by(diagnose(facts({ config: { state: "failed", error: "retention_days out of range" } })), "config").level, "warn");
  assert.equal(by(diagnose(facts({ config: { state: "pending" } })), "config").level, "info");
});

test("the overall level is the worst real problem; informational notes never make it worse than ok", () => {
  assert.equal(diagnose(facts({ device: { clock_skew_ms: 9 * MIN, client_version: "0.7.0" } })).level, "ok");
  assert.equal(diagnose(facts({ device: { last_error: "x" } })).level, "warn");
  assert.equal(diagnose(facts({ device: { status: "revoked", last_error: "x" } })).level, "bad");
});

async function setup() {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev1 = await enrollDevice(app, A, "Laptop");
  const get = (url, cookie = A) => app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
  const push = payload => app.inject({ method: "POST", url: "/api/sync/push", headers: dev1.auth, payload });
  return { app, db, A, dev: dev1, get, push };
}

test("device diagnostics API: owner only, never a credential, reflects what the device reported", async () => {
  const { app, get, push, dev: d, A } = await setup();
  for (const url of [`/api/devices/${d.deviceId}/diagnostics`, `/api/devices/${d.deviceId}/activity`]) {
    assert.equal((await get(url, null)).statusCode, 401, url);
    assert.equal((await app.inject({ method: "GET", url, headers: d.auth })).statusCode, 401, url + " with a device token");
  }
  assert.equal((await get("/api/devices/nope/diagnostics")).statusCode, 404);
  await push({ sessions: [session("s1", "vidA")], clientNow: Date.now(), pending: 3, clientVersion: "0.8.0", consents: { liveView: true, tracking: true, detail: false }, queue: { events: 12, dropped: 5 }, lastError: "push 503", lastErrorKind: "server" });
  const r = (await get(`/api/devices/${d.deviceId}/diagnostics`)).json();
  assert.equal(r.label, "Laptop"); assert.deepEqual(r.queue, { sessions: 3, events: 12, dropped: 5 });
  assert.deepEqual([r.consents.liveView, r.consents.tracking, r.consents.detail], [true, true, false]);
  assert.equal(r.errors[0].kind, "server"); assert.equal(r.errors[0].message, "push 503");
  assert.ok(r.checks.find(c => c.id === "queue" && c.level === "warn"));
  const text = JSON.stringify(r);
  assert.ok(!text.includes(d.refresh) && !text.includes(d.auth.authorization.slice(7)) && !/token_hash|code_hash|pw_hash/.test(text), "no credential material");
  void A;
});

test("sync errors are kept as a short deduplicated history", async () => {
  const { push, get, dev: d, db } = await setup();
  await push({ sessions: [], lastError: "offline", lastErrorKind: "network" });
  await push({ sessions: [], lastError: "offline", lastErrorKind: "network" });   // the same message within ten minutes: one row
  await push({ sessions: [], lastError: "push 500", lastErrorKind: "bogus-kind" }); // an unknown kind is stored as "other"
  const rows = db.prepare("SELECT kind,message FROM device_sync_errors WHERE device_id=? ORDER BY id").all(d.deviceId).map(x => ({ ...x }));
  assert.deepEqual(rows, [{ kind: "network", message: "offline" }, { kind: "other", message: "push 500" }]);
  for (let i = 0; i < 70; i++) db.prepare("INSERT INTO device_sync_errors(device_id,at,kind,message) VALUES (?,?,?,?)").run(d.deviceId, 1000 + i, "other", "e" + i);
  await push({ sessions: [], lastError: "final", lastErrorKind: "other" });
  assert.ok(db.prepare("SELECT COUNT(*) n FROM device_sync_errors WHERE device_id=?").get(d.deviceId).n <= 50, "capped per device");
  const act = (await get(`/api/devices/${d.deviceId}/activity?limit=5`)).json();
  assert.equal(act.items.length, 5); assert.equal(act.items[0].title, "Sync problem: other");
});

test("activity history: merged, newest first, wording for consent changes, secrets stripped, paged", async () => {
  const { app, get, dev: d, db, A } = await setup();
  await allowLiveView(app, d, true);
  await allowLiveView(app, d, false);
  await app.inject({ method: "PUT", url: `/api/devices/${d.deviceId}/config`, headers: { cookie: A }, payload: { changes: { retention_days: 30 } } });
  const admin = db.prepare("SELECT admin_id FROM devices WHERE id=?").get(d.deviceId).admin_id;
  db.prepare("INSERT INTO audit_log(id,admin_id,device_id,action,detail,created_at) VALUES('z',?,?,?,?,?)").run(admin, d.deviceId, "rename", JSON.stringify({ from: "a", to: "b", pairing_code: "ABCD-EFGH", token: "secret" }), Date.now() + 10);
  const r = (await get(`/api/devices/${d.deviceId}/activity`)).json();
  const titles = r.items.map(i => i.title);
  assert.ok(titles.includes("Live viewing turned ON by the person at the device") && titles.includes("Live viewing turned OFF by the person at the device"));
  assert.ok(titles.some(t => /Settings version 1 saved/.test(t)));
  assert.equal(r.items[0].title, "Renamed", "newest first");
  assert.deepEqual(r.items.map(i => i.at), r.items.map(i => i.at).sort((a, b) => b - a));
  assert.deepEqual(r.items[0].detail, { from: "a", to: "b" }, "fields that look like secrets are dropped");
  const p1 = (await get(`/api/devices/${d.deviceId}/activity?limit=2`)).json();
  assert.equal(p1.items.length, 2); assert.ok(p1.next);
  const p2 = (await get(`/api/devices/${d.deviceId}/activity?limit=50&before=${p1.next}`)).json();
  assert.ok(p2.items.every(i => i.at < p1.next));
});
