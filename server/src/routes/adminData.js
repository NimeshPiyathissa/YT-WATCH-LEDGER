import { decryptJSON } from "../lib/crypto.js";
import { ownDevice } from "../lib/helpers.js";

// Read-only views for the web dashboard; shapes mirror the extension's local records.
export default async function (app, { db }) {
  app.addHook("preHandler", app.authAdmin);

  app.get("/api/devices/:id/videos", (req, reply) => ownDevice(db, req, reply, d =>
    db.prepare("SELECT enc FROM videos WHERE device_id=? ORDER BY last_watched DESC").all(d.id).map(r => decryptJSON(r.enc))));

  app.get("/api/devices/:id/sessions", (req, reply) => ownDevice(db, req, reply, d => {
    const since = Number(req.query?.since) || 0;
    const limit = Math.min(Number(req.query?.limit) || 5000, 20000);
    return db.prepare("SELECT enc FROM sessions WHERE device_id=? AND updated_at>? ORDER BY start_ts DESC LIMIT ?")
      .all(d.id, since, limit).map(r => decryptJSON(r.enc));
  }));

  app.get("/api/devices/:id/videos/:videoId/sessions", (req, reply) => ownDevice(db, req, reply, d =>
    db.prepare("SELECT enc FROM sessions WHERE device_id=? AND video_id=? ORDER BY start_ts DESC").all(d.id, req.params.videoId).map(r => decryptJSON(r.enc))));

  // Recent commands and whether the device has picked them up / applied them.
  app.get("/api/devices/:id/commands", (req, reply) => ownDevice(db, req, reply, d =>
    db.prepare("SELECT id,type,payload,status,result,created_at,delivered_at,acked_at FROM commands WHERE device_id=? ORDER BY created_at DESC LIMIT 50").all(d.id)
      .map(c => ({ ...c, payload: c.payload ? JSON.parse(c.payload) : {}, result: c.result ? JSON.parse(c.result) : null }))));

  // Newest first. Optional: ?action=<name> (exact), ?before=<ms> (continue after the last row you have), ?limit=<n> (default 200, at most 500).
  app.get("/api/audit", req => {
    const q = req.query || {}, limit = Math.min(Math.max(Math.floor(Number(q.limit)) || 200, 1), 500);
    const where = ["admin_id=?"], args = [req.admin.id];
    if (typeof q.action === "string" && q.action) { where.push("action=?"); args.push(q.action.slice(0, 64)); }
    if (Number.isFinite(Number(q.before)) && q.before !== undefined && q.before !== "") { where.push("created_at<?"); args.push(Number(q.before)); }
    return db.prepare(`SELECT id,device_id,action,detail,ip,created_at FROM audit_log WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, limit);
  });
}
