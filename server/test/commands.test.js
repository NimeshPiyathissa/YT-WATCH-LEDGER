import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login, enrollDevice } from "./helpers.js";

async function setup() {
  const { app, db } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const dev = await enrollDevice(app, A);
  const enqueue = (type, payload, id = dev.deviceId) => app.inject({ method: "POST", url: `/api/devices/${id}/commands`, headers: { cookie: A }, payload: { type, payload } });
  const pull = d => app.inject({ method: "GET", url: "/api/sync/commands", headers: (d || dev).auth });
  const status = id => db.prepare("SELECT status FROM commands WHERE id=?").get(id)?.status;
  return { app, db, A, dev, enqueue, pull, status };
}

test("enqueue -> pull marks delivered -> ack marks acked", async () => {
  const { app, db, dev, enqueue, pull, status } = await setup();
  assert.equal((await enqueue("set_retention", { days: 30 })).statusCode, 200);
  const id = db.prepare("SELECT id FROM commands").get().id;
  assert.equal(status(id), "pending");
  const got = (await pull()).json().commands;
  assert.deepEqual(got.map(c => [c.id, c.type, c.payload]), [[id, "set_retention", { days: 30 }]]);
  assert.equal(status(id), "delivered");
  assert.equal((await pull()).json().commands.length, 0, "not re-sent immediately");
  const ack = await app.inject({ method: "POST", url: "/api/sync/commands/ack", headers: dev.auth, payload: { acks: [{ id, result: { status: "ok" } }] } });
  assert.equal(ack.statusCode, 200);
  assert.equal(status(id), "acked");
  assert.deepEqual(JSON.parse(db.prepare("SELECT result FROM commands").get().result), { status: "ok" });
});

test("delivered-but-unacked commands are redelivered after a delay", async () => {
  const { db, enqueue, pull } = await setup();
  await enqueue("pause_tracking");
  assert.equal((await pull()).json().commands.length, 1);
  db.prepare("UPDATE commands SET delivered_at=?").run(Date.now() - 120000);
  assert.equal((await pull()).json().commands.length, 1);
});

test("non-whitelisted or malformed commands are rejected with 400", async () => {
  const { db, enqueue } = await setup();
  for (const [t, p] of [["format_disk"], [undefined], ["set_retention", { days: -1 }], ["set_retention", { days: "x" }], ["set_retention", {}],
    ["delete_range", { from: 5, to: 1 }], ["delete_range", {}]]) {
    assert.equal((await enqueue(t, p)).statusCode, 400, JSON.stringify([t, p]));
  }
  for (const [t, p] of [["pause_tracking"], ["resume_tracking"], ["delete_all"], ["set_retention", { days: 0 }], ["delete_range", { from: 1, to: 2 }]])
    assert.equal((await enqueue(t, p)).statusCode, 200, t);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM commands").get().n, 5);
});

test("a device cannot see or ack another device's commands", async () => {
  const { app, db, A, dev, enqueue, pull, status } = await setup();
  const other = await enrollDevice(app, A, "Other");
  await enqueue("delete_all");
  const id = db.prepare("SELECT id FROM commands").get().id;
  assert.equal((await pull(other)).json().commands.length, 0);
  await app.inject({ method: "POST", url: "/api/sync/commands/ack", headers: other.auth, payload: { acks: [{ id, result: "x" }] } });
  assert.equal(status(id), "pending");
  assert.equal((await pull(dev)).json().commands.length, 1);
});

test("ack validates its body", async () => {
  const { app, dev } = await setup();
  for (const payload of [{}, { acks: "x" }, { acks: Array.from({ length: 101 }, () => ({ id: "a" })) }])
    assert.equal((await app.inject({ method: "POST", url: "/api/sync/commands/ack", headers: dev.auth, payload })).statusCode, 400);
});
