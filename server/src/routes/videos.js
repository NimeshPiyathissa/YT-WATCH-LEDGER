import { decryptJSON } from "../lib/crypto.js";
import pb from "../lib/playback.cjs";
import { eventRow } from "../lib/videoEvents.js";
import { audit } from "../lib/helpers.js";

// Video Details: owner-only reads over the event history. Every query is scoped to the owner's own devices
// (devices.admin_id), so another account's history is unreachable by construction; an unknown video or a device that is not the
// caller's answers 404 and never reveals whether it exists for someone else. Timestamps leave this module on the server's
// clock (device time + the skew measured at upload); durations were computed from the device's own clock.
const VID = /^[\w-]{1,32}$/, SID = /^[\w-]{1,64}$/;
const MAX_EVENTS_PAGE = 2000, MAX_EXPORT_EVENTS = 20000, MAX_LIST_ROWS = 20000;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Titles and channel names come from the web: a leading = + - @ is neutralised so a spreadsheet never runs one as a formula.
const cell = v => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const num = v => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const TIME_KEYS = ["startedAt", "endedAt", "interruptedAt", "lastEventAt", "completedAt", "since"];
const shift = (m, skew) => { const o = { ...m }; for (const k of TIME_KEYS) if (o[k] != null) o[k] = o[k] + skew; return o; };
const placeholders = ids => ids.map(() => "?").join(",");

export default async function (app, { db }) {
  app.addHook("preHandler", app.authAdmin);

  function filters(q = {}) {
    const types = String(q.type || "").split(",").map(s => s.trim()).filter(t => pb.TYPES.includes(t));
    return {
      device: q.device && q.device !== "all" ? String(q.device).slice(0, 64) : null,
      session: q.session && SID.test(String(q.session)) ? String(q.session) : null,
      from: num(q.from), to: num(q.to), types,
      completed: q.completed === "yes" ? 1 : q.completed === "no" ? 0 : null,
      state: ["open", "ended", "interrupted"].includes(q.state) ? q.state : null,
      tz: pb.DISPLAY_TZ, // always Sri Lanka time: a zone named by the caller is ignored, so every page and file agrees
      limit: Math.min(Math.max(Math.floor(num(q.limit)) || 200, 1), MAX_EVENTS_PAGE), offset: Math.max(Math.floor(num(q.offset)) || 0, 0),
      order: q.order === "desc" ? "DESC" : "ASC"
    };
  }

  // Resolves the owner's devices and the ones in scope; replies 404 itself when there is nothing to show.
  function scope(req, reply) {
    const videoId = req.params.videoId;
    if (!VID.test(videoId)) { reply.code(404).send({ error: "not_found" }); return null; }
    const devices = db.prepare("SELECT id,label,status,platform,last_seen,last_events_at,clock_skew_ms,client_version FROM devices WHERE admin_id=? ORDER BY enrolled_at").all(req.admin.id);
    const f = filters(req.query);
    let ids = devices.map(d => d.id);
    if (f.device) { if (!ids.includes(f.device)) { reply.code(404).send({ error: "not_found" }); return null; } ids = [f.device]; }
    const ph = placeholders(ids);
    const known = ids.length && (db.prepare(`SELECT 1 FROM videos WHERE video_id=? AND device_id IN (${ph}) LIMIT 1`).get(videoId, ...ids)
      || db.prepare(`SELECT 1 FROM video_sessions WHERE video_id=? AND device_id IN (${ph}) LIMIT 1`).get(videoId, ...ids)
      || db.prepare(`SELECT 1 FROM sessions WHERE video_id=? AND device_id IN (${ph}) LIMIT 1`).get(videoId, ...ids));
    if (!known) { reply.code(404).send({ error: "not_found" }); return null; }
    return { videoId, devices, ids, ph, f, label: Object.fromEntries(devices.map(d => [d.id, d.label || "Device"])) };
  }

  // Event-backed sessions (folded metrics) for the video, filtered; timestamps moved onto the server clock.
  function loadSessions(sc) {
    const { f, ids, ph, videoId } = sc;
    const where = [`device_id IN (${ph})`, "video_id=?"], args = [...ids, videoId];
    if (f.session) { where.push("session_id=?"); args.push(f.session); }
    if (f.from != null) { where.push("started_at>=?"); args.push(f.from); }
    if (f.to != null) { where.push("started_at<=?"); args.push(f.to); }
    if (f.completed != null) { where.push("completed=?"); args.push(f.completed); }
    if (f.state) { where.push("state=?"); args.push(f.state); }
    const rows = db.prepare(`SELECT * FROM video_sessions WHERE ${where.join(" AND ")} ORDER BY started_at DESC`).all(...args);
    const seg = db.prepare("SELECT enc FROM video_watch_segments WHERE device_id=? AND session_id=?");
    return rows.map(r => {
      const m = shift(decryptJSON(r.enc), r.skew_ms), s = seg.get(r.device_id, r.session_id), extra = s ? decryptJSON(s.enc) : { segments: [], runs: [] };
      return { deviceId: r.device_id, deviceLabel: sc.label[r.device_id], sessionId: r.session_id, startedAt: r.started_at, endedAt: r.ended_at, lastEventAt: r.last_event_at,
        state: r.state, completed: !!r.completed, skewMs: r.skew_ms, hasEvents: true, metrics: m, segments: extra.segments || [], runs: (extra.runs || []).map(x => ({ ...x, ts: x.ts + r.skew_ms })) };
    });
  }

  // Sessions recorded before 0.7 (or with detail collection off): the watch-time snapshot is all there is. Never given a timeline.
  function loadSummaryOnly(sc, withEvents) {
    const { f, ids, ph, videoId } = sc;
    if (f.types.length || f.state) return [];
    const where = [`device_id IN (${ph})`, "video_id=?"], args = [...ids, videoId];
    if (f.session) { where.push("session_id=?"); args.push(f.session); }
    if (f.from != null) { where.push("start_ts_adj>=?"); args.push(f.from); }
    if (f.to != null) { where.push("start_ts_adj<=?"); args.push(f.to); }
    const out = [];
    for (const r of db.prepare(`SELECT device_id,session_id,enc FROM sessions WHERE ${where.join(" AND ")} ORDER BY start_ts_adj DESC`).all(...args)) {
      if (withEvents.has(r.device_id + "\u0000" + r.session_id)) continue;
      const s = decryptJSON(r.enc), done = !!s.completed;
      if (f.completed != null && f.completed !== (done ? 1 : 0)) continue;
      out.push({ deviceId: r.device_id, deviceLabel: sc.label[r.device_id], sessionId: r.session_id, startedAt: s.startTsAdj ?? s.startTs, endedAt: s.endTsAdj ?? s.endTs ?? null,
        lastEventAt: s.endTsAdj ?? s.endTs ?? s.startTsAdj ?? s.startTs, state: s.endTs ? "ended" : "open", completed: done, hasEvents: false,
        summary: { watchedMs: s.watchedMs || 0, duration: s.duration || 0, positionSec: s.positionSec || 0, furthestSec: s.furthestSec || 0, seeks: s.seeks || 0, pauses: s.pauses || 0 } });
    }
    return out;
  }
  const allSessions = sc => {
    const ev = loadSessions(sc);
    const seen = new Set(ev.map(s => s.deviceId + "\u0000" + s.sessionId));
    // a session that has events but is excluded by a filter must not reappear as "summary only"
    for (const r of db.prepare(`SELECT device_id,session_id FROM video_sessions WHERE video_id=? AND device_id IN (${sc.ph})`).all(sc.videoId, ...sc.ids)) seen.add(r.device_id + "\u0000" + r.session_id);
    return { events: ev, summaryOnly: loadSummaryOnly(sc, seen) };
  };

  // Current state of the video on each device: what the page shows as LIVE WATCHING / PAUSED / COMPLETED / DEVICE OFFLINE.
  function liveOf(sc) {
    const now = Date.now(), per = [];
    for (const d of sc.devices.filter(x => sc.ids.includes(x.id))) {
      const online = app.hub.isOnline(d.id);
      const r = db.prepare("SELECT * FROM video_sessions WHERE device_id=? AND video_id=? ORDER BY last_event_at DESC LIMIT 1").get(d.id, sc.videoId);
      if (!r) { per.push({ deviceId: d.id, label: d.label || "Device", online, lastSeen: d.last_seen, session: null }); continue; }
      const m = shift(decryptJSON(r.enc), r.skew_ms);
      per.push({ deviceId: d.id, label: d.label || "Device", online, lastSeen: d.last_seen, lastEventsAt: d.last_events_at,
        session: { sessionId: r.session_id, status: m.status, state: m.state, since: m.since, pos: m.lastPos, rate: m.rate, lastEventAt: m.lastEventAt,
          activeMs: m.activeMs, pausedMs: m.pausedMs, elapsedMs: m.elapsedMs, completed: m.completed, startedAt: m.startedAt, endedAt: m.endedAt, interruptedAt: m.interruptedAt } });
    }
    const open = per.filter(p => p.session && p.session.status === "open").sort((a, b) => b.session.lastEventAt - a.session.lastEventAt)[0];
    let status = "idle", on = per.slice().sort((a, b) => (b.session ? b.session.lastEventAt : 0) - (a.session ? a.session.lastEventAt : 0))[0] || null;
    if (open) {
      on = open;
      status = !open.online ? "offline" : open.session.state === "playing" ? "playing" : open.session.state === "paused" ? "paused" : open.session.state === "buffering" ? "buffering" : open.session.state === "ad" ? "ad" : open.session.state === "ended" ? "completed" : "idle";
    } else if (on && on.session && on.session.completed) status = "completed";
    return { status, current: on, devices: per, serverNow: now };
  }

  /* ---- the list of videos the owner can open ---- */
  app.get("/api/videos", req => {
    const q = req.query || {}, text = String(q.q || "").trim().toLowerCase().slice(0, 200), channel = String(q.channel || "").trim().toLowerCase().slice(0, 200);
    const f = filters(q);
    const rows = db.prepare(`SELECT v.device_id AS device_id, v.video_id AS video_id, v.enc AS enc FROM videos v JOIN devices d ON d.id=v.device_id
      WHERE d.admin_id=@a AND (@dev IS NULL OR v.device_id=@dev) AND (@from IS NULL OR v.last_watched>=@from) AND (@to IS NULL OR v.last_watched<=@to)
      ORDER BY v.last_watched DESC LIMIT ${MAX_LIST_ROWS}`).all({ a: req.admin.id, dev: f.device, from: f.from, to: f.to });
    const withEvents = new Set(db.prepare(`SELECT a.device_id||'|'||a.video_id k FROM video_analytics a JOIN devices d ON d.id=a.device_id WHERE d.admin_id=?`).all(req.admin.id).map(r => r.k));
    const labels = Object.fromEntries(db.prepare("SELECT id,label FROM devices WHERE admin_id=?").all(req.admin.id).map(d => [d.id, d.label || "Device"]));
    const byVideo = new Map();
    for (const r of rows) {
      const v = decryptJSON(r.enc);
      let o = byVideo.get(r.video_id);
      if (!o) byVideo.set(r.video_id, o = { videoId: r.video_id, title: "", channel: "", channelUrl: "", url: "", thumbnail: v.thumbnail || "", duration: 0, totalMs: 0, sessionCount: 0, completions: 0, lastWatched: 0, firstWatched: 0, devices: [], hasEvents: false });
      if (v.title && (v.lastWatched || 0) >= o.lastWatched) { o.title = v.title; o.channel = v.channel || o.channel; o.channelUrl = v.channelUrl || o.channelUrl; o.url = v.url || o.url; }
      o.duration = Math.max(o.duration, v.duration || 0); o.totalMs += v.totalMs || 0; o.sessionCount += v.sessionCount || 0; o.completions += v.completions || 0;
      o.lastWatched = Math.max(o.lastWatched, v.lastWatched || 0); o.firstWatched = o.firstWatched ? Math.min(o.firstWatched, v.firstWatched || o.firstWatched) : (v.firstWatched || 0);
      o.devices.push({ id: r.device_id, label: labels[r.device_id] }); if (withEvents.has(r.device_id + "|" + r.video_id)) o.hasEvents = true;
    }
    let items = [...byVideo.values()];
    if (text) items = items.filter(i => i.title.toLowerCase().includes(text) || i.channel.toLowerCase().includes(text) || i.videoId.toLowerCase().includes(text));
    if (channel) items = items.filter(i => i.channel.toLowerCase().includes(channel));
    if (f.completed != null) items = items.filter(i => (i.completions > 0 ? 1 : 0) === f.completed);
    items.sort((a, b) => b.lastWatched - a.lastWatched);
    return { total: items.length, items: items.slice(f.offset, f.offset + Math.min(f.limit, 200)), serverNow: Date.now() };
  });

  /* ---- one video ---- */
  app.get("/api/video/:videoId", (req, reply) => {
    const sc = scope(req, reply); if (!sc) return;
    const { events, summaryOnly } = allSessions(sc);
    // identity of the video: the freshest title/channel any of the owner's devices reported
    const vids = db.prepare(`SELECT device_id,enc,last_watched FROM videos WHERE video_id=? AND device_id IN (${sc.ph}) ORDER BY last_watched`).all(sc.videoId, ...sc.ids).map(r => ({ deviceId: r.device_id, ...decryptJSON(r.enc) }));
    const video = { videoId: sc.videoId, url: "", title: "", channel: "", channelUrl: "", channelId: "", thumbnail: "https://i.ytimg.com/vi/" + sc.videoId + "/mqdefault.jpg", duration: 0, kind: "watch" };
    for (const v of vids) {
      if (v.title) video.title = v.title; if (v.channel) video.channel = v.channel; if (v.channelUrl) { video.channelUrl = v.channelUrl; video.channelId = v.channelId || ""; }
      if (v.url) video.url = v.url; video.duration = Math.max(video.duration, v.duration || 0);
    }
    video.url = video.url || "https://www.youtube.com/watch?v=" + sc.videoId;
    video.kind = video.url.includes("/shorts/") ? "shorts" : "watch";
    const sum = pb.rollup(events, video.duration);
    const legacyMs = summaryOnly.reduce((n, s) => n + s.summary.watchedMs, 0);
    const latest = [...events, ...summaryOnly].sort((a, b) => b.lastEventAt - a.lastEventAt)[0] || null;
    const position = latest ? (latest.hasEvents ? latest.metrics.lastPos : latest.summary.positionSec) : 0;
    const dur = Math.max(video.duration, sum.duration);
    const first = [...events, ...summaryOnly].reduce((m, s) => Math.min(m, s.startedAt || m), Infinity);
    const last = [...events, ...summaryOnly].reduce((m, s) => Math.max(m, s.lastEventAt || 0), 0);
    return {
      video: { ...video, duration: dur },
      totals: {
        sessions: events.length + summaryOnly.length, eventSessions: events.length, summaryOnlySessions: summaryOnly.length,
        activeMs: sum.activeMs + legacyMs, activeMsFromEvents: sum.activeMs, activeMsSummaryOnly: legacyMs,
        pausedMs: sum.pausedMs, unresolvedPausedMs: sum.unresolvedPausedMs, bufferingMs: sum.bufferingMs, adMs: sum.adMs, elapsedMs: sum.elapsedMs,
        pauseCount: sum.pauseCount, resumeCount: sum.resumeCount, seekCount: sum.seekCount, completedSessions: sum.completedSessions + summaryOnly.filter(s => s.completed).length,
        completedAt: sum.completedAt, firstWatched: Number.isFinite(first) ? first : null, lastActivity: last || null,
        position, positionPct: dur > 0 ? Math.min(100, Math.round(position / dur * 100)) : null, furthestSec: sum.furthestSec, progressPct: dur > 0 ? Math.min(100, Math.round(sum.furthestSec / dur * 100)) : null,
        uniqueContentSec: sum.uniqueContentSec, uniqueContentPct: sum.uniqueContentPct, rewatchSec: sum.rewatchSec, rewatchMs: sum.rewatchMs, uncertain: sum.uncertain
      },
      devices: sc.devices.filter(d => sc.ids.includes(d.id)).map(d => ({ id: d.id, label: d.label || "Device", platform: d.platform, status: d.status, online: app.hub.isOnline(d.id), lastSeen: d.last_seen, lastEventsAt: d.last_events_at, clientVersion: d.client_version })),
      live: liveOf(sc), serverNow: Date.now()
    };
  });

  app.get("/api/video/:videoId/live", (req, reply) => { const sc = scope(req, reply); if (sc) return liveOf(sc); });

  app.get("/api/video/:videoId/sessions", (req, reply) => {
    const sc = scope(req, reply); if (!sc) return;
    const { events, summaryOnly } = allSessions(sc);
    const items = [...events.map(({ runs, ...s }) => s), ...summaryOnly].sort((a, b) => b.startedAt - a.startedAt);
    return { total: items.length, items, serverNow: Date.now() };
  });

  // Events, oldest first by default, with the duration each one relates to. Annotations come from folding the whole session,
  // so "Resumed after 2 minutes 30 seconds" is right even when the page of results starts mid-session.
  function queryEvents(sc, { limit, offset, order }) {
    const { f, ids, ph, videoId } = sc;
    const where = [`e.device_id IN (${ph})`, "e.video_id=?"], args = [...ids, videoId];
    if (f.session) { where.push("e.session_id=?"); args.push(f.session); }
    if (f.types.length) { where.push(`e.type IN (${placeholders(f.types)})`); args.push(...f.types); }
    if (f.from != null) { where.push("e.ts_adj>=?"); args.push(f.from); }
    if (f.to != null) { where.push("e.ts_adj<=?"); args.push(f.to); }
    if (f.completed != null) { where.push("EXISTS (SELECT 1 FROM video_sessions s WHERE s.device_id=e.device_id AND s.session_id=e.session_id AND s.completed=?)"); args.push(f.completed); }
    const total = db.prepare(`SELECT COUNT(*) n FROM video_playback_events e WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = db.prepare(`SELECT e.* FROM video_playback_events e WHERE ${where.join(" AND ")} ORDER BY e.ts_adj ${order}, e.seq ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const annCache = new Map();
    const annotations = (deviceId, sessionId) => {
      const k = deviceId + "\u0000" + sessionId;
      if (!annCache.has(k)) {
        const all = db.prepare("SELECT * FROM video_playback_events WHERE device_id=? AND session_id=? ORDER BY seq").all(deviceId, sessionId).map(eventRow);
        annCache.set(k, pb.fold(all).annotations);
      }
      return annCache.get(k);
    };
    return { total, items: rows.map(r => { const e = eventRow(r); return { id: e.id, deviceId: r.device_id, deviceLabel: sc.label[r.device_id], sessionId: e.sessionId, seq: e.seq, type: e.type, ts: e.ts, tsAdj: e.tsAdj,
      pos: e.pos, rate: e.rate, prev: e.prev, next: e.next, meta: e.meta, related: annotations(r.device_id, e.sessionId)[e.id] || null }; }) };
  }
  app.get("/api/video/:videoId/events", (req, reply) => {
    const sc = scope(req, reply); if (!sc) return;
    const r = queryEvents(sc, { limit: sc.f.limit, offset: sc.f.offset, order: sc.f.order });
    return { ...r, limit: sc.f.limit, offset: sc.f.offset, serverNow: Date.now() };
  });

  function queryPauses(sc) {
    const { f, ids, ph, videoId } = sc;
    const where = [`p.device_id IN (${ph})`, "p.video_id=?"], args = [...ids, videoId];
    if (f.session) { where.push("p.session_id=?"); args.push(f.session); }
    if (f.from != null) { where.push("p.paused_at>=?"); args.push(f.from); }
    if (f.to != null) { where.push("p.paused_at<=?"); args.push(f.to); }
    if (f.completed != null) { where.push("EXISTS (SELECT 1 FROM video_sessions s WHERE s.device_id=p.device_id AND s.session_id=p.session_id AND s.completed=?)"); args.push(f.completed); }
    const rows = db.prepare(`SELECT p.* FROM video_pause_intervals p WHERE ${where.join(" AND ")} ORDER BY p.paused_at, p.n`).all(...args);
    return rows.map((r, i) => { const x = decryptJSON(r.enc); return { number: i + 1, deviceId: r.device_id, deviceLabel: sc.label[r.device_id], sessionId: r.session_id, sessionPause: r.n,
      pausedAt: r.paused_at, resumedAt: r.resumed_at, status: r.status, durationMs: r.duration_ms, minDurationMs: x.minDurationMs || 0, pausedPos: x.pausedPos, resumedPos: x.resumedPos,
      pausedEventId: x.pausedEventId || null, resumedEventId: x.resumedEventId || null }; });
  }
  app.get("/api/video/:videoId/pauses", (req, reply) => {
    const sc = scope(req, reply); if (!sc) return;
    const items = queryPauses(sc);
    return { items, stats: pb.pauseStats(items), distribution: pb.pauseDistribution(items), serverNow: Date.now() };
  });

  app.get("/api/video/:videoId/analytics", (req, reply) => {
    const sc = scope(req, reply); if (!sc) return;
    const { events } = allSessions(sc);
    const pauses = queryPauses(sc), summary = pb.rollup(events.map(s => ({ metrics: s.metrics, segments: s.segments, pauses: [] })));
    let coverage = []; for (const s of events) coverage = coverage.concat(s.segments);
    coverage.sort((a, b) => a.from - b.from);
    const merged = []; for (const c of coverage) { const l = merged[merged.length - 1]; if (l && c.from <= l.to + 0.001) l.to = Math.max(l.to, c.to); else merged.push({ ...c }); }
    return {
      summary,
      breakdown: { activeMs: summary.activeMs, pausedMs: summary.pausedMs, unresolvedPausedMs: summary.unresolvedPausedMs, bufferingMs: summary.bufferingMs, adMs: summary.adMs },
      sessions: events.slice().sort((a, b) => a.startedAt - b.startedAt).map(s => ({ sessionId: s.sessionId, deviceLabel: s.deviceLabel, startedAt: s.startedAt, state: s.state, completed: s.completed,
        activeMs: s.metrics.activeMs, pausedMs: s.metrics.pausedMs, unresolvedPausedMs: s.metrics.unresolvedPausedMs, bufferingMs: s.metrics.bufferingMs, elapsedMs: s.metrics.elapsedMs,
        uniqueContentSec: s.metrics.uniqueContentSec, pauseCount: s.metrics.pauseCount, seekCount: s.metrics.seekCount })),
      runs: events.flatMap(s => s.runs.map(r => ({ sessionId: s.sessionId, ts: r.ts, ms: r.ms, from: r.from, to: r.to, rate: r.rate }))).sort((a, b) => a.ts - b.ts).slice(-3000),
      coverage: merged, pauseStats: pb.pauseStats(pauses), pauseDistribution: pb.pauseDistribution(pauses), pauses: pauses.map(p => ({ pausedAt: p.pausedAt, durationMs: p.durationMs, status: p.status, pausedPos: p.pausedPos })),
      duration: summary.duration, serverNow: Date.now()
    };
  });

  /* ---- export: CSV / JSON / a print-ready report (Save as PDF in the browser) ---- */
  const relatedText = r => {
    if (!r) return "";
    if (r.kind === "seek") return r.fromSec != null ? `jumped from ${Math.round(r.fromSec)} s to ${Math.round(r.toSec)} s` : "";
    if (r.unresolved) return `unresolved (at least ${pb.formatDuration(r.minMs)})`;
    if (r.open) return "still paused";
    if (r.uncertain) return `session interrupted (at least ${pb.formatDuration(r.minMs)} elapsed)`;
    return r.ms != null ? pb.formatDuration(r.ms) : "";
  };
  app.get("/api/video/:videoId/export", (req, reply) => {
    const sc = scope(req, reply); if (!sc) return;
    const fmt = ["csv", "json", "print"].includes(req.query?.format) ? req.query.format : "json", scopeName = ["events", "pauses", "sessions"].includes(req.query?.scope) ? req.query.scope : "events";
    const tz = sc.f.tz, stamp = pb.dayKey(Date.now(), tz);
    const ev = queryEvents(sc, { limit: MAX_EXPORT_EVENTS, offset: 0, order: "ASC" });
    const pauses = queryPauses(sc), { events: es, summaryOnly } = allSessions(sc);
    const vid = db.prepare(`SELECT enc FROM videos WHERE video_id=? AND device_id IN (${sc.ph}) ORDER BY last_watched DESC LIMIT 1`).get(sc.videoId, ...sc.ids);
    const meta = vid ? decryptJSON(vid.enc) : {};
    const info = { videoId: sc.videoId, title: meta.title || "", channel: meta.channel || "", channelUrl: meta.channelUrl || "", url: meta.url || "https://www.youtube.com/watch?v=" + sc.videoId, duration: meta.duration || 0 };
    audit(db, req.admin.id, sc.f.device, "export_video", req.ip, { videoId: sc.videoId, format: fmt, scope: scopeName, events: ev.items.length });
    const t = ms => (ms == null ? "" : pb.formatTime(ms, tz, true)), d = ms => (ms == null ? "" : pb.formatDate(ms, tz)), S = ms => (ms == null ? "" : pb.formatStamp(ms, tz, true));
    const iso = ms => (ms == null ? "" : new Date(ms).toISOString());

    if (fmt === "json") {
      return reply.header("Content-Disposition", `attachment; filename="video-${sc.videoId}-${stamp}.json"`).send({
        exportedAt: new Date().toISOString(), timezone: tz, timezoneLabel: "SLST (UTC+05:30)", note: "Timestamps are UTC milliseconds on the server's clock; show them in Asia/Colombo (SLST, UTC+05:30). Durations come from the device's own clock and never depend on the display zone.",
        video: info, filters: { device: sc.f.device, session: sc.f.session, from: sc.f.from, to: sc.f.to, types: sc.f.types, completed: sc.f.completed },
        sessions: [...es.map(({ segments, runs, ...s }) => s), ...summaryOnly], pauses, events: ev.items, truncated: ev.total > ev.items.length
      });
    }
    if (fmt === "csv") {
      let head, lines;
      if (scopeName === "pauses") {
        head = ["pause_number", "device", "session_id", "paused_at_utc", "paused_at_local", "resumed_at_utc", "resumed_at_local", "timezone", "status", "duration_seconds", "at_least_seconds", "paused_position_seconds", "resumed_position_seconds"];
        lines = pauses.map(p => [p.number, p.deviceLabel, p.sessionId, iso(p.pausedAt), S(p.pausedAt), iso(p.resumedAt), p.resumedAt ? S(p.resumedAt) : "", tz, p.status,
          p.durationMs != null ? Math.round(p.durationMs / 1000) : "", p.status === "unresolved" ? Math.round(p.minDurationMs / 1000) : "", p.pausedPos ?? "", p.resumedPos ?? ""]);
      } else if (scopeName === "sessions") {
        head = ["device", "session_id", "started_utc", "ended_utc", "state", "has_event_history", "active_seconds", "paused_seconds", "buffering_seconds", "elapsed_seconds", "pauses", "resumes", "seeks", "completed", "unique_content_seconds"];
        lines = [...es, ...summaryOnly].sort((a, b) => a.startedAt - b.startedAt).map(s => s.hasEvents ? [s.deviceLabel, s.sessionId, iso(s.startedAt), iso(s.endedAt), s.state, "yes", Math.round(s.metrics.activeMs / 1000),
          Math.round(s.metrics.pausedMs / 1000), Math.round(s.metrics.bufferingMs / 1000), Math.round(s.metrics.elapsedMs / 1000), s.metrics.pauseCount, s.metrics.resumeCount, s.metrics.seekCount, s.completed, s.metrics.uniqueContentSec]
          : [s.deviceLabel, s.sessionId, iso(s.startedAt), iso(s.endedAt), s.state, "no (summary only)", Math.round(s.summary.watchedMs / 1000), "", "", "", s.summary.pauses, "", s.summary.seeks, s.completed, ""]);
      } else {
        head = ["event_number", "timestamp_utc", "timestamp_slst", "date_local", "time_local", "timezone", "event_type", "device", "session_id", "video_id", "video_title", "position_seconds", "playback_speed", "previous_state", "new_state", "related_duration_seconds", "related_note", "reason"];
        lines = ev.items.map((e, i) => [i + 1, iso(e.tsAdj), S(e.tsAdj), d(e.tsAdj), t(e.tsAdj), tz, e.type, e.deviceLabel, e.sessionId, sc.videoId, info.title, e.pos, e.rate, e.prev, e.next,
          e.related && e.related.ms != null ? Math.round(e.related.ms / 1000) : "", relatedText(e.related), e.meta.reason || ""]);
      }
      return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="video-${sc.videoId}-${scopeName}-${stamp}.csv"`)
        .send("﻿" + [head.join(",")].concat(lines.map(l => l.map(cell).join(","))).join("\r\n") + "\r\n");
    }

    // print-ready report: plain HTML and an external stylesheet (the page's CSP forbids inline styles and scripts)
    const row = cells => "<tr>" + cells.map(c => `<td>${esc(c)}</td>`).join("") + "</tr>";
    const sumRoll = pb.rollup(es, info.duration), ps = pb.pauseStats(pauses);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Video report — ${esc(info.title || sc.videoId)}</title>
<link rel="stylesheet" href="/print.css"></head><body>
<header><button id="printBtn" type="button" class="noprint">Save as PDF / Print</button><h1>${esc(info.title || sc.videoId)}</h1>
<p>${esc(info.channel)} · ${esc(info.url)} · ${esc(sc.videoId)}${info.duration ? " · " + esc(pb.formatDuration(info.duration * 1000)) : ""}</p>
<p class="muted">Generated ${esc(S(Date.now()))}. All times are Sri Lanka Standard Time (Asia/Colombo, UTC+05:30); they are stored in UTC.</p></header>
<h2>Summary</h2><table class="kv">${[["Watch sessions", es.length + summaryOnly.length], ["Active watch time", pb.formatDuration(sumRoll.activeMs)], ["Total paused time", pb.formatDuration(sumRoll.pausedMs)],
      ["Pauses / resumes", sumRoll.pauseCount + " / " + sumRoll.resumeCount], ["Buffering time", pb.formatDuration(sumRoll.bufferingMs)], ["Unique content watched", sumRoll.uniqueContentSec + " s" + (sumRoll.uniqueContentPct != null ? " (" + sumRoll.uniqueContentPct + "%)" : "")],
      ["Furthest position", sumRoll.furthestSec + " s" + (sumRoll.progressPct != null ? " (" + sumRoll.progressPct + "%)" : "")], ["Sessions without event history", summaryOnly.length]].map(r => row(r)).join("")}</table>
<h2>Pauses (${ps.count})</h2><p class="muted">Average ${esc(pb.formatDuration(ps.avgMs))} · longest ${esc(pb.formatDuration(ps.longestMs))} · shortest ${esc(pb.formatDuration(ps.shortestMs))} · unresolved ${ps.unresolved}</p>
<table><thead><tr><th>#</th><th>Paused at (SLST)</th><th>Resumed at (SLST)</th><th>Duration</th><th>Position</th></tr></thead><tbody>${pauses.map(p => row([p.number, S(p.pausedAt),
      p.resumedAt ? S(p.resumedAt) : p.status === "unresolved" ? "unresolved" : "still paused", p.durationMs != null ? pb.formatDuration(p.durationMs) : p.status === "unresolved" ? "at least " + pb.formatDuration(p.minDurationMs) : "—", p.pausedPos + " s"])).join("")}</tbody></table>
<h2>Sessions</h2><table><thead><tr><th>Started (SLST)</th><th>Ended (SLST)</th><th>Device</th><th>Active</th><th>Paused</th><th>Elapsed</th><th>Completed</th></tr></thead><tbody>${[...es, ...summaryOnly].sort((a, b) => a.startedAt - b.startedAt).map(s => row([S(s.startedAt),
      s.endedAt ? S(s.endedAt) : s.state, s.deviceLabel, pb.formatDuration(s.hasEvents ? s.metrics.activeMs : s.summary.watchedMs), s.hasEvents ? pb.formatDuration(s.metrics.pausedMs) : "no event history",
      s.hasEvents ? pb.formatDuration(s.metrics.elapsedMs) : "", s.completed ? "yes" : "no"])).join("")}</tbody></table>
<h2>Events (${ev.items.length}${ev.total > ev.items.length ? " of " + ev.total : ""})</h2><table><thead><tr><th>#</th><th>When (SLST)</th><th>Event</th><th>Position</th><th>Related</th></tr></thead><tbody>${ev.items.map((e, i) => row([i + 1, S(e.tsAdj), e.type.replace("VIDEO_", ""),
      e.pos + " s", relatedText(e.related)])).join("")}</tbody></table><script src="/print.js"></script></body></html>`;
    return reply.header("Content-Type", "text/html; charset=utf-8").send(html);
  });
}
