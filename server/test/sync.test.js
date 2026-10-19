import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login, enrollDevice, session } from "./helpers.js";

async function setup() {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev = await enrollDevice(app, A);
  const push = (sessions, extra = {}, d = dev) => app.inject({ method: "POST", url: "/api/sync/push", headers: d.auth, payload: { sessions, ...extra } });
  const videos = async (d = dev) => (await app.inject({ method: "GET", url: `/api/devices/${d.deviceId}/videos`, headers: { cookie: A } })).json();
  const sessionsOf = async (d = dev) => (await app.inject({ method: "GET", url: `/api/devices/${d.deviceId}/sessions`, headers: { cookie: A } })).json();
  return { app, db, A, dev, push, videos, sessionsOf };
}

test("pushing the same session twice is idempotent and the rollup is correct", async () => {
  const { db, push, videos } = await setup();
  const s = session("s1", "vid1", { watchedMs: 90000, duration: 300 });
  assert.equal((await push([s])).statusCode, 200);
  assert.equal((await push([s])).statusCode, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM videos").get().n, 1);
  const [v] = await videos();
  assert.deepEqual([v.videoId, v.totalMs, v.sessionCount, v.percent], ["vid1", 90000, 1, 30]);
});

test("conflicts are resolved by session revision, never by the device clock", async () => {
  const { db, push, videos } = await setup();
  // a far-future device clock on an OLD revision must not beat a newer revision
  await push([session("s1", "vid1", { watchedMs: 10000, rev: 1, updatedAt: 9_999_999_999_999 })]);
  await push([session("s1", "vid1", { watchedMs: 40000, rev: 3, updatedAt: 5 })]);
  assert.equal((await videos())[0].totalMs, 40000);
  await push([session("s1", "vid1", { watchedMs: 5000, rev: 2, updatedAt: 9_999_999_999_998 })]); // stale revision arriving late
  assert.equal((await videos())[0].totalMs, 40000, "late, lower revision ignored");
  assert.equal(db.prepare("SELECT rev FROM sessions").get().rev, 3);
  await push([session("s1", "vid1", { watchedMs: 40000, rev: 3 })]); // same revision again: harmless
  assert.equal((await videos())[0].totalMs, 40000);
});

test("rollup sums multiple sessions of one video, keeps videos separate, and carries progress/rewatch fields", async () => {
  const { push, videos } = await setup();
  await push([session("a", "v1", { watchedMs: 1000, startTs: 100, furthestSec: 50, seeks: 2, pauses: 1, completed: false }),
    session("b", "v1", { watchedMs: 2000, startTs: 200, furthestSec: 580, seeks: 1, completed: true }), session("c", "v2", { watchedMs: 7000 })]);
  const byId = Object.fromEntries((await videos()).map(v => [v.videoId, v]));
  assert.deepEqual([byId.v1.totalMs, byId.v1.sessionCount, byId.v2.totalMs], [3000, 2, 7000]);
  assert.deepEqual([byId.v1.rewatches, byId.v1.completions, byId.v1.seeks, byId.v1.pauses, byId.v1.furthestSec, byId.v1.progress], [1, 1, 3, 1, 580, 97]);
});

test("device clocks: a skewed clock is measured at upload and every time is put on the server's clock", async () => {
  const { app, db, A, dev, push, sessionsOf } = await setup();
  const now = Date.now(), twoHoursBehind = 2 * 3600 * 1000;
  const r = await push([session("s1", "v1", { startTs: now - 10 * 60000 - twoHoursBehind, endTs: now - 5 * 60000 - twoHoursBehind })], { clientNow: now - twoHoursBehind });
  assert.ok(Math.abs(r.json().skewMs - twoHoursBehind) < 5000, "skew measured ~2h");
  const [s] = await sessionsOf();
  assert.ok(Math.abs(s.startTsAdj - (now - 10 * 60000)) < 5000, "start moved onto the server clock");
  assert.equal(s.startTs, now - 10 * 60000 - twoHoursBehind, "the raw device time is kept too");
  const d = (await app.inject({ method: "GET", url: "/api/devices", headers: { cookie: A } })).json()[0];
  assert.ok(Math.abs(d.clock_skew_ms - twoHoursBehind) < 5000);
  assert.ok(db.prepare("SELECT start_ts_adj FROM sessions").get().start_ts_adj > now - 15 * 60000, "indexed by corrected time");
});

test("small clock differences (latency) are ignored; absurd clocks are not trusted", async () => {
  const { push } = await setup();
  const now = Date.now();
  assert.equal((await push([], { clientNow: now - 30000 })).json().skewMs, 0);
  assert.equal((await push([], { clientNow: 1 })).json().skewMs, 0, "a device claiming 1970 is not used to shift data");
  assert.equal((await push([], { clientNow: "garbage" })).json().skewMs, 0);
});

test("two devices with different clocks land in the right order on the server's clock", async () => {
  const { app, A, dev, push, sessionsOf } = await setup();
  const dev2 = await enrollDevice(app, A, "Ahead");
  const now = Date.now(), ahead = 3 * 3600 * 1000;
  // real order: laptop 1 watched 20 min ago, laptop 2 (clock 3 h fast) watched 5 min ago
  await push([session("a", "v1", { startTs: now - 20 * 60000 })], { clientNow: now });
  await push([session("b", "v2", { startTs: now - 5 * 60000 + ahead })], { clientNow: now + ahead }, dev2);
  const hist = (await app.inject({ method: "GET", url: "/api/history", headers: { cookie: A } })).json().items;
  assert.deepEqual(hist.map(i => i.sessionId), ["b", "a"], "newest first on the corrected clock");
  assert.ok(Math.abs(hist[0].startTs - (now - 5 * 60000)) < 5000);
});

test("devices report their sync status: pending uploads, last error, version, last push", async () => {
  const { app, A, push } = await setup();
  await push([], { pending: 7, lastError: "push 503", clientVersion: "0.4.0" });
  const d = (await app.inject({ method: "GET", url: "/api/devices", headers: { cookie: A } })).json()[0];
  assert.deepEqual([d.pending_count, d.last_error, d.client_version], [7, "push 503", "0.4.0"]);
  assert.ok(d.last_push_at > 0);
  await push([], { pending: 0 });
  const d2 = (await app.inject({ method: "GET", url: "/api/devices", headers: { cookie: A } })).json()[0];
  assert.deepEqual([d2.pending_count, d2.last_error], [0, null], "a clean push clears the error");
});

test("watch data is encrypted at rest", async () => {
  const { db, push } = await setup();
  await push([session("s1", "vid1", { title: "Very Secret Title", url: "https://www.youtube.com/watch?v=vid1" })]);
  for (const t of ["sessions", "videos"]) {
    const enc = db.prepare(`SELECT enc FROM ${t}`).get().enc;
    assert.ok(Buffer.isBuffer(enc));
    assert.equal(enc.includes("Very Secret Title"), false, t + " blob has no plaintext title");
    assert.equal(enc.includes("youtube.com"), false, t + " blob has no plaintext url");
  }
  assert.equal(db.prepare("SELECT video_id FROM sessions").get().video_id, "vid1");
});

test("invalid sessions are dropped and oversized batches rejected", async () => {
  const { app, dev, db, push } = await setup();
  const r = await push([session("ok", "v1"), { sessionId: "x" }, null, session("bad id!", "v1"), session("s", "bad video!")]);
  assert.equal(r.json().upserted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
  assert.equal((await push(Array.from({ length: 501 }, (_, i) => session("s" + i, "v1")))).statusCode, 413);
  assert.equal((await app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions: "x" } })).statusCode, 400);
});

test("push stores only whitelisted, bounded fields, and only canonical YouTube urls", async () => {
  const { push, sessionsOf } = await setup();
  await push([session("s1", "v1", { title: "t".repeat(1000), extra: "should not persist", cookie: "nope", url: "javascript:alert(1)" }),
    session("s2", "v2", { url: "https://evil.example/watch?v=v2" }), session("s3", "v3", { url: "https://www.youtube.com/watch?v=v3" }),
    session("s4", "v4", { url: "https://www.youtube.com/shorts/v4", kind: "shorts" })]);
  const byId = Object.fromEntries((await sessionsOf()).map(s => [s.sessionId, s]));
  assert.equal(byId.s1.title.length, 300);
  assert.equal("extra" in byId.s1, false);
  assert.equal("cookie" in byId.s1, false);
  assert.equal(byId.s1.url, "", "javascript: url dropped");
  assert.equal(byId.s2.url, "", "non-YouTube url dropped");
  assert.equal(byId.s3.url, "https://www.youtube.com/watch?v=v3");
  assert.equal(byId.s4.kind, "shorts");
});

test("device-initiated unenroll revokes the device and is audited", async () => {
  const { app, A, dev, push } = await setup();
  assert.equal((await app.inject({ method: "POST", url: "/api/sync/unenroll", headers: dev.auth, payload: {} })).statusCode, 200);
  assert.equal((await push([session("s1", "v1")])).statusCode, 403);
  const actions = (await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: A } })).json().map(r => r.action);
  assert.ok(actions.includes("device_unenrolled"));
  assert.equal((await app.inject({ method: "GET", url: "/api/devices", headers: { cookie: A } })).json()[0].status, "revoked");
});

test("push updates the device's last_seen", async () => {
  const { db, dev, push } = await setup();
  db.prepare("UPDATE devices SET last_seen=1 WHERE id=?").run(dev.deviceId);
  await push([]);
  assert.ok(db.prepare("SELECT last_seen FROM devices WHERE id=?").get(dev.deviceId).last_seen > 1);
});
