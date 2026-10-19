// Restores the database from a backup file. OFFLINE: stop the server first.
//   node scripts/restore.js ./data/backups/tracker-20260101T020000Z.db --yes
// The backup is integrity-checked first, and the current database is copied aside (<db>.pre-restore-<time>) before it is replaced.
import { restoreBackup, listBackups } from "../src/lib/backup.js";

const args = process.argv.slice(2), file = args.find(a => !a.startsWith("--"));
const dbPath = process.env.DB_PATH || "./data/tracker.db";
if (!file) {
  console.error("usage: node scripts/restore.js <backup file> --yes\n\navailable backups:");
  for (const b of listBackups(process.env.BACKUP_DIR || "./data/backups")) console.error("  " + b.name + "  " + new Date(b.createdAt).toISOString());
  process.exit(1);
}
if (!args.includes("--yes")) { console.error(`This replaces ${dbPath} with ${file}. Stop the server, then re-run with --yes.`); process.exit(1); }
try {
  const r = restoreBackup(file, dbPath);
  console.log(`restored ${file} -> ${r.restoredTo}` + (r.safetyCopy ? `\nprevious database kept at ${r.safetyCopy}` : ""));
  console.log("Start the server; migrations run automatically if the backup is from an older version.");
} catch (e) { console.error("restore failed: " + e.message); process.exit(1); }
