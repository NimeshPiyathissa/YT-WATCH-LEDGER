// Backup Manager regressions (BUG_FIX_REPORT A8-A11): interrupted writes, schema compatibility, wrong-key backups, and a restore that
// must never leave the live database half-replaced or lose what the server had not yet checkpointed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as B from "../src/lib/backup.js";
import { openDb, migrate, knownMigrations } from "../src/db.js";
import { uuid, encryptJSON } from "../src/lib/crypto.js";
import "./env.js";
import { tmpDir } from "./tmpdir.js";

const tmp = () => tmpDir("yt-bki-");
function seeded(dir, name = "tracker.db") {
  const file = path.join(dir, name), db = openDb(file); migrate(db);
  const admin = uuid(), dev = uuid();
  db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES (?,?,?,?)").run(admin, "o@example.com", "x", 1);
  db.prepare("INSERT INTO devices(id,admin_id,label,status,enrolled_at) VALUES (?,?,?,?,?)").run(dev, admin, "Laptop", "active", 1);
  db.prepare("INSERT INTO videos(device_id,video_id,enc,last_watched,updated_at) VALUES (?,?,?,?,?)").run(dev, "v1", encryptJSON({ title: "x" }), 1, 1);
  return { db, file, dev };
}
const devices = f => { const d = openDb(f); try { return d.prepare("SELECT COUNT(*) n FROM devices").get().n; } finally { d.close(); } };

test("A8: a backup interrupted by a crash leaves a .partial file; the next backup sweeps stale ones and keeps recent ones", async () => {
  const dir = tmp(), { db } = seeded(dir), bk = path.join(dir, "bk"); fs.mkdirSync(bk);
  const old = path.join(bk, "tracker-20260101T000000Z.db.partial"), oldWal = old + "-wal", recent = path.join(bk, "tracker-20260102T000000Z.db.partial");
  for (const f of [old, oldWal, recent]) fs.writeFileSync(f, "half");
  const past = new Date(Date.now() - 3 * 3600 * 1000); fs.utimesSync(old, past, past); fs.utimesSync(oldWal, past, past);
  await B.createBackup(db, bk, 5);
  assert.equal(fs.existsSync(old), false, "stale partial removed");
  assert.equal(fs.existsSync(oldWal), false, "its sidecar too");
  assert.equal(fs.existsSync(recent), true, "a partial that may belong to a running backup is left alone");
  assert.equal(B.listBackups(bk).length, 1, "partial files are never listed as backups");
  db.close();
});

test("A9: a backup made by a NEWER release is refused, and the live database is untouched", async () => {
  const dir = tmp(), { db } = seeded(dir, "a.db"), bk = path.join(dir, "bk");
  const { name } = await B.createBackup(db, bk, 5);
  const f = path.join(bk, name), x = openDb(f); x.prepare("INSERT INTO schema_migrations(name,applied_at) VALUES ('099_from_the_future.sql',1)").run(); x.close(); db.close();
  const live = path.join(dir, "live.db"), l = seeded(dir, "live.db"); l.db.close();
  const info = B.inspectBackup(f);
  assert.equal(info.schema.state, "newer"); assert.deepEqual(info.schema.unknown, ["099_from_the_future.sql"]); assert.equal(info.restorable, false);
  assert.throws(() => B.restoreBackup(f, live), /newer/i);
  assert.equal(devices(live), 1);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes("pre-restore") || n.includes("restoring")), []);
});

test("A9b: an older backup is accepted and reported as needing migration", async () => {
  const dir = tmp(), file = path.join(dir, "old.db"), db = openDb(file);
  db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  migrate(db, { upTo: "005_device_config.sql" }); db.close();
  const info = B.inspectBackup(file);
  assert.equal(info.schema.state, "older"); assert.deepEqual(info.schema.missing, knownMigrations().filter(n => n > "005_device_config.sql")); assert.equal(info.restorable, true);
});

test("A10: a backup whose records cannot be decrypted with this server's key is refused (restoring it would look fine and show nothing)", async () => {
  const dir = tmp(), { db, dev } = seeded(dir, "k.db"), bk = path.join(dir, "bk");
  const other = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", other, iv);
  const ct = Buffer.concat([c.update("{}"), c.final()]);
  db.prepare("UPDATE videos SET enc=? WHERE device_id=?").run(Buffer.concat([iv, c.getAuthTag(), ct]), dev);
  const { name } = await B.createBackup(db, bk, 5); db.close();
  const info = B.inspectBackup(path.join(bk, name));
  assert.equal(info.keyOk, false); assert.equal(info.restorable, false);
  const live = path.join(dir, "live.db"), l = seeded(dir, "live.db"); l.db.close();
  assert.throws(() => B.restoreBackup(path.join(bk, name), live), /key/i);
  assert.equal(devices(live), 1);
  B.restoreBackup(path.join(bk, name), live, Date.now(), { allowWrongKey: true }); // the owner can still override on purpose
});

test("A10b: a backup with no encrypted records yet reports the key as unchecked, not wrong", async () => {
  const dir = tmp(), file = path.join(dir, "e.db"), db = openDb(file); migrate(db);
  db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES (?,?,?,?)").run(uuid(), "o@example.com", "x", 1);
  db.pragma("journal_mode = DELETE"); db.close();
  const info = B.inspectBackup(file); assert.equal(info.keyOk, null); assert.equal(info.restorable, true);
});

test("A11: a restore that fails part-way never leaves the live database half-written", async () => {
  const dir = tmp(), { db } = seeded(dir, "a.db"), bk = path.join(dir, "bk");
  const { name } = await B.createBackup(db, bk, 5); db.close();
  const live = path.join(dir, "live.db"), l = seeded(dir, "live.db"); l.db.prepare("DELETE FROM videos").run(); l.db.close();
  const before = crypto.createHash("sha256").update(fs.readFileSync(live)).digest("hex");
  const failing = (src, dest) => { fs.writeFileSync(dest, fs.readFileSync(src).subarray(0, 100)); throw new Error("ENOSPC: no space left on device"); };
  assert.throws(() => B.restoreBackup(path.join(bk, name), live, Date.now(), { copy: failing }), /ENOSPC/);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(live)).digest("hex"), before, "live database byte-for-byte unchanged");
  assert.deepEqual(fs.readdirSync(dir).filter(n => /restoring|partial/.test(n)), [], "no temporary file left");
});

test("A12: the safety copy keeps writes the server had not yet checkpointed (they live only in the -wal file after a crash)", async () => {
  const dir = tmp(), { db } = seeded(dir, "a.db"), bk = path.join(dir, "bk");
  const { name } = await B.createBackup(db, bk, 5); db.close();
  const live = path.join(dir, "live.db"), l = seeded(dir, "live.db");
  l.db.pragma("wal_autocheckpoint = 0");
  l.db.prepare("INSERT INTO settings(key,value) VALUES ('only-in-wal','1')").run(); // a "crashed" server: connection never closed, WAL not merged
  // What a crashed server leaves on disk: the database file plus a -wal holding the newest writes. (Snapshotted, because on Windows
  // the still-open connection would stop the restore from deleting that -wal; in real use the server is stopped.)
  const crashed = path.join(dir, "crashed.db"); fs.copyFileSync(live, crashed); fs.copyFileSync(live + "-wal", crashed + "-wal");
  l.db.close();
  const r = B.restoreBackup(path.join(bk, name), crashed);
  const safety = openDb(r.safetyCopy);
  assert.equal(safety.prepare("SELECT value FROM settings WHERE key='only-in-wal'").get()?.value, "1");
  safety.close();
});

test("a restore is verified after it is written, and the result opens", async () => {
  const dir = tmp(), { db } = seeded(dir, "a.db"), bk = path.join(dir, "bk");
  const { name } = await B.createBackup(db, bk, 5); db.close();
  const live = path.join(dir, "live.db"); const r = B.restoreBackup(path.join(bk, name), live);
  assert.equal(r.verified, true); assert.equal(devices(live), 1);
  assert.deepEqual(fs.readdirSync(dir).filter(n => /restoring/.test(n)), []);
});
