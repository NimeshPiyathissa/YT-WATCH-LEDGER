import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import argon2 from "argon2";
import { makeApp, addOwner, login, enrollDevice, session, allowLiveView } from "./helpers.js";
import { uuid } from "../src/lib/crypto.js";

const require = createRequire(import.meta.url);
const P = require("../src/lib/playback.cjs");
const S = 1000;

function viewing(sessionId, fn, { videoId = "vidA", start = Date.now() - 7200 * S, duration = 600 } = {}) {
  const rec = P.createRecorder({ sessionId, videoId });
  const p = { t: start, pos: 0, paused: true }, events = [];
  const feed = hint => events.push(...rec.observe({ pos: p.pos, rate: 1, paused: p.paused, duration }, p.t, hint));
  const v = {
    play() { p.paused = false; feed("play"); return v; }, pause() { p.paused = true; feed("pause"); return v; },
    wait(s) { if (!p.paused) p.pos += s; p.t += s * S; return v; },
    seek(to) { p.pos = to; rec.observe({ pos: to, rate: 1, paused: p.paused, seeking: true }, p.t, "seeking"); feed("seeked"); return v; },
    end() { p.paused = true; p.ended = true; events.push(...rec.observe({ pos: duration, rate: 1, paused: true, ended: true, duration }, p.t, "ended")); return v; },
    stop(r) { events.push(...rec.end(p.t, r || "navigation", { pos: p.pos })); return v; }, events, rec, p
  };
  fn(v);
  return events;
}

async function setup() {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev = await enrollDevice(app, A, "Laptop");
  const send = (events, d = dev) => app.inject({ method: "POST", url: "/api/sync/events", headers: d.auth, payload: { events } });
  const push = (sessions, d = dev) => app.inject({ method: "POST", url: "/api/sync/push", headers: d.auth, payload: { sessions } });
  const get = (url, cookie = A) => app.inject({ method: "GET", url, headers: { cookie } });
  // a device is "online" while it holds a real-time connection; tests fake one
  const online = d => app.hub.subscribeDevice(d.deviceId, { sessionId: d.sessionId, send() {}, close() {} });
  return { app, db, A, dev, send, push, get, online };
}

async function seeded() {
  const c = await setup();
  const t0 = Date.now() - 7200 * S;
  // session 1: two pauses (2m30 and 3m), a seek, completed, ended
  await c.send(viewing("s1", v => v.play().wait(60).pause().wait(150).play().wait(30).seek(300).wait(60).pause().wait(180).play().wait(40).end().stop("ended"), { start: t0 }));
  // session 2 (a later viewing, no completion), one pause that is still open
  await c.send(viewing("s2", v => v.play().wait(20).pause(), { start: t0 + 3600 * S }));
  // a session from before 0.7: only the watch-time snapshot exists
  await c.push([session("old1", "vidA", { startTs: t0 - 86400 * S, endTs: t0 - 86400 * S + 100 * S, watchedMs: 90 * S, duration: 600, title: "A video", channel: "A channel", channelUrl: "https://www.youtube.com/@achannel", completed: false })]);
  await c.push([session("s1", "vidA", { startTs: t0, endTs: t0 + 600 * S, watchedMs: 250 * S, duration: 600, title: "A video", channel: "A channel", completed: true, rev: 3 })]);
  return { ...c, t0 };
}

test("details: identity, totals across sessions, and sessions without event history are counted but never given a timeline", async () => {
  const { get } = await seeded();
  const r = await get("/api/video/vidA");
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.deepEqual([d.video.videoId, d.video.title, d.video.channel, d.video.channelUrl], ["vidA", "A video", "A channel", "https://www.youtube.com/@achannel"]);
  assert.match(d.video.thumbnail, /^https:\/\/i\.ytimg\.com\/vi\/vidA\//);
  assert.deepEqual([d.totals.sessions, d.totals.eventSessions, d.totals.summaryOnlySessions], [3, 2, 1]);
  assert.equal(d.totals.pauseCount, 3);
  assert.equal(d.totals.resumeCount, 2);
  assert.equal(d.totals.pausedMs, 330 * S, "only completed pauses are in the total");
  assert.equal(d.totals.activeMsSummaryOnly, 90 * S);
  assert.equal(d.totals.activeMsFromEvents, 60 * S + 30 * S + 60 * S + 40 * S + 20 * S);
  assert.equal(d.totals.completedSessions, 1);
  assert.equal(d.devices[0].label, "Laptop");
  const sessions = (await get("/api/video/vidA/sessions")).json();
  assert.equal(sessions.total, 3);
  const old = sessions.items.find(s => s.sessionId === "old1");
  assert.equal(old.hasEvents, false); assert.equal(old.summary.watchedMs, 90 * S);
  assert.equal((await get("/api/video/vidA/events?session=old1")).json().total, 0, "nothing is invented for it");
});

test("events: chronological, each with its related duration, in the server's clock", async () => {
  const { get, t0 } = await seeded();
  const r = (await get("/api/video/vidA/events?session=s1&tz=UTC")).json();
  assert.deepEqual(r.items.map(e => e.type), ["VIDEO_STARTED", "VIDEO_PAUSED", "VIDEO_RESUMED", "VIDEO_SEEKED", "VIDEO_PAUSED", "VIDEO_RESUMED", "VIDEO_COMPLETED", "VIDEO_SESSION_ENDED"]);
  assert.ok(r.items.every((e, i) => i === 0 || e.tsAdj >= r.items[i - 1].tsAdj));
  const [, p1, r1, sk, p2, r2, done, end] = r.items;
  assert.equal(p1.related.ms, 150 * S); assert.equal(r1.related.ms, 150 * S); assert.equal(r1.related.n, 1);
  assert.equal(p2.related.ms, 180 * S); assert.equal(r2.related.ms, 180 * S);
  assert.deepEqual([sk.related.fromSec, sk.related.toSec], [90, 300]);
  assert.equal(done.related.kind, "completion"); assert.equal(done.related.ms, done.tsAdj - r.items[0].tsAdj);
  assert.equal(end.related.ms, end.tsAdj - r.items[0].tsAdj);
  assert.ok(Math.abs(r.items[0].tsAdj - t0) < 5000);
  assert.equal(r.items[1].pos, 60);
});

test("events: paging, newest-first order, and the limit is clamped", async () => {
  const { get } = await seeded();
  const all = (await get("/api/video/vidA/events")).json();
  assert.equal(all.total, 10);
  const page = (await get("/api/video/vidA/events?limit=3&offset=3")).json();
  assert.deepEqual(page.items.map(e => e.id), all.items.slice(3, 6).map(e => e.id));
  const desc = (await get("/api/video/vidA/events?order=desc&limit=2")).json();
  assert.equal(desc.items[0].id, all.items[all.items.length - 1].id);
  assert.equal((await get("/api/video/vidA/events?limit=999999")).json().limit, 2000);
  assert.equal((await get("/api/video/vidA/events?limit=abc&offset=-5")).json().offset, 0);
});

test("filters: event type, session, time range, device and completion status", async () => {
  const { get, t0, app, A } = await seeded();
  const types = (await get("/api/video/vidA/events?type=VIDEO_PAUSED,VIDEO_RESUMED")).json();
  assert.ok(types.items.every(e => ["VIDEO_PAUSED", "VIDEO_RESUMED"].includes(e.type)));
  assert.equal(types.total, 5);
  assert.equal((await get("/api/video/vidA/events?type=NOT_A_TYPE")).json().total, 10, "unknown types are ignored, not an error");
  assert.equal((await get("/api/video/vidA/events?session=s2")).json().total, 2);
  assert.equal((await get(`/api/video/vidA/events?from=${t0 + 3000 * S}`)).json().total, 2);
  assert.equal((await get(`/api/video/vidA/events?to=${t0 + 3000 * S}`)).json().total, 8);
  assert.equal((await get("/api/video/vidA/events?completed=yes")).json().total, 8);
  assert.equal((await get("/api/video/vidA/events?completed=no")).json().total, 2);
  const devId = (await app.inject({ method: "GET", url: "/api/devices", headers: { cookie: A } })).json()[0].id;
  assert.equal((await get(`/api/video/vidA/events?device=${devId}`)).json().total, 10);
  assert.equal((await get("/api/video/vidA/sessions?completed=yes")).json().items.filter(s => s.hasEvents).length, 1);
  assert.equal((await get("/api/video/vidA/pauses?session=s1")).json().items.length, 2);
});

test("pauses: every interval in order with stats; open and unresolved ones are labelled, not given an end", async () => {
  const { get, send } = await seeded();
  const r = (await get("/api/video/vidA/pauses")).json();
  assert.deepEqual(r.items.map(p => [p.number, p.sessionId, p.status]), [[1, "s1", "resumed"], [2, "s1", "resumed"], [3, "s2", "open"]]);
  assert.deepEqual(r.items.slice(0, 2).map(p => p.durationMs / S), [150, 180]);
  assert.equal(r.items[2].resumedAt, null); assert.equal(r.items[2].durationMs, null);
  assert.deepEqual([r.stats.count, r.stats.completed, r.stats.open, r.stats.avgMs / S, r.stats.longestMs / S, r.stats.shortestMs / S], [3, 2, 1, 165, 180, 150]);
  assert.equal(r.distribution.find(b => b.label === "1–5 min").count, 2);
  // an interrupted session: the pause is unresolved with only a lower bound
  const rec = P.createRecorder({ sessionId: "s3", videoId: "vidA" });
  const t = Date.now() - 600 * S, evs = [];
  evs.push(...rec.observe({ pos: 0, rate: 1, paused: false, duration: 600 }, t));
  evs.push(...rec.observe({ pos: 10, rate: 1, paused: true, duration: 600 }, t + 10 * S));
  rec.heartbeat(t + 100 * S, 10);
  evs.push(P.interruptedEvent(rec.snapshot(), t + 100 * S));
  await send(evs);
  const un = (await get("/api/video/vidA/pauses?session=s3")).json();
  assert.deepEqual([un.items[0].status, un.items[0].resumedAt, un.items[0].durationMs, un.items[0].minDurationMs], ["unresolved", null, null, 90 * S]);
  assert.equal(un.stats.unresolved, 1);
  const ev = (await get("/api/video/vidA/events?session=s3")).json().items;
  assert.equal(ev[1].related.unresolved, true); assert.equal(ev[1].related.ms, null);
});

test("live status: playing, paused (with since), buffering, completed, and DEVICE OFFLINE when the device is not connected", async () => {
  const c = await setup();
  await allowLiveView(c.app, c.dev);
  const t = Date.now() - 20 * S;
  await c.send(viewing("l1", v => v.play().wait(10), { start: t }));
  assert.equal((await c.get("/api/video/vidA/live")).json().status, "offline", "no real-time connection: the device is offline");
  const off = c.online(c.dev);
  let live = (await c.get("/api/video/vidA/live")).json();
  assert.deepEqual([live.status, live.current.session.state, live.current.online], ["playing", "playing", true]);
  await c.send(viewing("l1", v => v.play().wait(10).pause(), { start: t }).slice(1));
  live = (await c.get("/api/video/vidA/live")).json();
  assert.equal(live.status, "paused");
  assert.ok(Math.abs(live.current.session.since - (t + 10 * S)) < 5000, "since is the pause event's own time");
  assert.ok(live.serverNow >= live.current.session.since);
  await c.send(viewing("l1", v => v.play().wait(10).pause().wait(5).play().wait(30).end(), { start: t }).slice(2));
  assert.equal((await c.get("/api/video/vidA/live")).json().status, "completed");
  off();
  assert.equal((await c.get("/api/video/vidA/live")).json().status, "offline");
});

test("analytics: real recorded data for the charts", async () => {
  const { get } = await seeded();
  const a = (await get("/api/video/vidA/analytics")).json();
  assert.equal(a.sessions.length, 2);
  assert.deepEqual(a.sessions.map(s => s.sessionId), ["s1", "s2"]);
  assert.equal(a.breakdown.pausedMs, 330 * S);
  assert.equal(a.pauseStats.count, 3);
  assert.ok(a.coverage.length >= 2 && a.coverage[0].from === 0);
  assert.ok(a.runs.length >= 4 && a.runs.every(r => r.ms > 0 && r.to >= r.from));
  assert.equal(a.summary.uniqueContentSec, a.coverage.reduce((n, c) => n + c.to - c.from, 0));
  assert.equal(a.duration, 600);
});

test("the video list: filters by text, channel, completion and device; shows which videos have event history", async () => {
  const { get, push } = await seeded();
  await push([session("x1", "vidB", { title: "Other thing", channel: "Elsewhere", completed: false })]);
  const all = (await get("/api/videos")).json();
  assert.deepEqual(all.items.map(i => i.videoId).sort(), ["vidA", "vidB"]);
  assert.equal(all.items.find(i => i.videoId === "vidA").hasEvents, true);
  assert.equal(all.items.find(i => i.videoId === "vidB").hasEvents, false);
  assert.deepEqual((await get("/api/videos?q=other")).json().items.map(i => i.videoId), ["vidB"]);
  assert.deepEqual((await get("/api/videos?channel=a%20channel")).json().items.map(i => i.videoId), ["vidA"]);
  assert.deepEqual((await get("/api/videos?completed=yes")).json().items.map(i => i.videoId), ["vidA"]);
  assert.equal((await get("/api/videos?device=nope")).json().total, 0);
});

test("export CSV: one row per event, local and UTC time, neutralised formulas; JSON and the print report carry the same data", async () => {
  const c = await seeded();
  await c.push([session("s1", "vidA", { title: '=HYPERLINK("http://x","click")', channel: "A channel", startTs: c.t0, endTs: c.t0 + 600 * S, rev: 9, completed: true })]);
  const csv = await c.get("/api/video/vidA/export?format=csv&tz=Asia/Colombo");
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers["content-type"], /text\/csv/);
  assert.match(csv.headers["content-disposition"], /attachment; filename="video-vidA-events-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = csv.body.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines.length, 11);
  assert.match(lines[0], /^event_number,timestamp_utc,timestamp_slst,date_local,time_local,timezone,event_type,device,session_id/);
  assert.match(lines[2], /,Asia\/Colombo,VIDEO_PAUSED,Laptop,s1,vidA,/);
  assert.match(lines[2], /"[A-Z][a-z]+ \d{1,2}, \d{4} · \d{1,2}:\d{2}:\d{2}\.\d{3} [AP]M \(SLST\)"/, "the full SLST timestamp is in the row");
  assert.match(lines[2], /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  assert.match(lines[2], /,150,2 minutes 30 seconds,/);
  assert.match(csv.body, /"'=HYPERLINK\(""http:\/\/x"",""click""\)"/);
  const pa = (await c.get("/api/video/vidA/export?format=csv&scope=pauses")).body.trim().split("\r\n");
  assert.equal(pa.length, 4);
  assert.match(pa[3], /,open,/);
  const ss = (await c.get("/api/video/vidA/export?format=csv&scope=sessions")).body.trim().split("\r\n");
  assert.equal(ss.length, 4);
  assert.match(ss.find(l => l.includes("old1")), /no \(summary only\)/);
  const json = (await c.get("/api/video/vidA/export?format=json")).json();
  assert.equal(json.events.length, 10); assert.equal(json.pauses.length, 3); assert.equal(json.sessions.length, 3); assert.equal(json.video.videoId, "vidA");
  const html = await c.get("/api/video/vidA/export?format=print&tz=UTC");
  assert.match(html.headers["content-type"], /text\/html/);
  assert.match(html.body, /Pauses \(3\)/);
  assert.equal(html.body.includes("<script>"), false, "no inline script");
  assert.equal(html.body.includes('HYPERLINK("http'), false, "titles are escaped");
  assert.match(html.body, /&quot;|&lt;/);
  const audit = c.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='export_video'").get().n;
  assert.ok(audit >= 5, "exports are audited");
  assert.equal((await c.app.inject({ method: "GET", url: "/print.css" })).statusCode, 200);
});

test("authorization: nothing is readable without the owner's session, and unknown or malformed ids are 404", async () => {
  const { app, get } = await seeded();
  for (const u of ["", "/live", "/events", "/sessions", "/pauses", "/analytics", "/export?format=csv"]) {
    assert.equal((await app.inject({ method: "GET", url: "/api/video/vidA" + u })).statusCode, 401, u);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/videos" })).statusCode, 401);
  assert.equal((await get("/api/video/unknown")).statusCode, 404);
  assert.equal((await get("/api/video/..%2F..%2Fx")).statusCode, 404);
  assert.equal((await get("/api/video/vidA/events?device=not-mine")).statusCode, 404);
});

test("ownership: another account's devices and history are unreachable in both directions", async () => {
  const c = await seeded();
  // The product has one owner (the database enforces it); lift that rule in this test database only, to prove the queries scope by owner.
  c.db.exec("DROP INDEX idx_single_owner");
  const other = uuid();
  c.db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES (?,?,?,?)").run(other, "other@example.com", await argon2.hash("another long passphrase"), Date.now());
  const B = await login(c.app, "other@example.com", "another long passphrase");
  const devB = await enrollDevice(c.app, B, "Their laptop");
  await c.send(viewing("theirs1", v => v.play().wait(9).pause(), { videoId: "vidSecret", start: Date.now() - 600 * S }), devB);
  await c.push([session("theirs1", "vidSecret", { title: "Their private video" })], devB);

  // B sees only B's
  assert.equal((await c.get("/api/video/vidSecret", B)).statusCode, 200);
  assert.equal((await c.get("/api/video/vidA", B)).statusCode, 404);
  assert.deepEqual((await c.get("/api/videos", B)).json().items.map(i => i.videoId), ["vidSecret"]);
  // the first owner can't see B's video, nor address B's device
  for (const u of ["", "/events", "/sessions", "/pauses", "/analytics", "/live", "/export?format=json"]) assert.equal((await c.get("/api/video/vidSecret" + u)).statusCode, 404, u);
  assert.deepEqual((await c.get("/api/videos")).json().items.map(i => i.videoId), ["vidA"]);
  assert.equal((await c.get(`/api/video/vidA/events?device=${devB.deviceId}`)).statusCode, 404);
  assert.equal((await c.get(`/api/video/vidSecret/events?device=${devB.deviceId}`)).statusCode, 404);
  // the same video id on both accounts stays separate
  await c.send(viewing("theirs2", v => v.play().wait(5), { videoId: "vidA", start: Date.now() - 300 * S }), devB);
  assert.equal((await c.get("/api/video/vidA/events", B)).json().total, 1);
  assert.equal((await c.get("/api/video/vidA/events")).json().total, 10);
  assert.ok(!JSON.stringify((await c.get("/api/video/vidA/export?format=json")).json()).includes("theirs"));
});
