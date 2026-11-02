/* background.js — service worker. SESSION_FLUSH -> putSession -> recomputeVideo. */
importScripts("lib/build-config.js", "lib/util.js", "lib/accounting.js", "lib/db.js", "lib/diag.js", "lib/sync.js", "lib/realtime.js");

const DB = self.YTDB, A = self.YTAccounting, DIAG = self.YTDiag, SYNC = self.YTSync, RT = self.YTRealtime;
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
  runSync().catch(() => {}); // report the new version and reconnect straight away
});
// Browser restart: apply retention and resume uploading whatever is still in the outbox.
chrome.runtime.onStartup.addListener(() => { enforceRetention().catch(() => {}); runSync().catch(() => {}); });

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
  if (a.name === RT_ALARM) RT.connect().catch(() => {}); // brings the socket back if the worker was stopped
});
ensureSyncAlarm();

/* ---- real-time events from the server (hints; the work itself goes through the normal API) ---- */
RT.init(async m => {
  switch (m.type) {
    case "ready":
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
    case "SYNC_NOW": return run(runSync());
    case "PAIRED": return run(runSync().then(r => { RT.connect().catch(() => {}); return r; }));
    case "ENFORCE_RETENTION": return run(enforceRetention().then(n => ({ ok: true, removed: n })));
    case "CLEAR_ALL": return run(DB.clearAll().then(() => DIAG.info("all data cleared")).then(() => ({ ok: true })));
    case "GET_DIAG": return run(DIAG.read());
    case "CLEAR_DIAG": return run(DIAG.clear().then(() => ({ ok: true })));
    default: return false;
  }
});
