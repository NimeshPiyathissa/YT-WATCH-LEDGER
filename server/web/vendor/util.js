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
  // ---- display time zone ----
  // Every timestamp is stored as UTC milliseconds and shown in Sri Lanka Standard Time. The zone is fixed here, once: nothing
  // reads the browser's or the OS's zone, and nothing adds hours by hand (Intl does the conversion, so a date rolls over
  // exactly at 00:00 in Colombo). Formatting never feeds back into a calculation: durations always use the raw UTC numbers.
  const TZ = "Asia/Colombo", TZ_LABEL = "SLST", TZ_OFFSET_TEXT = "UTC+05:30";
  const fmts = {};
  const intl = (kind, o) => fmts[kind] || (fmts[kind] = new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: TZ }, o)));
  const tidy = s => s.replace(/[  ]/g, " "); // newer ICU puts a narrow no-break space before AM/PM
  const dateFmt = () => intl("d", { year: "numeric", month: "long", day: "numeric" });
  const timeFmt = () => intl("t", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  const partsFmt = () => intl("p", { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const num = ts => Number(ts);
  function fmtDate(ts) { return tidy(dateFmt().format(new Date(num(ts)))); }
  function fmtTime(ts, ms) {
    let s = tidy(timeFmt().format(new Date(num(ts))));
    if (ms) s = s.replace(/(\d{2})( [AP]M)$/, "$1." + String(Math.floor(((num(ts) % 1000) + 1000) % 1000)).padStart(3, "0") + "$2");
    return s;
  }
  // "November 3, 2026 · 12:45:02 PM (SLST)"
  function fmtDateTime(ts, ms) { return fmtDate(ts) + " · " + fmtTime(ts, ms) + " (" + TZ_LABEL + ")"; }
  // Calendar parts of an instant on the Colombo wall clock.
  function parts(ts) {
    const o = {}; partsFmt().formatToParts(new Date(num(ts))).forEach(p => { o[p.type] = Number(p.value); });
    return { y: o.year, m: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
  }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function dayKey(ts) { const p = parts(ts); return p.y + "-" + pad(p.m) + "-" + pad(p.d); }
  // The instant at which the Colombo wall clock reads y-m-d h:mi:s.ms (the second pass settles any offset change; Colombo has none today).
  function zonedToUtc(y, mo, d, h, mi, s, ms) {
    const naive = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0, ms || 0), off = t => { const p = parts(t); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000; };
    let t = naive - off(naive); t = naive - off(t); return t;
  }
  // A date picked in a <input type="date"> ("2026-11-03") covers 00:00:00.000 to 23:59:59.999 on that Colombo day.
  const dayStart = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ""); return m ? zonedToUtc(+m[1], +m[2], +m[3], 0, 0, 0, 0) : ""; };
  const dayEnd = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ""); return m ? zonedToUtc(+m[1], +m[2], +m[3], 23, 59, 59, 999) : ""; };
  function fmtDuration(ms) {
    const sec = Math.max(0, Math.round((ms || 0) / 1000));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + s + "s";
    return s + "s";
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }
  root.YTUtil = { uuid, escapeHtml, TZ, TZ_LABEL, TZ_OFFSET_TEXT, dayKey, dayStart, dayEnd, zonedToUtc, fmtDate, fmtTime, fmtDateTime, fmtDuration, fmtBytes };
})(typeof self !== "undefined" ? self : this);
