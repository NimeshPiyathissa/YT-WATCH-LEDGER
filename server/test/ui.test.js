// Dashboard layout and navigation in a real headless Chrome (scripts/ui-check.mjs) against the real server and a seeded database.
// Skipped where no Chrome / Chromium is installed (it never downloads one). Set CHROME=/path/to/chrome to point at a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { makeApp, addOwner, enrollDevice, session, OWNER, PW } from "./helpers.js";

const require = createRequire(import.meta.url);
const P = require("../src/lib/playback.cjs");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHROME = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => p && fs.existsSync(p));

function viewing(sessionId, start) {
  const rec = P.createRecorder({ sessionId, videoId: "vidUi" });
  const p = { t: start, pos: 0 }, events = [];
  events.push(...rec.observe({ pos: 0, rate: 1, paused: false, duration: 600 }, p.t, "play"));
  p.t += 90000; p.pos += 90;
  events.push(...rec.end(p.t, "navigation", { pos: p.pos }));
  return events;
}

test("every dashboard page draws, fits the screen at phone, tablet and desktop widths, and fast navigation shows the last page", { skip: CHROME ? false : "no Chrome or Chromium found", timeout: 280000 }, async () => {
  const { app, db } = await makeApp();
  await addOwner(db);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } });
  const cookie = login.cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
  const dev = await enrollDevice(app, cookie, "Test laptop");
  const t0 = Date.now() - 3600000;
  await app.inject({ method: "POST", url: "/api/sync/events", headers: dev.auth, payload: { events: viewing("ui1", t0) } });
  await app.inject({ method: "POST", url: "/api/sync/push", headers: dev.auth, payload: { sessions: [session("ui1", "vidUi", { startTs: t0, endTs: t0 + 90000, watchedMs: 90000, title: "A test video", channel: "A test channel" })] } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = "http://127.0.0.1:" + app.server.address().port;
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, "scripts", "ui-check.mjs"), "--url", url], { env: { ...process.env, WL_ADMIN_EMAIL: OWNER, WL_ADMIN_PASSWORD: PW, CHROME }, stdio: ["ignore", "pipe", "pipe"] });
      let buf = ""; child.stdout.on("data", d => { buf += d; }); child.stderr.on("data", d => { buf += d; });
      child.on("error", reject); child.on("close", code => resolve({ code, buf }));
    });
    assert.equal(out.code, 0, out.buf.split("\n").filter(l => /FAIL|passed/.test(l)).join("\n"));
    assert.match(out.buf, /\d+ passed, 0 failed/);
  } finally { await app.close(); }
});
