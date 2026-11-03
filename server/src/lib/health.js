// Server health snapshot for the owner's Health Center. Read-only and dependency free (Node's os / fs / process only).
// Nothing here reveals a path, a host name, an address or any secret: only sizes, counts and times.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listBackups } from "./backup.js";

const GB = 1024 ** 3;

// CPU use between two readings of the cumulative counters. The first reading after start covers the time since start.
export function createCpuSampler(readCpus = () => os.cpus(), clock = () => Date.now()) {
  const total = cpus => cpus.reduce((a, c) => { const t = c.times; a.idle += t.idle; a.all += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, all: 0 });
  let prev = total(readCpus()), at = clock(), last = null;
  return {
    percent() {
      const cur = total(readCpus()), now = clock();
      if (now - at < 1000 && last !== null) return last;           // do not recompute on every poll
      const all = cur.all - prev.all, idle = cur.idle - prev.idle;
      if (all > 0) last = Math.max(0, Math.min(100, Math.round((1 - idle / all) * 1000) / 10));
      prev = cur; at = now;
      return last;
    }
  };
}

export function readVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "unknown"; } catch { return "unknown"; }
}

function diskOf(dir) {
  try { const s = fs.statfsSync(dir); return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }; } catch { return null; }
}

// Every threshold is explicit so the warnings are explainable and testable.
export function evaluate(h) {
  const w = [];
  if (!h.database.ok) w.push({ level: "critical", code: "database", message: "The database did not answer a simple query." });
  if (h.disk) {
    const free = h.disk.freeBytes / h.disk.totalBytes;
    if (free < 0.05 || h.disk.freeBytes < 0.5 * GB) w.push({ level: "critical", code: "disk_full", message: "Less than 5% of the disk (or 0.5 GB) is free. Backups and the database may fail." });
    else if (free < 0.1 || h.disk.freeBytes < 2 * GB) w.push({ level: "warn", code: "disk_low", message: "Less than 10% of the disk (or 2 GB) is free." });
  }
  if (h.memory.totalBytes && h.memory.freeBytes / h.memory.totalBytes < 0.08) w.push({ level: "warn", code: "memory_low", message: "Less than 8% of memory is free." });
  if (h.backups.status === "none") w.push({ level: "warn", code: "backup_none", message: "No backup exists yet. Make one on the Data & backups page." });
  else if (h.backups.status === "stale") w.push({ level: "warn", code: "backup_stale", message: "The newest backup is older than expected. Check the server log for 'BACKUP FAILED'." });
  if (h.sync.queueDropped > 0) w.push({ level: "warn", code: "queue_overflow", message: h.sync.queueDropped + " playback event(s) were not queued by a device that stayed offline too long. They remain on that device." });
  if (h.sync.devicesWithErrors > 0) w.push({ level: "warn", code: "sync_errors", message: h.sync.devicesWithErrors + " device(s) reported a sync error." });
  return w;
}

export function collectHealth({ db, config = {}, hub = null, version = "unknown", startedAt = Date.now(), cpu = null, now = Date.now(), root = process.cwd() }) {
  let database = { ok: false, latencyMs: null, sizeBytes: null };
  try {
    const t = process.hrtime.bigint();
    db.prepare("SELECT 1").get();
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const pages = db.pragma("page_count", { simple: true }) * db.pragma("page_size", { simple: true });
    database = { ok: true, latencyMs: Math.round(ms * 100) / 100, sizeBytes: pages };
  } catch { /* reported as not ok */ }

  const devs = db.prepare("SELECT id,status,last_push_at,pending_count,last_error,queue_dropped FROM devices").all();
  const active = devs.filter(d => d.status === "active");
  const pushes = active.map(d => d.last_push_at).filter(Boolean);
  const bk = (() => { try { return listBackups(config.backupDir); } catch { return []; } })();
  const interval = config.backupIntervalHours === 0 ? 0 : Math.max(1, Number(config.backupIntervalHours) || 24); // 0 = scheduled backups are switched off
  const newest = bk[0] ? bk[0].createdAt : null;
  const backups = {
    count: bk.length, lastBackupAt: newest, ageHours: newest ? Math.round((now - newest) / 360000) / 10 : null,
    status: !bk.length ? "none" : interval && (now - newest) > (interval + 2) * 3600000 ? "stale" : "ok"
  };
  const h = {
    status: "ok", version, node: process.version, checkedAt: now, uptimeSec: Math.round(process.uptime()), startedAt,
    cpu: { cores: os.cpus().length, percent: cpu ? cpu.percent() : null, load: process.platform === "win32" ? null : os.loadavg().map(x => Math.round(x * 100) / 100) },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), processRssBytes: process.memoryUsage().rss },
    disk: diskOf(config.dbPath && config.dbPath !== ":memory:" ? path.dirname(path.resolve(config.dbPath)) : root),
    database,
    devices: { total: devs.length, active: active.length, pending: devs.filter(d => d.status === "pending").length, revoked: devs.filter(d => d.status === "revoked").length, online: hub ? active.filter(d => hub.isOnline(d.id)).length : 0 },
    sync: {
      devicesWithErrors: active.filter(d => d.last_error).length, queueDropped: active.reduce((a, d) => a + (d.queue_dropped || 0), 0), pendingUploads: active.reduce((a, d) => a + (d.pending_count || 0), 0),
      lastPushAt: pushes.length ? Math.max(...pushes) : null, oldestLastPushAt: pushes.length ? Math.min(...pushes) : null
    },
    backups,
    realtime: hub ? hub.stats() : null
  };
  h.warnings = evaluate(h);
  h.status = h.warnings.some(x => x.level === "critical") ? "critical" : h.warnings.length ? "warn" : "ok";
  return h;
}
