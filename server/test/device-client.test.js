// End-to-end: two simulated devices, each running the REAL extension code (background.js + lib/db.js + lib/sync.js,
// see device-harness.js), pair with and sync to the REAL server over HTTP. Nothing about sync itself is mocked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login } from "./helpers.js";
import { makeDevice } from "./device-harness.js";

let ctx, server, A;
const HOUR = 3600000;

before(async () => {
  ctx = await makeApp();
  await addOwner(ctx.db);
  A = await login(ctx.app);
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  server = "http://127.0.0.1:" + ctx.app.server.address().port;
});
after(async () => { await ctx.app.close(); });

const owner = (method, url, payload) => ctx.app.inject({ method, url, headers: { cookie: A }, payload });
const newCode = async (label, requireApproval = false) => (await owner("POST", "/api/devices/enroll-code", { label, requireApproval })).json().code;
const approve = id => owner("POST", `/api/devices/${id}/approve`);
const history = async q => (await owner("GET", "/api/history?limit=200" + (q || ""))).json();
const rows = id => ctx.db.prepare("SELECT session_id,rev FROM sessions WHERE device_id=?").all(id);

// A fresh, paired, connected device (pass { approve:false } for an approval-required code that leaves it pending).
async function pairedDevice(name, opts = {}) {
  const d = makeDevice({ server, name, clockSkewMs: opts.clockSkewMs || 0 });
  const j = await d.pair(await newCode(name, opts.approve === false), opts.pair);
  d.id = j.deviceId;
  if (opts.approve !== false) { assert.equal(j.status, "active", "connected straight away"); await d.sync(); }
  return d;
}

test("pairing with a plain code connects the device at once; the dashboard shows it connected", async () => {
  const d = makeDevice({ server, name: "instant-one" });
  const j = await d.pair(await newCode("Instant laptop"));
  const c = await d.cfg();
  assert.equal(j.status, "active");
  assert.equal(c.sync_status, "active");
  assert.ok(c.just_connected > 0, "the popup can say Connected Successfully");
  assert.equal(c.session_id, j.sessionId);
  assert.equal(c.confirm_code, "", "no confirmation step");
  await d.flush(d.snap("i1", "vidI1"));
  assert.equal((await d.sync()).pushed, 1);
  const dev = (await owner("GET", "/api/devices")).json().find(x => x.id === j.deviceId);
  assert.deepEqual([dev.status, dev.connection, dev.online, dev.active_sessions, dev.client_version], ["active", "online", true, 1, "0.5.0"]);
});

test("pairing with an approval-required code: pending, shows the owner a confirmation code, and uploads NOTHING until approved", async () => {
  const d = makeDevice({ server, name: "pending-one" });
  const j = await d.pair(await newCode("Pending laptop", true));
  const c = await d.cfg();
  assert.equal(c.sync_status, "pending");
  assert.match(c.confirm_code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal(c.device_refresh.length > 20, true);
  assert.equal(c.device_token, "", "no legacy bearer is kept");

  // The device keeps recording while it waits.
  await d.flush(d.snap("p1", "vidP", { rev: 1 }));
  assert.equal(await d.outboxCount(), 1, "queued for later");
  const r = await d.sync();
  assert.equal(r.pending, true);
  assert.equal(rows(j.deviceId).length, 0, "the server holds nothing for an unapproved device");
  assert.equal(await d.outboxCount(), 1, "and the device kept it");
  assert.equal(ctx.db.prepare("SELECT status FROM devices WHERE id=?").get(j.deviceId).status, "pending");
  assert.equal(d.alarms["sync-poll"].delayInMinutes, 1, "it re-checks for approval in a minute");

  // The owner's dashboard shows the same code, then approves.
  const dev = (await owner("GET", "/api/devices")).json().find(x => x.id === j.deviceId);
  assert.equal(dev.confirm_code, c.confirm_code, "owner sees the same code the device shows");
  assert.equal(dev.status, "pending");
  await approve(j.deviceId);
  const r2 = await d.sync();
  assert.equal(r2.pushed, 1);
  assert.equal(await d.outboxCount(), 0);
  assert.equal(rows(j.deviceId).length, 1, "the event recorded while pending arrived after approval");
  assert.equal((await d.cfg()).sync_status, "active");
});

test("two authorised devices sync into one history; every record names its source device", async () => {
  const l1 = await pairedDevice("Laptop 1"), l2 = await pairedDevice("Laptop 2");
  await l1.flush(l1.snap("two-a", "vidTwoA", { title: "From laptop one" }));
  await l2.flush(l2.snap("two-b", "vidTwoB", { title: "From laptop two" }));
  assert.equal((await l1.sync()).pushed, 1);
  assert.equal((await l2.sync()).pushed, 1);
  const h = await history("&q=From laptop");
  assert.equal(h.total, 2);
  const byTitle = Object.fromEntries(h.items.map(i => [i.title, i]));
  assert.equal(byTitle["From laptop one"].deviceId, l1.id);
  assert.equal(byTitle["From laptop one"].deviceLabel, "Laptop 1");
  assert.equal(byTitle["From laptop two"].deviceId, l2.id);
  assert.equal(byTitle["From laptop two"].deviceLabel, "Laptop 2");
  const it = byTitle["From laptop one"];
  assert.deepEqual([it.url, it.watchedMs, it.duration, it.kind], ["https://www.youtube.com/watch?v=vidTwoA", 30000, 600, "watch"]);
  // The same video id watched on both devices stays two separate sessions.
  await l1.flush(l1.snap("same-1", "vidSame")); await l2.flush(l2.snap("same-2", "vidSame"));
  await l1.sync(); await l2.sync();
  assert.equal((await history("&url=vidSame")).total, 2);
});

test("pause, seek, rewatch and growth: a session's later revisions update ONE record; a lower revision never overwrites", async () => {
  const d = await pairedDevice("Revisions");
  await d.flush(d.snap("r1", "vidR", { rev: 1, watchedMs: 10000, pauses: 0, seeks: 0 }));
  await d.sync();
  await d.flush(d.snap("r1", "vidR", { rev: 3, watchedMs: 50000, pauses: 2, seeks: 1, rewinds: 1, furthestSec: 300, positionSec: 120, endTs: Date.now() }));
  await d.sync();
  let r = (await history("&url=vidR")).items;
  assert.equal(r.length, 1, "one record, not three");
  assert.deepEqual([r[0].watchedMs, r[0].pauses, r[0].seeks, r[0].rewinds], [50000, 2, 1, 1]);
  // A delayed, older revision arrives afterwards (e.g. an old retry): it must not roll the record back.
  const stale = await ctx.app.inject({ method: "POST", url: "/api/device/token", headers: { authorization: "Bearer " + d.store.device_refresh } });
  const auth = { authorization: "Bearer " + stale.json().accessToken };
  await ctx.app.inject({ method: "POST", url: "/api/sync/push", headers: auth, payload: { sessions: [d.snap("r1", "vidR", { rev: 2, watchedMs: 20000 })] } });
  r = (await history("&url=vidR")).items;
  assert.equal(r[0].watchedMs, 50000, "highest revision wins, whatever order events arrive in");
  assert.equal(rows(d.id).length, 1);
});

test("offline: events queue locally, pending is counted, and everything uploads when the network returns", async () => {
  const d = await pairedDevice("Offline");
  d.net.offline = true;
  for (let i = 1; i <= 4; i++) await d.flush(d.snap("off" + i, "vidOff" + i));
  await d.flush(d.snap("off1", "vidOff1", { rev: 2, watchedMs: 99000 })); // an update to a queued session coalesces
  assert.equal(await d.outboxCount(), 4);
  const r = await d.sync();
  assert.equal(r.ok, false, "the failure is reported, not swallowed");
  const c = await d.cfg();
  assert.ok(c.sync_last_error, "the error is visible to the user");
  assert.equal(c.sync_pending, 4);
  assert.equal(await d.outboxCount(), 4, "nothing was dropped");
  assert.equal(rows(d.id).length, 0);

  d.net.offline = false;
  const ok = await d.sync();
  assert.equal(ok.pushed, 4);
  assert.equal(await d.outboxCount(), 0);
  assert.equal(rows(d.id).length, 4);
  assert.equal((await history("&url=vidOff1")).items[0].watchedMs, 99000, "the newest revision is what arrived");
  const c2 = await d.cfg();
  assert.equal(c2.sync_last_error, "");
  assert.ok(c2.sync_last_ok > 0);
  // The server knows how this device is doing.
  const row = ctx.db.prepare("SELECT pending_count,last_push_at FROM devices WHERE id=?").get(d.id);
  assert.equal(row.pending_count, 0);
  assert.ok(row.last_push_at > 0);
});

test("a lost response (server saved it, device never heard back) is retried without creating duplicates", async () => {
  const d = await pairedDevice("LostAck");
  await d.flush(d.snap("la1", "vidLA1")); await d.flush(d.snap("la2", "vidLA2"));
  d.net.loseResponses = 1;
  const r = await d.sync();
  assert.equal(r.ok, false);
  assert.equal(rows(d.id).length, 2, "the server did store them");
  assert.equal(await d.outboxCount(), 2, "but the device, having no acknowledgement, keeps them");
  const again = await d.sync();
  assert.equal(again.pushed, 2);
  assert.equal(await d.outboxCount(), 0);
  assert.equal(rows(d.id).length, 2, "re-sending changed nothing: no duplicates");
  assert.equal((await history("&url=vidLA")).total, 2);
});

test("an event updated while an upload is in flight stays queued (compare-and-delete)", async () => {
  const d = await pairedDevice("Race");
  const DB = d.db();
  await d.flush(d.snap("rc", "vidRace", { rev: 1 }));
  // The server acknowledges rev 1 after the session already advanced to rev 2:
  await d.flush(d.snap("rc", "vidRace", { rev: 2 }));
  await DB.outboxAck([{ sessionId: "rc", rev: 1 }]);
  assert.equal(await d.outboxCount(), 1, "rev 2 is not covered by an ack of rev 1");
  await DB.outboxAck([{ sessionId: "rc", rev: 2 }]);
  assert.equal(await d.outboxCount(), 0);
});

test("browser restart: the queue survives, and syncing resumes by itself", async () => {
  const d = await pairedDevice("Restarts");
  d.net.offline = true;
  await d.flush(d.snap("rs1", "vidRs1")); await d.flush(d.snap("rs2", "vidRs2"));
  await d.sync();
  assert.equal(await d.outboxCount(), 2);
  await d.restart();                       // browser closed and reopened while still offline
  assert.equal(await d.outboxCount(), 2, "the queue is in IndexedDB, not memory");
  assert.equal((await d.cfg()).sync_server, server, "still paired");
  d.net.offline = false;
  await d.restart();                       // next start-up has a connection: onStartup triggers the upload
  assert.equal(await d.outboxCount(), 0);
  assert.equal(rows(d.id).length, 2);
});

test("an expired access token is renewed transparently with the refresh credential", async () => {
  const d = await pairedDevice("Expiry");
  await d.flush(d.snap("ex", "vidEx"));
  d.net.expireAccessOnce = true;           // the server answers 401 token_invalid to the first push
  const r = await d.sync();
  assert.equal(r.pushed, 1);
  assert.equal(rows(d.id).length, 1);
  const tokenCalls = d.net.log.filter(l => l[0] === "/api/device/token").length;
  assert.ok(tokenCalls >= 2, "a second token exchange happened");
});

test("authentication failures: no/forged/foreign credentials are refused and nothing is stored", async () => {
  const d = await pairedDevice("AuthFail");
  const push = headers => ctx.app.inject({ method: "POST", url: "/api/sync/push", headers, payload: { sessions: [d.snap("af", "vidAF")] } });
  assert.equal((await push({})).statusCode, 401, "no token");
  assert.equal((await push({ authorization: "Bearer garbage" })).statusCode, 401, "forged token");
  assert.equal((await push({ authorization: "Bearer " + d.store.device_refresh })).statusCode, 401, "the refresh credential is not an access token");
  assert.equal((await ctx.app.inject({ method: "POST", url: "/api/device/token", headers: { authorization: "Bearer nope" } })).statusCode, 401);
  assert.equal((await ctx.app.inject({ method: "POST", url: "/api/device/token" })).statusCode, 401);
  assert.equal((await ctx.app.inject({ method: "GET", url: "/api/history", headers: { authorization: "Bearer " + d.store.device_refresh } })).statusCode, 401, "a device credential never reads history");
  assert.equal(rows(d.id).length, 0);
  // A reused or wrong pairing code is refused.
  const code = await newCode("once");
  const other = makeDevice({ server, name: "code-user" });
  await other.pair(code);
  await assert.rejects(makeDevice({ server, name: "code-reuse" }).pair(code), /invalid, expired or already used/);
  await assert.rejects(makeDevice({ server, name: "code-bad" }).pair("WRONGCODE"), /invalid, expired or already used/);
  await assert.rejects(makeDevice({ server: "http://tracker.example.com", name: "plain-http" }).pair("X"), /valid https/, "plain http to a real host is refused");
});

test("revocation: the device is cut off immediately, uploads stop, its queue is discarded, and it is told why", async () => {
  const d = await pairedDevice("Revoked");
  await d.flush(d.snap("rv1", "vidRv1"));
  await d.sync();
  assert.equal(rows(d.id).length, 1);
  const refresh = d.store.device_refresh;

  await owner("POST", `/api/devices/${d.id}/revoke`);
  await d.flush(d.snap("rv2", "vidRv2"));               // recorded after the revocation, before the device finds out
  const r = await d.sync();
  assert.equal(r.revoked, true);
  const c = await d.cfg();
  assert.equal(c.device_refresh, "", "credential erased");
  assert.match(c.sync_notice, /revoked this device/);
  assert.equal(await d.outboxCount(), 0, "nothing left to send");
  assert.equal(rows(d.id).length, 1, "rv2 never reached the server");
  const after = d.net.log.length;
  assert.equal((await d.sync()).skipped, true);
  assert.equal(d.net.log.length, after, "no further network calls");

  // Even a copy of the old credentials gets nothing.
  const t = await ctx.app.inject({ method: "POST", url: "/api/device/token", headers: { authorization: "Bearer " + refresh } });
  assert.equal(t.statusCode, 403);
  assert.equal((await ctx.app.inject({ method: "GET", url: "/api/sync/commands", headers: { authorization: "Bearer x" } })).statusCode, 401);
});

test("revocation applies to an access token that has not expired yet (checked on every request)", async () => {
  const d = await pairedDevice("RevokedLiveToken");
  const tok = await ctx.app.inject({ method: "POST", url: "/api/device/token", headers: { authorization: "Bearer " + d.store.device_refresh } });
  const auth = { authorization: "Bearer " + tok.json().accessToken };
  assert.equal((await ctx.app.inject({ method: "GET", url: "/api/sync/commands", headers: auth })).statusCode, 200);
  await owner("POST", `/api/devices/${d.id}/revoke`);
  assert.equal((await ctx.app.inject({ method: "GET", url: "/api/sync/commands", headers: auth })).statusCode, 403);
  assert.equal((await ctx.app.inject({ method: "POST", url: "/api/sync/push", headers: auth, payload: { sessions: [d.snap("z", "vidZ")] } })).statusCode, 403);
});

test("removing a device is detected too", async () => {
  const d = await pairedDevice("Removed");
  await owner("DELETE", `/api/devices/${d.id}`);
  await d.flush(d.snap("rm", "vidRm"));
  assert.equal((await d.sync()).revoked, true);
  assert.match((await d.cfg()).sync_notice, /removed this device/);
});

test("clock skew: a device whose clock is 3 hours wrong is placed on the server's timeline", async () => {
  const d = await pairedDevice("Skewed", { clockSkewMs: 3 * HOUR });
  const realStart = Date.now() - 60000;
  await d.flush(d.snap("sk", "vidSkew", { startTs: realStart + 3 * HOUR }));
  await d.sync();
  const it = (await history("&url=vidSkew")).items[0];
  assert.ok(Math.abs(it.startTs - realStart) < 5 * 60000, "start time corrected to server time");
  assert.equal(it.deviceStartTs, realStart + 3 * HOUR, "the device's own reading is kept");
  assert.ok(Math.abs(it.skewMs + 3 * HOUR) < 5 * 60000);
});

test("history recorded before pairing is not uploaded unless the user opts in", async () => {
  const quiet = makeDevice({ server, name: "NoHistory" });
  await quiet.flush(quiet.snap("old1", "vidOld1"));                 // recorded while not paired: never queued
  assert.equal(await quiet.outboxCount(), 0);
  quiet.id = (await quiet.pair(await newCode("NoHistory"))).deviceId;
  await quiet.sync();
  assert.equal(rows(quiet.id).length, 0);
  await quiet.flush(quiet.snap("new1", "vidNew1"));
  assert.equal((await quiet.sync()).pushed, 1, "new activity does sync");

  const full = makeDevice({ server, name: "WithHistory" });
  await full.flush(full.snap("oldA", "vidOldA")); await full.flush(full.snap("oldB", "vidOldB"));
  full.id = (await full.pair(await newCode("WithHistory"), { uploadHistory: true })).deviceId;
  assert.equal((await full.sync()).pushed, 2);
});

test("remote commands still work: pause, retention, delete are applied, acked and visible", async () => {
  const d = await pairedDevice("Commands");
  await d.flush(d.snap("cm1", "vidCm1", { startTs: 1000 }));
  await d.sync();
  for (const [type, payload] of [["pause_tracking"], ["set_retention", { days: 30 }]]) await owner("POST", `/api/devices/${d.id}/commands`, { type, payload });
  const r = await d.sync();
  assert.equal(r.applied, 2);
  assert.equal(d.store.tracking_enabled, false);
  assert.equal(d.store.retention_days, 30);
  assert.deepEqual(ctx.db.prepare("SELECT status FROM commands WHERE device_id=?").all(d.id).map(x => x.status), ["acked", "acked"]);
  assert.equal((await d.flush(d.snap("cm2", "vidCm2"))).reason, "off", "tracking is paused");
  await owner("POST", `/api/devices/${d.id}/commands`, { type: "delete_all" });
  await d.sync();
  assert.equal((await d.sessions()).length, 0);
});

test("retention never deletes sessions that are still waiting to be uploaded", async () => {
  const d = await pairedDevice("RetentionSafe");
  d.store.retention_days = 7;
  d.net.offline = true;
  await d.flush(d.snap("ret1", "vidRet1", { startTs: Date.now() - 30 * 86400000 }));   // far older than the window
  await d.sync();                                          // fails (offline); the session stays queued
  const removed = await d.db().deleteSessionsBefore(Date.now() - 7 * 86400000, new Set((await d.outbox()).map(x => x.sessionId)));
  assert.equal(removed.length, 0, "protected while queued");
  d.net.offline = false;
  assert.equal((await d.sync()).pushed, 1);
  assert.equal((await d.db().deleteSessionsBefore(Date.now() - 7 * 86400000, new Set())).join(), "vidRet1", "deletable once uploaded");
});

test("delete session: the device only REQUESTS it; the session keeps syncing until the owner approves", async () => {
  const d = await pairedDevice("Leaving");
  await d.flush(d.snap("lv", "vidLv")); await d.sync();
  const r = await d.requestDeletion();
  assert.equal(r.status, "pending");
  assert.equal((await d.cfg()).session_request.status, "pending", "the popup shows Waiting for Admin Approval");
  const again = await d.requestDeletion();
  assert.equal(again.id, r.id, "asking twice does not create a second request");
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM session_deletion_requests WHERE device_id=?").get(d.id).n, 1);

  // Still connected while waiting.
  await d.flush(d.snap("lv2", "vidLv2"));
  assert.equal((await d.sync()).pushed, 1, "the session stays active until approval");
  assert.equal((await d.cfg()).sync_server, server);

  // The owner approves: the session is revoked and the device learns why on its next contact.
  const list = (await owner("GET", "/api/session-requests?status=pending")).json();
  assert.equal(list.length, 1); assert.equal(list[0].label, "Leaving"); assert.equal(list[0].sessionId, d.store.session_id);
  assert.equal((await owner("POST", `/api/session-requests/${r.id}/approve`)).statusCode, 200);
  const res = await d.sync();
  assert.deepEqual([res.revoked, res.kind], [true, "deleted"]);
  const c = await d.cfg();
  assert.equal(c.sync_server, ""); assert.equal(c.device_refresh, "");
  assert.match(c.sync_notice, /admin approved your request/);
  await d.flush(d.snap("lv3", "vidLv3"));
  assert.equal(await d.outboxCount(), 0, "nothing is queued once the session is deleted");
  const dev = (await owner("GET", "/api/devices")).json().find(x => x.id === d.id);
  assert.deepEqual([dev.connection, dev.active_sessions], ["disconnected", 0]);
});

test("delete session denied: the session stays active and the device is told", async () => {
  const d = await pairedDevice("Staying");
  const r = await d.requestDeletion();
  assert.equal((await owner("POST", `/api/session-requests/${r.id}/deny`)).statusCode, 200);
  assert.equal((await owner("POST", `/api/session-requests/${r.id}/approve`)).statusCode, 409, "a decided request can't be approved later");
  await d.flush(d.snap("st", "vidSt"));
  assert.equal((await d.sync()).pushed, 1, "still connected");
  assert.equal((await d.cfg()).session_request.status, "denied", "the device picked up the decision on its next sync");
  const r2 = await d.requestDeletion();
  assert.notEqual(r2.id, r.id, "after a denial the device may ask again");
});

test("a device that re-pairs after its session was deleted gets its device record and history back", async () => {
  const d = await pairedDevice("Returning");
  await d.flush(d.snap("rt1", "vidRt1")); await d.sync();
  const r = await d.requestDeletion();
  await owner("POST", `/api/session-requests/${r.id}/approve`);
  await d.sync();
  const j = await d.pair(await newCode("Returning"));
  assert.equal(j.deviceId, d.id, "same device");
  assert.notEqual(j.sessionId, r.sessionId, "new session");
  assert.equal(rows(d.id).length, 1, "history kept");
  const pairings = (await owner("GET", "/api/pairing-codes")).json().filter(p => p.device_id === d.id);
  assert.equal(pairings.length, 2, "both pairings appear in the history");
});

test("upgrade from v0.3: an already-paired device keeps syncing without re-pairing, and unsent sessions are queued", async () => {
  const d = await pairedDevice("Upgrader");
  // Reproduce what a v0.3 install has in storage: the long-lived token under its old name, plus a timestamp cursor.
  const legacyToken = d.store.device_refresh;
  const sent = d.snap("lg1", "vidLg1"); await d.flush(sent); await d.sync();
  assert.equal(rows(d.id).length, 1);
  const cut = Date.now();
  await d.db().clearAll();                                     // start the upgraded install from an empty queue
  delete d.store.device_refresh; delete d.store.sync_status;
  d.store.device_token = legacyToken; d.store.sync_cursor = cut - 1000;
  await d.flush(d.snap("lg-old", "vidLgOld"));                 // newer than the old cursor, so the old client had not uploaded it
  assert.equal(await d.outboxCount(), 0, "legacy devices are not 'enrolled' for the new queue until migrated");
  const r = await d.sync();
  assert.equal(r.pushed, 1, "the session the old cursor had not uploaded went up");
  const c = await d.cfg();
  assert.equal(c.device_refresh, legacyToken, "the old token is now the refresh credential");
  assert.equal(c.device_token, "");
  assert.equal(c.sync_status, "active");
  assert.equal(rows(d.id).filter(x => x.session_id === "lg-old").length, 1);
});
