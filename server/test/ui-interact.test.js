// Dashboard buttons and forms in a real headless Chrome: the new Notification Center, Security Center and Backup Manager screens are
// clicked the way the owner uses them (not only drawn). Throwaway server and database; skipped where there is no Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, enrollDevice, login, session, OWNER, PW } from "./helpers.js";

const { findChrome, launch } = await import("../../scripts/lib/chrome-ext.mjs");

test("clicking through Notifications, Security and Backups works in a real browser", { skip: findChrome() ? false : "no Chrome or Chromium found", timeout: 120000 }, async () => {
  const { app, db } = await makeApp(); await addOwner(db);
  const cookie = await login(app);
  await enrollDevice(app, cookie, "Waiting laptop", { approve: false });
  await app.inject({ method: "POST", url: "/api/system/backup", headers: { cookie } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = "http://127.0.0.1:" + app.server.address().port;
  const savedBase = process.env.BASE_URL; process.env.BASE_URL = url; // state-changing requests must come from the server's own origin (the cross-site guard)
  const chrome = await launch({ extensionDir: null });
  const steps = [];
  const check = (name, ok, detail = "") => { steps.push({ name, ok }); console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  (" + detail + ")" : "")); };
  let tab;
  try {
    tab = await chrome.openTab(url + "/");
    const ev = expr => chrome.evalIn(tab, expr, { userGesture: true });
    const until = (expr, ms = 10000) => chrome.waitFor(() => ev(expr), { timeout: ms, step: 150 });
    await until("!!document.getElementById('app')");
    const st = await ev(`fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({email:${JSON.stringify(OWNER)},password:${JSON.stringify(PW)}})}).then(r=>r.status)`);
    check("sign-in", st === 200);
    const go = async hash => { await ev(`document.getElementById('app').innerHTML=''; location.hash=${JSON.stringify(hash)}; 1`); return until("!!document.querySelector('#app h1') && !document.querySelector('#app .skel')"); };

    // ---- Notifications ----
    check("notifications page draws", await go("#/notifications"));
    check("a pending device shows as an unread notification", await until("!!document.querySelector('.notif.unread')"));
    check("the sidebar badge counts it", await until("(() => { const b = document.getElementById('notifBadge'); return !!b && !b.hidden && Number(b.textContent) >= 1; })()"));
    const unread0 = await ev("document.querySelectorAll('.notif.unread').length");
    await ev("document.querySelector('[data-read]').click(); 1");
    check("Mark read turns exactly one item from new to read", await until(`document.querySelectorAll('.notif.unread').length === ${unread0 - 1}`));
    const before = await ev("document.querySelectorAll('.notif').length");
    await ev("document.querySelector('[data-dismiss]').click(); 1");
    check("Dismiss removes it from the active list", await until(`document.querySelectorAll('.notif').length < ${before}`));
    await ev("document.getElementById('ntAll').click(); 1");
    check("Mark all read empties the badge", await until("document.getElementById('notifBadge').hidden === true"));
    await ev("document.getElementById('ntVAll').click(); 1");
    check("History shows the dismissed one", await until("document.querySelectorAll('.notif').length >= 1"));
    await ev("(() => { const i = document.querySelector('[data-th=\"device_offline\"]'); i.value = '12'; document.getElementById('npForm').requestSubmit(); return 1; })()");
    check("saving a threshold shows the confirmation", await until("(document.getElementById('toast').textContent || '').includes('saved') && !document.getElementById('toast').hidden"));
    await go("#/audit"); await go("#/notifications");
    check("...and it is still there after leaving and coming back", await until("(document.querySelector('[data-th=\"device_offline\"]') || {}).value === '12'"));
    await ev("(() => { const i = document.querySelector('[data-th=\"device_offline\"]'); i.value = '0'; return 1; })()");
    check("a threshold outside its range is refused by the form itself", await ev("document.getElementById('npForm').checkValidity() === false"));

    // ---- Security ----
    check("security page draws", await go("#/security"));
    // two sign-ins exist: the one made by the test's own helper, and this browser's
    check("the list shows two sign-ins, one marked as this browser", await until("document.querySelectorAll('#scBody tbody tr').length === 2 && /This browser/.test(document.getElementById('scBody').textContent)"));
    await ev("document.getElementById('scOthers').click(); 1");
    check("'sign out everywhere else' asks first", await until("!!document.querySelector('dialog.dlg[open]')"));
    await ev("document.querySelector('dialog.dlg [data-r=\"1\"]').click(); 1");
    check("it ends the other sign-in and keeps this one", await until("/Signed out 1 other/.test(document.getElementById('toast').textContent) && document.querySelectorAll('#scBody tbody tr').length === 1"));
    await ev("(() => { document.getElementById('scCur').value = 'x'.repeat(14); document.getElementById('scNew').value = 'a long new passphrase'; document.getElementById('scNew2').value = 'a different passphrase'; document.getElementById('scForm').requestSubmit(); return 1; })()");
    check("mismatched new passwords are caught before anything is sent", await until("!document.getElementById('scErr').hidden && /do not match/.test(document.getElementById('scErr').textContent)"));
    await ev("(() => { document.getElementById('scNew2').value = 'a long new passphrase'; document.getElementById('scForm').requestSubmit(); return 1; })()");
    check("a wrong current password is reported plainly", await until("/not your current password/.test(document.getElementById('scErr').textContent)"));
    await ev("document.getElementById('scAll').click(); 1");
    check("'sign out everywhere' asks first", await until("!!document.querySelector('dialog.dlg[open]')"));
    await ev("document.querySelector('dialog.dlg [data-r=\"0\"]').click(); 1");
    check("cancelling leaves you signed in on the same page", await until("!document.querySelector('dialog.dlg') && location.hash === '#/security'"));
    check("the password was not changed by those attempts", (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } })).statusCode === 200);

    // ---- Backups ----
    check("data page draws", await go("#/data"));
    await ev("document.querySelector('[data-verify]').click(); 1");
    check("Verify reports that the backup can be restored", await until("/Can be restored/.test((document.getElementById('bkVerify') || {}).textContent || '')"));
  } finally { process.env.BASE_URL = savedBase; await chrome.close(); await app.close(); }
  const failed = steps.filter(s => !s.ok);
  assert.deepEqual(failed.map(f => f.name), [], `${steps.length - failed.length}/${steps.length} interaction checks passed`);
});

test("clicking through Settings Studio works in a real browser: dirty tracking, saving, validation, the retention confirmation, resetting, and the owner's preferences", { skip: findChrome() ? false : "no Chrome or Chromium found", timeout: 150000 }, async () => {
  const { app, db } = await makeApp(); await addOwner(db);
  const cookie = await login(app);
  const dev = await enrollDevice(app, cookie, "Archive laptop");
  const now = Date.now(), DAY = 86400000;
  const mk = (id, days) => session(id, "vid" + id, { startTs: now - days * DAY, endTs: now - days * DAY + 60000, updatedAt: now });
  await app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions: [mk("o1", 200), mk("o2", 120), mk("n1", 2)] } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = "http://127.0.0.1:" + app.server.address().port;
  const savedBase = process.env.BASE_URL; process.env.BASE_URL = url;
  const chrome = await launch({ extensionDir: null });
  const steps = [];
  const check = (name, ok, detail = "") => { steps.push({ name, ok }); console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  (" + detail + ")" : "")); };
  const sessions = () => db.prepare("SELECT COUNT(*) n FROM sessions").get().n;
  let tab;
  try {
    tab = await chrome.openTab(url + "/");
    const ev = expr => chrome.evalIn(tab, expr, { userGesture: true });
    const until = (expr, ms = 10000) => chrome.waitFor(() => ev(expr), { timeout: ms, step: 150 });
    await until("!!document.getElementById('app')");
    await ev(`fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({email:${JSON.stringify(OWNER)},password:${JSON.stringify(PW)}})}).then(r=>r.status)`);
    const go = async hash => { await ev(`if (location.hash === ${JSON.stringify(hash)}) location.hash = '#/audit'; 1`); await new Promise(r => setTimeout(r, 150)); await ev(`document.getElementById('app').innerHTML=''; location.hash=${JSON.stringify(hash)}; 1`); return until("!!document.querySelector('#app h1') && !document.querySelector('#app .skel') && !!document.querySelector('.studio')"); };
    const setVal = (key, v) => ev(`(() => { const el = document.querySelector('[data-set="${key}"]'); if (el.type === 'checkbox') el.checked = ${JSON.stringify(v)}; else el.value = ${JSON.stringify(String(v))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
    const submitGroup = g => ev(`document.querySelector('form[data-group="${g}"]').requestSubmit(); 1`);

    check("settings page draws", await go("#/settings"));
    check("every section is there, including the read-only restart list", await ev("['retention','backups','security','notifications','preferences','restart'].every(k => !!document.getElementById('sec_' + k))"));
    check("the restart list names the variable and shows no secret", await ev("(() => { const t = document.getElementById('sec_restart').textContent; return /TRUST_PROXY/.test(t) && /ACCESS_TTL/.test(t) && !/MASTER_KEY|COOKIE_SECRET/.test(t); })()"));
    check("no save bar until something changes", await ev("[...document.querySelectorAll('.savebar')].every(b => b.hidden)"));
    await setVal("backup_keep", 5);
    check("changing a value shows the save bar for that section only", await ev("!document.querySelector('form[data-group=\"backups\"] .savebar').hidden && document.querySelector('form[data-group=\"retention\"] .savebar').hidden"));
    await ev("document.querySelector('form[data-group=\"backups\"] [data-discard]').click(); 1");
    check("Discard puts the value back and hides the bar", await ev("document.querySelector('[data-set=\"backup_keep\"]').value === '14' && document.querySelector('form[data-group=\"backups\"] .savebar').hidden"));
    await setVal("backup_keep", 0);
    check("an out-of-range number is refused by the form before anything is sent", await ev("(() => { document.querySelector('form[data-group=\"backups\"]').requestSubmit(); return document.querySelector('[data-set=\"backup_keep\"]').validity.valid === false; })()"));
    await setVal("backup_keep", 5); await submitGroup("backups");
    check("saving shows a confirmation", await until("/Saved\\. 1 setting changed/.test(document.getElementById('toast').textContent)"));
    check("...and the server really stored it", db.prepare("SELECT value FROM settings WHERE key='setting.backup_keep'").get()?.value === "5");
    check("...and the audit log recorded the old and new value", /"from":14,"to":5/.test(db.prepare("SELECT detail FROM audit_log WHERE action='settings_changed'").get()?.detail || ""));
    await go("#/audit"); await go("#/settings");
    check("after leaving and coming back the value and its 'Your setting' label are there", await until("document.querySelector('[data-set=\"backup_keep\"]').value === '5' && /Your setting/.test(document.querySelector('[data-row=\"backup_keep\"]').textContent)"));
    await ev("document.querySelector('[data-reset=\"backup_keep\"]').click(); 1");
    check("'Use the server default' goes back to 14", await until("document.querySelector('[data-set=\"backup_keep\"]').value === '14'") && db.prepare("SELECT COUNT(*) n FROM settings WHERE key='setting.backup_keep'").get().n === 0);

    // retention: the owner is shown the count first
    await go("#/settings");
    await setVal("server_retention_days", 30); await submitGroup("retention");
    check("shortening retention asks first and says how many sessions go", await until("!!document.querySelector('dialog.dlg[open]') && /Delete 2 old sessions/.test(document.querySelector('dialog.dlg').textContent)"));
    await ev("document.querySelector('dialog.dlg [data-r=\"0\"]').click(); 1");
    await new Promise(r => setTimeout(r, 400));
    check("cancelling deletes nothing and stores nothing", sessions() === 3 && !db.prepare("SELECT 1 FROM settings WHERE key='server_retention_days' AND value='30'").get());
    await submitGroup("retention");
    await until("!!document.querySelector('dialog.dlg[open]')");
    await ev("document.querySelector('dialog.dlg [data-r=\"1\"]').click(); 1");
    check("confirming removes exactly those sessions and says so", await until("/2 old sessions removed/.test(document.getElementById('toast').textContent)") && sessions() === 1);

    // notifications inside the studio
    await go("#/settings");
    check("notification thresholds are editable here too", await until("!!document.querySelector('#stNotif [data-th=\"device_offline\"]')"));
    await ev("(() => { const i = document.querySelector('#stNotif [data-th=\"device_offline\"]'); i.value = '60'; document.getElementById('npForm').requestSubmit(); return 1; })()");
    check("saving them confirms and stores them", await until("/Notification settings saved/.test(document.getElementById('toast').textContent)") && JSON.parse(db.prepare("SELECT value FROM settings WHERE key='notification_prefs'").get().value).kinds.device_offline.hours === 60);

    // the owner's preferences
    await go("#/settings");
    await setVal("compact_tables", true); await setVal("default_page", "analytics"); await submitGroup("preferences");
    check("compact tables apply at once", await until("document.body.classList.contains('compact-tables')"));
    await ev("history.replaceState(null, '', location.pathname); location.reload(); 1");
    check("a fresh visit without a link opens the chosen page", await until("location.hash === '#/analytics'", 15000));
    await ev("location.hash = '#/devices'; 1");
    check("a link to another page is never overridden", await until("!!document.querySelector('#app h1') && location.hash === '#/devices'"));
  } finally { process.env.BASE_URL = savedBase; await chrome.close(); await app.close(); }
  const failed = steps.filter(s => !s.ok);
  assert.deepEqual(failed.map(f => f.name), [], `${steps.length - failed.length}/${steps.length} Settings Studio checks passed`);
});
