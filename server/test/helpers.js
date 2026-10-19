import "./env.js";
import argon2 from "argon2";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, migrate } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { uuid } from "../src/lib/crypto.js";

export const PW = "correct horse battery staple";
export const OWNER = "owner@example.com";

export async function makeApp() {
  const db = openDb(); // in-memory SQLite
  migrate(db);
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-test-bk-"));
  const app = await buildApp({ db, config: { backupDir, backupKeep: 3 } });
  await app.ready();
  return { app, db, backupDir };
}

// The single owner account (the database refuses a second one).
export async function addOwner(db, email = OWNER, password = PW) {
  const id = uuid();
  db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES (?,?,?,?)").run(id, email, await argon2.hash(password), Date.now());
  return id;
}

// Serialises Set-Cookie headers from an inject() response into a Cookie header value.
export const cookieHeader = res => res.cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
export const cookieNamed = (res, name) => res.cookies.find(c => c.name === name);

export async function login(app, email = OWNER, password = PW) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error("login failed: " + res.statusCode);
  return cookieHeader(res);
}

// Exchanges a device's refresh credential for a short-lived access token (what the extension does before syncing).
export async function accessFor(app, refresh) {
  const res = await app.inject({ method: "POST", url: "/api/device/token", headers: { authorization: "Bearer " + refresh } });
  return { res, auth: res.statusCode === 200 ? { authorization: "Bearer " + res.json().accessToken } : null };
}

// Owner creates a pairing code, a device redeems it (-> pending), the owner approves it, the device gets an access token.
// Pass { approve:false } to leave the device pending.
export async function enrollDevice(app, ownerCookie, label = "Test device", { approve = true } = {}) {
  const code = (await app.inject({ method: "POST", url: "/api/devices/enroll-code", headers: { cookie: ownerCookie }, payload: { label } })).json().code;
  const res = await app.inject({ method: "POST", url: "/api/enroll", payload: { code, installId: "inst-" + code, label, platform: "test" } });
  if (res.statusCode !== 200) throw new Error("enroll failed: " + res.statusCode);
  const j = res.json();
  if (approve) {
    const a = await app.inject({ method: "POST", url: `/api/devices/${j.deviceId}/approve`, headers: { cookie: ownerCookie } });
    if (a.statusCode !== 200) throw new Error("approve failed: " + a.statusCode);
  }
  const { auth } = await accessFor(app, j.refreshToken);
  return { deviceId: j.deviceId, refresh: j.refreshToken, auth, confirmCode: j.confirmCode, code };
}

export const session = (id, video, over = {}) => ({
  sessionId: id, videoId: video, title: "Title " + video, channel: "Chan", startTs: 1000, endTs: 5000,
  watchedMs: 60000, duration: 600, rev: 1, updatedAt: 10, ...over
});
