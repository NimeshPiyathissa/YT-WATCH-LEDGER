(function () {
  "use strict";
  const U = window.YTUtil, DB = window.YTDB, S = window.YTStats, C = window.YTCharts;
  const $ = id => document.getElementById(id);
  const esc = U.escapeHtml;
  let videos = [];

  function renderRows() {
    const list = S.searchVideos(videos, $("search").value).slice(0, 200);
    $("rows").innerHTML = list.map(v =>
      "<tr><td>" + (v.thumbnail ? '<img src="' + esc(v.thumbnail) + '" alt="" />' : "") + esc(v.title || v.videoId) + "</td>" +
      "<td>" + esc(v.channel) + '</td><td class="num">' + U.fmtDuration(v.totalMs) + '</td><td class="num">' + (v.lastWatched ? U.fmtDateTime(v.lastWatched) : "") + "</td></tr>"
    ).join("") || '<tr><td colspan="4" class="muted">No videos recorded yet.</td></tr>';
  }

  Promise.all([DB.getAllVideos(), DB.getAllSessions()]).then(r => {
    videos = r[0];
    const s = S.summarize(r[0], r[1], Date.now(), U.dayKey);
    $("tToday").textContent = U.fmtDuration(s.todayMs);
    $("tWeek").textContent = U.fmtDuration(s.last7Ms);
    $("tAll").textContent = U.fmtDuration(s.totalMs);
    $("tVideos").textContent = String(s.videoCount);
    C.barChart($("chart"), s.days, U.fmtDuration);
    $("channels").innerHTML = s.channels.slice(0, 8).map(c => "<div>" + esc(c.channel) + ' <span class="muted num">— ' + U.fmtDuration(c.totalMs) + "</span></div>").join("") || '<span class="muted">Nothing yet.</span>';
    renderRows();
  });
  $("search").addEventListener("input", renderRows);
})();
