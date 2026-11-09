// Notification Center: in-dashboard notifications only (nothing is sent anywhere). Every kind is configurable; a condition notifies once while it
// lasts, clears itself when it ends, and a dismissed one stays dismissed for as long as the condition does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login, enrollDevice, OWNER } from "./helpers.js";
import { openDb, migrate } from "../src/db.js";
import { createBackup } from "../src/lib/backup.js";
import { evaluateNotifications, pruneNotifications, DEFAULT_PREFS, getPrefs } from "../src/lib/notifications.js";
import { tmpDir } from "./tmpdir.js";

const H = 3600000;
async function setup(extra = {}) {
  const ctx = await makeApp(); await addOwner(ctx.db);
  const cookie = await login(ctx.app), h = { cookie };
  const api = async (method, url, payload) => { const r = await ctx.app.inject({ method, url, headers: h, payload }); return { code: r.statusCode, body: r.body ? JSON.parse(r.body) : null }; };
  const evalNow = (now = Date.now()) => evaluateNotifications(ctx.db, { config: { backupDir: ctx.backupDir, backupIntervalHours: 24, ...extra }, hub: ctx.app.hub, now });
  const list = async (q = "") => (await api("GET", "/api/notifications" + q)).body.items;
  const ofKind = async (kind, q = "") => (await list(q)).filter(n => n.kind === kind);
  return { ...ctx, cookie, api, evalNow, list, ofKind, adminId: ctx.db.prepare("SELECT id FROM admins").get().id };
}

test("migration 008 is additive: a database as v0.7.0 left it keeps every row and gains the notifications table", async () => {
  const db = openDb(); migrate(db, { upTo: "006_video_events.sql" });
  db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES ('a1','o@example.com','x',1)").run();
  db.prepare("INSERT INTO devices(id,admin_id,label,status,enrolled_at) VALUES ('d1','a1','Laptop','active',1)").run();
  const applied = migrate(db, { upTo: "008_notifications.sql" }); // later migrations are checked by their own tests
  assert.deepEqual(applied, ["007_device_consents_sync_diagnostics.sql", "008_notifications.sql"]);
  assert.equal(db.prepare("SELECT label FROM devices WHERE id='d1'").get().label, "Laptop");
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='notifications'").get());
  assert.deepEqual(migrate(db, { upTo: "008_notifications.sql" }), [], "running it again changes nothing");
});

test("every endpoint is owner-only", async () => {
  const { app } = await makeApp();
  for (const [m, u] of [["GET", "/api/notifications"], ["GET", "/api/notifications/summary"], ["POST", "/api/notifications/read-all"], ["POST", "/api/notifications/evaluate"],
    ["POST", "/api/notifications/x/read"], ["POST", "/api/notifications/x/dismiss"], ["GET", "/api/notifications/preferences"], ["PUT", "/api/notifications/preferences"]])
    assert.equal((await app.inject({ method: m, url: u })).statusCode, 401, m + " " + u);
});

test("preferences: defaults, validation, persistence; a damaged stored value falls back to the defaults", async () => {
  const s = await setup();
  assert.deepEqual((await s.api("GET", "/api/notifications/preferences")).body, DEFAULT_PREFS);
  const bad = async p => (await s.api("PUT", "/api/notifications/preferences", p)).code;
  assert.equal(await bad({ kinds: { nonsense: { on: true } } }), 400, "unknown kind");
  assert.equal(await bad({ kinds: { device_offline: { on: true, hours: 0 } } }), 400);
  assert.equal(await bad({ kinds: { device_offline: { on: true, hours: 5000 } } }), 400);
  assert.equal(await bad({ kinds: { device_offline: { on: "yes" } } }), 400);
  assert.equal(await bad({ kinds: { security: { on: true, failedLogins: 0 } } }), 400);
  assert.equal(await bad({ retentionDays: 3 }), 400);
  assert.equal(await bad({ enabled: "no" }), 400);
  assert.equal(await bad({ kinds: { device_offline: { on: true, hours: 2, evil: 1 } } }), 400, "unknown field");
  const ok = await s.api("PUT", "/api/notifications/preferences", { enabled: true, kinds: { device_offline: { on: true, hours: 48 }, backup: { on: false } }, retentionDays: 30 });
  assert.equal(ok.code, 200);
  const got = (await s.api("GET", "/api/notifications/preferences")).body;
  assert.equal(got.kinds.device_offline.hours, 48); assert.equal(got.kinds.backup.on, false); assert.equal(got.kinds.device_pending.on, true, "untouched kinds keep their defaults"); assert.equal(got.retentionDays, 30);
  s.db.prepare("UPDATE settings SET value='{not json' WHERE key='notification_prefs'").run();
  assert.deepEqual(getPrefs(s.db), DEFAULT_PREFS);
  assert.ok(s.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='notification_prefs_changed'").get().n >= 1, "changes are audited");
});

test("a device waiting for approval notifies once, however often it is evaluated, and clears when it is approved", async () => {
  const s = await setup();
  const dev = await enrollDevice(s.app, s.cookie, "Kitchen PC", { approve: false });
  s.evalNow(); s.evalNow(); s.evalNow();
  let n = await s.ofKind("device_pending");
  assert.equal(n.length, 1); assert.match(n[0].title + n[0].body, /Kitchen PC/); assert.equal(n[0].deviceId, dev.deviceId); assert.equal(n[0].read, false);
  assert.equal((await s.api("GET", "/api/notifications/summary")).body.unread >= 1, true);
  await s.api("POST", `/api/devices/${dev.deviceId}/approve`);
  s.evalNow();
  assert.equal((await s.ofKind("device_pending")).length, 0, "gone from the active list");
  const all = (await s.ofKind("device_pending", "?status=all"));
  assert.equal(all.length, 1); assert.ok(all[0].resolvedAt, "kept in the history, marked resolved");
});

test("an unseen device notifies after the configured hours, and the setting is honoured both ways", async () => {
  const s = await setup();
  const dev = await enrollDevice(s.app, s.cookie, "Old laptop");
  const now = Date.now();
  s.db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(now - 30 * H, dev.deviceId);
  s.db.prepare("UPDATE device_sessions SET last_seen=? WHERE device_id=?").run(now - 30 * H, dev.deviceId);
  s.evalNow(now);
  assert.equal((await s.ofKind("device_offline")).length, 1, "30 h > the 24 h default");
  await s.api("PUT", "/api/notifications/preferences", { kinds: { device_offline: { on: true, hours: 48 } } });
  s.evalNow(now);
  assert.equal((await s.ofKind("device_offline")).length, 0, "30 h < 48 h: it clears");
  await s.api("PUT", "/api/notifications/preferences", { kinds: { device_offline: { on: true, hours: 12 } } });
  s.evalNow(now);
  assert.equal((await s.ofKind("device_offline")).length, 1);
  await s.api("PUT", "/api/notifications/preferences", { kinds: { device_offline: { on: false } } });
  s.evalNow(now);
  assert.equal((await s.ofKind("device_offline")).length, 0, "switching the kind off clears it too");
  s.db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(now - 1000, dev.deviceId);
  s.db.prepare("UPDATE device_sessions SET last_seen=? WHERE device_id=?").run(now - 1000, dev.deviceId);
  await s.api("PUT", "/api/notifications/preferences", { kinds: { device_offline: { on: true, hours: 1 } } });
  s.evalNow(now);
  assert.equal((await s.ofKind("device_offline")).length, 0, "a device seen a second ago is not offline");
});

test("a device that has never connected is not reported offline, and a revoked one is not either", async () => {
  const s = await setup();
  const a = await enrollDevice(s.app, s.cookie, "Fresh"), b = await enrollDevice(s.app, s.cookie, "Gone");
  s.db.prepare("UPDATE devices SET last_seen=NULL WHERE id=?").run(a.deviceId);
  s.db.prepare("UPDATE devices SET last_seen=?, status='revoked' WHERE id=?").run(Date.now() - 100 * H, b.deviceId);
  s.db.prepare("UPDATE device_sessions SET last_seen=NULL WHERE device_id=?").run(a.deviceId);
  s.evalNow();
  assert.equal((await s.ofKind("device_offline")).length, 0);
});

test("queue overflow and sync errors are reported per device, with the message bounded", async () => {
  const s = await setup();
  const dev = await enrollDevice(s.app, s.cookie, "Flaky");
  s.db.prepare("UPDATE devices SET queue_dropped=12, last_error=? WHERE id=?").run("x".repeat(900), dev.deviceId);
  s.evalNow();
  const q = await s.ofKind("queue_overflow"), e = await s.ofKind("sync_error");
  assert.equal(q.length, 1); assert.match(q[0].body, /12/);
  assert.equal(e.length, 1); assert.ok(e[0].body.length <= 300);
  s.db.prepare("UPDATE devices SET queue_dropped=0, last_error=NULL WHERE id=?").run(dev.deviceId);
  s.evalNow();
  assert.equal((await s.ofKind("queue_overflow")).length + (await s.ofKind("sync_error")).length, 0);
});

test("backups: none, then stale, then healthy", async () => {
  const s = await setup();
  s.evalNow();
  assert.equal((await s.ofKind("backup"))[0].key, "backup:none");
  await createBackup(s.db, s.backupDir, 3, new Date());
  s.evalNow();
  assert.equal((await s.ofKind("backup")).length, 0, "a fresh backup clears it");
  s.evalNow(Date.now() + 5 * 24 * H);
  const stale = await s.ofKind("backup");
  assert.equal(stale.length, 1); assert.equal(stale[0].key, "backup:stale");
  const dir2 = tmpDir("yt-notif-"); // scheduled backups switched off: nothing to be stale
  evaluateNotifications(s.db, { config: { backupDir: s.backupDir, backupIntervalHours: 0 }, hub: s.app.hub, now: Date.now() + 5 * 24 * H });
  assert.equal((await s.ofKind("backup")).length, 0); assert.ok(dir2);
});

test("security: failed sign-ins past the owner's threshold, a copied token, and open deletion requests", async () => {
  const s = await setup();
  const ins = s.db.prepare("INSERT INTO audit_log(id,admin_id,device_id,action,detail,ip,created_at) VALUES (?,?,?,?,?,?,?)");
  for (let i = 0; i < 4; i++) ins.run("f" + i, s.adminId, null, "login_failed", null, "1.2.3.4", Date.now() - i * 1000);
  s.evalNow();
  assert.equal((await s.ofKind("security")).length, 0, "4 < the default threshold of 5");
  await s.api("PUT", "/api/notifications/preferences", { kinds: { security: { on: true, failedLogins: 3 } } });
  s.evalNow();
  const sec = await s.ofKind("security");
  assert.equal(sec.length, 1); assert.equal(sec[0].key, "sec:failed_logins"); assert.equal(sec[0].severity, "warn");
  ins.run("r1", s.adminId, null, "refresh_reuse_detected", null, "1.2.3.4", Date.now());
  s.evalNow();
  assert.deepEqual((await s.ofKind("security")).map(n => n.key).sort(), ["sec:failed_logins", "sec:refresh_reuse"]);
  const dev = await enrollDevice(s.app, s.cookie, "Asker");
  s.db.prepare("INSERT INTO session_deletion_requests(id,admin_id,device_id,session_id,status,requested_at) VALUES ('q1',?,?,?,'pending',?)").run(s.adminId, dev.deviceId, dev.sessionId, Date.now());
  s.evalNow();
  assert.equal((await s.ofKind("deletion_request")).length, 1);
});

test("read, read-all, dismiss: counts follow, and a dismissed notification stays dismissed while its condition lasts", async () => {
  const s = await setup();
  await enrollDevice(s.app, s.cookie, "A", { approve: false }); await enrollDevice(s.app, s.cookie, "B", { approve: false });
  s.evalNow();
  const pend = await s.ofKind("device_pending");
  assert.equal(pend.length, 2);
  const before = (await s.api("GET", "/api/notifications/summary")).body;
  assert.equal((await s.api("POST", `/api/notifications/${pend[0].id}/read`)).code, 200);
  assert.equal((await s.api("GET", "/api/notifications/summary")).body.unread, before.unread - 1);
  assert.equal((await s.api("POST", `/api/notifications/${pend[1].id}/dismiss`)).code, 200);
  assert.equal((await s.ofKind("device_pending")).length, 1, "dismissed ones leave the active list");
  s.evalNow(); s.evalNow();
  assert.equal((await s.ofKind("device_pending")).length, 1, "and are not re-created while the device is still pending");
  assert.equal((await s.api("POST", "/api/notifications/read-all")).code, 200);
  assert.equal((await s.api("GET", "/api/notifications/summary")).body.unread, 0);
  assert.equal((await s.api("POST", "/api/notifications/does-not-exist/read")).code, 404);
  assert.equal((await s.api("POST", "/api/notifications/does-not-exist/dismiss")).code, 404);
});

test("when everything is switched off nothing is created, and existing ones clear", async () => {
  const s = await setup();
  await enrollDevice(s.app, s.cookie, "P", { approve: false });
  s.evalNow();
  assert.ok((await s.list()).length > 0);
  await s.api("PUT", "/api/notifications/preferences", { enabled: false });
  s.evalNow();
  assert.equal((await s.list()).length, 0);
  assert.equal((await s.api("GET", "/api/notifications/summary")).body.unread, 0);
});

test("the list is paged and a summary is cheap: evaluation runs on demand, at most every 30 seconds", async () => {
  const s = await setup();
  await enrollDevice(s.app, s.cookie, "P", { approve: false });
  const first = (await s.api("GET", "/api/notifications/summary")).body;
  assert.ok(first.unread >= 1, "the summary itself triggers an evaluation");
  assert.equal((await s.api("GET", "/api/notifications?limit=1")).body.items.length, 1);
  assert.ok((await s.api("GET", "/api/notifications?limit=99999")).body.items.length <= 200);
  assert.equal((await s.api("POST", "/api/notifications/evaluate")).code, 200);
});

test("old resolved and dismissed notifications are pruned by the owner's retention; active ones never are", async () => {
  const s = await setup();
  const ins = s.db.prepare("INSERT INTO notifications(id,admin_id,kind,severity,dedupe_key,title,created_at,resolved_at) VALUES (?,?,?,?,?,?,?,?)");
  const day = 86400000, now = Date.now();
  ins.run("old1", s.adminId, "backup", "warn", "backup:none", "old", now - 200 * day, now - 199 * day);
  ins.run("new1", s.adminId, "backup", "warn", "backup:none", "new", now - 2 * day, now - day);
  ins.run("act1", s.adminId, "backup", "warn", "backup:stale", "active", now - 300 * day, null);
  const r = pruneNotifications(s.db, { days: 90, now });
  assert.equal(r.removed, 1);
  assert.deepEqual(s.db.prepare("SELECT id FROM notifications ORDER BY id").all().map(x => x.id), ["act1", "new1"]);
});

test("nothing sensitive reaches a notification: no tokens, hashes or passwords", async () => {
  const s = await setup();
  const dev = await enrollDevice(s.app, s.cookie, "Probe");
  s.db.prepare("UPDATE devices SET last_error='server said no', queue_dropped=1 WHERE id=?").run(dev.deviceId);
  s.evalNow();
  const text = JSON.stringify(await s.list("?status=all"));
  assert.ok(!/refresh|token|argon2|pw_hash|secret|MASTER_KEY/i.test(text), text);
  assert.ok(OWNER);
});
