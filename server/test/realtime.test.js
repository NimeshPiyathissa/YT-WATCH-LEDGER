// Real-time synchronisation over real sockets: the owner's Server-Sent Events stream, and the device WebSocket driven by
// the REAL extension code (background.js + lib/realtime.js + lib/sync.js in the device harness, with a real WebSocket).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login } from "./helpers.js";
import { makeDevice } from "./device-harness.js";

let ctx, server, A;
before(async () => {
  ctx = await makeApp();
  await addOwner(ctx.db);
  A = await login(ctx.app);
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  server = "http://127.0.0.1:" + ctx.app.server.address().port;
});
after(async () => { await ctx.app.close(); });

const owner = (method, url, payload) => ctx.app.inject({ method, url, headers: { cookie: A }, payload });
const newCode = async (label, requireApproval = false) => (await owner("POST", "/api/devices/enroll-code", { label, requireApproval })).json();
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 20)); } };

// Minimal SSE client: collects {type, data} events from /api/events with the owner's cookie.
async function openEvents(cookie = A) {
  const ctl = new AbortController(), events = [];
  const res = await fetch(server + "/api/events", { headers: { cookie }, signal: ctl.signal });
  const out = { status: res.status, headers: res.headers, events, close: () => ctl.abort(), next: type => until(() => events.find(e => e.type === type && !e.seen && (e.seen = true))) };
  if (res.status !== 200) return out;
  (async () => {
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = (chunk.match(/^event: (.+)$/m) || [])[1], data = (chunk.match(/^data: (.+)$/m) || [])[1];
          if (type) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  await out.next("hello");
  return out;
}

test("SSE: only the signed-in owner can listen; the stream is not cached", async () => {
  const anon = await fetch(server + "/api/events");
  assert.equal(anon.status, 401);
  const es = await openEvents();
  assert.equal(es.status, 200);
  assert.match(es.headers.get("content-type"), /text\/event-stream/);
  assert.equal(es.headers.get("cache-control"), "no-store");
  es.close();
});

test("pairing completed and device connected reach the dashboard the moment the code is redeemed", async () => {
  const es = await openEvents();
  const code = await newCode("Live laptop");
  const d = makeDevice({ server, name: "live-pair" });
  const j = await d.pair(code.code);
  const ev = (await es.next("pairing_completed")).data;
  assert.deepEqual([ev.codeId, ev.deviceId, ev.label, ev.status], [code.id, j.deviceId, "Live laptop", "active"]);
  assert.equal((await es.next("device_connected")).data.deviceId, j.deviceId);
  es.close();
});

test("the extension holds a live socket: presence shows online, and going away shows offline", async () => {
  const es = await openEvents();
  const d = makeDevice({ server, name: "presence", realtime: true });
  const j = await d.pair((await newCode("Presence")).code);
  await d.connect();
  await until(() => d.store.rt_state === "online");
  assert.deepEqual((await es.next("device_presence")).data, { ...es.events.find(e => e.type === "device_presence").data, deviceId: j.deviceId, online: true });
  const row = (await owner("GET", "/api/devices")).json().find(x => x.id === j.deviceId);
  assert.deepEqual([row.realtime, row.online, row.connection], [true, true, "online"]);
  await d.disconnect();
  const off = (await es.next("device_presence")).data;
  assert.deepEqual([off.deviceId, off.online], [j.deviceId, false]);
  es.close();
});

test("full workflow in real time: request -> owner sees it -> approve -> the extension is told and disconnects by itself", async () => {
  const es = await openEvents();
  const d = makeDevice({ server, name: "rt-approve", realtime: true });
  const j = await d.pair((await newCode("RT approve")).code);
  await d.connect();
  await until(() => d.store.rt_state === "online");

  const r = await d.requestDeletion();
  const asked = (await es.next("session_deletion_requested")).data;
  assert.deepEqual([asked.requestId, asked.deviceId, asked.label], [r.id, j.deviceId, "RT approve"]);
  assert.equal(d.store.session_request.status, "pending");
  assert.equal(d.isLive(), true, "still connected while waiting");

  assert.equal((await owner("POST", `/api/session-requests/${r.id}/approve`)).statusCode, 200);
  // No sync call here: the server's push alone makes the device forget the session.
  await until(() => d.store.device_refresh === "");
  assert.match(d.store.sync_notice, /admin approved your request/);
  await until(() => d.store.rt_state === "offline");
  assert.equal((await es.next("session_request_approved")).data.requestId, r.id);
  assert.equal((await es.next("session_revoked")).data.sessionId, j.sessionId);
  es.close();
});

test("deny in real time: the extension shows the decision and stays connected", async () => {
  const es = await openEvents();
  const d = makeDevice({ server, name: "rt-deny", realtime: true });
  await d.pair((await newCode("RT deny")).code);
  await d.connect();
  await until(() => d.store.rt_state === "online");
  const r = await d.requestDeletion();
  await owner("POST", `/api/session-requests/${r.id}/deny`);
  await until(() => d.store.session_request && d.store.session_request.status === "denied");
  assert.notEqual(d.store.device_refresh, "", "session kept");
  assert.equal(d.isLive(), true);
  assert.equal((await es.next("session_request_denied")).data.requestId, r.id);
  await d.disconnect();
  es.close();
});

test("revoking a device pushes the revocation over the socket; approval of a pending device is pushed too", async () => {
  const p = makeDevice({ server, name: "rt-pending", realtime: true });
  const pj = await p.pair((await newCode("RT pending", true)).code);
  await p.connect();
  await until(() => p.store.rt_state === "online");
  await owner("POST", `/api/devices/${pj.deviceId}/approve`);
  await until(() => p.store.sync_status === "active");
  assert.ok(p.store.just_connected > 0, "the popup can now say Connected Successfully");

  await owner("POST", `/api/devices/${pj.deviceId}/revoke`);
  await until(() => p.store.device_refresh === "");
  assert.match(p.store.sync_notice, /revoked this device/);
});

test("a queued command is fetched immediately when the device is connected", async () => {
  const d = makeDevice({ server, name: "rt-cmd", realtime: true });
  const j = await d.pair((await newCode("RT command")).code);
  await d.connect();
  await until(() => d.store.rt_state === "online");
  const res = (await owner("POST", `/api/devices/${j.deviceId}/commands`, { type: "pause_tracking" })).json();
  assert.equal(res.delivered, "now");
  await until(() => d.store.tracking_enabled === false);
  await d.disconnect();
});

test("the socket refuses a missing or forged token and a revoked session", async () => {
  const closeOf = (ws) => new Promise(r => ws.addEventListener("close", e => r(e.code)));
  const url = server.replace("http", "ws") + "/api/device/ws";
  const a = new WebSocket(url); a.addEventListener("open", () => a.send(JSON.stringify({ type: "hello" })));
  assert.equal(await closeOf(a), 4401);
  const b = new WebSocket(url); b.addEventListener("open", () => b.send(JSON.stringify({ type: "auth", token: "forged.token" })));
  assert.equal(await closeOf(b), 4401);

  const code = (await newCode("Socket revoked")).code;
  const e = (await ctx.app.inject({ method: "POST", url: "/api/enroll", payload: { code, installId: "sock" } })).json();
  const tok = (await ctx.app.inject({ method: "POST", url: "/api/device/token", headers: { authorization: "Bearer " + e.refreshToken } })).json().accessToken;
  await owner("POST", `/api/sessions/${e.sessionId}/revoke`);
  const c = new WebSocket(url), msgs = [];
  c.addEventListener("message", m => msgs.push(JSON.parse(m.data)));
  c.addEventListener("open", () => c.send(JSON.stringify({ type: "auth", token: tok })));
  assert.equal(await closeOf(c), 4403);
  assert.deepEqual(msgs.map(m => [m.type, m.reason]), [["session_revoked", "revoked"]]);
});
