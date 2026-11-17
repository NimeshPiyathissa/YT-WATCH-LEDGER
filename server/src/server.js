import fs from "node:fs";
import { openDb, migrate } from "./db.js";
import { buildApp } from "./app.js";
import { runHousekeeping } from "./lib/housekeeping.js";
import { runDueBackup } from "./lib/backupSchedule.js";
import { readSettings } from "./lib/settings.js";

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
const config = { dbPath, backupDir: env.BACKUP_DIR || "./data/backups", backupKeep: 14, backupIntervalHours: 24 }; // the two numbers are filled in below from the owner's settings, the environment, or the defaults
const db = openDb(dbPath);
const applied = migrate(db);
if (applied.length) console.log("migrations applied: " + applied.join(", "));
if (!db.prepare("SELECT 1 FROM admins").get()) console.warn("No owner account yet. Create it with: node scripts/create-owner.js you@example.com");

// A crash or an unexpected rejection is logged, never silently swallowed.
process.on("unhandledRejection", e => console.error("unhandled rejection:", e));
process.on("uncaughtException", e => { console.error("uncaught exception:", e); process.exit(1); });

// Settings: the owner's saved values, then the environment (when valid), then the defaults. A bad value in the environment is reported, never silently turned into something harmful.
{
  const s = readSettings(db);
  for (const w of s.warnings) console.warn("settings: " + w);
}
// Hourly housekeeping: retention, never-approved pairing requests, expired codes, the audit log and notifications, all with the owner's limits.
const housekeeping = () => { try { runHousekeeping(db); } catch (e) { console.error("housekeeping failed", e); } };
housekeeping();
setInterval(housekeeping, 60 * 60 * 1000).unref();

const https = hasTls ? { cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) } : null;
const app = await buildApp({ db, logger: true, https, config });
// Without certs we only bind loopback (dev, or behind a TLS-terminating proxy).
await app.listen({ port: Number(env.PORT || 8443), host: hasTls ? "0.0.0.0" : "127.0.0.1" });

// Scheduled backups: every ten minutes the server asks whether one is due under the CURRENT settings (interval and keep count come from
// Settings Studio, so a change applies at once). One is taken at start-up if the newest is stale. 0 hours switches them off.
async function backupCheck(why) {
  const r = await runDueBackup(db, app.wlConfig);
  if (r.ran) console.log(`backup (${why}) written: ${r.name}`);
  else if (r.error) console.error("BACKUP FAILED:", r.error);
}
await backupCheck("startup");
setInterval(() => backupCheck("scheduled"), 10 * 60 * 1000).unref();

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await app.close(); db.close(); process.exit(0); });
