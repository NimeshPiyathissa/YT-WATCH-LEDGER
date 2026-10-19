/* content/tracker.js — thin DOM adapter: reads the YouTube player once a second and feeds the pure
   state machine in lib/accounting.js (pause / seek / rewind / ad / progress logic lives and is tested there).
   Runs only on youtube.com. Sends session snapshots to the service worker. */
(function () {
  "use strict";
  const A = self.YTAccounting;
  const TICK_MS = 1000, FLUSH_MS = 5000, PAUSE_END_MS = 5 * 60 * 1000;
  const PRIVACY_KEYS = { tracking_enabled: true, collect_title: true, collect_channel: true, collect_url: true, collect_detail: true };
  let cfg = Object.assign({}, PRIVACY_KEYS), session = null, st = null;
  let lastTick = Date.now(), lastFlush = 0, wasEffPlaying = false, pausedSince = 0;

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const safe = fn => { try { return fn(); } catch (_e) { /* extension context invalidated */ } };

  safe(() => chrome.storage.local.get(PRIVACY_KEYS, o => { cfg = o; }));
  safe(() => chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    for (const k of Object.keys(PRIVACY_KEYS)) if (c[k]) cfg[k] = c[k].newValue;
    if (c.tracking_enabled && cfg.tracking_enabled === false) endSession();
  }));

  function videoIdFromUrl() {
    if (location.pathname === "/watch") return new URLSearchParams(location.search).get("v");
    if (location.pathname.indexOf("/shorts/") === 0) return location.pathname.split("/")[2] || null;
    return null;
  }
  const kindFromUrl = () => (location.pathname.indexOf("/shorts/") === 0 ? "shorts" : "watch");
  function readMeta() {
    const h1 = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.title");
    const title = (h1 && h1.textContent.trim()) || document.title.replace(/ - YouTube$/, "");
    const ch = document.querySelector("ytd-video-owner-renderer #channel-name a, #owner #channel-name a");
    return { title: title, channel: ch ? ch.textContent.trim() : "" };
  }

  function flush() {
    if (!session) return;
    const m = readMeta();
    if (m.title) session.title = m.title;
    if (m.channel) session.channel = m.channel;
    session.rev++;
    lastFlush = Date.now();
    // Fields the user turned off are blanked here, before they reach storage or the server.
    const snapshot = A.applyPrivacy(session, cfg);
    safe(() => chrome.runtime.sendMessage({ type: "SESSION_FLUSH", snapshot: snapshot }, () => void chrome.runtime.lastError));
    safe(() => chrome.storage.local.set({ last_heartbeat: Date.now(), live_video_id: session ? session.videoId : null }));
  }

  function endSession() {
    if (!session) return;
    session.endTs = Date.now();
    flush();
    session = null; st = null; wasEffPlaying = false;
    safe(() => chrome.storage.local.set({ live_video_id: null }));
  }

  function tick() {
    const now = Date.now(), dt = now - lastTick; lastTick = now;
    const vid = videoIdFromUrl();
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (cfg.tracking_enabled === false || !vid || !video) { endSession(); return; }
    if (session && session.videoId !== vid) endSession();

    const adShowing = !!document.querySelector(".html5-video-player.ad-showing");
    const playing = !video.paused && !video.ended && video.readyState > 2;
    const effPlaying = playing && !adShowing;
    if (!session) {
      if (!effPlaying) return; // nothing recorded until real playback starts
      session = A.newSession(uuid(), vid, kindFromUrl(), now);
      st = A.newTrackState();
    }
    A.step(session, st, { positionSec: video.currentTime, duration: video.duration, playing: playing, ended: video.ended, adShowing: adShowing, rate: video.playbackRate }, dt);

    if (effPlaying) {
      pausedSince = 0;
      if (now - lastFlush >= FLUSH_MS) flush();
    } else {
      if (wasEffPlaying) flush(); // capture the pause promptly
      if (!pausedSince) pausedSince = now;
      if (video.ended || now - pausedSince > PAUSE_END_MS) endSession();
    }
    wasEffPlaying = effPlaying;
  }

  setInterval(tick, TICK_MS);
  window.addEventListener("pagehide", endSession);
  document.addEventListener("yt-navigate-finish", () => { if (session && session.videoId !== videoIdFromUrl()) endSession(); });
})();
