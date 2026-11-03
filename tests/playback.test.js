"use strict";
// Pure playback model: recorder (DOM observations -> events), fold (events -> metrics), validation, formatting.
const test = require("node:test"), assert = require("node:assert/strict");
global.self = global; require("../lib/playback.js");
const P = global.YTPlayback;

const T0 = Date.UTC(2026, 10, 3, 10, 0, 0); // 2026-11-03 10:00:00 UTC
const S = 1000;

// A scripted player: advances a virtual clock and feeds the recorder the way the content script does.
function player(opts) {
  opts = opts || {};
  const rec = P.createRecorder({ sessionId: opts.sessionId || "s1", videoId: "vid1" });
  const p = { t: T0, pos: opts.pos || 0, rate: 1, paused: true, ended: false, seeking: false, waiting: false, adShowing: false, hidden: false, duration: opts.duration || 600 };
  const events = [];
  const obs = () => ({ pos: p.pos, rate: p.rate, paused: p.paused, ended: p.ended, seeking: p.seeking, waiting: p.waiting, adShowing: p.adShowing, hidden: p.hidden, duration: p.duration });
  const feed = (hint) => { for (const e of rec.observe(obs(), p.t, hint)) events.push(e); };
  const api = {
    rec, events, p,
    // wall time passes; the media position advances only while actually playing
    wait(sec) { if (!p.paused && !p.waiting && !p.ended && !p.adShowing) p.pos += sec * p.rate; p.t += sec * S; return api; },
    play() { p.paused = false; feed("play"); return api; },
    pause() { p.paused = true; feed("pause"); return api; },
    seek(to) { p.seeking = true; p.pos = to; feed("seeking"); p.seeking = false; feed("seeked"); return api; },
    stall() { p.waiting = true; feed("waiting"); return api; },
    unstall() { p.waiting = false; feed("playing"); return api; },
    settle() { for (const e of rec.settle(p.t)) events.push(e); return api; },
    speed(r) { p.rate = r; feed("ratechange"); return api; },
    hide(h) { p.hidden = h; feed("visibility"); return api; },
    end() { p.ended = true; p.paused = true; p.pos = p.duration; feed("ended"); return api; },
    stop(reason) { for (const e of rec.end(p.t, reason || "navigation", obs())) events.push(e); return api; },
    reconcile() { feed("reconcile"); return api; },
    types() { return events.map(e => e.type); },
    fold(o) { return P.fold(events, o); }
  };
  return api;
}

test("video start is detected only when real playback begins", () => {
  const v = player();
  v.pause();                       // paused before ever playing: nothing recorded
  assert.equal(v.events.length, 0);
  v.play();
  assert.deepEqual(v.types(), ["VIDEO_STARTED"]);
  assert.equal(v.events[0].ts, T0);
  assert.equal(v.events[0].meta.duration, 600);
  assert.equal(v.events[0].next, "playing");
});

test("an ad is not playback: no start, no pause noise, ad time is separate", () => {
  const v = player();
  v.p.adShowing = true; v.play();
  assert.equal(v.events.length, 0);
  v.p.adShowing = false; v.p.pos = 0; v.feed = null; v.play();
  assert.deepEqual(v.types(), ["VIDEO_STARTED"]);
  v.wait(30); v.p.adShowing = true; v.pause(); v.wait(10); v.p.adShowing = false; v.p.paused = false; v.play();
  const f = v.stop().fold();
  assert.equal(f.metrics.pauseCount, 0);
  assert.equal(f.metrics.adMs, 10 * S);
  assert.equal(f.metrics.activeMs, 30 * S);
});

test("pause and resume produce one event each with exact timestamps and positions", () => {
  const v = player();
  v.play().wait(60).pause().wait(150).play().wait(20).stop();
  const [s, pa, re, en] = v.events;
  assert.deepEqual(v.types(), ["VIDEO_STARTED", "VIDEO_PAUSED", "VIDEO_RESUMED", "VIDEO_SESSION_ENDED"]);
  assert.equal(pa.ts, T0 + 60 * S); assert.equal(pa.pos, 60); assert.equal(pa.prev, "playing"); assert.equal(pa.next, "paused");
  assert.equal(re.ts, T0 + 210 * S); assert.equal(re.pos, 60); assert.equal(re.prev, "paused"); assert.equal(re.next, "playing");
  assert.equal(en.pos, 80);
  const f = v.fold();
  assert.equal(f.pauses.length, 1);
  assert.deepEqual([f.pauses[0].n, f.pauses[0].pausedAt, f.pauses[0].resumedAt, f.pauses[0].durationMs, f.pauses[0].status],
    [1, T0 + 60 * S, T0 + 210 * S, 150 * S, "resumed"]);
  assert.equal(f.pauses[0].pausedPos, 60);
});

test("the spec example: 2m30 and 3m pauses keep their own records and durations", () => {
  const v = player();
  v.play().wait(300).pause().wait(150).play().wait(270).pause().wait(180).play().wait(30).stop();
  const f = v.fold();
  assert.deepEqual(f.pauses.map(p => p.durationMs), [150 * S, 180 * S]);
  assert.equal(f.metrics.pausedMs, 330 * S);
  assert.equal(f.metrics.activeMs, 600 * S);
  assert.equal(f.metrics.pauseCount, 2); assert.equal(f.metrics.resumeCount, 2);
  const st = P.pauseStats(f.pauses);
  assert.deepEqual([st.avgMs, st.longestMs, st.shortestMs], [165 * S, 180 * S, 150 * S]);
});

test("ten consecutive pause/resume cycles: every event preserved, none overwritten", () => {
  const v = player({ duration: 3600 });
  v.play();
  for (let i = 1; i <= 10; i++) v.wait(30 + i).pause().wait(i * 5).play();
  v.wait(10).stop();
  const f = v.fold();
  assert.equal(v.types().filter(t => t === "VIDEO_PAUSED").length, 10);
  assert.equal(v.types().filter(t => t === "VIDEO_RESUMED").length, 10);
  assert.equal(f.pauses.length, 10);
  assert.deepEqual(f.pauses.map(p => p.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(f.pauses.map(p => p.durationMs / S), [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
  assert.equal(f.metrics.pausedMs, 275 * S);
  let sum = 10; for (let i = 1; i <= 10; i++) sum += 30 + i;
  assert.equal(f.metrics.activeMs, sum * S);
  assert.equal(new Set(v.events.map(e => e.id)).size, v.events.length);
});

test("a hundred cycles still keep every interval in order", () => {
  const v = player({ duration: 36000 });
  v.play();
  for (let i = 0; i < 100; i++) v.wait(5).pause().wait(2).play();
  v.stop();
  const f = v.fold();
  assert.equal(f.pauses.length, 100); assert.equal(f.metrics.pausedMs, 200 * S);
  assert.ok(f.pauses.every((p, i) => p.n === i + 1 && (i === 0 || p.pausedAt > f.pauses[i - 1].pausedAt)));
});

test("reconciliation never duplicates an event the listeners already recorded", () => {
  const v = player();
  v.play().wait(5).reconcile().wait(5).reconcile().pause().reconcile().wait(5).reconcile().play().reconcile().wait(5).reconcile();
  assert.deepEqual(v.types(), ["VIDEO_STARTED", "VIDEO_PAUSED", "VIDEO_RESUMED"]);
});

test("reconciliation catches a state change whose DOM event was missed", () => {
  const v = player();
  v.play().wait(10);
  v.p.paused = true; v.reconcile();            // the 'pause' event never reached us
  assert.deepEqual(v.types(), ["VIDEO_STARTED", "VIDEO_PAUSED"]);
  assert.equal(v.events[1].meta.reason, "reconcile");
});

test("seeking forward: skipped content is not counted as watched, and the event records where from", () => {
  const v = player();
  v.play().wait(60).seek(300).wait(60).stop();
  const sk = v.events.find(e => e.type === "VIDEO_SEEKED");
  assert.equal(sk.pos, 300); assert.equal(sk.meta.from, 60);
  const f = v.fold();
  assert.equal(f.metrics.seekCount, 1);
  assert.equal(f.metrics.activeMs, 120 * S);
  assert.equal(f.metrics.uniqueContentSec, 120);
  assert.deepEqual(f.segments, [{ from: 0, to: 60 }, { from: 300, to: 360 }]);
  assert.equal(f.metrics.furthestSec, 360);
});

test("scrubbing (many seeking events) produces one VIDEO_SEEKED", () => {
  const v = player();
  v.play().wait(20);
  v.p.seeking = true; v.p.pos = 100; v.rec.observe({ pos: 100, rate: 1, paused: false, seeking: true }, v.p.t, "seeking");
  const e1 = v.rec.observe({ pos: 140, rate: 1, paused: false, seeking: true }, v.p.t + 50, "seeking");
  assert.equal(e1.length, 0);
  v.p.t += 100; v.p.pos = 150; v.p.seeking = false; v.p.paused = false;
  v.events.push(...v.rec.observe({ pos: 150, rate: 1, paused: false, seeking: false, duration: 600 }, v.p.t, "seeked"));
  assert.equal(v.types().filter(t => t === "VIDEO_SEEKED").length, 1);
  assert.equal(v.events.find(e => e.type === "VIDEO_SEEKED").meta.from, 20);
});

test("a seek while paused does not end the pause", () => {
  const v = player();
  v.play().wait(30).pause().wait(5).seek(200).wait(5).play().wait(10).stop();
  const f = v.fold();
  assert.equal(f.pauses.length, 1); assert.equal(f.pauses[0].durationMs, 10 * S);
  assert.deepEqual(f.segments, [{ from: 0, to: 30 }, { from: 200, to: 210 }]);
});

test("seeking backwards counts as rewatch, not new content", () => {
  const v = player();
  v.play().wait(100).seek(40).wait(30).stop();
  const f = v.fold();
  assert.equal(f.metrics.uniqueContentSec, 100);
  assert.equal(f.metrics.rewatchSec, 30);
  assert.equal(f.metrics.rewatchMs, 30 * S);
  assert.equal(f.metrics.activeMs, 130 * S);
});

test("playback speed: wall-clock active time vs content covered (2x and 0.5x)", () => {
  const v = player({ duration: 3000 });
  v.play().wait(60).speed(2).wait(60).speed(0.5).wait(60).stop();
  const f = v.fold();
  assert.equal(f.metrics.activeMs, 180 * S);
  assert.equal(f.metrics.uniqueContentSec, 60 + 120 + 30);
  assert.deepEqual(v.events.filter(e => e.type === "VIDEO_PLAYING").map(e => [e.meta.rateFrom, e.rate]), [[1, 2], [2, 0.5]]);
  assert.equal(f.metrics.uncertain.length, 0);
});

test("a speed change while paused is silent", () => {
  const v = player();
  v.play().wait(10).pause().speed(1.5).play().wait(10).stop();
  assert.equal(v.types().filter(t => t === "VIDEO_PLAYING").length, 0);
  assert.equal(v.events.find(e => e.type === "VIDEO_RESUMED").rate, 1.5);
});

test("buffering: short stalls are ignored, long ones are recorded with their original start", () => {
  const v = player();
  v.play().wait(10);
  v.stall(); v.p.t += 100; v.settle(); v.unstall();           // 100 ms blip
  assert.equal(v.types().includes("VIDEO_BUFFERING_STARTED"), false);
  v.wait(10);
  v.stall(); const stallAt = v.p.t; v.p.t += 450; v.settle(); v.p.t += 1550; v.unstall();   // 2 s stall
  assert.deepEqual(v.types().slice(-2), ["VIDEO_BUFFERING_STARTED", "VIDEO_BUFFERING_ENDED"]);
  assert.equal(v.events.find(e => e.type === "VIDEO_BUFFERING_STARTED").ts, stallAt);
  assert.equal(v.events.find(e => e.type === "VIDEO_BUFFERING_ENDED").meta.dur, 2 * S);
  v.wait(10).stop();
  const f = v.fold();
  assert.equal(f.metrics.bufferingMs, 2 * S); assert.equal(f.metrics.bufferingCount, 1);
  assert.equal(f.metrics.activeMs, 10 * S + 0.1 * S + 10 * S + 10 * S);
});

test("pausing during a stall closes the stall and opens a pause", () => {
  const v = player();
  v.play().wait(5).stall(); v.p.t += 1000; v.settle(); v.p.t += 500; v.pause().wait(20).play().wait(5).stop();
  assert.deepEqual(v.types(), ["VIDEO_STARTED", "VIDEO_BUFFERING_STARTED", "VIDEO_BUFFERING_ENDED", "VIDEO_PAUSED", "VIDEO_RESUMED", "VIDEO_SESSION_ENDED"]);
  const f = v.fold();
  assert.equal(f.pauses[0].durationMs, 20 * S);
});

test("tab hidden/visible are events; background playback still counts as active time", () => {
  const v = player();
  v.play().wait(10).hide(true).wait(60).hide(false).wait(10).stop();
  assert.deepEqual(v.types().slice(1, 3), ["VIDEO_TAB_HIDDEN", "VIDEO_TAB_VISIBLE"]);
  const f = v.fold();
  assert.equal(f.metrics.activeMs, 80 * S); assert.equal(f.metrics.hiddenMs, 60 * S); assert.equal(f.metrics.backgroundPlayMs, 60 * S);
});

test("completion: timestamp, time to complete including interruptions, and the final session end", () => {
  const v = player({ duration: 100 });
  v.play().wait(40).pause().wait(200).play().wait(60);
  v.end();
  const f = v.stop().fold();
  assert.deepEqual(v.types().slice(-2), ["VIDEO_COMPLETED", "VIDEO_SESSION_ENDED"]);
  assert.equal(f.metrics.completed, true);
  assert.equal(f.metrics.completedAt, T0 + 300 * S);
  assert.equal(f.metrics.timeToCompleteMs, 300 * S);
  assert.equal(f.metrics.activeMs, 100 * S);
  assert.equal(f.metrics.uniqueContentSec, 100);
});

test("reaching 100% does not prove everything was watched", () => {
  const v = player({ duration: 600 });
  v.play().wait(10).seek(590).wait(10).stop();
  const f = v.fold();
  assert.equal(f.metrics.furthestSec, 600);
  assert.equal(f.metrics.uniqueContentSec, 20);
  const r = P.rollup([f], 600);
  assert.equal(r.progressPct, 100); assert.equal(r.uniqueContentPct, 3);
});

test("replay after completion is its own event; the first completion time is kept", () => {
  const v = player({ duration: 60 });
  v.play().wait(60); v.end(); v.p.ended = false; v.p.paused = false; v.p.pos = 0; v.play().wait(20).stop();
  assert.deepEqual(v.types().filter(t => t === "VIDEO_COMPLETED" || t === "VIDEO_REPLAYED"), ["VIDEO_COMPLETED", "VIDEO_REPLAYED"]);
  const f = v.fold();
  assert.equal(f.metrics.replayCount, 1); assert.equal(f.metrics.completionCount, 1);
  assert.equal(f.metrics.completedAt, T0 + 60 * S);
  assert.equal(f.metrics.rewatchSec, 20);
});

test("session ended while paused closes the pause at the recorded end time", () => {
  const v = player();
  v.play().wait(30).pause().wait(90).stop("pagehide");
  const f = v.fold();
  assert.equal(f.pauses[0].status, "session_ended"); assert.equal(f.pauses[0].durationMs, 90 * S);
  assert.equal(f.metrics.pausedMs, 90 * S); assert.equal(f.metrics.resumeCount, 0);
  assert.equal(f.metrics.status, "ended"); assert.equal(f.metrics.elapsedMs, 120 * S);
});

test("browser shutdown while paused: the pause is unresolved, nothing is invented", () => {
  const v = player();
  v.play().wait(30).pause().wait(40);
  v.rec.heartbeat(v.p.t, v.p.pos);
  const lastKnown = v.p.t;                                    // the last heartbeat the device wrote
  const snap = v.rec.snapshot();
  const ev = P.interruptedEvent(snap, lastKnown);             // recovered much later, on next browser start
  assert.equal(ev.ts, lastKnown); assert.equal(ev.meta.reason, "recovered"); assert.equal(ev.pos, 30);
  const f = P.fold(v.events.concat([ev]));
  const p = f.pauses[0];
  assert.equal(p.status, "unresolved"); assert.equal(p.resumedAt, null); assert.equal(p.durationMs, null);
  assert.equal(p.minDurationMs, 40 * S);
  assert.equal(f.metrics.pausedMs, 0); assert.equal(f.metrics.unresolvedPausedMs, 40 * S);
  assert.equal(f.metrics.status, "interrupted"); assert.equal(f.metrics.endedAt, null);
  assert.ok(f.metrics.uncertain.some(u => u.kind === "unresolved_pause"));
});

test("browser shutdown while playing: active time stops at the last heartbeat and is flagged uncertain", () => {
  const v = player();
  v.play().wait(60);
  v.rec.heartbeat(v.p.t, v.p.pos);
  const ev = P.interruptedEvent(v.rec.snapshot(), v.p.t);
  const f = P.fold(v.events.concat([ev]));
  assert.equal(f.metrics.activeMs, 60 * S); assert.equal(f.metrics.uniqueContentSec, 60);
  assert.ok(f.metrics.uncertain.some(u => u.kind === "interrupted_run"));
  assert.equal(P.interruptedEvent(Object.assign({}, v.rec.snapshot(), { finished: true }), v.p.t), null);
});

test("an implausible position jump is capped and flagged instead of trusted", () => {
  const evs = [
    { id: "x:e1", sessionId: "x", videoId: "v", seq: 1, type: "VIDEO_STARTED", ts: T0, pos: 0, rate: 1, meta: {} },
    { id: "x:e2", sessionId: "x", videoId: "v", seq: 2, type: "VIDEO_PAUSED", ts: T0 + 10 * S, pos: 500, rate: 1, meta: {} }];
  const f = P.fold(evs);
  assert.equal(f.metrics.uniqueContentSec, 10);
  assert.equal(f.metrics.uncertain[0].kind, "implausible_span");
});

test("fold ignores duplicate events and is independent of delivery order", () => {
  const v = player();
  v.play().wait(20).pause().wait(10).play().wait(5).stop();
  const base = JSON.stringify(P.fold(v.events));
  const shuffled = v.events.slice().reverse().concat(v.events.slice(0, 3));   // reversed, with duplicates
  assert.equal(JSON.stringify(P.fold(shuffled)), base);
});

test("an open pause is listed, excluded from totals, and projected live", () => {
  const v = player();
  v.play().wait(30).pause();
  const f = v.fold();
  assert.equal(f.pauses[0].status, "open"); assert.equal(f.metrics.pauseCount, 1); assert.equal(f.metrics.pausedMs, 0);
  const at = P.project(f, T0 + 30 * S + 155 * S);
  assert.equal(at.currentPauseMs, 155 * S); assert.equal(P.formatClock(at.currentPauseMs), "00:02:35");
  assert.equal(at.activeMs, 30 * S);                     // paused: active time does not grow
  const live = P.project(player().play().fold(), T0 + 42 * S);
  assert.equal(live.activeMs, 42 * S);
  const frozen = P.project(v.fold(), T0 + 9999 * S, { frozen: true });
  assert.equal(frozen.currentPauseMs, 0);                // device offline: nothing is extrapolated
});

test("multiple sessions stay distinguishable and roll up without double counting content", () => {
  const a = player({ sessionId: "A", duration: 100 });
  a.play().wait(60).stop();
  const b = player({ sessionId: "B", duration: 100 });
  b.p.t += 86400 * S; b.play().wait(80).stop();
  const fa = a.fold(), fb = b.fold();
  const r = P.rollup([fa, fb], 100);
  assert.equal(r.sessions, 2); assert.equal(r.activeMs, 140 * S);
  assert.equal(r.uniqueContentSec, 80);                // 0-60 and 0-80 overlap
  assert.equal(r.firstWatched, T0); assert.equal(r.lastActivity, T0 + 86400 * S + 80 * S);
});

test("pause duration distribution buckets", () => {
  const pauses = [5, 15, 45, 120, 600, 3600].map((s, i) => ({ n: i + 1, durationMs: s * S }));
  assert.deepEqual(P.pauseDistribution(pauses).map(b => b.count), [1, 1, 1, 1, 1, 1]);
});

test("validateEvent accepts a recorder event and rejects forged or malformed ones", () => {
  const v = player(); v.play().wait(5).pause();
  const now = T0 + 100 * S;
  for (const e of v.events) assert.deepEqual(P.validateEvent(e, now), e);
  const ok = v.events[0];
  assert.equal(P.validateEvent(Object.assign({}, ok, { type: "VIDEO_HACKED" }), now), null);
  assert.equal(P.validateEvent(Object.assign({}, ok, { id: "other:e1" }), now), null);           // id must derive from session + seq
  assert.equal(P.validateEvent(Object.assign({}, ok, { ts: now + 3 * 86400000 }), now), null);   // from the future
  assert.equal(P.validateEvent(Object.assign({}, ok, { ts: 5 }), now), null);
  assert.equal(P.validateEvent(Object.assign({}, ok, { rate: 99 }), now), null);
  assert.equal(P.validateEvent(Object.assign({}, ok, { pos: -1 }), now), null);
  assert.equal(P.validateEvent(null, now), null);
  const dirty = P.validateEvent(Object.assign({}, ok, { meta: { reason: "user", evil: "<script>", from: 5, dur: "x" }, extra: 1 }), now);
  assert.deepEqual(dirty.meta, { reason: "user", from: 5 }); assert.equal("extra" in dirty, false);
});

test("timezone conversion: UTC instants are displayed in the chosen zone, with optional milliseconds", () => {
  const ts = Date.UTC(2026, 10, 3, 15, 5, 0) + 123;      // 15:05:00.123 UTC
  assert.equal(P.formatDate(ts, "UTC"), "November 3, 2026");
  assert.match(P.formatTime(ts, "UTC"), /^3:05:00\sPM$/);
  assert.match(P.formatTime(ts, "UTC", true), /^3:05:00\.123\sPM$/);
  assert.match(P.formatTime(ts, "Asia/Colombo"), /^8:35:00\sPM$/);          // UTC+5:30
  assert.match(P.formatTime(ts, "America/New_York"), /^10:05:00\sAM$/);     // EST in November
  assert.equal(P.formatDate(Date.UTC(2026, 10, 3, 23, 30, 0), "Asia/Colombo"), "November 4, 2026");   // crosses midnight
  assert.match(P.formatTime(ts, "Not/AZone"), /^\d{1,2}:\d{2}:00\s[AP]M$/);   // an invalid zone falls back to the local zone, never throws
});

test("duration formatting", () => {
  assert.equal(P.formatDuration(150 * S), "2 minutes 30 seconds");
  assert.equal(P.formatDuration(180 * S), "3 minutes");
  assert.equal(P.formatDuration(3661 * S), "1 hour 1 minute 1 second");
  assert.equal(P.formatDuration(0), "0 seconds");
  assert.equal(P.formatDuration(300), "< 1 second");
  assert.equal(P.formatDuration(null), "—");
  assert.equal(P.formatClock(155 * S), "00:02:35");
});
