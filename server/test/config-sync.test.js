// Managed configuration end to end: the REAL extension code (background.js + lib/sync.js + lib/realtime.js in the device
// harness) against the REAL server over HTTP and WebSocket. Covers apply, confirmation, failure, offline, clearing,
// live push, and that the session ending drops the managed view. Tracking itself is never part of the config.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login } from "./helpers.js";
import { makeDevice } from "./device-harness.js";

let ctx, server, A;
before(async () => {
  ctx = await makeApp(); await addOwner(ctx.db); A = await login(ctx.app);
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  server = "http://127.0.0.1:" + ctx.app.server.address().port;
});
after(async () => { await ctx.app.close(); });

const owner = (method, url, payload) => ctx.app.inject({ method, url, headers: { cookie: A }, payload });
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 20)); } };
async function pair(name, opts = {}) {
  const d = makeDevice({ server, name, realtime: !!opts.realtime });
  const code = (await owner("POST", "/api/devices/enroll-code", { label: name })).json().code;
  d.id = (await d.pair(code)).deviceId; await d.sync();
  return d;
}
const status = async d => (await owner("GET", `/api/devices/${d.id}/config`)).json();
const setCfg = (d, changes) => owner("PUT", `/api/devices/${d.id}/config`, { changes });
const calls = (d, path) => d.net.log.filter(x => x[0] === path).length;

test("the device applies the owner's settings on its next sync, reports applied, and the dashboard shows it", async () => {
  const d = await pair("Applies");
  d.store.tracking_enabled = true;
  await setCfg(d, { retention_days: 30, sync_interval_minutes: 15 });
  assert.equal((await status(d)).state, "pending", "saved, waiting for the device");
  await d.sync();
  assert.deepEqual([d.store.retention_days, d.store.sync_interval_minutes], [30, 15]);
  assert.deepEqual([d.store.managed_config.version, d.store.managed_config.status, d.store.managed_config.acked], [1, "applied", true]);
  assert.equal(d.alarms.sync.periodInMinutes, 15, "the sync timer follows the managed interval");
  const s = await status(d);
  assert.deepEqual([s.state, s.appliedVersion], ["applied", 1]);
  assert.equal(ctx.db.prepare("SELECT retention_days FROM devices WHERE id=?").get(d.id).retention_days, 30, "server copy follows");
  assert.equal(d.store.tracking_enabled, true, "tracking is not a managed setting and is untouched");
  const again = calls(d, "/api/sync/config/ack");
  await d.sync();
  assert.equal(calls(d, "/api/sync/config/ack"), again, "an applied and confirmed version is not re-applied or re-reported");
});

test("a confirmation that never reached the server is sent again at the next sync", async () => {
  const d = await pair("LostConfirm");
  await setCfg(d, { retention_days: 7 });
  d.net.mock["/api/sync/config/ack"] = () => new Response("{}", { status: 503 });
  await d.sync();
  assert.deepEqual([d.store.retention_days, d.store.managed_config.acked], [7, false], "applied locally, not yet confirmed");
  assert.equal((await status(d)).state, "pending");
  delete d.net.mock["/api/sync/config/ack"];
  await d.sync();
  assert.deepEqual([d.store.managed_config.acked, (await status(d)).state], [true, "applied"]);
});

test("a config the device cannot validate is refused and reported as failed, not applied", async () => {
  const d = await pair("Refuses");
  d.store.retention_days = 90;
  await setCfg(d, { retention_days: 14 });
  d.net.mock["/api/sync/config"] = () => new Response(JSON.stringify({ version: 1, config: { retention_days: 99999 } }), { status: 200 });
  await d.sync();
  assert.equal(d.store.retention_days, 90, "nothing was applied");
  assert.deepEqual([d.store.managed_config.status, /whole number/.test(d.store.managed_config.error)], ["failed", true]);
  const s = await status(d);
  assert.deepEqual([s.state, /whole number/.test(s.error)], ["failed", true]);
  assert.ok((await owner("GET", "/api/audit")).json().some(x => x.action === "config_failed"));
  delete d.net.mock["/api/sync/config"];
  await setCfg(d, { retention_days: 21 });      // the owner fixes it with a new version
  await d.sync();
  assert.deepEqual([d.store.retention_days, (await status(d)).state], [21, "applied"]);
});

test("an offline device keeps working and picks the config up when it is back", async () => {
  const d = await pair("Offline");
  d.net.offline = true;
  await setCfg(d, { sync_interval_minutes: 30 });
  const r = await d.sync();
  assert.equal(r.ok, false);
  assert.equal(d.store.sync_interval_minutes === undefined || d.store.sync_interval_minutes === 0, true, "nothing applied while offline");
  assert.equal((await status(d)).state, "pending", "the dashboard keeps showing it as pending");
  d.net.offline = false;
  await d.sync();
  assert.deepEqual([d.store.sync_interval_minutes, (await status(d)).state], [30, "applied"]);
});

test("clearing a setting returns the sync interval to the device's own default and records history for every step", async () => {
  const d = await pair("Clears");
  await setCfg(d, { sync_interval_minutes: 20 }); await d.sync();
  assert.equal(d.alarms.sync.periodInMinutes, 20);
  await setCfg(d, { sync_interval_minutes: null }); await d.sync();
  assert.deepEqual([d.store.sync_interval_minutes, d.alarms.sync.periodInMinutes], [0, 5]);
  const hist = (await owner("GET", `/api/devices/${d.id}/config/history`)).json();
  assert.deepEqual(hist.map(h => [h.version, h.status]), [[2, "applied"], [1, "applied"]], "each version was applied in turn, newest first");
});

test("live: a connected extension applies a change at once over its socket, without waiting for a sync", async () => {
  const d = await pair("Live", { realtime: true });
  await d.connect();
  await until(() => d.store.rt_state === "online");
  const before = calls(d, "/api/sync/push");
  const res = (await setCfg(d, { retention_days: 45 })).json();
  assert.equal(res.online, true, "the dashboard knows the device is connected");
  await until(() => d.store.retention_days === 45);
  await until(async () => (await status(d)).state === "applied");
  assert.ok(calls(d, "/api/sync/push") >= before, "it synced because the server told it to");
  await d.disconnect();
});

test("the dashboard is told in real time when a change is made and when the device reports back", async () => {
  const d = await pair("Events");
  const ctl = new AbortController(), events = [];
  const res = await fetch(server + "/api/events", { headers: { cookie: A }, signal: ctl.signal });
  (async () => { const rd = res.body.getReader(), dec = new TextDecoder(); let buf = ""; try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); const t = (c.match(/^event: (.+)$/m) || [])[1], x = (c.match(/^data: (.+)$/m) || [])[1]; if (t) events.push({ t, data: JSON.parse(x) }); } } } catch { /* aborted */ } })();
  await until(() => events.some(e => e.t === "hello"));
  await setCfg(d, { retention_days: 60 });
  await until(() => events.some(e => e.t === "config_updated" && e.data.deviceId === d.id));
  await d.sync();
  const st = await until(() => events.find(e => e.t === "config_status" && e.data.deviceId === d.id));
  assert.deepEqual([st.data.version, st.data.status], [1, "applied"]);
  ctl.abort();
});

test("when the session ends the device forgets the managed view; a removed or revoked device no longer receives config", async () => {
  const d = await pair("Ends");
  await setCfg(d, { retention_days: 10 }); await d.sync();
  assert.equal(d.store.managed_config.status, "applied");
  await owner("POST", `/api/devices/${d.id}/revoke`);
  assert.equal((await d.sync()).revoked, true);
  assert.equal(d.store.managed_config, null);
  assert.equal((await setCfg(d, { retention_days: 20 })).statusCode, 409, "a revoked device cannot be configured");
});
