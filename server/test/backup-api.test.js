// Backup Manager API: owner-only, never reads outside the backup folder, and every verification is audited.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeApp, addOwner, login } from "./helpers.js";

test("listing and verifying backups needs the owner, and verifying reports integrity, release compatibility and the key", async () => {
  const { app, db, backupDir } = await makeApp(); await addOwner(db);
  assert.equal((await app.inject({ method: "GET", url: "/api/system/backups" })).statusCode, 401);
  const cookie = await login(app), h = { cookie };
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/system/backups", headers: h })).json().items, []);
  const made = (await app.inject({ method: "POST", url: "/api/system/backup", headers: h })).json();
  const list = (await app.inject({ method: "GET", url: "/api/system/backups", headers: h })).json();
  assert.equal(list.items[0].name, made.name);
  assert.equal(list.dir, path.basename(backupDir), "only the folder's name is exposed, not its full path");
  const v = (await app.inject({ method: "POST", url: `/api/system/backups/${made.name}/verify`, headers: h })).json();
  assert.equal(v.integrity, true); assert.equal(v.schema.state, "current"); assert.equal(v.restorable, true); assert.match(v.sha256, /^[0-9a-f]{64}$/);
  const audited = db.prepare("SELECT detail FROM audit_log WHERE action='backup_verified'").all();
  assert.equal(audited.length, 1); assert.equal(JSON.parse(audited[0].detail).name, made.name);
});

test("a verify request cannot name a file outside the backup folder", async () => {
  const { app, db, backupDir } = await makeApp(); await addOwner(db); const h = { cookie: await login(app) };
  fs.writeFileSync(path.join(path.dirname(backupDir), "secret.db"), "x");
  for (const n of ["..%2Fsecret.db", "..%5Csecret.db", "tracker-20260101T000000Z.db%2F..%2F..%2Fsecret.db", "secret.db", "%2Fetc%2Fpasswd"]) {
    const r = await app.inject({ method: "POST", url: `/api/system/backups/${n}/verify`, headers: h });
    assert.ok([400, 404].includes(r.statusCode), n + " -> " + r.statusCode);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/system/backups/tracker-20260101T000000Z.db/verify", headers: h })).statusCode, 404);
});
