// Takes a verified backup of the database right now (safe while the server is running).
//   node scripts/backup.js            uses DB_PATH, BACKUP_DIR, BACKUP_KEEP from the environment
import { openDb } from "../src/db.js";
import { createBackup, listBackups } from "../src/lib/backup.js";

const dbPath = process.env.DB_PATH || "./data/tracker.db";
const dir = process.env.BACKUP_DIR || "./data/backups";
const db = openDb(dbPath);
try {
  const r = await createBackup(db, dir, Number(process.env.BACKUP_KEEP || 14));
  console.log(`backup written: ${dir}/${r.name} (${r.size} bytes); ${listBackups(dir).length} kept`);
} catch (e) { console.error("backup failed: " + e.message); process.exitCode = 1; }
db.close();
