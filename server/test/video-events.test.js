import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeApp, addOwner, login, enrollDevice, session, allowLiveView } from "./helpers.js";
import { openDb, migrate } from "../src/db.js";
import { decryptJSON } from "../src/lib/crypto.js";
import { purgeDevice } from "../src/lib/retention.js";

const require = createRequire(import.meta.url);
const P = require("../src/lib/playback.cjs");
const S = 1000;

// Drive the real recorder with a scripted player and return the events it would send.
function script(fn, { sessionId = "sess1", videoId = "vid1", start = Date.now() - 3600 * S, duration = 600 } = {}) {
  const rec = P.createRecorder({ sessionId, videoId });
  const p = { t: start, pos: 0, paused: true };
  const events = [];
  const feed = hint => events.push(...rec.observe({ pos: p.pos, rate: 1, paused: p.paused, duration }, p.t, hint));
  const v = {
    play() { p.paused = false; feed("play"); return v; }, pause() { p.paused = true; feed("pause"); return v; },
    wait(s) { if (!p.paused) p.pos += s; p.t += s * S; return v; },
    stop(reason) { events.push(...rec.end(p.t, reason || "navigation", { pos: p.pos })); return v; }, events, rec, p
  };
  fn(v);
  return events;
}

async function setup() {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev = await enrollDevice(app, A);
  const send = (events, extra = {}, d = dev) => app.inject({ method: "POST", url: "/api/sync/events", headers: d.auth, payload: { events, ...extra } });
  const pauses = (d = dev, sid = "sess1") => db.prepare("SELECT * FROM video_pause_intervals WHERE device_id=? AND session_id=? ORDER BY n").all(d.deviceId, sid);
  return { app, db, A, dev, send, pauses };
}

test("events are stored, acknowledged, and folded into sessions, pause intervals and segments", async () => {
  const { db, dev, send, pauses } = await setup();
  const evs = script(v => v.play().wait(60).pause().wait(150).play().wait(20).stop());
  const r = await send(evs);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().acked, evs.map(e => e.id));
  assert.deepEqual(r.json().rejected, []);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_playback_events").get().n, 4);
  const [p] = pauses();
  assert.deepEqual([p.n, p.status, p.duration_ms], [1, "resumed", 150 * S]);
  assert.equal(p.resumed_at - p.paused_at, 150 * S);
  const vs = db.prepare("SELECT * FROM video_sessions").get();
  assert.deepEqual([vs.state, vs.event_count, vs.completed], ["ended", 4, 0]);
  const m = decryptJSON(vs.enc);
  assert.deepEqual([m.activeMs, m.pausedMs, m.pauseCount, m.resumeCount], [80 * S, 150 * S, 1, 1]);
  const an = decryptJSON(db.prepare("SELECT enc FROM video_analytics WHERE video_id='vid1'").get().enc);
  assert.deepEqual([an.sessions, an.activeMs, an.uniqueContentSec], [1, 80 * S, 80]);
  assert.ok(db.prepare("SELECT last_events_at FROM devices WHERE id=?").get(dev.deviceId).last_events_at > 0);
});

test("event payloads are encrypted at rest", async () => {
  const { db, send } = await setup();
  await send(script(v => v.play().wait(1234).pause()));
  const raw = Buffer.concat(db.prepare("SELECT enc FROM video_playback_events").all().map(r => r.enc));
  assert.equal(raw.includes(Buffer.from("1234")), false);
  assert.equal(raw.includes(Buffer.from('"pos"')), false);
  const first = db.prepare("SELECT * FROM video_playback_events ORDER BY seq").get();
  assert.equal(decryptJSON(first.enc).next, "playing");
});

test("re-sending events is idempotent: no duplicates, still acknowledged, derived data unchanged", async () => {
  const { db, send, pauses } = await setup();
  const evs = script(v => v.play().wait(10).pause().wait(5).play().wait(5).stop());
  await send(evs);
  const before = JSON.stringify(pauses());
  const again = await send(evs);
  assert.deepEqual(again.json().acked, evs.map(e => e.id));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_playback_events").get().n, evs.length);
  assert.equal(JSON.stringify(pauses()), before);
  const overlap = await send(evs.slice(2)); // a retry of a partly delivered batch
  assert.equal(overlap.statusCode, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_playback_events").get().n, evs.length);
});

test("ten pause/resume cycles survive intact end to end, whatever the delivery order or batching", async () => {
  const { db, send, pauses } = await setup();
  const evs = script(v => { v.play(); for (let i = 1; i <= 10; i++) v.wait(20).pause().wait(i * 3).play(); v.wait(5).stop(); });
  assert.equal(evs.length, 1 + 20 + 1);
  await send(evs.slice(10).reverse());      // later events first (an offline queue replayed out of order)
  await send(evs.slice(0, 10));
  const ps = pauses();
  assert.deepEqual(ps.map(p => p.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(ps.map(p => p.duration_ms / S), [3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
  assert.ok(ps.every(p => p.status === "resumed"));
  const m = decryptJSON(db.prepare("SELECT enc FROM video_sessions").get().enc);
  assert.deepEqual([m.pauseCount, m.resumeCount, m.pausedMs, m.activeMs], [10, 10, 165 * S, 205 * S]);
});

test("a session that ends without a resume is closed at its end time; an interrupted one stays unresolved", async () => {
  const { db, dev, send, pauses } = await setup();
  await send(script(v => v.play().wait(30).pause().wait(90).stop("pagehide")));
  assert.deepEqual(pauses().map(p => [p.status, p.duration_ms]), [["session_ended", 90 * S]]);

  const s3 = (() => {
    const r = P.createRecorder({ sessionId: "sess3", videoId: "vid1" });
    const t0 = Date.now() - 1000 * S, out = [];
    out.push(...r.observe({ pos: 0, rate: 1, paused: false, duration: 600 }, t0));
    out.push(...r.observe({ pos: 30, rate: 1, paused: true, duration: 600 }, t0 + 30 * S));
    r.heartbeat(t0 + 70 * S, 30);
    out.push(P.interruptedEvent(r.snapshot(), t0 + 70 * S));
    return out;
  })();
  await send(s3);
  const unresolved = pauses(dev, "sess3");
  assert.deepEqual([unresolved[0].status, unresolved[0].resumed_at, unresolved[0].duration_ms], ["unresolved", null, null]);
  assert.equal(decryptJSON(unresolved[0].enc).minDurationMs, 40 * S);
  assert.equal(db.prepare("SELECT state FROM video_sessions WHERE session_id='sess3'").get().state, "interrupted");
});

test("validation: forged, malformed and oversized input is refused without storing anything", async () => {
  const { db, send } = await setup();
  const good = script(v => v.play().wait(5).pause())[0];
  assert.equal((await send("nope")).statusCode, 400);
  assert.equal((await send(Array.from({ length: 201 }, () => good))).statusCode, 413);
  const bad = [
    { ...good, id: "sess1:e9", seq: 1 },                         // id does not match seq
    { ...good, type: "VIDEO_DELETE_EVERYTHING", id: "sess1:e2", seq: 2 },
    { ...good, id: "sess1:e3", seq: 3, ts: Date.now() + 30 * 86400000 },
    { ...good, id: "sess1:e4", seq: 4, rate: 50 },
    { ...good, id: "../../x:e5", seq: 5, sessionId: "../../x" },
    { ...good, id: "sess1:e6", seq: 6, pos: "abc" },
    null, 7, "x"
  ];
  const r = await send(bad);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().acked, []);
  assert.ok(r.json().rejected.includes("sess1:e9") && r.json().rejected.includes("sess1:e2"));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_playback_events").get().n, 0);
});

test("stored fields are whitelisted: unknown metadata never reaches the database", async () => {
  const { db, send } = await setup();
  const e = script(v => v.play())[0];
  await send([{ ...e, meta: { reason: "user", title: "<script>x</script>", from: 3 }, note: "hi" }]);
  const row = db.prepare("SELECT enc FROM video_playback_events").get();
  assert.deepEqual(decryptJSON(row.enc).meta, { reason: "user", from: 3 });
});

test("a session may not exceed the per-session event cap", async () => {
  const { db, send } = await setup();
  const mk = (a, b) => Array.from({ length: b - a }, (_, i) => {
    const seq = a + i + 1;
    return { id: `big:e${seq}`, sessionId: "big", videoId: "vid1", seq, type: seq % 2 ? "VIDEO_PAUSED" : "VIDEO_RESUMED", ts: Date.now() - 1e6 + seq, pos: 1, rate: 1, prev: "none", next: "none", meta: {} };
  });
  for (let a = 0; a < 5000; a += 200) assert.equal((await send(mk(a, a + 200))).statusCode, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_playback_events").get().n, 5000);
  const over = (await send(mk(5000, 5010))).json();
  assert.deepEqual([over.acked.length, over.rejected.length], [0, 10]);
});

test("authorization: no token, revoked device and pending device cannot post events", async () => {
  const { app, A, send, dev, db } = await setup();
  const evs = script(v => v.play());
  assert.equal((await app.inject({ method: "POST", url: "/api/sync/events", payload: { events: evs } })).statusCode, 401);
  const pending = await enrollDevice(app, A, "Pending one", { approve: false });
  assert.equal((await app.inject({ method: "POST", url: "/api/sync/events", payload: { events: evs }, headers: pending.auth })).statusCode, 403);   // pending_approval
  const rev = await app.inject({ method: "POST", url: `/api/devices/${dev.deviceId}/revoke`, headers: { cookie: A } });
  assert.equal(rev.statusCode, 200);
  assert.equal((await send(evs)).statusCode, 403);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_playback_events").get().n, 0);
  // an owner cookie is not a device credential
  assert.equal((await app.inject({ method: "POST", url: "/api/sync/events", payload: { events: evs }, headers: { cookie: A } })).statusCode, 401);
});

test("events are attributed to the authenticated device, never to a device named in the payload", async () => {
  const { app, A, db, dev, send } = await setup();
  const other = await enrollDevice(app, A, "Other");
  const evs = script(v => v.play().wait(5).pause()).map(e => ({ ...e, deviceId: other.deviceId, device_id: other.deviceId }));
  await send(evs);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_playback_events WHERE device_id=?").get(other.deviceId).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_playback_events WHERE device_id=?").get(dev.deviceId).n, 2);
});

test("two devices with the same session id stay separate", async () => {
  const { app, A, db, dev, send } = await setup();
  const other = await enrollDevice(app, A, "Other");
  await send(script(v => v.play().wait(5).pause()));
  await send(script(v => v.play().wait(9).pause().wait(2).play()), {}, other);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_sessions").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_pause_intervals WHERE device_id=?").get(dev.deviceId).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_playback_events WHERE device_id=?").get(other.deviceId).n, 3);
});

test("clock skew: ts keeps the device time for durations, ts_adj puts it on the server clock", async () => {
  const { db, send, pauses } = await setup();
  const behind = 2 * 3600 * S, now = Date.now();
  const evs = script(v => v.play().wait(30).pause().wait(60).play().stop(), { start: now - behind - 600 * S });
  const r = await send(evs, { clientNow: now - behind });
  assert.ok(Math.abs(r.json().skewMs - behind) < 5000);
  const row = db.prepare("SELECT ts, ts_adj FROM video_playback_events ORDER BY seq").get();
  assert.ok(Math.abs(row.ts_adj - row.ts - behind) < 5000);
  assert.equal(pauses()[0].duration_ms, 60 * S);             // a duration is never distorted by the offset
  assert.ok(Math.abs(pauses()[0].paused_at - (now - 600 * S + 30 * S)) < 5000);
});

test("the owner's open pages are told about new events, and only about new ones", async () => {
  const { app, db, dev, send } = await setup();
  await allowLiveView(app, dev);
  const admin = db.prepare("SELECT admin_id FROM devices WHERE id=?").get(dev.deviceId).admin_id;
  const got = [];
  const unsub = app.hub.subscribeAdmin(admin, (type, data) => got.push([type, data]));
  const evs = script(v => v.play().wait(5).pause());
  await send(evs);
  await send(evs);
  unsub();
  const ve = got.filter(g => g[0] === "video_event");
  assert.equal(ve.length, 1, "the replay produced no second notification");
  assert.deepEqual(ve[0][1].events.map(e => e.type), ["VIDEO_STARTED", "VIDEO_PAUSED"]);
  assert.equal(ve[0][1].deviceId, dev.deviceId); assert.equal(ve[0][1].videoId, "vid1");
});

test("sessions may carry a channel link, validated against YouTube's own URL shapes", async () => {
  const { app, dev } = await setup();
  const push = s => app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions: [s] } });
  const ok = await push(session("c1", "vid1", { channelUrl: "https://www.youtube.com/@SomeChannel", channelId: "UC" + "a".repeat(22) }));
  assert.equal(ok.statusCode, 200);
  const evil = await push(session("c2", "vid1", { channelUrl: "javascript:alert(1)", channelId: "<x>" }));
  assert.equal(evil.statusCode, 200);
});

test("deleting server data for a period, and retention, remove the event history of those sessions only", async () => {
  const { db, dev, send, A, app } = await setup();
  await send(script(v => v.play().wait(5).pause(), { sessionId: "old1", start: Date.now() - 100 * 86400000 }));
  await send(script(v => v.play().wait(5).pause(), { sessionId: "new1", start: Date.now() - 600 * S }));
  await app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions: [session("old1", "vid1", { startTs: Date.now() - 100 * 86400000 }), session("new1", "vid1", { startTs: Date.now() - 600 * S })] } });
  db.prepare("UPDATE devices SET retention_days=30 WHERE id=?").run(dev.deviceId);
  purgeDevice(db, dev.deviceId);
  assert.deepEqual(db.prepare("SELECT DISTINCT session_id FROM video_playback_events").all().map(r => r.session_id), ["new1"]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_sessions").get().n, 1);
  const del = await app.inject({ method: "POST", url: "/api/data/delete", headers: { cookie: A }, payload: { confirm: true } });
  assert.equal(del.statusCode, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_playback_events").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_analytics").get().n, 0);
});

test("migration 006 is additive: a database at v0.6.0 with data upgrades with every row intact", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const db = openDb();
  db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort().filter(f => f < "006")) {
    db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(f, 1);
  }
  db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES('a','o@x.test','h',1)").run();
  db.prepare("INSERT INTO devices(id,admin_id,label,enrolled_at) VALUES('d','a','Laptop',1)").run();
  db.prepare("INSERT INTO sessions(device_id,session_id,enc,video_id,start_ts,start_ts_adj,rev,updated_at) VALUES('d','s1',x'00','v1',5,5,2,9)").run();
  db.prepare("INSERT INTO videos(device_id,video_id,enc,last_watched,updated_at) VALUES('d','v1',x'00',7,9)").run();
  const before = { sessions: db.prepare("SELECT * FROM sessions").all(), videos: db.prepare("SELECT * FROM videos").all(), devices: db.prepare("SELECT * FROM devices").all() };
  assert.deepEqual(migrate(db, { upTo: "006_video_events.sql" }), ["006_video_events.sql"]);
  assert.deepEqual(db.prepare("SELECT * FROM sessions").all(), before.sessions);
  assert.deepEqual(db.prepare("SELECT * FROM videos").all(), before.videos);
  const dev = db.prepare("SELECT * FROM devices").get();
  assert.equal(dev.last_events_at, null);
  assert.deepEqual({ ...dev, last_events_at: undefined }, { ...before.devices[0], last_events_at: undefined });
  for (const t of ["video_playback_events", "video_sessions", "video_pause_intervals", "video_watch_segments", "video_analytics"]) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0);
  assert.deepEqual(migrate(db, { upTo: "006_video_events.sql" }), [], "running it again changes nothing");
  // an old session has no event history and none is invented for it
  assert.equal(db.prepare("SELECT COUNT(*) n FROM video_sessions WHERE session_id='s1'").get().n, 0);
});
