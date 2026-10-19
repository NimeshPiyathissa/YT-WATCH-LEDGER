// Synthetic device for demos and tests. It speaks the same protocol as the extension but sends
// FABRICATED sessions - it never reads anyone's browsing. Intended for a local server you run yourself.
//
//   First run (enrols):  node scripts/sim-device.js --server http://127.0.0.1:8451 --code ABC123 --label "Lab laptop 1" --sessions 8
//   Later runs (sync):   node scripts/sim-device.js --label "Lab laptop 1" [--sessions 3]
//   Extras:              --hostile   include titles with HTML/script payloads (to show output escaping)
//                        --state <file>   where simulated devices are remembered (default ./sim-devices.json)
//
// Each run pushes new synthetic sessions (unless the "admin" paused tracking), pulls queued commands,
// applies them to the simulated device, and acknowledges them - exactly like the extension's sync loop.
import fs from "node:fs";

function args() {
  const a = {}, v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (!v[i].startsWith("--")) continue;
    const k = v[i].slice(2), next = v[i + 1];
    if (next === undefined || next.startsWith("--")) a[k] = true; else { a[k] = next; i++; }
  }
  return a;
}
const opt = args();
const label = opt.label || "Simulated device";
const stateFile = opt.state || "./sim-devices.json";
const say = m => console.log(`[sim:${label}] ${m}`);

const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
let dev = state[label];

async function call(method, path, body, token) {
  const res = await fetch(dev.server + path, {
    method, headers: { "Content-Type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function main() {
// ---- enrol on first run ----
if (!dev) {
  if (!opt.server || !opt.code) { console.error("first run needs --server <url> and --code <enrollment code>"); process.exitCode = 1; return; }
  const server = new URL(opt.server).origin;
  const res = await fetch(server + "/api/enroll", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: String(opt.code), installId: "sim-" + label.replace(/\W+/g, "-").toLowerCase(), label, platform: "Simulated" }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`enrolment failed (${res.status}): ${j.error || ""}`); process.exitCode = 1; return; }
  dev = state[label] = { server, token: j.deviceToken, deviceId: j.deviceId, tracking_enabled: true, retention_days: 0, sessions: [], seq: 0 };
  save();
  say("enrolled (synthetic device, fabricated data only)");
}

// ---- fabricate sessions ----
const POOL = [
  ["sim00000001", "Intro to cryptography", "Security Lectures", 1800],
  ["sim00000002", "Lo-fi beats to study to", "Chill Radio", 7200],
  ["sim00000003", "Cooking pasta 101", "Kitchen Basics", 900],
  ["sim00000004", "How TLS works", "Security Lectures", 1200],
  ["sim00000005", "Learning Rust in one hour", "Code Channel", 3600]
];
const HOSTILE = [["sim00000099", "<img src=x onerror=console.error('XSS-FIRED')> hostile title", "<b>Evil</b> Channel", 600]];
const pool = opt.hostile ? POOL.concat(HOSTILE) : POOL;
const rnd = n => Math.floor(Math.random() * n);

const want = opt.sessions === undefined ? (dev.sessions.length ? 2 : 6) : Number(opt.sessions) || 0;
if (!dev.tracking_enabled) {
  say("tracking is paused (by an admin command), so no new sessions are generated");
} else {
  const now = Date.now(), span = dev.sessions.length ? 3600000 : 7 * 86400000; // first run spreads over a week
  for (let i = 0; i < want; i++) {
    const [videoId, title, channel, duration] = pool[rnd(pool.length)];
    const startTs = now - rnd(span), watchedMs = (3 + rnd(25)) * 60000;
    dev.sessions.push({ sessionId: `sim-${dev.deviceId.slice(0, 8)}-${Date.now()}-${dev.seq++}`, videoId, title, channel, startTs, endTs: startTs + watchedMs, watchedMs, duration, updatedAt: startTs + watchedMs });
  }
  if (want) say(`generated ${want} synthetic session(s)`);
}

// ---- sync: push, then pull + apply + ack commands ----
async function lost(r) {
  if (r.status !== 401 && r.status !== 403) return false;
  say(`server returned ${r.status} (${r.json.error}): this device was ${r.status === 403 ? "revoked" : "removed"}; forgetting its token and stopping`);
  delete state[label]; save(); return true;
}
const cursor = dev.cursor || 0;
const batch = dev.sessions.filter(s => s.updatedAt > cursor).slice(0, 500);
const push = await call("POST", "/api/sync/push", { sessions: batch }, dev.token);
if (await lost(push)) return;
if (!push.json.ok) { console.error("push failed", push.status, push.json); process.exitCode = 1; return; }
if (batch.length) dev.cursor = Math.max(...batch.map(s => s.updatedAt));
say(`pushed ${batch.length} session(s) (server upserted ${push.json.upserted})`);

const pull = await call("GET", "/api/sync/commands", null, dev.token);
if (await lost(pull)) return;
const acks = [];
for (const c of pull.json.commands || []) {
  let result = { status: "ok" };
  switch (c.type) {
    case "pause_tracking": dev.tracking_enabled = false; break;
    case "resume_tracking": dev.tracking_enabled = true; break;
    case "set_retention": dev.retention_days = c.payload.days; break;
    case "delete_all": dev.sessions = []; dev.cursor = 0; break;
    case "delete_range": dev.sessions = dev.sessions.filter(s => s.startTs < c.payload.from || s.startTs > c.payload.to); break;
    default: result = { status: "error", error: "unknown_command" };
  }
  say(`applied remote command ${c.type} ${JSON.stringify(c.payload)} -> ${result.status}`);
  acks.push({ id: c.id, result });
}
if (acks.length) await call("POST", "/api/sync/commands/ack", { acks }, dev.token);
else say("no queued commands");
save();
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
