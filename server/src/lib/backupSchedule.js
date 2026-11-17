// Scheduled backups. The server calls runDueBackup() on a short timer; whether one is due is decided from the CURRENT settings every time,
// so changing the interval in Settings Studio takes effect on the next check with no restart.
import { createBackup, listBackups } from "./backup.js";

const HOUR = 3600000;

export function intervalHours(config) {
  if (config.backupIntervalHours === 0) return 0;                       // scheduled backups switched off
  const n = Number(config.backupIntervalHours);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 24;
}

// Makes a backup when none exists or the newest is older than the interval. Never throws: a failure is returned for the caller to log.
export async function runDueBackup(db, config, now = Date.now()) {
  try {
    const every = intervalHours(config);
    if (!every) return { ran: false, reason: "off" };
    const newest = listBackups(config.backupDir)[0];
    if (newest && now - newest.createdAt < every * HOUR) return { ran: false, reason: "not_due" };
    const r = await createBackup(db, config.backupDir, config.backupKeep);
    return { ran: true, name: r.name };
  } catch (e) { return { ran: false, error: String(e && e.message || e) }; }
}
