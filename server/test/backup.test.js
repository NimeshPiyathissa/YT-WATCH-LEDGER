import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, migrate } from "../src/db.js";
import { createBackup, restoreBackup, listBackups, checkIntegrity } from "../src/lib/backup.js";
import { uuid } from "../src/lib/crypto.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "yt-bk-")); }
function seededDb(dir) {
  const file = path.join(dir, "tracker.db");
  const db = openDb(file);
  migrate(db);
  const admin = uuid();
  db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES (?,?,?,?)").run(admin, "o@example.com", "x", 1);
  for (let i = 0; i < 3; i++) db.prepare("INSERT INTO devices(id,admin_id,label,status,enrolled_at) VALUES (?,?,?,?,?)").run(uuid(), admin, "Device " + i, "active", 1);
  return { db, file };
}
const count = (db, t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

test("a backup is a consistent, verified copy that opens as a normal database", async () => {
  const dir = tmp(), { db } = seededDb(dir);
  const r = await createBackup(db, path.join(dir, "bk"), 5);
  assert.match(r.name, /^tracker-\d{8}T\d{6}Z\.db$/);
  assert.ok(r.size > 0);
  const file = path.join(dir, "bk", r.name);
  assert.equal(checkIntegrity(file), true);
  const copy = openDb(file);
  assert.equal(count(copy, "devices"), 3);
  copy.close(); db.close();
});

test("backups are pruned to the newest N, and a failed backup leaves nothing partial behind", async () => {
  const dir = tmp(), { db } = seededDb(dir), bk = path.join(dir, "bk");
  for (let i = 0; i < 5; i++) await createBackup(db, bk, 3, new Date(Date.UTC(2026, 0, 1 + i, 2)));
  assert.deepEqual(listBackups(bk).map(b => b.name), ["tracker-20260105T020000Z.db", "tracker-20260104T020000Z.db", "tracker-20260103T020000Z.db"]);
  db.close();
  await assert.rejects(createBackup(db, bk, 3), "a closed database cannot be backed up");
  assert.deepEqual(fs.readdirSync(bk).filter(n => n.endsWith(".partial")), []);
  assert.equal(listBackups(bk).length, 3, "existing backups untouched by the failure");
});

test("backing up a WAL database leaves exactly one self-contained file per backup (no -wal/-shm litter)", async () => {
  const dir = tmp(), { db } = seededDb(dir), bk = path.join(dir, "bk");
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal", "the server runs in WAL mode");
  for (let i = 0; i < 3; i++) await createBackup(db, bk, 5, new Date(Date.UTC(2026, 0, 1 + i, 2)));
  const files = fs.readdirSync(bk);
  assert.equal(files.length, 3, "only the backups themselves: " + files.join(", "));
  assert.ok(files.every(n => /^tracker-\d{8}T\d{6}Z\.db$/.test(n)));
  // ...and each one restores on its own, with no sidecar files.
  const live = path.join(dir, "restored.db");
  restoreBackup(path.join(bk, files.sort()[0]), live);
  const copy = openDb(live); assert.equal(count(copy, "devices"), 3); copy.close(); db.close();
});

test("two backups in the same second do not overwrite each other", async () => {
  const dir = tmp(), { db } = seededDb(dir), bk = path.join(dir, "bk"), at = new Date(Date.UTC(2026, 0, 1, 2));
  const a = await createBackup(db, bk, 5, at), b = await createBackup(db, bk, 5, at);
  assert.notEqual(a.name, b.name);
  assert.equal(listBackups(bk).length, 2);
  db.close();
});

test("backups taken across a clock-second boundary list newest first and pruning keeps the newest (fixed clock, no timing luck)", async () => {
  const dir = tmp(), { db } = seededDb(dir), bk = path.join(dir, "bk");
  const t1 = new Date("2026-11-02T10:00:00Z"), t2 = new Date("2026-11-02T10:00:01Z");
  const made = [];
  for (const t of [t1, t1, t2, t2, t2]) made.push((await createBackup(db, bk, 3, t)).name); // two in one second, three in the next
  assert.deepEqual(made, ["tracker-20261102T100000Z.db", "tracker-20261102T100000Z-2.db", "tracker-20261102T100001Z.db", "tracker-20261102T100001Z-2.db", "tracker-20261102T100001Z-3.db"]);
  const listed = listBackups(bk).map(b => b.name);
  assert.deepEqual(listed, made.slice(-3).reverse(), "chronological, newest first");
  // The trap this guards against: as plain strings the newest ("...Z-3.db") sorts BEFORE the oldest kept ("...Z.db").
  assert.equal(listed[0] > listed[2], false, "alphabetical order is NOT chronological order here, so code and tests must not use it");
  db.close();
});

test("restore brings back the data as it was at backup time and keeps a safety copy of what it replaced", async () => {
  const dir = tmp(), { db, file } = seededDb(dir), bk = path.join(dir, "bk");
  const { name } = await createBackup(db, bk, 5);
  db.prepare("DELETE FROM devices").run(); // disaster
  assert.equal(count(db, "devices"), 0);
  db.close();

  const r = restoreBackup(path.join(bk, name), file);
  assert.ok(r.safetyCopy && fs.existsSync(r.safetyCopy), "the damaged database is kept, not destroyed");
  const restored = openDb(file);
  assert.equal(count(restored, "devices"), 3);
  assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
  restored.close();
  const safety = openDb(r.safetyCopy);
  assert.equal(count(safety, "devices"), 0, "safety copy is the pre-restore state");
  safety.close();
});

test("restore refuses a corrupt or missing backup and leaves the current database alone", async () => {
  const dir = tmp(), { db, file } = seededDb(dir);
  db.close();
  const junk = path.join(dir, "junk.db");
  fs.writeFileSync(junk, "this is not a sqlite database at all");
  assert.throws(() => restoreBackup(junk, file));
  assert.throws(() => restoreBackup(path.join(dir, "missing.db"), file), /not found/);
  const still = openDb(file);
  assert.equal(count(still, "devices"), 3);
  still.close();
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes("pre-restore")), [], "no safety copy made when nothing was replaced");
});

test("restoring onto a database with stale WAL files does not resurrect them", async () => {
  const dir = tmp(), { db, file } = seededDb(dir), bk = path.join(dir, "bk");
  const { name } = await createBackup(db, bk, 5);
  db.prepare("INSERT INTO settings(key,value) VALUES ('x','1')").run(); // lands in the WAL
  assert.ok(fs.existsSync(file + "-wal"));
  db.close();
  fs.writeFileSync(file + "-wal", Buffer.alloc(64, 1)); // simulate stale journal bytes
  restoreBackup(path.join(bk, name), file);
  assert.ok(!fs.existsSync(file + "-wal") || fs.statSync(file + "-wal").size === 0);
  const r = openDb(file);
  assert.equal(count(r, "settings"), 0, "the post-backup write is gone, as expected for a restore");
  assert.equal(r.pragma("integrity_check", { simple: true }), "ok");
  r.close();
});

test("restoring an older backup and starting the server upgrades it by running the missing migrations", async () => {
  const dir = tmp(), file = path.join(dir, "old.db");
  const old = openDb(file);
  old.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  old.close();
  // simulate a v1-era database: apply only the first migration by hand
  const { default: fsx } = await import("node:fs");
  const first = fsx.readFileSync(new URL("../migrations/001_init.sql", import.meta.url), "utf8");
  const db1 = openDb(file);
  db1.exec(first);
  db1.prepare("INSERT INTO schema_migrations(name,applied_at) VALUES ('001_init.sql',1)").run();
  db1.close();
  const db2 = openDb(file);
  assert.deepEqual(migrate(db2), ["002_retention.sql", "003_single_owner_pairing.sql", "004_device_sessions.sql", "005_device_config.sql"]);
  assert.ok(db2.prepare("SELECT 1 FROM sqlite_master WHERE name='settings'").get());
  db2.close();
});
