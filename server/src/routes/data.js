import fs from "node:fs";
import { decryptJSON } from "../lib/crypto.js";
import { summarize } from "../lib/aggregate.js";
import { audit } from "../lib/helpers.js";
import { recomputeVideo, getGlobalRetention, setGlobalRetention, purgeAll } from "../lib/retention.js";
import { createBackup, listBackups } from "../lib/backup.js";
import pb from "../lib/playback.cjs";
import { deleteVideoEvents } from "../lib/videoEvents.js";

const MAX_ROWS = 200000;

// Owner-only combined views over every paired device's data. Records are decrypted in memory per request;
// the filterable text fields (title, channel, url) are only ever stored encrypted, so text filters run after decryption.
export default async function (app, { db, config }) {
  app.addHook("preHandler", app.authAdmin);

  function filterOf(q = {}) {
    const n = v => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      device: q.device && q.device !== "all" ? String(q.device).slice(0, 64) : null,
      from: n(q.from) ?? 0, to: n(q.to) ?? Number.MAX_SAFE_INTEGER,
      text: String(q.q || "").trim().toLowerCase().slice(0, 200),
      url: String(q.url || "").trim().toLowerCase().slice(0, 300)
    };
  }

  function loadItems(adminId, f) {
    const labels = Object.fromEntries(db.prepare("SELECT id,label FROM devices WHERE admin_id=?").all(adminId).map(d => [d.id, d.label || "Device"]));
    const rows = db.prepare(`SELECT s.enc AS enc, s.device_id AS device_id, s.updated_at AS updated_at FROM sessions s JOIN devices d ON d.id=s.device_id
      WHERE d.admin_id=@admin AND (@device IS NULL OR s.device_id=@device) AND s.start_ts_adj>=@from AND s.start_ts_adj<=@to
      ORDER BY s.start_ts_adj DESC LIMIT ${MAX_ROWS}`).all({ admin: adminId, device: f.device, from: f.from, to: f.to });
    const items = [];
    for (const r of rows) {
      const s = decryptJSON(r.enc);
      const it = {
        deviceId: r.device_id, deviceLabel: labels[r.device_id] || "Device", sessionId: s.sessionId, videoId: s.videoId, kind: s.kind || "watch",
        url: s.url || "", title: s.title || "", channel: s.channel || "",
        startTs: s.startTsAdj ?? s.startTs, endTs: s.endTsAdj ?? s.endTs ?? null, deviceStartTs: s.startTs, skewMs: s.skewMs || 0,
        watchedMs: s.watchedMs || 0, duration: s.duration || 0,
        progress: s.duration > 0 ? Math.min(100, Math.round((s.furthestSec || 0) / s.duration * 100)) : null,
        startSec: s.startSec ?? null, positionSec: s.positionSec || 0, furthestSec: s.furthestSec || 0,
        seeks: s.seeks || 0, rewinds: s.rewinds || 0, pauses: s.pauses || 0, completed: !!s.completed, rev: s.rev || 0,
        updatedAt: r.updated_at // server time of the last accepted push for this session (not a device clock)
      };
      if (f.text && !(it.title.toLowerCase().includes(f.text) || it.channel.toLowerCase().includes(f.text))) continue;
      if (f.url && !it.url.toLowerCase().includes(f.url)) continue;
      items.push(it);
    }
    return { items, truncated: rows.length >= MAX_ROWS };
  }

  app.get("/api/history", req => {
    const f = filterOf(req.query);
    const limit = Math.min(Math.max(Number(req.query?.limit) || 100, 1), 500), offset = Math.max(Number(req.query?.offset) || 0, 0);
    const { items, truncated } = loadItems(req.admin.id, f);
    return { total: items.length, items: items.slice(offset, offset + limit), truncated, serverNow: Date.now() };
  });

  app.get("/api/stats", req => {
    const { items, truncated } = loadItems(req.admin.id, filterOf(req.query));
    return { ...summarize(items, { now: Date.now() }), timeZone: pb.DISPLAY_TZ, truncated }; // days are Sri Lanka days whatever the browser's zone
  });

  /* ---- export: JSON or CSV of everything matching the filters ---- */
  // startedAt / endedAt stay UTC (ISO 8601, unchanged for anything that reads them); the two *Slst columns repeat them in Sri Lanka time.
const CSV_COLS = ["device", "sessionId", "videoId", "url", "title", "channel", "startedAt", "endedAt", "watchedSeconds", "durationSeconds", "progressPercent", "completed", "seeks", "rewinds", "pauses", "startedAtSlst", "endedAtSlst"];
  // Titles and channel names come from the web, so spreadsheet formula injection is guarded: a leading = + - @ is neutralised.
  const cell = v => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  app.get("/api/export", (req, reply) => {
    const f = filterOf(req.query);
    const { items } = loadItems(req.admin.id, f);
    const stamp = pb.dayKey(Date.now()); // the file name carries the Sri Lanka date
    audit(db, req.admin.id, f.device, "export", req.ip, { format: req.query?.format === "csv" ? "csv" : "json", rows: items.length });
    if (req.query?.format === "csv") {
      const lines = [CSV_COLS.join(",")].concat(items.map(it => [it.deviceLabel, it.sessionId, it.videoId, it.url, it.title, it.channel,
        new Date(it.startTs).toISOString(), it.endTs ? new Date(it.endTs).toISOString() : "", Math.round(it.watchedMs / 1000), it.duration,
        it.progress ?? "", it.completed, it.seeks, it.rewinds, it.pauses, pb.formatStamp(it.startTs), it.endTs ? pb.formatStamp(it.endTs) : ""].map(cell).join(",")));
      return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="watch-history-${stamp}.csv"`).send(lines.join("\r\n") + "\r\n");
    }
    return reply.header("Content-Disposition", `attachment; filename="watch-history-${stamp}.json"`).send({ exportedAt: new Date().toISOString(), exportedAtSlst: pb.formatStamp(Date.now()), displayTimeZone: pb.DISPLAY_TZ, note: "Timestamps are UTC milliseconds; display them in Asia/Colombo (SLST, UTC+05:30).", count: items.length, items: items.map(({ updatedAt, ...rest }) => rest) });
  });

  /* ---- deletion of the SERVER copy (devices keep their own local data) ---- */
  app.post("/api/data/delete", (req, reply) => {
    const b = req.body || {};
    if (b.confirm !== true) return reply.code(400).send({ error: "confirmation_required" });
    const f = filterOf({ device: b.device, from: b.from, to: b.to });
    const rows = db.prepare(`SELECT s.device_id AS device_id, s.session_id AS session_id, s.video_id AS video_id FROM sessions s JOIN devices d ON d.id=s.device_id
      WHERE d.admin_id=@admin AND (@device IS NULL OR s.device_id=@device) AND s.start_ts_adj>=@from AND s.start_ts_adj<=@to`)
      .all({ admin: req.admin.id, device: f.device, from: f.from, to: f.to });
    const del = db.prepare("DELETE FROM sessions WHERE device_id=? AND session_id=?");
    db.transaction(() => {
      for (const r of rows) del.run(r.device_id, r.session_id);
      const devs = db.prepare("SELECT id FROM devices WHERE admin_id=? AND (? IS NULL OR id=?)").all(req.admin.id, f.device, f.device);
      for (const d of devs) deleteVideoEvents(db, d.id, f.from, f.to); // playback events of the same period
      for (const k of new Set(rows.map(r => r.device_id + "\u0000" + r.video_id))) { const [d, v] = k.split("\u0000"); recomputeVideo(db, d, v); }
    })();
    audit(db, req.admin.id, f.device, "delete_data", req.ip, { device: f.device || "all", from: b.from ?? null, to: b.to ?? null, sessions: rows.length });
    return { ok: true, deleted: rows.length };
  });

  /* ---- owner settings ---- */
  app.get("/api/settings", () => ({ server_retention_days: getGlobalRetention(db) }));
  app.put("/api/settings", (req, reply) => {
    const d = req.body?.server_retention_days;
    if (!Number.isInteger(d) || d < 0 || d > 3650) return reply.code(400).send({ error: "bad_retention" });
    setGlobalRetention(db, d);
    const removed = purgeAll(db);
    audit(db, req.admin.id, null, "set_server_retention", req.ip, { days: d, removed });
    return { ok: true, server_retention_days: d, removed };
  });

  /* ---- system: backups and database size ---- */
  app.get("/api/system", () => {
    let dbBytes = 0; try { dbBytes = config.dbPath && config.dbPath !== ":memory:" ? fs.statSync(config.dbPath).size : 0; } catch { /* ignore */ }
    const backups = listBackups(config.backupDir);
    return { serverTime: Date.now(), dbBytes, backups: backups.slice(0, 10), lastBackupAt: backups[0] ? backups[0].createdAt : null, backupKeep: config.backupKeep };
  });
  app.post("/api/system/backup", async (req, reply) => {
    try {
      const r = await createBackup(db, config.backupDir, config.backupKeep);
      audit(db, req.admin.id, null, "backup", req.ip, { name: r.name });
      return { ok: true, ...r };
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: "backup_failed" });
    }
  });
}
