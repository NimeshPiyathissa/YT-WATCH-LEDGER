// What a device reports about itself on every upload: its consent switches, its queue, and any error it hit.
// The server only ever RECORDS these. A consent is never set or changed from the owner's side, and every change is written to
// the audit log so the owner can see what the person at the device switched.
import { audit } from "./helpers.js";

export const ERROR_KINDS = ["network", "server", "auth", "rejected", "quota", "other"];
const MAX_ERRORS_PER_DEVICE = 50;
const bool01 = v => (v === true ? 1 : v === false ? 0 : null);

// body.consents: { liveView, tracking, detail } booleans (anything else is ignored); body.queue: { events, dropped } counts.
export function recordDeviceState(db, dev, body, { now = Date.now(), ip = null } = {}) {
  const c = body && typeof body.consents === "object" && body.consents ? body.consents : {};
  const live = bool01(c.liveView), track = bool01(c.tracking), detail = bool01(c.detail);
  const q = body && typeof body.queue === "object" && body.queue ? body.queue : {};
  const cnt = v => Math.min(Math.max(Math.floor(Number(v)) || 0, 0), 1e7);
  const sets = [], args = [];
  if (live !== null) { sets.push("live_view=?"); args.push(live); if (live !== (dev.live_view ? 1 : 0)) { sets.push("live_view_at=?"); args.push(now); } }
  if (track !== null) { sets.push("consent_tracking=?"); args.push(track); }
  if (detail !== null) { sets.push("consent_detail=?"); args.push(detail); }
  if (body && body.queue) { sets.push("queue_events=?", "queue_dropped=?"); args.push(cnt(q.events), cnt(q.dropped)); }
  if (sets.length) db.prepare(`UPDATE devices SET ${sets.join(",")} WHERE id=?`).run(...args, dev.id);
  const changed = live !== null && live !== (dev.live_view ? 1 : 0);
  if (changed) audit(db, dev.admin_id, dev.id, live ? "device_live_view_on" : "device_live_view_off", ip, { by: "device" });
  return { liveView: live !== null ? live === 1 : !!dev.live_view, liveViewChanged: changed };
}

// Keeps a short, deduplicated history: the same message again within ten minutes only bumps nothing (no new row).
export function recordSyncError(db, dev, message, kind, now = Date.now()) {
  if (typeof message !== "string" || !message.trim()) return false;
  const msg = message.trim().slice(0, 300), k = ERROR_KINDS.includes(kind) ? kind : "other";
  const last = db.prepare("SELECT message,at FROM device_sync_errors WHERE device_id=? ORDER BY at DESC, id DESC LIMIT 1").get(dev.id);
  if (last && last.message === msg && now - last.at < 10 * 60 * 1000) return false;
  db.prepare("INSERT INTO device_sync_errors(device_id,at,kind,message) VALUES (?,?,?,?)").run(dev.id, now, k, msg);
  db.prepare(`DELETE FROM device_sync_errors WHERE device_id=? AND id NOT IN (SELECT id FROM device_sync_errors WHERE device_id=? ORDER BY at DESC, id DESC LIMIT ${MAX_ERRORS_PER_DEVICE})`).run(dev.id, dev.id);
  return true;
}
