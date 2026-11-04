// Migration 007 (v0.8.0-beta.1): device consent states, queue figures and the sync error history.
// It must be additive and backward compatible: a database exactly as v0.7.0 left it, with data, upgrades with every row intact,
// and a v0.7.0 extension (which reports none of the new fields) keeps working and is never treated as having consented to anything.
import "./env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, migrate } from "../src/db.js";
import { makeApp, addOwner, login, enrollDevice, session, allowLiveView } from "./helpers.js";

const V070 = "006_video_events.sql";
const ALL = ["video_playback_events", "video_sessions", "video_pause_intervals", "video_watch_segments", "video_analytics", "sessions", "videos", "audit_log", "device_sessions", "device_config"];
const rows = (db, t) => db.prepare(`SELECT * FROM ${t}`).all();

function v070db() {
  const db = openDb();
  assert.equal(migrate(db, { upTo: V070 }).length, 6, "six migrations make a v0.7.0 database");
  db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES('a','o@x.test','h',1)").run();
  db.prepare("INSERT INTO devices(id,admin_id,label,platform,enrolled_at,client_version,last_push_at) VALUES('d1','a','Laptop','Win',1,'0.7.0',50)").run();
  db.prepare("INSERT INTO devices(id,admin_id,label,enrolled_at,status) VALUES('d2','a','Old PC',2,'revoked')").run();
  db.prepare("INSERT INTO sessions(device_id,session_id,enc,video_id,start_ts,start_ts_adj,rev,updated_at) VALUES('d1','s1',x'00','v1',5,5,2,9)").run();
  db.prepare("INSERT INTO videos(device_id,video_id,enc,last_watched,updated_at) VALUES('d1','v1',x'00',7,9)").run();
  db.prepare("INSERT INTO audit_log(id,admin_id,device_id,action,created_at) VALUES('x','a','d1','approve',3)").run();
  db.prepare("INSERT INTO video_playback_events(device_id,id,session_id,video_id,type,seq,ts,ts_adj,enc,received_at) VALUES('d1','s1:e1','s1','v1','VIDEO_STARTED',1,5,5,x'00',6)").run();
  return db;
}

test("007 is additive: every v0.7.0 row survives unchanged and the new columns take their safe defaults", () => {
  const db = v070db();
  const before = Object.fromEntries(ALL.map(t => [t, rows(db, t)])), devBefore = rows(db, "devices");
  assert.deepEqual(migrate(db, { upTo: "007_device_consents_sync_diagnostics.sql" }), ["007_device_consents_sync_diagnostics.sql"]);
  for (const t of ALL) assert.deepEqual(rows(db, t), before[t], t + " is untouched");
  for (const old of devBefore) {
    const now = db.prepare("SELECT * FROM devices WHERE id=?").get(old.id);
    for (const k of Object.keys(old)) assert.deepEqual(now[k], old[k], `devices.${k} of ${old.id}`);
    assert.equal(now.live_view, 0, "nobody is treated as having allowed live viewing");
    assert.equal(now.consent_tracking, null); assert.equal(now.consent_detail, null);
    assert.equal(now.queue_events, 0); assert.equal(now.queue_dropped, 0);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_sync_errors").get().n, 0);
  assert.deepEqual(migrate(db, { upTo: "007_device_consents_sync_diagnostics.sql" }), [], "running it again changes nothing");
});

test("007: the error history is removed with its device, and is keyed by time for fast reads", () => {
  const db = v070db(); migrate(db);
  db.prepare("INSERT INTO device_sync_errors(device_id,at,kind,message) VALUES('d1',10,'network','offline')").run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_sync_errors").get().n, 1);
  db.prepare("DELETE FROM devices WHERE id='d1'").run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_sync_errors").get().n, 0, "cascade");
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_dse_device_time'").get());
});

async function setup() {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev = await enrollDevice(app, A, "Laptop");
  const get = url => app.inject({ method: "GET", url, headers: { cookie: A } });
  const push = payload => app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload });
  return { app, db, A, dev, get, push };
}

test("a v0.7.0 extension (reports no consents) keeps syncing and is never treated as having allowed live viewing", async () => {
  const { push, get, db, dev } = await setup();
  const r = await push({ sessions: [session("s1", "vidA")], clientNow: Date.now(), pending: 0, clientVersion: "0.7.0" });
  assert.equal(r.statusCode, 200);
  const d = db.prepare("SELECT live_view,consent_tracking,consent_detail FROM devices WHERE id=?").get(dev.deviceId);
  assert.deepEqual({ ...d }, { live_view: 0, consent_tracking: null, consent_detail: null });
  const list = (await get("/api/devices")).json();
  assert.equal(list[0].live_view, 0); assert.equal(list[0].consent_tracking, null);
});

test("consents are recorded as reported, only booleans count, and a change is written to the audit log", async () => {
  const { push, db, dev } = await setup();
  await push({ sessions: [], consents: { liveView: true, tracking: false, detail: true } });
  let d = db.prepare("SELECT live_view,live_view_at,consent_tracking,consent_detail FROM devices WHERE id=?").get(dev.deviceId);
  assert.equal(d.live_view, 1); assert.ok(d.live_view_at > 0); assert.equal(d.consent_tracking, 0); assert.equal(d.consent_detail, 1);
  const at = d.live_view_at;
  await push({ sessions: [], consents: { liveView: true } });
  assert.equal(db.prepare("SELECT live_view_at FROM devices WHERE id=?").get(dev.deviceId).live_view_at, at, "no change, no new timestamp");
  await push({ sessions: [], consents: { liveView: "yes", tracking: 1, detail: null } });   // not booleans: ignored
  d = db.prepare("SELECT live_view,consent_tracking,consent_detail FROM devices WHERE id=?").get(dev.deviceId);
  assert.deepEqual({ ...d }, { live_view: 1, consent_tracking: 0, consent_detail: 1 });
  await push({ sessions: [], consents: { liveView: false } });
  assert.equal(db.prepare("SELECT live_view FROM devices WHERE id=?").get(dev.deviceId).live_view, 0);
  const acts = db.prepare("SELECT action,detail FROM audit_log WHERE device_id=? AND action LIKE 'device_live_view%' ORDER BY created_at").all(dev.deviceId).map(r => r.action);
  assert.deepEqual(acts, ["device_live_view_on", "device_live_view_off"]);
});

test("the owner cannot switch a device's consent: no owner route accepts it", async () => {
  const { app, A, db, dev } = await setup();
  for (const [method, url, payload] of [["PATCH", `/api/devices/${dev.deviceId}`, { label: "X", live_view: 1 }], ["POST", `/api/devices/${dev.deviceId}/commands`, { type: "enable_live_view" }], ["PUT", "/api/settings", { server_retention_days: 0, live_view: 1 }]]) {
    await app.inject({ method, url, headers: { cookie: A }, payload });
  }
  assert.equal(db.prepare("SELECT live_view FROM devices WHERE id=?").get(dev.deviceId).live_view, 0);
});

test("live viewing is gated: with it off the owner gets no stream and no current state; with it on, both", async () => {
  const { app, db, dev, A } = await setup();
  const admin = db.prepare("SELECT admin_id FROM devices WHERE id=?").get(dev.deviceId).admin_id, got = [];
  app.hub.subscribeAdmin(admin, (type, data) => { if (type === "video_event") got.push(data); });
  const ev = n => ({ id: `lv:e${n}`, sessionId: "lv", videoId: "vidLive", seq: n, type: n === 1 ? "VIDEO_STARTED" : "VIDEO_PAUSED", ts: Date.now() - 5000 + n, pos: n, rate: 1, prev: n === 1 ? "none" : "playing", next: n === 1 ? "playing" : "paused", meta: {} });
  const send = events => app.inject({ method: "POST", url: "/api/sync/events", headers: dev.auth, payload: { events } });
  await send([ev(1)]);
  assert.equal(got.length, 0, "live view is off: no real-time notification");
  app.hub.subscribeDevice(dev.deviceId, { sessionId: dev.sessionId, send() {}, close() {} });
  const live = (await app.inject({ method: "GET", url: "/api/video/vidLive/live", headers: { cookie: A } })).json();
  assert.equal(live.current.liveView, false); assert.equal(live.current.session, null); assert.equal(live.status, "idle");
  const detail = (await app.inject({ method: "GET", url: "/api/video/vidLive", headers: { cookie: A } })).json();
  assert.equal(detail.devices[0].liveView, false);
  await allowLiveView(app, dev);
  await send([ev(2)]);
  assert.equal(got.length, 1, "live view is on: the event is streamed");
  const live2 = (await app.inject({ method: "GET", url: "/api/video/vidLive/live", headers: { cookie: A } })).json();
  assert.equal(live2.current.liveView, true); assert.equal(live2.current.session.state, "paused");
});

test("a device can only ever report its own state; hostile values are clamped, truncated or ignored", async () => {
  const { app, db, A, dev: d1 } = await setup();
  const d2 = await enrollDevice(app, A, "Second");
  const push = (d, payload) => app.inject({ method: "POST", url: "/api/sync/push", headers: d.auth, payload });
  await push(d1, { sessions: [], consents: { liveView: true } });
  await push(d2, { sessions: [], consents: { liveView: false }, deviceId: d1.deviceId, device_id: d1.deviceId });   // naming another device changes nothing
  const live = id => db.prepare("SELECT live_view FROM devices WHERE id=?").get(id).live_view;
  assert.equal(live(d1.deviceId), 1, "the second device cannot turn the first one off"); assert.equal(live(d2.deviceId), 0);
  await push(d1, { sessions: [], queue: { events: -5, dropped: 1e99 }, lastError: "<img src=x onerror=alert(1)>" + "x".repeat(900), lastErrorKind: "<script>" });
  const row = db.prepare("SELECT queue_events,queue_dropped FROM devices WHERE id=?").get(d1.deviceId);
  assert.deepEqual({ ...row }, { queue_events: 0, queue_dropped: 1e7 }, "negative and absurd counts are clamped");
  const err = db.prepare("SELECT kind,message FROM device_sync_errors WHERE device_id=?").get(d1.deviceId);
  assert.equal(err.kind, "other"); assert.ok(err.message.length <= 300, "message truncated");
  for (const bad of [{ consents: "yes" }, { consents: [1, 2] }, { consents: { liveView: { $gt: 0 } } }, { queue: "many" }, { consents: null }]) assert.equal((await push(d1, { sessions: [], ...bad })).statusCode, 200, "junk is ignored, never an error: " + JSON.stringify(bad));
  assert.equal(live(d1.deviceId), 1, "and never changes the stored consent");
  const r = await app.inject({ method: "POST", url: "/api/sync/push", headers: { authorization: "Bearer nope" }, payload: { sessions: [], consents: { liveView: true } } });
  assert.ok(r.statusCode === 401 || r.statusCode === 403, "an unauthenticated caller cannot report consent");
});
