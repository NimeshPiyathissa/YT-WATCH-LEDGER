import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login, enrollDevice, session } from "./helpers.js";
import { drifted } from "../scripts/sync-shared.js";

const DAY = 86400000;

async function setup() {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev = await enrollDevice(app, A);
  const now = Date.now();
  await app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions: [
    session("old1", "mixed", { startTs: now - 100 * DAY, endTs: now - 100 * DAY + 1000, watchedMs: 1000 }),
    session("new1", "mixed", { startTs: now - 1 * DAY, endTs: now - 1 * DAY + 1000, watchedMs: 2000 }),
    session("old2", "onlyold", { startTs: now - 90 * DAY, endTs: now - 90 * DAY + 1000, watchedMs: 3000 })
  ] } });
  const enqueue = days => app.inject({ method: "POST", url: `/api/devices/${dev.deviceId}/commands`, headers: { cookie: A }, payload: { type: "set_retention", payload: { days } } });
  const pullAck = async result => {
    const cmds = (await app.inject({ method: "GET", url: "/api/sync/commands", headers: dev.auth })).json().commands;
    return app.inject({ method: "POST", url: "/api/sync/commands/ack", headers: dev.auth, payload: { acks: cmds.map(c => ({ id: c.id, result })) } });
  };
  const videos = async () => (await app.inject({ method: "GET", url: `/api/devices/${dev.deviceId}/videos`, headers: { cookie: A } })).json();
  return { app, db, dev, A, enqueue, pullAck, videos };
}

test("an acknowledged set_retention trims the synced copy and rebuilds rollups", async () => {
  const { db, dev, enqueue, pullAck, videos } = await setup();
  assert.equal((await videos()).length, 2);
  await enqueue(30);
  await pullAck({ status: "ok" });
  assert.equal(db.prepare("SELECT retention_days FROM devices WHERE id=?").get(dev.deviceId).retention_days, 30);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
  const v = await videos();
  assert.deepEqual(v.map(x => [x.videoId, x.totalMs, x.sessionCount]), [["mixed", 2000, 1]], "fully-old video removed, mixed one recomputed");
});

test("a failed or unacknowledged retention change does not delete anything", async () => {
  const { db, dev, enqueue, pullAck } = await setup();
  await enqueue(30);
  await pullAck({ status: "error", error: "nope" });
  assert.equal(db.prepare("SELECT retention_days FROM devices WHERE id=?").get(dev.deviceId).retention_days, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 3);
});

test("retention 0 (forever) keeps everything; later pushes of old data are trimmed on the next purge", async () => {
  const { db, dev, enqueue, pullAck } = await setup();
  await enqueue(0); await pullAck({ status: "ok" });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 3);
  const { purgeAll } = await import("../src/lib/retention.js");
  db.prepare("UPDATE devices SET retention_days=7 WHERE id=?").run(dev.deviceId);
  assert.equal(purgeAll(db), 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
});

test("admin can list a device's command history with outcomes", async () => {
  const { app, A, dev, enqueue, pullAck } = await setup();
  await enqueue(30); await pullAck({ status: "ok" });
  const list = (await app.inject({ method: "GET", url: `/api/devices/${dev.deviceId}/commands`, headers: { cookie: A } })).json();
  assert.deepEqual([list[0].type, list[0].status, list[0].payload, list[0].result], ["set_retention", "acked", { days: 30 }, { status: "ok" }]);
  const dl = (await app.inject({ method: "GET", url: "/api/devices", headers: { cookie: A } })).json();
  assert.equal(dl[0].retention_days, 30);
});

test("browser/server copies of the shared modules match the extension's originals", () => {
  assert.deepEqual(drifted(), [], "run: node scripts/sync-shared.js");
});
