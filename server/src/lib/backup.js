// SQLite backups and restore. Backups use SQLite's online backup API, so they are consistent even while the server runs.
// Watch records inside a backup are still AES-256-GCM ciphertext (MASTER_KEY); keep the key separate from the backups.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { knownMigrations } from "../db.js";
import { decryptJSON } from "./crypto.js";

const NAME_RE = /^tracker-(\d{8}T\d{6})(\d{3})?Z(?:-(\d+))?\.db$/;
export const isBackupName = n => typeof n === "string" && NAME_RE.test(n);
// Chronological key. Plain string order is wrong: "...Z-2.db" sorts before "...Z.db" although it is newer.
const sortKey = n => { const m = NAME_RE.exec(n); return m[1] + (m[2] || "000") + String(m[3] || 1).padStart(6, "0"); };
const sha256File = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
// A .partial left by a crash is only swept once it is this old, so a backup that is running right now is never touched.
const STALE_PARTIAL_MS = 60 * 60 * 1000;

export function checkIntegrity(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const r = db.pragma("integrity_check", { simple: true });
    const hasSchema = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='devices'").get();
    return r === "ok" && hasSchema;
  } finally { db.close(); }
}

// Everything worth knowing about a backup before trusting it, without changing it:
//   integrity   SQLite's own check passes and the Watch Ledger tables exist
//   schema      "current" | "older" (the missing migrations run at start) | "newer" (made by a later release: refuse) | "unknown"
//   keyOk       true / false: sampled records decrypt with this server's MASTER_KEY; null: the backup holds no encrypted records yet
//   restorable  integrity, and not newer, and the key is not known to be wrong
export function inspectBackup(file) {
  const r = { file: path.basename(file), size: 0, sha256: null, integrity: false, schema: { state: "unknown", missing: [], unknown: [] }, keyOk: null, counts: null, restorable: false, problems: [] };
  let db;
  try {
    r.size = fs.statSync(file).size; r.sha256 = sha256File(file);
    db = new Database(file, { readonly: true, fileMustExist: true });
    r.integrity = db.pragma("integrity_check", { simple: true }) === "ok" && !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='devices'").get();
    if (!r.integrity) { r.problems.push("not a healthy Watch Ledger database"); return r; }
    const has = n => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(n);
    if (has("schema_migrations")) {
      const applied = new Set(db.prepare("SELECT name FROM schema_migrations").all().map(x => x.name)), known = knownMigrations();
      r.schema.unknown = [...applied].filter(n => !known.includes(n)).sort();
      r.schema.missing = known.filter(n => !applied.has(n));
      r.schema.state = r.schema.unknown.length ? "newer" : r.schema.missing.length ? "older" : "current";
    }
    if (r.schema.state === "newer") r.problems.push("made by a newer release (" + r.schema.unknown.join(", ") + "); upgrade this server first");
    if (r.schema.state === "unknown") r.problems.push("no migration history");
    r.counts = { devices: db.prepare("SELECT COUNT(*) n FROM devices").get().n, sessions: has("sessions") ? db.prepare("SELECT COUNT(*) n FROM sessions").get().n : 0 };
    let sampled = 0, bad = 0;
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x => x.name)) {
      if (!db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === "enc")) continue;
      for (const row of db.prepare(`SELECT enc FROM "${t}" LIMIT 3`).all()) { sampled++; try { decryptJSON(row.enc); } catch { bad++; } }
    }
    if (sampled) r.keyOk = bad === 0;
    if (r.keyOk === false) r.problems.push("records in this backup cannot be decrypted with this server's MASTER_KEY");
    r.restorable = r.schema.state !== "newer" && r.schema.state !== "unknown" && r.keyOk !== false;
  } catch (e) { r.problems.push("cannot be read: " + e.message); r.integrity = false; r.restorable = false; }
  finally { try { if (db) db.close(); } catch { /* already closed */ } }
  return r;
}

export function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => NAME_RE.test(n)).sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1)).map(n => {
    const st = fs.statSync(path.join(dir, n));
    return { name: n, size: st.size, createdAt: st.mtimeMs };
  });
}

// Removes what a crashed backup left behind (<name>.partial and its -wal/-shm/-journal), but only when it is old.
export function sweepPartials(dir, now = Date.now()) {
  const gone = [];
  for (const n of fs.readdirSync(dir)) {
    if (!/^tracker-.*\.partial(-wal|-shm|-journal)?$/.test(n)) continue;
    try { if (now - fs.statSync(path.join(dir, n)).mtimeMs > STALE_PARTIAL_MS) { fs.rmSync(path.join(dir, n), { force: true }); gone.push(n); } } catch { /* raced with its owner */ }
  }
  return gone;
}

// Creates a verified backup and prunes to the newest `keep` files. Never leaves a partial or unverified file behind.
export async function createBackup(db, dir, keep = 14, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  sweepPartials(dir);
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

// OFFLINE operation: stop the server first. Order matters, so that a failure at any point leaves a usable database:
//   1. inspect the backup (integrity, not from a newer release, readable with this MASTER_KEY) and refuse if it is not safe
//   2. keep what is there now, INCLUDING writes that only exist in its -wal file (VACUUM INTO reads them; a plain file copy would not)
//   3. write the backup next to the database under a temporary name, check the copy, then rename it into place
// A copy that fails part-way (disk full) therefore never touches the live database. opts: { allowWrongKey, copy(src, dest) }.
export function restoreBackup(backupFile, dbPath, now = Date.now(), opts = {}) {
  if (!fs.existsSync(backupFile)) throw new Error("backup file not found");
  const info = inspectBackup(backupFile);
  if (!info.integrity) throw new Error("backup failed its integrity check; refusing to restore");
  if (info.schema.state === "newer") throw new Error("backup was made by a newer release (" + info.schema.unknown.join(", ") + "); upgrade this server before restoring it");
  if (info.schema.state === "unknown") throw new Error("backup has no migration history; refusing to restore");
  if (info.keyOk === false && !opts.allowWrongKey) throw new Error("backup records cannot be decrypted with this server's MASTER_KEY; restore the matching key first (or pass allowWrongKey to override)");
  const copy = opts.copy || ((s, d) => fs.copyFileSync(s, d));
  const tmp = `${dbPath}.restoring-${now}`;
  let safety = null;
  try {
    if (fs.existsSync(dbPath)) {
      safety = `${dbPath}.pre-restore-${now}`;
      try {
        const cur = new Database(dbPath, { readonly: true, fileMustExist: true });
        try { cur.exec(`VACUUM INTO '${safety.replace(/'/g, "''")}'`); } finally { cur.close(); }
      } catch { // the live file is too damaged to read: keep the raw files instead, so nothing is lost
        fs.rmSync(safety, { force: true });
        fs.copyFileSync(dbPath, safety);
        for (const ext of ["-wal", "-shm"]) if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, safety + ext);
      }
    }
    copy(backupFile, tmp);
    if (sha256File(tmp) !== info.sha256 || !checkIntegrity(tmp)) throw new Error("the copy written for the restore does not match the backup; nothing was replaced");
    for (const ext of ["-wal", "-shm"]) fs.rmSync(dbPath + ext, { force: true }); // stale journal files must not be replayed onto the restored DB
    fs.renameSync(tmp, dbPath);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  return { restoredTo: dbPath, safetyCopy: safety, verified: checkIntegrity(dbPath), schema: info.schema.state, keyOk: info.keyOk };
}
