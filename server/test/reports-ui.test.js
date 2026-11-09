// Reports Studio in a real headless Chrome: the owner's clicks, not only the drawing. Periods and the date navigator, the custom range
// check, filters, downloads, the print page after the sign-in cookie has expired (A25), saved reports, and the empty, error and phone
// layouts. Throwaway server and database; skipped where there is no Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { makeApp, addOwner, enrollDevice, login, session, OWNER, PW } from "./helpers.js";
import { midnightOf } from "../src/lib/reports.js";

const { findChrome, launch } = await import("../../scripts/lib/chrome-ext.mjs");
const require = createRequire(import.meta.url);
const P = require("../src/lib/playback.cjs");
const S = 1000, HOUR = 3600 * S, DAY = 24 * HOUR;

test("Reports Studio: periods, filters, exports, print, saved reports and every state work in a real browser", { skip: findChrome() ? false : "no Chrome or Chromium found", timeout: 180000 }, async () => {
  const { app, db } = await makeApp(); await addOwner(db);
  const cookie = await login(app);
  const lap = await enrollDevice(app, cookie, "Laptop"), phone = await enrollDevice(app, cookie, "Phone");
  const day = P.dayKey(Date.now() - 10 * DAY, "Asia/Colombo"), t = midnightOf(day) + 10 * HOUR;
  const push = (d, sessions) => app.inject({ method: "POST", url: "/api/sync/push", headers: d.auth, payload: { sessions } });
  await push(lap, [session("a", "vidA", { startTs: t, endTs: t + 600 * S, watchedMs: 600 * S, title: "Alpha video", channel: "Alpha channel" }),
    session("b", "vidB", { startTs: t + HOUR, endTs: t + HOUR + 300 * S, watchedMs: 300 * S, title: "Beta <b>video</b>", channel: "Beta channel" })]);
  await push(phone, [session("c", "vidC", { startTs: t + DAY, endTs: t + DAY + 120 * S, watchedMs: 120 * S, title: "Gamma video", channel: "Alpha channel" })]);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = "http://127.0.0.1:" + app.server.address().port;
  const savedBase = process.env.BASE_URL; process.env.BASE_URL = url; // writes must come from the server's own origin
  const chrome = await launch({ extensionDir: null });
  const steps = [];
  const check = (name, ok, detail = "") => { steps.push({ name, ok: !!ok }); console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  (" + detail + ")" : "")); };
  let tab;
  try {
    tab = await chrome.openTab(url + "/");
    const sid = await chrome.attach(tab);
    const ev = expr => chrome.evalIn(tab, expr, { userGesture: true });
    const until = (expr, ms = 10000) => chrome.waitFor(() => ev(expr), { timeout: ms, step: 150 });
    await until("!!document.getElementById('app')");
    check("sign-in", await ev(`fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({email:${JSON.stringify(OWNER)},password:${JSON.stringify(PW)}})}).then(r=>r.status)`) === 200);
    const settled = "!!document.getElementById('rpBody') && !document.getElementById('rpBody').hasAttribute('aria-busy') && !document.querySelector('#rpBody .skel')";
    const go = async hash => { await ev(`document.getElementById('app').innerHTML=''; location.hash=${JSON.stringify(hash)}; 1`); return until(settled); };
    const label = () => ev("(document.getElementById('rpPeriodLabel') || {}).textContent || ''");
    const total = () => ev("(document.getElementById('rpTotal') || {}).textContent || ''");
    const apiTotal = q => ev(`fetch("/api/reports?${q}",{credentials:"same-origin"}).then(r=>r.json()).then(j=>YTUtil.fmtDuration(j.totals.watchMs))`);
    const click = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
    const pick = (id, v) => ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("change")); return s.value; })()`);
    const loaded = async () => { await chrome.sleep(120); return until(settled); };

    // ---- the sidebar, and a weekly report that matches the server ----
    check("the sidebar has a Reports entry", await ev("!!document.querySelector('#nav a[data-nav=\"reports\"]')"));
    check("weekly report draws", await go(`#/reports?period=week&date=${day}`));
    check("the sidebar marks Reports as the current page", await ev("document.querySelector('#nav a[data-nav=\"reports\"]').classList.contains('active')"));
    const wk = await apiTotal(`period=week&date=${day}`);
    check("the weekly total on screen is the server's total", (await total()) === wk, wk);
    check("the label names the Monday-to-Sunday week", /^Week of Mon .* to Sun /.test(await label()), await label());
    check("device text is escaped, not run", await ev("document.body.innerHTML.includes('Beta &lt;b&gt;video&lt;/b&gt;') && !document.querySelector('#rpBody b b')"));

    // ---- periods and the navigator ----
    await click("[data-p='day']"); await loaded();
    check("Daily switches the report and the address", /period=day/.test(await ev("location.hash")) && (await apiTotal(`period=day&date=${day}`)) === (await total()));
    const before = await label();
    await click("#rpPrev"); await loaded();
    check("Previous goes back one day", (await label()) !== before && (await ev("location.hash")).includes("date=" + P.dayKey(midnightOf(day) - DAY / 2, "Asia/Colombo")), await label());
    await click("#rpNow"); await loaded();
    check("Current returns to today and the Next button is disabled there", !/date=/.test(await ev("location.hash")) && await ev("document.getElementById('rpNext').disabled"));
    await click("[data-p='month']"); await loaded();
    check("Monthly draws a day-by-day table", await until("document.querySelectorAll('.rp-days tbody tr').length >= 28"));

    // ---- custom range: checked before anything is sent ----
    await click("[data-p='custom']"); await loaded();
    await ev(`(() => { const f = document.getElementById("rpFrom"), t = document.getElementById("rpTo"); f.value = "${P.dayKey(midnightOf(day) + 2 * DAY, "Asia/Colombo")}"; f.dispatchEvent(new Event("change")); t.value = "${day}"; t.dispatchEvent(new Event("change")); return 1; })()`);
    check("an end date before the start is refused on the page, with the reason", await until("!document.getElementById('rpFormErr').hidden && /before the start/.test(document.getElementById('rpFormErr').textContent)"));
    await ev(`(() => { const t = document.getElementById("rpTo"); t.value = "${P.dayKey(midnightOf(day) + 3 * DAY, "Asia/Colombo")}"; t.dispatchEvent(new Event("change")); return 1; })()`);
    await loaded();
    check("a valid custom range loads", (await ev("document.getElementById('rpFormErr').hidden")) && /to/.test(await label()), await label());
    check("the custom total covers both devices", (await total()) === (await apiTotal(`period=custom&from=${P.dayKey(midnightOf(day) + 2 * DAY, "Asia/Colombo")}&to=${P.dayKey(midnightOf(day) + 3 * DAY, "Asia/Colombo")}`)));

    // ---- filters ----
    await go(`#/reports?period=week&date=${day}`);
    check("the channel menu lists what played", await until("[...document.querySelectorAll('#rpChannel option')].map(o => o.value).join('|') === '|Alpha channel|Beta channel'"));
    await pick("rpChannel", "Alpha channel"); await loaded();
    check("a channel filter narrows the total to that channel", (await total()) === (await apiTotal(`period=week&date=${day}&channel=Alpha%20channel`)) && (await total()) !== wk, await total());
    check("...shows it as a chip and offers Clear filters", /Alpha channel/.test(await ev("document.querySelector('.rp-chips').textContent")) && !(await ev("document.getElementById('rpClear').hidden")));
    await pick("rpDevice", phone.deviceId); await loaded();
    check("device + channel together", (await total()) === (await apiTotal(`period=week&date=${day}&channel=Alpha%20channel&device=${phone.deviceId}`)));
    await click("#rpClear"); await loaded();
    check("Clear filters returns to everything", (await total()) === wk && (await ev("document.getElementById('rpClear').hidden")));
    await click("[data-channel='Beta channel']"); await loaded();
    check("clicking a channel in the list filters to it", (await ev("document.getElementById('rpChannel').value")) === "Beta channel");
    await click("#rpClear"); await loaded();

    // ---- downloads ----
    await ev("window.__blobs = []; (o => { URL.createObjectURL = b => { window.__blobs.push(b); return o.call(URL, b); }; })(URL.createObjectURL); 1");
    await click("#rpExport");
    check("Download opens its menu", await until("!document.getElementById('rpExportMenu').hidden && document.getElementById('rpExport').getAttribute('aria-expanded') === 'true'"));
    await click("[data-ex='csv:days']");
    check("By day (CSV) downloads the day rows", await until("window.__blobs.length === 1"), "");
    const csv = await ev("window.__blobs[0].text()");
    check("...with a header and seven Sri Lanka days", csv.replace(/^﻿/, "").startsWith("day_slst,starts_utc,watch_seconds") && csv.trim().split("\r\n").length === 8);
    await click("#rpExport"); await click("[data-ex='json']");
    await until("window.__blobs.length === 2");
    const json = JSON.parse(await ev("window.__blobs[1].text()"));
    check("Everything (JSON) is the whole report, with the total shown on screen", json.kind === "watch-ledger-report" && json.timeZone === "Asia/Colombo" && (await ev(`YTUtil.fmtDuration(${json.totals.watchMs})`)) === wk && json.viewings.length === 3);
    await ev("document.getElementById('rpExport').click(); document.body.click(); 1");
    check("a click elsewhere closes the menu", await until("document.getElementById('rpExportMenu').hidden"));

    // ---- print after the sign-in cookie expired (A25) ----
    const printTabs = async () => (await chrome.targets()).filter(x => x.type === "page" && /format=print/.test(x.url));
    await chrome.send("Network.deleteCookies", { name: "at", url }, sid); // what the browser does when ACCESS_TTL runs out
    const direct = await ev(`fetch("/api/reports/export?format=print&period=week",{credentials:"same-origin"}).then(r=>r.status)`);
    check("control: without a fresh sign-in the print address answers 401 (what a directly opened tab showed)", direct === 401);
    await chrome.send("Network.deleteCookies", { name: "at", url }, sid);
    await click("#rpPrint");
    const pt = await chrome.waitFor(async () => (await printTabs())[0], { timeout: 10000 });
    check("Print / Save as PDF opens the report in a new tab", !!pt);
    if (pt) {
      const ptitle = await chrome.waitFor(() => chrome.evalIn(pt.targetId, "document.readyState === 'complete' && document.title"), { timeout: 10000 });
      check("...renewing the expired sign-in first, so the tab holds the report (not 'unauthorized')", /^Watch report — Week of/.test(ptitle || ""), ptitle);
      check("...with its Save as PDF button and Sri Lanka time", await chrome.evalIn(pt.targetId, "!!document.getElementById('printBtn') && /Sri Lanka Standard Time/.test(document.body.textContent)"));
      await chrome.closeTab(pt.targetId);
    }

    // ---- saved reports ----
    await pick("rpDevice", lap.deviceId); await loaded();
    check("nothing is saved yet", /Nothing saved yet/.test(await ev("document.getElementById('rpSavedList').textContent")));
    await click("#rpSave");
    check("Save asks for a name", await until("!!document.querySelector('dialog.dlg[open] #rpDlgName')"));
    await ev("(() => { const i = document.getElementById('rpDlgName'); i.value = ''; i.form.requestSubmit(); return 1; })()");
    check("an empty name is refused in the dialog", await until("!document.getElementById('rpDlgErr').hidden"));
    await ev("(() => { const i = document.getElementById('rpDlgName'); i.value = 'Laptop weekly'; i.form.requestSubmit(); return 1; })()");
    check("saving lists it, marked as open", await until("document.querySelector('.rp-saved-list li.open b') && document.querySelector('.rp-saved-list li.open b').textContent === 'Laptop weekly'"));
    check("...and it opens on the current week (no fixed date)", /Weekly report, current week/.test(await ev("document.querySelector('.rp-saved-list li.open .caption').textContent")));
    await go("#/audit"); await go("#/reports");
    check("it is still there after leaving and coming back", await until("document.querySelectorAll('.rp-saved-list li').length === 1"));
    await click("[data-open]"); await loaded();
    check("opening it applies its device filter", (await ev("document.getElementById('rpDevice').value")) === lap.deviceId && /saved=/.test(await ev("location.hash")));
    await pick("rpDevice", phone.deviceId); await loaded(); // the saved one opens on the current week, so change something always offered
    check("changing a filter offers Update", !(await ev("document.getElementById('rpUpdate').hidden")));
    await click("#rpUpdate");
    check("Update saves the change", await until("/Updated/.test(document.getElementById('toast').textContent) && document.getElementById('rpUpdate').hidden"));
    check("...on the server too", (await ev(`fetch("/api/reports/saved",{credentials:"same-origin"}).then(r=>r.json()).then(j=>j.items[0].spec.device)`)) === phone.deviceId);
    await click("[data-rename]");
    await until("!!document.querySelector('dialog.dlg[open] #rpDlgName')");
    await ev("(() => { const i = document.getElementById('rpDlgName'); i.value = 'Alpha on the laptop'; i.form.requestSubmit(); return 1; })()");
    check("Rename renames it", await until("document.querySelector('.rp-saved-list b').textContent === 'Alpha on the laptop'"));
    await click("[data-del]");
    check("Delete asks first", await until("!!document.querySelector('dialog.dlg[open] [data-r=\"1\"]')"));
    await ev("document.querySelector('dialog.dlg[open] [data-r=\"0\"]').click(); 1");
    check("...and Cancel keeps it", await until("!document.querySelector('dialog.dlg[open]') && document.querySelectorAll('.rp-saved-list li').length === 1"));
    await click("[data-del]"); await until("!!document.querySelector('dialog.dlg[open] [data-r=\"1\"]')");
    await ev("document.querySelector('dialog.dlg[open] [data-r=\"1\"]').click(); 1");
    check("confirming deletes it", await until("/Nothing saved yet/.test(document.getElementById('rpSavedList').textContent)"));

    // ---- empty, error, phone ----
    await go("#/reports?period=month&date=2030-06-15");
    check("a period that has not started says so", /has not started yet/.test(await ev("document.getElementById('rpBody').textContent")));
    await go(`#/reports?period=week&date=${day}&channel=Nobody`);
    check("filters that match nothing offer to clear them", await until("!!document.querySelector('#rpBody [data-clear]')"));
    await go("#/reports?period=week&device=gone-device");
    check("a device that is no longer paired shows an error with Try again", await until("/no longer paired/.test(document.getElementById('rpBody').textContent) && !!document.getElementById('rpRetry')"));
    await chrome.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sid);
    await go(`#/reports?period=month&date=${day}`);
    check("phone width: no sideways scroll", await ev("document.documentElement.scrollWidth <= window.innerWidth"), await ev("document.documentElement.scrollWidth + ' > ' + window.innerWidth"));
  } finally {
    await chrome.close(); process.env.BASE_URL = savedBase; await app.close();
  }
  const failed = steps.filter(s => !s.ok).map(s => s.name);
  assert.deepEqual(failed, [], failed.length + " of " + steps.length + " steps failed");
  assert.ok(steps.length >= 45, "ran " + steps.length + " steps");
});

