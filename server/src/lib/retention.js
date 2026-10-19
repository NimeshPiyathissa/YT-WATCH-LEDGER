// Retention, cleanup and per-video rollup maintenance for the server copy.
import { encryptJSON, decryptJSON } from "./crypto.js";
import acc from "./accounting.cjs";

export const thumb = id => "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";

// Sessions are stored with the device's own clock plus the skew measured at upload; rollups use the corrected times.
export function normalised(rec) {
  return { ...rec, startTs: rec.startTsAdj ?? rec.startTs, endTs: rec.endTsAdj ?? rec.endTs };
}

// Rebuilds (or removes) one video's rollup for one device from its stored sessions.
export function recomputeVideo(db, deviceId, videoId) {
  const all = db.prepare("SELECT enc FROM sessions WHERE device_id=? AND video_id=?").all(deviceId, videoId).map(r => normalised(decryptJSON(r.enc)));
  const roll = acc.rollupVideo(videoId, all, thumb);
  if (!roll) { db.prepare("DELETE FROM videos WHERE device_id=? AND video_id=?").run(deviceId, videoId); return null; }
  db.prepare(`INSERT INTO videos(device_id,video_id,enc,last_watched,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(device_id,video_id) DO UPDATE SET enc=excluded.enc,last_watched=excluded.last_watched,updated_at=excluded.updated_at`)
    .run(deviceId, videoId, encryptJSON(roll), roll.lastWatched || 0, Date.now());
  return roll;
}

export function getGlobalRetention(db) {
  const r = db.prepare("SELECT value FROM settings WHERE key='server_retention_days'").get();
  return r ? Number(r.value) || 0 : 0;
}
export function setGlobalRetention(db, days) {
  db.prepare("INSERT INTO settings(key,value) VALUES('server_retention_days',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(days));
}
// The shorter of the owner's server-wide window and the window the device itself applied (0 = keep forever).
export function effectiveRetention(deviceDays, globalDays) {
  if (deviceDays > 0 && globalDays > 0) return Math.min(deviceDays, globalDays);
  return deviceDays > 0 ? deviceDays : globalDays;
}

// Deletes sessions older than the effective retention window and rebuilds affected rollups.
export function purgeDevice(db, deviceId, now = Date.now()) {
  const d = db.prepare("SELECT retention_days FROM devices WHERE id=?").get(deviceId);
  if (!d) return 0;
  const days = effectiveRetention(d.retention_days, getGlobalRetention(db));
  if (!(days > 0)) return 0;
  const cutoff = now - days * 86400000;
  return db.transaction(() => {
    const affected = db.prepare("SELECT DISTINCT video_id FROM sessions WHERE device_id=? AND start_ts_adj<?").all(deviceId, cutoff).map(r => r.video_id);
    if (!affected.length) return 0;
    const removed = db.prepare("DELETE FROM sessions WHERE device_id=? AND start_ts_adj<?").run(deviceId, cutoff).changes;
    for (const vid of affected) recomputeVideo(db, deviceId, vid);
    return removed;
  })();
}
export function purgeAll(db, now = Date.now()) {
  return db.prepare("SELECT id FROM devices").all().reduce((n, d) => n + purgeDevice(db, d.id, now), 0);
}

// A device that asked to pair but was never approved is removed after a day.
export function expirePending(db, now = Date.now(), ttlMs = 24 * 3600 * 1000) {
  return db.prepare("DELETE FROM devices WHERE status='pending' AND enrolled_at<?").run(now - ttlMs).changes;
}
// Housekeeping: expired pairing codes and old audit entries.
export function purgeHousekeeping(db, now = Date.now(), auditDays = 365) {
  db.prepare("DELETE FROM enroll_codes WHERE expires_at<?").run(now - 24 * 3600 * 1000);
  db.prepare("DELETE FROM audit_log WHERE created_at<?").run(now - auditDays * 86400000);
}
