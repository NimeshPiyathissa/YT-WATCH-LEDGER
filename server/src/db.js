// SQLite access. Swap this module to move to Postgres; routes only use prepare/get/all/run/transaction.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function openDb(file = ":memory:") {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  return db;
}

// Applies any unapplied migrations/*.sql in filename order; returns the names applied.
export function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set(db.prepare("SELECT name FROM schema_migrations").all().map(r => r.name));
  const applied = [];
  for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations(name,applied_at) VALUES (?,?)").run(f, Date.now());
    })();
    applied.push(f);
  }
  return applied;
}
