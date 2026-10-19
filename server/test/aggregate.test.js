import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKey, weekKey, monthKey, summarize } from "../src/lib/aggregate.js";

const MIN = 60000, DAY = 86400000;
const utc = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);

test("day/week/month keys follow the viewer's timezone, not the server's", () => {
  const t = utc(2026, 3, 10, 23, 30); // Tue 10 Mar 23:30 UTC
  assert.equal(dayKey(t, 0), "2026-03-10");
  assert.equal(dayKey(t, -120), "2026-03-11", "UTC+2 is already the 11th (offset is minutes WEST, so -120)");
  assert.equal(dayKey(t, 300), "2026-03-10", "UTC-5 is still the 10th");
  assert.equal(monthKey(utc(2026, 3, 31, 23, 0), -120), "2026-04", "crosses into April in UTC+2");
  assert.equal(monthKey(utc(2026, 3, 31, 23, 0), 0), "2026-03");
});

test("weeks start on Monday", () => {
  assert.equal(weekKey(utc(2026, 3, 9, 12)), "2026-03-09", "Monday");
  assert.equal(weekKey(utc(2026, 3, 15, 12)), "2026-03-09", "Sunday belongs to the week that began Monday the 9th");
  assert.equal(weekKey(utc(2026, 3, 16, 0, 1)), "2026-03-16");
  assert.equal(weekKey(utc(2026, 1, 1, 12)), "2025-12-29", "weeks can start in the previous year");
});

const items = [
  { deviceId: "d1", deviceLabel: "L1", videoId: "a", title: "A", channel: "X", url: "u/a", startTsAdj: utc(2026, 3, 10, 10), watchedMs: 10 * MIN, completed: true, seeks: 1, pauses: 2 },
  { deviceId: "d2", deviceLabel: "L2", videoId: "a", title: "A", channel: "X", url: "u/a", startTsAdj: utc(2026, 3, 10, 12), watchedMs: 5 * MIN },
  { deviceId: "d2", deviceLabel: "L2", videoId: "b", title: "B", channel: "Y", url: "u/b", startTsAdj: utc(2026, 3, 3, 12), watchedMs: 30 * MIN },
  { deviceId: "d1", deviceLabel: "L1", videoId: "c", title: "", channel: "", url: "", startTsAdj: utc(2025, 12, 1, 12), watchedMs: 60 * MIN }
];
const now = utc(2026, 3, 10, 18);

test("summarize: totals, distinct videos, per-device split, top lists", () => {
  const s = summarize(items, { now });
  assert.deepEqual([s.totalMs, s.sessions, s.videos, s.completions, s.seeks, s.pauses], [105 * MIN, 4, 3, 1, 1, 2]);
  assert.deepEqual(s.byDevice.map(d => [d.deviceId, d.totalMs, d.sessions]), [["d1", 70 * MIN, 2], ["d2", 35 * MIN, 2]]);
  assert.deepEqual(s.topChannels.map(c => c.channel), ["(unknown)", "Y", "X"]);
  assert.deepEqual([s.topVideos[0].videoId, s.topVideos[0].views], ["c", 1]);
  assert.deepEqual(s.topVideos.find(v => v.videoId === "a"), { videoId: "a", title: "A", url: "u/a", totalMs: 15 * MIN, views: 2 });
});

test("summarize: today / 7 / 30 day windows and the series lengths", () => {
  const s = summarize(items, { now });
  assert.equal(s.todayMs, 15 * MIN);
  assert.equal(s.last7Ms, 15 * MIN, "7 days ending 10 Mar is 4-10 Mar: the 3 Mar session (30) is 8 days back, outside");
  assert.equal(s.last30Ms, 45 * MIN, "the December session is outside");
  assert.deepEqual([s.daily.length, s.weekly.length, s.monthly.length], [30, 12, 12]);
  assert.equal(s.daily.at(-1).key, "2026-03-10");
  assert.equal(s.daily.at(-1).value, 15 * MIN);
  assert.equal(s.weekly.at(-1).key, "2026-03-09");
  assert.equal(s.weekly.at(-1).value, 15 * MIN);
  assert.equal(s.weekly.at(-2).value, 30 * MIN, "week of 2 Mar holds the 3 Mar session");
  assert.equal(s.monthly.at(-1).key, "2026-03");
  assert.equal(s.monthly.at(-1).value, 45 * MIN);
  assert.equal(s.monthly.at(-4).key, "2025-12");
  assert.equal(s.monthly.at(-4).value, 60 * MIN);
});

test("summarize honours the timezone when assigning sessions to days", () => {
  const late = [{ deviceId: "d", videoId: "v", startTsAdj: utc(2026, 3, 10, 23, 30), watchedMs: MIN }];
  assert.equal(summarize(late, { now: utc(2026, 3, 11, 1), tzOffsetMin: 0 }).daily.find(d => d.value).key, "2026-03-10");
  assert.equal(summarize(late, { now: utc(2026, 3, 11, 1), tzOffsetMin: -120 }).daily.find(d => d.value).key, "2026-03-11");
});

test("summarize handles empty input", () => {
  const s = summarize([], { now });
  assert.deepEqual([s.totalMs, s.sessions, s.videos, s.todayMs, s.byDevice.length, s.topChannels.length], [0, 0, 0, 0, 0, 0]);
  assert.equal(s.daily.length, 30);
});

test("falls back to startTs when no corrected time is present", () => {
  const s = summarize([{ deviceId: "d", videoId: "v", startTs: utc(2026, 3, 10, 9), watchedMs: MIN }], { now });
  assert.equal(s.todayMs, MIN);
  assert.equal(DAY, 86400000);
});
