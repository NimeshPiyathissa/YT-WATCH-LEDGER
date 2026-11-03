/* video.js — the Video Details page (#/video/<id>) and the Videos list (#/videos) of Watch Ledger.
   Everything from a device (titles, channel names, labels, ids) is untrusted and goes through esc(). No inline styles or scripts.
   Live behaviour: the page subscribes to the dashboard's server-sent event stream, adds each confirmed event to the timeline the
   moment the server stores it, re-folds the viewing with the same code the server uses (playback.js), and ticks the timers
   locally between events. Nothing is extrapolated for a device that is offline. */
(function () {
  "use strict";
  const WL = new Proxy({}, { get: (_t, k) => window.WL[k] }), TL = window.WLTimeline, P = window.YTPlayback, U = window.YTUtil, CH = window.WLVideoCharts, esc = U.escapeHtml, ic = window.YTIcons.icon;
  const $ = id => document.getElementById(id);
  const REDUCED = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TL_STEP = 300, EVENT_LIMIT = 2000;
  const qs = o => { const p = new URLSearchParams(); for (const k of Object.keys(o)) if (o[k] !== "" && o[k] != null && o[k] !== "all") p.set(k, o[k]); const s = p.toString(); return s ? "?" + s : ""; };
  const clock = sec => { const t = Math.max(0, Math.round(sec || 0)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0"); };
  const safeUrl = u => (/^https:\/\/www\.youtube\.com\//.test(u || "") ? u : "");

  /* ---- event vocabulary: label, icon, colour class ---- */
  const KIND = {
    VIDEO_STARTED: ["Started", "play", "k-start"], VIDEO_PLAYING: ["Speed changed", "activity", "k-play"], VIDEO_PAUSED: ["Paused", "pause", "k-pause"],
    VIDEO_RESUMED: ["Resumed", "play", "k-resume"], VIDEO_SEEKED: ["Seeked", "sliders-horizontal", "k-seek"], VIDEO_BUFFERING_STARTED: ["Buffering started", "refresh-cw", "k-buffer"],
    VIDEO_BUFFERING_ENDED: ["Buffering ended", "refresh-cw", "k-buffer"], VIDEO_COMPLETED: ["Completed", "circle-check", "k-done"], VIDEO_REPLAYED: ["Replayed", "history", "k-resume"],
    VIDEO_TAB_HIDDEN: ["Tab hidden", "eye", "k-tab"], VIDEO_TAB_VISIBLE: ["Tab visible", "eye", "k-tab"], VIDEO_SESSION_ENDED: ["Viewing ended", "check", "k-end"],
    VIDEO_SESSION_INTERRUPTED: ["Interrupted", "triangle-alert", "k-bad"]
  };
  const TYPES = Object.keys(KIND);
  const REASON = { user: "by the viewer", ad_break: "ad break", ad_break_end: "ad break ended", recovered: "recovered after the browser closed", navigation: "navigated away", pagehide: "tab closed",
    tracking_off: "tracking was turned off", idle: "idle for too long", reconcile: "noticed by the fallback check", paused: "because of a pause", ended: "video ended", retention: "retention" };

  let st = null;   // the open Video Details page, or null
  function dispose() {
    if (!st) return;
    clearInterval(st.tick); clearTimeout(st.refreshT); clearTimeout(st.retryT); clearInterval(st.poll);
    if (st.es) { st.es.close(); st.es = null; }
    window.removeEventListener("online", st.onOnline); window.removeEventListener("offline", st.onOffline);
    document.removeEventListener("visibilitychange", st.onVis);
    st = null;
  }
  const alive = s => st === s && document.body.contains($("vd"));

  /* ---- time ---- */
  const serverNow = () => Date.now() + (st ? st.offset : 0);
  // Every date and time on this page is Sri Lanka Standard Time (Asia/Colombo), converted from the stored UTC instant by Intl.
  // Nothing here reads the browser's zone and nothing adds hours by hand. dBoth is the full form: "November 3, 2026 · 12:45:02 PM (SLST)".
  const dDate = ts => (ts == null ? "—" : P.formatDate(ts, P.DISPLAY_TZ));
  const dTime = (ts, ms) => (ts == null ? "—" : P.formatTime(ts, P.DISPLAY_TZ, ms));
  const dBoth = (ts, ms) => (ts == null ? "—" : P.formatStamp(ts, P.DISPLAY_TZ, ms));
  const dur = ms => P.formatDuration(ms);

  /* ---- filters → query ---- */
  function range() {
    const f = st.F, tz = st.tz, out = { from: "", to: "" };
    if (f.fromDate) { const [y, m, d] = f.fromDate.split("-").map(Number), [h, mi] = (f.timeFrom || "00:00").split(":").map(Number); out.from = P.zonedToUtc(y, m, d, h, mi, 0, 0, tz); }
    if (f.toDate) { const [y, m, d] = f.toDate.split("-").map(Number), [h, mi] = (f.timeTo || "23:59").split(":").map(Number); out.to = P.zonedToUtc(y, m, d, h, mi, f.timeTo ? 0 : 59, f.timeTo ? 0 : 999, tz); }
    return out;
  }
  function query(extra) {
    const f = st.F, r = range();
    return qs(Object.assign({ device: f.device, session: f.session, from: r.from, to: r.to, type: [...f.types].join(","), completed: f.completed, tz: st.tz }, extra));
  }
  const filterCount = () => { const f = st.F; return [f.device !== "all", !!f.session, !!(f.fromDate || f.toDate), !!(f.timeFrom || f.timeTo), f.types.size > 0, !!f.completed].filter(Boolean).length; };

  /* ================= data ================= */
  const base = () => "/api/video/" + encodeURIComponent(st.videoId);
  async function fetchAll() {
    const s = st;
    const [detail, sessions, pauses, events, analytics] = await Promise.all([
      WL.api("GET", base() + qs({ device: s.F.device })), WL.api("GET", base() + "/sessions" + query()), WL.api("GET", base() + "/pauses" + query()),
      WL.api("GET", base() + "/events" + query({ order: "desc", limit: EVENT_LIMIT })), WL.api("GET", base() + "/analytics" + query())]);
    if (!alive(s)) return null;
    s.offset = detail.serverNow - Date.now();
    s.detail = detail; s.sessions = sessions.items; s.pauses = pauses.items; s.pauseStats = pauses.stats; s.pauseDist = pauses.distribution; s.analytics = analytics;
    s.events = TL.normalize(events.items); s.eventTotal = events.total; s.ids = new Set(s.events.map(e => e.id));
    // the open viewings are folded locally from here on: fetch their complete event lists once
    s.local = new Map();
    await Promise.all(s.sessions.filter(x => x.hasEvents && x.metrics.status === "open").map(x => loadLocal(x.sessionId, x.skewMs)));
    s.lastSync = Date.now() + s.offset; s.loadedAt = Date.now();
    return true;
  }
  async function loadLocal(sessionId, skewMs) {
    const s = st, r = await WL.api("GET", base() + "/events" + qs({ session: sessionId, order: "asc", limit: EVENT_LIMIT, device: s.F.device }));
    if (!alive(s)) return;
    s.local.set(sessionId, { skew: skewMs || 0, deviceId: r.items.length ? r.items[0].deviceId : null, events: r.items.map(e => ({ id: e.id, sessionId: e.sessionId, videoId: s.videoId, seq: e.seq, type: e.type, ts: e.ts, pos: e.pos, rate: e.rate, prev: e.prev, next: e.next, meta: e.meta })) });
  }

  /* ================= derived numbers (same rules as the server) ================= */
  const eventSessions = () => st.sessions.filter(s => s.hasEvents);
  const summaryOnly = () => st.sessions.filter(s => !s.hasEvents);
  const deviceOf = id => (st.detail && st.detail.devices.find(d => d.id === id)) || null;
  const isOnline = id => { const d = deviceOf(id); return !!(d && d.online); };
  // Current state is shown only for a device whose user has allowed live viewing (the server enforces it too: no stream, no current state).
  const liveAllowed = id => { const d = deviceOf(id); return !!(d && d.liveView === true); };
  const openPauseOf = s => st.pauses.find(p => p.sessionId === s.sessionId && p.status === "open") || null;
  function projected(s) {
    const live = s.metrics.status === "open" && isOnline(s.deviceId) && liveAllowed(s.deviceId);
    return P.project({ metrics: s.metrics, pauses: openPauseOf(s) ? [{ status: "open", pausedAt: openPauseOf(s).pausedAt, pausedPos: openPauseOf(s).pausedPos }] : [] }, serverNow(), { frozen: !live });
  }
  function totals() {
    const list = eventSessions().map(s => ({ metrics: projected(s), segments: s.segments || [], pauses: [] }));
    const dur0 = Math.max(st.detail.video.duration || 0, 0), r = P.rollup(list, dur0), legacy = summaryOnly();
    const legacyMs = legacy.reduce((n, s) => n + s.summary.watchedMs, 0);
    const last = st.sessions.slice().sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
    const pos = last ? (last.hasEvents ? last.metrics.lastPos : last.summary.positionSec) : 0;
    const open = list.map(l => l.metrics).filter(m => m.currentPauseMs > 0).sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
    r.activeAll = r.activeMs + legacyMs; r.sessionsAll = st.sessions.length; r.legacyCount = legacy.length; r.legacyMs = legacyMs;
    r.completedAll = r.completedSessions + legacy.filter(s => s.completed).length;
    r.position = pos; r.positionPct = r.duration > 0 ? Math.min(100, Math.round(pos / r.duration * 100)) : null;
    r.currentPauseMs = open ? open.currentPauseMs : 0;
    r.first = st.sessions.reduce((m, s) => Math.min(m, s.startedAt || m), Infinity); r.first = Number.isFinite(r.first) ? r.first : null;
    return r;
  }
  // The headline status: derived from the freshest viewing and whether its device is connected.
  function liveStatus() {
    const open = eventSessions().filter(s => s.metrics.status === "open").sort((a, b) => b.metrics.lastEventAt - a.metrics.lastEventAt)[0];
    if (open) {
      const m = projected(open), on = isOnline(open.deviceId);
      if (!liveAllowed(open.deviceId)) return { key: "notlive", text: "LIVE VIEW OFF", sub: "The person at this device has not allowed live viewing. This page shows what was recorded up to the last sync (" + dBoth(open.metrics.lastEventAt) + ").", session: open, m };
      if (!on) return { key: "offline", text: "DEVICE OFFLINE", sub: "Last event " + dBoth(open.metrics.lastEventAt) + ". Timers are frozen until it reconnects.", session: open, m };
      switch (open.metrics.state) {
        case "playing": return { key: "playing", text: "LIVE WATCHING", sub: "Playing at " + clock(m.lastPos + (serverNow() - open.metrics.since) / 1000 * (open.metrics.rate || 1)) + " · " + (open.metrics.rate || 1) + "×", session: open, m };
        case "paused": return { key: "paused", text: "PAUSED — " + P.formatClock(m.currentPauseMs), sub: "Paused at " + clock(open.metrics.lastPos) + " since " + dBoth(open.metrics.since), session: open, m, pausedTimer: true };
        case "buffering": return { key: "buffering", text: "BUFFERING", sub: "Waiting for data at " + clock(open.metrics.lastPos), session: open, m };
        case "ad": return { key: "ad", text: "AD PLAYING", sub: "Not counted as watch time", session: open, m };
        case "ended": return { key: "completed", text: "COMPLETED", sub: "Reached the end at " + dBoth(open.metrics.completedAt), session: open, m };
        default: break;
      }
    }
    const done = eventSessions().concat(summaryOnly()).some(s => s.completed);
    const last = st.sessions.slice().sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
    if (done) return { key: "completed", text: "COMPLETED", sub: "Watched to the end" + (last ? ". Last activity " + dBoth(last.lastEventAt) : ""), m: null };
    return { key: "idle", text: "NOT PLAYING", sub: last ? "Last activity " + dBoth(last.lastEventAt) : "No activity yet", m: null };
  }

  /* ================= rendering ================= */
  function statCard(k, label, icon, extra) {
    return `<article class="vd-stat" data-stat="${k}"><span class="vd-stat-ic">${ic(icon)}</span><div><div class="vd-stat-l">${esc(label)}</div><div class="vd-stat-v num" data-v="${k}">—</div><div class="vd-stat-s" data-s="${k}">${extra || ""}</div></div></article>`;
  }
  function frame(v) {
    const devOpts = `<option value="all">All devices</option>` + WL.devices().map(d => `<option value="${esc(d.id)}">${esc(d.label || "Device")}</option>`).join("");
    return `<div class="vd" id="vd">
      <a class="vd-back" href="#/videos">${ic("arrow-left")}All videos</a>
      <section class="vd-glass vd-hero" aria-labelledby="vdTitle">
        <div class="vd-thumb"><img id="vdThumb" src="${esc(v.thumbnail)}" alt="" width="320" height="180" loading="lazy" referrerpolicy="no-referrer" /><span class="vd-dur num" id="vdDur"></span></div>
        <div class="vd-hero-main">
          <div class="vd-badges"><span class="vd-status" id="vdStatus" data-k="idle" role="status" aria-live="polite"><i class="vd-dot"></i><span id="vdStatusText">…</span></span><span class="vd-chip vd-chip-done" id="vdDone" hidden>${ic("circle-check")}Completed</span><span class="vd-conn" id="vdConn" data-state="syncing"><i class="vd-dot"></i><span id="vdConnText">SYNCING</span></span></div>
          <h1 id="vdTitle" class="vd-title">${esc(v.title || v.videoId)}</h1>
          <p class="vd-meta" id="vdMeta"></p><p class="vd-sub" id="vdStatusSub"></p>
          <div class="vd-actions">
            <div class="vd-field"><span>Time zone</span><span class="vd-tz" title="All times are shown in Sri Lanka Standard Time (Asia/Colombo) and stored in UTC.">Sri Lanka time · SLST (UTC+05:30)</span></div>
            <label class="vd-field"><span>Device</span><select class="vd-input" id="vdDev">${devOpts}</select></label>
            <div class="vd-menu"><button class="vd-btn" id="vdExport" type="button" aria-haspopup="true" aria-expanded="false">${ic("download")}Export</button>
              <div class="vd-pop" id="vdExportMenu" hidden role="menu"><button role="menuitem" type="button" data-ex="csv:events">Events (CSV)</button><button role="menuitem" type="button" data-ex="csv:pauses">Pauses (CSV)</button><button role="menuitem" type="button" data-ex="csv:sessions">Sessions (CSV)</button><button role="menuitem" type="button" data-ex="json">Everything (JSON)</button><button role="menuitem" type="button" data-ex="print">Report for PDF…</button></div></div>
          </div>
        </div>
      </section>
      <section class="vd-glass vd-info" aria-label="Video information"><h2 class="vd-h">${ic("info")}Video information</h2><dl class="vd-kv" id="vdInfo"></dl></section>
      <section aria-label="Live statistics" class="vd-stats">
        ${statCard("active", "Active watch time", "play")}${statCard("paused", "Total paused time", "pause")}${statCard("elapsed", "Total elapsed time", "clock")}
        ${statCard("pauses", "Pause count", "pause")}${statCard("resumes", "Resume count", "play")}${statCard("pct", "Completion", "circle-check")}
      </section>
      <section class="vd-glass vd-filters" aria-label="Filters"><button class="vd-filter-toggle" id="vdFToggle" type="button" aria-expanded="false" aria-controls="vdFBody">${ic("filter")}Filters <span class="vd-count" id="vdFCount" hidden>0</span></button>
        <form id="vdFBody" class="vd-fbody" hidden autocomplete="off">
          <label class="vd-field"><span>From date</span><input class="vd-input" type="date" id="fFromD" /></label><label class="vd-field"><span>Start time</span><input class="vd-input" type="time" id="fFromT" /></label>
          <label class="vd-field"><span>To date</span><input class="vd-input" type="date" id="fToD" /></label><label class="vd-field"><span>End time</span><input class="vd-input" type="time" id="fToT" /></label>
          <label class="vd-field"><span>Viewing</span><select class="vd-input" id="fSess"><option value="">All viewings</option></select></label>
          <label class="vd-field"><span>Completion</span><select class="vd-input" id="fComp"><option value="">Any</option><option value="yes">Completed viewings</option><option value="no">Not completed</option></select></label>
          <fieldset class="vd-types"><legend>Event types</legend>${TYPES.map(t => `<label class="vd-check"><input type="checkbox" value="${t}" /><span>${esc(KIND[t][0])}</span></label>`).join("")}</fieldset>
          <p class="vd-hint">Dates and times are read in Sri Lanka time (SLST). The time of day applies to the first and last date. <button class="vd-link" id="fClear" type="button">Clear all filters</button></p>
        </form></section>
      <section class="vd-glass" aria-labelledby="vdRbH"><div class="vd-head"><h2 class="vd-h" id="vdRbH">${ic("film")}Timeline overview</h2></div><div id="vdRibbon"></div></section>
      <section class="vd-glass" aria-labelledby="vdTlH"><div class="vd-head"><h2 class="vd-h" id="vdTlH">${ic("activity")}Activity timeline</h2><div class="vd-tools"><button class="vd-btn vd-btn-sm" id="vdSort" type="button">Newest first</button></div></div>
        <div class="vd-quick" id="vdQuick" role="group" aria-label="Quick filters"></div>
        <p class="vd-hint" id="vdTlNote"></p><ol class="vd-tl" id="vdTl" aria-live="off"></ol><div class="vd-more"><button class="vd-btn" id="vdTlMore" type="button" hidden>Show older events</button></div></section>
      <section class="vd-glass" aria-labelledby="vdPaH"><div class="vd-head"><h2 class="vd-h" id="vdPaH">${ic("pause")}Pause and resume</h2></div><div id="vdPause"></div></section>
      <section class="vd-glass" aria-labelledby="vdSeH"><div class="vd-head"><h2 class="vd-h" id="vdSeH">${ic("history")}Watch sessions</h2></div><div id="vdSess" class="vd-sessions"></div></section>
      <section class="vd-glass" aria-labelledby="vdAnH"><div class="vd-head"><h2 class="vd-h" id="vdAnH">${ic("activity")}Analytics</h2></div><div class="vd-charts" id="vdCharts"></div></section>
    </div>`;
  }

  function renderHeader() {
    const v = st.detail.video, T = totals(), S = liveStatus();
    $("vdTitle").textContent = v.title || v.videoId;
    const chan = v.channelUrl && safeUrl(v.channelUrl) ? `<a href="${esc(v.channelUrl)}" target="_blank" rel="noopener noreferrer">${esc(v.channel || v.channelUrl)}</a>` : esc(v.channel || "Unknown channel");
    $("vdMeta").innerHTML = `${chan} · <a href="${esc(safeUrl(v.url) || "#")}" target="_blank" rel="noopener noreferrer">${esc(v.url.replace(/^https:\/\/www\./, ""))}</a> · <span class="num">${esc(v.videoId)}</span>`;
    $("vdDur").textContent = v.duration ? clock(v.duration) : "";
    $("vdDur").hidden = !v.duration;
    $("vdDone").hidden = !(T.completedAll > 0);
    $("vdStatus").dataset.k = S.key; $("vdStatusText").textContent = S.text; $("vdStatusSub").textContent = S.sub;
    renderInfo(T, v);
  }
  function renderInfo(T, v) {
    const devs = st.detail.devices, S = liveStatus(), cur = S.session;
    const row = (k, val, cls) => `<div class="vd-kv-r${cls ? " " + cls : ""}"><dt>${esc(k)}</dt><dd>${val}</dd></div>`;
    const deviceList = devs.length ? devs.map(d => `<span class="vd-dev ${d.online ? "on" : ""}"><i></i>${esc(d.label)}<small>${esc([d.platform, d.clientVersion && "v" + d.clientVersion].filter(Boolean).join(" · "))} · ${d.online ? "connected" : d.lastSeen ? "last seen " + esc(dBoth(d.lastSeen)) : "never seen"}</small></span>`).join("") : "—";
    $("vdInfo").innerHTML = [
      row("Video ID", `<span class="num">${esc(v.videoId)}</span>`), row("Video URL", `<a href="${esc(safeUrl(v.url) || "#")}" target="_blank" rel="noopener noreferrer" class="break">${esc(v.url)}</a>`),
      row("Channel", esc(v.channel || "Unknown")), row("Channel URL", v.channelUrl && safeUrl(v.channelUrl) ? `<a href="${esc(v.channelUrl)}" target="_blank" rel="noopener noreferrer" class="break">${esc(v.channelUrl)}</a>` : "Not available"),
      row("Channel ID", v.channelId ? `<span class="num">${esc(v.channelId)}</span>` : "Not available (the channel link has no ID)"), row("Duration", v.duration ? `<span class="num">${esc(clock(v.duration))}</span> (${esc(dur(v.duration * 1000))})` : "Not reported"),
      row("Current position", `<span class="num" data-live="pos">${esc(clock(T.position))}</span>${T.positionPct != null ? ` · ${T.positionPct}%` : ""}`), row("Playback percentage", T.progressPct != null ? `Furthest <span class="num">${T.progressPct}%</span> · unique content <span class="num">${T.uniqueContentPct}%</span>` : "Unknown (no duration)"),
      row("First watched", `<span class="num">${esc(dBoth(T.first))}</span>`), row("Last watched", `<span class="num">${esc(dBoth(T.lastActivity))}</span>`),
      row("Last activity", `<span class="num" data-live="last">${esc(T.lastActivity ? ago(T.lastActivity) : "—")}</span>`), row("Total watch sessions", `<span class="num">${T.sessionsAll}</span>${T.legacyCount ? ` <small>(${T.legacyCount} without event history)</small>` : ""}`),
      row("Total active watch time", `<span class="num" data-live="active2">${esc(P.formatClock(T.activeAll))}</span>`), row("Total paused time", `<span class="num">${esc(dur(T.pausedMs))}</span>${T.unresolvedPausedMs ? ` <small>+ at least ${esc(dur(T.unresolvedPausedMs))} unresolved</small>` : ""}`),
      row("Total elapsed session time", `<span class="num">${esc(dur(T.elapsedMs))}</span>`), row("Buffering time", `<span class="num">${esc(dur(T.bufferingMs))}</span>`),
      row("Unique content watched", `<span class="num">${esc(dur(T.uniqueContentSec * 1000))}</span> · rewatched <span class="num">${esc(dur(T.rewatchMs))}</span>`), row("Pause / resume count", `<span class="num">${T.pauseCount} / ${T.resumeCount}</span> · seeks <span class="num">${T.seekCount}</span>`),
      row("Completion status", T.completedAll ? `Completed in ${T.completedAll} of ${T.sessionsAll} viewing${T.sessionsAll === 1 ? "" : "s"}` : "Not completed"), row("Completion timestamp", T.completedAt ? `<span class="num">${esc(dBoth(T.completedAt, true))}</span>` : "—"),
      row("Devices", `<div class="vd-devs">${deviceList}</div>`, "wide"),
      row("Current session", cur ? `<span class="num break">${esc(cur.sessionId)}</span> · ${esc(cur.metrics.state)} · started ${esc(dBoth(cur.metrics.startedAt))}` : "No viewing in progress", "wide")
    ].join("");
  }
  function ago(ts) { const s = Math.max(0, Math.round((serverNow() - ts) / 1000)); return s < 5 ? "just now" : s < 60 ? s + " s ago" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; }

  /* ---- statistic cards: tick locally between events ---- */
  const shown = {};
  function setNum(el, text, k) {
    if (el.textContent === text) return;
    el.textContent = text;
    if (!REDUCED() && k && shown[k] !== undefined && shown[k] !== text) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
    shown[k] = text;
  }
  function updateStats() {
    const T = totals(), S = liveStatus();
    setNum($("vdStatusText"), S.text, "status-text");
    document.querySelector('[data-v="active"]').textContent = P.formatClock(T.activeAll);
    document.querySelector('[data-s="active"]').textContent = T.legacyCount ? `includes ${dur(T.legacyMs)} from ${T.legacyCount} older viewing${T.legacyCount === 1 ? "" : "s"} (summary only)` : T.uniqueContentSec ? `${dur(T.uniqueContentSec * 1000)} of unique content` : "playing time";
    const pausedTxt = P.formatClock(T.pausedMs + T.currentPauseMs);
    document.querySelector('[data-v="paused"]').textContent = pausedTxt;
    document.querySelector('[data-s="paused"]').textContent = T.currentPauseMs > 0 ? `paused now ${P.formatClock(T.currentPauseMs)}` : T.unresolvedPausedMs ? `+ at least ${dur(T.unresolvedPausedMs)} unresolved` : "completed pauses";
    document.querySelector('[data-v="elapsed"]').textContent = P.formatClock(T.elapsedMs);
    document.querySelector('[data-s="elapsed"]').textContent = `${T.sessions} viewing${T.sessions === 1 ? "" : "s"} with events`;
    setNum(document.querySelector('[data-v="pauses"]'), String(T.pauseCount), "pauses"); document.querySelector('[data-s="pauses"]').textContent = st.pauseStats && st.pauseStats.count ? `avg ${dur(st.pauseStats.avgMs)} · longest ${dur(st.pauseStats.longestMs)}` : "no pauses yet";
    setNum(document.querySelector('[data-v="resumes"]'), String(T.resumeCount), "resumes"); document.querySelector('[data-s="resumes"]').textContent = T.pauseCount > T.resumeCount ? `${T.pauseCount - T.resumeCount} pause${T.pauseCount - T.resumeCount === 1 ? "" : "s"} without a resume` : "every pause resumed";
    const pct = T.progressPct == null ? "—" : T.progressPct + "%";
    setNum(document.querySelector('[data-v="pct"]'), pct, "pct");
    document.querySelector('[data-s="pct"]').innerHTML = T.progressPct == null ? "duration unknown" : `<svg class="vd-meter" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${T.progressPct}% reached"><rect class="vd-meter-bg" width="100" height="6" rx="3"/><rect class="vd-meter-fill" width="${T.progressPct}" height="6" rx="3"/></svg> <span>${T.uniqueContentPct}% actually played</span>`;
    // header timers
    $("vdStatus").dataset.k = S.key; $("vdStatusSub").textContent = S.sub;
    for (const el of document.querySelectorAll('[data-live="pos"]')) el.textContent = clock(S.key === "playing" && S.session ? S.m.lastPos + (serverNow() - S.session.metrics.since) / 1000 * (S.session.metrics.rate || 1) : T.position);
    for (const el of document.querySelectorAll('[data-live="active2"]')) el.textContent = P.formatClock(T.activeAll);
    for (const el of document.querySelectorAll('[data-live="last"]')) el.textContent = T.lastActivity ? ago(T.lastActivity) : "—";
    for (const el of document.querySelectorAll("[data-open-pause]")) { const p = st.pauses.find(x => x.pausedEventId === el.dataset.openPause); if (p && p.status === "open") el.textContent = isOnline(p.deviceId) ? P.formatClock(serverNow() - p.pausedAt) : "offline, frozen"; }
    renderConn();
  }

  /* ---- connection indicator ---- */
  function setConn(state) { if (st.conn === state) return; st.conn = state; renderConn(); }
  function renderConn() {
    const el = $("vdConn"); if (!el) return;
    const label = { live: "LIVE", syncing: "SYNCING", offline: "OFFLINE", reconnecting: "RECONNECTING" }[st.conn];
    el.dataset.state = st.conn; $("vdConnText").textContent = label;
    el.title = (st.lastSync ? "Last successful sync " + dBoth(st.lastSync) : "Not synced yet") + (st.conn === "offline" ? ". This browser is offline." : "");
    $("vdLast") && ($("vdLast").textContent = st.lastSync ? dBoth(st.lastSync) : "—");
  }

  /* ---- timeline ---- */
  function describe(e) {
    const r = e.related, pos = clock(e.pos), m = e.meta || {};
    switch (e.type) {
      case "VIDEO_STARTED": return { t: "Started playing", d: `Playback began at ${pos}${e.rate !== 1 ? " · " + e.rate + "×" : ""}.`, rel: "" };
      case "VIDEO_PLAYING": return { t: "Playback speed changed", d: `Speed ${m.rateFrom || "?"}× → ${e.rate}× at ${pos}.`, rel: "" };
      case "VIDEO_PAUSED": return { t: r && r.n ? "Pause #" + r.n : "Paused", d: m.reason === "ad_break" ? `An ad break began at ${pos} (not counted as a pause).` : `Paused at ${pos}.`, rel: relPause(e, r) };
      case "VIDEO_RESUMED": return m.reason === "ad_break_end" ? { t: "Ad break ended", d: `Playback continued at ${pos}.`, rel: "" } : { t: r && r.n ? "Resume #" + r.n : "Resumed", d: `Resumed at ${pos}${r && r.ms != null ? " after " + dur(r.ms) + " paused" : ""}.`, rel: r && r.ms != null ? "paused " + dur(r.ms) : "" };
      case "VIDEO_SEEKED": return { t: "Seeked", d: r && r.fromSec != null ? `Jumped from ${clock(r.fromSec)} to ${clock(r.toSec)} (${r.toSec >= r.fromSec ? "forward " + dur((r.toSec - r.fromSec) * 1000) : "back " + dur((r.fromSec - r.toSec) * 1000)}). Skipped content is not counted as watched.` : `Jumped to ${pos}.`, rel: "" };
      case "VIDEO_BUFFERING_STARTED": return { t: "Buffering started", d: `The player was waiting for data at ${pos}.`, rel: r && r.ms != null ? "stalled " + dur(r.ms) : "" };
      case "VIDEO_BUFFERING_ENDED": return { t: "Buffering ended", d: `Playback continued at ${pos}.`, rel: m.dur != null ? "stalled " + dur(m.dur) : "" };
      case "VIDEO_COMPLETED": return { t: "Completed", d: `Reached the end of the video${r && r.ms != null ? ", " + dur(r.ms) + " after the viewing began (interruptions included)" : ""}.`, rel: r && r.ms != null ? "took " + dur(r.ms) : "" };
      case "VIDEO_REPLAYED": return { t: "Replayed", d: "Playback started again after the video ended.", rel: "" };
      case "VIDEO_TAB_HIDDEN": return { t: "Tab hidden", d: "The YouTube tab went to the background. Playback may continue.", rel: "" };
      case "VIDEO_TAB_VISIBLE": return { t: "Tab visible", d: "The YouTube tab came back to the foreground.", rel: "" };
      case "VIDEO_SESSION_ENDED": return { t: "Viewing ended", d: `The viewing ended at ${pos} (${REASON[m.reason] || "closed normally"}).`, rel: r && r.ms != null ? "lasted " + dur(r.ms) : "" };
      case "VIDEO_SESSION_INTERRUPTED": return { t: "Viewing interrupted", d: `The browser or tab closed without an end event. This is the last time the extension confirmed activity (${pos}); the real end is unknown.`, rel: r && r.minMs != null ? "at least " + dur(r.minMs) + " elapsed" : "" };
      default: return { t: e.type, d: "", rel: "" };
    }
  }
  function relPause(e, r) {
    if (!r || (e.meta && e.meta.reason === "ad_break")) return "";
    if (r.unresolved) return "unresolved · at least " + dur(r.minMs);
    if (r.open) return `<span data-open-pause="${esc(e.id)}">${P.formatClock(isOnline(e.deviceId) ? serverNow() - e.tsAdj : 0)}</span> so far`;
    if (r.ms != null) return (r.endedBy === "session_ended" ? "ended with the viewing · " : "") + dur(r.ms);
    return "";
  }
  function tlItem(e, number) {
    const k = KIND[e.type] || [e.type, "info", "k-play"], d = describe(e), open = st.open.has(e.id);
    const relHtml = d.rel ? (d.rel.startsWith("<") ? d.rel : esc(d.rel)) : "";
    return `<li class="vd-ev ${k[2]}${st.fresh.has(e.id) ? " fresh" : ""}" data-id="${esc(e.id)}"><span class="vd-ev-n num">#${number}</span><span class="vd-ev-ic" aria-hidden="true">${ic(k[1])}</span>
      <div class="vd-ev-body"><button class="vd-ev-btn" type="button" aria-expanded="${open}" aria-controls="x-${esc(e.id)}"><span class="vd-ev-t">${esc(d.t)}</span>
        <span class="vd-ev-when num">${esc(dBoth(e.tsAdj))}</span><span class="vd-ev-pos num">${esc(clock(e.pos))}</span>${relHtml ? `<span class="vd-ev-rel">${relHtml}</span>` : ""}<span class="vd-ev-chev" aria-hidden="true">${ic("chevron-right")}</span></button>
        <p class="vd-ev-d">${esc(d.d)}</p>${open ? evDetail(e) : ""}</div></li>`;
  }
  function evDetail(e) {
    const m = e.meta || {}, skew = e.tsAdj - e.ts, kv = [
      ["Event ID", `<span class="num break">${esc(e.id)}</span>`], ["Type", esc(e.type)], ["Date and time", `<span class="num">${esc(dBoth(e.tsAdj, true))}</span>`],
      ["UTC (stored)", `<span class="num">${esc(new Date(e.tsAdj).toISOString())}</span>`], ["As the device saw it", `<span class="num">${esc(new Date(e.ts).toISOString())}</span>${Math.abs(skew) > 60000 ? ` · device clock ${dur(Math.abs(skew))} ${skew > 0 ? "behind" : "ahead"}` : ""}`],
      ["Playback position", `<span class="num">${esc(clock(e.pos))} (${e.pos}s)</span>`], ["Playback speed", `<span class="num">${e.rate}×</span>`], ["State change", `${esc(e.prev)} → ${esc(e.next)}`],
      ["Device", esc(e.deviceLabel || "Device")], ["Viewing", `<span class="num break">${esc(e.sessionId)}</span> · event ${e.seq}`], ["Reason", esc(m.reason ? REASON[m.reason] || m.reason : "—")],
      ["Related", esc(e.related ? (e.related.kind === "seek" ? `from ${clock(e.related.fromSec)} to ${clock(e.related.toSec)}` : e.related.ms != null ? dur(e.related.ms) : e.related.unresolved ? "unresolved, at least " + dur(e.related.minMs) : e.related.open ? "still paused" : "—") : "—")],
      ["Server", `<span class="vd-ok">${ic("check")}confirmed and stored</span>`]
    ];
    return `<dl class="vd-ev-kv" id="x-${esc(e.id)}">${kv.map(r => `<div><dt>${r[0]}</dt><dd>${r[1]}</dd></div>`).join("")}</dl>`;
  }
  /* ---- timeline v2: viewing boundaries, quick filters, the interactive overview ---- */
  function timelineRows(vis) {
    const numOf = new Map(vis.map(x => [x.e.id, x.n])), asc = (st.sortDesc ? vis.slice().reverse() : vis).map(x => x.e);
    const meta = {}; for (const s of st.sessions) meta[s.sessionId] = { deviceLabel: s.deviceLabel, startedAt: s.startedAt, endedAt: s.endedAt, state: s.state, completed: s.completed };
    const items = TL.withBoundaries(asc, meta);
    return (st.sortDesc ? items.slice().reverse() : items).map(x => x.kind === "event" ? tlItem(x.e, numOf.get(x.e.id)) : boundaryItem(x));
  }
  function boundaryItem(b) {
    const start = b.edge === "start", s = b.meta;
    const sub = start ? esc(dBoth(b.at)) : b.open ? "last event " + esc(dBoth(b.at)) + " (viewing still open, or its end is not in this list)" : esc(dBoth(b.at)) + (s && s.state === "interrupted" ? " · interrupted" : s && s.completed ? " · completed" : "");
    return `<li class="vd-bound ${start ? "start" : "end"}" role="separator" aria-label="${start ? "Viewing started" : "Viewing ended"}"><span class="vd-bound-l">${ic(start ? "play" : "check")}${start ? "Viewing started" : "Viewing ended"}</span><span class="vd-bound-d">${esc(b.deviceLabel)}</span><span class="vd-bound-t num">${sub}</span></li>`;
  }
  function renderQuick() {
    const cur = TL.groupOf(st.F.types);
    $("vdQuick").innerHTML = TL.GROUPS.map(g => `<button type="button" class="vd-qf" data-g="${g.key}" aria-pressed="${g.key === cur}">${esc(g.label)}</button>`).join("");
    $("vdQuick").querySelectorAll("[data-g]").forEach(b => b.onclick = () => {
      st.F.types = new Set(TL.typesOf(b.dataset.g));
      document.querySelectorAll("#vdFBody .vd-types input").forEach(i => { i.checked = st.F.types.has(i.value); });
      reload();
    });
  }
  const KCLS = { VIDEO_STARTED: "k-start", VIDEO_PLAYING: "k-play", VIDEO_PAUSED: "k-pause", VIDEO_RESUMED: "k-resume", VIDEO_SEEKED: "k-seek", VIDEO_BUFFERING_STARTED: "k-buffer", VIDEO_BUFFERING_ENDED: "k-buffer",
    VIDEO_COMPLETED: "k-done", VIDEO_REPLAYED: "k-resume", VIDEO_TAB_HIDDEN: "k-tab", VIDEO_TAB_VISIBLE: "k-tab", VIDEO_SESSION_ENDED: "k-end", VIDEO_SESSION_INTERRUPTED: "k-bad", MIXED: "k-mix" };
  function renderRibbon() {
    const box = $("vdRibbon"), r = TL.ribbon(st.events, st.pauses);
    if (!r.lanes.length) { box.innerHTML = `<p class="vd-hint">${ic("film")} No events to draw${filterCount() ? " for these filters" : " yet"}.</p>`; return; }
    const H = 28, lanes = r.lanes.map((l, i) => {
      const mk = l.markers.map(m => `<line class="mk ${KCLS[m.type] || "k-play"}" x1="${m.x}" x2="${m.x}" y1="4" y2="${H - 4}" data-id="${esc(m.id)}" data-at="${m.at}" data-n="${m.count}" tabindex="0" role="button" aria-label="${esc(m.count > 1 ? m.count + " events from " + dBoth(m.at) : (KIND[m.type] ? KIND[m.type][0] : m.type) + " at " + dBoth(m.at))}"><title>${esc(m.count > 1 ? m.count + " events near " + dBoth(m.at) : (KIND[m.type] ? KIND[m.type][0] : m.type) + " · " + dBoth(m.at) + " · " + clock(m.pos))}</title></line>`).join("");
      const ps = l.pauses.map(p => `<rect class="pz ${esc(p.status)}" x="${p.x0}" y="9" width="${Math.max(0.5, p.x1 - p.x0)}" height="${H - 18}" rx="2"/>`).join("");
      return `<div class="rb-lane"><div class="rb-l" title="${esc(dBoth(l.first))}"><span class="mono">${esc(String(l.sessionId).slice(0, 8))}</span><small>${esc(l.deviceLabel)}</small><small class="num">${esc(dur(l.durationMs))} · ${l.events} events</small></div><svg viewBox="0 0 1000 ${H}" preserveAspectRatio="none" role="group" aria-label="Viewing ${i + 1}: ${l.events} events"><rect class="rb-span" x="${l.x0}" y="${H / 2 - 1}" width="${Math.max(1, l.x1 - l.x0)}" height="2"/>${ps}${mk}</svg></div>`;
    }).join("");
    box.innerHTML = `<p class="vd-hint">One row per viewing, each stretched over its own length. Markers are events; shaded spans are pauses. Click or press Enter on a marker to jump to it in the list below.</p>
      <div class="rb">${lanes}</div>
      <p class="vd-hint rb-info" id="rbInfo" role="status" aria-live="polite">Hover or focus a marker for details.</p>`;
    const info = $("rbInfo");
    box.querySelectorAll("line.mk").forEach(m => {
      const say = () => { info.textContent = (m.getAttribute("aria-label") || ""); };
      m.addEventListener("mouseenter", say); m.addEventListener("focus", say);
      m.onclick = () => focusEvent(m.dataset.id);
      m.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); focusEvent(m.dataset.id); } });
    });
  }
  // Jump from the overview to one event in the list: make sure it is shown (not hidden behind "show more"), open it, scroll to it, flash it.
  function focusEvent(id) {
    if (!st.events.some(e => e.id === id)) return;
    const asc = st.events.map(e => e.id), idx = st.sortDesc ? asc.length - 1 - asc.indexOf(id) : asc.indexOf(id);
    if (idx >= st.tlLimit) st.tlLimit = Math.ceil((idx + 1) / TL_STEP) * TL_STEP;
    st.open.add(id); renderTimeline();
    const li = document.querySelector(`#vdTl li[data-id="${CSS.escape(id)}"]`);
    if (li) { li.scrollIntoView({ block: "center", behavior: REDUCED() ? "auto" : "smooth" }); li.classList.add("hl"); setTimeout(() => li.classList.remove("hl"), 2200); const b = li.querySelector(".vd-ev-btn"); if (b) b.focus({ preventScroll: true }); }
  }

  function renderTimeline() {
    const list = st.events.slice(), total = st.eventTotal, firstNo = total - list.length + 1;
    const ordered = st.sortDesc ? list.map((e, i) => ({ e, n: firstNo + i })).reverse() : list.map((e, i) => ({ e, n: firstNo + i }));
    const vis = ordered.slice(0, st.tlLimit);
    $("vdTl").innerHTML = vis.length ? timelineRows(vis).join("") : `<li class="vd-empty">${ic("film")}<p>No events match. ${filterCount() ? "Clear a filter to see more." : "Events appear here as the extension records them."}</p></li>`;
    $("vdTlMore").hidden = ordered.length <= vis.length; $("vdTlMore").textContent = `Show ${Math.min(TL_STEP, ordered.length - vis.length)} more (${ordered.length - vis.length} hidden)`;
    $("vdSort").textContent = st.sortDesc ? "Newest first" : "Oldest first";
    renderQuick(); renderRibbon();
    const dev = st.detail.devices.filter(d => st.F.device === "all" || d.id === st.F.device);
    $("vdTlNote").innerHTML = `Every event listed here is <b>confirmed</b>: the server has stored it. Events a device records while it is offline are held on that device and appear here, in order, when it reconnects${dev.length ? " (" + dev.map(d => esc(d.label) + (d.lastEventsAt ? " last delivered " + esc(dBoth(d.lastEventsAt)) : " has not delivered events yet")).join("; ") + ")" : ""}.${total > list.length ? ` Showing the latest ${list.length} of ${total}; narrow the filters or export for the rest.` : ""} Last sync <span class="num" id="vdLast">${esc(st.lastSync ? dBoth(st.lastSync) : "—")}</span>.`;
  }

  /* ---- pause table ---- */
  function renderPauses() {
    const ps = st.pauses, S = st.pauseStats || P.pauseStats(ps);
    const stat = (l, v) => `<div class="vd-mini"><span>${esc(l)}</span><b class="num">${v}</b></div>`;
    const status = p => p.status === "unresolved" ? `<span class="vd-tag warn">Unresolved</span>` : p.status === "open" ? `<span class="vd-tag live">Paused now</span>` : p.status === "session_ended" ? `<span class="vd-tag">Ended with viewing</span>` : p.status === "ad_break" ? `<span class="vd-tag">Ad break</span>` : "";
    $("vdPause").innerHTML = `<div class="vd-minis">${stat("Total pauses", S.count)}${stat("Total paused", esc(dur(S.totalMs)))}${stat("Average", esc(dur(S.avgMs)))}${stat("Longest", esc(dur(S.longestMs)))}${stat("Shortest", S.completed ? esc(dur(S.shortestMs)) : "—")}</div>
      ${ps.length ? `<div class="vd-scroll"><table class="vd-table vd-rt"><thead><tr><th>Pause</th><th>Paused at</th><th>Resumed at</th><th class="r">Duration</th><th class="r">Position</th></tr></thead><tbody>${ps.slice().reverse().map(p => `<tr>
        <td data-label="Pause"><b class="num">#${p.number}</b> <small>${esc(p.deviceLabel)}</small> ${status(p)}</td>
        <td data-label="Paused at" class="num">${esc(dBoth(p.pausedAt))}</td>
        <td data-label="Resumed at" class="num">${p.resumedAt != null ? esc(dBoth(p.resumedAt)) : p.status === "unresolved" ? "unknown" : p.status === "open" ? "not yet" : "—"}</td>
        <td data-label="Duration" class="num r">${p.durationMs != null ? esc(dur(p.durationMs)) : p.status === "unresolved" ? `at least ${esc(dur(p.minDurationMs))}` : `<span data-open-pause="${esc(p.pausedEventId || "")}">${P.formatClock(isOnline(p.deviceId) ? serverNow() - p.pausedAt : 0)}</span>`}</td>
        <td data-label="Position" class="num r">${esc(clock(p.pausedPos))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="vd-empty">${ic("pause")}<p>No pauses recorded${filterCount() ? " for these filters" : ""}.</p></div>`}
      <p class="vd-hint">A pause is closed by the next resume. If a viewing ends while paused, the pause closes at that recorded end time; if the browser vanished, the pause is shown as <b>unresolved</b> with the time it is known to have lasted at least. Nothing is guessed.</p>`;
  }

  /* ---- sessions ---- */
  function renderSessions() {
    const items = st.sessions;
    $("vdSess").innerHTML = items.length ? items.map(s => {
      const open = st.sessOpen.has(s.sessionId), m = s.hasEvents ? projected(s) : null;
      const stateTag = !s.hasEvents ? `<span class="vd-tag">Summary only</span>` : s.metrics.status === "open" ? (isOnline(s.deviceId) ? `<span class="vd-tag live">In progress</span>` : `<span class="vd-tag warn">Device offline</span>`) : s.metrics.status === "interrupted" ? `<span class="vd-tag warn">Interrupted</span>` : `<span class="vd-tag">Ended</span>`;
      const end = s.hasEvents ? (s.metrics.endedAt != null ? dBoth(s.metrics.endedAt) : s.metrics.interruptedAt != null ? "unknown (last activity " + dBoth(s.metrics.interruptedAt) + ")" : "in progress") : s.endedAt ? dBoth(s.endedAt) : "unknown";
      const grid = s.hasEvents ? [["Active", dur(m.activeMs)], ["Paused", dur(m.pausedMs) + (m.unresolvedPausedMs ? " + ≥" + dur(m.unresolvedPausedMs) : "")], ["Buffering", dur(m.bufferingMs)], ["Elapsed", dur(m.elapsedMs)], ["Pauses", m.pauseCount + " / " + m.resumeCount + " resumed"], ["Seeks", m.seekCount], ["Completion", m.completed ? "Completed " + dTime(m.completedAt) : "No"]]
        : [["Watched", dur(s.summary.watchedMs)], ["Pauses (count only)", s.summary.pauses], ["Seeks (count only)", s.summary.seeks], ["Completion", s.completed ? "Completed" : "No"]];
      return `<article class="vd-sess${open ? " open" : ""}" data-sid="${esc(s.sessionId)}"><button class="vd-sess-h" type="button" aria-expanded="${open}"><span class="vd-sess-t"><b class="num">${esc(dBoth(s.startedAt))}</b> → <span class="num">${esc(end)}</span></span>
        <span class="vd-sess-m">${WL.chip(s.deviceId, s.deviceLabel)} ${stateTag}${s.completed ? `<span class="vd-tag ok">Completed</span>` : ""}</span><span class="vd-ev-chev" aria-hidden="true">${ic("chevron-right")}</span></button>
        <dl class="vd-sess-g">${grid.map(g => `<div><dt>${esc(g[0])}</dt><dd class="num">${esc(String(g[1]))}</dd></div>`).join("")}</dl>
        ${open ? `<div class="vd-sess-tl" id="sx-${esc(s.sessionId)}">${s.hasEvents ? '<p class="vd-hint">Loading…</p>' : `<p class="vd-hint">This viewing was recorded before event tracking existed (or with detail collection off), so it has only a summary. No timeline is available and none is invented.</p>`}</div>` : ""}</article>`;
    }).join("") : `<div class="vd-empty">${ic("film")}<p>No viewings${filterCount() ? " match these filters" : " recorded yet"}.</p></div>`;
    for (const sid of st.sessOpen) { const box = $("sx-" + sid); const s = items.find(x => x.sessionId === sid); if (box && s && s.hasEvents) fillSessionTl(sid, box); }
  }
  async function fillSessionTl(sid, box) {
    const s = st;
    try {
      let evs = s.sessEvents.get(sid);
      if (!evs || s.local.has(sid)) {
        const r = await WL.api("GET", base() + "/events" + qs({ session: sid, order: "asc", limit: EVENT_LIMIT, device: s.F.device }));
        if (!alive(s)) return; evs = r.items; s.sessEvents.set(sid, evs);
      }
      box.innerHTML = `<ol class="vd-tl vd-tl-compact">${evs.map((e, i) => tlItem(e, i + 1)).join("")}</ol>`;
    } catch (e) { if (e.message !== "unauthorized") box.innerHTML = `<p class="vd-hint">Could not load this viewing's events.</p>`; }
  }

  /* ---- charts ---- */
  function renderCharts() {
    const a = st.analytics, sess = eventSessions().sort((a1, b1) => a1.startedAt - b1.startedAt);
    const pick = st.progressSid && sess.find(s => s.sessionId === st.progressSid) || sess[sess.length - 1];
    const card = (title, sub, body, extra) => `<article class="vd-chart-card"><h3>${esc(title)}</h3><p class="vd-hint">${esc(sub)}</p>${extra || ""}${body}</article>`;
    $("vdCharts").innerHTML = [
      card("Watch activity", "Playing time per " + (a.runs.length && a.runs[a.runs.length - 1].ts - a.runs[0].ts > 172800000 ? "day" : "hour") + ", from recorded playback runs, in Sri Lanka time (SLST)", CH.activity(a.runs, st.tz)),
      card("Playback progress", "Position in the video against time since the viewing began. Shaded = paused.", pick ? CH.progress(pick, a.runs.map(r => r), st.pauses.filter(p => p.sessionId === pick.sessionId), a.duration || st.detail.video.duration) + CH.coverage(pick.segments || [], a.duration || st.detail.video.duration) : CH.progress({ sessionId: "", startedAt: 0 }, [], [], 0),
        sess.length > 1 ? `<label class="vd-field vd-field-inline"><span>Viewing</span><select class="vd-input" id="vdProgSel">${sess.map(s => `<option value="${esc(s.sessionId)}"${pick && s.sessionId === pick.sessionId ? " selected" : ""}>${esc(dBoth(s.startedAt))}</option>`).join("")}</select></label>` : ""),
      card("Pause and resume distribution", "How long the pauses lasted", CH.pauseDistribution(a.pauseDistribution)),
      card("Watch-time breakdown", "Where the time went across all viewings", CH.breakdown(a.breakdown) + `<h4 class="vd-sub-h">Content actually played, all viewings</h4>` + CH.coverage(a.coverage, a.duration || st.detail.video.duration)),
      card("Session comparison", "Playing and paused time per viewing (most recent 12)", CH.sessionsComparison(a.sessions, st.tz))
    ].join("");
    const sel = $("vdProgSel"); if (sel) sel.onchange = () => { st.progressSid = sel.value; renderCharts(); };
  }

  function renderAll() {
    renderHeader(); updateStats(); renderTimeline(); renderPauses(); renderSessions(); renderCharts();
    const f = $("fSess"); if (f) { const cur = st.F.session; f.innerHTML = `<option value="">All viewings</option>` + st.sessions.map(s => `<option value="${esc(s.sessionId)}"${s.sessionId === cur ? " selected" : ""}>${esc(dBoth(s.startedAt))} · ${esc(s.deviceLabel)}</option>`).join(""); }
    const c = filterCount(); $("vdFCount").hidden = !c; $("vdFCount").textContent = c;
  }

  /* ================= live updates ================= */
  const matches = e => { const f = st.F, r = range(); return (f.types.size === 0 || f.types.has(e.type)) && (!f.session || f.session === e.sessionId) && (r.from === "" || e.tsAdj >= r.from) && (r.to === "" || e.tsAdj <= r.to); };
  // Fold a viewing's events locally and replace its entry in the page's data: the same function the server runs.
  function refold(sessionId) {
    const L = st.local.get(sessionId); if (!L) return;
    const f = P.fold(L.events), shift = (m) => { const o = Object.assign({}, m); for (const k of ["startedAt", "endedAt", "interruptedAt", "lastEventAt", "completedAt", "since"]) if (o[k] != null) o[k] += L.skew; return o; };
    const m = shift(f.metrics), dev = L.deviceId, label = (WL.devices().find(d => d.id === dev) || {}).label || "Device";
    let s = st.sessions.find(x => x.sessionId === sessionId);
    if (!s) { s = { deviceId: dev, deviceLabel: label, sessionId, hasEvents: true }; st.sessions.unshift(s); }
    Object.assign(s, { startedAt: m.startedAt, endedAt: m.endedAt != null ? m.endedAt : m.interruptedAt, lastEventAt: m.lastEventAt, state: m.status, completed: m.completed, skewMs: L.skew, metrics: m, segments: f.segments });
    // pause rows of this viewing
    const others = st.pauses.filter(p => p.sessionId !== sessionId);
    const mine = f.pauses.map(p => ({ deviceId: dev, deviceLabel: label, sessionId, sessionPause: p.n, pausedAt: p.pausedAt + L.skew, resumedAt: p.resumedAt != null ? p.resumedAt + L.skew : null, status: p.status, durationMs: p.durationMs,
      minDurationMs: p.minDurationMs || 0, pausedPos: p.pausedPos, resumedPos: p.resumedPos, pausedEventId: p.pausedEventId, resumedEventId: p.resumedEventId }));
    st.pauses = others.concat(mine).sort((a, b) => a.pausedAt - b.pausedAt).map((p, i) => Object.assign(p, { number: i + 1 }));
    st.pauseStats = P.pauseStats(st.pauses); st.pauseDist = P.pauseDistribution(st.pauses);
    // annotate the viewing's events on the timeline (the pause lasted ..., resumed after ...)
    for (const e of st.events) if (e.sessionId === sessionId && f.annotations[e.id]) e.related = f.annotations[e.id];
    st.sessEvents.delete(sessionId);
  }
  async function onVideoEvent(data) {
    const s = st; if (!s || data.videoId !== s.videoId || (s.F.device !== "all" && s.F.device !== data.deviceId)) return;
    const fresh = [];
    for (const raw of data.events) {
      if (s.ids.has(raw.id)) continue;
      const e = Object.assign({ deviceId: data.deviceId, deviceLabel: (WL.devices().find(d => d.id === data.deviceId) || {}).label || "Device", tsAdj: raw.ts + (data.skewMs || 0), related: null }, raw);
      fresh.push(e);
    }
    if (!fresh.length) { s.lastSync = serverNow(); renderConn(); return; }
    // make sure the viewing's earlier events are known before folding (a page opened mid-viewing, or events missed)
    for (const sid of new Set(fresh.map(e => e.sessionId))) {
      const first = Math.min(...fresh.filter(e => e.sessionId === sid).map(e => e.seq));
      let L = s.local.get(sid);
      if (!L) { L = { skew: data.skewMs || 0, events: [], deviceId: data.deviceId }; s.local.set(sid, L); if (first > 1) { try { await loadLocal(sid, data.skewMs); const got = s.local.get(sid); if (got) got.deviceId = data.deviceId; L = got || L; } catch (_e) { /* the soft refresh below repairs it */ } } }
      L.deviceId = data.deviceId; L.skew = data.skewMs || L.skew;
      const known = new Set(L.events.map(x => x.id));
      for (const e of fresh.filter(x => x.sessionId === sid)) if (!known.has(e.id)) L.events.push({ id: e.id, sessionId: e.sessionId, videoId: s.videoId, seq: e.seq, type: e.type, ts: e.ts, pos: e.pos, rate: e.rate, prev: e.prev, next: e.next, meta: e.meta });
    }
    if (!alive(s)) return;
    const shownNew = fresh.filter(matches);
    for (const e of shownNew) { s.ids.add(e.id); s.events.push(e); s.fresh.add(e.id); s.eventTotal++; }
    s.events = TL.normalize(s.events);
    for (const sid of new Set(fresh.map(e => e.sessionId))) refold(sid);
    s.lastSync = serverNow(); if (s.conn !== "live") setConn("live");
    renderAll();
    setTimeout(() => { s.fresh.clear(); }, 2500);
    scheduleRefresh(1500);
  }
  function scheduleRefresh(ms) { clearTimeout(st.refreshT); const s = st; s.refreshT = setTimeout(() => softRefresh(s), ms); }
  async function softRefresh(s) {
    if (!alive(s)) return;
    try { const ok = await fetchAll(); if (!ok || !alive(s)) return; renderAll(); if (s.conn === "syncing") setConn("live"); }
    catch (e) { if (e.message !== "unauthorized") { if (!navigator.onLine) setConn("offline"); } }
  }
  function onPresence(d) {
    if (!st || !st.detail) return; const dev = st.detail.devices.find(x => x.id === d.deviceId); if (!dev) return;
    if (d.online !== undefined) dev.online = !!d.online; else if (d.reason) dev.online = false; else dev.online = true;
    renderHeader(); updateStats(); renderSessions(); scheduleRefresh(800);
  }

  function connectSSE() {
    const s = st; if (!s || !window.EventSource) { if (s) { setConn("live"); s.poll = setInterval(() => softRefresh(s), 5000); } return; }
    if (s.es) s.es.close();
    const es = s.es = new EventSource("/api/events");
    es.onopen = () => {
      if (!alive(s)) return; s.attempt = 0;
      if (Date.now() - (s.loadedAt || 0) < 3000) { setConn("live"); return; }   // just loaded: nothing can have been missed
      setConn("syncing"); softRefresh(s).then(() => { if (alive(s) && s.es === es) setConn("live"); });    // after a drop, catch up on anything missed
    };
    es.addEventListener("video_event", ev => { try { onVideoEvent(JSON.parse(ev.data)); } catch (_e) { /* malformed */ } });
    for (const t of ["device_presence", "device_connected", "device_disconnected"]) es.addEventListener(t, ev => { try { onPresence(JSON.parse(ev.data)); } catch (_e) { /* malformed */ } });
    es.addEventListener("hello", ev => { try { const d = JSON.parse(ev.data); if (d.serverNow) s.offset = d.serverNow - Date.now(); } catch (_e) { /* ignore */ } });
    es.addEventListener("reconnect", () => { es.close(); if (alive(s)) setTimeout(connectSSE, 300); });
    es.onerror = () => {
      if (!alive(s)) return; es.close(); if (s.es === es) s.es = null;
      setConn(navigator.onLine ? "reconnecting" : "offline");
      const delay = Math.min(15000, 1000 * Math.pow(2, Math.min(s.attempt++, 4)));
      clearTimeout(s.retryT);
      s.retryT = setTimeout(async () => { if (!alive(s)) return; if (!navigator.onLine) return; if (await WL.refreshed().catch(() => false)) connectSSE(); else if (alive(s)) connectSSE(); }, delay);
    };
  }

  /* ================= wiring ================= */
  function bind() {
    const s = st;
    $("vdDev").onchange = () => { s.F.device = $("vdDev").value; reload(); };
    $("vdSort").onclick = () => { s.sortDesc = !s.sortDesc; renderTimeline(); };
    $("vdTlMore").onclick = () => { s.tlLimit += TL_STEP; renderTimeline(); };
    $("vdFToggle").onclick = () => { const b = $("vdFBody"); b.hidden = !b.hidden; $("vdFToggle").setAttribute("aria-expanded", String(!b.hidden)); };
    let t = null;
    $("vdFBody").addEventListener("input", () => {
      const f = s.F; f.fromDate = $("fFromD").value; f.timeFrom = $("fFromT").value; f.toDate = $("fToD").value; f.timeTo = $("fToT").value; f.session = $("fSess").value; f.completed = $("fComp").value;
      f.types = new Set([...document.querySelectorAll("#vdFBody .vd-types input:checked")].map(i => i.value));
      clearTimeout(t); t = setTimeout(reload, 300);
    });
    $("vdFBody").addEventListener("submit", e => e.preventDefault());
    $("fClear").onclick = () => { s.F = { device: s.F.device, session: "", fromDate: "", toDate: "", timeFrom: "", timeTo: "", types: new Set(), completed: "" }; for (const id of ["fFromD", "fFromT", "fToD", "fToT", "fComp"]) $(id).value = ""; document.querySelectorAll("#vdFBody .vd-types input").forEach(i => { i.checked = false; }); reload(); };
    $("vdExport").onclick = () => { const m = $("vdExportMenu"); m.hidden = !m.hidden; $("vdExport").setAttribute("aria-expanded", String(!m.hidden)); };
    $("vdExportMenu").onclick = WL.guarded(async e => {
      const b = e.target.closest("[data-ex]"); if (!b) return; $("vdExportMenu").hidden = true; $("vdExport").setAttribute("aria-expanded", "false");
      const [fmt, scope] = b.dataset.ex.split(":"), url = base() + "/export" + query({ format: fmt, scope: scope || "" });
      if (fmt === "print") { window.open(url + "&print=1", "_blank", "noopener"); return; }
      await WL.download(url, `video-${s.videoId}-${scope || "all"}.${fmt}`);
    });
    document.addEventListener("click", s.docClick = e => { if (!alive(s)) { document.removeEventListener("click", s.docClick); return; } if (!e.target.closest(".vd-menu")) { const m = $("vdExportMenu"); if (m && !m.hidden) { m.hidden = true; $("vdExport").setAttribute("aria-expanded", "false"); } } });
    $("vdTl").addEventListener("click", e => toggleEvent(e));
    $("vdSess").addEventListener("click", e => {
      const ev = e.target.closest(".vd-ev-btn"); if (ev) return toggleEvent(e);
      const h = e.target.closest(".vd-sess-h"); if (!h) return; const sid = h.closest(".vd-sess").dataset.sid;
      if (s.sessOpen.has(sid)) s.sessOpen.delete(sid); else s.sessOpen.add(sid); renderSessions();
    });
    s.onOnline = () => { if (!alive(s)) return; setConn("reconnecting"); connectSSE(); };
    s.onOffline = () => { if (alive(s)) setConn("offline"); };
    window.addEventListener("online", s.onOnline); window.addEventListener("offline", s.onOffline);
    s.onVis = () => { if (!document.hidden && alive(s)) { updateStats(); if (s.conn !== "live") connectSSE(); } };
    document.addEventListener("visibilitychange", s.onVis);
    s.tick = setInterval(() => { if (!alive(s)) { dispose(); return; } if (!document.hidden) updateStats(); }, 500);
    s.poll = setInterval(() => { if (alive(s) && s.conn === "live" && !document.hidden) softRefresh(s); }, 30000); // a safety net, not the live path
  }
  function toggleEvent(e) {
    const b = e.target.closest(".vd-ev-btn"); if (!b) return; const li = b.closest(".vd-ev"), id = li.dataset.id;
    if (st.open.has(id)) st.open.delete(id); else st.open.add(id);
    const ev = st.events.find(x => x.id === id) || [...st.sessEvents.values()].flat().find(x => x.id === id); if (!ev) return;
    const no = li.querySelector(".vd-ev-n").textContent.replace("#", ""), tmp = document.createElement("template"); tmp.innerHTML = tlItem(ev, no);
    li.replaceWith(tmp.content.firstElementChild); const nb = document.querySelector(`.vd-ev[data-id="${CSS.escape(id)}"] .vd-ev-btn`); if (nb) nb.focus();
  }
  async function reload() {
    const s = st; setConn("syncing");
    try { const ok = await fetchAll(); if (!ok || !alive(s)) return; s.tlLimit = TL_STEP; renderAll(); setConn(s.es ? "live" : "reconnecting"); }
    catch (e) { if (e.message !== "unauthorized") WL.toast(WL.errText(e)); }
  }

  async function render(app, videoId) {
    dispose();
    await WL.loadDevices();
    const s = st = { videoId, tz: P.DISPLAY_TZ, F: { device: "all", session: "", fromDate: "", toDate: "", timeFrom: "", timeTo: "", types: new Set(), completed: "" }, offset: 0, conn: "syncing", lastSync: null,
      open: new Set(), sessOpen: new Set(), fresh: new Set(), sessEvents: new Map(), local: new Map(), sortDesc: true, tlLimit: TL_STEP, attempt: 0, progressSid: null, events: [], eventTotal: 0, ids: new Set(), sessions: [], pauses: [] };
    // identity first (404 for an unknown video), so the page frame can show the title straight away
    let first;
    try { first = await WL.api("GET", "/api/video/" + encodeURIComponent(videoId)); }
    catch (e) { if (e.status === 404) { app.innerHTML = `<section class="vd-glass">${WL.empty("film", "No such video", "This video has no recorded viewing on your devices.", `<a class="btn btn-accent" href="#/videos">${ic("arrow-left")}All videos</a>`)}</section>`; st = null; return; } throw e; }
    if (st !== s) return;
    app.innerHTML = frame(first.video);
    s.detail = first; s.offset = first.serverNow - Date.now();
    bind();
    await fetchAll();
    if (!alive(s)) return;
    renderAll(); setConn("syncing"); connectSSE();
  }

  /* ================= the Videos list ================= */
  const vf = { q: "", channel: "", completed: "", device: "all", from: "", to: "", offset: 0 };
  const PAGE = 40;
  async function renderList(app) {
    dispose();
    await WL.loadDevices();
    app.innerHTML = WL.head("Videos", "Every video your devices have played. Open one for its full timeline, every pause and resume, and live status.") + `
      <form class="card filters" id="vlForm" autocomplete="off"><label class="field">Title, channel or ID<input class="input" id="vlQ" value="${esc(vf.q)}" placeholder="e.g. lofi" /></label>
        <label class="field">Channel<input class="input" id="vlCh" value="${esc(vf.channel)}" placeholder="channel name" /></label>
        <label class="field">Completion<select class="input" id="vlComp"><option value="">Any</option><option value="yes"${vf.completed === "yes" ? " selected" : ""}>Completed</option><option value="no"${vf.completed === "no" ? " selected" : ""}>Not completed</option></select></label>
        <label class="field">Device<select class="input" id="vlDev"><option value="all">All devices</option>${WL.devices().map(d => `<option value="${esc(d.id)}"${d.id === vf.device ? " selected" : ""}>${esc(d.label || "Device")}</option>`).join("")}</select></label>
        <label class="field">From<input class="input" type="date" id="vlFrom" value="${esc(vf.from)}" /></label><label class="field">To<input class="input" type="date" id="vlTo" value="${esc(vf.to)}" /></label>
        <button class="btn" type="button" id="vlClear">${ic("x")}Clear filters</button></form>
      <section class="card flush"><div id="vlRes"><span class="skel h-block"></span></div></section>`;
    const day = (v, end) => (v ? new Date(v + (end ? "T23:59:59.999" : "T00:00:00")).getTime() : "");
    const load = WL.guarded(async () => {
      const r = await WL.api("GET", "/api/videos" + qs({ q: vf.q, channel: vf.channel, completed: vf.completed, device: vf.device, from: day(vf.from), to: day(vf.to, true), limit: PAGE, offset: vf.offset }));
      const box = $("vlRes"); if (!box) return;
      if (!r.items.length) { box.innerHTML = WL.empty("film", "No videos", vf.q || vf.channel || vf.completed || vf.from || vf.to || vf.device !== "all" ? "Nothing matches these filters." : "Videos appear here after a paired device plays one."); return; }
      box.innerHTML = `<p class="caption result-meta">${r.total} video${r.total === 1 ? "" : "s"}</p><table class="table rtable"><thead><tr><th>Video</th><th>Last watched</th><th class="right">Sessions</th><th class="right">Watched</th><th>Status</th></tr></thead><tbody>${r.items.map(v => `<tr class="click" tabindex="0" data-v="${esc(v.videoId)}">
        <td data-primary><div class="vl-cell"><img class="vl-thumb" src="${esc(v.thumbnail || "https://i.ytimg.com/vi/" + v.videoId + "/mqdefault.jpg")}" alt="" width="96" height="54" loading="lazy" referrerpolicy="no-referrer" /><div><div class="cell-primary clip">${esc(v.title || v.videoId)}</div><div class="cell-sub">${esc(v.channel)}</div></div></div></td>
        <td class="num" data-label="Last watched">${esc(U.fmtDateTime(v.lastWatched))}</td><td class="num right" data-label="Sessions">${v.sessionCount}</td><td class="num right" data-label="Watched">${esc(U.fmtDuration(v.totalMs))}</td>
        <td data-label="Status">${v.completions ? '<span class="pill on"><span class="dot"></span><span>Completed</span></span> ' : ""}${v.hasEvents ? '<span class="pill"><span class="dot"></span><span>Event history</span></span>' : '<span class="muted small">summary only</span>'}</td></tr>`).join("")}</tbody></table>
        <div class="pager"><button class="btn" id="vlPrev" type="button" ${vf.offset === 0 ? "disabled" : ""}>${ic("chevron-left")}Previous</button><span class="caption num">${vf.offset + 1} to ${vf.offset + r.items.length} of ${r.total}</span><button class="btn" id="vlNext" type="button" ${vf.offset + PAGE >= r.total ? "disabled" : ""}>Next${ic("chevron-right")}</button></div>`;
      const go = tr => { location.hash = "#/video/" + tr.dataset.v; };
      box.querySelectorAll("tr.click").forEach(tr => { tr.onclick = () => go(tr); tr.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(tr); } }; });
      $("vlPrev").onclick = () => { vf.offset = Math.max(0, vf.offset - PAGE); load(); }; $("vlNext").onclick = () => { vf.offset += PAGE; load(); };
    });
    let t = null;
    $("vlForm").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { Object.assign(vf, { q: $("vlQ").value.trim(), channel: $("vlCh").value.trim(), completed: $("vlComp").value, device: $("vlDev").value, from: $("vlFrom").value, to: $("vlTo").value, offset: 0 }); load(); }, 250); });
    $("vlForm").addEventListener("submit", e => e.preventDefault());
    $("vlClear").onclick = () => { Object.assign(vf, { q: "", channel: "", completed: "", device: "all", from: "", to: "", offset: 0 }); renderList(app); };
    load();
  }

  window.WLVideo = { render, renderList, dispose };
})();
