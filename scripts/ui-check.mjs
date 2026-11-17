#!/usr/bin/env node
// Dashboard layout and navigation check in a real (headless) Chrome. Dependency free: it speaks the DevTools protocol itself.
//
//   WL_ADMIN_EMAIL=you@example.com WL_ADMIN_PASSWORD=... node scripts/ui-check.mjs --url http://localhost:8443 [--shots DIR] [--theme dark|light]
//
// For every page and three screen sizes (phone 390, tablet 820, desktop 1440) it checks that the page drew its heading, did not
// show the "could not load" state, and does not scroll sideways. It also clicks through pages quickly to prove a slow page can no
// longer draw over the page the owner moved to. READ-ONLY: it signs in and reads; it changes nothing on the server.
// Exit code: 0 all checks passed, 1 a check failed, 2 usage / no browser. Credentials come only from the environment.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const URL_ = (opt("--url", "") || "").replace(/\/+$/, ""), SHOTS = opt("--shots", ""), THEME = opt("--theme", "dark");
const email = process.env.WL_ADMIN_EMAIL, password = process.env.WL_ADMIN_PASSWORD;
if (!URL_ || !email || !password) { console.error("usage: WL_ADMIN_EMAIL=... WL_ADMIN_PASSWORD=... node scripts/ui-check.mjs --url http://localhost:8443 [--shots DIR] [--theme dark|light]"); process.exit(2); }

export function findChrome() {
  const c = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return c.find(p => p && fs.existsSync(p)) || null;
}
const CHROME = findChrome();
if (!CHROME) { console.error("No Chrome or Chromium found (set CHROME=/path/to/chrome)."); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 9400 + Math.floor(Math.random() * 400);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-ui-"));
const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-sandbox",
  "--hide-scrollbars", "--force-color-profile=srgb", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
let ws, id = 0; const pending = new Map();
async function connect() {
  for (let i = 0; i < 80; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = t.find(x => x.type === "page"); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch { /* starting */ }
    await sleep(250);
  }
  if (!ws) throw new Error("Chrome did not start");
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
}
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
async function goto(url) {
  // a navigation that only changes the #hash is not a page load and fires no load event: always pass through a blank page
  const blank = new Promise(r => { const h = e => { if (JSON.parse(e.data).method === "Page.loadEventFired") { ws.removeEventListener("message", h); r(); } }; ws.addEventListener("message", h); });
  await send("Page.navigate", { url: "about:blank" }); await blank;
  const loaded = new Promise(r => { const h = e => { if (JSON.parse(e.data).method === "Page.loadEventFired") { ws.removeEventListener("message", h); r(); } }; ws.addEventListener("message", h); });
  await send("Page.navigate", { url }); await loaded;
}

const PAGES = [["overview", "#/overview", "Overview"], ["analytics", "#/analytics", "Analytics"], ["reports", "#/reports", "Reports"], ["history", "#/history", "History"], ["videos", "#/videos", "Videos"],
  ["devices", "#/devices", "Devices"], ["health", "#/health", "Health Center"], ["updates", "#/updates", "Updates"], ["data", "#/data", null], ["security", "#/security", "Security Center"], ["notifications", "#/notifications", "Notifications"], ["settings", "#/settings", "Settings"], ["audit", "#/audit", null]];
const SIZES = [["phone", 390, 800, true], ["tablet", 820, 1100, false], ["desktop", 1440, 900, false]];
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  (" + detail + ")" : "")); };
// The server allows 300 requests a minute from one address, and this check makes many quickly (11 pages x 3 sizes, each page reading
// several APIs). Before each burst it waits for headroom instead of tripping the limit: a 429 would be reported as a broken page or a
// lost session, which is not what is being checked. Reads the limit's own headers; never changes the server.
async function headroom(min = 80) {
  const r = await ev(`fetch("/api/health", { credentials: "same-origin" }).then(r => [Number(r.headers.get("x-ratelimit-remaining")), Number(r.headers.get("x-ratelimit-reset"))]).catch(() => [NaN, NaN])`).catch(() => [NaN, NaN]);
  if (Number.isFinite(r[0]) && r[0] < min) await sleep((Math.min(60, Math.max(1, r[1] || 60)) + 1) * 1000);
}
const waitFor = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };

try {
  await connect();
  await send("Page.enable"); await send("Runtime.enable");
  await goto(URL_ + "/");
  const status = await ev(`fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({email:${JSON.stringify(email)},password:${JSON.stringify(password)}})}).then(r=>r.status)`);
  check("sign-in", status === 200, "HTTP " + status);
  if (status !== 200) throw new Error("cannot continue without signing in");
  await ev(`localStorage.setItem('yt_theme', ${JSON.stringify(THEME)}); 1`);
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  // a device page too, when the server has a device
  const firstDevice = await ev(`fetch("/api/devices",{credentials:"same-origin"}).then(r=>r.json()).then(l=>l[0]?l[0].id:"")`).catch(() => "");
  if (/^[\w-]+$/.test(firstDevice)) PAGES.push(["device", "#/device/" + firstDevice, null]);

  for (const [sn, w, h, mobile] of SIZES) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    await headroom();
    await goto(URL_ + "/#/audit");              // one real page load per screen size (starting on a page that is not in the list, so every hash change below is a real navigation); pages are then opened the way the owner does (the sidebar's hash links)
    for (const [name, hash, title] of PAGES) {
      await ev(`document.getElementById('app').innerHTML = ''; location.hash = ${JSON.stringify(hash)}; 1`);
      const drew = await waitFor(`!!document.querySelector('#app h1') && !document.querySelector('#app .skel')`);
      const m = await ev(`(() => { const d = document.documentElement; return { sw: d.scrollWidth, cw: d.clientWidth, bad: !!document.querySelector('#app .empty.bad'), h1: (document.querySelector('#app h1') || {}).textContent || '' }; })()`);
      check(`${sn} ${name}: drew its page`, drew && !m.bad, drew ? (m.bad ? "error state" : "") : "never finished loading");
      if (title) check(`${sn} ${name}: heading is "${title}"`, m.h1.trim() === title, m.h1.trim());
      check(`${sn} ${name}: no sideways scroll`, m.sw <= m.cw + 1, m.sw + " > " + m.cw);
      if (SHOTS) { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOTS, `${name}-${sn}-${THEME}.png`), Buffer.from(r.data, "base64")); }
    }
  }

  // A page that is slow to load must not overwrite the page the owner has already moved to.
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await goto(URL_ + "/#/overview");
  await ev(`location.hash = '#/analytics'; 1`); await sleep(30); await ev(`location.hash = '#/health'; 1`);
  await sleep(2500);
  const last = await ev(`(document.querySelector('#app h1') || {}).textContent || ''`);
  check("fast navigation: the last page clicked is the page shown", last.trim() === "Health Center", last.trim());

  // Expired access cookie + several requests at once (BUG_FIX_REPORT A7). The page must refresh ONCE, every request must then succeed,
  // and the owner must still be signed in. (Refreshing twice with one cookie makes the server treat it as stolen and end every session.)
  await goto(URL_ + "/#/health");
  await sleep(1500);
  await headroom();
  await send("Network.deleteCookies", { name: "at", url: URL_ + "/" });
  const burst = await ev(`(async () => { const paths = ['/api/devices', '/api/system', '/api/settings', '/api/audit', '/api/security/overview', '/api/system/backups'];
    const r = await Promise.allSettled(paths.map(p => window.WL.api('GET', p))); return { ok: r.filter(x => x.status === 'fulfilled').length, of: paths.length, hash: location.hash, errs: r.filter(x => x.status === 'rejected').map(x => String(x.reason && x.reason.message)) }; })()`);
  check("expired access cookie, six simultaneous requests: all succeed", burst.ok === burst.of, `${burst.ok}/${burst.of} ${burst.errs.join(",")}`);
  check("expired access cookie, six simultaneous requests: still signed in", burst.hash !== "#/login", burst.hash);
  const after = await ev(`window.WL.api('GET', '/api/devices').then(() => 'ok', e => String(e.message))`);
  check("expired access cookie: the session still works afterwards", after === "ok", after);
} catch (e) {
  check("run", false, e.message);
} finally {
  try { await send("Browser.close"); } catch { /* closing */ }
  // wait for Chrome to exit, then remove its temporary profile (it used to be left behind on every run: BUG_FIX_REPORT A26)
  await new Promise(ok => { if (proc.exitCode !== null) return ok(); proc.once("exit", ok); setTimeout(() => { try { proc.kill(); } catch { /* done */ } ok(); }, 3000).unref(); });
  for (let i = 0; i < 60 && fs.existsSync(dir); i++) { // Chrome's helpers can hold files for a few seconds after it exits (A26 follow-up)
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch { /* still releasing files */ }
    if (fs.existsSync(dir)) await sleep(500);
  }
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
setTimeout(() => process.exit(failed.length ? 1 : 0), 1700);
