/* background.js — service worker. SESSION_FLUSH -> putSession -> recomputeVideo. */
importScripts("lib/build-config.js", "lib/util.js", "lib/accounting.js", "lib/playback.js", "lib/db.js", "lib/diag.js", "lib/sync.js", "lib/realtime.js");

const DB = self.YTDB, A = self.YTAccounting, P = self.YTPlayback, DIAG = self.YTDiag, SYNC = self.YTSync, RT = self.YTRealtime;
const getCfg = k => new Promise(r => chrome.storage.local.get(k, r));
const setCfg = o => new Promise(r => chrome.storage.local.set(o, r));
const thumb = id => "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";

// Install and update. An update (a new build loaded over the old one) keeps chrome.storage and IndexedDB, so settings,
// history and the paired session carry over untouched; nothing here resets them.
chrome.runtime.onInstalled.addListener(details => {
  const version = chrome.runtime.getManifest().version;
  chrome.storage.local.get({ install_id: null, installed_at: null, ext_version: null }, res => {
    const patch = { ext_version: version };
    if (!res.install_id) patch.install_id = (self.crypto?.randomUUID?.() || self.YTUtil.uuid());
    if (!res.installed_at) patch.installed_at = Date.now();
    chrome.storage.local.set(patch);
    if (details && details.reason === "update" && res.ext_version !== version) DIAG.info("extension updated", { from: res.ext_version || details.previousVersion || "?", to: version });
  });
  chrome.action.setBadgeBackgroundColor({ color: "#d92d20" });
  ensureSyncAlarm();
  recoverInterrupted().catch(() => {});
  runSync().catch(() => {}); // report the new version and reconnect straight away
});
// Browser restart: apply retention and resume uploading whatever is still in the outbox.
chrome.runtime.onStartup.addListener(() => { enforceRetention().catch(() => {}); recoverInterrupted().catch(() => {}); runSync().catch(() => {}); });

async function recomputeVideo(videoId) {
  const sessions = await DB.getSessionsByVideo(videoId);
  const roll = A.rollupVideo(videoId, sessions, thumb);
  if (roll) await DB.putVideo(roll); else await DB.deleteVideo(videoId);
}

async function enforceRetention() {
  const { retention_days } = await getCfg({ retention_days: 0 });
  if (!(retention_days > 0)) return 0;
  // While paired, never delete sessions still waiting in the outbox (no silent loss from retention).
  const pending = new Set((await DB.outboxAll()).map(r => r.sessionId));
  const affected = await DB.deleteSessionsBefore(Date.now() - retention_days * 86400000, pending);
  for (const id of affected) await recomputeVideo(id);
  if (affected.length) await DIAG.info("retention applied", { videos: affected.length });
  return affected.length;
}

/* ---- opt-in sync (no-ops unless the device is enrolled; see lib/sync.js) ---- */
SYNC.init({ enforceRetention, onIntervalChange: applySyncInterval });
const SYNC_ALARM = "sync", POLL_ALARM = "sync-poll", RT_ALARM = "realtime", MAX_RETRIES = 5;
let syncing = false, failCount = 0, debounceT = null, retryT = null;

async function runSync() {
  if (syncing) return { skipped: true };
  syncing = true;
  try {
    const r = await SYNC.pushOnce(DB);
    failCount = 0;
    // Waiting for the owner's approval: check again in a minute (alarms survive service-worker restarts).
    if (r.pending) chrome.alarms.create(POLL_ALARM, { delayInMinutes: 1 });
    if (r.pending) await DIAG.info("waiting for owner approval");
    else if (r.revoked) { await DIAG.warn("sync stopped: device no longer authorised", { reason: r.kind }); await RT.stop(); }
    else if (r.pushed || r.applied) await DIAG.info("sync ok", { pushed: r.pushed, commands: r.applied });
    if (!r.revoked && !r.skipped) RT.connect().catch(() => {});
    return r;
  } catch (err) {
    failCount++;
    await DIAG.warn("sync failed", { error: String(err), attempt: failCount });
    clearTimeout(retryT);
    // short backoff retries, then the 5-minute alarm takes over
    if (failCount <= MAX_RETRIES) retryT = setTimeout(runSync, SYNC.backoff(failCount));
    return { ok: false, error: String(err) };
  } finally { syncing = false; }
}
function scheduleSync() { clearTimeout(debounceT); debounceT = setTimeout(runSync, 5000); }
// The sync period is 5 minutes unless the owner manages it (5..60, see lib/sync.js MANAGED); read each time so a change applies at once.
async function syncPeriod() { const c = await getCfg({ sync_interval_minutes: 0 }); return c.sync_interval_minutes >= 5 ? c.sync_interval_minutes : 5; }
async function applySyncInterval() { chrome.alarms.create(SYNC_ALARM, { periodInMinutes: await syncPeriod() }); }
function ensureSyncAlarm() {
  syncPeriod().then(p => chrome.alarms.get(SYNC_ALARM, a => { if (!a || a.periodInMinutes !== p) chrome.alarms.create(SYNC_ALARM, { periodInMinutes: p }); }));
  chrome.alarms.get(RT_ALARM, a => { if (!a) chrome.alarms.create(RT_ALARM, { periodInMinutes: 1 }); });
}
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === SYNC_ALARM || a.name === POLL_ALARM) runSync();
  if (a.name === RT_ALARM) {
    RT.connect().catch(() => {}); // brings the socket back if the worker was stopped
    recoverInterrupted().catch(() => {});
    DB.evOutboxCount().then(n => { if (n) scheduleEvents(0); }).catch(() => {}); // events still queued (offline earlier): try again
  }
});
ensureSyncAlarm();

/* ---- real-time events from the server (hints; the work itself goes through the normal API) ---- */
RT.init(async m => {
  switch (m.type) {
    case "ready":
      scheduleEvents(0); // back online: whatever was queued while the connection was down goes first
      if (m.deletionRequest !== undefined) await SYNC.storeRequest(m.deletionRequest);
      if (m.status === "active" && (await SYNC.cfg()).sync_status === "pending") return runSync();
      return;
    case "device_status": return runSync();   // approved by the owner
    case "commands": return runSync();        // a remote command is waiting
    case "config": return runSync();          // the owner changed this device's managed settings
    case "session_request":                   // our deletion request was filed, approved or denied
      await SYNC.storeRequest(m.request);
      if (m.request && m.request.status !== "pending") await DIAG.info("session deletion request " + m.request.status);
      return;
    case "session_revoked":                   // revoked, removed, or our deletion request was approved
      await SYNC.revoked(m.reason);
      await DIAG.warn("session ended by the server", { reason: m.reason });
      return RT.stop();
  }
});
RT.connect().catch(() => {});

/* ---- playback events (lib/playback.js) ---- */
const END_TYPES = ["VIDEO_SESSION_ENDED", "VIDEO_SESSION_INTERRUPTED"];
const URGENT_TYPES = ["VIDEO_STARTED", "VIDEO_PAUSED", "VIDEO_RESUMED", "VIDEO_SEEKED", "VIDEO_COMPLETED", "VIDEO_REPLAYED", "VIDEO_SESSION_ENDED", "VIDEO_SESSION_INTERRUPTED"];
const STALE_MS = 3 * 60 * 1000; // a recorder whose heartbeat is older than this is gone (the content script writes one every ~5 s)
let evT = null, evAt = 0, evSyncing = false, evAgain = false, evFail = 0;

// Pause / resume / seek / completion reach the server about a second later; everything else rides the next 5-second batch.
function scheduleEvents(ms) {
  const at = Date.now() + ms;
  if (evT && evAt <= at) return;
  clearTimeout(evT); evAt = at; evT = setTimeout(runEvents, ms);
}
async function runEvents() {
  evT = null; evAt = 0;
  if (evSyncing) { evAgain = true; return; }
  evSyncing = true;
  try {
    const r = await SYNC.pushEventsOnce(DB);
    if (r.revoked) { await DIAG.warn("event sync stopped: device no longer authorised", { reason: r.kind }); await RT.stop(); }
    else if (r.ok === false) { evFail++; scheduleEvents(SYNC.backoff(Math.min(evFail, 6))); } // offline or server error: events stay queued
    else evFail = 0;
  } finally { evSyncing = false; if (evAgain) { evAgain = false; scheduleEvents(200); } }
}

async function handleVideoEvents(events) {
  const c = await getCfg({ tracking_enabled: true, collect_detail: true });
  let list = (Array.isArray(events) ? events.slice(0, 200) : []).map(e => P.validateEvent(e)).filter(Boolean);
  // With tracking paused or detail collection off nothing new is recorded; only the marker that closes a viewing already in
  // progress is kept, so the owner never sees a session that looks open forever.
  if (c.tracking_enabled === false || c.collect_detail === false) list = list.filter(e => END_TYPES.indexOf(e.type) >= 0);
  if (!list.length) return { ok: true, stored: 0 };
  await DB.putEvents(list, SYNC.isEnrolled(await SYNC.cfg())); // paired devices queue them in the same transaction
  await setCfg({ last_activity: Date.now() });
  scheduleEvents(list.some(e => URGENT_TYPES.indexOf(e.type) >= 0) ? 1000 : 5000);
  return { ok: true, stored: list.length };
}

// A recorder that vanished without an end event (browser closed, tab crashed, power lost) is closed at its last heartbeat:
// the recorded timestamp, never "now". Open pauses then become "unresolved" instead of getting an invented end.
async function recoverInterrupted() {
  const { live_rec } = await getCfg({ live_rec: null });
  if (!live_rec || live_rec.finished || !live_rec.started || Date.now() - live_rec.lastTs < STALE_MS) return;
  const ev = P.interruptedEvent(live_rec, live_rec.lastTs);
  if (ev) {
    await DB.putEvents([ev], SYNC.isEnrolled(await SYNC.cfg()));
    scheduleEvents(0);
    await DIAG.info("interrupted viewing recovered", { sessionId: live_rec.sessionId });
  }
  const s = await DB.getSession(live_rec.sessionId); // the watch-time snapshot of that viewing never got an end either
  if (s && !s.endTs) {
    s.endTs = Math.max(s.startTs || 0, live_rec.lastTs); s.rev = (s.rev || 0) + 1; s.updatedAt = Date.now();
    await DB.putSession(s, SYNC.isEnrolled(await SYNC.cfg()));
    await recomputeVideo(s.videoId);
    scheduleSync();
  }
  await setCfg({ live_rec: null });
}

async function handleFlush(snap, sender) {
  const cfg = await getCfg({ tracking_enabled: true });
  if (cfg.tracking_enabled === false) return { ok: false, reason: "off" };
  if (!snap || !snap.sessionId || !snap.videoId) return { ok: false, reason: "bad_snapshot" };
  snap.updatedAt = Date.now();
  const prev = await DB.getSession(snap.sessionId);
  const merged = A.mergeSnapshot(prev, snap);
  await DB.putSession(merged, SYNC.isEnrolled(await SYNC.cfg())); // enrolled devices queue the snapshot atomically
  await recomputeVideo(merged.videoId);
  await setCfg({ last_activity: Date.now() });
  scheduleSync();
  // Toolbar badge makes active recording visible on the device.
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId != null) chrome.action.setBadgeText({ text: snap.endTs ? "" : "REC", tabId }).catch(() => {});
  if (snap.endTs) { // sampled: log once per finished session
    await DIAG.info("session flush", { videoId: snap.videoId });
    await enforceRetention();
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = p => { p.then(sendResponse, err => sendResponse({ ok: false, error: String(err) })); return true; };
  switch (msg && msg.type) {
    case "SESSION_FLUSH":
      return run(handleFlush(msg.snapshot, sender).catch(async err => { await DIAG.error("flush failed", String(err)); throw err; }));
    case "VIDEO_EVENTS": return run(handleVideoEvents(msg.events));
    case "SYNC_NOW": return run(runSync());
    case "PAIRED": return run(runSync().then(r => { RT.connect().catch(() => {}); return r; }));
    case "ENFORCE_RETENTION": return run(enforceRetention().then(n => ({ ok: true, removed: n })));
    case "CLEAR_ALL": return run(DB.clearAll().then(() => DIAG.info("all data cleared")).then(() => ({ ok: true })));
    case "GET_DIAG": return run(DIAG.read());
    case "CLEAR_DIAG": return run(DIAG.clear().then(() => ({ ok: true })));
    default: return false;
  }
});
