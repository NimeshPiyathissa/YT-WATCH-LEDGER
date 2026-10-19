/* lib/accounting.js — pure watch-time accounting. No DOM, no chrome.*, Node-compatible.
   Exposed as self.YTAccounting. Reused server-side (copied to server/src/lib/accounting.cjs). */
(function (root) {
  "use strict";

  const MAX_GAP_MS = 2500;     // a single tick never credits more than this
  const SEEK_TOLERANCE_S = 2;  // position may differ from "expected" by this much before it counts as a seek
  const COMPLETE_RATIO = 0.9;  // furthest position >= 90% of duration (or the video ended) = completed

  // Cap a wall-clock delta so a stalled tab / sleeping laptop can't credit hours.
  function clampDelta(deltaMs, maxMs) {
    if (!(deltaMs > 0)) return 0;
    return Math.min(deltaMs, maxMs);
  }

  function videoUrl(videoId, kind) {
    return kind === "shorts" ? "https://www.youtube.com/shorts/" + videoId : "https://www.youtube.com/watch?v=" + videoId;
  }

  /* ---- live tracking: a pure state machine driven by what the player reports each tick ---- */

  function newSession(sessionId, videoId, kind, now) {
    return {
      sessionId: sessionId, videoId: videoId, kind: kind === "shorts" ? "shorts" : "watch", url: videoUrl(videoId, kind),
      title: "", channel: "", startTs: now, endTs: null,
      watchedMs: 0, duration: 0,
      startSec: null, positionSec: 0, furthestSec: 0, // where this viewing began / ended / got furthest (seconds)
      seeks: 0, rewinds: 0, pauses: 0, completed: false,
      rev: 0 // incremented on every flush; the server keeps the highest revision it has seen
    };
  }
  function newTrackState() { return { lastPos: null, wasPlaying: false }; }

  // obs: { positionSec, duration, playing, ended, adShowing, rate }; dtMs: real time since the previous step.
  // Mutates `s` and `st`. Ad time is ignored entirely (the <video> element reports the ad's position/length).
  function step(s, st, obs, dtMs) {
    if (obs.adShowing) { st.lastPos = null; st.wasPlaying = false; return; } // resuming after the ad must not look like a seek
    const pos = Number.isFinite(obs.positionSec) ? obs.positionSec : null;
    if (obs.duration > 0 && Number.isFinite(obs.duration)) s.duration = Math.round(obs.duration);
    const playing = !!obs.playing && !obs.ended;

    if (pos !== null && st.lastPos !== null) {
      const advance = st.wasPlaying ? (Math.max(dtMs, 0) / 1000) * (obs.rate > 0 ? obs.rate : 1) : 0;
      const jump = pos - (st.lastPos + advance);
      if (Math.abs(jump) > SEEK_TOLERANCE_S) { s.seeks++; if (jump < 0) s.rewinds++; }
    }
    if (playing) s.watchedMs += clampDelta(dtMs, MAX_GAP_MS);
    if (st.wasPlaying && !playing && !obs.ended) s.pauses++;

    if (pos !== null) {
      if (s.startSec === null) s.startSec = Math.round(pos);
      s.positionSec = Math.round(pos);
      if (s.positionSec > s.furthestSec) s.furthestSec = s.positionSec;
    }
    if (obs.ended || (s.duration > 0 && s.furthestSec / s.duration >= COMPLETE_RATIO)) s.completed = true;
    st.lastPos = pos; st.wasPlaying = playing;
  }

  // Blank out what the user chose not to record, so disabled fields never reach storage or the server.
  // cfg: { collect_title, collect_channel, collect_url, collect_detail } (undefined = on).
  function applyPrivacy(snap, cfg) {
    const out = Object.assign({}, snap), c = cfg || {};
    if (c.collect_title === false) out.title = "";
    if (c.collect_channel === false) out.channel = "";
    if (c.collect_url === false) out.url = "";
    if (c.collect_detail === false) {
      out.startSec = null; out.positionSec = 0; out.furthestSec = 0; out.seeks = 0; out.rewinds = 0; out.pauses = 0; out.completed = false;
    }
    return out;
  }

  /* ---- merging and rollups ---- */

  const MAX_FIELDS = ["seeks", "rewinds", "pauses", "furthestSec", "rev"];

  // Combine a stored session with a newer snapshot. Counters and watched time never decrease,
  // startTs keeps the earliest value, and an end timestamp is never lost.
  function mergeSnapshot(prev, snap) {
    if (!prev) return Object.assign({}, snap);
    const out = Object.assign({}, prev, snap);
    out.watchedMs = Math.max(prev.watchedMs || 0, snap.watchedMs || 0);
    const starts = [prev.startTs, snap.startTs].filter(x => x > 0);
    out.startTs = starts.length ? Math.min.apply(null, starts) : 0;
    if (prev.endTs && !snap.endTs) out.endTs = prev.endTs;
    if (!snap.title && prev.title) out.title = prev.title;
    if (!snap.channel && prev.channel) out.channel = prev.channel;
    if (!snap.url && prev.url) out.url = prev.url;
    for (const k of MAX_FIELDS) if (k in prev || k in snap) out[k] = Math.max(prev[k] || 0, snap[k] || 0);
    if ("completed" in prev || "completed" in snap) out.completed = !!(prev.completed || snap.completed);
    if (prev.startSec != null && snap.startSec != null) out.startSec = prev.startSec; // where the viewing began never changes
    return out;
  }

  // Build the per-video rollup from all of its sessions. Returns null when empty.
  function rollupVideo(videoId, sessions, thumbFn) {
    if (!sessions || !sessions.length) return null;
    const sorted = sessions.slice().sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
    let totalMs = 0, duration = 0, title = "", channel = "", url = "", furthestSec = 0, seeks = 0, pauses = 0, completions = 0;
    for (const s of sorted) {
      totalMs += s.watchedMs || 0;
      if ((s.duration || 0) > duration) duration = s.duration;
      if (s.title) title = s.title;
      if (s.channel) channel = s.channel;
      if (s.url) url = s.url;
      if ((s.furthestSec || 0) > furthestSec) furthestSec = s.furthestSec;
      seeks += s.seeks || 0; pauses += s.pauses || 0;
      if (s.completed) completions++;
    }
    const first = sorted[0];
    const lastWatched = Math.max.apply(null, sorted.map(s => s.endTs || s.startTs || 0));
    return {
      videoId: videoId,
      title: title,
      channel: channel,
      url: url,
      thumbnail: thumbFn ? thumbFn(videoId) : "",
      totalMs: totalMs,
      sessionCount: sorted.length,
      rewatches: sorted.length - 1, // viewings after the first
      completions: completions,
      seeks: seeks,
      pauses: pauses,
      furthestSec: furthestSec,
      firstWatched: first.startTs || 0,
      lastWatched: lastWatched,
      duration: duration,
      percent: duration > 0 ? Math.min(100, Math.round(totalMs / (duration * 1000) * 100)) : null,
      progress: duration > 0 ? Math.min(100, Math.round(furthestSec / duration * 100)) : null
    };
  }

  // Sum watched time per local day (a session counts toward the day it started).
  function dailyTotals(sessions, dayKeyFn) {
    const out = {};
    for (const s of sessions || []) {
      const k = dayKeyFn(s.startTs || 0);
      out[k] = (out[k] || 0) + (s.watchedMs || 0);
    }
    return out;
  }

  root.YTAccounting = { clampDelta, videoUrl, newSession, newTrackState, step, applyPrivacy, mergeSnapshot, rollupVideo, dailyTotals,
    MAX_GAP_MS, SEEK_TOLERANCE_S, COMPLETE_RATIO };
  if (typeof module !== "undefined" && module.exports) module.exports = root.YTAccounting;
})(typeof self !== "undefined" ? self : this);
