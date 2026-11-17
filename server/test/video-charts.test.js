// The Video Details charts: pure string builders, so they can be checked without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const sb = {}; sb.self = sb; vm.createContext(sb);
for (const f of ["vendor/util.js", "vendor/playback.js", "video-charts.js"]) vm.runInContext(fs.readFileSync(path.join(WEB, f), "utf8"), sb, { filename: f });
const C = sb.WLVideoCharts, S = 1000, MIN = 60 * S;
const T0 = Date.UTC(2026, 10, 3, 10, 0, 0);

const noInline = html => assert.equal(/\sstyle=|<script|\son\w+=/.test(html), false, "no inline style, script or handler (the page's CSP forbids them)");

test("watch activity: hourly bars from the recorded runs, a run crossing the hour is split in proportion", () => {
  const runs = [{ ts: T0 + 50 * MIN, ms: 20 * MIN }, { ts: T0 + 3 * 3600 * S, ms: 10 * MIN }];
  const html = C.activity(runs, "UTC");
  assert.match(html, /Active watch time per hour/);
  assert.match(html, /<title>10 AM: 10\.0 min playing<\/title>/);
  assert.match(html, /<title>11 AM: 10\.0 min playing<\/title>/);
  assert.match(html, /<title>12 PM: 0 s playing<\/title>/);
  assert.match(html, /<title>1 PM: 10\.0 min playing<\/title>/);
  assert.match(html, /30\.0 min playing in total/);
  noInline(html);
});

test("watch activity: spans longer than two days switch to daily bars on the chosen zone's calendar", () => {
  const runs = [{ ts: Date.UTC(2026, 10, 1, 20, 0), ms: 60 * MIN }, { ts: Date.UTC(2026, 10, 5, 3, 0), ms: 30 * MIN }];
  const utc = C.activity(runs, "UTC"), colombo = C.activity(runs, "Asia/Colombo");
  assert.match(utc, /per day/);
  assert.match(utc, /<title>Nov 1: 1\.0 h playing<\/title>/);
  assert.match(colombo, /<title>Nov 2: 1\.0 h playing<\/title>/, "20:00 UTC is already the next day in Colombo");
  assert.match(utc, /Nov 5: 30\.0 min/);
});

test("watch activity across a daylight-saving change does not skip or double a day", () => {
  const runs = [1, 2, 3, 4].map(d => ({ ts: Date.UTC(2026, 10, d, 12, 0), ms: 10 * MIN }));        // New York falls back on Nov 1
  const html = C.activity(runs, "America/New_York");
  assert.equal((html.match(/<rect class="vd-bar/g) || []).length, 4);
  assert.equal((html.match(/10\.0 min playing<\/title>/g) || []).length, 4);
});

test("empty data gives a plain message, never a broken chart", () => {
  assert.match(C.activity([], "UTC"), /No playback runs/);
  assert.match(C.coverage([], 600), /No watched content/);
  assert.match(C.pauseDistribution([{ label: "< 10 s", count: 0 }]), /No completed pauses/);
  assert.match(C.breakdown({ activeMs: 0, pausedMs: 0 }), /No time recorded/);
  assert.match(C.sessionsComparison([], "UTC"), /No viewings/);
  assert.match(C.progress({ sessionId: "x", startedAt: T0 }, [], [], 600), /No playback runs/);
});

test("progress timeline: position against time with pauses shaded; an unresolved pause is drawn differently", () => {
  const runs = [{ sessionId: "a", ts: T0, ms: 60 * S, from: 0, to: 60 }, { sessionId: "a", ts: T0 + 210 * S, ms: 30 * S, from: 60, to: 90 }, { sessionId: "b", ts: T0, ms: 5 * S, from: 0, to: 5 }];
  const pauses = [{ sessionId: "a", pausedAt: T0 + 60 * S, resumedAt: T0 + 210 * S, durationMs: 150 * S, status: "resumed" }, { sessionId: "a", pausedAt: T0 + 240 * S, resumedAt: null, minDurationMs: 40 * S, status: "unresolved" }];
  const html = C.progress({ sessionId: "a", startedAt: T0 }, runs, pauses, 600);
  assert.match(html, /<path class="vd-line" d="M0\.0,/);
  assert.equal((html.match(/class="vd-band"/g) || []).length, 1);
  assert.equal((html.match(/vd-band-unres/g) || []).length, 1);
  assert.match(html, /Pause: 2 minutes 30 seconds/);
  assert.match(html, /Unresolved pause \(at least 40 seconds\)/);
  assert.match(html, /furthest 1:30 of 10:00/);
  assert.equal((html.match(/L/g) || []).length >= 3, true);
  noInline(html);
});

test("coverage strip: shows only what was played and says that completion is not full viewing", () => {
  const html = C.coverage([{ from: 0, to: 60 }, { from: 300, to: 360 }], 600);
  assert.equal((html.match(/class="vd-cover-fill"/g) || []).length, 2);
  assert.match(html, /2:00<\/b> of 10:00 actually played \(20%\)/);
  assert.match(html, /does not mean every part was watched/);
});

test("pause distribution, breakdown and session comparison use the figures they are given", () => {
  const dist = C.pauseDistribution([{ label: "< 10 s", count: 2 }, { label: "10–30 s", count: 0 }, { label: "1–5 min", count: 5 }]);
  assert.match(dist, /<title>1–5 min: 5<\/title>/);
  assert.match(dist, /2 of &lt; 10 s, 5 of 1–5 min/);
  const bd = C.breakdown({ activeMs: 600 * S, pausedMs: 300 * S, bufferingMs: 100 * S, adMs: 0, unresolvedPausedMs: 0 });
  assert.match(bd, /Playing<\/span><b class="num">10 minutes<\/b><em class="num">60%<\/em>/);
  assert.match(bd, /Paused<\/span><b class="num">5 minutes<\/b><em class="num">30%<\/em>/);
  assert.equal(/Ads/.test(bd), false, "a zero part is not listed");
  const sc = C.sessionsComparison([{ startedAt: T0, completed: true, activeMs: 600 * S, pausedMs: 150 * S, bufferingMs: 0, unresolvedPausedMs: 0 }, { startedAt: T0 + 86400000, activeMs: 300 * S, pausedMs: 0, bufferingMs: 0 }], "UTC");
  assert.match(sc, /Nov 3 10:00 AM ✓/);
  assert.match(sc, /10\.0 min <small>playing<\/small> · 2\.5 min <small>paused<\/small>/);
  noInline(dist + bd + sc);
});

test("text from recorded data is escaped in chart output", () => {
  const html = C.sessionsComparison([{ startedAt: T0, activeMs: 1000, pausedMs: 0, bufferingMs: 0 }], "<img src=x onerror=alert(1)>");
  assert.equal(html.includes("<img"), false);
});

test("the page's assets obey the CSP (no inline style, script or handler) and are wired into the dashboard", () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  for (const f of ["video.css", "vendor/playback.js", "video-charts.js", "video.js"]) assert.ok(html.includes(f), f + " is referenced by index.html");
  assert.ok(html.indexOf("video.js") < html.indexOf("app.js"), "video.js is loaded before app.js (it reads window.WL lazily)");
  for (const f of ["video.js", "video-charts.js"]) {
    const src = fs.readFileSync(path.join(WEB, f), "utf8");
    assert.equal(/\sstyle="|\sstyle=\\"|onclick=|onerror=|onload=|javascript:|eval\(|new Function|document\.write/.test(src), false, f);
  }
});

test("v0.8 dashboard assets (ui.css, analytics.js, health.js) are wired in, load before app.js, and obey the CSP", () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  for (const f of ["ui.css", "analytics.js", "health.js", "security.js", "notifications.js", "settings-studio.js", "session.js", "device-center.js"]) assert.ok(html.includes(f), f + " is referenced by index.html");
  assert.ok(html.indexOf("analytics.js") < html.indexOf("app.js") && html.indexOf("health.js") < html.indexOf("app.js"), "page modules load before app.js");
  for (const f of ["analytics.js", "health.js", "security.js", "notifications.js", "settings-studio.js", "session.js", "device-center.js", "app.js", "video.js"]) {
    const src = fs.readFileSync(path.join(WEB, f), "utf8");
    assert.equal(/\sstyle="|\sstyle=\\"|onclick=|onerror=|onload=|javascript:|eval\(|new Function|document\.write/.test(src), false, f);
  }
  for (const id of ["#/analytics", "#/health"]) assert.ok(html.includes(`href="${id}"`), id + " is in the navigation");
});
