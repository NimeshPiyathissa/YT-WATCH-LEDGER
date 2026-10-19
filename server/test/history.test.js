import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, addOwner, login, enrollDevice, session } from "./helpers.js";

const DAY = 86400000, MIN = 60000;

// Two paired laptops with a spread of sessions.
async function setup() {
  const { app, db, backupDir } = await makeApp();
  await addOwner(db);
  const A = await login(app);
  const l1 = await enrollDevice(app, A, "Laptop 1"), l2 = await enrollDevice(app, A, "Laptop 2");
  const now = Date.now();
  const push = (d, sessions) => app.inject({ method: "POST", url: "/api/sync/push", headers: d.auth, payload: { sessions, clientNow: now } });
  await push(l1, [
    session("a1", "vidA", { title: "Learning Rust", channel: "Code Channel", url: "https://www.youtube.com/watch?v=vidA", startTs: now - 1 * DAY, endTs: now - 1 * DAY + 10 * MIN, watchedMs: 10 * MIN, duration: 1200, furthestSec: 600, seeks: 2, pauses: 3 }),
    session("a2", "vidB", { title: "Cooking pasta", channel: "Kitchen", url: "https://www.youtube.com/watch?v=vidB", startTs: now - 10 * DAY, endTs: now - 10 * DAY + 5 * MIN, watchedMs: 5 * MIN, duration: 600, furthestSec: 560, completed: true })]);
  await push(l2, [
    session("b1", "vidA", { title: "Learning Rust", channel: "Code Channel", url: "https://www.youtube.com/watch?v=vidA", startTs: now - 2 * DAY, endTs: now - 2 * DAY + 20 * MIN, watchedMs: 20 * MIN, duration: 1200, furthestSec: 1200, completed: true }),
    session("b2", "vidC", { title: "Lo-fi beats", channel: "Chill Radio", url: "https://www.youtube.com/shorts/vidC", kind: "shorts", startTs: now - 40 * DAY, endTs: now - 40 * DAY + 30 * MIN, watchedMs: 30 * MIN, duration: 3600, furthestSec: 1800 })]);
  const get = (path) => app.inject({ method: "GET", url: path, headers: { cookie: A } });
  return { app, db, A, l1, l2, now, get, backupDir };
}

test("combined history shows every device's records, newest first, each tagged with its source device", async () => {
  const { get, l1, l2 } = await setup();
  const r = (await get("/api/history")).json();
  assert.equal(r.total, 4);
  assert.deepEqual(r.items.map(i => i.sessionId), ["a1", "b1", "a2", "b2"]);
  assert.deepEqual(r.items.map(i => i.deviceLabel), ["Laptop 1", "Laptop 2", "Laptop 1", "Laptop 2"]);
  assert.deepEqual(r.items.map(i => i.deviceId), [l1.deviceId, l2.deviceId, l1.deviceId, l2.deviceId]);
  const a1 = r.items[0];
  assert.deepEqual([a1.title, a1.url, a1.watchedMs, a1.duration, a1.progress, a1.seeks, a1.pauses], ["Learning Rust", "https://www.youtube.com/watch?v=vidA", 10 * MIN, 1200, 50, 2, 3]);
  assert.equal(r.items[1].completed, true);
  assert.equal(r.items[3].kind, "shorts");
});

test("filters: device, date range, title/channel text, url", async () => {
  const { get, l2, now } = await setup();
  assert.deepEqual((await get(`/api/history?device=${l2.deviceId}`)).json().items.map(i => i.sessionId), ["b1", "b2"]);
  assert.equal((await get("/api/history?device=all")).json().total, 4);
  assert.deepEqual((await get(`/api/history?from=${now - 3 * DAY}`)).json().items.map(i => i.sessionId), ["a1", "b1"]);
  assert.deepEqual((await get(`/api/history?from=${now - 12 * DAY}&to=${now - 5 * DAY}`)).json().items.map(i => i.sessionId), ["a2"]);
  assert.deepEqual((await get("/api/history?q=rust")).json().items.map(i => i.sessionId), ["a1", "b1"], "title, case-insensitive");
  assert.deepEqual((await get("/api/history?q=chill")).json().items.map(i => i.sessionId), ["b2"], "channel");
  assert.deepEqual((await get("/api/history?url=shorts/")).json().items.map(i => i.sessionId), ["b2"]);
  assert.deepEqual((await get(`/api/history?url=vidA&device=${l2.deviceId}`)).json().items.map(i => i.sessionId), ["b1"], "filters combine");
  assert.equal((await get("/api/history?q=nothing-matches")).json().total, 0);
});

test("history paginates and reports the total", async () => {
  const { get } = await setup();
  const p1 = (await get("/api/history?limit=3&offset=0")).json(), p2 = (await get("/api/history?limit=3&offset=3")).json();
  assert.deepEqual([p1.total, p1.items.length, p2.items.length], [4, 3, 1]);
  assert.equal(new Set([...p1.items, ...p2.items].map(i => i.sessionId)).size, 4);
});

test("stats combine all devices: totals, per-device split, top channels, daily/weekly/monthly series", async () => {
  const { get, l1, l2 } = await setup();
  const s = (await get("/api/stats?tz=0")).json();
  assert.equal(s.totalMs, (10 + 5 + 20 + 30) * MIN);
  assert.deepEqual([s.sessions, s.videos, s.completions, s.seeks, s.pauses], [4, 3, 2, 2, 3]);
  assert.deepEqual(s.byDevice.map(d => [d.label, d.totalMs]), [["Laptop 2", 50 * MIN], ["Laptop 1", 15 * MIN]]);
  assert.equal(s.topChannels[0].channel, "Chill Radio");
  assert.equal(s.topVideos[0].views >= 1, true);
  assert.deepEqual([s.daily.length, s.weekly.length, s.monthly.length], [30, 12, 12]);
  assert.equal(s.daily.reduce((a, d) => a + d.value, 0), 35 * MIN, "last 30 days exclude the 40-day-old session");
  assert.equal(s.last30Ms, 35 * MIN);
  assert.equal(s.weekly.reduce((a, d) => a + d.value, 0), s.totalMs, "12 weeks (~84 days) includes the 40-day-old session too");
  assert.equal(s.monthly.reduce((a, d) => a + d.value, 0), s.totalMs);
  const one = (await get(`/api/stats?device=${l1.deviceId}`)).json();
  assert.deepEqual([one.totalMs, one.sessions], [15 * MIN, 2]);
  assert.equal(l2.deviceId !== l1.deviceId, true);
});

test("export returns JSON and CSV for the current filters, and neutralises spreadsheet formulas", async () => {
  const { app, A, l1, now } = await setup();
  await app.inject({ method: "POST", url: "/api/sync/push", headers: l1.auth, payload: { sessions: [
    session("evil", "vidX", { title: '=HYPERLINK("http://evil","x"), "quoted"', channel: "+cmd|' /C calc'!A0", startTs: now - 3 * 3600000, endTs: now - 2 * 3600000, watchedMs: 60000 })], clientNow: now } });
  const json = await app.inject({ method: "GET", url: "/api/export?format=json", headers: { cookie: A } });
  assert.match(json.headers["content-disposition"], /attachment; filename="watch-history-\d{4}-\d{2}-\d{2}\.json"/);
  assert.equal(json.json().count, 5);
  const csv = await app.inject({ method: "GET", url: `/api/export?format=csv&device=${l1.deviceId}`, headers: { cookie: A } });
  assert.match(csv.headers["content-type"], /text\/csv/);
  assert.match(csv.headers["content-disposition"], /\.csv"/);
  const lines = csv.body.trim().split("\r\n");
  assert.equal(lines[0], "device,sessionId,videoId,url,title,channel,startedAt,endedAt,watchedSeconds,durationSeconds,progressPercent,completed,seeks,rewinds,pauses");
  assert.equal(lines.length, 4, "header + the 3 Laptop-1 rows");
  const evil = lines.find(l => l.includes("evil,vidX"));
  assert.ok(evil.includes(`"'=HYPERLINK(""http://evil"",""x""), ""quoted"""`), "title formula neutralised and quotes escaped: " + evil);
  assert.ok(evil.includes(`"'+cmd|' /C calc'!A0"`) || evil.includes("'+cmd"), "channel formula neutralised");
});

test("deleting server data needs explicit confirmation, honours device/date scope, and rebuilds rollups", async () => {
  const { app, A, db, l1, l2, now, get } = await setup();
  const del = payload => app.inject({ method: "POST", url: "/api/data/delete", headers: { cookie: A }, payload });
  assert.equal((await del({})).statusCode, 400);
  assert.equal((await del({ device: "all" })).statusCode, 400, "no confirm flag, no deletion");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 4);

  assert.equal((await del({ confirm: true, device: l2.deviceId, from: 0, to: now - 30 * DAY })).json().deleted, 1, "only Laptop 2's 40-day-old session");
  assert.equal((await get("/api/history")).json().total, 3);
  const v2 = (await app.inject({ method: "GET", url: `/api/devices/${l2.deviceId}/videos`, headers: { cookie: A } })).json();
  assert.deepEqual(v2.map(v => v.videoId), ["vidA"], "its video rollup for the deleted session is gone");

  assert.equal((await del({ confirm: true, device: l1.deviceId })).json().deleted, 2);
  assert.equal((await get("/api/history")).json().total, 1);
  assert.equal((await del({ confirm: true, device: "all" })).json().deleted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM videos").get().n, 0);
  assert.ok((await get("/api/audit")).json().some(r => r.action === "delete_data"));
  assert.equal((await get("/api/devices")).json().length, 2, "deleting history keeps the paired devices");
});

test("server retention setting: validated, applied immediately, and mirrored in the settings read", async () => {
  const { app, A, get } = await setup();
  const put = v => app.inject({ method: "PUT", url: "/api/settings", headers: { cookie: A }, payload: { server_retention_days: v } });
  assert.equal((await get("/api/settings")).json().server_retention_days, 0);
  for (const bad of [-1, 1.5, "30", 99999, null]) assert.equal((await put(bad)).statusCode, 400, String(bad));
  const r = (await put(30)).json();
  assert.deepEqual([r.ok, r.server_retention_days, r.removed], [true, 30, 1], "the 40-day-old session was trimmed");
  assert.equal((await get("/api/history")).json().total, 3);
  assert.equal((await get("/api/settings")).json().server_retention_days, 30);
  assert.equal((await put(0)).json().removed, 0, "0 = keep forever");
});

test("hostile titles round-trip untouched (escaping is the dashboard's job) and never break the API", async () => {
  const { app, A, l1, now } = await setup();
  const title = `<img src=x onerror=alert(1)> ${"‮"}</script>`;
  await app.inject({ method: "POST", url: "/api/sync/push", headers: l1.auth, payload: { sessions: [session("h", "vidH", { title, startTs: now - 1000, endTs: now })], clientNow: now } });
  const r = (await app.inject({ method: "GET", url: "/api/history?q=onerror", headers: { cookie: A } })).json();
  assert.equal(r.items[0].title, title);
});

test("system: on-demand backup, listing, and pruning to the configured count", async () => {
  const { app, A, get, backupDir } = await setup();
  const before = (await get("/api/system")).json();
  assert.deepEqual([before.backups.length, before.lastBackupAt], [0, null]);
  for (let i = 0; i < 5; i++) assert.equal((await app.inject({ method: "POST", url: "/api/system/backup", headers: { cookie: A } })).statusCode, 200);
  const after = (await get("/api/system")).json();
  assert.equal(after.backups.length, 3, "backupKeep=3 in the test config");
  assert.ok(after.lastBackupAt > 0);
  assert.ok(after.backups[0].name > after.backups[2].name, "newest first");
  assert.equal((await import("node:fs")).readdirSync(backupDir).filter(n => n.endsWith(".partial")).length, 0);
});
