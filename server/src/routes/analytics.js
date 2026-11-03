import { decryptJSON } from "../lib/crypto.js";
import { computeAnalytics, DISPLAY_TZ } from "../lib/analytics.js";

// Owner-only analytics. Every query is scoped to the owner's own devices (devices.admin_id). Playback intervals come from the
// recorded playback runs (event based, shifted onto the server clock by the skew measured at upload); a session recorded before
// events existed falls back to its summary. The arithmetic lives in src/lib/analytics.js and is unit tested on its own.
const DAY = 86400000, MAX_RANGE_DAYS = 366, MAX_ROWS = 200000, MAX_SESSION_MS = DAY;
const RANGES = { today: 1, "7": 7, "30": 30, "90": 90, "365": 365 };
const num = v => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export default async function (app, { db }) {
  app.addHook("preHandler", app.authAdmin);

  // Intervals of real playback for the owner's devices that overlap [lo, hi).
  function loadIntervals(adminId, device, lo, hi) {
    const labels = Object.fromEntries(db.prepare("SELECT id,label FROM devices WHERE admin_id=?").all(adminId).map(d => [d.id, d.label || "Device"]));
    const rows = db.prepare(`SELECT s.device_id, s.session_id, s.enc FROM sessions s JOIN devices d ON d.id=s.device_id
      WHERE d.admin_id=@a AND (@dev IS NULL OR s.device_id=@dev) AND s.start_ts_adj>=@lo AND s.start_ts_adj<@hi LIMIT ${MAX_ROWS}`).all({ a: adminId, dev: device, lo, hi });
    const runs = new Map();
    for (const r of db.prepare(`SELECT w.device_id, w.session_id, w.video_id, w.enc, vs.skew_ms FROM video_watch_segments w
      JOIN video_sessions vs ON vs.device_id=w.device_id AND vs.session_id=w.session_id JOIN devices d ON d.id=w.device_id
      WHERE d.admin_id=@a AND (@dev IS NULL OR w.device_id=@dev) AND vs.started_at>=@lo AND vs.started_at<@hi LIMIT ${MAX_ROWS}`).all({ a: adminId, dev: device, lo, hi })) {
      runs.set(r.device_id + "/" + r.session_id, { runs: decryptJSON(r.enc).runs || [], skew: r.skew_ms || 0, videoId: r.video_id, deviceId: r.device_id, sessionId: r.session_id });
    }
    const intervals = [], sessions = [], seen = new Set();
    for (const r of rows) {
      seen.add(r.device_id + "/" + r.session_id);
      const s = decryptJSON(r.enc), start = s.startTsAdj ?? s.startTs;
      if (!Number.isFinite(start)) continue;
      const base = { deviceId: r.device_id, sessionId: r.session_id, videoId: s.videoId || "", title: s.title || "", channel: s.channel || "" };
      sessions.push({ start, completed: !!s.completed, pauses: s.pauses || 0, seeks: s.seeks || 0 });
      const ev = runs.get(r.device_id + "/" + r.session_id);
      if (ev && ev.runs.length) {
        for (const x of ev.runs) if (Number.isFinite(x.ts) && x.ms > 0) intervals.push({ ...base, start: x.ts + ev.skew, end: x.ts + ev.skew + x.ms });
      } else {
        const ms = Math.min(Math.max(0, s.watchedMs || 0), MAX_SESSION_MS); // summary only: one interval from the start of the session
        if (ms > 0) intervals.push({ ...base, start, end: start + ms });
      }
    }
    // a viewing whose event history arrived but whose summary has not (yet): the events alone are enough for time
    for (const [key, ev] of runs) {
      if (seen.has(key)) continue;
      const base = { deviceId: ev.deviceId, sessionId: ev.sessionId, videoId: ev.videoId, title: "", channel: "" };
      for (const x of ev.runs) if (Number.isFinite(x.ts) && x.ms > 0) intervals.push({ ...base, start: x.ts + ev.skew, end: x.ts + ev.skew + x.ms });
    }
    return { intervals, sessions, labels, truncated: rows.length >= MAX_ROWS };
  }

  app.get("/api/analytics", (req, reply) => {
    const q = req.query || {};
    const now = Date.now();
    let to = num(q.to), from = num(q.from);
    if (from === null && to === null && q.range !== undefined) {
      if (!Object.hasOwn(RANGES, String(q.range))) return reply.code(400).send({ error: "bad_range" });
      to = now; from = now - RANGES[String(q.range)] * DAY;
    }
    if (to === null) to = now;
    if (from === null) from = to - 30 * DAY;
    if (!(from >= 0) || !(to > from) || to - from > MAX_RANGE_DAYS * DAY) return reply.code(400).send({ error: "bad_range" });
    const granularity = q.granularity === undefined || q.granularity === "" ? "auto" : String(q.granularity);
    if (!["auto", "day", "week", "month"].includes(granularity)) return reply.code(400).send({ error: "bad_granularity" });
    let device = q.device && q.device !== "all" ? String(q.device).slice(0, 64) : null;
    if (device && !db.prepare("SELECT 1 FROM devices WHERE id=? AND admin_id=?").get(device, req.admin.id)) return reply.code(404).send({ error: "not_found" });
    // devices of another account are unreachable; a session that starts up to a day before `from` can still reach into the range
    const { intervals, sessions, labels, truncated } = loadIntervals(req.admin.id, device, from - (to - from) - DAY, to);
    return { ...computeAnalytics({ intervals, sessions, from, to, granularity, tz: DISPLAY_TZ, labels }), truncated, generatedAt: now };
  });
}
