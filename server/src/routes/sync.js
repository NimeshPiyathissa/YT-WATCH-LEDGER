import { encryptJSON } from "../lib/crypto.js";
import { cleanSession } from "../lib/helpers.js";
import { purgeDevice, recomputeVideo } from "../lib/retention.js";
import { fileDeletionRequest } from "../lib/sessions.js";
import { measureSkew } from "../lib/videoEvents.js";

const REDELIVER_AFTER_MS = 60 * 1000; // delivered-but-unacked commands are re-sent after this

export default async function (app, { db }) {
  app.addHook("preHandler", app.authDevice);

  // Conflict rule: the highest revision of a session wins. Revisions are counted by the device per session, so the
  // outcome never depends on any wall clock. Re-sending the same revision is an idempotent overwrite with identical data.
  const upSess = db.prepare(`INSERT INTO sessions(device_id,session_id,enc,video_id,start_ts,start_ts_adj,rev,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(device_id,session_id) DO UPDATE SET
      enc=excluded.enc,start_ts=excluded.start_ts,start_ts_adj=excluded.start_ts_adj,rev=excluded.rev,updated_at=excluded.updated_at
    WHERE excluded.rev >= sessions.rev`);
  const upStatus = db.prepare(`UPDATE devices SET last_push_at=?,pending_count=?,last_error=?,client_version=?,clock_skew_ms=? WHERE id=?`);

  app.post("/api/sync/push", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const dev = req.device, now = Date.now();
    const body = req.body || {};
    if (body.sessions != null && !Array.isArray(body.sessions)) return reply.code(400).send({ error: "bad_request" });
    const input = body.sessions || [];
    if (input.length > 500) return reply.code(413).send({ error: "too_many_sessions" });
    const sessions = input.map(cleanSession).filter(Boolean);
    // Events that can never be accepted (malformed) are reported so the device drops them instead of retrying forever.
    const rejected = input.filter(s => !cleanSession(s) && s && typeof s.sessionId === "string")
      .map(s => ({ sessionId: s.sessionId.slice(0, 64), rev: Number(s.rev) || 0 }));

    // Put this device's clock on the server's: skew = server time - device time, measured when the device uploads.
    const skew = measureSkew(dev.clock_skew_ms, body.clientNow, now);

    const touched = new Set();
    db.transaction(() => {
      for (const s of sessions) {
        const rec = { ...s, startTsAdj: s.startTs + skew, endTsAdj: s.endTs ? s.endTs + skew : null, skewMs: skew, deviceId: dev.id };
        upSess.run(dev.id, s.sessionId, encryptJSON(rec), s.videoId, s.startTs, rec.startTsAdj, s.rev, now);
        touched.add(s.videoId);
      }
      for (const vid of touched) recomputeVideo(db, dev.id, vid);
      upStatus.run(now, Math.min(Math.max(Math.floor(Number(body.pending)) || 0, 0), 1e7),
        typeof body.lastError === "string" && body.lastError ? body.lastError.slice(0, 300) : null,
        typeof body.clientVersion === "string" ? body.clientVersion.slice(0, 32) : null, skew, dev.id);
    })();
    // Per-event acknowledgement: the device removes an outbox row only when its (sessionId, rev) is listed here.
    // Re-sending an acknowledged event is harmless (idempotent upsert; a lower rev never overwrites a higher one).
    return { ok: true, upserted: sessions.length, acked: sessions.map(s => ({ sessionId: s.sessionId, rev: s.rev })), rejected, serverNow: now, skewMs: skew };
  });

  // Kept for extensions older than 0.5, whose "Unpair" called this. A device can no longer end its own session:
  // this files a deletion request for the owner to approve, exactly like the extension's "Delete session" button.
  app.post("/api/sync/unenroll", req => {
    const r = fileDeletionRequest(db, app.hub, { device: req.device, session: req.deviceSession, reason: "unpair requested by an older extension", ip: req.ip });
    return { ok: true, requested: true, requestId: r.request.id };
  });

  app.get("/api/sync/commands", req => {
    const now = Date.now();
    const cmds = db.prepare("SELECT id,type,payload FROM commands WHERE device_id=? AND (status='pending' OR (status='delivered' AND delivered_at<?)) ORDER BY created_at")
      .all(req.device.id, now - REDELIVER_AFTER_MS);
    const mark = db.prepare("UPDATE commands SET status='delivered',delivered_at=? WHERE id=?");
    db.transaction(() => cmds.forEach(c => mark.run(now, c.id)))();
    return { commands: cmds.map(c => ({ id: c.id, type: c.type, payload: c.payload ? JSON.parse(c.payload) : {} })) };
  });

  app.post("/api/sync/commands/ack", (req, reply) => {
    const acks = req.body?.acks;
    if (!Array.isArray(acks) || acks.length > 100) return reply.code(400).send({ error: "bad_request" });
    const upd = db.prepare("UPDATE commands SET status='acked',acked_at=?,result=? WHERE id=? AND device_id=?");
    const getCmd = db.prepare("SELECT type,payload FROM commands WHERE id=? AND device_id=?");
    db.transaction(() => {
      for (const a of acks) {
        if (!a || typeof a.id !== "string") continue;
        const cmd = getCmd.get(a.id, req.device.id);
        if (!cmd) continue;
        upd.run(Date.now(), JSON.stringify(a.result ?? null).slice(0, 2000), a.id, req.device.id);
        // Once the device confirms it applied a retention window, apply the same one to the synced copy.
        if (cmd.type === "set_retention" && a.result && a.result.status === "ok") {
          db.prepare("UPDATE devices SET retention_days=? WHERE id=?").run(JSON.parse(cmd.payload).days, req.device.id);
          purgeDevice(db, req.device.id);
        }
      }
    })();
    return { ok: true };
  });
}
