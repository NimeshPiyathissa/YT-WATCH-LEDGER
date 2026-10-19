/* lib/util.js — small helpers shared by worker and pages. Exposed as self.YTUtil. */
(function (root) {
  "use strict";
  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
  }
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ESC[c]); }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fmtDuration(ms) {
    const sec = Math.max(0, Math.round((ms || 0) / 1000));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + s + "s";
    return s + "s";
  }
  function fmtDateTime(ts) { return new Date(ts).toLocaleString(); }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }
  root.YTUtil = { uuid, escapeHtml, dayKey, fmtDuration, fmtDateTime, fmtBytes };
})(typeof self !== "undefined" ? self : this);
