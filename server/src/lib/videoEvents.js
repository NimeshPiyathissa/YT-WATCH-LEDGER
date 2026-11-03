// Event-level playback history: ingest, derived tables, and the lookups the Video Details API uses.
// The derived tables (video_sessions, video_pause_intervals, video_watch_segments, video_analytics) are a pure function of
// the stored events (src/lib/playback.cjs fold), so they are rebuilt per touched session and can always be regenerated.
import { encryptJSON, decryptJSON } from "./crypto.js";
import pb from "./playback.cjs";

export const MAX_BATCH = 200;
const MAX_EVENTS_PER_SESSION = pb.MAX_EVENTS_PER_SESSION;

const SKEW_IGNORE_MS = 2 * 60 * 1000; // smaller differences are request latency / rounding, not a wrong clock
const SKEW_MAX_MS = 400 * 24 * 3600 * 1000; // a clock more than ~13 months off is treated as garbage and ignored

// Device clock offset: skew = server time - device time, measured when the device uploads (shared with /api/sync/push).
export function measureSkew(prevSkew, clientNow, now) {
  let skew = prevSkew || 0;
  const c = Number(clientNow);
  if (Number.isFinite(c) && c > 0) {
    const raw = now - c;
    skew = Math.abs(raw) < SKEW_IGNORE_MS ? 0 : (Math.abs(raw) > SKEW_MAX_MS ? skew : raw);
  }
  return skew;
}

export function eventRow(r) {
  const p = decryptJSON(r.enc);
  return { id: r.id, sessionId: r.session_id, videoId: r.video_id, seq: r.seq, type: r.type, ts: r.ts, tsAdj: r.ts_adj,
    pos: p.pos, rate: p.rate, prev: p.prev, next: p.next, meta: p.meta || {} };
}

// Folds one session's events and rewrites its derived rows. Idempotent; safe to call in any order.
export function recomputeSession(db, deviceId, sessionId, skew = null) {
  const rows = db.prepare("SELECT * FROM video_playback_events WHERE device_id=? AND session_id=? ORDER BY seq").all(deviceId, sessionId);
  if (!rows.length) {
    for (const t of ["video_sessions", "video_pause_intervals", "video_watch_segments"]) db.prepare(`DELETE FROM ${t} WHERE device_id=? AND session_id=?`).run(deviceId, sessionId);
    return null;
  }
  const evs = rows.map(eventRow);
  const prev = db.prepare("SELECT skew_ms FROM video_sessions WHERE device_id=? AND session_id=?").get(deviceId, sessionId);
  const skewMs = skew != null ? skew : (prev ? prev.skew_ms : rows[rows.length - 1].ts_adj - rows[rows.length - 1].ts);
  const f = pb.fold(evs);
  const m = f.metrics, videoId = rows[0].video_id, now = Date.now();
  const adj = t => (t == null ? null : t + skewMs);
  db.prepare(`INSERT INTO video_sessions(device_id,session_id,video_id,started_at,ended_at,last_event_at,state,completed,event_count,skew_ms,enc,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,session_id) DO UPDATE SET video_id=excluded.video_id,started_at=excluded.started_at,
    ended_at=excluded.ended_at,last_event_at=excluded.last_event_at,state=excluded.state,completed=excluded.completed,event_count=excluded.event_count,
    skew_ms=excluded.skew_ms,enc=excluded.enc,updated_at=excluded.updated_at`)
    .run(deviceId, sessionId, videoId, adj(m.startedAt), adj(m.endedAt != null ? m.endedAt : m.interruptedAt), adj(m.lastEventAt),
      m.status === "empty" ? "open" : m.status, m.completed ? 1 : 0, m.eventCount, skewMs, encryptJSON(m), now);
  db.prepare("DELETE FROM video_pause_intervals WHERE device_id=? AND session_id=?").run(deviceId, sessionId);
  const ins = db.prepare("INSERT INTO video_pause_intervals(device_id,session_id,n,video_id,paused_at,resumed_at,status,duration_ms,enc) VALUES(?,?,?,?,?,?,?,?,?)");
  for (const p of f.pauses) ins.run(deviceId, sessionId, p.n, videoId, adj(p.pausedAt), adj(p.resumedAt), p.status, p.durationMs,
    encryptJSON({ pausedPos: p.pausedPos, resumedPos: p.resumedPos, minDurationMs: p.minDurationMs, pausedEventId: p.pausedEventId, resumedEventId: p.resumedEventId }));
  db.prepare("INSERT INTO video_watch_segments(device_id,session_id,video_id,enc) VALUES(?,?,?,?) ON CONFLICT(device_id,session_id) DO UPDATE SET enc=excluded.enc,video_id=excluded.video_id")
    .run(deviceId, sessionId, videoId, encryptJSON({ segments: f.segments, runs: f.runs }));
  return { folded: f, skewMs, videoId };
}

// Per device and video roll-up across its sessions.
export function recomputeAnalytics(db, deviceId, videoId) {
  const sess = db.prepare("SELECT session_id,enc,last_event_at FROM video_sessions WHERE device_id=? AND video_id=?").all(deviceId, videoId);
  if (!sess.length) { db.prepare("DELETE FROM video_analytics WHERE device_id=? AND video_id=?").run(deviceId, videoId); return null; }
  const segs = Object.fromEntries(db.prepare("SELECT session_id,enc FROM video_watch_segments WHERE device_id=? AND video_id=?").all(deviceId, videoId)
    .map(r => [r.session_id, decryptJSON(r.enc).segments]));
  const list = sess.map(s => ({ metrics: decryptJSON(s.enc), pauses: [], segments: segs[s.session_id] || [] }));
  const r = pb.rollup(list);
  const last = Math.max(...sess.map(s => s.last_event_at));
  db.prepare(`INSERT INTO video_analytics(device_id,video_id,last_event_at,enc,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(device_id,video_id) DO UPDATE SET last_event_at=excluded.last_event_at,enc=excluded.enc,updated_at=excluded.updated_at`)
    .run(deviceId, videoId, last, encryptJSON(r), Date.now());
  return r;
}

// Stores a batch. Returns what to acknowledge: every id that is now safely stored (new or already present) and the ids
// that can never be accepted, so the device stops retrying them.
export function ingestEvents(db, device, rawEvents, { clientNow = null, now = Date.now() } = {}) {
  const skew = measureSkew(device.clock_skew_ms, clientNow, now);
  const clean = [], rejected = [];
  for (const raw of rawEvents) {
    const e = pb.validateEvent(raw, now + SKEW_IGNORE_MS);
    if (e) clean.push(e);
    else if (raw && typeof raw.id === "string") rejected.push(raw.id.slice(0, 80));
  }
  const acked = [], touched = new Map(); // sessionId -> videoId
  const exists = db.prepare("SELECT 1 FROM video_playback_events WHERE device_id=? AND id=?");
  const count = db.prepare("SELECT COUNT(*) n FROM video_playback_events WHERE device_id=? AND session_id=?");
  const ins = db.prepare(`INSERT OR IGNORE INTO video_playback_events(device_id,id,session_id,video_id,type,seq,ts,ts_adj,enc,received_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const fresh = [];
  db.transaction(() => {
    const room = new Map();
    for (const e of clean) {
      if (exists.get(device.id, e.id)) { acked.push(e.id); continue; } // already stored: idempotent
      if (!room.has(e.sessionId)) room.set(e.sessionId, MAX_EVENTS_PER_SESSION - count.get(device.id, e.sessionId).n);
      if (room.get(e.sessionId) <= 0) { rejected.push(e.id); continue; }
      const r = ins.run(device.id, e.id, e.sessionId, e.videoId, e.type, e.seq, e.ts, e.ts + skew,
        encryptJSON({ pos: e.pos, rate: e.rate, prev: e.prev, next: e.next, meta: e.meta }), now);
      if (r.changes) { room.set(e.sessionId, room.get(e.sessionId) - 1); fresh.push({ ...e, tsAdj: e.ts + skew }); touched.set(e.sessionId, e.videoId); }
      acked.push(e.id);
    }
    const videos = new Set();
    for (const [sid, vid] of touched) { recomputeSession(db, device.id, sid, skew); videos.add(vid); }
    for (const vid of videos) recomputeAnalytics(db, device.id, vid);
    db.prepare("UPDATE devices SET last_events_at=?, clock_skew_ms=? WHERE id=?").run(now, skew, device.id);
  })();
  return { acked, rejected, fresh, skew };
}

// Removes event history for sessions that started in [from, to] (adjusted time): the owner's delete and retention.
export function deleteVideoEvents(db, deviceId, from, to) {
  const sess = db.prepare("SELECT session_id,video_id FROM video_sessions WHERE device_id=? AND started_at>=? AND started_at<=?").all(deviceId, from, to);
  const dEv = db.prepare("DELETE FROM video_playback_events WHERE device_id=? AND session_id=?");
  const videos = new Set();
  db.transaction(() => {
    for (const s of sess) { dEv.run(deviceId, s.session_id); recomputeSession(db, deviceId, s.session_id); videos.add(s.video_id); }
    for (const v of videos) recomputeAnalytics(db, deviceId, v);
  })();
  return sess.length;
}
