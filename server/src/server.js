import fs from "node:fs";
import { openDb, migrate } from "./db.js";
import { buildApp } from "./app.js";
import { purgeAll, expirePending, purgeHousekeeping } from "./lib/retention.js";
import { pruneAudit, purgeExpiredTokens } from "./lib/security.js";
import { createBackup, listBackups } from "./lib/backup.js";

const env = process.env;
const missing = ["COOKIE_SECRET", "MASTER_KEY", "BASE_URL", "ACCESS_TTL", "REFRESH_TTL"].filter(k => !env[k]);
if (missing.length) { console.error("Missing env: " + missing.join(", ") + " (see .env.example; start with `node --env-file=.env src/server.js`)"); process.exit(1); }
if (env.COOKIE_SECRET.length < 32) { console.error("COOKIE_SECRET must be at least 32 characters"); process.exit(1); }
if (Buffer.from(env.MASTER_KEY, "base64").length !== 32) { console.error("MASTER_KEY must be 32 bytes, base64-encoded"); process.exit(1); }

const prod = env.NODE_ENV === "production";
const hasTls = !!(env.TLS_CERT && env.TLS_KEY);
// HTTP is never served in production: either Fastify holds the certs, or a TLS proxy
// is declared (TRUST_PROXY=true) and we only listen on loopback behind it.
if (prod && !hasTls && env.TRUST_PROXY !== "true") {
  console.error("Production requires TLS_CERT/TLS_KEY, or TRUST_PROXY=true behind a TLS-terminating proxy.");
  process.exit(1);
}
if (prod && !env.BASE_URL.startsWith("https://")) { console.error("BASE_URL must be https:// in production"); process.exit(1); }

const dbPath = env.DB_PATH || "./data/tracker.db";
const config = { dbPath, backupDir: env.BACKUP_DIR || "./data/backups", backupKeep: Number(env.BACKUP_KEEP || 14), backupIntervalHours: Number(env.BACKUP_INTERVAL_HOURS || 24) };
const db = openDb(dbPath);
const applied = migrate(db);
if (applied.length) console.log("migrations applied: " + applied.join(", "));
if (!db.prepare("SELECT 1 FROM admins").get()) console.warn("No owner account yet. Create it with: node scripts/create-owner.js you@example.com");

// A crash or an unexpected rejection is logged, never silently swallowed.
process.on("unhandledRejection", e => console.error("unhandled rejection:", e));
process.on("uncaughtException", e => { console.error("uncaught exception:", e); process.exit(1); });

// Hourly housekeeping: retention, never-approved pairing requests, expired codes, old audit entries.
const housekeeping = () => { try { purgeAll(db); expirePending(db); purgeHousekeeping(db); pruneAudit(db); purgeExpiredTokens(db); } catch (e) { console.error("housekeeping failed", e); } };
housekeeping();
setInterval(housekeeping, 60 * 60 * 1000).unref();

// Scheduled backups (default every 24 h, keep the newest BACKUP_KEEP). One is taken at start-up if the newest is stale.
const backupEveryMs = Number(env.BACKUP_INTERVAL_HOURS || 24) * 3600 * 1000;
async function backupNow(why) {
  try { const r = await createBackup(db, config.backupDir, config.backupKeep); console.log(`backup (${why}) written: ${r.name}`); }
  catch (e) { console.error("BACKUP FAILED:", e.message); }
}
if (backupEveryMs > 0) {
  const newest = listBackups(config.backupDir)[0];
  if (!newest || Date.now() - newest.createdAt > backupEveryMs) await backupNow("startup");
  setInterval(() => backupNow("scheduled"), backupEveryMs).unref();
}

const https = hasTls ? { cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) } : null;
const app = await buildApp({ db, logger: true, https, config });
// Without certs we only bind loopback (dev, or behind a TLS-terminating proxy).
await app.listen({ port: Number(env.PORT || 8443), host: hasTls ? "0.0.0.0" : "127.0.0.1" });

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await app.close(); db.close(); process.exit(0); });
