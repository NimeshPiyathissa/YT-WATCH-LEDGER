#!/usr/bin/env node
// Watch Ledger smoke test: talks to a running server over HTTP like a real client. No dependencies (Node 20+).
//
//   node scripts/smoke-test.mjs --url https://tracker.example.com            checks that are safe on a production server
//   node scripts/smoke-test.mjs --url http://127.0.0.1:8787 --full            adds an end-to-end run that WRITES test data
//
// Credentials come from the environment, never from arguments (they would land in shell history and process lists):
//   WL_ADMIN_EMAIL, WL_ADMIN_PASSWORD
//
// The default checks only read, plus one pairing code that is created and cancelled again. --full pairs a simulated device,
// uploads playback events, reads Video Details back, checks the exports and then removes that device and its data. Use --full
// only on a disposable instance. Exit code 0 = every check passed, 1 = a check failed, 2 = usage error.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2), has = f => args.includes(f), val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (has("--help") || !val("--url")) { console.error("usage: node scripts/smoke-test.mjs --url <https://host> [--full] [--quiet]\nenv: WL_ADMIN_EMAIL, WL_ADMIN_PASSWORD"); process.exit(2); }
const BASE = val("--url").replace(/\/+$/, ""), ORIGIN = new URL(BASE).origin, FULL = has("--full"), QUIET = has("--quiet");
const EMAIL = process.env.WL_ADMIN_EMAIL || "", PASSWORD = process.env.WL_ADMIN_PASSWORD || "";
if (!EMAIL || !PASSWORD) { console.error("Set WL_ADMIN_EMAIL and WL_ADMIN_PASSWORD in the environment."); process.exit(2); }

const results = [];
const out = s => { if (!QUIET) console.log(s); };
async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, ok: true }); out(`  ✓ ${name}${detail ? "  (" + detail + ")" : ""}`); }
  catch (e) { results.push({ name, ok: false, err: e.message }); out(`  ✗ ${name}\n      ${e.message}`); }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

let cookie = "";
async function call(method, p, { body, headers = {}, auth = true, raw = false } = {}) {
  const res = await fetch(BASE + p, { method, redirect: "manual", headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(method !== "GET" ? { Origin: ORIGIN } : {}),
    ...(auth && cookie ? { Cookie: cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) { const jar = new Map(cookie.split("; ").filter(Boolean).map(c => c.split(/=(.*)/s).slice(0, 2))); for (const c of set) { const [kv] = c.split(";"); const [k, v] = kv.split(/=(.*)/s); jar.set(k, v); } cookie = [...jar].map(([k, v]) => k + "=" + v).join("; "); }
  if (raw) return res;
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers, setCookie: set };
}

out(`Watch Ledger smoke test: ${BASE}${FULL ? "  [FULL: writes test data]" : ""}\n`);

out("Server");
await check("health endpoint answers", async () => { const r = await call("GET", "/api/health", { auth: false }); must(r.status === 200 && r.json && r.json.ok === true, "status " + r.status); });
await check("dashboard page is served", async () => { const r = await call("GET", "/", { auth: false }); must(r.status === 200 && /Watch Ledger/.test(r.text), "status " + r.status); });
await check("security headers are set", async () => { const r = await call("GET", "/api/health", { auth: false }); const h = r.headers; must(h.get("x-content-type-options") === "nosniff" && /default-src 'self'/.test(h.get("content-security-policy") || "") && h.get("x-frame-options") === "DENY", "missing header"); if (ORIGIN.startsWith("https:")) must(/max-age=/.test(h.get("strict-transport-security") || ""), "no HSTS"); });
if (ORIGIN.startsWith("https:")) await check("HTTP redirects to HTTPS", async () => { const r = await fetch(BASE.replace(/^https:/, "http:") + "/", { redirect: "manual" }).catch(e => { throw new Error("port 80 not reachable: " + e.cause?.code); }); must([301, 302, 307, 308].includes(r.status) && /^https:/.test(r.headers.get("location") || ""), "status " + r.status); });

out("\nAuthentication");
await check("protected routes refuse an anonymous caller", async () => { for (const p of ["/api/devices", "/api/history", "/api/videos", "/api/system"]) { const r = await call("GET", p, { auth: false }); must(r.status === 401, p + " -> " + r.status); } });
await check("a wrong password is refused", async () => { const r = await call("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD + "x" }, auth: false }); must(r.status === 401, "status " + r.status); });
await check("administrator login succeeds, with httpOnly strict cookies", async () => { const r = await call("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD }, auth: false }); must(r.status === 200, "status " + r.status + " " + (r.json?.error || "")); must(r.setCookie.length >= 2 && r.setCookie.every(c => /HttpOnly/i.test(c) && /SameSite=Strict/i.test(c)), "cookie flags"); });
await check("a cross-origin state-changing request is refused", async () => { const r = await call("POST", "/api/devices/enroll-code", { body: {}, headers: { Origin: "https://evil.example" } }); must(r.status === 403, "status " + r.status); });

out("\nDatabase and dashboard");
await check("devices list is readable", async () => { const r = await call("GET", "/api/devices"); must(r.status === 200 && Array.isArray(r.json), "status " + r.status); return r.json.length + " device(s)"; });
await check("system status: database present, backups configured", async () => { const r = await call("GET", "/api/system"); must(r.status === 200 && r.json.serverTime > 0, "status " + r.status); return `db ${Math.round((r.json.dbBytes || 0) / 1024)} KB, ${r.json.backups?.length ?? 0} backup(s) listed`; });
await check("history and videos queries run", async () => { for (const p of ["/api/history?limit=1", "/api/videos?limit=1", "/api/stats"]) { const r = await call("GET", p); must(r.status === 200, p + " -> " + r.status); } });

out("\nDevice pairing API");
await check("a pairing code can be created (and is cancelled again)", async () => {
  const r = await call("POST", "/api/devices/enroll-code", { body: { label: "smoke-test (cancelled)" } });
  must(r.status === 200 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.json.code || ""), "status " + r.status);
  const c = await call("POST", `/api/pairing-codes/${r.json.id}/revoke`, { body: {} }); must(c.status === 200, "cancel -> " + c.status);
});
await check("a bad pairing code is refused", async () => { const r = await call("POST", "/api/enroll", { body: { code: "ZZZZ-ZZZZ", installId: "smoke" }, auth: false }); must(r.status === 400, "status " + r.status); });

if (FULL) {
  out("\nEnd to end (writes test data, removes it afterwards)");
  const here = path.dirname(fileURLToPath(import.meta.url)), P = createRequire(import.meta.url)(path.join(here, "..", "server", "src", "lib", "playback.cjs"));
  let dev = null, auth = null; const S = 1000, t0 = Date.now() - 3600 * S, VID = "SMOKEvid001";
  await check("a simulated device pairs and gets an access token", async () => {
    const code = (await call("POST", "/api/devices/enroll-code", { body: { label: "smoke-test device" } })).json.code;
    const e = await call("POST", "/api/enroll", { body: { code, installId: "smoke-" + Date.now(), label: "smoke-test device", platform: "smoke", clientVersion: "0.7.0" }, auth: false });
    must(e.status === 200 && e.json.status === "active", "enroll " + e.status); dev = e.json;
    const t = await call("POST", "/api/device/token", { headers: { Authorization: "Bearer " + dev.refreshToken }, auth: false }); must(t.status === 200, "token " + t.status); auth = { Authorization: "Bearer " + t.json.accessToken };
  });
  const rec = P.createRecorder({ sessionId: "smoke-s1", videoId: VID }), evs = []; let pos = 0, t = t0;
  const step = (paused, dt) => { pos += paused ? 0 : dt; t += dt * S; };
  await check("ten pause/resume cycles are uploaded and acknowledged", async () => {
    evs.push(...rec.observe({ pos, rate: 1, paused: false, duration: 600 }, t));
    for (let i = 0; i < 10; i++) { step(false, 20); evs.push(...rec.observe({ pos, rate: 1, paused: true, duration: 600 }, t)); step(true, 10 + i); evs.push(...rec.observe({ pos, rate: 1, paused: false, duration: 600 }, t)); }
    step(false, 15); evs.push(...rec.end(t, "navigation", { pos }));
    const r = await call("POST", "/api/sync/events", { body: { events: evs, clientNow: Date.now() }, headers: auth, auth: false }); must(r.status === 200 && r.json.acked.length === evs.length, "status " + r.status);
    const again = await call("POST", "/api/sync/events", { body: { events: evs }, headers: auth, auth: false }); must(again.json.acked.length === evs.length, "a retry is not acknowledged in full"); return evs.length + " events";
  });
  await call("POST", "/api/sync/push", { body: { sessions: [{ sessionId: "smoke-s1", videoId: VID, kind: "watch", url: "https://www.youtube.com/watch?v=" + VID, title: "Smoke test video", channel: "Smoke channel", channelUrl: "https://www.youtube.com/@smoketest", startTs: t0, endTs: t, watchedMs: 215 * S, duration: 600, positionSec: 215, furthestSec: 215, seeks: 0, rewinds: 0, pauses: 10, completed: false, rev: 1 }] }, headers: auth, auth: false });
  await check("Video Details shows the video, its channel and all ten pauses", async () => {
    const d = await call("GET", "/api/video/" + VID); must(d.status === 200 && d.json.video.title === "Smoke test video" && d.json.video.channelUrl === "https://www.youtube.com/@smoketest", "details " + d.status);
    must(d.json.totals.pauseCount === 10 && d.json.totals.resumeCount === 10, "pauses " + d.json.totals.pauseCount);
    const p = await call("GET", `/api/video/${VID}/pauses`); must(p.json.items.length === 10 && p.json.items[9].durationMs === 19000, "pause table");
    const ev = await call("GET", `/api/video/${VID}/events?limit=500`); must(ev.json.total === evs.length && ev.json.items.every((e, i, a) => i === 0 || e.tsAdj >= a[i - 1].tsAdj), "timeline order");
    must(d.json.video.url === "https://www.youtube.com/watch?v=" + VID, "url");
  });
  await check("exports: CSV and print report carry Sri Lanka time, JSON keeps UTC", async () => {
    const csv = await call("GET", `/api/video/${VID}/export?format=csv`); must(csv.status === 200 && /\(SLST\)/.test(csv.text) && /timestamp_utc/.test(csv.text), "csv");
    const json = await call("GET", `/api/video/${VID}/export?format=json`); must(json.json.timezone === "Asia/Colombo" && json.json.events.length === evs.length, "json");
    const html = await call("GET", `/api/video/${VID}/export?format=print`); must(/Sri Lanka Standard Time/.test(html.text) && !/<script>/.test(html.text), "print");
    const h = await call("GET", "/api/export?format=csv"); must(h.status === 200 && /startedAtSlst/.test(h.text), "history csv");
  });
  await check("the device is removed again, with its data", async () => {
    const r = await call("DELETE", "/api/devices/" + dev.deviceId, { body: {} }); must(r.status === 200, "status " + r.status);
    const gone = await call("GET", "/api/video/" + VID); must(gone.status === 404, "video still visible: " + gone.status);
  });
}
await call("POST", "/api/auth/logout", { body: {} });

const failed = results.filter(r => !r.ok);
out(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) { console.error("FAILED:\n" + failed.map(f => `  - ${f.name}: ${f.err}`).join("\n")); process.exit(1); }
