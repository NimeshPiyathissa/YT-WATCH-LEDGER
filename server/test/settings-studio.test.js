// Settings Studio: every editable setting is validated by the server, stored, audited and applied without a restart; everything that
// does need a restart is shown read-only with the variable that controls it. Owner-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeApp, addOwner, login, enrollDevice, session, OWNER } from "./helpers.js";
import { createBackup, listBackups } from "../src/lib/backup.js";
import { resolveInt, applyRuntime, SETTINGS, READONLY } from "../src/lib/settings.js";
import { runDueBackup } from "../src/lib/backupSchedule.js";
import { runHousekeeping } from "../src/lib/housekeeping.js";
import { previewRetention, purgeAll } from "../src/lib/retention.js";
import { openDb, migrate } from "../src/db.js";
import { tmpDir } from "./tmpdir.js";

const H = 3600000, DAY = 86400000;
async function setup() {
  const ctx = await makeApp(); await addOwner(ctx.db);
  const cookie = await login(ctx.app), h = { cookie };
  const api = async (method, url, payload) => { const r = await ctx.app.inject({ method, url, headers: h, payload }); return { code: r.statusCode, body: r.body ? JSON.parse(r.body) : null }; };
  const put = changes => api("PUT", "/api/settings/studio", { changes });
  const get = async () => (await api("GET", "/api/settings/studio")).body;
  const item = async key => { for (const g of (await get()).groups) for (const i of g.items) if (i.key === key) return i; return null; };
  return { ...ctx, cookie, api, put, get, item, adminId: ctx.db.prepare("SELECT id FROM admins").get().id };
}

/* ---- A22: found while auditing the existing settings ---- */
test("A22: an invalid BACKUP_KEEP (not a number) used to delete every backup, including the one just made", async () => {
  const dir = tmpDir("yt-keep-"), db = openDb(); migrate(db);
  for (const keep of [Number("abc"), undefined, 0, -3, 2.9, Infinity]) {
    const bk = path.join(dir, String(keep));
    await createBackup(db, bk, 5, new Date(Date.UTC(2026, 0, 1))); await createBackup(db, bk, 5, new Date(Date.UTC(2026, 0, 2)));
    const r = await createBackup(db, bk, keep, new Date(Date.UTC(2026, 0, 3)));
    const left = listBackups(bk).map(b => b.name);
    assert.ok(left.includes(r.name), `keep=${keep}: the new backup survives`);
    assert.ok(left.length >= 1 && left.length <= 14, `keep=${keep}: ${left.length} left`);
  }
  assert.equal(listBackups(path.join(dir, "2.9")).length, 2, "a fractional keep is rounded down");
});

test("resolveInt: environment values are accepted only when they are whole numbers in range, otherwise the default is used and reported", () => {
  const spec = { min: 1, max: 365, def: 14 };
  assert.deepEqual(resolveInt("30", spec), { value: 30, valid: true });
  assert.deepEqual(resolveInt(undefined, spec), { value: 14, valid: true, unset: true });
  assert.deepEqual(resolveInt("", spec), { value: 14, valid: true, unset: true });
  for (const bad of ["abc", "0", "-1", "1.5", "99999", "NaN", "1e3x"]) assert.deepEqual(resolveInt(bad, spec), { value: 14, valid: false }, bad);
});

/* ---- reading ---- */
test("the studio is owner-only, and a cross-site write is refused", async () => {
  const { app, cookie } = await setup().then(s => ({ app: s.app, cookie: s.cookie }));
  for (const [m, u] of [["GET", "/api/settings/studio"], ["PUT", "/api/settings/studio"], ["GET", "/api/settings/retention-preview?days=30"]]) assert.equal((await app.inject({ method: m, url: u })).statusCode, 401, m + " " + u);
  assert.equal((await app.inject({ method: "PUT", url: "/api/settings/studio", headers: { cookie, origin: "https://evil.example" }, payload: { changes: { backup_keep: 5 } } })).statusCode, 403);
});

test("GET shows every setting with its value, where it came from and its limits; restart-only settings are listed read-only; no secret or path appears", async () => {
  const s = await setup(); const g = await s.get();
  const keys = g.groups.flatMap(x => x.items.map(i => i.key));
  for (const k of Object.keys(SETTINGS)) assert.ok(keys.includes(k), k + " is shown");
  const keep = await s.item("backup_keep");
  assert.deepEqual([keep.type, keep.min, keep.max, keep.restart, keep.editable], ["int", 1, 365, false, true]);
  assert.ok(["environment", "default", "owner"].includes(keep.source));
  assert.equal(g.restartRequired.every(r => r.editable === false && r.restart === true && /^[A-Z_]+$/.test(r.env)), true);
  for (const name of READONLY) assert.ok(g.restartRequired.some(r => r.env === name), name + " listed");
  const text = JSON.stringify(g);
  assert.ok(!/MASTER_KEY|COOKIE_SECRET|pw_hash|argon2/i.test(text.replace(/"env":"[A-Z_]+"/g, "")), "no secrets");
  assert.ok(!/[A-Za-z]:\\|\/tmp\/|yt-test-bk/.test(text), "no filesystem paths");
  assert.ok(Array.isArray(g.warnings));
});

test("a bad value in the server's environment is reported as a warning, and the default is used", async () => {
  const s = await setup(); const saved = process.env.BACKUP_KEEP; process.env.BACKUP_KEEP = "fourteen";
  try {
    const g = await s.get();
    assert.equal((await s.item("backup_keep")).value, 14);
    assert.ok(g.warnings.some(w => /BACKUP_KEEP/.test(w)), JSON.stringify(g.warnings));
  } finally { if (saved === undefined) delete process.env.BACKUP_KEEP; else process.env.BACKUP_KEEP = saved; }
});

/* ---- writing ---- */
test("validation: unknown keys, wrong types, out-of-range, fractions, read-only settings and empty requests are all refused, and nothing is stored", async () => {
  const s = await setup();
  const code = async c => (await s.put(c)).code;
  assert.equal(await code({ nope: 1 }), 400, "unknown key");
  assert.equal(await code({ backup_keep: 0 }), 400); assert.equal(await code({ backup_keep: 366 }), 400);
  assert.equal(await code({ backup_keep: 5.5 }), 400); assert.equal(await code({ backup_keep: "5" }), 400); assert.equal(await code({ backup_keep: null === 1 }), 400);
  assert.equal(await code({ backup_interval_hours: -1 }), 400); assert.equal(await code({ backup_interval_hours: 721 }), 400);
  assert.equal(await code({ pairing_code_ttl_min: 0 }), 400); assert.equal(await code({ pairing_max_fails: 51 }), 400);
  assert.equal(await code({ audit_retention_days: 29 }), 400); assert.equal(await code({ server_retention_days: -5 }), 400); assert.equal(await code({ server_retention_days: 3651 }), 400);
  assert.equal(await code({ default_page: "../../etc" }), 400); assert.equal(await code({ compact_tables: "yes" }), 400);
  const ro = await s.put({ TRUST_PROXY: true }); assert.equal(ro.code, 400); assert.equal(ro.body.error, "restart_required");
  assert.equal(await code({}), 400, "nothing to change");
  assert.equal((await s.api("PUT", "/api/settings/studio", "nope")).code, 400);
  assert.equal((await s.api("PUT", "/api/settings/studio", { changes: [1] })).code, 400);
  assert.equal(await code({ backup_keep: 5, pairing_max_fails: 999 }), 400, "one bad value rejects the whole request");
  assert.equal((await s.item("backup_keep")).source !== "owner", true, "the valid half of a rejected request was not saved");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'setting.%'").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='settings_changed'").get().n, 0, "rejected requests are not 'changes'");
});

test("saving stores the value, reports what changed, and a later read shows it as the owner's setting; null puts the server default back", async () => {
  const s = await setup();
  const r = await s.put({ backup_keep: 7, pairing_max_fails: 3, default_page: "devices", compact_tables: true });
  assert.equal(r.code, 200); assert.deepEqual(r.body.changed.map(c => c.key).sort(), ["backup_keep", "compact_tables", "default_page", "pairing_max_fails"]);
  assert.equal(r.body.restartRequired, false);
  for (const [k, v] of [["backup_keep", 7], ["pairing_max_fails", 3], ["default_page", "devices"], ["compact_tables", true]]) { const i = await s.item(k); assert.equal(i.value, v, k); assert.equal(i.source, "owner", k); }
  const back = await s.put({ backup_keep: null });
  assert.equal(back.code, 200);
  const i = await s.item("backup_keep"); assert.notEqual(i.source, "owner"); assert.equal(i.value, 14);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM settings WHERE key='setting.backup_keep'").get().n, 0);
});

test("every change is audited with old and new values; an unchanged value writes nothing", async () => {
  const s = await setup();
  await s.put({ backup_keep: 9 });
  const rows = s.db.prepare("SELECT detail FROM audit_log WHERE action='settings_changed'").all().map(r => JSON.parse(r.detail));
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].changes, [{ key: "backup_keep", from: 14, to: 9 }]);
  const again = await s.put({ backup_keep: 9 });
  assert.deepEqual(again.body.changed, []);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='settings_changed'").get().n, 1);
});

test("changes apply at once, no restart: backup keep, pairing code lifetime and the wrong-code lock-out", async () => {
  const s = await setup();
  await s.put({ backup_keep: 2 });
  for (let i = 0; i < 4; i++) await s.api("POST", "/api/system/backup");
  assert.equal(listBackups(s.backupDir).length, 2, "the new keep count is used by the next backup");
  await s.put({ pairing_code_ttl_min: 3 });
  const code = (await s.api("POST", "/api/devices/enroll-code", {})).body;
  assert.ok(Math.abs(code.expiresAt - (Date.now() + 3 * 60000)) < 5000, "the new lifetime is used by the next code");
  await s.put({ pairing_max_fails: 2 });
  const bad = () => s.app.inject({ method: "POST", url: "/api/enroll", remoteAddress: "10.9.9.9", payload: { code: "ZZZZ-ZZZZ" } });
  assert.equal((await bad()).statusCode, 400); assert.equal((await bad()).statusCode, 400);
  assert.equal((await bad()).statusCode, 429, "locked out after the 2 wrong codes the owner chose");
});

test("the server's own limits survive a round trip through the owner's settings (interval 0 switches scheduled backups off)", async () => {
  const s = await setup();
  assert.equal((await s.put({ backup_interval_hours: 0 })).code, 200);
  assert.equal((await s.item("backup_interval_hours")).value, 0);
  assert.equal((await s.put({ backup_interval_hours: 6 })).code, 200);
  assert.equal((await s.item("backup_interval_hours")).value, 6);
});

/* ---- A24: found by the history test; applyRuntime overwrote the keep count the caller passed to buildApp with the default ---- */
test("A24: a backupKeep given by the caller stands unless the owner or the environment sets one explicitly", async () => {
  const s = await setup();                                  // makeApp() passes backupKeep: 3
  assert.equal(s.app.wlConfig.backupKeep, 3, "nothing set explicitly: the caller's 3 stands, not the default 14");
  assert.equal((await s.put({ backup_keep: 7 })).code, 200);
  assert.equal(s.app.wlConfig.backupKeep, 7, "the owner's value wins at once");
  assert.equal((await s.put({ backup_keep: null })).code, 200);
  assert.equal(s.app.wlConfig.backupKeep, 3, "'use the server default' returns to the caller's value");
  const cfg = { backupKeep: 3 };                            // the environment is explicit too, and beats the caller
  applyRuntime(s.db, cfg, { BACKUP_KEEP: "9" });
  assert.equal(cfg.backupKeep, 9);
  const bare = {};                                          // no caller value at all: the built-in default
  applyRuntime(s.db, bare, {});
  assert.deepEqual([bare.backupKeep, bare.backupIntervalHours], [14, 24]);
});

/* ---- retention, with a look before the leap ---- */
async function withSessions(s) {
  const dev = await enrollDevice(s.app, s.cookie, "Archive"), now = Date.now();
  const mk = (id, days) => session(id, "vid" + id, { startTs: now - days * DAY, endTs: now - days * DAY + 60000, updatedAt: now });
  await s.app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions: [mk("old1", 200), mk("old2", 120), mk("mid1", 45), mk("new1", 2)] } });
  return dev;
}
test("retention preview counts exactly what a shorter window would remove, and removes nothing itself", async () => {
  const s = await setup(); await withSessions(s);
  const total = () => s.db.prepare("SELECT COUNT(*) n FROM sessions").get().n;
  assert.equal(total(), 4);
  assert.equal((await s.api("GET", "/api/settings/retention-preview?days=30")).body.wouldRemove, 3);
  assert.equal((await s.api("GET", "/api/settings/retention-preview?days=90")).body.wouldRemove, 2);
  assert.equal((await s.api("GET", "/api/settings/retention-preview?days=0")).body.wouldRemove, 0);
  assert.equal((await s.api("GET", "/api/settings/retention-preview?days=abc")).code, 400);
  assert.equal(total(), 4, "a preview deletes nothing");
  assert.equal(previewRetention(s.db, 90), purgeAllCount(s.db, 90), "and it agrees with the real purge");
});
function purgeAllCount(db, days) { // run the real purge on a copy of the data
  const copy = openDb(); migrate(copy);
  const dump = t => db.prepare(`SELECT * FROM ${t}`).all();
  for (const t of ["admins", "devices", "sessions", "videos"]) for (const r of dump(t)) { const k = Object.keys(r); copy.prepare(`INSERT INTO ${t}(${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).run(...k.map(x => r[x])); }
  copy.prepare("INSERT INTO settings(key,value) VALUES('server_retention_days',?)").run(String(days));
  return purgeAll(copy);
}
test("a retention change that would delete data needs the exact number confirmed; one that deletes nothing does not", async () => {
  const s = await setup(); await withSessions(s);
  const r1 = await s.put({ server_retention_days: 30 });
  assert.equal(r1.code, 409); assert.equal(r1.body.error, "confirmation_required"); assert.equal(r1.body.wouldRemove, 3);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 4, "nothing removed without the confirmation");
  const wrong = await s.api("PUT", "/api/settings/studio", { changes: { server_retention_days: 30 }, confirmRemoveSessions: 1 });
  assert.equal(wrong.code, 409, "a different number is not a confirmation (the data changed since you looked)");
  const ok = await s.api("PUT", "/api/settings/studio", { changes: { server_retention_days: 30 }, confirmRemoveSessions: 3 });
  assert.equal(ok.code, 200); assert.equal(ok.body.removedSessions, 3);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
  const audit = s.db.prepare("SELECT detail FROM audit_log WHERE action='settings_changed'").all().map(r => JSON.parse(r.detail));
  assert.equal(audit[0].removedSessions, 3);
  assert.equal((await s.put({ server_retention_days: 365 })).code, 200, "lengthening needs no confirmation");
  assert.equal((await s.put({ server_retention_days: 0 })).code, 200);
});

test("the original /api/settings route keeps working exactly as before, and now also reports the admin preferences", async () => {
  const s = await setup();
  assert.deepEqual(Object.keys((await s.api("GET", "/api/settings")).body).sort(), ["compact_tables", "default_page", "server_retention_days"]);
  const r = await s.api("PUT", "/api/settings", { server_retention_days: 180 });
  assert.equal(r.code, 200); assert.equal(r.body.server_retention_days, 180);
  assert.equal((await s.item("server_retention_days")).value, 180, "the studio sees it");
  await s.put({ default_page: "analytics", compact_tables: true });
  const g = (await s.api("GET", "/api/settings")).body;
  assert.equal(g.default_page, "analytics"); assert.equal(g.compact_tables, true); assert.equal(g.server_retention_days, 180);
  assert.equal((await s.api("PUT", "/api/settings", { server_retention_days: -1 })).code, 400);
});

/* ---- schedulers and housekeeping read the settings ---- */
test("scheduled backups: due when none exists or the newest is older than the interval; never when the interval is 0; the owner's value wins at once", async () => {
  const s = await setup(); const cfg = { backupDir: s.backupDir, backupKeep: 3, backupIntervalHours: 24 }, now = Date.now();
  assert.equal((await runDueBackup(s.db, cfg, now)).ran, true, "none yet");
  assert.equal((await runDueBackup(s.db, cfg, now + 1000)).ran, false, "just made one");
  assert.equal((await runDueBackup(s.db, cfg, now + 23 * H)).ran, false);
  assert.equal((await runDueBackup(s.db, cfg, now + 25 * H)).ran, true);
  cfg.backupIntervalHours = 0;
  assert.equal((await runDueBackup(s.db, cfg, now + 900 * H)).ran, false, "0 switches scheduled backups off");
  cfg.backupIntervalHours = 1;
  assert.equal((await runDueBackup(s.db, cfg, now + 900 * H)).ran, true, "a shorter interval takes effect on the next check");
  cfg.backupDir = path.join(s.backupDir, "x", "\0bad");
  const bad = await runDueBackup(s.db, cfg, now + 1800 * H);
  assert.equal(bad.ran, false); assert.ok(bad.error, "a failure is reported, never thrown into the timer");
});

test("housekeeping uses the owner's audit retention for both of the places that prune the audit log", async () => {
  const s = await setup(); const ins = s.db.prepare("INSERT INTO audit_log(id,admin_id,device_id,action,detail,ip,created_at) VALUES (?,?,?,?,?,?,?)"), now = Date.now();
  ins.run("a1", s.adminId, null, "x", null, null, now - 400 * DAY); ins.run("a2", s.adminId, null, "x", null, null, now - 100 * DAY); ins.run("a3", s.adminId, null, "x", null, null, now - 10 * DAY);
  await s.put({ audit_retention_days: 800 });
  runHousekeeping(s.db, { now });
  assert.deepEqual(s.db.prepare("SELECT id FROM audit_log WHERE id IN ('a1','a2','a3') ORDER BY id").all().map(r => r.id), ["a1", "a2", "a3"], "400 days old is kept under an 800-day setting (a fixed 365 elsewhere used to delete it)");
  await s.put({ audit_retention_days: 60 });
  runHousekeeping(s.db, { now });
  assert.deepEqual(s.db.prepare("SELECT id FROM audit_log WHERE id IN ('a1','a2','a3') ORDER BY id").all().map(r => r.id), ["a3"]);
});

test("notification thresholds are part of the studio response and saved through the notification preferences (one source of truth)", async () => {
  const s = await setup();
  const g = await s.get();
  assert.equal(g.notifications.enabled, true); assert.equal(g.notifications.kinds.device_offline.hours, 24);
  await s.api("PUT", "/api/notifications/preferences", { kinds: { device_offline: { on: true, hours: 36 } } });
  assert.equal((await s.get()).notifications.kinds.device_offline.hours, 36);
  assert.ok(OWNER);
});
