// End-to-end: a simulated extension (the REAL background.js, lib/db.js, lib/sync.js, lib/playback.js) records playback events,
// queues them offline and delivers them to the REAL server over HTTP: offline queue, reconnection, duplicates, restarts,
// privacy gates, crash recovery and live delivery to the owner's dashboard.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { makeApp, addOwner, login } from "./helpers.js";
import { makeDevice } from "./device-harness.js";
import { decryptJSON } from "../src/lib/crypto.js";

const require = createRequire(import.meta.url);
const P = require("../src/lib/playback.cjs");
const S = 1000;

let ctx, server, A;
before(async () => {
  ctx = await makeApp();
  await addOwner(ctx.db);
  A = await login(ctx.app);
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  server = "http://127.0.0.1:" + ctx.app.server.address().port;
});
after(async () => { await ctx.app.close(); });

const owner = (method, url, payload) => ctx.app.inject({ method, url, headers: { cookie: A }, payload });
let n = 0;
async function pairedDevice(name = "dev" + ++n) {
  const d = makeDevice({ server, name });
  const code = (await owner("POST", "/api/devices/enroll-code", { label: name })).json().code;
  const j = await d.pair(code);
  d.id = j.deviceId;
  await d.sync();
  return d;
}
// Events exactly as the recorder produces them for a scripted viewing.
function viewing(sessionId, fn, { videoId = "vidA", start = Date.now() - 600 * S, duration = 600 } = {}) {
  const rec = P.createRecorder({ sessionId, videoId });
  const p = { t: start, pos: 0, paused: true }, events = [];
  const feed = hint => events.push(...rec.observe({ pos: p.pos, rate: 1, paused: p.paused, duration }, p.t, hint));
  const v = {
    play() { p.paused = false; feed("play"); return v; }, pause() { p.paused = true; feed("pause"); return v; },
    wait(s) { if (!p.paused) p.pos += s; p.t += s * S; return v; },
    stop(r) { events.push(...rec.end(p.t, r || "navigation", { pos: p.pos })); return v; }, events, rec, p
  };
  fn(v);
  return events;
}
const serverEvents = (d, sid) => ctx.db.prepare("SELECT id,type,seq FROM video_playback_events WHERE device_id=? AND session_id=? ORDER BY seq").all(d.id, sid);

test("a paired device's events reach the server in about one request, and are removed from its queue only once acknowledged", async () => {
  const d = await pairedDevice();
  const evs = viewing("e2e1", v => v.play().wait(30).pause().wait(60).play().wait(10).stop());
  assert.equal(evs.length, 4);
  assert.equal((await d.videoEvents(evs)).stored, 4);
  assert.equal((await d.evOutbox()).length, 4);
  const r = await d.pushEvents();
  assert.equal(r.sent, 4);
  assert.equal((await d.evOutbox()).length, 0);
  assert.deepEqual(serverEvents(d, "e2e1").map(e => e.type), ["VIDEO_STARTED", "VIDEO_PAUSED", "VIDEO_RESUMED", "VIDEO_SESSION_ENDED"]);
  assert.equal(ctx.db.prepare("SELECT duration_ms FROM video_pause_intervals WHERE device_id=?").get(d.id).duration_ms, 60 * S);
  assert.equal((await d.localEvents("e2e1")).length, 4, "the device keeps its own history after upload");
  assert.ok((await d.cfg()).sync_last_ok > 0, "last successful sync is recorded");
});

test("offline: events queue in order, uploads fail safely, and everything arrives once the connection returns", async () => {
  const d = await pairedDevice();
  d.net.offline = true;
  await d.videoEvents(viewing("off1", v => v.play().wait(20).pause().wait(5).play().wait(20).pause()));
  const r = await d.pushEvents();
  assert.equal(r.ok, false);
  assert.equal((await d.evOutbox()).length, 4);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM video_playback_events WHERE device_id=?").get(d.id).n, 0);
  // more activity while still offline, in a second session
  await d.videoEvents(viewing("off2", v => v.play().wait(5).pause(), { videoId: "vidB" }));
  assert.equal((await d.evOutbox()).length, 6);
  d.net.offline = false;
  assert.equal((await d.pushEvents()).sent, 6);
  assert.deepEqual(serverEvents(d, "off1").map(e => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(serverEvents(d, "off2").map(e => e.seq), [1, 2]);
  assert.equal((await d.evOutbox()).length, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM video_pause_intervals WHERE device_id=? AND session_id='off1'").get(d.id).n, 2);
});

test("a lost acknowledgement does not duplicate: the retry is acknowledged and the queue drains", async () => {
  const d = await pairedDevice();
  await d.videoEvents(viewing("lost1", v => v.play().wait(10).pause().wait(10).play()));
  d.net.loseEventResponses = 1;                       // the server stores the batch, the device never sees the answer
  assert.equal((await d.pushEvents()).ok, false);
  assert.equal((await d.evOutbox()).length, 3, "still queued, because nothing was acknowledged");
  assert.equal(serverEvents(d, "lost1").length, 3, "but the server has them");
  assert.equal((await d.pushEvents()).sent, 3);       // resend: acknowledged, not stored twice
  assert.equal(serverEvents(d, "lost1").length, 3);
  assert.equal((await d.evOutbox()).length, 0);
});

test("a browser restart with events still queued loses nothing and keeps their order", async () => {
  const d = await pairedDevice();
  d.net.offline = true;
  await d.videoEvents(viewing("rst1", v => v.play().wait(10).pause().wait(10).play().wait(3).pause()));
  await d.pushEvents();
  await d.restart();
  d.net.offline = false;
  assert.equal((await d.evOutbox()).length, 4);
  assert.equal((await d.pushEvents()).sent, 4);
  assert.deepEqual(serverEvents(d, "rst1").map(e => e.seq), [1, 2, 3, 4]);
});

test("a server that predates 0.7 leaves the events queued instead of dropping them", async () => {
  const d = await pairedDevice();
  await d.videoEvents(viewing("old1", v => v.play().wait(5).pause()));
  d.net.mock["/api/sync/events"] = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  const r = await d.pushEvents();
  assert.equal(r.unsupported, true);
  assert.equal((await d.evOutbox()).length, 2);
  delete d.net.mock["/api/sync/events"];
  assert.equal((await d.pushEvents()).sent, 2);
});

test("an unpaired device records events locally and queues nothing; pairing later uploads only on request", async () => {
  const d = makeDevice({ server, name: "unpaired" });
  await d.videoEvents(viewing("loc1", v => v.play().wait(5).pause()));
  assert.equal((await d.localEvents("loc1")).length, 2);
  assert.equal((await d.evOutbox()).length, 0);
  assert.equal((await d.pushEvents()).skipped, true);
  const code = (await owner("POST", "/api/devices/enroll-code", { label: "later" })).json().code;
  const j = await d.pair(code);                                         // default: history before pairing stays on the device
  assert.equal((await d.evOutbox()).length, 0);
  await d.sync();
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM video_playback_events WHERE device_id=?").get(j.deviceId).n, 0);
});

test("tracking paused: no new events are stored, only the marker that closes a viewing in progress", async () => {
  const d = await pairedDevice();
  d.store.tracking_enabled = false;
  const evs = viewing("trk1", v => v.play().wait(5).pause().wait(2).stop("tracking_off"));
  const r = await d.videoEvents(evs);
  assert.equal(r.stored, 1);
  assert.deepEqual((await d.localEvents("trk1")).map(e => e.type), ["VIDEO_SESSION_ENDED"]);
  d.store.tracking_enabled = true;
  d.store.collect_detail = false;
  assert.equal((await d.videoEvents(viewing("trk2", v => v.play().wait(5).pause()))).stored, 0);
  assert.equal((await d.localEvents("trk2")).length, 0);
});

test("forged events from the page are refused by the extension before they are stored", async () => {
  const d = await pairedDevice();
  const good = viewing("frg1", v => v.play())[0];
  const r = await d.videoEvents([{ ...good, type: "DROP TABLE" }, { ...good, id: "frg1:e2", seq: 2, ts: 3 }, "junk", null]);
  assert.equal(r.stored, 0);
  assert.equal(await d.localEvents("frg1").then(a => a.length), 0);
});

test("a viewing whose browser vanished is closed at its last heartbeat, with an unresolved pause and no invented end", async () => {
  const d = await pairedDevice();
  const t0 = Date.now() - 3600 * S;
  const live = viewing("crash1", v => { v.play().wait(30).pause().wait(45); v.rec.heartbeat(v.p.t, v.p.pos); }, { start: t0 });
  await d.videoEvents(live);
  // the recorder state as the content script last persisted it, an hour ago
  const rec = P.createRecorder({ sessionId: "crash1", videoId: "vidA" });
  rec.observe({ pos: 0, rate: 1, paused: false, duration: 600 }, t0); rec.observe({ pos: 30, rate: 1, paused: true, duration: 600 }, t0 + 30 * S);
  rec.heartbeat(t0 + 75 * S, 30);
  d.store.live_rec = rec.snapshot();
  await d.flush(d.snap("crash1", "vidA", { startTs: t0 }));              // its watch-time snapshot never got an end timestamp
  await d.recover();
  assert.equal(d.store.live_rec, null);
  const types = (await d.localEvents("crash1")).map(e => e.type);
  assert.equal(types[types.length - 1], "VIDEO_SESSION_INTERRUPTED");
  const intr = (await d.localEvents("crash1")).pop();
  assert.equal(intr.ts, t0 + 75 * S, "stamped with the last heartbeat, not with now");
  assert.equal((await d.sessions()).find(s => s.sessionId === "crash1").endTs, t0 + 75 * S);
  await d.pushEvents(); await d.sync();
  const pause = ctx.db.prepare("SELECT status,resumed_at,duration_ms,enc FROM video_pause_intervals WHERE device_id=? AND session_id='crash1'").get(d.id);
  assert.deepEqual([pause.status, pause.resumed_at, pause.duration_ms], ["unresolved", null, null]);
  assert.equal(decryptJSON(pause.enc).minDurationMs, 45 * S);
  assert.equal(ctx.db.prepare("SELECT state FROM video_sessions WHERE session_id='crash1'").get().state, "interrupted");
  // recovery is idempotent and leaves a live recorder alone
  await d.recover();
  d.store.live_rec = P.createRecorder({ sessionId: "alive", videoId: "vidA" }).snapshot();
  const fresh = P.createRecorder({ sessionId: "alive", videoId: "vidA" });
  fresh.observe({ pos: 0, rate: 1, paused: false }, Date.now()); fresh.heartbeat(Date.now(), 1);
  d.store.live_rec = fresh.snapshot();
  await d.recover();
  assert.ok(d.store.live_rec, "a recorder with a fresh heartbeat is not interrupted");
});

test("revocation stops event upload and clears the queue", async () => {
  const d = await pairedDevice();
  await d.videoEvents(viewing("rev1", v => v.play().wait(5).pause()));
  assert.equal((await owner("POST", `/api/devices/${d.id}/revoke`)).statusCode, 200);
  const r = await d.pushEvents();
  assert.equal(r.revoked, true);
  assert.equal((await d.evOutbox()).length, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM video_playback_events WHERE device_id=?").get(d.id).n, 0);
});

test("real-time: the owner's open dashboard is told about each pause and resume as the device uploads them", async () => {
  const d = await pairedDevice();
  const admin = ctx.db.prepare("SELECT admin_id FROM devices WHERE id=?").get(d.id).admin_id;
  const got = [];
  const unsub = ctx.app.hub.subscribeAdmin(admin, (type, data) => { if (type === "video_event") got.push(...data.events.map(e => e.type)); });
  const t0 = Date.now();
  const v = viewing("live1", v => v.play().wait(5), { start: Date.now() - 30 * S });
  await d.videoEvents(v); await d.pushEvents();
  assert.deepEqual(got, ["VIDEO_STARTED"]);
  const more = viewing("live1", v => v.play().wait(5).pause().wait(3).play(), { start: Date.now() - 30 * S }).slice(1);
  await d.videoEvents(more); await d.pushEvents();
  unsub();
  assert.deepEqual(got, ["VIDEO_STARTED", "VIDEO_PAUSED", "VIDEO_RESUMED"]);
  assert.ok(Date.now() - t0 < 5000);
});

test("separate viewings of the same video stay separate sessions on the server", async () => {
  const d = await pairedDevice();
  await d.videoEvents([...viewing("sepA", v => v.play().wait(20).stop()), ...viewing("sepB", v => v.play().wait(40).pause().wait(5).stop())]);
  await d.pushEvents();
  const rows = ctx.db.prepare("SELECT session_id,state FROM video_sessions WHERE device_id=? ORDER BY session_id").all(d.id);
  assert.deepEqual(rows.map(r => r.session_id), ["sepA", "sepB"]);
  const an = decryptJSON(ctx.db.prepare("SELECT enc FROM video_analytics WHERE device_id=? AND video_id='vidA'").get(d.id).enc);
  assert.equal(an.sessions, 2);
  assert.equal(an.activeMs, 60 * S);
});
