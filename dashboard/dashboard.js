(function () {
  "use strict";
  const U = window.YTUtil, DB = window.YTDB, S = window.YTStats, C = window.YTCharts, I = window.YTIcons;
  const $ = id => document.getElementById(id);
  const esc = U.escapeHtml;
  let videos = [];

  const emptyState = (icon, title, text) => '<span class="empty-icon">' + I.icon(icon) + "</span><h3>" + esc(title) + "</h3><p>" + esc(text) + "</p>";

  function renderRows() {
    const q = $("search").value, matches = S.searchVideos(videos, q), list = matches.slice(0, 200);
    $("histCount").textContent = videos.length ? (q.trim() ? matches.length + " of " + videos.length : String(videos.length)) : "";
    $("rows").innerHTML = list.map(v =>
      '<tr><td data-primary><span class="vid">' + (v.thumbnail ? '<img class="thumb" src="' + esc(v.thumbnail) + '" alt="" loading="lazy" />' : "") + '<span class="cell-primary">' + esc(v.title || v.videoId) + "</span></span></td>" +
      '<td data-label="Channel">' + esc(v.channel) + '</td><td class="num right" data-label="Watched">' + U.fmtDuration(v.totalMs) + '</td><td class="num right" data-label="Last watched">' + (v.lastWatched ? U.fmtDateTime(v.lastWatched) : "—") + "</td></tr>"
    ).join("");
    const none = !list.length;
    $("histTable").hidden = none; $("histEmpty").hidden = !none;
    if (none) $("histEmpty").innerHTML = videos.length
      ? emptyState("search", "No matches", "Nothing in your history matches that search. Try a different title or channel name.")
      : emptyState("film", "No videos recorded yet", "Watch something on YouTube with tracking on and it will show up here within a few seconds.");
  }

  Promise.all([DB.getAllVideos(), DB.getAllSessions()]).then(r => {
    videos = r[0];
    const s = S.summarize(r[0], r[1], Date.now(), U.dayKey);
    $("tToday").textContent = U.fmtDuration(s.todayMs);
    $("tWeek").textContent = U.fmtDuration(s.last7Ms);
    $("tAll").textContent = U.fmtDuration(s.totalMs);
    $("tVideos").textContent = String(s.videoCount);
    C.barChart($("chart"), s.days, U.fmtDuration);
    $("channels").innerHTML = s.channels.length
      ? '<ul class="ledger">' + s.channels.slice(0, 8).map(c => '<li><span class="name">' + esc(c.channel || "(unknown)") + '</span><span class="lead"></span><span class="amt">' + U.fmtDuration(c.totalMs) + "</span></li>").join("") + "</ul>"
      : '<div class="empty">' + emptyState("film", "No channels yet", "Channels appear once you have watched something.") + "</div>";
    renderRows();
  }).catch(() => {
    $("chart").innerHTML = ""; $("channels").innerHTML = "";
    $("histTable").hidden = true; $("histEmpty").hidden = false; $("histEmpty").classList.add("bad");
    $("histEmpty").innerHTML = emptyState("circle-alert", "Could not read your history", "The browser's local storage did not respond. Reload this page; if it keeps happening, check the Admin console diagnostics.");
  });
  $("search").addEventListener("input", renderRows);
})();
