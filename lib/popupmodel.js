/* lib/popupmodel.js: what the popup says, as a pure function of the extension's state (self.YTPopupModel).
   popup.js only draws this; every wording and priority rule is here so it can be tested exactly. Nothing here touches chrome.*. */
(function (root) {
  "use strict";
  const sp = () => root.YTSyncPolicy || (typeof require === "function" ? require("./syncpolicy.js") : null);

  function relative(ts, now) {
    if (!ts) return "never";
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 10) return "just now";
    if (s < 60) return s + " s ago";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function inWords(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    return s < 60 ? s + " s" : s < 3600 ? Math.round(s / 60) + " min" : Math.round(s / 3600) + " h";
  }
  const hostOf = u => { try { return new URL(u).host; } catch (_e) { return String(u || ""); } };

  // s: { enrolled, sync_status, sync_server, enrolled_label, session_id, confirm_code, sync_last_ok, sync_last_error, sync_last_error_kind,
  //      sync_retry:{attempt,at,kind}|null, rt_state, tracking_enabled, live_view, session_request, queue:{sessions,events,oldestAt,dropped},
  //      browserOnline, version, platform }
  function build(s, now) {
    now = now === undefined ? Date.now() : now;
    const P = sp();
    const tracking = s.tracking_enabled !== false, live = s.live_view === true;
    const q = s.queue || { sessions: 0, events: 0, dropped: 0 };
    const waiting = (q.sessions || 0) + (q.events || 0);
    const m = { tracking, queue: { text: P.queueSummary(q, now), events: q.events || 0, limit: P.LIMITS.EV_QUEUE, dropped: q.dropped || 0, waiting: waiting > 0, warn: (q.dropped || 0) > 0 } };

    if (!s.enrolled) {
      return Object.assign(m, { key: "unpaired", tone: "idle", title: "Not connected", sub: "Pair this browser with your Watch Ledger server to see it in one dashboard.", error: "", retry: "",
        pairing: "Not paired", canReconnect: false, rows: [], live: { available: false, on: false }, lastSync: "never" });
    }
    const pending = s.sync_status === "pending";
    const kind = s.sync_last_error_kind || (s.sync_retry && s.sync_retry.kind) || "";
    const failing = !!s.sync_last_error && !pending;
    const offline = failing && (kind === "network" || s.browserOnline === false) || (s.browserOnline === false && !pending);
    const error = failing || offline ? P.friendlyError(s.sync_last_error, offline ? "network" : kind) : "";

    let retry = "";
    if (s.sync_retry && !pending) {
      if (s.sync_retry.at && s.sync_retry.at > now) retry = "Retrying in " + inWords(s.sync_retry.at - now) + ".";
      else if (s.sync_retry.attempt) retry = "Will try again automatically in a few minutes.";
    }
    const last = relative(s.sync_last_ok, now);
    const rt = s.rt_state === "online";

    let key, tone, title, sub;
    if (pending) { key = "pending"; tone = "warn"; title = "Waiting for approval"; sub = "Nothing is uploaded until the owner approves this device."; }
    else if (!tracking) { key = "paused"; tone = "warn"; title = "Tracking paused"; sub = "Nothing is being recorded. Turn tracking back on below."; }
    else if (offline) { key = "offline"; tone = "warn"; title = "Offline: saving on this device"; sub = waiting ? "Your viewing is kept here and uploads when the connection returns." : "Nothing is lost while offline; it uploads when the connection returns."; }
    else if (failing) { key = "error"; tone = "bad"; title = "Sync problem"; sub = "Your viewing is saved on this device. Last successful sync " + last + "."; }
    else { key = rt ? "live" : "connected"; tone = "ok"; title = "Connected"; sub = s.sync_last_ok ? "Last sync " + last + "." : "Waiting for the first sync."; }

    const rows = [
      ["Device", s.enrolled_label || "This browser"],
      ["Server", hostOf(s.sync_server)],
      ["Pairing", pending ? "Waiting for approval" : "Paired"],
      ["Last sync", s.sync_last_ok ? last : "Not yet"],
      ...(pending ? [["Confirm code", s.confirm_code || "n/a"]] : [["Channel", rt ? "Live" : "Polling"]]),
      ["Session", s.session_id ? String(s.session_id).slice(0, 8) : "n/a"]
    ];
    const req = s.session_request;
    return Object.assign(m, {
      key, tone, title, sub, error, retry, rows, pairing: pending ? "Waiting for approval" : "Paired", lastSync: last, canReconnect: true,
      live: {
        available: !pending, on: live,
        indicator: live ? "Live viewing is ON" : "Live viewing is off",
        detail: live ? "The owner of " + hostOf(s.sync_server) + " can see which video is playing on this device right now. Turn it off any time."
                     : "The owner sees your history after each sync, but not what is playing right now."
      },
      deletion: req && req.status === "pending" ? "waiting" : req && req.status === "denied" ? "denied" : ""
    });
  }

  const api = { build, relative, inWords, hostOf };
  root.YTPopupModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
