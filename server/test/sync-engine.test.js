// Smart sync engine, end to end: the REAL extension code (background.js, lib/sync.js, lib/syncpolicy.js, lib/db.js) in simulated browsers
// against the REAL server over HTTP. Only the network conditions and timers are controlled. Covers the offline queue and its limit,
// retry classification and backoff, a poisoned batch, duplicate protection, consent reporting and the upload cadence.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { makeApp, addOwner, login } from "./helpers.js";
import { makeDevice } from "./device-harness.js";

const require = createRequire(import.meta.url);
const PB = require("../src/lib/playback.cjs");
const S = 1000;
let ctx, server, A;

before(async () => {
  ctx = await makeApp(); await addOwner(ctx.db); A = await login(ctx.app);
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  server = "http://127.0.0.1:" + ctx.app.server.address().port;
});
after(async () => { await ctx.app.close(); });

const owner = (method, url, payload) => ctx.app.inject({ method, url, headers: { cookie: A }, payload });
async function paired(name) {
  const code = (await owner("POST", "/api/devices/enroll-code", { label: name })).json().code;
  const d = makeDevice({ server, name });
  d.id = (await d.pair(code)).deviceId;
  await d.sync();
  return d;
}
// A real viewing through the real recorder: n play/pause cycles produce 1 + 2n events with stable ids.
function viewing(sessionId, cycles = 2, start = Date.now() - 600 * S) {
  const rec = PB.createRecorder({ sessionId, videoId: "vidSync" }), p = { t: start, pos: 0, paused: true }, ev = [];
  const feed = h => ev.push(...rec.observe({ pos: p.pos, rate: 1, paused: p.paused, duration: 900 }, p.t, h));
  p.paused = false; feed("play");
  for (let i = 0; i < cycles; i++) { p.t += 20 * S; p.pos += 20; p.paused = true; feed("pause"); p.t += 5 * S; p.paused = false; feed("play"); }
  ev.push(...rec.end(p.t + 3 * S, "navigation", { pos: p.pos }));
  return ev;
}
const stored = id => ctx.db.prepare("SELECT COUNT(*) n FROM video_playback_events WHERE device_id=?").get(id).n;
const dev = id => ctx.db.prepare("SELECT * FROM devices WHERE id=?").get(id);
const res = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test("offline: events pile up in the queue, nothing is lost, and everything uploads once on reconnect", async () => {
  const d = await paired("offline-1");
  d.net.offline = true;
  const ev = viewing("off1", 3);
  await d.videoEvents(ev);
  assert.equal(await d.queued(), ev.length, "every event is queued");
  assert.equal((await d.pushEvents()).ok, false); assert.equal(stored(d.id), 0);
  d.net.offline = false;
  const r = await d.pushEvents();
  assert.equal(r.sent, ev.length); assert.equal(await d.queued(), 0); assert.equal(stored(d.id), ev.length);
});

test("duplicate protection: a lost response makes the device resend, and the server still holds each event exactly once", async () => {
  const d = await paired("dup-1");
  const ev = viewing("dup1", 2);
  await d.videoEvents(ev);
  d.net.loseEventResponses = 1;
  assert.equal((await d.pushEvents()).ok, false, "the server stored them, but the device never heard back");
  assert.equal(stored(d.id), ev.length);
  assert.equal(await d.queued(), ev.length, "so they are still queued");
  const again = await d.pushEvents();
  assert.equal(again.sent, ev.length, "acknowledged again");
  assert.equal(stored(d.id), ev.length, "no duplicates");
  await d.videoEvents(ev);                                    // even the content script replaying the same events
  await d.pushEvents();
  assert.equal(stored(d.id), ev.length);
});

test("classified failures: network, 503 with Retry-After, 429 and 500 are retried, never dropped; the queue is untouched", async () => {
  const d = await paired("retry-1");
  const ev = viewing("rt1", 1); await d.videoEvents(ev);
  d.net.offline = true;
  let r = await d.pushEvents(); assert.deepEqual([r.ok, r.kind], [false, "network"]);
  d.net.offline = false;
  d.net.mock["/api/sync/events"] = () => res(503, { error: "busy" }, { "Retry-After": "7" });
  r = await d.pushEvents(); assert.deepEqual([r.ok, r.kind, r.retryAfterMs], [false, "server", 7000]);
  d.net.mock["/api/sync/events"] = () => res(429, { error: "rate_limited" }, { "Retry-After": "120" });
  r = await d.pushEvents(); assert.deepEqual([r.ok, r.kind, r.retryAfterMs], [false, "quota", 120000]);
  d.net.mock["/api/sync/events"] = () => res(500, { error: "internal_error" });
  r = await d.pushEvents(); assert.deepEqual([r.ok, r.kind], [false, "server"]);
  assert.equal(await d.queued(), ev.length, "after four failures every event is still queued");
  delete d.net.mock["/api/sync/events"];
  assert.equal((await d.pushEvents()).sent, ev.length);
});

test("a poisoned batch: the server refuses it for good, the engine finds the one bad event, sets it aside, and the rest uploads", async () => {
  const d = await paired("poison-1");
  const ev = viewing("poi1", 4);                               // 10 events
  await d.videoEvents(ev);
  const bad = ev[5].id;
  let calls = 0;
  d.net.mock["/api/sync/events"] = opts => { calls++; return JSON.parse(opts.body).events.some(e => e.id === bad) ? res(400, { error: "bad_request" }) : undefined; };
  const r = await d.pushEvents();
  assert.equal(r.ok === false, false, "the run did not fail");
  assert.equal(r.sent, ev.length - 1, "all but the bad one were stored");
  assert.equal(stored(d.id), ev.length - 1);
  assert.equal(await d.queued(), 0, "the queue is empty: the bad event does not block it");
  assert.equal(d.store.sync_dropped_rejected, 1, "and it is counted so the person can see it");
  assert.ok((await d.localEvents("poi1")).some(e => e.id === bad), "the bad event is still on the device, not deleted");
  assert.ok(calls <= 2 * Math.ceil(Math.log2(ev.length)) + 3, "found it by halving, not by trying every event (" + calls + " requests)");
  const before = calls; await d.pushEvents(); assert.equal(calls, before, "nothing is retried afterwards: no retry loop");
});

test("a poisoned session update is isolated the same way", async () => {
  const d = await paired("poison-2");
  for (const id of ["a", "b", "c"]) await d.flush(d.snap("ps-" + id, "v-" + id));
  d.net.mock["/api/sync/push"] = opts => JSON.parse(opts.body).sessions.some(s => s.sessionId === "ps-b") ? res(400, { error: "bad_request" }) : undefined;
  const r = await d.sync();
  assert.ok(r && r.ok !== false);
  assert.equal(await d.outboxCount(), 0, "the outbox drains");
  assert.deepEqual(ctx.db.prepare("SELECT session_id FROM sessions WHERE device_id=? ORDER BY session_id").all(d.id).map(x => x.session_id), ["ps-a", "ps-c"]);
  assert.equal(d.store.sync_dropped_rejected, 1);
});

test("the queue limit: past it the OLDEST queue entries are set aside, and no event is deleted from the device", async () => {
  const d = await paired("limit-1");
  d.net.offline = true;
  d.policy().LIMITS.EV_QUEUE = 8;                              // a small limit, for the test
  const ev = viewing("lim1", 5);                               // 12 events
  await d.videoEvents(ev);
  assert.equal(await d.queued(), 8, "the queue is at its limit");
  assert.equal(d.store.sync_queue_dropped, ev.length - 8);
  assert.equal((await d.localEvents("lim1")).length, ev.length, "all events are still on the device");
  const kept = (await d.evOutbox()).map(r => r.id);
  assert.deepEqual(kept, ev.slice(ev.length - 8).map(e => e.id), "the NEWEST events are the ones still queued");
  d.net.offline = false;
  assert.equal((await d.pushEvents()).sent, 8);
  const rep = ctx.db.prepare("SELECT queue_dropped FROM devices WHERE id=?").get(d.id).queue_dropped;
  assert.equal(rep, ev.length - 8, "the device tells the server, so the owner sees it");
});

test("backoff: each failed sync run waits longer, a few quick retries, then only the periodic alarm; success resets it", async () => {
  const d = await paired("backoff-1");
  d.net.offline = true;
  const waits = [], bounds = [];
  for (let i = 1; i <= 8; i++) { const t0 = Date.now(); await d.sync(); waits.push(d.store.sync_retry); bounds.push([t0, Date.now()]); }
  assert.deepEqual(waits.map(w => w.attempt), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(waits.slice(0, 6).every(w => w.at > Date.now() - 1000), "the first six schedule a retry");
  assert.deepEqual(waits.slice(6).map(w => w.at), [null, null], "after that there is no quick retry: the alarm takes over");
  assert.equal(waits[0].kind, "network");
  const P = d.policy();
  waits.slice(0, 6).forEach((w, i) => {
    const lo = bounds[i][0] + P.retryDelay(i + 1, () => 0), hi = bounds[i][1] + P.retryDelay(i + 1, () => 1);
    assert.ok(w.at >= lo && w.at <= hi, `attempt ${i + 1}: retry at +${w.at - bounds[i][0]} ms, expected between ${lo - bounds[i][0]} and ${hi - bounds[i][0]}`);
  });
  assert.ok(waits[5].at - bounds[5][0] > waits[0].at - bounds[0][0], "the later retries wait longer than the first");
  d.net.offline = false;
  await d.sync();
  assert.equal(d.store.sync_retry, null, "a successful run clears the retry state");
});

test("Retry-After is honoured for the next sync run", async () => {
  const d = await paired("retryafter-1");
  d.net.mock["/api/sync/push"] = () => res(503, { error: "busy" }, { "Retry-After": "90" });
  await d.flush(d.snap("ra1", "v"));
  await d.sync();
  const w = d.store.sync_retry;
  assert.equal(w.kind, "server");
  assert.ok(w.at - Date.now() >= 85000, "waits at least the 90 s the server asked for");
});

test("manual reconnect: clears the backoff, fetches a fresh token and syncs at once", async () => {
  const d = await paired("reconnect-1");
  d.net.offline = true; for (let i = 0; i < 3; i++) await d.sync();
  assert.ok(d.store.sync_retry);
  d.net.offline = false; d.net.log.length = 0;
  const r = await d.message({ type: "RECONNECT" });
  assert.ok(r && r.ok !== false && !r.error, JSON.stringify(r));
  assert.equal(d.store.sync_retry, null);
  assert.ok(d.net.log.some(([p]) => p === "/api/device/token"), "a new access token was requested");
  assert.ok(d.net.log.some(([p]) => p === "/api/sync/push"), "and a sync ran");
});

test("consent: live viewing starts OFF, is reported by the device, and a new pairing starts OFF again", async () => {
  const d = await paired("consent-1");
  assert.equal(dev(d.id).live_view, 0);
  assert.notEqual(d.store.live_view, true);
  const r = await d.message({ type: "SET_LIVE_VIEW", on: true });
  assert.equal(r.ok, true); assert.equal(d.store.live_view, true);
  assert.equal(dev(d.id).live_view, 1, "reported to the server right away");
  assert.equal(dev(d.id).consent_tracking, 1); assert.equal(dev(d.id).consent_detail, 1);
  d.store.tracking_enabled = false; await d.sync();
  assert.equal(dev(d.id).consent_tracking, 0, "pausing tracking is reported too");
  await d.message({ type: "SET_LIVE_VIEW", on: "true" });      // not a real boolean: treated as off
  assert.equal(d.store.live_view, false);
  await d.message({ type: "SET_LIVE_VIEW", on: true });
  const code = (await owner("POST", "/api/devices/enroll-code", { label: "again" })).json().code;
  await d.pair(code);
  assert.equal(d.store.live_view, false, "consent belongs to one pairing");
});

test("cadence: with live viewing OFF events wait for the regular sync (except at the end of a viewing); ON they go out within seconds", async () => {
  const d = await paired("cadence-1");
  const ev = viewing("cad1", 1);
  const mid = ev.filter(e => e.type !== "VIDEO_SESSION_ENDED");
  d.timers.length = 0;
  await d.videoEvents(mid);
  assert.deepEqual(d.timers, [], "off: nothing is scheduled for the middle of a viewing");
  await d.videoEvents(ev.filter(e => e.type === "VIDEO_SESSION_ENDED"));
  assert.deepEqual(d.timers, [5000], "off: the end of a viewing goes out after a few seconds");
  await d.message({ type: "SET_LIVE_VIEW", on: true });
  d.timers.length = 0;
  await d.videoEvents(viewing("cad2", 0));
  assert.ok(d.timers.includes(1000), "on: a start/pause/resume goes out in about a second: " + JSON.stringify(d.timers));
});

test("snapshots: a running viewing only syncs at once with live viewing on; its end always does", async () => {
  const d = await paired("cadence-2");
  d.timers.length = 0;
  await d.flush(d.snap("cs1", "v1"));
  assert.ok(!d.timers.includes(5000), "off: the 5 s snapshot sync is not scheduled while it plays");
  await d.flush(d.snap("cs1", "v1", { endTs: Date.now(), rev: 2 }));
  assert.ok(d.timers.includes(5000), "the end of the viewing syncs");
  await d.message({ type: "SET_LIVE_VIEW", on: true });
  d.timers.length = 0;
  await d.flush(d.snap("cs2", "v2"));
  assert.ok(d.timers.includes(5000), "on: running viewings sync every few seconds");
});

test("restart: a device that was offline with a full queue resumes without losing or duplicating anything", async () => {
  const d = await paired("restart-1");
  d.net.offline = true;
  const ev = viewing("rs1", 3);
  await d.videoEvents(ev);
  await d.restart();
  assert.equal(await d.queued(), ev.length, "the queue survived the restart");
  d.net.offline = false;
  await d.pushEvents();
  assert.equal(stored(d.id), ev.length);
  await d.restart(); await d.pushEvents();
  assert.equal(stored(d.id), ev.length, "and a second restart changes nothing");
});
