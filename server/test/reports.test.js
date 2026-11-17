// Reports Studio (server): report accuracy on Sri Lanka days, weeks and months, filters, CSV / JSON / print exports, saved report
// configurations, and authorization. Throwaway in-memory database; playback is recorded by the same recorder the extension runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { openDb, migrate } from "../src/db.js";
import { makeApp, addOwner, login, enrollDevice, session } from "./helpers.js";
import { midnightOf, resolvePeriod, validateSpec, toCsv, csvCell } from "../src/lib/reports.js";

const require = createRequire(import.meta.url);
const P = require("../src/lib/playback.cjs");
const S = 1000, MIN = 60 * S, HOUR = 60 * MIN, DAY = 24 * HOUR;
const dayKey = ts => P.dayKey(ts, "Asia/Colombo");

function viewing(sessionId, fn, { videoId = "vidA", start, duration = 3600 } = {}) {
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
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev = await enrollDevice(app, A, "Laptop");
  const dev2 = await enrollDevice(app, A, "Phone");
  const send = (events, d = dev) => app.inject({ method: "POST", url: "/api/sync/events", headers: d.auth, payload: { events } });
  const push = (sessions, d = dev) => app.inject({ method: "POST", url: "/api/sync/push", headers: d.auth, payload: { sessions } });
  const get = (url, cookie = A) => app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
  const api = async (method, url, payload, headers = {}) => { const r = await app.inject({ method, url, payload, headers: { cookie: A, ...headers } }); return { code: r.statusCode, body: r.json() }; };
  const report = async q => { const r = await get("/api/reports?" + new URLSearchParams(q)); assert.equal(r.statusCode, 200, r.body); return r.json(); };
  return { app, db, A, dev, dev2, send, push, get, api, report };
}
// A Sri Lanka calendar day a few days back (so every period below is in the past and complete), and its midnight as a UTC instant.
const DAYS_BACK = 10;
const baseDay = () => dayKey(Date.now() - DAYS_BACK * DAY);
const mid = d => midnightOf(d);
const next = (d, n = 1) => dayKey(mid(d) + n * DAY + HOUR);

/* ---- periods ---- */
test("periods follow Sri Lanka calendar days: midnight is 18:30 UTC, weeks start on Monday, months have their real length", () => {
  const now = Date.UTC(2026, 10, 11, 20, 0); // Thursday 12 November 2026, 01:30 in Colombo (still the 11th in UTC)
  const d = resolvePeriod({ period: "day" }, now);
  assert.equal(d.fromDate, "2026-11-12", "the Sri Lanka date, not the UTC one");
  assert.equal(new Date(d.from).toISOString(), "2026-11-11T18:30:00.000Z");
  assert.equal(d.to - d.from, DAY);
  const w = resolvePeriod({ period: "week" }, now);
  assert.deepEqual([w.fromDate, w.toDate, w.days, w.prevDate, w.nextDate], ["2026-11-09", "2026-11-15", 7, "2026-11-02", "2026-11-16"]);
  const m = resolvePeriod({ period: "month", date: "2028-02-10" }, now);
  assert.deepEqual([m.fromDate, m.toDate, m.days, m.label], ["2028-02-01", "2028-02-29", 29, "February 2028"]);
  const c = resolvePeriod({ period: "custom", from: "2026-12-30", to: "2027-01-02" }, now);
  assert.deepEqual([c.fromDate, c.toDate, c.days], ["2026-12-30", "2027-01-02", 4], "both days included");
  assert.equal(resolvePeriod({ period: "week", date: "2026-11-15" }, now).fromDate, "2026-11-09", "a Sunday belongs to the week that started on the Monday before");
});

test("spec validation refuses bad periods, impossible dates, reversed or too long ranges and malformed filters", () => {
  const bad = (s, error, field) => { const v = validateSpec(s); assert.equal(v.ok, false, JSON.stringify(s)); assert.equal(v.error, error); if (field) assert.equal(v.field, field); };
  bad({ period: "year" }, "bad_period", "period");
  bad({ period: "day", date: "2026-02-30" }, "bad_date", "date");
  bad({ period: "day", date: "11/09/2026" }, "bad_date");
  bad({ period: "custom", from: "2026-11-09" }, "bad_date", "to");
  bad({ period: "custom", from: "2026-11-09", to: "2026-11-01" }, "bad_range");
  bad({ period: "custom", from: "2025-01-01", to: "2026-01-02" }, "range_too_long");
  bad({ period: "week", video: "../etc" }, "bad_video");
  bad({ period: "week", device: "a b" }, "bad_device");
  bad({ period: "week", channel: "x".repeat(201) }, "bad_channel");
  bad({ period: "week", channel: "a\nb" }, "bad_channel");
  assert.equal(validateSpec({ period: "week", x: 1 }, { strict: true }).error, "unknown_field");
  assert.deepEqual(validateSpec({ period: "custom", from: "2025-01-02", to: "2026-01-02", device: "all" }).spec, { period: "custom", from: "2025-01-02", to: "2026-01-02" }, "366 days is allowed; 'all' is no filter");
  assert.deepEqual(validateSpec({}).spec, { period: "week" });
});

/* ---- accuracy ---- */
test("a daily report counts only real playback, on the Sri Lanka hour it happened", async () => {
  const s = await setup(), day = baseDay();
  const t0 = mid(day) + 9 * HOUR + 15 * MIN; // 09:15 SLST
  await s.send(viewing("e1", v => v.play().wait(60).pause().wait(600).play().wait(30).stop("ended"), { start: t0 }));
  const r = await s.report({ period: "day", date: day });
  assert.equal(r.timeZone, "Asia/Colombo");
  assert.equal(r.totals.watchMs, 90 * S, "60 s + 30 s; the ten-minute pause is not watch time");
  assert.equal(r.byHour[9], 90 * S); assert.equal(r.byHour.reduce((a, b) => a + b, 0), 90 * S);
  assert.equal(r.series.length, 1); assert.equal(r.series[0].key, day);
  assert.equal(r.viewings.length, 1); assert.equal(r.viewings[0].watchMs, 90 * S); assert.equal(r.viewings[0].deviceLabel, "Laptop");
  assert.equal(r.period.fromDate, day); assert.equal(r.period.isCurrent, false);
});

test("playback across Sri Lanka midnight is split between the two days, and the week holds all of it", async () => {
  const s = await setup(), day = baseDay();
  await s.send(viewing("x1", v => v.play().wait(90).stop("ended"), { start: mid(next(day)) - 30 * S }));
  const d1 = await s.report({ period: "day", date: day }), d2 = await s.report({ period: "day", date: next(day) });
  assert.equal(d1.totals.watchMs, 30 * S); assert.equal(d2.totals.watchMs, 60 * S);
  assert.equal(d1.byHour[23], 30 * S); assert.equal(d2.byHour[0], 60 * S);
  const c = await s.report({ period: "custom", from: day, to: next(day) });
  assert.deepEqual(c.series.map(b => b.watchMs), [30 * S, 60 * S]);
  assert.equal(c.totals.activeDays, 2);
});

test("weekly and monthly reports add up their days, and agree exactly with the Analytics page for the same dates", async () => {
  const s = await setup(), day = baseDay();
  for (let i = 0; i < 9; i++) await s.send(viewing("w" + i, v => v.play().wait(60 + i).stop("ended"), { start: mid(next(day, i - 4)) + 20 * HOUR, videoId: "vid" + (i % 3) }));
  for (const period of ["week", "month"]) {
    const r = await s.report({ period, date: day });
    assert.equal(r.series.reduce((a, b) => a + b.watchMs, 0), r.totals.watchMs, period + ": the days add up to the total");
    assert.equal(r.series.length, r.period.days, period + ": one row per day");
    const a = (await s.get(`/api/analytics?from=${r.period.from}&to=${r.period.to}&granularity=day`)).json();
    assert.equal(r.totals.watchMs, a.totals.watchMs, period + ": same engine, same number");
    assert.deepEqual(r.series.map(b => b.watchMs), a.series.map(b => b.watchMs));
  }
  const w = await s.report({ period: "week", date: day });
  assert.equal(new Date(w.period.from + 5.5 * HOUR).getUTCDay(), 1, "the week starts on a Monday in Sri Lanka");
});

test("the comparison is with the period before: last week's time is not mixed into this week's", async () => {
  const s = await setup(), day = baseDay();
  const w = (await s.report({ period: "week", date: day })).period;
  await s.send(viewing("p1", v => v.play().wait(100).stop(), { start: w.from - DAY + HOUR }));
  await s.send(viewing("c1", v => v.play().wait(50).stop(), { start: w.from + HOUR }));
  const r = await s.report({ period: "week", date: day });
  assert.equal(r.totals.watchMs, 50 * S); assert.equal(r.comparison.watchMs, 100 * S); assert.equal(r.comparison.deltaPct, -50); assert.equal(r.comparison.trend, "down");
});

/* ---- filters ---- */
async function overlapping(s, day) {
  // On one laptop: A (channel X) plays 0-60 s, B (channel Y) 30-90 s, so 30 s overlap. On the phone: C (channel X) plays 40 s.
  const t = mid(day) + 14 * HOUR;
  await s.push([session("a", "vidA", { startTs: t, endTs: t + 60 * S, watchedMs: 60 * S, channel: "Chan X", title: "Video A" }),
    session("b", "vidB", { startTs: t + 30 * S, endTs: t + 90 * S, watchedMs: 60 * S, channel: "Chan Y", title: "Video B" })]);
  await s.push([session("c", "vidC", { startTs: t + 2 * HOUR, endTs: t + 2 * HOUR + 40 * S, watchedMs: 40 * S, channel: "Chan X", title: "Video C" })], s.dev2);
}
test("overlapping playback is counted once, and a channel filter keeps the fair share instead of taking the whole overlap", async () => {
  const s = await setup(), day = baseDay();
  await overlapping(s, day);
  const all = await s.report({ period: "day", date: day });
  assert.equal(all.totals.watchMs, 90 * S + 40 * S, "laptop 90 s (not 120), phone 40 s");
  assert.equal(all.totals.overlapRemovedMs, 30 * S);
  const chX = all.channels.find(c => c.channel === "Chan X").watchMs;
  assert.equal(chX, 45 * S + 40 * S, "A keeps 30 s alone + half of the 30 s overlap; C 40 s");
  const x = await s.report({ period: "day", date: day, channel: "Chan X" });
  assert.equal(x.totals.watchMs, chX, "the filtered report equals the channel's figure in the full report");
  assert.deepEqual(x.channels.map(c => c.channel), ["Chan X"]);
  assert.equal(x.totals.videos, 2); assert.equal(x.viewings.length, 2);
  assert.ok(x.options.channels.includes("Chan Y"), "the menus still offer what the filter hides");
  const y = await s.report({ period: "day", date: day, channel: "Chan Y" });
  assert.equal(x.totals.watchMs + y.totals.watchMs, all.totals.watchMs, "the channels partition the total exactly");
});

test("device and video filters, and a device that is not the owner's is refused without saying whether it exists", async () => {
  const s = await setup(), day = baseDay();
  await overlapping(s, day);
  const phone = await s.report({ period: "day", date: day, device: s.dev2.deviceId });
  assert.equal(phone.totals.watchMs, 40 * S); assert.equal(phone.filters.deviceLabel, "Phone"); assert.deepEqual(phone.byDevice.map(d => d.label), ["Phone"]);
  const vb = await s.report({ period: "day", date: day, video: "vidB" });
  assert.equal(vb.totals.watchMs, 45 * S); assert.equal(vb.filters.videoTitle, "Video B"); assert.equal(vb.totals.sessions, 1);
  const both = await s.report({ period: "day", date: day, channel: "Chan X", video: "vidB" });
  assert.equal(both.totals.watchMs, 0, "video B is not on channel X");
  const r = await s.get(`/api/reports?period=day&date=${day}&device=00000000-0000-0000-0000-000000000000`);
  assert.equal(r.statusCode, 404); assert.equal(r.json().error, "not_found");
});

test("query validation answers 400 with the field, and an empty period is a normal, empty report", async () => {
  const s = await setup();
  for (const [q, field] of [["period=year", "period"], ["period=day&date=2026-13-01", "date"], ["period=custom&from=2026-11-09&to=2026-11-01", "to"], ["period=custom&from=2024-01-01&to=2026-01-01", "to"], ["period=week&video=%3Cx%3E", "video"]]) {
    const r = await s.get("/api/reports?" + q);
    assert.equal(r.statusCode, 400, q); assert.equal(r.json().field, field, q);
  }
  const e = await s.report({ period: "month", date: "2030-06-15" });
  assert.equal(e.totals.watchMs, 0); assert.equal(e.series.length, 30); assert.equal(e.period.isFuture, true); assert.deepEqual(e.viewings, []);
});

/* ---- exports ---- */
test("CSV exports: every scope, rows that add up to the total, UTC and SLST times, and no spreadsheet formulas", async () => {
  const s = await setup(), day = baseDay();
  await overlapping(s, day);
  await s.push([session("h", "vidH", { startTs: mid(day) + 20 * HOUR, endTs: mid(day) + 20 * HOUR + 10 * S, watchedMs: 10 * S, channel: "=HYPERLINK(\"http://evil\")", title: "+cmd|' /C calc'!A0" })]);
  const total = (await s.report({ period: "day", date: day })).totals.watchMs;
  const csv = async scope => { const r = await s.get(`/api/reports/export?format=csv&scope=${scope}&period=day&date=${day}`); assert.equal(r.statusCode, 200, scope); assert.match(r.headers["content-type"], /text\/csv/); return r; };
  const days = await csv("days");
  assert.match(days.headers["content-disposition"], new RegExp(`watch-report-day-${day}-days\\.csv`));
  const lines = days.body.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[0], "day_slst,starts_utc,watch_seconds"); assert.equal(lines.length, 2);
  assert.equal(Number(lines[1].split(",")[2]) * 1000, total);
  const v = (await csv("viewings")).body;
  assert.match(v, /first_played_utc,first_played_slst/); assert.match(v, /\(SLST\)/);
  assert.ok(v.includes(`"'=HYPERLINK(""http://evil"")"`), "a channel starting with = is neutralised");
  assert.ok(v.includes("'+cmd|' /C calc'!A0"), "a title starting with + is neutralised");
  const sum = v.replace(/^﻿/, "").trim().split("\r\n").slice(1).reduce((a, l) => a + Number(l.split(",").pop()), 0);
  assert.equal(Math.round(sum * 1000), total, "the viewings add up to the total");
  for (const scope of ["videos", "channels", "devices", "hours"]) await csv(scope);
  assert.equal((await s.get(`/api/reports/export?format=csv&scope=passwords&period=day&date=${day}`)).statusCode, 400);
  assert.equal((await s.get(`/api/reports/export?format=xlsx&period=day&date=${day}`)).statusCode, 400);
  assert.equal(csvCell("-1"), "'-1"); assert.equal(csvCell("a,b"), '"a,b"');
});

test("JSON export carries the whole report with UTC timestamps and the display zone, and every export is audited", async () => {
  const s = await setup(), day = baseDay();
  await overlapping(s, day);
  const r = await s.get(`/api/reports/export?format=json&period=week&date=${day}&channel=Chan%20X`);
  assert.equal(r.statusCode, 200); assert.match(r.headers["content-disposition"], /watch-report-week-.*\.json/);
  const j = r.json();
  assert.equal(j.kind, "watch-ledger-report"); assert.equal(j.timeZone, "Asia/Colombo"); assert.match(j.note, /UTC/);
  assert.equal(j.filters.channel, "Chan X"); assert.equal(j.totals.watchMs, 85 * S);
  assert.ok(Number.isInteger(j.period.from) && Number.isInteger(j.viewings[0].firstPlayedAt));
  const log = s.db.prepare("SELECT detail FROM audit_log WHERE action='export_report'").all().map(x => JSON.parse(x.detail));
  assert.equal(log.length, 1); assert.equal(log[0].format, "json"); assert.equal(log[0].period, "week"); assert.equal(log[0].filtered, true);
  assert.ok(!JSON.stringify(log).includes("Chan X"), "the audit log does not copy the (encrypted) channel name");
});

test("the print report is a self-contained page for Save as PDF: escaped, Sri Lanka time, no inline script or style", async () => {
  const s = await setup(), day = baseDay();
  await s.push([session("p", "vidP", { startTs: mid(day) + 8 * HOUR, endTs: mid(day) + 8 * HOUR + 30 * S, watchedMs: 30 * S, title: "<img src=x onerror=alert(1)>", channel: "<script>bad()</script>" })]);
  const r = await s.get(`/api/reports/export?format=print&period=day&date=${day}`);
  assert.equal(r.statusCode, 200); assert.match(r.headers["content-type"], /text\/html/);
  const h = r.body;
  assert.ok(!h.includes("<img src=x") && !h.includes("<script>bad"), "device text is escaped");
  assert.ok(h.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.match(h, /href="\/print\.css"/); assert.match(h, /<script src="\/print\.js"><\/script>/);
  assert.ok(!/<script>(?!bad)/.test(h) && !/\sstyle=/.test(h) && !/\son[a-z]+=/i.test(h.replace(/&lt;.*?&gt;/g, "")), "no inline script, style or handler");
  assert.match(h, /Sri Lanka Standard Time/); assert.match(h, /30 seconds/);
  assert.match(r.headers["content-security-policy"], /default-src 'self'/);
});

/* ---- saved reports ---- */
test("saved reports: create, list, rename, change, delete; encrypted at rest; audited", async () => {
  const s = await setup();
  const c = await s.api("POST", "/api/reports/saved", { name: "  Weekly laptop  ", spec: { period: "week", device: s.dev.deviceId, channel: "Secret channel" } });
  assert.equal(c.code, 201); assert.equal(c.body.name, "Weekly laptop"); assert.deepEqual(c.body.spec, { period: "week", device: s.dev.deviceId, channel: "Secret channel" });
  const raw = s.db.prepare("SELECT enc FROM saved_reports").get().enc;
  assert.ok(!Buffer.from(raw).toString("latin1").includes("Secret channel") && !Buffer.from(raw).toString("latin1").includes("Weekly"), "name and spec are encrypted");
  assert.deepEqual((await s.api("GET", "/api/reports/saved")).body.items.map(i => i.name), ["Weekly laptop"]);
  const u = await s.api("PUT", "/api/reports/saved/" + c.body.id, { name: "Laptop, weekly" });
  assert.equal(u.code, 200); assert.equal(u.body.name, "Laptop, weekly"); assert.equal(u.body.spec.channel, "Secret channel", "renaming keeps the spec");
  const u2 = await s.api("PUT", "/api/reports/saved/" + c.body.id, { spec: { period: "custom", from: "2026-10-01", to: "2026-10-31" } });
  assert.equal(u2.code, 200); assert.equal(u2.body.name, "Laptop, weekly"); assert.equal(u2.body.spec.period, "custom");
  assert.equal((await s.api("DELETE", "/api/reports/saved/" + c.body.id)).code, 200);
  assert.deepEqual((await s.api("GET", "/api/reports/saved")).body.items, []);
  assert.equal((await s.api("DELETE", "/api/reports/saved/" + c.body.id)).code, 404);
  assert.deepEqual(s.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'report_%' ORDER BY rowid").all().map(x => x.action), ["report_saved", "report_updated", "report_updated", "report_deleted"]);
});

test("saved reports: names and specs are validated, names are unique, the count is capped, and unknown ids are 404", async () => {
  const s = await setup();
  const post = b => s.api("POST", "/api/reports/saved", b);
  assert.equal((await post({ name: "", spec: { period: "day" } })).body.error, "bad_name");
  assert.equal((await post({ name: "x".repeat(81), spec: { period: "day" } })).body.error, "bad_name");
  assert.equal((await post({ name: "a\u0007b", spec: { period: "day" } })).body.error, "bad_name");
  assert.equal((await post({ name: "Ok" })).body.error, "bad_spec");
  assert.equal((await post({ name: "Ok", spec: { period: "day", sql: "1" } })).body.field, "spec.sql");
  assert.equal((await post({ name: "Ok", spec: { period: "custom", from: "2026-01-02", to: "2026-01-01" } })).body.error, "bad_range");
  assert.equal((await post({ name: "Ok", spec: { period: "day" }, owner: "x" })).body.error, "unknown_field");
  const nd = await post({ name: "Ok", spec: { period: "day", device: "not-my-device" } });
  assert.equal(nd.code, 404); assert.equal(nd.body.field, "spec.device");
  assert.equal((await post({ name: "Daily", spec: { period: "day" } })).code, 201);
  const dup = await post({ name: "daily", spec: { period: "week" } });
  assert.equal(dup.code, 409); assert.equal(dup.body.error, "name_taken");
  for (let i = 1; i < 50; i++) assert.equal((await post({ name: "R" + i, spec: { period: "day" } })).code, 201);
  const over = await post({ name: "One too many", spec: { period: "day" } });
  assert.equal(over.code, 409); assert.equal(over.body.error, "too_many");
  for (const id of ["nope", "00000000-0000-0000-0000-000000000000", "..%2F..%2Fetc"]) {
    assert.equal((await s.api("PUT", "/api/reports/saved/" + id, { name: "x" })).code, 404, id);
    assert.equal((await s.api("DELETE", "/api/reports/saved/" + id)).code, 404, id);
  }
});

/* ---- authorization ---- */
test("every Reports route is owner-only: no cookie, a device token, or a cross-site write are all refused", async () => {
  const s = await setup();
  const routes = [["GET", "/api/reports?period=day"], ["GET", "/api/reports/export?format=csv&period=day"], ["GET", "/api/reports/export?format=print&period=day"],
    ["GET", "/api/reports/saved"], ["POST", "/api/reports/saved"], ["PUT", "/api/reports/saved/x"], ["DELETE", "/api/reports/saved/x"]];
  for (const [method, url] of routes) {
    assert.equal((await s.app.inject({ method, url, payload: method === "GET" ? undefined : {} })).statusCode, 401, method + " " + url);
    assert.equal((await s.app.inject({ method, url, headers: s.dev.auth, payload: method === "GET" ? undefined : {} })).statusCode, 401, method + " " + url + " with a device token");
  }
  const x = await s.api("POST", "/api/reports/saved", { name: "x", spec: { period: "day" } }, { origin: "https://evil.example" });
  assert.equal(x.code, 403); assert.equal(x.body.error, "bad_origin");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM saved_reports").get().n, 0);
});

test("migration 009 is additive: a database as 008 left it keeps its rows and gains saved_reports; a removed owner takes theirs along", async () => {
  const db = openDb(); migrate(db, { upTo: "008_notifications.sql" });
  db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES ('a1','o@example.com','x',1)").run();
  db.prepare("INSERT INTO devices(id,admin_id,label,status,enrolled_at) VALUES ('d1','a1','Laptop','active',1)").run();
  assert.deepEqual(migrate(db, { upTo: "009_saved_reports.sql" }), ["009_saved_reports.sql"]);
  assert.equal(db.prepare("SELECT label FROM devices WHERE id='d1'").get().label, "Laptop");
  db.prepare("INSERT INTO saved_reports(id,admin_id,enc,created_at,updated_at) VALUES ('r1','a1',x'00',1,1)").run();
  db.prepare("DELETE FROM devices").run(); db.prepare("DELETE FROM admins").run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM saved_reports").get().n, 0);
});

test("toCsv on an empty report still has a header row for every scope", () => {
  const r = { timeZone: "Asia/Colombo", period: { granularity: "day" }, series: [], viewings: [], videos: [], channels: [], byDevice: [], byHour: new Array(24).fill(0) };
  for (const scope of ["days", "viewings", "videos", "channels", "devices"]) assert.equal(toCsv(r, scope).replace(/^﻿/, "").trim().split("\r\n").length, 1, scope);
  assert.equal(toCsv(r, "hours").trim().split("\r\n").length, 25);
});
