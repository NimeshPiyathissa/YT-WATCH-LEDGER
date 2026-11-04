// Dashboard buttons and forms in a real headless Chrome: the new Notification Center, Security Center and Backup Manager screens are
// clicked the way the owner uses them (not only drawn). Throwaway server and database; skipped where there is no Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, enrollDevice, login, OWNER, PW } from "./helpers.js";

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
