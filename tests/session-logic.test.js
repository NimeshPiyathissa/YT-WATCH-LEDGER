"use strict";
// Tests for the pure tracking core: lib/accounting.js, lib/stats.js, lib/util.js.
global.self = global;
require("../lib/util.js");
require("../lib/accounting.js");
require("../lib/stats.js");
const A = global.YTAccounting, S = global.YTStats, U = global.YTUtil;

let p = 0, f = 0;
const eq = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  ok ? p++ : f++;
  console.log((ok ? "  ✓ " : "  ✗ ") + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
};
const thumb = id => "t/" + id;

console.log("clampDelta");
eq("normal delta passes", A.clampDelta(900, 2500), 900);
eq("large delta capped", A.clampDelta(60000, 2500), 2500);
eq("negative -> 0", A.clampDelta(-5, 2500), 0);
eq("NaN -> 0", A.clampDelta(NaN, 2500), 0);
eq("zero -> 0", A.clampDelta(0, 2500), 0);

console.log("mergeSnapshot");
eq("no prev returns copy", A.mergeSnapshot(null, { sessionId: "a", watchedMs: 5 }).watchedMs, 5);
eq("copy is not same object", (() => { const s = { watchedMs: 1 }; return A.mergeSnapshot(null, s) !== s; })(), true);
eq("watchedMs never decreases", A.mergeSnapshot({ watchedMs: 9000 }, { watchedMs: 4000 }).watchedMs, 9000);
eq("watchedMs increases", A.mergeSnapshot({ watchedMs: 1000 }, { watchedMs: 4000 }).watchedMs, 4000);
eq("earliest startTs kept", A.mergeSnapshot({ startTs: 100 }, { startTs: 200 }).startTs, 100);
eq("earlier snapshot startTs wins", A.mergeSnapshot({ startTs: 300 }, { startTs: 200 }).startTs, 200);
eq("missing startTs falls back", A.mergeSnapshot({}, { startTs: 50 }).startTs, 50);
eq("endTs preserved when snap lacks it", A.mergeSnapshot({ endTs: 999 }, { endTs: null }).endTs, 999);
eq("endTs set by snap", A.mergeSnapshot({ endTs: null }, { endTs: 500 }).endTs, 500);
eq("title kept when snap empty", A.mergeSnapshot({ title: "T" }, { title: "" }).title, "T");
eq("title updated when snap has one", A.mergeSnapshot({ title: "T" }, { title: "U" }).title, "U");
eq("channel kept when snap empty", A.mergeSnapshot({ channel: "C" }, { channel: "" }).channel, "C");
eq("merge idempotent", JSON.stringify(A.mergeSnapshot({ watchedMs: 5, startTs: 1 }, { watchedMs: 5, startTs: 1 })), JSON.stringify({ watchedMs: 5, startTs: 1 }));

console.log("rollupVideo");
eq("null for no sessions", A.rollupVideo("v", [], thumb), null);
eq("null for undefined", A.rollupVideo("v", undefined, thumb), null);
const S1 = [
  { sessionId: "a", videoId: "v", title: "Old", channel: "Ch", startTs: 1000, endTs: 2000, watchedMs: 60000, duration: 600 },
  { sessionId: "b", videoId: "v", title: "New", channel: "Ch", startTs: 5000, endTs: 9000, watchedMs: 120000, duration: 600 }
];
const R = A.rollupVideo("v", S1, thumb);
eq("totalMs sums", R.totalMs, 180000);
eq("sessionCount", R.sessionCount, 2);
eq("firstWatched", R.firstWatched, 1000);
eq("lastWatched uses max endTs", R.lastWatched, 9000);
eq("title from latest session", R.title, "New");
eq("channel", R.channel, "Ch");
eq("duration max", R.duration, 600);
eq("percent", R.percent, 30);
eq("thumbnail via fn", R.thumbnail, "t/v");
eq("order independent", A.rollupVideo("v", S1.slice().reverse(), thumb).totalMs, 180000);
eq("percent capped at 100", A.rollupVideo("v", [{ startTs: 1, watchedMs: 999999, duration: 10 }], thumb).percent, 100);
eq("percent null without duration", A.rollupVideo("v", [{ startTs: 1, watchedMs: 5000 }], thumb).percent, null);
eq("lastWatched falls back to startTs", A.rollupVideo("v", [{ startTs: 77, watchedMs: 1 }], thumb).lastWatched, 77);
eq("works without thumbFn", A.rollupVideo("v", [{ startTs: 1, watchedMs: 1 }]).thumbnail, "");
eq("input not mutated", (() => { const c = JSON.stringify(S1); A.rollupVideo("v", S1, thumb); return JSON.stringify(S1) === c; })(), true);

console.log("dailyTotals");
const k = ts => U.dayKey(ts);
const d1 = new Date(2026, 0, 5, 10).getTime(), d2 = new Date(2026, 0, 6, 10).getTime();
const DT = A.dailyTotals([{ startTs: d1, watchedMs: 1000 }, { startTs: d1 + 1000, watchedMs: 2000 }, { startTs: d2, watchedMs: 500 }], k);
eq("sums per day", DT[k(d1)], 3000);
eq("separate day", DT[k(d2)], 500);
eq("empty input", A.dailyTotals([], k), {});

console.log("util");
eq("dayKey format", U.dayKey(new Date(2026, 2, 7, 12).getTime()), "2026-03-07");
eq("fmtDuration seconds", U.fmtDuration(45000), "45s");
eq("fmtDuration minutes", U.fmtDuration(125000), "2m 5s");
eq("fmtDuration hours", U.fmtDuration(3 * 3600000 + 5 * 60000), "3h 5m");
eq("fmtBytes KB", U.fmtBytes(2048), "2.0 KB");
eq("fmtBytes B", U.fmtBytes(12), "12 B");
eq("escapeHtml", U.escapeHtml('<a href="x">&\''), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");

console.log("stats");
const now = new Date(2026, 0, 10, 12).getTime();
const sess = [{ startTs: now - 1000, watchedMs: 5000 }, { startTs: now - 86400000 * 3, watchedMs: 7000 }, { startTs: now - 86400000 * 20, watchedMs: 9000 }];
const vids = [{ videoId: "a", title: "Alpha", channel: "X", totalMs: 10000, lastWatched: 5 }, { videoId: "b", title: "Beta", channel: "Y", totalMs: 30000, lastWatched: 9 }, { videoId: "c", title: "Gamma", channel: "X", totalMs: 5000, lastWatched: 7 }];
const SM = S.summarize(vids, sess, now, k);
eq("todayMs", SM.todayMs, 5000);
eq("last7Ms excludes old", SM.last7Ms, 12000);
eq("14 day buckets", SM.days.length, 14);
eq("totalMs from videos", SM.totalMs, 45000);
eq("top channel", SM.channels[0].channel, "Y");
eq("channels merged", SM.channels.find(c => c.channel === "X").totalMs, 15000);
eq("search by channel", S.searchVideos(vids, "x").map(v => v.videoId), ["c", "a"]);
eq("search empty returns all newest first", S.searchVideos(vids, "").map(v => v.videoId), ["b", "c", "a"]);


// ---------- live tracking state machine (pause / seek / rewind / ads / rewatch) ----------
console.log("step: playback, pause, seek");
const obsAt = (pos, o) => Object.assign({ positionSec: pos, duration: 600, playing: true, ended: false, adShowing: false, rate: 1 }, o);
// Simulate a viewing: list of [positionSec, overrides, dtMs]; the first tick has dt 0.
function sim(ticks, kind) {
  const sess = A.newSession("s", "vid", kind, 1000), st = A.newTrackState();
  ticks.forEach((t, i) => A.step(sess, st, obsAt(t[0], t[1]), t[2] === undefined ? (i ? 1000 : 0) : t[2]));
  return sess;
}
const steady = Array.from({ length: 11 }, (_, i) => [10 + i]); // 10 s of normal playback from 0:10
let r1 = sim(steady);
eq("steady playback credits 10 s", r1.watchedMs, 10000);
eq("steady playback has no seeks/pauses", [r1.seeks, r1.rewinds, r1.pauses], [0, 0, 0]);
eq("start/position/furthest tracked", [r1.startSec, r1.positionSec, r1.furthestSec], [10, 20, 20]);
eq("duration captured", r1.duration, 600);
eq("incomplete is not completed", r1.completed, false);

let r2 = sim([[10], [11], [12, { playing: false }], [12, { playing: false }], [12, { playing: false }], [13], [14]]);
eq("paused time is not credited", r2.watchedMs, 3000);
eq("a pause is counted once", r2.pauses, 1);
eq("pausing is not a seek", r2.seeks, 0);

let r3 = sim([[10], [11], [71], [72]]); // jump forward 60 s
eq("forward seek counted", [r3.seeks, r3.rewinds], [1, 0]);
eq("skipped footage is not credited", r3.watchedMs, 3000);
eq("furthest follows a forward seek", r3.furthestSec, 72);

let r4 = sim([[100], [101], [102], [30], [31]]); // jump back 72 s
eq("backward seek counted as rewind", [r4.seeks, r4.rewinds], [1, 1]);
eq("furthest survives a rewind", [r4.positionSec, r4.furthestSec], [31, 102]);

let r5 = sim([[10], [12, { rate: 2 }], [14, { rate: 2 }], [16, { rate: 2 }]]);
eq("2x playback is not mistaken for seeking", r5.seeks, 0);

let r6 = sim([[10], [40, {}, 30000], [70, {}, 30000]]); // throttled background timer: 30 s per tick, position kept pace
eq("throttled timers are not seeks", r6.seeks, 0);
eq("a long gap credits at most one clamped tick each", r6.watchedMs, 2 * A.MAX_GAP_MS);

let r7 = sim([[10], [11], [0, { adShowing: true, duration: 15, playing: true }], [5, { adShowing: true, duration: 15, playing: true }], [12], [13]]);
eq("ad time is not credited", r7.watchedMs, 3000);
eq("ad's own duration/position are ignored", [r7.duration, r7.positionSec], [600, 13]);
eq("returning from an ad is not a seek or pause", [r7.seeks, r7.pauses], [0, 0]);

console.log("step: completion and rewatch");
let r8 = sim([[540], [541], [542]]);
eq("90% of duration marks completed", r8.completed, true);
let r9 = sim([[10], [11], [600, { ended: true, playing: false }]]);
eq("ended marks completed", r9.completed, true);
eq("ending is not a pause", r9.pauses, 0);
eq("shorts get a shorts url", A.newSession("x", "abc", "shorts", 1).url, "https://www.youtube.com/shorts/abc");
eq("watch url", A.videoUrl("abc", "watch"), "https://www.youtube.com/watch?v=abc");
eq("unknown kind falls back to watch", A.newSession("x", "abc", "weird", 1).kind, "watch");

const view1 = Object.assign(sim([[0], [1], [2], [570]]), { sessionId: "a", startTs: 1000, endTs: 2000 }); // seek into the final stretch -> completed
const view2 = Object.assign(sim([[0], [1], [2]]), { sessionId: "b", startTs: 9000, endTs: 9500 });
const roll = A.rollupVideo("vid", [view1, view2], () => "t");
eq("rewatch = viewings after the first", roll.rewatches, 1);
eq("completions counted across viewings", roll.completions, 1);
eq("rollup sums seeks", roll.seeks, view1.seeks + view2.seeks);
eq("rollup keeps furthest and progress", [roll.furthestSec, roll.progress], [570, 95]);
eq("rollup carries url", roll.url, "https://www.youtube.com/watch?v=vid");

console.log("privacy toggles");
const full = Object.assign(sim([[10], [11], [90]]), { title: "T", channel: "C" });
const noTitle = A.applyPrivacy(full, { collect_title: false });
eq("title blanked when disabled", [noTitle.title, noTitle.channel, noTitle.url !== ""], ["", "C", true]);
const noUrl = A.applyPrivacy(full, { collect_url: false, collect_channel: false });
eq("url and channel blanked when disabled", [noUrl.url, noUrl.channel, noUrl.title], ["", "", "T"]);
const noDetail = A.applyPrivacy(full, { collect_detail: false });
eq("detail blanked when disabled", [noDetail.seeks, noDetail.furthestSec, noDetail.startSec, noDetail.completed], [0, 0, null, false]);
eq("watch time is kept when detail is disabled", noDetail.watchedMs, full.watchedMs);
eq("undefined config keeps everything", JSON.stringify(A.applyPrivacy(full, {})), JSON.stringify(full));
eq("applyPrivacy does not mutate", full.title, "T");

console.log("mergeSnapshot: revisions and counters");
eq("rev keeps the highest", A.mergeSnapshot({ rev: 5 }, { rev: 3 }).rev, 5);
eq("rev advances", A.mergeSnapshot({ rev: 3 }, { rev: 4 }).rev, 4);
eq("counters never decrease", (m => [m.seeks, m.pauses, m.rewinds, m.furthestSec])(A.mergeSnapshot({ seeks: 4, pauses: 2, rewinds: 1, furthestSec: 90 }, { seeks: 1, pauses: 0, rewinds: 0, furthestSec: 20 })), [4, 2, 1, 90]);
eq("completed is sticky", A.mergeSnapshot({ completed: true }, { completed: false }).completed, true);
eq("startSec is kept from the first snapshot", A.mergeSnapshot({ startSec: 30 }, { startSec: 90 }).startSec, 30);
eq("url kept when later snapshot lacks it", A.mergeSnapshot({ url: "u" }, { url: "" }).url, "u");

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
