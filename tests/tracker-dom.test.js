"use strict";
// content/tracker.js against a fake YouTube page: a scripted <video>, a controllable clock and timers, and a fake chrome.
// This is the real content script; only the browser around it is simulated.
const test = require("node:test"), assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const T0 = Date.UTC(2026, 10, 3, 10, 0, 0), S = 1000;

function makePage(opts) {
  opts = opts || {};
  let clock = T0;
  const store = Object.assign({ tracking_enabled: true, collect_title: true, collect_channel: true, collect_url: true, collect_detail: true }, opts.store);
  const sent = [], timers = [], timeouts = [], docListeners = {}, winListeners = {}, changeListeners = [];
  let failSend = false;
  const video = {
    currentTime: 0, playbackRate: 1, paused: true, ended: false, seeking: false, readyState: 4, duration: 600, _l: {},
    addEventListener(n, f) { (this._l[n] = this._l[n] || []).push(f); },
    removeEventListener(n, f) { this._l[n] = (this._l[n] || []).filter(x => x !== f); }
  };
  const state = { ad: false, hidden: false, path: "/watch", search: "?v=vid1" };
  const document = {
    get hidden() { return state.hidden; }, title: "Some video - YouTube",
    querySelector(sel) {
      if (/ad-showing/.test(sel)) return state.ad ? {} : null;
      if (/^video/.test(sel)) return video;
      return null;
    },
    addEventListener(n, f) { (docListeners[n] = docListeners[n] || []).push(f); }
  };
  const chrome = {
    storage: {
      local: {
        get(keys, cb) { const o = {}; for (const k of Object.keys(keys)) o[k] = k in store ? store[k] : keys[k]; cb(o); },
        set(o, cb) { Object.assign(store, o); cb && cb(); }
      },
      onChanged: { addListener(f) { changeListeners.push(f); } }
    },
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        sent.push(JSON.parse(JSON.stringify(msg)));
        if (cb) { if (failSend) { chrome.runtime.lastError = { message: "worker not ready" }; cb(undefined); chrome.runtime.lastError = null; } else cb({ ok: true }); }
      }
    }
  };
  const sandbox = {
    document, chrome, console, crypto: { randomUUID: () => "uuid-" + (++sandbox._n) }, _n: 0, URLSearchParams, URL,
    Date: class FakeDate extends Date { static now() { return clock; } },
    location: { get pathname() { return state.path; }, get search() { return state.search; } },
    setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    setTimeout(fn, ms) { timeouts.push({ fn, ms, at: clock + ms }); return timeouts.length; },
    clearTimeout() {}, clearInterval() {},
    window: { addEventListener(n, f) { (winListeners[n] = winListeners[n] || []).push(f); } }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ["lib/accounting.js", "lib/playback.js", "content/tracker.js"]) vm.runInContext(read(f), sandbox, { filename: f });

  const page = {
    video, state, store, sent, timers, sandbox,
    advance(sec) { clock += sec * S; if (!video.paused && !video.ended && video.readyState > 2 && !state.ad) video.currentTime += sec * video.playbackRate; return page; },
    fire(name) { (video._l[name] || []).forEach(f => f({ type: name })); return page; },
    tick() { timers.forEach(t => t.fn()); return page; },
    runTimeouts() { const due = timeouts.splice(0); due.forEach(t => t.fn()); return page; },
    play() { video.paused = false; return page.fire("play").fire("playing"); },
    pause() { video.paused = true; return page.fire("pause"); },
    seek(to) { video.seeking = true; video.currentTime = to; page.fire("seeking"); video.seeking = false; return page.fire("seeked"); },
    doc(name) { (docListeners[name] || []).forEach(f => f({ type: name })); return page; },
    win(name) { (winListeners[name] || []).forEach(f => f({ type: name })); return page; },
    config(patch) { const ch = {}; for (const k of Object.keys(patch)) { ch[k] = { newValue: patch[k] }; store[k] = patch[k]; } changeListeners.forEach(f => f(ch, "local")); return page; },
    failSends(v) { failSend = v; return page; },
    get now() { return clock; },
    events() { return sent.filter(m => m.type === "VIDEO_EVENTS").flatMap(m => m.events); },
    types() { return page.events().map(e => e.type); },
    flushes() { return sent.filter(m => m.type === "SESSION_FLUSH").map(m => m.snapshot); }
  };
  return page;
}

test("the content script is event-driven: one slow 5-second fallback tick, listeners on the player", () => {
  const p = makePage();
  assert.equal(p.timers.length, 1);
  assert.equal(p.timers[0].ms, 5000);
  for (const n of ["play", "pause", "seeking", "seeked", "waiting", "playing", "ratechange", "ended"]) assert.equal(p.video._l[n].length, 1, n);
});

test("video start is detected the instant playback begins, not at the next tick", () => {
  const p = makePage();
  p.play();
  assert.deepEqual(p.types(), ["VIDEO_STARTED"]);
  assert.equal(p.events()[0].ts, T0);
  assert.equal(p.events()[0].meta.duration, 600);
});

test("nothing is recorded while the player is paused, loading or showing an ad", () => {
  const p = makePage();
  p.fire("pause").tick();
  p.state.ad = true; p.play(); p.tick();
  assert.equal(p.events().length, 0);
  assert.equal(p.flushes().length, 0);
});

test("pause and resume are captured immediately with their exact timestamps and positions", () => {
  const p = makePage();
  p.play().advance(60);
  p.pause();
  const pause = p.events()[1];
  assert.deepEqual([pause.type, pause.ts, pause.pos], ["VIDEO_PAUSED", T0 + 60 * S, 60]);
  p.advance(150);
  p.play();
  const resume = p.events()[2];
  assert.deepEqual([resume.type, resume.ts, resume.pos], ["VIDEO_RESUMED", T0 + 210 * S, 60]);
  assert.ok(p.sent.length >= 3 && p.sent.every(m => m.type !== "VIDEO_EVENTS" || m.events.length >= 1));
});

test("ten consecutive pause/resume cycles with fallback ticks in between: exactly ten of each, no duplicates", () => {
  const p = makePage();
  p.play();
  for (let i = 0; i < 10; i++) {
    p.advance(12).tick().advance(3).pause().tick().advance(7).tick().play().tick();
  }
  const t = p.types();
  assert.equal(t.filter(x => x === "VIDEO_PAUSED").length, 10);
  assert.equal(t.filter(x => x === "VIDEO_RESUMED").length, 10);
  assert.equal(t.length, 21);
  assert.equal(new Set(p.events().map(e => e.id)).size, 21);
  assert.deepEqual(p.events().map(e => e.seq), Array.from({ length: 21 }, (_, i) => i + 1));
});

test("the fallback tick records a change whose DOM event was missed, marked as reconciled", () => {
  const p = makePage();
  p.play().advance(10);
  p.video.paused = true;                       // no 'pause' event reached us
  p.advance(4).tick();
  const e = p.events()[1];
  assert.deepEqual([e.type, e.meta.reason], ["VIDEO_PAUSED", "reconcile"]);
});

test("watch time is credited in full across pauses, with only events and 5-second ticks", () => {
  const p = makePage();
  p.play();
  for (let i = 0; i < 6; i++) p.advance(5).tick();       // 30 s
  p.advance(2).pause();                                  // + 2 s up to the pause = 32 s
  p.advance(100).tick().tick();                          // paused: nothing credited
  p.play();
  p.advance(8).pause();                                  // + 8 s
  const last = p.flushes().pop();
  assert.ok(Math.abs(last.watchedMs - 40 * S) <= 1500, "got " + last.watchedMs);
  assert.equal(last.pauses, 2);
});

test("a laptop that slept does not credit the sleep, and a hidden tab's throttled tick credits real playback", () => {
  const p = makePage();
  p.play().advance(10).tick();
  p.state.hidden = true; p.doc("visibilitychange");
  p.advance(60).tick();                                  // hidden, throttled to once a minute, media really advanced
  const hiddenCredit = p.flushes().pop();
  p.state.hidden = false; p.doc("visibilitychange");
  const before = p.flushes().pop().watchedMs;
  p.sandbox.Date.now = (() => { const c = p.now + 3600 * S; return () => c; })();   // one hour passes, the media clock does not move
  p.tick();
  const after = p.flushes().pop().watchedMs;
  assert.ok(hiddenCredit.watchedMs >= 69 * S, "background playback is counted: " + hiddenCredit.watchedMs);
  assert.ok(after - before <= 1500, "sleep not credited: " + (after - before));
  assert.equal(p.flushes().pop().seeks, 0, "a lagging media clock is not a seek");
});

test("seeking: skipped content is not counted, scrubbing is one event, and the event knows where from", () => {
  const p = makePage();
  p.play().advance(30);
  p.seek(400);
  p.advance(30);
  p.pause();
  const sk = p.events().filter(e => e.type === "VIDEO_SEEKED");
  assert.equal(sk.length, 1);
  assert.deepEqual([sk[0].pos, sk[0].meta.from], [400, 30]);
  const last = p.flushes().pop();
  assert.ok(Math.abs(last.watchedMs - 60 * S) <= 1500, "watched " + last.watchedMs);
  assert.equal(last.seeks, 1);
});

test("playback speed changes are recorded while playing and the new rate is carried on later events", () => {
  const p = makePage();
  p.play().advance(10);
  p.video.playbackRate = 2; p.fire("ratechange");
  p.advance(10);
  p.pause();
  const e = p.events();
  assert.deepEqual([e[1].type, e[1].meta.rateFrom, e[1].rate], ["VIDEO_PLAYING", 1, 2]);
  assert.equal(e[2].rate, 2);
  assert.equal(e[2].pos, 30);       // 10 s at 1x + 10 s at 2x
});

test("buffering: a stall is recorded only once it lasts, and it ends when playback resumes", () => {
  const p = makePage();
  p.play().advance(5);
  p.video.readyState = 1; p.fire("waiting"); p.advance(0.1); p.runTimeouts();
  p.video.readyState = 4; p.fire("playing");
  assert.equal(p.types().includes("VIDEO_BUFFERING_STARTED"), false, "a 100 ms blip is ignored");
  p.advance(5);
  p.video.readyState = 1; p.fire("waiting"); p.advance(1); p.runTimeouts();
  p.advance(1); p.video.readyState = 4; p.fire("playing");
  assert.deepEqual(p.types().slice(-2), ["VIDEO_BUFFERING_STARTED", "VIDEO_BUFFERING_ENDED"]);
  assert.equal(p.events().pop().meta.dur, 2 * S);
});

test("tab switching is recorded as hidden/visible events", () => {
  const p = makePage();
  p.play().advance(5);
  p.state.hidden = true; p.doc("visibilitychange");
  p.advance(20);
  p.state.hidden = false; p.doc("visibilitychange");
  assert.deepEqual(p.types().slice(1), ["VIDEO_TAB_HIDDEN", "VIDEO_TAB_VISIBLE"]);
  assert.equal(p.events()[2].ts - p.events()[1].ts, 20 * S);
});

test("completion, then a replay in the same viewing, then the viewing ends after the linger period", () => {
  const p = makePage();
  p.video.duration = 100;
  p.play().advance(100);
  p.video.ended = true; p.video.paused = true; p.video.currentTime = 100; p.fire("ended");
  assert.equal(p.types().pop(), "VIDEO_COMPLETED");
  p.advance(20).tick();
  assert.equal(p.types().includes("VIDEO_SESSION_ENDED"), false, "still open: the viewer may replay");
  p.video.ended = false; p.video.paused = false; p.video.currentTime = 0; p.fire("play").fire("playing");
  assert.equal(p.types().pop(), "VIDEO_REPLAYED");
  p.advance(10).pause();
  p.advance(31 * 60).tick();                              // idle for longer than the pause limit
  const t = p.types();
  assert.equal(t[t.length - 1], "VIDEO_SESSION_ENDED");
  assert.equal(p.events().pop().meta.reason, "idle");
  const snap = p.flushes().pop();
  assert.equal(snap.completed, true);
  assert.ok(snap.endTs > 0);
});

test("a long pause stays one viewing: both the pause and the resume are kept", () => {
  const p = makePage();
  p.play().advance(10).pause();
  p.advance(20 * 60).tick().tick();
  p.play().advance(5);
  const t = p.types();
  assert.deepEqual(t, ["VIDEO_STARTED", "VIDEO_PAUSED", "VIDEO_RESUMED"]);
  assert.equal(p.events()[2].ts - p.events()[1].ts, 20 * 60 * S);
});

test("navigating to another video ends the first viewing and starts a new one; closing the tab ends it too", () => {
  const p = makePage();
  p.play().advance(30);
  p.state.search = "?v=vid2"; p.video.currentTime = 0;
  p.doc("yt-navigate-finish");
  const ended = p.events().filter(e => e.type === "VIDEO_SESSION_ENDED");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].meta.reason, "navigation");
  p.advance(1).tick();
  const starts = p.events().filter(e => e.type === "VIDEO_STARTED");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].sessionId, starts[1].sessionId);
  assert.equal(starts[1].videoId, "vid2");
  p.advance(5).win("pagehide");
  assert.equal(p.events().pop().meta.reason, "pagehide");
});

test("pausing tracking ends the viewing from what was already recorded and records nothing new", () => {
  const p = makePage();
  p.play().advance(20);
  p.config({ tracking_enabled: false });
  const end = p.events().pop();
  assert.deepEqual([end.type, end.meta.reason], ["VIDEO_SESSION_ENDED", "tracking_off"]);
  const n = p.events().length;
  p.advance(30).pause().play().tick().advance(5).tick();
  assert.equal(p.events().length, n, "no further events while tracking is paused");
});

test("detail collection off: watch-time snapshots continue but no event stream is created, and turning it on does not start one mid-viewing", () => {
  const p = makePage({ store: { collect_detail: false } });
  p.play().advance(10).pause();
  assert.equal(p.events().length, 0);
  assert.ok(p.flushes().length > 0);
  p.config({ collect_detail: true });
  p.play().advance(5).pause();
  assert.equal(p.events().length, 0, "the viewing already in progress stays without events");
});

test("switching detail collection off mid-viewing stops the stream at once", () => {
  const p = makePage();
  p.play().advance(10);
  p.config({ collect_detail: false });
  assert.equal(p.events().pop().type, "VIDEO_SESSION_ENDED");
  const n = p.events().length;
  p.pause().advance(3).play();
  assert.equal(p.events().length, n);
});

test("a message the service worker could not take is retried, in order, without loss or duplication", () => {
  const p = makePage();
  p.failSends(true);
  p.play().advance(5).pause();
  p.advance(3).play();
  p.failSends(false);
  p.tick();
  const ids = p.events().map(e => e.id);
  assert.deepEqual([...new Set(ids)].sort(), ["uuid-1:e1", "uuid-1:e2", "uuid-1:e3"]);
  // after a success nothing is re-sent
  const n = p.sent.filter(m => m.type === "VIDEO_EVENTS").length;
  p.advance(5).tick(); p.advance(5).tick();
  assert.equal(p.sent.filter(m => m.type === "VIDEO_EVENTS").length, n);
});

test("the recorder state is persisted for crash recovery, and a previous unfinished viewing is closed when a new one starts", () => {
  const p = makePage();
  p.play().advance(10).tick();
  assert.equal(p.store.live_rec.sessionId, "uuid-1");
  assert.equal(p.store.live_rec.state, "playing");
  assert.equal(p.store.live_rec.lastTs, p.now);
  // a different, unfinished recorder left behind by a crashed tab
  const q = makePage({ store: { live_rec: { sessionId: "ghost", videoId: "old", seq: 4, state: "paused", rate: 1, lastPos: 12, lastTs: T0 - 600 * S, started: true, finished: false, hidden: false } } });
  q.play();
  const intr = q.events().find(e => e.type === "VIDEO_SESSION_INTERRUPTED");
  assert.equal(intr.sessionId, "ghost"); assert.equal(intr.ts, T0 - 600 * S); assert.equal(intr.seq, 5);
});

test("the snapshot sent to the service worker still honours the user's privacy switches", () => {
  const p = makePage({ store: { collect_channel: false, collect_url: false } });
  p.play().advance(6).tick();
  const s = p.flushes().pop();
  assert.equal(s.channel, ""); assert.equal(s.channelUrl || "", ""); assert.equal(s.url, "");
  for (const e of p.events()) assert.deepEqual(Object.keys(e).sort(), ["id", "meta", "next", "pos", "prev", "rate", "seq", "sessionId", "ts", "type", "videoId"]);
});
