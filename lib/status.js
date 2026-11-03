/* lib/status.js — read-only device status (self.YTStatus), shared by the Settings page and the Device information page.
   model(raw) is pure (unit-tested in Node); gather() reads chrome.storage / IndexedDB / the browser and calls it.
   These pages only DISPLAY state. They are not a security boundary: whoever uses this browser can still pause tracking,
   delete data, remove the extension or clear its storage, and administrator settings cannot change that. */
(function (root) {
  "use strict";
  const DAY = 86400000;

  // "Windows 10/11 · Chrome 124" from a user-agent string (approximate by nature).
  function browserOf(ua, uaPlatform) {
    ua = String(ua || "");
    const chrome = /(?:Chrome|Chromium)\/(\d+)/.exec(ua), edge = /Edg\/(\d+)/.exec(ua);
    const browser = edge ? "Edge " + edge[1] : chrome ? "Chrome " + chrome[1] : "Unknown browser";
    const os = /Windows NT 10/.test(ua) ? "Windows 10/11" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : (uaPlatform || "Unknown OS");
    return { browser, os, text: os + " · " + browser };
  }

  const REMOTE = {
    pause_tracking: "Tracking was paused by your administrator",
    resume_tracking: "Tracking was resumed by your administrator",
    set_retention: "Your administrator changed how long history is kept",
    delete_all: "Your administrator deleted history stored on this device",
    delete_range: "Your administrator deleted part of the history stored on this device"
  };

  // raw: values read from storage plus { version, counts, storageBytes, ua, uaPlatform, queued, now }
  function model(raw) {
    const r = raw || {}, now = r.now || Date.now();
    const enrolled = !!(r.sync_server && r.device_refresh_present);
    const pending = r.sync_status === "pending", host = (() => { try { return new URL(r.sync_server).host; } catch (_e) { return r.sync_server || ""; } })();
    const live = !!(r.live_video_id && now - (r.last_heartbeat || 0) < 15000);
    const on = r.tracking_enabled !== false;
    const req = r.session_request, mc = r.managed_config, managed = (mc && mc.config) || {};

    const tracking = { on, tone: on ? "on" : "warn", label: on ? "Tracking on" : "Tracking paused",
      detail: live ? "Recording a video right now" : on ? "Recording YouTube watch time on this device" : "Nothing is being recorded. Resume from the toolbar popup.", live };

    let connection;
    if (!enrolled) connection = { state: "not_paired", tone: "off", label: "Not connected", host: "", channel: "—", detail: r.sync_notice || "Nothing is sent anywhere. Pair from the toolbar popup with a code from your dashboard." };
    else if (pending) connection = { state: "pending", tone: "warn", label: "Waiting for approval", host, channel: "—", detail: "The administrator has to approve this device before anything is sent." };
    else connection = { state: "connected", tone: "on", label: "Connected", host, channel: r.rt_state === "online" ? "Live" : "Polling", detail: "Syncing YouTube watch data to " + host + "." };

    const pairing = { state: connection.state, label: enrolled ? (pending ? "Pending approval" : "Paired") : "Not paired", tone: enrolled ? (pending ? "warn" : "on") : "off",
      session: r.session_id ? String(r.session_id).slice(0, 8) : "", pairedAt: r.paired_at || 0, name: r.enrolled_label || "",
      request: req ? { status: req.status, at: req.requestedAt || 0, note: req.decisionNote || "" } : null,
      requestLabel: !req ? "None" : req.status === "pending" ? "Waiting for Admin Approval" : req.status === "denied" ? "Denied" : req.status === "approved" ? "Approved" : req.status };

    const interval = r.sync_interval_minutes >= 5 ? r.sync_interval_minutes : 5;
    const sync = { lastOk: r.sync_last_ok || 0, queued: r.queued || 0, error: r.sync_last_error || "", intervalMin: interval,
      tone: !enrolled ? "off" : r.sync_last_error ? "warn" : "on",
      label: !enrolled ? "Not syncing" : pending ? "Paused until approved" : r.sync_last_error ? "Needs attention" : r.sync_last_ok ? "Up to date" : "Not synced yet" };

    const retention = r.retention_days > 0 ? r.retention_days + " days" : "Forever";
    const config = [
      { key: "tracking", label: "Tracking", value: on ? "On" : "Paused", managed: false, note: "Set from the toolbar popup" },
      { key: "live_view", label: "Live viewing", value: r.live_view === true ? "On" : "Off", managed: false, note: enrolled ? "Only you can turn this on, from the toolbar popup. While it is on the badge says LIVE." : "Off. It can only be turned on after pairing." },
      { key: "retention_days", label: "Keep history for", value: retention, managed: Object.prototype.hasOwnProperty.call(managed, "retention_days"), note: "" },
      { key: "sync_interval_minutes", label: "Sync every", value: interval + " minutes", managed: Object.prototype.hasOwnProperty.call(managed, "sync_interval_minutes"), note: "" },
      { key: "theme", label: "Appearance", value: "Follows your system", managed: false, note: "" }
    ];
    const managedState = !mc ? null : { version: mc.version, status: mc.status, error: mc.error || "", at: mc.at || 0, acked: !!mc.acked };

    const cmd = r.last_remote_command;
    const remote = cmd && REMOTE[cmd.type] ? { type: cmd.type, at: cmd.t, text: REMOTE[cmd.type] } : null;

    return { tracking, connection, pairing, sync, config, managed: managedState, remote, notice: r.sync_notice || "",
      device: { version: r.version || "", installId: r.install_id || "", installedAt: r.installed_at || 0, lastActivity: r.last_activity || 0,
        browser: browserOf(r.ua, r.uaPlatform), counts: r.counts || { videos: 0, sessions: 0 }, storageBytes: r.storageBytes },
      generatedAt: now, _age: n => Math.max(0, Math.floor((now - n) / DAY)) };
  }

  const KEYS = { tracking_enabled: true, retention_days: 0, sync_interval_minutes: 0, managed_config: null, sync_server: "", device_refresh: "", sync_status: "", device_id: "",
    session_id: "", enrolled_label: "", install_id: "", installed_at: 0, last_activity: 0, last_heartbeat: 0, live_video_id: null, sync_last_ok: 0, sync_last_error: "",
    sync_notice: "", rt_state: "offline", session_request: null, last_remote_command: null, paired_at: 0, live_view: false };

  async function gather() {
    const raw = await new Promise(r => chrome.storage.local.get(KEYS, r));
    raw.device_refresh_present = !!raw.device_refresh; delete raw.device_refresh; // the credential never leaves storage via this module
    raw.version = chrome.runtime.getManifest().version;
    raw.ua = navigator.userAgent; raw.uaPlatform = navigator.userAgentData && navigator.userAgentData.platform;
    if (root.YTDB) { raw.counts = await root.YTDB.counts().catch(() => null); raw.queued = await root.YTDB.outboxCount().catch(() => 0); }
    try { raw.storageBytes = (await navigator.storage.estimate()).usage; } catch (_e) { raw.storageBytes = undefined; }
    return model(raw);
  }

  // Small markup helpers so both pages look the same. Everything dynamic goes through escapeHtml.
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const badge = (tone, text) => '<span class="pill ' + (tone === "on" ? "on" : tone === "warn" ? "warn" : tone === "bad" ? "bad" : "off") + '"><span class="dot"></span><span>' + esc(text) + "</span></span>";
  const rows = list => '<dl class="ro-kv">' + list.map(x => "<dt>" + esc(x[0]) + "</dt><dd>" + (x[2] ? x[1] : esc(x[1])) + "</dd>").join("") + "</dl>"; // x[2] = trusted markup

  root.YTStatus = { model, gather, browserOf, REMOTE, ui: { esc, badge, rows } };
  if (typeof module !== "undefined" && module.exports) module.exports = root.YTStatus;
})(typeof self !== "undefined" ? self : this);
