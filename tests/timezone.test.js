"use strict";
// Display time zone: every date and time is Sri Lanka Standard Time (Asia/Colombo, UTC+05:30), converted from UTC by Intl,
// independent of the machine's zone, and never involved in a duration calculation.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
global.self = global; require("../lib/util.js"); require("../lib/playback.js");
const U = global.YTUtil, P = global.YTPlayback;
const S = 1000, ROOT = path.join(__dirname, "..");

test("UTC converts to Asia/Colombo in the required display format", () => {
  assert.equal(U.TZ, "Asia/Colombo");
  assert.equal(U.fmtDateTime(Date.UTC(2026, 10, 3, 7, 15, 2)), "November 3, 2026 · 12:45:02 PM (SLST)");
  assert.equal(P.formatStamp(Date.UTC(2026, 10, 3, 7, 15, 2)), "November 3, 2026 · 12:45:02 PM (SLST)");
  assert.equal(U.fmtDateTime(Date.UTC(2026, 10, 3, 7, 15, 2) + 123, true), "November 3, 2026 · 12:45:02.123 PM (SLST)");
  assert.equal(U.fmtDate(Date.UTC(2026, 0, 1, 0, 0, 0)), "January 1, 2026");
  assert.equal(U.fmtTime(Date.UTC(2026, 0, 1, 0, 0, 0)), "5:30:00 AM");
  assert.equal(/[  ]/.test(U.fmtDateTime(Date.now())), false, "plain spaces only");
  // no daylight saving: the offset is +05:30 all year
  for (const m of [0, 3, 6, 9]) assert.equal(U.fmtTime(Date.UTC(2026, m, 15, 12, 0, 0)), "5:30:00 PM");
});

test("midnight rollover happens at 00:00 in Colombo (18:30 UTC), not at UTC midnight", () => {
  assert.equal(U.fmtDateTime(Date.UTC(2026, 10, 3, 18, 29, 59)), "November 3, 2026 · 11:59:59 PM (SLST)");
  assert.equal(U.fmtDateTime(Date.UTC(2026, 10, 3, 18, 30, 0)), "November 4, 2026 · 12:00:00 AM (SLST)");
  assert.equal(U.fmtDateTime(Date.UTC(2026, 10, 3, 23, 59, 59)), "November 4, 2026 · 5:29:59 AM (SLST)");   // UTC still Nov 3
  assert.equal(U.fmtDateTime(Date.UTC(2026, 11, 31, 18, 30, 0)), "January 1, 2027 · 12:00:00 AM (SLST)");  // year rollover
  assert.equal(U.dayKey(Date.UTC(2026, 10, 3, 18, 29, 59)), "2026-11-03");
  assert.equal(U.dayKey(Date.UTC(2026, 10, 3, 18, 30, 0)), "2026-11-04");
  assert.equal(P.dayKey(Date.UTC(2026, 10, 3, 18, 30, 0)), "2026-11-04");
});

test("a picked date is that day in Sri Lanka: 00:00:00.000 to 23:59:59.999 SLST", () => {
  assert.equal(U.dayStart("2026-11-04"), Date.UTC(2026, 10, 3, 18, 30, 0));
  assert.equal(U.dayEnd("2026-11-04"), Date.UTC(2026, 10, 4, 18, 29, 59, 999));
  assert.equal(U.dayEnd("2026-11-04") - U.dayStart("2026-11-04"), 86400000 - 1);
  assert.equal(U.dayStart(""), ""); assert.equal(U.dayEnd("not a date"), "");
  assert.equal(U.dayStart("2026-11-04"), P.zonedToUtc(2026, 11, 4, 0, 0, 0, 0, "Asia/Colombo"), "extension and page helpers agree");
  assert.equal(U.fmtDateTime(U.dayStart("2026-11-04")), "November 4, 2026 · 12:00:00 AM (SLST)");
});

test("the result does not depend on the machine's time zone", () => {
  const probe = "global.self=global; require('./lib/util.js'); require('./lib/playback.js'); const t=Date.UTC(2026,10,3,18,30,0);" +
    "console.log(JSON.stringify([self.YTUtil.fmtDateTime(t), self.YTPlayback.formatStamp(t), self.YTUtil.dayKey(t), self.YTUtil.dayStart('2026-11-04')]))";
  const outs = ["UTC", "America/Los_Angeles", "Pacific/Auckland", "Asia/Kolkata", "Asia/Colombo"].map(tz =>
    cp.execFileSync(process.execPath, ["-e", probe], { cwd: ROOT, env: Object.assign({}, process.env, { TZ: tz }) }).toString().trim());
  assert.equal(new Set(outs).size, 1, outs.join("\n"));
  assert.deepEqual(JSON.parse(outs[0]), ["November 4, 2026 · 12:00:00 AM (SLST)", "November 4, 2026 · 12:00:00 AM (SLST)", "2026-11-04", Date.UTC(2026, 10, 3, 18, 30, 0)]);
});

test("many pause/resume events each show their own correct Sri Lanka time, across midnight", () => {
  // viewing starts 23:55:00 SLST on Nov 3 (18:25:00 UTC) and runs past midnight with ten pause/resume cycles
  const t0 = Date.UTC(2026, 10, 3, 18, 25, 0), rec = P.createRecorder({ sessionId: "m", videoId: "v" }), evs = [];
  let t = t0, pos = 0, paused = true;
  const feed = h => evs.push(...rec.observe({ pos, rate: 1, paused, duration: 3600 }, t, h));
  paused = false; feed("play");
  for (let i = 0; i < 10; i++) { t += 60 * S; pos += 60; paused = true; feed("pause"); t += 30 * S; paused = false; feed("play"); }
  const shown = evs.map(e => P.formatStamp(e.ts));
  assert.equal(shown[0], "November 3, 2026 · 11:55:00 PM (SLST)");
  const pauses = evs.filter(e => e.type === "VIDEO_PAUSED").map(e => P.formatStamp(e.ts));
  assert.equal(pauses.length, 10);
  assert.equal(pauses[0], "November 3, 2026 · 11:56:00 PM (SLST)");
  assert.equal(pauses[2], "November 3, 2026 · 11:59:00 PM (SLST)", "still the 3rd");
  assert.equal(pauses[3], "November 4, 2026 · 12:00:30 AM (SLST)", "the 4th pause is 30 s after SLST midnight (18:30:30 UTC)");
  assert.equal(pauses[9], "November 4, 2026 · 12:09:30 AM (SLST)");
  assert.ok(evs.every((e, i) => i === 0 || e.ts > evs[i - 1].ts), "order is by absolute time");
});

test("durations come from absolute timestamps and are identical whatever is displayed", () => {
  const t0 = Date.UTC(2026, 10, 3, 18, 29, 0);           // 11:59:00 PM SLST
  const mk = (seq, type, dt, pos, meta) => ({ id: "d:e" + seq, sessionId: "d", videoId: "v", seq, type, ts: t0 + dt * S, pos, rate: 1, prev: "none", next: "none", meta: meta || {} });
  const f = P.fold([mk(1, "VIDEO_STARTED", 0, 0), mk(2, "VIDEO_PAUSED", 30, 30), mk(3, "VIDEO_RESUMED", 180, 30), mk(4, "VIDEO_PAUSED", 200, 50), mk(5, "VIDEO_SESSION_ENDED", 290, 50, { reason: "pagehide" })]);
  // the first pause is 11:59:30 PM -> 12:02:00 AM next day (crossing SLST midnight): exactly 150 s
  assert.equal(P.formatStamp(f.pauses[0].pausedAt), "November 3, 2026 · 11:59:30 PM (SLST)");
  assert.equal(P.formatStamp(f.pauses[0].resumedAt), "November 4, 2026 · 12:02:00 AM (SLST)");
  assert.equal(f.pauses[0].durationMs, 150 * S);
  assert.equal(f.pauses[1].durationMs, 90 * S);
  assert.deepEqual([f.metrics.activeMs, f.metrics.pausedMs, f.metrics.elapsedMs], [50 * S, 240 * S, 290 * S]);
  assert.equal(f.metrics.timeToCompleteMs, null);
  // formatting the same events in other zones changes the text, never the numbers
  const text = ["Asia/Colombo", "UTC", "America/New_York"].map(z => P.formatStamp(f.pauses[0].pausedAt, z));
  assert.equal(new Set(text).size, 3);
  assert.equal(f.pauses[0].durationMs, 150 * S);
});

test("records stored before this change keep their UTC values and display correctly", () => {
  // fixtures: timestamps exactly as the 0.6/0.7 databases hold them (UTC ms); nothing is rewritten, only displayed
  const stored = [Date.UTC(2026, 9, 31, 5, 9, 12), Date.UTC(2026, 10, 2, 11, 30, 0), Date.UTC(2026, 5, 15, 0, 0, 0)];
  const before = stored.slice();
  const shown = stored.map(ts => U.fmtDateTime(ts));
  assert.deepEqual(shown, ["October 31, 2026 · 10:39:12 AM (SLST)", "November 2, 2026 · 5:00:00 PM (SLST)", "June 15, 2026 · 5:30:00 AM (SLST)"]);
  assert.deepEqual(stored, before, "formatting does not modify the stored numbers");
});

test("no source file reads the browser's or machine's time zone", () => {
  const files = [];
  const walk = d => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (n === "node_modules" || n === "dist" || n === ".git" || n === "test" || n === "tests" || n === "docs" || n === "data" || n === "vendor") continue; const st = fs.statSync(f); if (st.isDirectory()) walk(f); else if (/\.(js|html|mjs)$/.test(n)) files.push(f); } };
  walk(ROOT);
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8").split("\n");
    src.forEach((line, i) => { if (/toLocale(Date|Time)?String|getTimezoneOffset|resolvedOptions\(\)\.timeZone|\.getHours\(|\.getMinutes\(|\.getDate\(|\.getFullYear\(|\.getMonth\(/.test(line) && !/scripts\/restore\.js/.test(f)) bad.push(path.relative(ROOT, f) + ":" + (i + 1)); });
  }
  assert.deepEqual(bad, []);
});
