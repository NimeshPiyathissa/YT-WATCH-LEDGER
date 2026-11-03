import "./env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAnalytics, bucketStart, nextBucketStart, bucketKey, dayStart, tzOffsetMs, autoGranularity } from "../src/lib/analytics.js";

const H = 3600000, D = 86400000, MIN = 60000;
const TZ = "Asia/Colombo"; // UTC+05:30, no daylight saving
// 2026-03-02 00:00 in Colombo = 2026-03-01T18:30:00Z (a Monday)
const MON = Date.UTC(2026, 2, 1, 18, 30);
const iv = (deviceId, videoId, start, end, extra = {}) => ({ deviceId, sessionId: extra.sessionId || deviceId + videoId + start, videoId, title: extra.title || videoId, channel: extra.channel === undefined ? "Chan" : extra.channel, start, end });
const run = (intervals, from, to, o = {}) => computeAnalytics({ intervals, from, to, granularity: o.granularity || "day", labels: { a: "Laptop A", b: "Laptop B" }, sessions: o.sessions || [] });

test("zone helpers use Asia/Colombo, not the machine zone", () => {
  assert.equal(tzOffsetMs(MON, TZ), 5.5 * H);
  assert.equal(dayStart(MON + 7 * H, TZ), MON);
  assert.equal(dayStart(MON - 1, TZ), MON - D);
  assert.equal(bucketStart(MON + 3 * D + 5 * H, "week", TZ), MON, "weeks start on Monday");
  assert.equal(bucketStart(MON + 3 * D, "month", TZ), Date.UTC(2026, 1, 28, 18, 30), "March 2026 starts at 28 Feb 18:30Z");
  assert.equal(nextBucketStart(MON, "day", TZ), MON + D);
  assert.equal(nextBucketStart(MON, "week", TZ), MON + 7 * D);
  assert.equal(nextBucketStart(Date.UTC(2026, 1, 28, 18, 30), "month", TZ), Date.UTC(2026, 2, 31, 18, 30));
  assert.equal(bucketKey(MON, "day", TZ), "2026-03-02");
  assert.equal(bucketKey(MON, "month", TZ), "2026-03");
  assert.equal(autoGranularity(0, 30 * D), "day"); assert.equal(autoGranularity(0, 100 * D), "week"); assert.equal(autoGranularity(0, 300 * D), "month");
});

test("a simple interval is counted once and lands in the right day", () => {
  const r = run([iv("a", "v1", MON + 10 * H, MON + 10 * H + 30 * MIN)], MON, MON + 3 * D);
  assert.equal(r.totals.watchMs, 30 * MIN);
  assert.deepEqual(r.series.map(s => s.watchMs), [30 * MIN, 0, 0]);
  assert.equal(r.series[0].key, "2026-03-02");
  assert.equal(r.totals.sessions, 1); assert.equal(r.totals.videos, 1); assert.equal(r.totals.activeDays, 1);
  assert.equal(r.byHour[10], 30 * MIN, "10:00 local hour");
  assert.equal(r.byWeekday[0], 30 * MIN, "Monday");
});

test("an interval that crosses local midnight is split between the two days", () => {
  const r = run([iv("a", "v1", MON + 23 * H + 40 * MIN, MON + 24 * H + 20 * MIN)], MON, MON + 2 * D);
  assert.deepEqual(r.series.map(s => s.watchMs), [20 * MIN, 20 * MIN]);
  assert.equal(r.totals.activeDays, 2);
  assert.equal(r.byHour[23], 20 * MIN); assert.equal(r.byHour[0], 20 * MIN);
});

test("an interval that crosses the range edges is clipped to the range", () => {
  const r = run([iv("a", "v1", MON - H, MON + H)], MON, MON + D);
  assert.equal(r.totals.watchMs, H);
});

test("overlapping intervals on one device are counted once (two tabs, a duplicated upload)", () => {
  const r = run([iv("a", "v1", MON + H, MON + 3 * H, { sessionId: "s1" }), iv("a", "v2", MON + 2 * H, MON + 4 * H, { sessionId: "s2" }), iv("a", "v1", MON + H, MON + 3 * H, { sessionId: "s1dup" })], MON, MON + D);
  assert.equal(r.totals.watchMs, 3 * H, "union of [1h,4h] is 3h");
  assert.equal(r.totals.overlapRemovedMs, 3 * H, "raw 2+2+2 = 6h, union 3h");
  assert.equal(r.topVideos.reduce((a, v) => a + v.watchMs, 0), r.totals.watchMs, "per-video totals add up to the device total");
  assert.equal(r.topChannels.reduce((a, c) => a + c.watchMs, 0), r.totals.watchMs);
});

test("an overlapping span is shared equally between the videos playing in it", () => {
  const r = run([iv("a", "v1", MON, MON + 2 * H), iv("a", "v2", MON + H, MON + 3 * H)], MON, MON + D);
  const by = Object.fromEntries(r.topVideos.map(v => [v.videoId, v.watchMs]));
  assert.equal(by.v1, 1.5 * H); assert.equal(by.v2, 1.5 * H);
});

test("different devices add up: they are different screens", () => {
  const r = run([iv("a", "v1", MON, MON + H), iv("b", "v1", MON, MON + H)], MON, MON + D);
  assert.equal(r.totals.watchMs, 2 * H);
  assert.equal(r.byDevice.length, 2);
  assert.deepEqual(r.byDevice.map(d => d.share), [50, 50]);
  assert.ok(r.byDevice[0].label.startsWith("Laptop"));
  assert.equal(r.totals.overlapRemovedMs, 0);
});

test("touching intervals are not an overlap", () => {
  const r = run([iv("a", "v1", MON, MON + H), iv("a", "v2", MON + H, MON + 2 * H)], MON, MON + D);
  assert.equal(r.totals.watchMs, 2 * H); assert.equal(r.totals.overlapRemovedMs, 0);
});

test("comparison with the previous period of the same length", () => {
  const prev = iv("a", "v1", MON - D + H, MON - D + 2 * H);          // 1 h in the previous day
  const cur = iv("a", "v1", MON + H, MON + 2 * H + 30 * MIN);        // 1.5 h in the current day
  const r = run([prev, cur], MON, MON + D);
  assert.equal(r.comparison.watchMs, H); assert.equal(r.comparison.deltaMs, 30 * MIN); assert.equal(r.comparison.deltaPct, 50); assert.equal(r.comparison.trend, "up");
  const none = run([cur], MON, MON + D);
  assert.equal(none.comparison.deltaPct, null, "no previous data: the percentage is unknown, not infinite");
  assert.equal(none.comparison.trend, "none");
  const flat = run([iv("a", "v1", MON - D, MON - D + H), iv("a", "v1", MON, MON + H)], MON, MON + D);
  assert.equal(flat.comparison.trend, "flat");
});

test("weekly and monthly series are bucketed in local weeks and months", () => {
  const items = [iv("a", "v1", MON + H, MON + 2 * H), iv("a", "v1", MON + 6 * D + H, MON + 6 * D + 2 * H), iv("a", "v1", MON + 7 * D + H, MON + 7 * D + 3 * H)];
  const w = run(items, MON, MON + 14 * D, { granularity: "week" });
  assert.deepEqual(w.series.map(s => s.watchMs), [2 * H, 2 * H]);
  const m = run(items, Date.UTC(2026, 1, 28, 18, 30), Date.UTC(2026, 3, 30, 18, 30), { granularity: "month" });
  assert.deepEqual(m.series.map(s => s.key), ["2026-03", "2026-04"]);
  assert.equal(m.series[0].watchMs + m.series[1].watchMs, 4 * H);
});

test("top videos and channels are ordered, ties break by id, unknown channels are named", () => {
  const r = run([iv("a", "vb", MON, MON + H, { channel: "" }), iv("a", "va", MON + 2 * H, MON + 3 * H, { channel: "" }), iv("a", "vc", MON + 4 * H, MON + 7 * H, { channel: "Big" })], MON, MON + D);
  assert.deepEqual(r.topVideos.map(v => v.videoId), ["vc", "va", "vb"]);
  assert.deepEqual(r.topChannels.map(c => c.channel), ["Big", "(unknown)"]);
});

test("session summary uses sessions started in the range; empty input is all zeros", () => {
  const r = run([iv("a", "v1", MON, MON + H)], MON, MON + D, { sessions: [{ start: MON, completed: true, pauses: 2, seeks: 1 }, { start: MON - D, completed: true, pauses: 9, seeks: 9 }] });
  assert.equal(r.totals.completed, 1); assert.equal(r.totals.pauses, 2); assert.equal(r.totals.seeks, 1);
  const z = run([], MON, MON + D);
  assert.equal(z.totals.watchMs, 0); assert.equal(z.totals.avgSessionMs, 0); assert.equal(z.topVideos.length, 0); assert.equal(z.comparison.deltaPct, 0);
});

test("the machine time zone never changes a result", () => {
  const items = [iv("a", "v1", MON + 23 * H + 40 * MIN, MON + 24 * H + 20 * MIN)];
  const before = JSON.stringify(run(items, MON, MON + 2 * D));
  const keep = process.env.TZ; process.env.TZ = "America/Los_Angeles";
  try { assert.equal(JSON.stringify(run(items, MON, MON + 2 * D)), before); } finally { if (keep === undefined) delete process.env.TZ; else process.env.TZ = keep; }
});

test("a very busy input stays fast", () => {
  const items = [];
  for (let i = 0; i < 20000; i++) { const s = MON + (i * 30 * MIN) % (60 * D); items.push(iv("a", "v" + (i % 50), s, s + 10 * MIN, { sessionId: "s" + i })); }
  const t = Date.now(); const r = run(items, MON, MON + 60 * D);
  assert.ok(Date.now() - t < 8000, "took " + (Date.now() - t) + " ms");
  assert.ok(r.totals.watchMs > 0);
});
