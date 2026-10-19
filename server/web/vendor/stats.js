/* lib/stats.js — pure aggregation for the dashboard. self.YTStats. */
(function (root) {
  "use strict";
  const DAY = 86400000;

  function summarize(videos, sessions, now, dayKeyFn) {
    const A = root.YTAccounting;
    const daily = A.dailyTotals(sessions, dayKeyFn);
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const k = dayKeyFn(now - i * DAY);
      days.push({ label: k.slice(5), value: daily[k] || 0 });
    }
    const todayMs = daily[dayKeyFn(now)] || 0;
    const last7Ms = days.slice(-7).reduce((m, d) => m + d.value, 0);
    const totalMs = videos.reduce((m, v) => m + (v.totalMs || 0), 0);
    const byChannel = {};
    for (const v of videos) {
      const c = v.channel || "(unknown)";
      byChannel[c] = (byChannel[c] || 0) + (v.totalMs || 0);
    }
    const channels = Object.keys(byChannel).map(c => ({ channel: c, totalMs: byChannel[c] })).sort((a, b) => b.totalMs - a.totalMs);
    return { totalMs, todayMs, last7Ms, days, channels, videoCount: videos.length, sessionCount: sessions.length };
  }

  function searchVideos(videos, q) {
    q = String(q || "").trim().toLowerCase();
    const out = q ? videos.filter(v => (v.title || "").toLowerCase().includes(q) || (v.channel || "").toLowerCase().includes(q)) : videos.slice();
    return out.sort((a, b) => (b.lastWatched || 0) - (a.lastWatched || 0));
  }

  root.YTStats = { summarize, searchVideos };
  if (typeof module !== "undefined" && module.exports) module.exports = root.YTStats;
})(typeof self !== "undefined" ? self : this);
