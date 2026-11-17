import path from "node:path";
import { fileURLToPath } from "node:url";
import { ownDevice } from "../lib/helpers.js";
import { connectionOf } from "../lib/sessions.js";
import { stateOf } from "../lib/config.js";
import { diagnose } from "../lib/deviceDiagnostics.js";
import { readVersion } from "../lib/health.js";

// Device Control Center reads: connection diagnostics and activity history for ONE device. Owner only; ownership is checked on every
// call (a device of another account answers 403 / 404 exactly like the rest of /api/devices/:id). Nothing here returns a credential,
// a token hash, a pairing code or any video content.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const num = v => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

// Plain wording for what the audit log records, so the page does not need to know the action codes.
const ACTIONS = {
  approve: ["Device approved", "pairing"], revoke: ["Access revoked", "security"], delete_device: ["Device removed", "security"], rename: ["Renamed", "settings"],
  device_live_view_on: ["Live viewing turned ON by the person at the device", "consent"], device_live_view_off: ["Live viewing turned OFF by the person at the device", "consent"],
  pair_completed: ["Paired", "pairing"], pair_requested: ["Paired, waiting for approval", "pairing"], pairing_failed: ["A pairing attempt failed", "security"],
  session_deletion_requested: ["The device asked to delete its session", "security"], session_deletion_approved: ["Deletion request approved", "security"], session_deletion_denied: ["Deletion request denied", "security"],
  session_revoked: ["Session revoked", "security"], config_changed: ["Settings changed", "settings"], config_applied: ["Settings applied by the device", "settings"], config_failed: ["The device refused a settings change", "settings"],
  refresh_reuse_detected: ["A reused sign-in token was detected", "security"]
};function describe(action, detail) {
  if (action.startsWith("enqueue:")) return { title: "Command sent: " + action.slice(8).replace(/_/g, " "), group: "command" };
  const a = ACTIONS[action];
  return a ? { title: a[0], group: a[1] } : { title: action.replace(/[_:]/g, " "), group: "other" };
}

export default async function (app, { db, config }) {
  app.addHook("preHandler", app.authAdmin);
  const serverVersion = readVersion(ROOT);

  app.get("/api/devices/:id/diagnostics", (req, reply) => ownDevice(db, req, reply, d => {
    const now = Date.now();
    const live = app.hub.isOnline(d.id);
    const active = db.prepare("SELECT COUNT(*) n FROM device_sessions WHERE device_id=? AND status='active'").get(d.id).n;
    const conn = connectionOf(d, { live, activeSessions: active, now });
    const cfgRow = db.prepare("SELECT * FROM device_config WHERE device_id=?").get(d.id);
    let interval = 5;
    try { const c = cfgRow ? JSON.parse(cfgRow.config) : {}; if (Number.isInteger(c.sync_interval_minutes)) interval = c.sync_interval_minutes; } catch { /* default */ }
    const errors = db.prepare("SELECT at,kind,message FROM device_sync_errors WHERE device_id=? ORDER BY at DESC, id DESC LIMIT 20").all(d.id);
    const result = diagnose({
      device: d, connection: conn.state, realtime: live, activeSessions: active, errors, serverVersion, syncIntervalMin: interval, now,
      config: cfgRow ? { state: stateOf(cfgRow), error: cfgRow.failed_error } : null
    });
    return {
      deviceId: d.id, label: d.label || "Device", checkedAt: now, connection: conn.state, online: conn.online, realtime: live,
      lastSeen: d.last_seen, lastPushAt: d.last_push_at, lastEventsAt: d.last_events_at, clientVersion: d.client_version, serverVersion,
      queue: { sessions: d.pending_count || 0, events: d.queue_events || 0, dropped: d.queue_dropped || 0 },
      consents: { liveView: !!d.live_view, liveViewSince: d.live_view ? d.live_view_at : null, tracking: d.consent_tracking === null ? null : !!d.consent_tracking, detail: d.consent_detail === null ? null : !!d.consent_detail },
      ...result
    };
  }));

  // Newest first. `before` (epoch ms) pages backwards; `limit` is 1..200.
  app.get("/api/devices/:id/activity", (req, reply) => ownDevice(db, req, reply, d => {
    const limit = Math.min(Math.max(Math.floor(num(req.query?.limit)) || 50, 1), 200), before = num(req.query?.before) ?? Number.MAX_SAFE_INTEGER;
    const items = [];
    for (const r of db.prepare("SELECT action,detail,ip,created_at FROM audit_log WHERE device_id=? AND created_at<? ORDER BY created_at DESC LIMIT ?").all(d.id, before, limit)) {
      let detail = null; try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { /* keep null */ }
      const x = describe(r.action, detail);
      items.push({ at: r.created_at, source: "owner-or-device", action: r.action, title: x.title, group: x.group, detail: safeDetail(detail) });
    }
    for (const r of db.prepare("SELECT at,kind,message FROM device_sync_errors WHERE device_id=? AND at<? ORDER BY at DESC LIMIT ?").all(d.id, before, limit)) {
      items.push({ at: r.at, source: "device", action: "sync_error", title: "Sync problem: " + r.kind, group: "error", detail: { message: r.message } });
    }
    for (const r of db.prepare("SELECT version,changes,actor_label,created_at FROM device_config_history WHERE device_id=? AND created_at<? ORDER BY created_at DESC LIMIT ?").all(d.id, before, limit)) {
      let changes = {}; try { changes = JSON.parse(r.changes); } catch { /* none */ }
      items.push({ at: r.created_at, source: "owner", action: "config_change", title: "Settings version " + r.version + " saved", group: "settings", detail: { changes, by: r.actor_label || null } });
    }
    items.sort((a, b) => b.at - a.at);
    const page = items.slice(0, limit);
    return { deviceId: d.id, items: page, next: page.length === limit ? page[page.length - 1].at : null };
  }));
}

// The audit detail is free-form JSON written by this server; only simple scalar fields are passed on.
function safeDetail(detail) {
  if (!detail || typeof detail !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(detail)) if (["string", "number", "boolean"].includes(typeof v) && !/token|secret|code|password|hash/i.test(k)) out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  return Object.keys(out).length ? out : null;
}
