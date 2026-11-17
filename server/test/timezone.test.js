// Sri Lanka Standard Time end to end on the server: stats day boundaries, the stats route, CSV / JSON / print exports,
// history export columns, live event payloads and offline-recorded events. Stored timestamps stay UTC throughout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { makeApp, addOwner, login, enrollDevice, session, allowLiveView } from "./helpers.js";
import { summarize, dayKey, weekKey, monthKey } from "../src/lib/aggregate.js";

const require = createRequire(import.meta.url);
const P = require("../src/lib/playback.cjs");
const S = 1000;
const ev = (sessionId, seq, type, ts, pos, extra = {}) => ({ id: `${sessionId}:e${seq}`, sessionId, videoId: "vidTz", seq, type, ts, pos, rate: 1, prev: "none", next: "none", meta: {}, ...extra });

async function setup() {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev = await enrollDevice(app, A, "Laptop");
  const send = events => app.inject({ method: "POST", url: "/api/sync/events", headers: dev.auth, payload: { events, clientNow: Date.now() } });
  const push = sessions => app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions } });
  const get = url => app.inject({ method: "GET", url, headers: { cookie: A } });
  return { app, db, A, dev, send, push, get };
}

test("statistics bucket by Sri Lanka day, week and month, not by UTC", () => {
  const t = Date.UTC(2026, 10, 3, 19, 0, 0);                       // 7 PM UTC on Nov 3 is 12:30 AM on Nov 4 in Colombo
  assert.equal(dayKey(t), "2026-11-04");
  assert.equal(dayKey(Date.UTC(2026, 10, 3, 18, 29, 59)), "2026-11-03");
  assert.equal(dayKey(Date.UTC(2026, 10, 3, 18, 30, 0)), "2026-11-04");
  assert.equal(monthKey(Date.UTC(2026, 9, 31, 18, 30, 0)), "2026-11", "UTC is still October; Colombo is already November");
  assert.equal(weekKey(Date.UTC(2026, 10, 8, 18, 30, 0)), "2026-11-09", "Sunday night UTC is Monday morning in Colombo: a new week");
  const items = [{ startTs: t, watchedMs: 60000, videoId: "a", deviceId: "d" }];
  const s = summarize(items, { now: t + 3600e3 });
  assert.equal(s.daily.find(d => d.value).key, "2026-11-04");
  assert.equal(s.todayMs, 60000, "'today' is the Colombo day");
  // an explicit fixed offset still works for callers that ask for one
  assert.equal(summarize(items, { now: t + 3600e3, tzOffsetMin: 0 }).daily.find(d => d.value).key, "2026-11-03");
});

test("the stats route ignores any zone the browser sends: days are Sri Lanka days", async () => {
  const { push, get } = await setup();
  const late = Date.now() - 3 * 86400e3;
  await push([session("s1", "v1", { startTs: late, endTs: late + 1000, watchedMs: 60000 })]);
  const a = (await get("/api/stats")).json(), b = (await get("/api/stats?tz=480")).json(), c = (await get("/api/stats?tz=-720")).json();
  assert.deepEqual(b.daily, a.daily); assert.deepEqual(c.daily, a.daily);
  assert.equal(a.timeZone, "Asia/Colombo");
  assert.equal(a.daily.find(d => d.value).key, P.dayKey(late));
});

test("video export CSV shows UTC and the full SLST timestamp for every event; a requested zone is ignored", async () => {
  const { send, get } = await setup();
  // 2026-11-03 18:29:58 UTC = 11:59:58 PM SLST on Nov 3; the pause lasts 4 s, so the resume is on Nov 4 SLST
  const t0 = Date.UTC(2026, 10, 3, 18, 29, 58);
  assert.equal((await send([ev("z", 1, "VIDEO_STARTED", t0 - 10 * S, 0, { next: "playing" }), ev("z", 2, "VIDEO_PAUSED", t0, 10, { prev: "playing", next: "paused" }), ev("z", 3, "VIDEO_RESUMED", t0 + 4 * S, 10, { prev: "paused", next: "playing" }), ev("z", 4, "VIDEO_SESSION_ENDED", t0 + 20 * S, 26, { next: "none" })])).statusCode, 200);
  for (const q of ["", "&tz=UTC", "&tz=America/New_York"]) {
    const r = await get("/api/video/vidTz/export?format=csv" + q);
    const lines = r.body.replace(/^﻿/, "").trim().split("\r\n");
    assert.equal(lines.length, 5);
    assert.match(lines[2], /"November 3, 2026 · 11:59:58\.000 PM \(SLST\)"/);
    assert.match(lines[3], /2026-11-03T18:30:02\.000Z,"November 4, 2026 · 12:00:02\.000 AM \(SLST\)"/);
    assert.match(lines[2], /,Asia\/Colombo,VIDEO_PAUSED,/);
    assert.match(lines[3], /,4,4 seconds,/, "the 4 s pause is 4 s although it crosses SLST midnight");
  }
  const pauses = (await get("/api/video/vidTz/export?format=csv&scope=pauses&tz=UTC")).body.trim().split("\r\n");
  assert.match(pauses[1], /2026-11-03T18:29:58\.000Z,"November 3, 2026 · 11:59:58\.000 PM \(SLST\)",2026-11-03T18:30:02\.000Z,"November 4, 2026 · 12:00:02\.000 AM \(SLST\)",Asia\/Colombo,resumed,4,/);
});

test("JSON export keeps UTC instants unchanged and names the display zone; the print report is all SLST", async () => {
  const { send, get, db } = await setup();
  const t0 = Date.UTC(2026, 10, 3, 7, 15, 2);                      // 12:45:02 PM SLST
  await send([ev("j", 1, "VIDEO_STARTED", t0, 0, { next: "playing" }), ev("j", 2, "VIDEO_PAUSED", t0 + 30 * S, 30, { prev: "playing", next: "paused" }), ev("j", 3, "VIDEO_RESUMED", t0 + 150 * S, 30, { prev: "paused", next: "playing" }), ev("j", 4, "VIDEO_SESSION_ENDED", t0 + 200 * S, 80, { next: "none" })]);
  const j = (await get("/api/video/vidTz/export?format=json&tz=UTC")).json();
  assert.equal(j.timezone, "Asia/Colombo");
  assert.match(j.timezoneLabel, /SLST/);
  assert.deepEqual(j.events.map(e => e.ts), [t0, t0 + 30 * S, t0 + 150 * S, t0 + 200 * S], "the instants are exactly the stored UTC milliseconds");
  assert.equal(j.pauses[0].durationMs, 120 * S);
  assert.equal(db.prepare("SELECT MIN(ts) m FROM video_playback_events").get().m, t0, "the database still holds UTC");
  const html = (await get("/api/video/vidTz/export?format=print&tz=America/New_York")).body;
  assert.match(html, /November 3, 2026 · 12:45:02\.000 PM \(SLST\)/);
  assert.match(html, /November 3, 2026 · 12:45:32\.000 PM \(SLST\)/);
  assert.match(html, /All times are Sri Lanka Standard Time/);
  assert.match(html, /<th>Paused at \(SLST\)<\/th>/);
  assert.equal(/\bEST\b|\bEDT\b|America\/New_York/.test(html), false);
  assert.match(html, /2 minutes/, "durations are in the report, independent of display");
});

test("history export keeps the UTC columns and adds Sri Lanka columns", async () => {
  const { push, get } = await setup();
  const start = Date.UTC(2026, 10, 3, 18, 29, 0), end = start + 120 * S;
  await push([session("h1", "vidH", { startTs: start, endTs: end, watchedMs: 90 * S })]);
  const csv = (await get("/api/export?format=csv&tz=UTC")).body.trim().split("\r\n");
  assert.match(csv[0], /,startedAt,endedAt,.*,startedAtSlst,endedAtSlst$/);
  assert.match(csv[1], /2026-11-03T18:29:00\.000Z,2026-11-03T18:31:00\.000Z/);
  assert.match(csv[1], /"November 3, 2026 · 11:59:00 PM \(SLST\)","November 4, 2026 · 12:01:00 AM \(SLST\)"$/);
  const json = (await get("/api/export?format=json")).json();
  assert.equal(json.displayTimeZone, "Asia/Colombo");
  assert.equal(json.items[0].startTs, start);
});

test("live timeline: a pushed event reaches the dashboard with its UTC instant, and the page formats it in SLST at once", async () => {
  const { app, db, dev, send } = await setup();
  await allowLiveView(app, dev);
  const admin = db.prepare("SELECT admin_id FROM devices WHERE id=?").get(dev.deviceId).admin_id, got = [];
  app.hub.subscribeAdmin(admin, (type, data) => { if (type === "video_event") got.push(data); });
  const t = Date.UTC(2026, 10, 3, 7, 15, 2);
  await send([ev("L", 1, "VIDEO_STARTED", t, 0, { next: "playing" })]);
  await send([ev("L", 2, "VIDEO_PAUSED", t + 5 * S, 5, { prev: "playing", next: "paused" })]);
  assert.equal(got.length, 2);
  const e = got[1].events[0];
  assert.equal(e.ts, t + 5 * S, "raw UTC milliseconds on the wire");
  // what the page does with it (video.js: dBoth(e.tsAdj) = formatStamp(ts + skew))
  assert.equal(P.formatStamp(e.ts + got[1].skewMs), "November 3, 2026 · 12:45:07 PM (SLST)");
  assert.equal(P.formatStamp(e.ts + got[1].skewMs, undefined, true), "November 3, 2026 · 12:45:07.000 PM (SLST)");
});

test("offline-recorded events keep their original occurrence time after they finally sync", async () => {
  const { send, get, db } = await setup();
  const earlier = Date.now() - 6 * 3600e3;                         // recorded six hours ago while the device was offline
  const t = earlier - (earlier % S);
  await send([ev("o", 1, "VIDEO_STARTED", t, 0, { next: "playing" }), ev("o", 2, "VIDEO_PAUSED", t + 90 * S, 90, { prev: "playing", next: "paused" }), ev("o", 3, "VIDEO_RESUMED", t + 210 * S, 90, { prev: "paused", next: "playing" })]);
  const rows = db.prepare("SELECT ts, ts_adj, received_at FROM video_playback_events ORDER BY seq").all();
  assert.deepEqual(rows.map(r => r.ts), [t, t + 90 * S, t + 210 * S], "the stored time is when it happened");
  assert.ok(rows.every(r => r.received_at - r.ts > 5 * 3600e3), "it arrived hours later");
  assert.ok(rows.every(r => Math.abs(r.ts_adj - r.ts) < 2 * 60e3), "only the measured clock skew (none here) is applied");
  const csv = (await get("/api/video/vidTz/export?format=csv")).body.trim().split("\r\n");
  assert.match(csv[2], new RegExp(P.formatStamp(t + 90 * S, undefined, true).replace(/[().·]/g, c => "\\" + c)), "the export shows the original SLST time, not the sync time");
  const pause = (await get("/api/video/vidTz/pauses")).json().items[0];
  assert.equal(pause.durationMs, 120 * S);
});

test("a historical record (written before this change) is displayed correctly and its stored value is untouched", async () => {
  const { push, db, get } = await setup();
  const t = Date.UTC(2026, 9, 31, 5, 9, 12);                       // an old session, as 0.6 stored it
  await push([session("old", "vidOld", { startTs: t, endTs: t + 100 * S, watchedMs: 95 * S })]);
  const before = db.prepare("SELECT start_ts, start_ts_adj FROM sessions").get();
  const items = (await get("/api/history")).json().items;
  assert.equal(items[0].startTs, t);
  assert.equal(P.formatStamp(items[0].startTs), "October 31, 2026 · 10:39:12 AM (SLST)");
  const after = db.prepare("SELECT start_ts, start_ts_adj FROM sessions").get();
  assert.deepEqual(after, before);
});

test("durations are computed from absolute timestamps in the stored events, not from any formatted text", async () => {
  const { send, get } = await setup();
  const t0 = Date.UTC(2026, 10, 3, 18, 29, 0);                     // 11:59:00 PM SLST
  await send([ev("D", 1, "VIDEO_STARTED", t0, 0, { next: "playing" }), ev("D", 2, "VIDEO_PAUSED", t0 + 30 * S, 30, { prev: "playing", next: "paused" }),
    ev("D", 3, "VIDEO_RESUMED", t0 + 180 * S, 30, { prev: "paused", next: "playing" }), ev("D", 4, "VIDEO_PAUSED", t0 + 200 * S, 50, { prev: "playing", next: "paused" }), ev("D", 5, "VIDEO_SESSION_ENDED", t0 + 290 * S, 50, { next: "none" })]);
  const d = (await get("/api/video/vidTz")).json();
  assert.equal(d.totals.pausedMs, 240 * S);
  assert.equal(d.totals.activeMs, 50 * S);
  assert.equal(d.totals.elapsedMs, 290 * S);
  const ps = (await get("/api/video/vidTz/pauses")).json();
  assert.deepEqual(ps.items.map(p => p.durationMs / S), [150, 90]);
  assert.equal(P.formatStamp(ps.items[0].resumedAt), "November 4, 2026 · 12:02:00 AM (SLST)");
});
