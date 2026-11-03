import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeApp, addOwner, login, enrollDevice, session } from "./helpers.js";
import { createRequire } from "node:module";
import { rotate, encryptedTables } from "../scripts/rotate-key.js";

const P = createRequire(import.meta.url)("../src/lib/playback.cjs");

const OLD = Buffer.alloc(32, 7).toString("base64"); // the key test/env.js configures
const NEW = crypto.randomBytes(32).toString("base64");

async function seeded() {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev = await enrollDevice(app, A);
  await app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions: [session("s1", "v1"), session("s2", "v2")] } });
  return { app, db };
}

test("rotation re-encrypts every record; the old key no longer decrypts, the new one does", async () => {
  const { db } = await seeded();
  const before = db.prepare("SELECT enc FROM sessions ORDER BY session_id").all().map(r => r.enc);
  assert.equal(rotate(db, OLD, NEW), 4); // 2 sessions + 2 video rollups
  const after = db.prepare("SELECT enc FROM sessions ORDER BY session_id").all().map(r => r.enc);
  assert.notDeepEqual(after, before);
  const open = (key, buf) => { const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString()); };
  assert.equal(open(NEW, after[0]).sessionId, "s1");
  assert.throws(() => open(OLD, after[0]));
});

test("a wrong old key aborts and leaves the data untouched", async () => {
  const { db } = await seeded();
  const before = db.prepare("SELECT enc FROM videos ORDER BY video_id").all().map(r => r.enc.toString("hex"));
  assert.throws(() => rotate(db, crypto.randomBytes(32).toString("base64"), NEW));
  assert.deepEqual(db.prepare("SELECT enc FROM videos ORDER BY video_id").all().map(r => r.enc.toString("hex")), before);
});

test("rotation rejects malformed or identical keys", async () => {
  const { db } = await seeded();
  assert.throws(() => rotate(db, "short", NEW), /OLD_MASTER_KEY/);
  assert.throws(() => rotate(db, OLD, OLD), /identical/);
});

test("REGRESSION: rotation also re-encrypts the v0.7.0 playback-event tables (Video Details data stays readable)", async () => {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app), dev = await enrollDevice(app, A);
  const rec = P.createRecorder({ sessionId: "r1", videoId: "vidR" }), t0 = Date.now() - 600000, evs = [];
  evs.push(...rec.observe({ pos: 0, rate: 1, paused: false, duration: 300 }, t0));
  evs.push(...rec.observe({ pos: 30, rate: 1, paused: true, duration: 300 }, t0 + 30000));
  evs.push(...rec.observe({ pos: 30, rate: 1, paused: false, duration: 300 }, t0 + 90000));
  evs.push(...rec.end(t0 + 120000, "navigation", { pos: 60 }));
  assert.equal((await app.inject({ method: "POST", url: "/api/sync/events", headers: dev.auth, payload: { events: evs } })).statusCode, 200);
  await app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions: [session("r1", "vidR")] } });

  const tables = encryptedTables(db);
  for (const must of ["videos", "sessions", "video_playback_events", "video_sessions", "video_pause_intervals", "video_watch_segments", "video_analytics"]) assert.ok(tables.includes(must), "discovered " + must);
  const counts = Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n]));
  assert.ok(counts.video_playback_events === 4 && counts.video_pause_intervals === 1, JSON.stringify(counts));

  assert.equal(rotate(db, OLD, NEW), Object.values(counts).reduce((a, b) => a + b, 0), "every encrypted row was rotated");
  const open = (key, buf) => { const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString()); };
  for (const t of tables) for (const r of db.prepare(`SELECT enc FROM "${t}"`).all()) { assert.doesNotThrow(() => open(NEW, r.enc), t + " opens with the new key"); assert.throws(() => open(OLD, r.enc), t + " no longer opens with the old key"); }
  assert.equal(open(NEW, db.prepare("SELECT enc FROM video_pause_intervals").get().enc).pausedPos, 30, "the content is intact, not just decryptable");
});
