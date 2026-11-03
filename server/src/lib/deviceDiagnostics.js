// Connection diagnostics for one device. Pure: it turns facts the server already has into a list of plain-language checks, each with
// what is wrong and what to do. No I/O, no clock of its own, and nothing here ever includes a credential or a token.
const MIN = 60000, HOUR = 3600000;
const LEVEL_RANK = { ok: 0, info: 1, warn: 2, bad: 3 };

const verParts = v => String(v || "").split(/[-+]/)[0].split(".").map(n => parseInt(n, 10) || 0);
export function compareVersions(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1; }
  return 0;
}

const ago = (now, t) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? "a few seconds ago" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago"; };

// facts: { device, connection, realtime, activeSessions, config:{state,error}, errors:[{at,kind,message}], serverVersion, syncIntervalMin, now }
export function diagnose(f) {
  const d = f.device, now = f.now, checks = [];
  const add = (id, level, title, detail, fix) => checks.push({ id, level, title, detail, fix: fix || null });
  const interval = Math.max(5, f.syncIntervalMin || 5);

  // authorization
  if (d.status === "revoked") add("access", "bad", "Access was revoked", "You revoked this device. It cannot upload or read anything.", "Pair it again with a new code if it should be connected.");
  else if (d.status === "pending") add("access", "warn", "Waiting for your approval", "The device paired with a code that requires approval and uploads nothing until you approve it.", "Check that the confirmation code on the device matches, then approve it on the Devices page.");
  else if (!f.activeSessions) add("access", "bad", "No active session", "The device has no active pairing session, so it cannot sync.", "Pair it again with a new code.");
  else add("access", "ok", "Authorised", f.activeSessions + " active session" + (f.activeSessions === 1 ? "" : "s") + ".");

  // reachability
  if (d.status === "active" && f.activeSessions) {
    if (f.realtime) add("connection", "ok", "Connected live", "The extension holds a live connection and receives changes at once.");
    else if (f.connection === "online") add("connection", "ok", "Reachable", "The device synced recently; it is not holding a live connection right now (polling instead).");
    else if (!d.last_seen && !d.last_push_at) add("connection", "warn", "Never connected", "The device has not contacted the server since it was paired.", "Open the extension popup on the device and press Reconnect; make sure the browser is open.");
    else add("connection", "warn", "Offline", "Last contact " + ago(now, Math.max(d.last_seen || 0, d.last_push_at || 0)) + ".", "The browser may be closed or offline. Data recorded meanwhile is queued on the device and uploads on reconnect.");
  }

  // freshness of uploads
  if (d.status === "active" && f.activeSessions) {
    if (!d.last_push_at) add("sync", "warn", "Nothing uploaded yet", "No data has been received from this device.", "Watch a video with the extension on, then check again after the next sync.");
    else {
      const age = now - d.last_push_at;
      if (age <= 3 * interval * MIN) add("sync", "ok", "Syncing on schedule", "Last upload " + ago(now, d.last_push_at) + " (every " + interval + " min).");
      else if (age <= 24 * HOUR) add("sync", "warn", "Uploads are late", "Last upload " + ago(now, d.last_push_at) + ", expected about every " + interval + " min.", "Usually the browser was closed or offline. It catches up when it reconnects.");
      else add("sync", "bad", "No uploads for over a day", "Last upload " + ago(now, d.last_push_at) + ".", "Check the device: is the browser running, is the extension enabled and still paired?");
    }
  }

  // queue
  if (d.status === "active" && f.activeSessions && d.last_push_at) {
    if (d.queue_dropped > 0) add("queue", "warn", "Some events were not queued", d.queue_dropped + " playback event" + (d.queue_dropped === 1 ? "" : "s") + " stayed on the device only because its upload queue reached its limit while offline.", "Their viewing summaries still synced. Reconnect the device; the events are not lost on the device.");
    else if (d.pending_count > 500 || d.queue_events > 2000) add("queue", "warn", "A long queue is waiting", (d.pending_count || 0) + " session update(s) and " + (d.queue_events || 0) + " event(s) are waiting on the device.", "The device is catching up after being offline; it will clear by itself.");
    else add("queue", "ok", "Queue is small", (d.pending_count || 0) + " session update(s) and " + (d.queue_events || 0) + " event(s) waiting.");
  }

  // errors
  if (d.last_error) add("errors", "warn", "The device reported an error", String(d.last_error).slice(0, 200), "See the recent errors below. A single network error clears at the next successful sync.");
  else if (d.status === "active" && d.last_push_at) add("errors", "ok", "No errors reported", "The last upload finished cleanly.");

  // clock
  if (Math.abs(d.clock_skew_ms || 0) > 2 * MIN) add("clock", "info", "The device clock is off", "Its clock differs from the server by " + Math.round(Math.abs(d.clock_skew_ms) / MIN) + " min. Times are corrected on the server, so nothing is wrong with your data.", "Set the device's date and time to automatic to avoid confusion.");

  // version
  if (d.client_version && f.serverVersion) {
    const c = compareVersions(d.client_version, f.serverVersion);
    if (c < 0) add("version", "info", "Extension is older than the server", "Extension " + d.client_version + ", server " + f.serverVersion + ". Newer features (such as live viewing consent) need the newer extension.", "Update the extension on that device (docs/EXTENSION_SETUP.md).");
    else add("version", "ok", "Extension version", "Extension " + d.client_version + ".");
  }

  // managed settings
  if (f.config && f.config.state === "failed") add("config", "warn", "The device refused your settings", f.config.error || "It could not apply the last change.", "Choose values within the allowed range and save again.");
  else if (f.config && f.config.state === "pending" && d.status === "active") add("config", "info", "A settings change is waiting", "The device has not confirmed your last change yet.", "It applies at the next sync.");

  // consent states (reported by the device, never set here)
  add("consent", "info", d.live_view ? "Live viewing is on" : "Live viewing is off", d.live_view ? "The person at the device allowed it, and the extension shows a visible indicator while it is on." : "The person at the device has not allowed live viewing. You see history after each sync, not what is playing right now.", null);

  const level = checks.reduce((m, c) => (LEVEL_RANK[c.level] > LEVEL_RANK[m] ? c.level : m), "ok");
  return { level: level === "info" ? "ok" : level, checks, errors: (f.errors || []).slice(0, 20) };
}
