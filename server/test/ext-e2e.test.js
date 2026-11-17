// REAL Chrome + the built extension + a throwaway local server + real YouTube. Opt-in: WL_EXT_E2E=1 (it needs Chrome, the internet and
// about two minutes, so it is not part of the normal run). Everything happens in a temporary Chrome profile and a temporary database
// with a made-up owner; no real account, key or browser profile is touched.
//   WL_EXT_E2E=1 node --test test/ext-e2e.test.js        (WL_E2E_VIDEO=<id> to use another public video)
// Steps that depend on YouTube being reachable and playable are reported BLOCKED (not failed) when YouTube refuses, and the
// guided manual checklist in docs/MANUAL_TEST_CHECKLIST_EXTENSION.md covers them.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";
import { openDb, migrate } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { uuid } from "../src/lib/crypto.js";
import "./env.js";
import { tmpDir } from "./tmpdir.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOCK = process.env.WL_E2E_MOCK === "1"; // WL_E2E_MOCK=1: play a local stand-in for the watch page instead of real YouTube (scripts/lib/mock-youtube.mjs)
const VIDEO = MOCK ? "mock0000001" : (process.env.WL_E2E_VIDEO || "aqz-KE-bpKQ"); // Blender's "Big Buck Bunny", a public video that normally plays without an ad
const ON = process.env.WL_EXT_E2E === "1";
const sleep = ms => new Promise(r => setTimeout(r, ms));

test("real Chrome: the built extension pairs, tracks real YouTube playback, syncs, survives an outage and honours a revoke", { skip: ON ? false : "set WL_EXT_E2E=1 to run (needs Chrome and the internet)", timeout: 420000 }, async () => {
  const { launch } = await import("../../scripts/lib/chrome-ext.mjs");
  const out = tmpDir("wl-e2e-build-");
  const b = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-extension.mjs"), "--out", out], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stdout + b.stderr);

  const dbFile = path.join(tmpDir("wl-e2e-db-"), "e2e.db");
  const OWNER = "e2e-owner@example.test", PW = "e2e-throwaway-password-123";
  const db = openDb(dbFile); migrate(db);
  db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES (?,?,?,?)").run(uuid(), OWNER, await argon2.hash(PW), Date.now());
  const cfg = { dbPath: dbFile, backupDir: path.join(path.dirname(dbFile), "bk"), backupKeep: 2 };
  let app = await buildApp({ db, config: cfg });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const PORT = app.server.address().port, SERVER = "http://127.0.0.1:" + PORT;
  const cookie = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } })).cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
  const api = async (method, url, payload) => { const r = await app.inject({ method, url, headers: { cookie }, payload }); return { code: r.statusCode, body: r.body ? JSON.parse(r.body) : null }; };

  const results = [];
  const step = async (name, fn) => {
    try {
      const r = await fn(); const blocked = r && r.blocked, warn = r && r.warn;
      const status = blocked ? "BLOCKED" : warn ? "WARN" : "ok", note = blocked || warn || "";
      results.push({ name, status, note }); console.log(`  ${status.padEnd(7)} ${name}${note ? "  (" + note + ")" : ""}`); return r;
    }
    catch (e) { results.push({ name, status: "FAIL", note: e.message }); console.log(`  FAIL    ${name}  (${e.message.split("\n")[0]})`); return null; }
  };

  let mock = null;
  if (MOCK) { const { startMockYouTube } = await import("../../scripts/lib/mock-youtube.mjs"); mock = await startMockYouTube(); }
  const chrome = await launch({ extensionDir: path.join(out, "extension"), chromeArgs: mock ? mock.chromeArgs : [] });
  let tabs = [];
  try {
    const sw = await chrome.serviceWorker();
    let swId = sw;
    const inSW = async expr => { try { return await chrome.evalIn(swId, expr); } catch (e) { swId = await chrome.serviceWorker(); return chrome.evalIn(swId, expr); } }; // the worker may have been restarted
    const waitServer = async (fn, ms = 20000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(500); } return v; };

    await step("the extension loads in real Chrome with no manifest errors; its service worker runs", async () => {
      assert.ok(sw, "service worker target");
      assert.ok(await chrome.waitFor(() => inSW("!!(self.chrome && chrome.runtime && chrome.runtime.id)"), { timeout: 20000 }), "extension APIs available");
      const mf = JSON.parse(await inSW("JSON.stringify(chrome.runtime.getManifest())"));
      assert.equal(mf.manifest_version, 3); assert.match(mf.version_name, /^0\.8\.0/);
      assert.equal(await inSW("typeof YTSync + typeof YTDB + typeof YTPlayback"), "objectobjectobject");
    });

    await step("pairing: a one-time code from the owner pairs the extension (device active, code used once)", async () => {
      const code = (await api("POST", "/api/devices/enroll-code", { label: "Chrome E2E" })).body.code;
      const j = JSON.parse(await inSW(`YTSync.enroll(${JSON.stringify(SERVER)}, ${JSON.stringify(code)}, { deviceName: "Chrome E2E" }).then(j => JSON.stringify({ status: j.status, deviceId: j.deviceId }))`));
      assert.equal(j.status, "active");
      const devs = (await api("GET", "/api/devices")).body;
      assert.equal(devs.length, 1); assert.equal(devs[0].status, "active");
      const again = await app.inject({ method: "POST", url: "/api/enroll", payload: { code, installId: "other", label: "x" } });
      assert.equal(again.statusCode, 400, "the same code cannot be used twice");
    });
    const dev = (await api("GET", "/api/devices")).body[0];

    await step("popup: opened as an extension page it shows the connected state and the live-viewing switch (off)", async () => {
      const t = await chrome.openTab(`chrome-extension://${chrome.extensionId}/popup/popup.html`); tabs.push(t);
      await chrome.waitFor(() => chrome.evalIn(t, "!!document.getElementById('state') && !/Checking/.test(document.getElementById('state').innerText) && !!document.getElementById('hero') && document.getElementById('hero').innerText.length > 5"), { timeout: 20000 });
      await sleep(1500);
      const txt = await chrome.evalIn(t, "document.body.innerText");
      assert.match(txt, /Connected|Live|Synced|Waiting/i, txt.slice(0, 200));
      assert.equal(await chrome.evalIn(t, "!!document.getElementById('liveToggle') && !document.getElementById('liveToggle').checked"), true);
      await chrome.screenshot(t, path.join(os.tmpdir(), "wl-e2e-popup.png"));
      await chrome.closeTab(t);
    });

    // ---- real YouTube playback ----
    let played = null, seekSettled = false;
    const watch = async (label, plan) => {
      const t = await chrome.openTab("about:blank"); tabs.push(t);
      await chrome.send("Page.navigate", { url: `https://www.youtube.com/watch?v=${VIDEO}` }, await chrome.attach(t));
      const ready = await chrome.waitFor(() => chrome.evalIn(t, "(() => { const v = document.querySelector('video'); return !!v && v.readyState >= 3 && v.duration > 0; })()"), { timeout: 40000 });
      if (!ready) { await chrome.closeTab(t); return { blocked: "YouTube did not provide a playable video in this automated browser" }; }
      await chrome.evalIn(t, "document.querySelector('video').play().then(() => true, () => false)", { userGesture: true });
      const moving = await chrome.waitFor(() => chrome.evalIn(t, "(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime > 1; })()"), { timeout: 30000 });
      if (!moving) { await chrome.closeTab(t); return { blocked: "the video would not start playing automatically" }; }
      await plan(t);
      await chrome.closeTab(t); // closing the tab ends the viewing
      tabs = tabs.filter(x => x !== t); await sleep(2500);
      return { ok: true };
    };
    const V = "document.querySelector('video')";

    played = await step("playback: play 8 s, pause 3 s, resume 4 s, seek +6 s, then a +60 s jump on the real video page", async () => {
      return watch("first", async t => {
        await chrome.evalIn(t, "window.__ev = []; for (const n of ['play','pause','seeking','seeked','waiting','playing','ended']) document.querySelector('video').addEventListener(n, () => window.__ev.push(n + '@' + document.querySelector('video').currentTime.toFixed(1)))");
        await sleep(8000);
        await chrome.evalIn(t, `${V}.pause()`); await sleep(3000);
        await chrome.evalIn(t, `${V}.play()`, { userGesture: true }); await sleep(4000);
        await chrome.evalIn(t, `${V}.currentTime = ${V}.currentTime + 6`); await sleep(3000); // a short jump inside what is already buffered: settles at once
        await chrome.evalIn(t, `${V}.currentTime = ${V}.currentTime + 60`); // a long jump past the buffer: may stall for many seconds
        seekSettled = !!(await chrome.waitFor(() => chrome.evalIn(t, `!${V}.seeking && ${V}.readyState >= 3 && !${V}.paused`), { timeout: 25000 }));
        await sleep(3000);
        console.log("         page video events:", (await chrome.evalIn(t, "window.__ev.join(' ')")));
      });
    });
    const playedOk = played && played.ok;

    await step("sync: the viewing reaches the server; watch time is what was actually played (pause and stalled seek excluded)", async () => {
      if (!playedOk) return { blocked: "no playback to check" };
      await inSW("runSync()");
      const s = await waitServer(async () => { const r = await api("GET", `/api/video/${VIDEO}/sessions`); return r.body && r.body.total ? r.body : null; });
      assert.ok(s, "a session for the video reached the server");
      const sess = s.items[0], ms = sess.metrics.activeMs;
      console.log("         session metrics:", JSON.stringify(sess.metrics));
      // played about 8 s + 4 s (+ 3 s if the jump finished); the 3 s pause is excluded. If the 60 s jump hung (an unbuffered seek in this
      // headless browser can stall for ~25 s) that wait must be buffering, NOT playing time (BUG_FIX_REPORT A18).
      const m = sess.metrics;
      assert.ok(ms >= 5000, `some playing time was counted: ${ms} ms`);
      // the viewing is fully accounted for: playing + paused + buffering never exceeds the time the page was open (a stalled seek counted as
      // playing would break this by the length of the stall)
      assert.ok(ms + m.pausedMs + m.bufferingMs <= m.elapsedMs + 1500, `playing ${ms} + paused ${m.pausedMs} + buffering ${m.bufferingMs} must fit in ${m.elapsedMs} ms`);
      assert.ok(m.pausedMs >= 2000, "the 3 s pause was counted as paused: " + m.pausedMs);
      if (!seekSettled) assert.ok(sess.metrics.bufferingMs > 5000, "a stalled seek is counted as buffering: " + sess.metrics.bufferingMs);
    });

    await step("events: pause, resume and seek were recorded with the right order", async () => {
      if (!playedOk) return { blocked: "no playback to check" };
      const ev = (await api("GET", `/api/video/${VIDEO}/events?limit=500`)).body;
      const types = ev.items.map(e => e.type);
      console.log("         events:", ev.items.map(e => e.type.replace("VIDEO_", "") + "@" + e.pos + (e.meta && Object.keys(e.meta).length ? JSON.stringify(e.meta) : "")).join(" | "));
      for (const need of ["VIDEO_PAUSED", "VIDEO_RESUMED"]) assert.ok(types.includes(need), need + " recorded");
      assert.ok(types.includes("VIDEO_SEEKED"), "VIDEO_SEEKED recorded");
      assert.ok(types.indexOf("VIDEO_PAUSED") < types.indexOf("VIDEO_RESUMED"));
      const pauses = (await api("GET", `/api/video/${VIDEO}/pauses`)).body;
      const p = (pauses.items || pauses)[0];
      assert.ok(p && p.durationMs >= 2000, "a pause was recorded: " + (p && p.durationMs));
      // Soft checks: each showed up in some runs of real Chrome and is described in BUG_FIX_REPORT.md (A19, A20), so they are reported, not hidden.
      const warns = [];
      if (p.durationMs > 6000) warns.push(`the 3 s pause was recorded as ${Math.round(p.durationMs / 1000)} s (resume noticed late)`);
      if (!types.includes("VIDEO_SESSION_ENDED")) warns.push("no end-of-viewing event arrived (it is closed later by the interrupted-viewing recovery)");
      if (warns.length) return { warn: warns.join("; ") };
    });

    // ---- consent ----
    await step("live viewing: off by default; the person at the device turns it on in the popup (with confirmation); the server then reports it on", async () => {
      assert.equal((await api("GET", "/api/devices")).body[0].live_view, 0);
      const t = await chrome.openTab(`chrome-extension://${chrome.extensionId}/popup/popup.html`); tabs.push(t);
      await sleep(2000);
      await chrome.evalIn(t, "document.getElementById('liveToggle').click()", { userGesture: true }); await sleep(500);
      await chrome.evalIn(t, "document.getElementById('liveYes').click()", { userGesture: true }); await sleep(1500);
      await inSW("runSync()");
      const on = await waitServer(async () => (await api("GET", "/api/devices")).body[0].live_view === 1);
      assert.ok(on, "server shows live viewing on");
      await chrome.closeTab(t);
    });

    // ---- outage: the server goes away while the person keeps watching ----
    await step("outage: with the server down, a viewing is queued on the device and the popup says so; nothing is lost when the server returns", async () => {
      if (!playedOk) return { blocked: "no playback to check" };
      const before = (await api("GET", `/api/video/${VIDEO}/sessions`)).body.total;
      await app.close();
      const r = await watch("offline", async () => { await sleep(7000); });
      if (r.blocked) return r;
      await inSW("runSync().catch(() => null)");
      console.log("         local events of the offline viewing:", await inSW(`YTDB.getEventsByVideo(${JSON.stringify(VIDEO)}).then(a => a.length)`));
      const q = JSON.parse(await inSW("Promise.all([YTDB.outboxCount(), YTDB.evOutboxCount()]).then(x => JSON.stringify(x))"));
      assert.ok(q[0] + q[1] > 0, "events/sessions are waiting in the outbox: " + q);
      const st = JSON.parse(await inSW("new Promise(r => chrome.storage.local.get(['sync_last_error_kind'], v => r(JSON.stringify(v))))"));
      console.log("         queued:", q.join("/"), "error kind:", st.sync_last_error_kind);
      // server back on the same address with the same database
      const db2 = openDb(dbFile); migrate(db2);
      app = await buildApp({ db: db2, config: cfg });
      await app.listen({ port: PORT, host: "127.0.0.1" });
      await inSW("runSync()"); await sleep(1500); await inSW("runSync()");
      const after = await waitServer(async () => { const t = (await app.inject({ method: "GET", url: `/api/video/${VIDEO}/sessions`, headers: { cookie } })).json().total; return t > before ? t : 0; }, 30000);
      assert.ok(after > before, `the offline viewing arrived (${before} -> ${after})`);
      const q2 = JSON.parse(await inSW("Promise.all([YTDB.outboxCount(), YTDB.evOutboxCount()]).then(x => JSON.stringify(x))"));
      assert.deepEqual(q2, [0, 0], "queue is empty after delivery");
    });

    // ---- revoke ----
    await step("revoke: the owner revokes the device; the extension stops syncing and unpairs, but keeps its local history", async () => {
      const localBefore = Number(await inSW(`YTDB.getSessionsByVideo(${JSON.stringify(VIDEO)}).then(s => s.length)`));
      const rv = await app.inject({ method: "POST", url: `/api/devices/${dev.id}/revoke`, headers: { cookie } });
      assert.equal(rv.statusCode, 200);
      await inSW("runSync().catch(() => null)"); await sleep(1500);
      const server = await inSW("new Promise(r => chrome.storage.local.get(['sync_server', 'device_refresh'], v => r(JSON.stringify(v))))");
      const c = JSON.parse(server);
      assert.ok(!c.sync_server && !c.device_refresh, "unpaired: " + server);
      const localAfter = Number(await inSW(`YTDB.getSessionsByVideo(${JSON.stringify(VIDEO)}).then(s => s.length)`));
      assert.equal(localAfter, localBefore, "local watch history untouched");
      if (playedOk) assert.ok(localAfter >= 1, "history exists locally");
    });
  } finally {
    for (const t of tabs) await chrome.closeTab(t);
    await chrome.close();
    if (mock) await mock.close();
    try { await app.close(); } catch { /* closed */ }
  }
  const failed = results.filter(r => r.status === "FAIL");
  console.log(`real Chrome warnings: ${results.filter(r => r.status === "WARN").length}`);
  console.log(`\nreal Chrome: ${results.filter(r => r.status === "ok").length} ok, ${results.filter(r => r.status === "BLOCKED").length} blocked, ${failed.length} failed`);
  assert.equal(failed.length, 0, failed.map(f => f.name + ": " + f.note).join("\n"));
});

// BUG_FIX_REPORT A20 (unreproduced): many pause/resume cycles on a real <video> with the real content script, no YouTube involved.
// Every pause and resume must be recorded within 50 ms of the player's own event, with reason "user". 100 of 100 passed when this was
// written; if it ever fails the printed lines show which cycle and how late.
test("real Chrome: 40 quick pause/resume cycles are each recorded exactly once, on time", { skip: ON ? false : "set WL_EXT_E2E=1 to run", timeout: 240000 }, async (t) => {
  const { launch } = await import("../../scripts/lib/chrome-ext.mjs");
  const { startMockYouTube, mockAvailable } = await import("../../scripts/lib/mock-youtube.mjs");
  if (!mockAvailable()) return t.skip("needs openssl and ffmpeg on the PATH");
  const out = tmpDir("wl-e2e-build-");
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, "tools", "build-extension.mjs"), "--out", out]).status, 0);
  const mock = await startMockYouTube();
  const chrome = await launch({ extensionDir: path.join(out, "extension"), chromeArgs: mock.chromeArgs });
  const V = "document.querySelector('video')", ID = "mock0000002", CYCLES = 40;
  let tab = null;
  try {
    const sw = await chrome.serviceWorker();
    assert.ok(await chrome.waitFor(() => chrome.evalIn(sw, "!!(self.chrome && chrome.runtime && chrome.runtime.id)"), { timeout: 20000 }));
    tab = await chrome.openTab("about:blank");
    await chrome.send("Page.navigate", { url: mock.watchUrl(ID) }, await chrome.attach(tab));
    assert.ok(await chrome.waitFor(() => chrome.evalIn(tab, `(() => { const v = ${V}; return !!v && v.readyState >= 3; })()`), { timeout: 20000 }), "the page's video loaded");
    await chrome.evalIn(tab, `${V}.play()`, { userGesture: true });
    assert.ok(await chrome.waitFor(() => chrome.evalIn(tab, `${V}.currentTime > 1`), { timeout: 15000 }));
    await chrome.evalIn(tab, `window.__ev = []; for (const n of ['play','pause']) ${V}.addEventListener(n, () => window.__ev.push([n, Date.now()]))`);
    await sleep(3000);
    for (let i = 0; i < CYCLES; i++) { await chrome.evalIn(tab, `${V}.pause()`); await sleep(900); await chrome.evalIn(tab, `${V}.play()`, { userGesture: true }); await sleep(1100); }
    const page = JSON.parse(await chrome.evalIn(tab, "JSON.stringify(window.__ev)"));
    await chrome.closeTab(tab); tab = null; await sleep(2500);
    const ev = JSON.parse(await inSWOf(chrome, sw, `YTDB.getEventsByVideo(${JSON.stringify(ID)}).then(a => JSON.stringify(a.map(e => [e.type.replace('VIDEO_',''), e.ts, (e.meta||{}).reason||''])))`));
    const plays = page.filter(e => e[0] === "play").map(e => e[1]), pauses = page.filter(e => e[0] === "pause").map(e => e[1]);
    const rr = ev.filter(e => e[0] === "RESUMED"), pr = ev.filter(e => e[0] === "PAUSED"), odd = [];
    rr.forEach((r, i) => { const d = r[1] - plays[i]; if (Math.abs(d) > 50 || r[2] !== "user") odd.push(`resume ${i + 1}: ${d} ms, reason ${r[2]}`); });
    pr.forEach((r, i) => { const d = r[1] - pauses[i]; if (Math.abs(d) > 50 || r[2] !== "user") odd.push(`pause ${i + 1}: ${d} ms, reason ${r[2]}`); });
    console.log(`  ${plays.length} plays / ${pauses.length} pauses seen by the page; ${rr.length} resumes / ${pr.length} pauses recorded; ${odd.length} late or odd`);
    assert.equal(rr.length, plays.length); assert.equal(pr.length, pauses.length);
    assert.deepEqual(odd, []);
  } finally { if (tab) await chrome.closeTab(tab); await chrome.close(); await mock.close(); }
});
async function inSWOf(chrome, sw, expr) { try { return await chrome.evalIn(sw, expr); } catch { return chrome.evalIn(await chrome.serviceWorker(), expr); } }
