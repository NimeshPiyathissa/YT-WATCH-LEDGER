/* content/tracker.js — thin DOM adapter between the YouTube player and two pure modules:
   - lib/accounting.js  watch-time snapshots (the session record shown in History / Overview), and
   - lib/playback.js    the playback event stream (pause / resume / seek / buffering / ... with exact timestamps).
   It is event-driven: the <video> element's own events (play, pause, seeking, seeked, waiting, playing, ratechange, ended)
   and the page's visibility / navigation events drive everything at the instant they happen. A slow 5-second tick remains
   only as a fallback: it notices a state change whose event was missed, keeps the heartbeat that lets a crash be recognised
   afterwards, and credits watch time while nothing happens. Runs only on youtube.com; sends messages to the service worker. */
(function () {
  "use strict";
  const A = self.YTAccounting, P = self.YTPlayback;
  const TICK_MS = 5000, FLUSH_MS = 5000;
  // Longest wall-clock gap one accounting step may credit. Generous on purpose (a hidden tab's timer is throttled to about once a
  // minute): the real guard against crediting time that did not play is the media position, see A.step.
  const GAP_MS = 70000;
  const PAUSE_END_MS = 30 * 60 * 1000;  // a pause this long ends the viewing session (the pause itself is kept, closed at the session end)
  const ENDED_LINGER_MS = 2 * 60 * 1000; // after the video ends the session stays open this long, so a replay is a VIDEO_REPLAYED
  const PRIVACY_KEYS = { tracking_enabled: true, collect_title: true, collect_channel: true, collect_url: true, collect_detail: true };
  const VIDEO_EVENTS = ["play", "pause", "seeking", "seeked", "waiting", "playing", "ratechange", "ended"];
  let cfg = Object.assign({}, PRIVACY_KEYS), session = null, st = null, rec = null;
  let video = null, lastStep = 0, lastFlush = 0, wasEffPlaying = false, pausedSince = 0, endedSince = 0;
  let unsent = [], inflight = false, settleT = 0;

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const safe = fn => { try { return fn(); } catch (_e) { /* extension context invalidated */ } };

  safe(() => chrome.storage.local.get(PRIVACY_KEYS, o => { cfg = o; }));
  safe(() => chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    for (const k of Object.keys(PRIVACY_KEYS)) if (c[k]) cfg[k] = c[k].newValue;
    if (c.tracking_enabled && cfg.tracking_enabled === false) endSession("tracking_off", false);
    // Detail collection switched off mid-viewing: stop the event stream now. Turning it back on never restarts one mid-session.
    if (c.collect_detail && cfg.collect_detail === false && rec) endRecorder("tracking_off", null);
  }));

  function videoIdFromUrl() {
    if (location.pathname === "/watch") return new URLSearchParams(location.search).get("v");
    if (location.pathname.indexOf("/shorts/") === 0) return location.pathname.split("/")[2] || null;
    return null;
  }
  const kindFromUrl = () => (location.pathname.indexOf("/shorts/") === 0 ? "shorts" : "watch");
  const findVideo = () => document.querySelector("video.html5-main-video") || document.querySelector("video");
  function readMeta() {
    const h1 = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.title");
    const title = (h1 && h1.textContent.trim()) || document.title.replace(/ - YouTube$/, "");
    const ch = document.querySelector("ytd-video-owner-renderer #channel-name a, #owner #channel-name a");
    let channelUrl = "", channelId = "";
    if (ch && ch.href) {
      try {
        const u = new URL(ch.href), m = u.origin === "https://www.youtube.com" && u.pathname.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/);
        if (m) { channelUrl = u.origin + "/" + m[1]; const id = m[1].match(/^channel\/(UC[\w-]{22})$/); if (id) channelId = id[1]; }
      } catch (_e) { /* not a URL */ }
    }
    return { title: title, channel: ch ? ch.textContent.trim() : "", channelUrl: channelUrl, channelId: channelId };
  }

  function observation(v) {
    return { pos: v.currentTime, rate: v.playbackRate, paused: v.paused, ended: v.ended, seeking: v.seeking,
      waiting: !v.paused && !v.ended && !v.seeking && v.readyState < 3, adShowing: !!document.querySelector(".html5-video-player.ad-showing"),
      hidden: document.hidden, duration: v.duration };
  }

  /* ---- events to the service worker: queued here until it acknowledges them (a failed message is simply retried) ---- */
  function send(events) {
    if (!events || !events.length) return;
    unsent.push.apply(unsent, events);
    if (rec) safe(() => chrome.storage.local.set({ live_rec: rec.snapshot() }));
    drain();
  }
  function drain() {
    if (inflight || !unsent.length) return;
    const batch = unsent.slice(0, 100);
    inflight = true;
    try {
      chrome.runtime.sendMessage({ type: "VIDEO_EVENTS", events: batch }, resp => {
        inflight = false;
        const err = chrome.runtime.lastError; // the worker may be starting; the next event or tick retries
        if (!err && resp) { unsent.splice(0, batch.length); if (unsent.length) drain(); }
        else if (unsent.length > 500) unsent.splice(0, unsent.length - 500);
      });
    } catch (_e) { inflight = false; }
  }

  function flush() {
    if (!session) return;
    const m = readMeta();
    if (m.title) session.title = m.title;
    if (m.channel) session.channel = m.channel;
    if (m.channelUrl) { session.channelUrl = m.channelUrl; session.channelId = m.channelId; }
    session.rev++;
    lastFlush = Date.now();
    // Fields the user turned off are blanked here, before they reach storage or the server.
    const snapshot = A.applyPrivacy(session, cfg);
    safe(() => chrome.runtime.sendMessage({ type: "SESSION_FLUSH", snapshot: snapshot }, () => void chrome.runtime.lastError));
    safe(() => chrome.storage.local.set({ last_heartbeat: Date.now(), live_video_id: session ? session.videoId : null }));
  }

  function startSession(now, vid) {
    session = A.newSession(uuid(), vid, kindFromUrl(), now);
    st = A.newTrackState();
    rec = cfg.collect_detail === false ? null : P.createRecorder({ sessionId: session.sessionId, videoId: vid });
    lastStep = now; pausedSince = 0; endedSince = 0; wasEffPlaying = false;
    // A previous viewing that never got an end event (browser closed, crash) is closed at its last heartbeat.
    if (rec) safe(() => chrome.storage.local.get({ live_rec: null }, o => {
      const old = o.live_rec;
      if (old && old.sessionId !== session.sessionId && !old.finished) { const ev = P.interruptedEvent(old, old.lastTs); if (ev) send([ev]); }
    }));
  }

  function endRecorder(reason, obs) {
    if (!rec) return;
    const ev = rec.end(Date.now(), reason, obs || undefined);
    rec = null;
    unsent.push.apply(unsent, ev);
    safe(() => chrome.storage.local.set({ live_rec: null }));
    drain();
  }

  // reason: why the viewing ended; useObs: whether the player may still be read for the final position (not after a
  // navigation, and never once the user turned tracking off — then only what was already recorded is used).
  function endSession(reason, useObs) {
    if (!session) return;
    const now = Date.now();
    let o = null;
    if (useObs !== false && cfg.tracking_enabled !== false) { const v = findVideo(); if (v && videoIdFromUrl() === session.videoId) o = observation(v); }
    if (o) stepAccounting(o, now);
    endRecorder(reason, o);
    session.endTs = now;
    flush();
    session = null; st = null; wasEffPlaying = false;
    safe(() => chrome.storage.local.set({ live_video_id: null }));
  }

  function stepAccounting(o, now) {
    const playing = !o.paused && !o.ended && !o.waiting && !o.seeking;
    A.step(session, st, { positionSec: o.pos, duration: o.duration, playing: playing, ended: o.ended, adShowing: o.adShowing, rate: o.rate }, now - lastStep, GAP_MS);
    lastStep = now;
  }

  // One entry point for every trigger: a player event, a visibility change, or the fallback tick (hint "reconcile").
  function handle(hint) {
    const now = Date.now(), vid = videoIdFromUrl(), v = findVideo();
    if (v !== video) attach(v);
    if (cfg.tracking_enabled === false || !vid || !v) { endSession(cfg.tracking_enabled === false ? "tracking_off" : "navigation", false); return; }
    if (session && session.videoId !== vid) endSession("navigation", false);

    const o = observation(v);
    const playing = !v.paused && !v.ended && v.readyState > 2;
    const effPlaying = playing && !o.adShowing;
    if (!session) {
      if (!effPlaying) return; // nothing recorded until real playback starts
      startSession(now, vid);
    }
    stepAccounting(o, now);
    if (rec) {
      send(rec.observe(o, now, hint));
      rec.heartbeat(now, o.pos);
      if (hint === "reconcile") safe(() => chrome.storage.local.set({ live_rec: rec.snapshot() }));
    }
    if (o.paused === false && (o.waiting || o.seeking) && !settleT) settleT = setTimeout(() => { settleT = 0; handle("settle"); }, P.BUFFER_DEBOUNCE_MS + 50);

    if (effPlaying) {
      pausedSince = 0; endedSince = 0;
      if (now - lastFlush >= FLUSH_MS) flush();
    } else {
      if (wasEffPlaying) flush(); // capture the pause promptly
      if (v.ended) {
        if (!endedSince) endedSince = now;
        if (now - endedSince > ENDED_LINGER_MS) { endSession("ended"); return; }
      } else {
        endedSince = 0;
        if (!pausedSince) pausedSince = now;
        if (now - pausedSince > PAUSE_END_MS) { endSession("idle"); return; }
      }
    }
    wasEffPlaying = effPlaying;
    drain();
  }

  function attach(v) {
    if (video) VIDEO_EVENTS.forEach(n => video.removeEventListener(n, onVideoEvent));
    video = v;
    if (video) VIDEO_EVENTS.forEach(n => video.addEventListener(n, onVideoEvent, { passive: true }));
  }
  const onVideoEvent = e => handle(e.type);

  attach(findVideo());
  setInterval(() => handle("reconcile"), TICK_MS);
  document.addEventListener("visibilitychange", () => handle("visibility"));
  window.addEventListener("pagehide", () => endSession("pagehide"));
  // Just before YouTube swaps the page, credit the time up to now (the player still shows the old video).
  document.addEventListener("yt-navigate-start", () => { if (session) { const v = findVideo(); if (v) { stepAccounting(observation(v), Date.now()); } } });
  document.addEventListener("yt-navigate-finish", () => handle("navigation"));
})();
