// Development only: seeds a RUNNING dev server with an owner and two approved devices holding sample data
// (one has a wrong clock, one has a hostile title) so the dashboard can be looked at.
//   DB_PATH=./data/dev.db node scripts/seed-dev.js [baseUrl]      (default http://127.0.0.1:8443)
// The owner credentials are throwaway values for local development; never use them on a real server.
// There is no registration endpoint, so the owner row is created straight in the database (same as scripts/create-owner.js).
import { openDb, migrate } from "../src/db.js";
import { createOwner } from "./create-owner.js";

export const DEV_OWNER = { email: "dev-owner@example.test", password: "dev-only-password-123" };

const base = process.argv[2] || "http://127.0.0.1:8443";
const DAY = 86400000, HOUR = 3600000;

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookies: res.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") };
}

if (process.argv[1] && process.argv[1].endsWith("seed-dev.js")) {
  const db = openDb(process.env.DB_PATH || "./data/dev.db");
  migrate(db);
  if (!db.prepare("SELECT 1 FROM admins").get()) await createOwner(db, DEV_OWNER.email, DEV_OWNER.password);
  db.close();
  const login = await call("POST", "/api/auth/login", DEV_OWNER);
  if (login.status !== 200) { console.error("login failed (" + login.status + "): is a different owner set up in this database?"); process.exit(1); }
  const owner = { cookie: login.cookies };

  const titles = [
    ["aaaaaaaaaaa", "Learning Rust in one hour", "Code Channel", 3600],
    ["bbbbbbbbbbb", "Lo-fi beats to study to", "Chill Radio", 7200],
    ["ccccccccccc", "<img src=x onerror=console.error('XSS-FIRED')> hostile title", "<b>Evil</b> Channel", 600],
    ["ddddddddddd", "Cooking pasta 101", "Kitchen Basics", 900]
  ];
  async function device(label, skewMs, offset) {
    const code = (await call("POST", "/api/devices/enroll-code", { label }, owner)).json.code;
    const j = (await call("POST", "/api/enroll", { code, installId: "seed-" + label, platform: "Win32" })).json;
    await call("POST", `/api/devices/${j.deviceId}/approve`, undefined, owner);
    const access = (await call("POST", "/api/device/token", undefined, { authorization: "Bearer " + j.refreshToken })).json.accessToken;
    const now = Date.now(), sessions = [];
    for (let d = 0; d < 30; d++) for (let i = 0; i < titles.length; i++) {
      if ((d + i + offset) % 3 === 2) continue;
      const [videoId, title, channel, duration] = titles[i];
      const startTs = now - d * DAY - (i + 1 + offset) * HOUR + skewMs, watchedMs = (5 + (d % 9) + i * 3 + offset * 2) * 60000;
      sessions.push({ sessionId: `${label.replace(/\W/g, "")}-${d}-${i}`, videoId, kind: "watch", url: "https://www.youtube.com/watch?v=" + videoId, title, channel, startTs, endTs: startTs + watchedMs, watchedMs, duration,
        startSec: 0, positionSec: Math.min(duration, Math.round(watchedMs / 1000)), furthestSec: Math.min(duration, Math.round(watchedMs / 1000)), seeks: d % 4, rewinds: d % 2, pauses: i, completed: watchedMs / 1000 >= duration * 0.9, rev: 3 });
    }
    const r = await call("POST", "/api/sync/push", { sessions, clientNow: Date.now() + skewMs, pending: 0, clientVersion: "0.4.0" }, { authorization: "Bearer " + access });
    console.log(label.padEnd(10), "device", j.deviceId, "upserted", r.json.upserted);
  }
  await device("Laptop 1", 0, 0);
  await device("Laptop 2", 3 * HOUR, 1); // its clock is three hours fast; the server corrects for it
}
