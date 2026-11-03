/* lib/playback.js — pure playback-event model (self.YTPlayback). No DOM, no chrome.*, Node-compatible.
   Shared by the extension (recorder), the server (validation + folding events into metrics) and the dashboard (live timers,
   formatting). Copied to server/src/lib/playback.cjs and server/web/vendor/playback.js by server/scripts/sync-shared.js.

   Three parts:
   1. Recorder   — turns what the <video> element reports into a minimal, de-duplicated stream of events.
   2. fold()     — turns an event stream into metrics, pause intervals and watched content ranges. A pure function of
                   the events, so late or re-ordered delivery converges to the same answer.
   3. helpers    — validation, projection of live timers, roll-ups, timezone-aware formatting.
   Nothing here invents timestamps: an interval whose end is unknown is reported as unresolved with a known lower bound. */
(function (root) {
  "use strict";

  const TYPES = ["VIDEO_STARTED", "VIDEO_PLAYING", "VIDEO_PAUSED", "VIDEO_RESUMED", "VIDEO_SEEKED", "VIDEO_BUFFERING_STARTED",
    "VIDEO_BUFFERING_ENDED", "VIDEO_COMPLETED", "VIDEO_REPLAYED", "VIDEO_TAB_HIDDEN", "VIDEO_TAB_VISIBLE", "VIDEO_SESSION_ENDED",
    "VIDEO_SESSION_INTERRUPTED"];
  const STATES = ["none", "playing", "paused", "buffering", "ad", "ended"];
  const REASONS = ["user", "ad_break", "ad_break_end", "recovered", "navigation", "pagehide", "tracking_off", "idle", "reconcile", "paused", "ended", "retention"];
  const BUFFER_DEBOUNCE_MS = 400;   // shorter stalls are not recorded
  const SEEK_TOLERANCE_S = 1;       // a position change smaller than this after `seeked` is not a seek
  const MAX_RATE = 16, MIN_RATE = 0.0625;
  const MAX_EVENTS_PER_SESSION = 5000, MAX_RUNS = 2500;

  const r1 = n => Math.round((Number(n) || 0) * 10) / 10;

  /* ================= 1. Recorder ================= */

  // The recorder is diff-based: every DOM event and every reconcile tick feeds the same observe(); an event is emitted
  // only when the observed state really differs from the recorded one, so a fallback tick can never duplicate an event.
  // obs: { pos, rate, paused, ended, seeking, waiting, adShowing, hidden, duration }
  function desiredState(o) {
    if (o.adShowing) return "ad";
    if (o.ended) return "ended";
    if (o.paused) return "paused";
    return o.waiting ? "buffering" : "playing";
  }

  function createRecorder(init) {
    init = init || {};
    const sessionId = init.sessionId, videoId = init.videoId;
    let seq = init.seq || 0, state = init.state || "none", rate = init.rate || 1, hidden = !!init.hidden;
    let lastPos = init.lastPos || 0, lastTs = init.lastTs || 0, started = !!init.started, finished = !!init.finished;
    let seekFrom = null, pend = null, bufStartTs = init.bufStartTs || 0;
    let out = [];

    function emit(type, ts, pos, next, meta, keepRate) {
      const e = { id: sessionId + ":e" + (++seq), videoId: videoId, sessionId: sessionId, seq: seq, type: type, ts: ts,
        pos: r1(pos), rate: keepRate || rate, prev: state, next: next || state, meta: meta || {} };
      state = e.next;
      out.push(e);
      return e;
    }
    const expected = ts => (state === "playing" ? lastPos + Math.max(0, ts - lastTs) / 1000 * rate : lastPos);
    const track = (pos, ts) => { lastPos = pos; lastTs = ts; };

    // A stall is recorded only once it has lasted BUFFER_DEBOUNCE_MS; the event keeps the stall's original timestamp.
    function settle(ts, still) {
      if (!pend) return;
      if (!still) { pend = null; return; }
      if (ts - pend.ts >= BUFFER_DEBOUNCE_MS && state === "playing") {
        bufStartTs = pend.ts;
        emit("VIDEO_BUFFERING_STARTED", pend.ts, pend.pos, "buffering", {});
        pend = null;
      }
    }

    function observe(obs, ts, hint) {
      out = [];
      if (finished) return out;
      const want = desiredState(obs), pos = Number.isFinite(obs.pos) ? obs.pos : lastPos;
      if (!started) {
        if (want !== "playing") return out;
        started = true; rate = obs.rate > 0 ? obs.rate : 1; hidden = !!obs.hidden;
        const meta = {}; if (obs.duration > 0 && Number.isFinite(obs.duration)) meta.duration = Math.round(obs.duration);
        emit("VIDEO_STARTED", ts, pos, "playing", meta);
        track(pos, ts);
        return out;
      }
      if (want === "buffering" && state === "playing") { if (!pend) pend = { ts: ts, pos: pos }; settle(ts, true); }
      else settle(ts, want === "buffering");

      if (typeof obs.hidden === "boolean" && obs.hidden !== hidden) {
        hidden = obs.hidden;
        emit(hidden ? "VIDEO_TAB_HIDDEN" : "VIDEO_TAB_VISIBLE", ts, state === "playing" ? expected(ts) : lastPos, state, {});
      }

      // Seeking: remember where the viewer was; one VIDEO_SEEKED per burst of scrubbing, emitted when it settles.
      if (hint === "seeking" || obs.seeking) { if (seekFrom === null) seekFrom = expected(ts); return out; }
      if (seekFrom !== null) {
        const from = seekFrom; seekFrom = null;
        if (Math.abs(pos - from) > SEEK_TOLERANCE_S) { emit("VIDEO_SEEKED", ts, pos, state, { from: r1(from) }); }
        track(pos, ts);
      } else if (hint === "reconcile" && state === "playing") {
        const drift = Math.abs(pos - expected(ts));
        if (drift > Math.max(3, (ts - lastTs) / 2000)) emit("VIDEO_SEEKED", ts, pos, state, { from: r1(expected(ts)), reason: "reconcile" });
      }

      if (obs.rate > 0 && obs.rate !== rate) {
        const was = rate; rate = obs.rate;
        if (state === "playing") emit("VIDEO_PLAYING", ts, pos, "playing", { rateFrom: was });
      }

      if (want !== state && !(want === "buffering" && state === "playing")) {
        const reason = hint === "reconcile" ? "reconcile" : "user";
        if (want === "playing") {
          if (state === "paused") emit("VIDEO_RESUMED", ts, pos, "playing", { reason: reason });
          else if (state === "buffering") emit("VIDEO_BUFFERING_ENDED", ts, pos, "playing", { dur: Math.max(0, ts - bufStartTs) });
          else if (state === "ended") emit("VIDEO_REPLAYED", ts, pos, "playing", {});
          else if (state === "ad") emit("VIDEO_RESUMED", ts, pos, "playing", { reason: "ad_break_end" });
        } else if (want === "paused") {
          if (state === "buffering") emit("VIDEO_BUFFERING_ENDED", ts, pos, "playing", { dur: Math.max(0, ts - bufStartTs), reason: "paused" });
          if (state === "ad") emit("VIDEO_RESUMED", ts, pos, "playing", { reason: "ad_break_end" });
          if (state === "playing") emit("VIDEO_PAUSED", ts, pos, "paused", { reason: reason });
        } else if (want === "ad") {
          if (state === "buffering") emit("VIDEO_BUFFERING_ENDED", ts, pos, "playing", { dur: Math.max(0, ts - bufStartTs), reason: "paused" });
          emit("VIDEO_PAUSED", ts, pos, "ad", { reason: "ad_break" });
        } else if (want === "ended") {
          if (state === "buffering") emit("VIDEO_BUFFERING_ENDED", ts, pos, "playing", { dur: Math.max(0, ts - bufStartTs), reason: "ended" });
          if (state === "ad") emit("VIDEO_RESUMED", ts, pos, "playing", { reason: "ad_break_end" });
          emit("VIDEO_COMPLETED", ts, Number.isFinite(obs.duration) && obs.duration > 0 ? obs.duration : pos, "ended", {});
        } else if (want === "buffering") { // from paused/ad/ended straight to a stall: treat as playing first
          if (state === "paused") emit("VIDEO_RESUMED", ts, pos, "playing", { reason: reason });
          else if (state === "ended") emit("VIDEO_REPLAYED", ts, pos, "playing", {});
          else if (state === "ad") emit("VIDEO_RESUMED", ts, pos, "playing", { reason: "ad_break_end" });
        }
      }
      if (state === "playing" || state === "paused" || state === "ended") track(pos, ts);
      return out;
    }

    // Close the session with the exact timestamp the caller observed.
    function end(ts, reason, obs) {
      out = [];
      if (!started || finished) { finished = true; return out; }
      const pos = obs && Number.isFinite(obs.pos) ? obs.pos : expected(ts);
      settle(ts, false);
      emit("VIDEO_SESSION_ENDED", ts, pos, "none", { reason: REASONS.indexOf(reason) >= 0 ? reason : "navigation" });
      finished = true;
      return out;
    }

    const api = {
      observe: observe, settle: ts => { out = []; settle(ts, !!pend); return out; }, end: end,
      get state() { return state; }, get started() { return started; }, get finished() { return finished; }, get seq() { return seq; },
      get pendingBuffer() { return !!pend; },
      snapshot: () => ({ sessionId: sessionId, videoId: videoId, seq: seq, state: state, rate: rate, hidden: hidden, lastPos: lastPos,
        lastTs: lastTs, started: started, finished: finished, bufStartTs: bufStartTs }),
      heartbeat: (ts, pos) => { if (state === "playing" || state === "buffering") track(Number.isFinite(pos) ? pos : expected(ts), ts); else lastTs = ts; }
    };
    return api;
  }

  // A session whose recorder disappeared without an end event (browser closed, crash, power loss). The timestamp is the last
  // heartbeat the device actually wrote — never "now" — and the position is only projected while the media was playing.
  function interruptedEvent(snap, lastKnownTs) {
    if (!snap || snap.finished || !snap.started) return null;
    const dt = Math.max(0, lastKnownTs - (snap.lastTs || lastKnownTs));
    const pos = snap.state === "playing" ? snap.lastPos + dt / 1000 * (snap.rate || 1) : snap.lastPos;
    return { id: snap.sessionId + ":e" + (snap.seq + 1), videoId: snap.videoId, sessionId: snap.sessionId, seq: snap.seq + 1,
      type: "VIDEO_SESSION_INTERRUPTED", ts: lastKnownTs, pos: r1(pos), rate: snap.rate || 1, prev: snap.state, next: "none",
      meta: { reason: "recovered", lastKnownTs: lastKnownTs } };
  }

  /* ================= 2. fold ================= */

  function mergeSegs(segs) {
    const s = segs.slice().sort((a, b) => a.from - b.from), out = [];
    for (const x of s) {
      const last = out[out.length - 1];
      if (last && x.from <= last.to + 0.001) last.to = Math.max(last.to, x.to); else out.push({ from: x.from, to: x.to });
    }
    return out;
  }
  const covered = (segs, a, b) => segs.reduce((n, s) => n + Math.max(0, Math.min(b, s.to) - Math.max(a, s.from)), 0);
  const segLen = segs => segs.reduce((n, s) => n + (s.to - s.from), 0);

  function fold(events, opts) {
    opts = opts || {};
    const seen = {}, evs = [];
    for (const e of events || []) { if (!e || !e.id || seen[e.id]) continue; seen[e.id] = 1; evs.push(e); }
    evs.sort((a, b) => ((a.seq || 0) - (b.seq || 0)) || (a.ts - b.ts));

    const M = {
      sessionId: evs.length ? evs[0].sessionId : null, videoId: evs.length ? evs[0].videoId : null,
      startedAt: null, endedAt: null, interruptedAt: null, lastEventAt: null, lastPos: 0, rate: 1,
      state: "none", since: null, status: "empty", eventCount: evs.length, duration: opts.duration || 0,
      activeMs: 0, pausedMs: 0, unresolvedPausedMs: 0, bufferingMs: 0, adMs: 0, hiddenMs: 0, backgroundPlayMs: 0, elapsedMs: 0,
      pauseCount: 0, resumeCount: 0, seekCount: 0, bufferingCount: 0, completionCount: 0, replayCount: 0,
      completed: false, completedAt: null, timeToCompleteMs: null,
      furthestSec: 0, uniqueContentSec: 0, rewatchSec: 0, rewatchMs: 0, tabHiddenCount: 0, uncertain: []
    };
    let segs = [], pauses = [], pause = null, run = null, cur = "none", curTs = null, hidden = false;
    const ann = {};          // eventId -> the duration or distance this event relates to, for the timeline
    const runs = [];         // every stretch of real playback: when, how long (wall clock) and which part of the video it covered
    let bufOpenId = null;

    function closeRun(ts, endPos, rate, uncertain) {
      if (!run) return;
      const wall = Math.max(0, ts - run.ts), maxRate = Math.max(run.maxRate, rate || 1, 1);
      let sec = endPos - run.pos;
      const r = run; run = null;
      if (!(sec > 0)) return;
      if (runs.length < MAX_RUNS) runs.push({ ts: r.ts, ms: wall, from: r1(r.pos), to: r1(r.pos + Math.min(sec, wall / 1000 * maxRate)), rate: rate || 1 });
      if (sec > wall / 1000 * maxRate + 2) { sec = wall / 1000 * maxRate; M.uncertain.push({ kind: "implausible_span", ts: ts }); }
      if (uncertain) M.uncertain.push({ kind: "interrupted_run", ts: ts });
      const a = r.pos, b = r.pos + sec, over = covered(segs, a, b);
      M.rewatchSec += over; M.rewatchMs += over * 1000 / Math.max(rate || 1, MIN_RATE);
      segs = mergeSegs(segs.concat([{ from: a, to: b }]));
      if (b > M.furthestSec) M.furthestSec = b;
    }
    const startRun = (ts, pos, rate) => { run = { ts: ts, pos: pos, maxRate: rate || 1 }; };
    function closePause(ts, pos, status, evId) {
      if (!pause) return;
      pause.resumedAt = ts; pause.resumedPos = r1(pos); pause.status = status; pause.durationMs = Math.max(0, ts - pause.pausedAt);
      if (status === "resumed") pause.resumedEventId = evId;
      pauses.push(pause); pause = null;
    }

    for (const e of evs) {
      const ts = e.ts, rate = e.rate > 0 ? e.rate : 1;
      if (M.startedAt === null) M.startedAt = ts;
      if (curTs !== null && ts >= curTs) {
        const dt = ts - curTs;
        if (cur === "playing") M.activeMs += dt; else if (cur === "buffering") M.bufferingMs += dt; else if (cur === "ad") M.adMs += dt;
        if (hidden && cur !== "none") { M.hiddenMs += dt; if (cur === "playing") M.backgroundPlayMs += dt; }
      }
      M.lastEventAt = M.lastEventAt === null ? ts : Math.max(M.lastEventAt, ts);
      M.lastPos = e.pos; M.rate = rate;
      const meta = e.meta || {};
      switch (e.type) {
        case "VIDEO_STARTED":
          if (meta.duration > 0) M.duration = meta.duration;
          cur = "playing"; startRun(ts, e.pos, rate); break;
        case "VIDEO_PLAYING": if (run) run.maxRate = Math.max(run.maxRate, rate); break; // a playback-speed change
        case "VIDEO_PAUSED":
          closeRun(ts, e.pos, rate);
          if (meta.reason === "ad_break") { closePause(ts, e.pos, "ad_break", e.id); cur = "ad"; break; }
          if (!pause) { pause = { n: pauses.length + 1, pausedAt: ts, pausedPos: r1(e.pos), resumedAt: null, resumedPos: null, status: "open", durationMs: null, minDurationMs: 0, pausedEventId: e.id, resumedEventId: null }; M.pauseCount++; }
          cur = "paused"; break;
        case "VIDEO_RESUMED":
          if (meta.reason !== "ad_break_end") {
            if (pause) { closePause(ts, e.pos, "resumed", e.id); M.resumeCount++; }
            else M.uncertain.push({ kind: "resume_without_pause", ts: ts });
          }
          cur = "playing"; startRun(ts, e.pos, rate); break;
        case "VIDEO_SEEKED":
          M.seekCount++;
          ann[e.id] = { kind: "seek", fromSec: meta.from != null ? meta.from : null, toSec: e.pos };
          if (cur === "playing") { closeRun(ts, meta.from != null ? meta.from : e.pos, rate); startRun(ts, e.pos, rate); }
          break;
        case "VIDEO_BUFFERING_STARTED": closeRun(ts, e.pos, rate); cur = "buffering"; M.bufferingCount++; bufOpenId = e.id; break;
        case "VIDEO_BUFFERING_ENDED":
          if (meta.dur != null) { ann[e.id] = { kind: "buffering", ms: meta.dur }; if (bufOpenId) ann[bufOpenId] = { kind: "buffering", ms: meta.dur }; }
          bufOpenId = null; cur = "playing"; startRun(ts, e.pos, rate); break;
        case "VIDEO_COMPLETED":
          closeRun(ts, e.pos, rate); cur = "ended"; M.completionCount++;
          if (!M.completed) { M.completed = true; M.completedAt = ts; M.timeToCompleteMs = Math.max(0, ts - M.startedAt); ann[e.id] = { kind: "completion", ms: M.timeToCompleteMs }; }
          if (e.pos > M.furthestSec) M.furthestSec = e.pos;
          break;
        case "VIDEO_REPLAYED": M.replayCount++; cur = "playing"; startRun(ts, e.pos, rate); break;
        case "VIDEO_TAB_HIDDEN": hidden = true; M.tabHiddenCount++; break;
        case "VIDEO_TAB_VISIBLE": hidden = false; break;
        case "VIDEO_SESSION_ENDED":
          closeRun(ts, e.pos, rate); closePause(ts, e.pos, "session_ended", e.id);
          cur = "none"; M.endedAt = ts; ann[e.id] = { kind: "session", ms: Math.max(0, ts - M.startedAt) }; break;
        case "VIDEO_SESSION_INTERRUPTED":
          closeRun(ts, e.pos, rate, true);
          if (pause) { pause.status = "unresolved"; pause.minDurationMs = Math.max(0, ts - pause.pausedAt); pauses.push(pause); pause = null; M.uncertain.push({ kind: "unresolved_pause", ts: ts }); }
          cur = "none"; M.interruptedAt = ts; ann[e.id] = { kind: "interrupted", minMs: Math.max(0, ts - M.startedAt), uncertain: true }; break;
        default: break;
      }
      curTs = ts; if (e.pos > M.furthestSec && (cur === "playing" || cur === "paused" || cur === "ended")) M.furthestSec = Math.max(M.furthestSec, e.pos);
    }
    // an open pause (the video is paused right now) is listed but is not part of the completed totals
    if (pause) pauses.push(pause);
    for (const p of pauses) {
      if (p.status === "resumed") { ann[p.pausedEventId] = { kind: "pause", n: p.n, ms: p.durationMs }; if (p.resumedEventId) ann[p.resumedEventId] = { kind: "resume", n: p.n, ms: p.durationMs }; }
      else if (p.status === "session_ended" || p.status === "ad_break") ann[p.pausedEventId] = { kind: "pause", n: p.n, ms: p.durationMs, endedBy: p.status };
      else if (p.status === "unresolved") ann[p.pausedEventId] = { kind: "pause", n: p.n, ms: null, minMs: p.minDurationMs, unresolved: true };
      else ann[p.pausedEventId] = { kind: "pause", n: p.n, ms: null, open: true };
    }
    for (const p of pauses) {
      if (p.status === "resumed" || p.status === "session_ended" || p.status === "ad_break") M.pausedMs += p.durationMs;
      else if (p.status === "unresolved") M.unresolvedPausedMs += p.minDurationMs;
    }
    M.state = cur; M.since = curTs;
    M.status = M.endedAt != null ? "ended" : M.interruptedAt != null ? "interrupted" : evs.length ? "open" : "empty";
    const endTs = M.endedAt != null ? M.endedAt : M.interruptedAt != null ? M.interruptedAt : M.lastEventAt;
    M.elapsedMs = M.startedAt != null && endTs != null ? Math.max(0, endTs - M.startedAt) : 0;
    M.uniqueContentSec = r1(segLen(segs)); M.rewatchSec = r1(M.rewatchSec); M.rewatchMs = Math.round(M.rewatchMs);
    M.furthestSec = r1(M.furthestSec);
    return { metrics: M, pauses: pauses, segments: segs.map(s => ({ from: r1(s.from), to: r1(s.to) })), annotations: ann, runs: runs };
  }

  // Live display: what the metrics would read at `now`, assuming the device is still online. The server never stores this;
  // the page uses it to tick timers between events and drops it (freezes) when the device is offline.
  function project(folded, now, opts) {
    const m = Object.assign({}, folded.metrics), live = m.status === "open" && !(opts && opts.frozen);
    m.currentPauseMs = 0; m.currentPausePos = null;
    if (live && m.since != null && now > m.since) {
      const dt = now - m.since;
      if (m.state === "playing") m.activeMs += dt; else if (m.state === "buffering") m.bufferingMs += dt; else if (m.state === "ad") m.adMs += dt;
      m.elapsedMs += dt;
    }
    const open = folded.pauses.filter(p => p.status === "open")[0];
    if (open) { m.currentPausePos = open.pausedPos; m.currentPauseMs = live ? Math.max(0, now - open.pausedAt) : Math.max(0, (m.lastEventAt || open.pausedAt) - open.pausedAt); }
    return m;
  }

  function pauseStats(pauses) {
    const done = pauses.filter(p => p.durationMs != null).map(p => p.durationMs);
    return { count: pauses.length, completed: done.length, unresolved: pauses.filter(p => p.status === "unresolved").length,
      open: pauses.filter(p => p.status === "open").length, totalMs: done.reduce((a, b) => a + b, 0),
      avgMs: done.length ? Math.round(done.reduce((a, b) => a + b, 0) / done.length) : 0,
      longestMs: done.length ? Math.max.apply(null, done) : 0, shortestMs: done.length ? Math.min.apply(null, done) : 0 };
  }
  const PAUSE_BUCKETS = [["< 10 s", 10e3], ["10–30 s", 30e3], ["30–60 s", 60e3], ["1–5 min", 300e3], ["5–15 min", 900e3], ["> 15 min", Infinity]];
  function pauseDistribution(pauses) {
    const out = PAUSE_BUCKETS.map(b => ({ label: b[0], max: b[1], count: 0 }));
    for (const p of pauses) { if (p.durationMs == null) continue; for (const b of out) if (p.durationMs < b.max) { b.count++; break; } }
    return out.map(b => ({ label: b.label, count: b.count }));
  }

  // Combine the folded sessions of one video (all devices): totals, and unique content across sessions without double counting.
  function rollup(list, duration) {
    const R = { sessions: list.length, activeMs: 0, pausedMs: 0, unresolvedPausedMs: 0, bufferingMs: 0, adMs: 0, elapsedMs: 0, pauseCount: 0, resumeCount: 0,
      seekCount: 0, bufferingCount: 0, completionCount: 0, completedSessions: 0, completedAt: null, firstWatched: null, lastActivity: null, furthestSec: 0,
      uniqueContentSec: 0, rewatchSec: 0, rewatchMs: 0, uncertain: 0, duration: duration || 0 };
    let all = [];
    for (const f of list) {
      const m = f.metrics;
      for (const k of ["activeMs", "pausedMs", "unresolvedPausedMs", "bufferingMs", "adMs", "elapsedMs", "pauseCount", "resumeCount", "seekCount", "bufferingCount", "completionCount", "rewatchSec", "rewatchMs"]) R[k] += m[k] || 0;
      if (m.completed) { R.completedSessions++; if (R.completedAt === null || m.completedAt < R.completedAt) R.completedAt = m.completedAt; }
      if (m.startedAt != null && (R.firstWatched === null || m.startedAt < R.firstWatched)) R.firstWatched = m.startedAt;
      if (m.lastEventAt != null && (R.lastActivity === null || m.lastEventAt > R.lastActivity)) R.lastActivity = m.lastEventAt;
      if (m.furthestSec > R.furthestSec) R.furthestSec = m.furthestSec;
      if (m.duration > R.duration) R.duration = m.duration;
      R.uncertain += m.uncertain.length;
      all = all.concat(f.segments);
    }
    // content watched in different sessions overlaps: a second viewing of the same range is rewatching, not new content
    const u = mergeSegs(all);
    R.uniqueContentSec = r1(segLen(u)); R.rewatchSec = r1(R.rewatchSec);
    R.progressPct = R.duration > 0 ? Math.min(100, Math.round(R.furthestSec / R.duration * 100)) : null;
    R.uniqueContentPct = R.duration > 0 ? Math.min(100, Math.round(R.uniqueContentSec / R.duration * 100)) : null;
    return R;
  }

  /* ================= 3. validation (server side and tests) ================= */

  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  const MIN_TS = Date.UTC(2015, 0, 1);

  // Returns a cleaned event or null. Whitelists every field; `now` bounds timestamps (default: real time).
  function validateEvent(raw, now) {
    now = now || Date.now();
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.id !== "string" || !/^[\w-]{1,64}:e\d{1,6}$/.test(raw.id)) return null;
    if (typeof raw.sessionId !== "string" || !/^[\w-]{1,64}$/.test(raw.sessionId)) return null;
    if (typeof raw.videoId !== "string" || !/^[\w-]{1,32}$/.test(raw.videoId)) return null;
    if (TYPES.indexOf(raw.type) < 0) return null;
    const seq = num(raw.seq, 1, 999999), ts = num(raw.ts, MIN_TS, now + 86400000), pos = num(raw.pos, 0, 1e6);
    if (seq === null || ts === null || pos === null || !Number.isInteger(seq)) return null;
    if (raw.id !== raw.sessionId + ":e" + seq) return null; // the id is derived, so a client cannot forge a colliding one
    const rate = raw.rate === undefined ? 1 : num(raw.rate, MIN_RATE, MAX_RATE);
    if (rate === null) return null;
    const prev = STATES.indexOf(raw.prev) >= 0 ? raw.prev : "none", next = STATES.indexOf(raw.next) >= 0 ? raw.next : "none";
    const m = raw.meta && typeof raw.meta === "object" ? raw.meta : {}, meta = {};
    if (REASONS.indexOf(m.reason) >= 0) meta.reason = m.reason;
    for (const k of ["from", "duration"]) { const n = num(m[k], 0, 1e6); if (n !== null) meta[k] = Math.round(n * 10) / 10; }
    for (const k of ["dur", "rateFrom"]) { const n = num(m[k], 0, 1e9); if (n !== null) meta[k] = n; }
    const lk = num(m.lastKnownTs, MIN_TS, now + 86400000); if (lk !== null) meta.lastKnownTs = lk;
    return { id: raw.id, sessionId: raw.sessionId, videoId: raw.videoId, seq: seq, type: raw.type, ts: Math.floor(ts), pos: r1(pos), rate: rate, prev: prev, next: next, meta: meta };
  }

  /* ================= formatting (timezone-aware) ================= */

  // The display zone of the whole product: Sri Lanka Standard Time. Callers may name another zone (tests do); anything missing or
  // invalid falls back to this one, never to the browser's or the machine's zone.
  const DISPLAY_TZ = "Asia/Colombo", DISPLAY_TZ_LABEL = "SLST";
  const tidy = s => s.replace(/[  ]/g, " "); // newer ICU puts a narrow no-break space before AM/PM
  const fmtCache = {};
  function dtf(tz, kind) {
    const key = tz + "|" + kind;
    if (!fmtCache[key]) {
      const base = { timeZone: tz };
      fmtCache[key] = new Intl.DateTimeFormat("en-US", kind === "date"
        ? Object.assign({ year: "numeric", month: "long", day: "numeric" }, base)
        : Object.assign({ hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }, base));
    }
    return fmtCache[key];
  }
  function validZone(tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (_e) { return false; } }
  const zoneOf = tz => (tz && validZone(tz) ? tz : DISPLAY_TZ);
  // Stored UTC, shown in the display zone: "November 3, 2026" / "10:05:00 AM" (".123" appended when ms = true).
  function formatDate(ts, tz) { return tidy(dtf(zoneOf(tz), "date").format(new Date(ts))); }
  function formatTime(ts, tz, ms) {
    let s = tidy(dtf(zoneOf(tz), "time").format(new Date(ts)));
    if (ms) { const m = String(Math.floor(((ts % 1000) + 1000) % 1000)).padStart(3, "0"); s = s.replace(/(\d{2})( [AP]M)$/, "$1." + m + "$2"); }
    return s;
  }
  // "November 3, 2026 · 12:45:02 PM (SLST)": the one format used for every full timestamp.
  function formatStamp(ts, tz, ms) { const z = zoneOf(tz); return formatDate(ts, z) + " · " + formatTime(ts, z, ms) + " (" + (z === DISPLAY_TZ ? DISPLAY_TZ_LABEL : z) + ")"; }
  // Calendar day ("2026-11-03") of an instant on the display zone's wall clock.
  function dayKey(ts, tz) {
    const o = {}; new Intl.DateTimeFormat("en-US", { timeZone: zoneOf(tz), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ts)).forEach(p => { o[p.type] = p.value; });
    return o.year + "-" + o.month + "-" + o.day;
  }
  // The instant (UTC ms) at which the wall clock in `tz` reads y-m-d h:mi:s. Used by the date and time-range filters, so
  // "from 09:00" means 09:00 in the zone the page is showing, whatever the browser's own zone is.
  function tzOffsetMs(ts, tz) {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const o = {}; f.formatToParts(new Date(ts)).forEach(p => { o[p.type] = Number(p.value); });
    return Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second) - Math.floor(ts / 1000) * 1000;
  }
  function zonedToUtc(y, mo, d, h, mi, s, ms, tz) {
    const zone = zoneOf(tz), naive = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0, ms || 0);
    let t = naive - tzOffsetMs(naive, zone);
    t = naive - tzOffsetMs(t, zone); // second pass settles the offset on the far side of a daylight-saving change
    return t;
  }
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  function formatDuration(ms) {
    if (ms == null || !Number.isFinite(ms)) return "—";
    const t = Math.max(0, Math.round(ms / 1000));
    if (t === 0) return ms > 0 ? "< 1 second" : "0 seconds";
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60, parts = [];
    if (h) parts.push(plural(h, "hour")); if (m) parts.push(plural(m, "minute")); if (s) parts.push(plural(s, "second"));
    return parts.join(" ");
  }
  function formatClock(ms) {
    const t = Math.max(0, Math.floor((ms || 0) / 1000));
    const p = n => String(n).padStart(2, "0");
    return p(Math.floor(t / 3600)) + ":" + p(Math.floor(t % 3600 / 60)) + ":" + p(t % 60);
  }

  root.YTPlayback = { TYPES, STATES, REASONS, BUFFER_DEBOUNCE_MS, MAX_EVENTS_PER_SESSION, createRecorder, interruptedEvent, desiredState,
    fold, project, pauseStats, pauseDistribution, rollup, validateEvent, formatDate, formatTime, formatDuration, formatClock, validZone, tzOffsetMs, zonedToUtc, formatStamp, dayKey, DISPLAY_TZ, DISPLAY_TZ_LABEL };
  if (typeof module !== "undefined" && module.exports) module.exports = root.YTPlayback;
})(typeof self !== "undefined" ? self : this);
