import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeApp, addOwner, login, enrollDevice, session } from "./helpers.js";
import { rotate } from "../scripts/rotate-key.js";

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
