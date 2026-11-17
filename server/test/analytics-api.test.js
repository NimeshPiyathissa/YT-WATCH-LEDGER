import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { makeApp, addOwner, login, enrollDevice, session } from "./helpers.js";

const require = createRequire(import.meta.url);
const P = require("../src/lib/playback.cjs");
const S = 1000;

// Plays a scripted viewing through the real recorder (same code the extension runs) and returns its events.
function viewing(sessionId, fn, { videoId = "vidA", start = Date.now() - 7200 * S, duration = 600 } = {}) {
  const rec = P.createRecorder({ sessionId, videoId });
  const p = { t: start, pos: 0, paused: true }, events = [];
  const feed = hint => events.push(...rec.observe({ pos: p.pos, rate: 1, paused: p.paused, duration }, p.t, hint));
  const v = {
    play() { p.paused = false; feed("play"); return v; }, pause() { p.paused = true; feed("pause"); return v; },
    wait(s) { if (!p.paused) p.pos += s; p.t += s * S; return v; },
    stop(r) { events.push(...rec.end(p.t, r || "navigation", { pos: p.pos })); return v; }
  };
  fn(v);
  return events;
}

async function setup() {
  const { app, db, backupDir } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev = await enrollDevice(app, A, "Laptop");
  const send = events => app.inject({ method: "POST", url: "/api/sync/events", headers: dev.auth, payload: { events } });
  const push = sessions => app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions } });
  const get = (url, cookie = A) => app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
  return { app, db, A, dev, send, push, get, backupDir };
}

test("analytics and health require the owner's session", async () => {
  const { get, dev, app } = await setup();
  for (const url of ["/api/analytics", "/api/analytics?range=7", "/api/system/health"]) {
    assert.equal((await get(url, null)).statusCode, 401, url);
    assert.equal((await app.inject({ method: "GET", url, headers: dev.auth })).statusCode, 401, url + " with a device token");
  }
});

test("event-based time: only the seconds actually playing count, and the pause is excluded", async () => {
  const { send, get } = await setup();
  const t0 = Date.now() - 3 * 3600 * S;
  await send(viewing("e1", v => v.play().wait(60).pause().wait(150).play().wait(30).stop("ended"), { start: t0 }));
  const r = (await get("/api/analytics?range=7")).json();
  assert.equal(r.timeZone, "Asia/Colombo");
  assert.equal(r.totals.watchMs, 90000, "60 s + 30 s of playback, not the 150 s pause");
  assert.equal(r.totals.videos, 1);
  assert.equal(r.topVideos[0].videoId, "vidA");
  assert.equal(r.byDevice.length, 1); assert.equal(r.byDevice[0].label, "Laptop"); assert.equal(r.byDevice[0].share, 100);
  assert.equal(r.byHour.reduce((a, b) => a + b, 0), 90000);
  assert.ok(Array.isArray(r.series) && r.series.length >= 7);
  assert.equal(r.comparison.watchMs, 0);
});

test("a session recorded before events existed falls back to its summary; with events the summary is not added on top", async () => {
  const { send, push, get } = await setup();
  const t0 = Date.now() - 5 * 3600 * S;
  await push([session("old", "vidOld", { startTs: t0, endTs: t0 + 100 * S, watchedMs: 90 * S, title: "Old one", channel: "Old channel" })]);
  await send(viewing("n1", v => v.play().wait(40).stop("ended"), { start: t0 + 3600 * S, videoId: "vidNew" }));
  await push([session("n1", "vidNew", { startTs: t0 + 3600 * S, endTs: t0 + 3600 * S + 99 * S, watchedMs: 99 * S, title: "New one", channel: "New channel" })]);
  const r = (await get("/api/analytics?range=7")).json();
  assert.equal(r.totals.watchMs, 90000 + 40000, "90 s from the summary + 40 s from the events (the 99 s summary of the evented session is ignored)");
  const names = Object.fromEntries(r.topVideos.map(v => [v.videoId, v.title]));
  assert.equal(names.vidOld, "Old one"); assert.equal(names.vidNew, "New one");
  assert.deepEqual(r.topChannels.map(c => c.channel).sort(), ["New channel", "Old channel"]);
});

test("the same viewing uploaded twice is not counted twice", async () => {
  const { send, get } = await setup();
  const ev = viewing("dup", v => v.play().wait(50).stop("ended"), { start: Date.now() - 3600 * S });
  await send(ev); await send(ev);
  assert.equal((await get("/api/analytics?range=7")).json().totals.watchMs, 50000);
});

test("range validation: bad, reversed, too wide, unknown granularity, unknown device", async () => {
  const { get } = await setup();
  const now = Date.now();
  for (const url of ["/api/analytics?range=abc", "/api/analytics?from=" + now + "&to=" + (now - 1000), "/api/analytics?from=0&to=" + now, "/api/analytics?range=7&granularity=hour", "/api/analytics?from=-5&to=100"]) {
    assert.equal((await get(url)).statusCode, 400, url);
  }
  assert.equal((await get("/api/analytics?range=7&device=nope")).statusCode, 404);
  assert.equal((await get("/api/analytics?from=" + (now - 86400000) + "&to=" + now + "&granularity=day")).statusCode, 200);
  assert.equal((await get("/api/analytics?range=365")).statusCode, 200);
});

test("custom date ranges and the device filter", async () => {
  const { send, get, dev } = await setup();
  const t0 = Date.now() - 2 * 86400000;
  await send(viewing("c1", v => v.play().wait(30).stop("ended"), { start: t0 }));
  const inside = (await get(`/api/analytics?from=${t0 - 3600000}&to=${t0 + 3600000}&granularity=day&device=${dev.deviceId}`)).json();
  assert.equal(inside.totals.watchMs, 30000);
  const outside = (await get(`/api/analytics?from=${t0 + 3600000}&to=${t0 + 7200000}`)).json();
  assert.equal(outside.totals.watchMs, 0);
  assert.equal(outside.comparison.watchMs, 30000, "the previous period of equal length is compared");
});

test("health: owner-only detail, no paths or secrets, backups and devices counted", async () => {
  const { get, app, dev, backupDir } = await setup();
  let h = (await get("/api/system/health")).json();
  assert.equal(h.database.ok, true);
  assert.equal(typeof h.version, "string"); assert.equal(typeof h.uptimeSec, "number");
  assert.ok(h.memory.totalBytes > 0 && h.memory.freeBytes >= 0);
  assert.equal(h.devices.total, 1); assert.equal(h.devices.active, 1); assert.equal(h.devices.online, 0);
  assert.equal(h.backups.status, "none");
  assert.ok(h.warnings.some(w => w.code === "backup_none"));
  app.hub.subscribeDevice(dev.deviceId, { sessionId: dev.sessionId, send() {}, close() {} });
  await app.inject({ method: "POST", url: "/api/system/backup", headers: { cookie: await login(app) } });
  h = (await get("/api/system/health")).json();
  assert.equal(h.devices.online, 1);
  assert.equal(h.backups.count, 1); assert.equal(h.backups.status, "ok");
  assert.ok(!h.warnings.some(w => w.code === "backup_none"));
  const text = JSON.stringify(h);
  assert.ok(!text.includes(backupDir) && !text.includes(process.cwd()), "no file system path leaks");
  assert.ok(!/MASTER_KEY|COOKIE_SECRET|password|token/i.test(text), "no secret-looking field");
  assert.ok(["ok", "warn", "critical"].includes(h.status));
});

test("the public health endpoint stays minimal", async () => {
  const { app } = await setup();
  const r = await app.inject({ method: "GET", url: "/api/health" });
  assert.deepEqual(r.json(), { ok: true });
});
