// Authorization sweep: every API route found in the source must refuse a caller with no credentials, and must refuse the
// wrong kind of credential (a device token on an owner route, an owner cookie on a device route). New routes are picked up
// automatically, so a route added without authentication fails this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeApp, addOwner, login, enrollDevice } from "./helpers.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
// Deliberately public: health check, owner sign-in/refresh/sign-out (they carry their own credential checks), pairing
// with a one-time code, the device credential exchange (401 without a credential), and the WebSocket (authenticates in its first message).
const PUBLIC = new Set(["GET /api/health", "POST /api/auth/login", "POST /api/auth/refresh", "POST /api/auth/logout", "POST /api/enroll", "POST /api/device/token", "GET /api/device/ws"]);

function routes() {
  const out = [];
  const files = [path.join(SRC, "app.js"), ...fs.readdirSync(path.join(SRC, "routes")).map(f => path.join(SRC, "routes", f))];
  for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/app\.(get|post|put|patch|delete)\(\s*"(\/api[^"]*)"/g)) out.push({ method: m[1].toUpperCase(), url: m[2] });
  return out;
}
const isDeviceRoute = r => r.url.startsWith("/api/sync/") || r.url.startsWith("/api/device/");

test("every API route is found (the sweep is not silently empty)", () => {
  const r = routes();
  assert.ok(r.length >= 42, "found " + r.length); // 42 routes when this was written; more is fine, fewer means discovery broke
  for (const must of ["POST /api/session-requests/:id/approve", "POST /api/session-requests/:id/deny", "GET /api/events", "POST /api/sessions/:id/revoke", "POST /api/device/session/deletion-request", "POST /api/pairing-codes/:id/revoke"])
    assert.ok(r.some(x => x.method + " " + x.url === must), must);
});

test("no credentials: every non-public route answers 401", async () => {
  const { app } = await makeApp(), bad = [];
  for (const r of routes()) {
    if (PUBLIC.has(r.method + " " + r.url)) continue;
    const res = await app.inject({ method: r.method, url: r.url.replace(/:\w+/g, "x"), payload: r.method === "GET" ? undefined : {} });
    if (res.statusCode !== 401) bad.push(`${r.method} ${r.url} -> ${res.statusCode}`);
  }
  assert.deepEqual(bad, []);
});

test("the wrong kind of credential is refused: device token on owner routes, owner cookie on device routes", async () => {
  const { app, db } = await makeApp(); await addOwner(db);
  const cookie = await login(app), dev = await enrollDevice(app, cookie, "Sweep device"), bad = [];
  for (const r of routes()) {
    if (PUBLIC.has(r.method + " " + r.url)) continue;
    const url = r.url.replace(/:\w+/g, "x"), payload = r.method === "GET" ? undefined : {};
    const res = await app.inject({ method: r.method, url, payload, headers: isDeviceRoute(r) ? { cookie } : dev.auth });
    if (res.statusCode !== 401) bad.push(`${isDeviceRoute(r) ? "owner cookie on" : "device token on"} ${r.method} ${r.url} -> ${res.statusCode}`);
  }
  assert.deepEqual(bad, []);
});

test("a revoked session's old access token is refused on every device route", async () => {
  const { app, db } = await makeApp(); await addOwner(db);
  const cookie = await login(app), dev = await enrollDevice(app, cookie, "To revoke"), bad = [];
  await app.inject({ method: "POST", url: `/api/sessions/${dev.sessionId}/revoke`, headers: { cookie } });
  for (const r of routes().filter(isDeviceRoute)) {
    if (PUBLIC.has(r.method + " " + r.url)) continue;
    const res = await app.inject({ method: r.method, url: r.url, payload: r.method === "GET" ? undefined : {}, headers: dev.auth });
    if (res.statusCode !== 403) bad.push(`${r.method} ${r.url} -> ${res.statusCode}`);
  }
  assert.deepEqual(bad, []);
});
