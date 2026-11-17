/* lib/syncpolicy.js: the rules of the sync engine that need no browser, so they can be tested exactly (self.YTSyncPolicy).
   What to do when an upload fails, how long to wait, when to stop retrying in the foreground, how to find the one bad item in a
   rejected batch, how big the offline queue may grow, and what to tell the person at the device. */
(function (root) {
  "use strict";
  const LIMITS = {
    EV_QUEUE: 20000,            // playback events that may wait for an upload; the events themselves stay in local storage regardless
    HOT_RETRIES: 6,             // quick retries in the service worker; after these the periodic alarm takes over (no endless hot loop)
    RETRY_BASE_MS: 2000, RETRY_CAP_MS: 5 * 60 * 1000,
    RETRY_AFTER_CAP_MS: 10 * 60 * 1000
  };

  // Exponential backoff with jitter: the wait doubles with every failure up to the cap, and is spread over its upper half so that
  // many devices that failed together do not return together. rand() is injectable for tests.
  function retryDelay(attempt, rand) {
    const n = Math.max(0, Math.min(Math.floor(Number(attempt)) || 0, 12));
    const top = Math.min(LIMITS.RETRY_CAP_MS, LIMITS.RETRY_BASE_MS * Math.pow(2, n));
    const r = typeof rand === "function" ? rand() : Math.random();
    return Math.round(top / 2 + Math.min(Math.max(r, 0), 1) * top / 2);
  }

  // The server's Retry-After (seconds, or an HTTP date) as milliseconds, capped; null when absent or unusable.
  function retryAfterMs(value, now) {
    if (value === null || value === undefined || value === "") return null;
    const s = String(value).trim();
    let ms = null;
    if (/^\d+$/.test(s)) ms = Number(s) * 1000;
    else { const t = Date.parse(s); if (Number.isFinite(t)) ms = t - (now === undefined ? Date.now() : now); }
    if (ms === null || !Number.isFinite(ms)) return null;
    return Math.min(Math.max(ms, 0), LIMITS.RETRY_AFTER_CAP_MS);
  }

  // What a failed request means. retryable: the same payload may succeed later. A "rejected" payload never will: it must be
  // narrowed down to the bad item and set aside instead of being retried for ever.
  function classifyFailure(f) {
    const status = f && f.status;
    if (f && f.networkError) return { kind: "network", retryable: true };
    if (status === 401 || status === 403) return { kind: "auth", retryable: false };
    if (status === 429) return { kind: "quota", retryable: true };
    if (status === 408 || status === 425 || (status >= 500 && status <= 599)) return { kind: "server", retryable: true };
    if (status >= 400 && status <= 499) return { kind: "rejected", retryable: false };
    return { kind: "other", retryable: true };
  }

  // How many of the oldest queue rows to set aside so that at most `max` remain.
  const planTrim = (count, max) => Math.max(0, (Number(count) || 0) - Math.max(0, Number(max) || 0));

  // A rejected batch is halved until the single offending item is found.
  function splitBatch(list) {
    if (!Array.isArray(list) || list.length < 2) return [list || []];
    const mid = Math.ceil(list.length / 2);
    return [list.slice(0, mid), list.slice(mid)];
  }

  // After `failures` failed runs in a row: wait this long and try again, or null = stop hot retries and wait for the alarm.
  function nextRetry(failures, rand, retryAfter) {
    if (failures > LIMITS.HOT_RETRIES) return retryAfter ? Math.min(retryAfter, LIMITS.RETRY_AFTER_CAP_MS) : null;
    return Math.max(retryDelay(failures, rand), retryAfter || 0);
  }

  // A raw error text (from an exception, or the last_error stored by the sync run) as something a person can act on.
  function friendlyError(raw, kind) {
    const s = String(raw || "").toLowerCase();
    if (!s && !kind) return "";
    if (kind === "network" || /failed to fetch|fetch failed|network|offline|could not reach|connection|timeout|aborted/.test(s))
      return "Can't reach the server. Check your internet connection. Your viewing is saved on this device and uploads when the connection returns.";
    if (kind === "quota" || /429|rate/.test(s)) return "The server is asking this device to slow down. It will try again shortly.";
    if (kind === "auth" || /401|403|revoked|removed|not authorised|unauthori[sz]ed/.test(s)) return "The server no longer accepts this device. Ask the owner to check the Devices page, or pair again.";
    if (kind === "server" || /\b5\d\d\b|server error|internal/.test(s)) return "The server had a problem. This device will try again automatically.";
    if (kind === "rejected" || /\b4\d\d\b|invalid|too many|too large/.test(s)) return "The server did not accept some data. The rest keeps syncing; nothing on this device was lost.";
    return "Sync did not finish. This device will try again automatically.";
  }

  // The popup's one-line summary of the upload queue.
  function queueSummary(q, now) {
    const s = q.sessions || 0, e = q.events || 0, dropped = q.dropped || 0;
    const parts = [];
    if (s + e === 0) parts.push("Nothing waiting");
    else parts.push([s ? s + " viewing update" + (s === 1 ? "" : "s") : "", e ? e + " event" + (e === 1 ? "" : "s") : ""].filter(Boolean).join(" and ") + " waiting to upload");
    if (q.oldestAt && s + e > 0) { const m = Math.max(0, Math.round(((now === undefined ? Date.now() : now) - q.oldestAt) / 60000)); if (m >= 2) parts.push("oldest " + (m < 120 ? m + " min" : Math.round(m / 60) + " h") + " ago"); }
    if (dropped > 0) parts.push(dropped + " event" + (dropped === 1 ? "" : "s") + " kept on this device only (queue limit)");
    return parts.join(" · ");
  }

  const api = { LIMITS, retryDelay, retryAfterMs, classifyFailure, planTrim, splitBatch, nextRetry, friendlyError, queueSummary };
  root.YTSyncPolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
