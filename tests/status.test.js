// Read-only status model (lib/status.js): what the Settings and Device information pages show for each state.
const assert = require("node:assert/strict");
const S = require("../lib/status.js");
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + "\n    " + e.message); } };
const NOW = 1_700_000_000_000;

t("not paired: nothing is sent, tracking on by default, defaults shown", () => {
  const m = S.model({ now: NOW, version: "0.6.0" });
  assert.deepEqual([m.tracking.on, m.tracking.label, m.connection.state, m.connection.label, m.pairing.label, m.sync.label], [true, "Tracking on", "not_paired", "Not connected", "Not paired", "Not syncing"]);
  assert.deepEqual([m.sync.intervalMin, m.config.find(c => c.key === "retention_days").value, m.config.find(c => c.key === "retention_days").managed], [5, "Forever", false]);
});

t("paused tracking says so and points the user at the popup", () => {
  const m = S.model({ now: NOW, tracking_enabled: false });
  assert.deepEqual([m.tracking.on, m.tracking.label, m.tracking.tone], [false, "Tracking paused", "warn"]);
  assert.match(m.tracking.detail, /popup/);
  assert.equal(m.config.find(c => c.key === "tracking").value, "Paused");
});

t("connected: host, channel Live or Polling, session short id, last sync", () => {
  const base = { now: NOW, sync_server: "https://tracker.example.com", device_refresh_present: true, sync_status: "active", session_id: "abcdef12-3456", sync_last_ok: NOW - 60000, enrolled_label: "Laptop" };
  const live = S.model({ ...base, rt_state: "online" }), poll = S.model({ ...base, rt_state: "offline" });
  assert.deepEqual([live.connection.label, live.connection.host, live.connection.channel, poll.connection.channel], ["Connected", "tracker.example.com", "Live", "Polling"]);
  assert.deepEqual([live.pairing.session, live.pairing.label, live.sync.label, live.sync.lastOk], ["abcdef12", "Paired", "Up to date", NOW - 60000]);
});

t("pending approval and sync errors are surfaced; the credential flag, not the credential, drives 'paired'", () => {
  const p = S.model({ now: NOW, sync_server: "https://x.example.com", device_refresh_present: true, sync_status: "pending" });
  assert.deepEqual([p.connection.state, p.pairing.label, p.sync.label], ["pending", "Pending approval", "Paused until approved"]);
  const e = S.model({ now: NOW, sync_server: "https://x.example.com", device_refresh_present: true, sync_status: "active", sync_last_error: "push 503" });
  assert.deepEqual([e.sync.label, e.sync.tone, e.sync.error], ["Needs attention", "warn", "push 503"]);
  assert.equal(S.model({ now: NOW, sync_server: "https://x.example.com" }).connection.state, "not_paired", "a server address without a credential is not a connection");
});

t("managed settings are marked as administrator-managed; the rest stay local", () => {
  const m = S.model({ now: NOW, retention_days: 90, sync_interval_minutes: 15, managed_config: { version: 3, status: "applied", config: { retention_days: 90, sync_interval_minutes: 15 }, at: NOW, acked: true } });
  const by = k => m.config.find(c => c.key === k);
  assert.deepEqual([by("retention_days").value, by("retention_days").managed, by("sync_interval_minutes").value, by("sync_interval_minutes").managed, by("tracking").managed, by("theme").managed], ["90 days", true, "15 minutes", true, false, false]);
  assert.deepEqual([m.managed.version, m.managed.status, m.managed.acked], [3, "applied", true]);
  const f = S.model({ now: NOW, managed_config: { version: 4, status: "failed", error: "bad value", config: {}, at: NOW } });
  assert.deepEqual([f.managed.status, f.managed.error], ["failed", "bad value"]);
});

t("deletion request state and remote administrator activity are visible to the user", () => {
  const m = S.model({ now: NOW, sync_server: "https://x.example.com", device_refresh_present: true, sync_status: "active", session_request: { status: "pending", requestedAt: NOW }, last_remote_command: { t: NOW, type: "resume_tracking" } });
  assert.deepEqual([m.pairing.requestLabel, m.remote.text], ["Waiting for Admin Approval", "Tracking was resumed by your administrator"]);
  for (const type of ["pause_tracking", "set_retention", "delete_all", "delete_range"]) assert.ok(S.model({ now: NOW, last_remote_command: { t: NOW, type } }).remote.text.includes("administrator"), type);
  assert.equal(S.model({ now: NOW, last_remote_command: { t: NOW, type: "something_else" } }).remote, null, "unknown commands are not described");
  assert.equal(S.model({ now: NOW, session_request: { status: "denied" } }).pairing.requestLabel, "Denied");
});

t("the notice left by a session that ended is passed on for display", () => {
  assert.equal(S.model({ now: NOW, sync_notice: "The owner revoked this device." }).notice, "The owner revoked this device.");
  assert.equal(S.model({ now: NOW }).notice, "");
});

t("browser and OS text, storage figures and counts pass through", () => {
  const b = S.browserOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  assert.equal(b.text, "Windows 10/11 · Chrome 124");
  assert.equal(S.browserOf("Mozilla/5.0 (Windows NT 10.0) Chrome/124.0 Safari/537 Edg/124.0").browser, "Edge 124");
  assert.equal(S.browserOf("", "Linux").os, "Linux");
  const m = S.model({ now: NOW, version: "0.6.0", install_id: "i-1", storageBytes: 2048, counts: { videos: 3, sessions: 9 }, last_activity: NOW - 1000, installed_at: NOW - 5000 });
  assert.deepEqual([m.device.version, m.device.installId, m.device.storageBytes, m.device.counts, m.device.lastActivity], ["0.6.0", "i-1", 2048, { videos: 3, sessions: 9 }, NOW - 1000]);
});

t("markup helpers escape everything dynamic", () => {
  const { esc, badge, rows } = S.ui;
  assert.equal(esc('<img src=x onerror="1">&\''), "&lt;img src=x onerror=&quot;1&quot;&gt;&amp;&#39;");
  assert.ok(!badge("on", "<b>x</b>").includes("<b>"));
  assert.ok(!rows([["<i>k</i>", "<script>v</script>"]]).includes("<script>"));
  assert.ok(rows([["k", "<b>ok</b>", true]]).includes("<b>ok</b>"), "trusted markup is only honoured when flagged");
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
