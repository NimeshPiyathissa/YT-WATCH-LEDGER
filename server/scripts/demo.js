// Self-enrolled local demo: one command, loopback only, throwaway data.
//   node scripts/demo.js            (PORT=8443 by default)
// Starts the server on 127.0.0.1 with a temporary database and fresh random secrets, creates a demo
// admin, and prints an enrollment code for YOUR OWN browser. Press Enter for a new code. Ctrl+C stops
// the server and deletes the temporary database, so nothing is left behind.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const port = Number(process.env.PORT || 8443);
const origin = `http://127.0.0.1:${port}`;
Object.assign(process.env, {
  NODE_ENV: "development", BASE_URL: origin, CORS_ORIGIN: origin, ALLOW_REGISTRATION: "false",
  COOKIE_SECRET: crypto.randomBytes(32).toString("hex"), MASTER_KEY: crypto.randomBytes(32).toString("base64"),
  ACCESS_TTL: "900", REFRESH_TTL: "2592000"
});
// config must be in place before the app modules read it
const { openDb, migrate } = await import("../src/db.js");
const { buildApp } = await import("../src/app.js");
const { DEV_ADMIN } = await import("./seed-dev.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-demo-"));
const db = openDb(path.join(dir, "demo.db"));
migrate(db);
const app = await buildApp({ db });
await app.listen({ port, host: "127.0.0.1" });

await app.inject({ method: "POST", url: "/api/auth/register", payload: DEV_ADMIN });
const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: DEV_ADMIN });
const cookie = login.cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
async function newCode() {
  const r = await app.inject({ method: "POST", url: "/api/devices/enroll-code", headers: { cookie }, payload: { label: "My own browser" } });
  return r.json().code;
}

console.log(`
  Watch Tracker - local demo (loopback only, data is deleted on exit)
  ---------------------------------------------------------------------
  Dashboard       ${origin}
  Demo admin      ${DEV_ADMIN.email} / ${DEV_ADMIN.password}   (throwaway, dev only)

  Enroll YOUR OWN browser:
    1. chrome://extensions -> Developer mode -> Load unpacked -> the yt-watch-tracker folder
    2. Extension popup -> Admin console -> Remote sync
    3. Server address: ${origin}      Enrollment code: ${await newCode()}   (valid 15 min)
    4. Play a YouTube video for a minute, then open the dashboard above and sign in.

  Press Enter for a new code, Ctrl+C to stop and delete everything.
`);

readline.createInterface({ input: process.stdin }).on("line", async () => console.log("  New enrollment code: " + await newCode()));
let closing = false;
async function stop() {
  if (closing) return; closing = true;
  await app.close(); db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\n  Stopped. Temporary data deleted.");
  process.exit(0);
}
process.on("SIGINT", stop); process.on("SIGTERM", stop);
