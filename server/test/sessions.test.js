// Device sessions, pairing codes and the session-deletion approval workflow (owner and device sides of the API).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login, enrollDevice, accessFor, session } from "./helpers.js";
import { uuid } from "../src/lib/crypto.js";

async function setup() {
  const { app, db } = await makeApp();
  const adminId = await addOwner(db);
  const A = await login(app);
  return { app, db, A, adminId };
}
const as = (app, A, method, url, payload) => app.inject({ method, url, headers: { cookie: A }, payload });
const dev = (app, auth, method, url, payload) => app.inject({ method, url, headers: auth, payload });

/* ---- pairing codes ---- */

test("pairing codes: XXXX-XXXX without look-alike characters, accepted in any case or spacing, single use", async () => {
  const { app, A } = await setup();
  const r = (await as(app, A, "POST", "/api/devices/enroll-code", { label: "Kitchen PC" })).json();
  assert.match(r.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.ok(r.expiresAt > Date.now() + 14 * 60000 && r.expiresAt <= Date.now() + 15 * 60000);
  const sloppy = " " + r.code.toLowerCase().replace("-", " ") + " ";
  const e = await app.inject({ method: "POST", url: "/api/enroll", payload: { code: sloppy, installId: "i1" } });
  assert.equal(e.statusCode, 200);
  assert.deepEqual([e.json().status, e.json().label], ["active", "Kitchen PC"]);
  assert.match(e.json().sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(e.json().confirmCode, null);
  assert.equal((await app.inject({ method: "POST", url: "/api/enroll", payload: { code: r.code, installId: "i2" } })).statusCode, 400, "used once only");
});

test("two devices racing for one code: exactly one wins", async () => {
  const { app, db, A } = await setup();
  const { code } = (await as(app, A, "POST", "/api/devices/enroll-code", {})).json();
  const res = await Promise.all([1, 2, 3, 4].map(i => app.inject({ method: "POST", url: "/api/enroll", payload: { code, installId: "race" + i } })));
  assert.deepEqual(res.map(r => r.statusCode).sort(), [200, 400, 400, 400]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM devices").get().n, 1);
});

test("expired and cancelled codes are refused; the history shows every code's state and who used it", async () => {
  const { app, db, A } = await setup();
  const used = (await as(app, A, "POST", "/api/devices/enroll-code", { label: "Used" })).json();
  const p = (await app.inject({ method: "POST", url: "/api/enroll", payload: { code: used.code, installId: "u" } })).json();
  const cancelled = (await as(app, A, "POST", "/api/devices/enroll-code", { label: "Cancelled" })).json();
  assert.equal((await as(app, A, "POST", `/api/pairing-codes/${cancelled.id}/revoke`)).statusCode, 200);
  assert.equal((await as(app, A, "POST", `/api/pairing-codes/${cancelled.id}/revoke`)).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/enroll", payload: { code: cancelled.code } })).statusCode, 400);
  const expired = (await as(app, A, "POST", "/api/devices/enroll-code", { label: "Expired" })).json();
  db.prepare("UPDATE enroll_codes SET expires_at=? WHERE id=?").run(Date.now() - 1, expired.id);
  assert.equal((await app.inject({ method: "POST", url: "/api/enroll", payload: { code: expired.code } })).statusCode, 400);
  const active = (await as(app, A, "POST", "/api/devices/enroll-code", { label: "Active", requireApproval: true })).json();

  const hist = Object.fromEntries((await as(app, A, "GET", "/api/pairing-codes")).json().map(c => [c.label, c]));
  assert.deepEqual([hist.Used.status, hist.Used.device_id, hist.Used.session_id], ["used", p.deviceId, p.sessionId]);
  assert.equal(hist.Cancelled.status, "cancelled");
  assert.equal(hist.Expired.status, "expired");
  assert.deepEqual([hist.Active.status, hist.Active.require_approval], ["active", true]);
  assert.equal(JSON.stringify(hist).includes(active.code), false, "codes are never shown again");
});

test("wrong codes lock the address out after five attempts, and every failure is audited", async () => {
  const { app, A } = await setup();
  const { code } = (await as(app, A, "POST", "/api/devices/enroll-code", {})).json();
  for (let i = 0; i < 5; i++) assert.equal((await app.inject({ method: "POST", url: "/api/enroll", payload: { code: "AAAA-AAA" + i } })).statusCode, 400);
  const locked = await app.inject({ method: "POST", url: "/api/enroll", payload: { code } });
  assert.equal(locked.statusCode, 429, "even the right code is refused while locked out");
  assert.equal(locked.json().error, "too_many_attempts");
  const audit = (await as(app, A, "GET", "/api/audit")).json().filter(r => r.action === "pairing_failed");
  assert.equal(audit.length, 5);
});

/* ---- sessions ---- */

test("the owner sees each device's sessions and can revoke one; that session is refused at once", async () => {
  const { app, A } = await setup();
  const d = await enrollDevice(app, A, "Laptop");
  const list = (await as(app, A, "GET", "/api/sessions")).json();
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].id, list[0].device_id, list[0].status, list[0].label], [d.sessionId, d.deviceId, "active", "Laptop"]);
  assert.equal((await as(app, A, "POST", `/api/sessions/${d.sessionId}/revoke`)).statusCode, 200);
  const push = await dev(app, d.auth, "POST", "/api/sync/push", { sessions: [session("s", "v")] });
  assert.deepEqual([push.statusCode, push.json().error], [403, "revoked"], "the unexpired access token stops working");
  assert.equal((await accessFor(app, d.refresh)).res.statusCode, 403, "and the credential can't mint a new one");
  assert.equal((await as(app, A, "GET", "/api/sessions")).json().length, 0, "no active sessions left");
  assert.equal((await as(app, A, "GET", "/api/sessions?status=all")).json()[0].revoked_reason, "admin_revoked");
  const d2 = (await as(app, A, "GET", "/api/devices")).json()[0];
  assert.deepEqual([d2.connection, d2.active_sessions], ["disconnected", 0]);
});

test("revoking a device ends all of its sessions and cancels its open deletion request", async () => {
  const { app, db, A } = await setup();
  const d = await enrollDevice(app, A, "Laptop");
  const r = (await dev(app, d.auth, "POST", "/api/device/session/deletion-request", {})).json().request;
  await as(app, A, "POST", `/api/devices/${d.deviceId}/revoke`);
  assert.equal(db.prepare("SELECT status FROM device_sessions WHERE id=?").get(d.sessionId).status, "revoked");
  assert.equal(db.prepare("SELECT status FROM session_deletion_requests WHERE id=?").get(r.id).status, "cancelled");
  assert.equal((await as(app, A, "POST", `/api/session-requests/${r.id}/approve`)).statusCode, 409);
});

test("the devices list reports connection, presence, version, sessions and pending requests", async () => {
  const { app, db, A } = await setup();
  const d = await enrollDevice(app, A, "Laptop");
  await app.inject({ method: "POST", url: "/api/device/token", headers: { authorization: "Bearer " + d.refresh, "x-client-version": "0.5.0" } });
  await dev(app, d.auth, "POST", "/api/device/session/deletion-request", {});
  let row = (await as(app, A, "GET", "/api/devices")).json()[0];
  assert.deepEqual([row.connection, row.online, row.client_version, row.active_sessions, row.pending_requests, row.pairings], ["online", true, "0.5.0", 1, 1, 1]);
  assert.ok(row.last_active > Date.now() - 5000);
  // A 0.5 client without a live socket goes offline quickly; a 0.4 client (polling only) is given its 5-minute cycle.
  db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(Date.now() - 2 * 60000, d.deviceId);
  db.prepare("UPDATE device_sessions SET last_seen=? WHERE device_id=?").run(Date.now() - 2 * 60000, d.deviceId);
  row = (await as(app, A, "GET", "/api/devices")).json()[0];
  assert.deepEqual([row.connection, row.online], ["offline", false]);
  db.prepare("UPDATE devices SET client_version='0.4.0' WHERE id=?").run(d.deviceId);
  row = (await as(app, A, "GET", "/api/devices")).json()[0];
  assert.deepEqual([row.connection, row.online], ["online", true]);
});

/* ---- deletion requests ---- */

test("deletion request: filed by the device, listed for the owner, duplicates refused, session untouched until a decision", async () => {
  const { app, A } = await setup();
  const d = await enrollDevice(app, A, "Laptop");
  const first = await dev(app, d.auth, "POST", "/api/device/session/deletion-request", { reason: "selling this laptop" });
  assert.equal(first.statusCode, 201);
  const second = await dev(app, d.auth, "POST", "/api/device/session/deletion-request", {});
  assert.deepEqual([second.statusCode, second.json().duplicate, second.json().request.id], [200, true, first.json().request.id]);
  const list = (await as(app, A, "GET", "/api/session-requests")).json();
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].label, list[0].sessionId, list[0].status, list[0].reason], ["Laptop", d.sessionId, "pending", "selling this laptop"]);
  assert.ok(list[0].requestedAt > 0);
  assert.equal((await dev(app, d.auth, "POST", "/api/sync/push", { sessions: [session("s", "v")] })).statusCode, 200, "still active");
  const info = (await dev(app, d.auth, "GET", "/api/device/session")).json();
  assert.deepEqual([info.session.id, info.deletionRequest.status], [d.sessionId, "pending"]);
});

test("parallel deletion requests from one session create exactly one request", async () => {
  const { app, db, A } = await setup();
  const d = await enrollDevice(app, A, "Laptop");
  const res = await Promise.all([1, 2, 3, 4, 5].map(() => dev(app, d.auth, "POST", "/api/device/session/deletion-request", {})));
  assert.equal(new Set(res.map(r => r.json().request.id)).size, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM session_deletion_requests").get().n, 1);
});

test("approve deletes the session: device gets 403 session_deleted, the request is approved and audited", async () => {
  const { app, A } = await setup();
  const d = await enrollDevice(app, A, "Laptop");
  const r = (await dev(app, d.auth, "POST", "/api/device/session/deletion-request", {})).json().request;
  const ok = await as(app, A, "POST", `/api/session-requests/${r.id}/approve`);
  assert.deepEqual([ok.statusCode, ok.json().request.status], [200, "approved"]);
  const push = await dev(app, d.auth, "POST", "/api/sync/push", { sessions: [] });
  assert.deepEqual([push.statusCode, push.json().error], [403, "session_deleted"]);
  const tok = await accessFor(app, d.refresh);
  assert.deepEqual([tok.res.statusCode, tok.res.json().error], [403, "session_deleted"]);
  assert.equal((await as(app, A, "POST", `/api/session-requests/${r.id}/approve`)).statusCode, 409, "no double approval");
  assert.equal((await as(app, A, "POST", `/api/session-requests/${r.id}/deny`)).statusCode, 409, "nor deny after approve");
  const actions = (await as(app, A, "GET", "/api/audit")).json().map(x => x.action);
  for (const a of ["session_deletion_requested", "session_deletion_approved"]) assert.ok(actions.includes(a), a);
});

test("deny keeps the session active and records the decision", async () => {
  const { app, A } = await setup();
  const d = await enrollDevice(app, A, "Laptop");
  const r = (await dev(app, d.auth, "POST", "/api/device/session/deletion-request", {})).json().request;
  const no = await as(app, A, "POST", `/api/session-requests/${r.id}/deny`, { note: "keep it for now" });
  assert.deepEqual([no.statusCode, no.json().request.status, no.json().request.decisionNote], [200, "denied", "keep it for now"]);
  assert.equal((await dev(app, d.auth, "POST", "/api/sync/push", { sessions: [] })).statusCode, 200);
  assert.equal((await dev(app, d.auth, "GET", "/api/device/session")).json().deletionRequest.status, "denied");
  assert.ok((await as(app, A, "GET", "/api/audit")).json().some(x => x.action === "session_deletion_denied"));
});

test("only the owner can decide: no cookie is 401, a device token is 401, another admin's request is 403, a foreign Origin is 403", async () => {
  const { app, db, A } = await setup();
  const d = await enrollDevice(app, A, "Laptop");
  const r = (await dev(app, d.auth, "POST", "/api/device/session/deletion-request", {})).json().request;
  assert.equal((await app.inject({ method: "POST", url: `/api/session-requests/${r.id}/approve` })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: `/api/session-requests/${r.id}/approve`, headers: d.auth })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: `/api/session-requests/${r.id}/approve`, headers: { cookie: A, origin: "https://evil.example" } })).statusCode, 403);
  // Defence in depth: a row belonging to some other admin id is refused even though there is only one owner.
  db.prepare("UPDATE session_deletion_requests SET admin_id=? WHERE id=?").run(uuid(), r.id);
  assert.equal((await as(app, A, "POST", `/api/session-requests/${r.id}/approve`)).statusCode, 403);
  assert.equal((await as(app, A, "GET", "/api/session-requests")).json().length, 0);
  assert.equal((await as(app, A, "POST", "/api/session-requests/nope/approve")).statusCode, 404);
  assert.equal(db.prepare("SELECT status FROM device_sessions WHERE id=?").get(d.sessionId).status, "active", "nothing was revoked");
});

test("a pending (not yet approved) device may ask too, and the request does not let it sync", async () => {
  const { app, A } = await setup();
  const d = await enrollDevice(app, A, "Waiting", { approve: false });
  assert.equal((await dev(app, d.auth, "POST", "/api/device/session/deletion-request", {})).statusCode, 201);
  assert.equal((await dev(app, d.auth, "POST", "/api/sync/push", { sessions: [] })).statusCode, 403);
});

test("upgrade: a device paired before device sessions existed keeps working with its old credential (migration 004)", async () => {
  const fs = await import("node:fs"), path = await import("node:path"), { fileURLToPath } = await import("node:url");
  const { openDb, migrate } = await import("../src/db.js");
  const { buildApp } = await import("../src/app.js");
  const { sha256 } = await import("../src/lib/crypto.js");
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const db = openDb();
  db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const f of ["001_init.sql", "002_retention.sql", "003_single_owner_pairing.sql"]) {
    db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    db.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(f, Date.now());
  }
  await addOwner(db);
  const admin = db.prepare("SELECT id FROM admins").get().id;
  db.prepare("INSERT INTO devices(id,admin_id,label,token_hash,status,enrolled_at,approved_at,client_version) VALUES ('old-dev',?,'Old laptop',?,'active',1,1,'0.4.0')").run(admin, sha256("old-credential"));
  db.prepare("INSERT INTO devices(id,admin_id,label,token_hash,status,enrolled_at) VALUES ('gone-dev',?,'Revoked one',?,'revoked',1)").run(admin, sha256("revoked-credential"));
  db.prepare("INSERT INTO enroll_codes(code_hash,admin_id,label,expires_at,used_at) VALUES ('h',?,'old code',?,?)").run(admin, Date.now(), Date.now());
  assert.deepEqual(migrate(db), ["004_device_sessions.sql"]);

  const app = await buildApp({ db }); await app.ready();
  const ok = await app.inject({ method: "POST", url: "/api/device/token", headers: { authorization: "Bearer old-credential" } });
  assert.deepEqual([ok.statusCode, ok.json().status], [200, "active"], "no re-pairing needed");
  const push = await app.inject({ method: "POST", url: "/api/sync/push", headers: { authorization: "Bearer " + ok.json().accessToken }, payload: { sessions: [session("m1", "v1")] } });
  assert.equal(push.statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/device/token", headers: { authorization: "Bearer revoked-credential" } })).statusCode, 403, "revoked stays revoked");
  const sess = db.prepare("SELECT device_id,status,revoked_reason FROM device_sessions ORDER BY device_id").all();
  assert.deepEqual(sess.map(s => [s.device_id, s.status]), [["gone-dev", "revoked"], ["old-dev", "active"]]);
  assert.match(db.prepare("SELECT id FROM enroll_codes").get().id, /^[0-9a-f]{32}$/, "old codes get ids for the history");
  await app.close();
});
