// SQLite backups and restore. Backups use SQLite's online backup API, so they are consistent even while the server runs.
// Watch records inside a backup are still AES-256-GCM ciphertext (MASTER_KEY); keep the key separate from the backups.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const NAME_RE = /^tracker-(\d{8}T\d{6})(\d{3})?Z(?:-(\d+))?\.db$/;
// Chronological key. Plain string order is wrong: "...Z-2.db" sorts before "...Z.db" although it is newer.
const sortKey = n => { const m = NAME_RE.exec(n); return m[1] + (m[2] || "000") + String(m[3] || 1).padStart(6, "0"); };

export function checkIntegrity(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const r = db.pragma("integrity_check", { simple: true });
    const hasSchema = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='devices'").get();
    return r === "ok" && hasSchema;
  } finally { db.close(); }
}

export function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => NAME_RE.test(n)).sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1)).map(n => {
    const st = fs.statSync(path.join(dir, n));
    return { name: n, size: st.size, createdAt: st.mtimeMs };
  });
}

// Creates a verified backup and prunes to the newest `keep` files. Never leaves a partial or unverified file behind.
export async function createBackup(db, dir, keep = 14, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  // Within one second, number after the highest existing sequence (not the first free name), so a new
  // backup always sorts newest even after pruning has removed the unsuffixed one.
  const same = listBackups(dir).map(b => b.name).filter(x => x.startsWith(`tracker-${stamp}`));
  const n = same.length ? Math.max(...same.map(x => Number(NAME_RE.exec(x)[3] || 1))) + 1 : 1;
  const name = n === 1 ? `tracker-${stamp}.db` : `tracker-${stamp}-${n}.db`;
  const dest = path.join(dir, name), tmp = dest + ".partial";
  try {
    await db.backup(tmp);
    // A backup of a WAL database inherits WAL mode, and opening it would leave -wal/-shm sidecars named after the
    // temp file. Make it a single self-contained file first, so nothing is left behind.
    const t = new Database(tmp);
    try { t.pragma("journal_mode = DELETE"); } finally { t.close(); }
    if (!checkIntegrity(tmp)) throw new Error("backup failed integrity check");
    fs.renameSync(tmp, dest);
    try { fs.chmodSync(dest, 0o600); } catch { /* not supported on every platform */ }
  } catch (e) { for (const x of ["", "-wal", "-shm"]) fs.rmSync(tmp + x, { force: true }); throw e; }
  const all = listBackups(dir);
  for (const old of all.slice(Math.max(keep, 1))) fs.rmSync(path.join(dir, old.name), { force: true });
  return { name, size: fs.statSync(dest).size };
}

// OFFLINE operation: stop the server first. Verifies the backup, keeps a copy of the current database, then replaces it.
export function restoreBackup(backupFile, dbPath, now = Date.now()) {
  if (!fs.existsSync(backupFile)) throw new Error("backup file not found");
  if (!checkIntegrity(backupFile)) throw new Error("backup failed its integrity check; refusing to restore");
  let safety = null;
  if (fs.existsSync(dbPath)) { safety = `${dbPath}.pre-restore-${now}`; fs.copyFileSync(dbPath, safety); }
  for (const ext of ["-wal", "-shm"]) fs.rmSync(dbPath + ext, { force: true }); // stale journal files must not be replayed onto the restored DB
  fs.copyFileSync(backupFile, dbPath);
  return { restoredTo: dbPath, safetyCopy: safety };
}
