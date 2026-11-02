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

  function load() {
  return Promise.all([DB.getAllVideos(), DB.getAllSessions()]).then(r => {
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
    $("histEmpty").innerHTML = emptyState("circle-alert", "Could not read your history", "The browser's local storage did not respond. Reload this page; if it keeps happening, check Device information for diagnostics.");
  });
  }
  load();
  $("search").addEventListener("input", renderRows);

  /* ---- Your data: review (above), export, delete. Deleting is local to this browser and always needs a second click. ---- */
  const toast = m => { let t = $("toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); } t.textContent = m; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 2600); };
  const download = (name, text) => { const u = URL.createObjectURL(new Blob([text], { type: "application/json" })); const a = document.createElement("a"); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000); };
  const exportJson = (name, vids, sess) => { download(name + "-" + U.dayKey(Date.now()) + ".json", JSON.stringify({ exportedAt: new Date().toISOString(), videos: vids, sessions: sess }, null, 2)); toast("Exported " + vids.length + " videos"); };
  const openForm = html => { const f = $("dataForm"); f.innerHTML = html; f.hidden = false; return f; };
  const closeForm = () => { const f = $("dataForm"); f.hidden = true; f.innerHTML = ""; };
  const goBtn = (danger, label) => '<button class="btn ' + (danger ? "btn-danger" : "btn-accent") + '" id="fmGo" type="button">' + label + '</button><button class="btn" id="fmCancel" type="button">Cancel</button>';
  const inRange = (v, a, b) => (v.lastWatched || 0) >= a && (v.lastWatched || 0) <= b;
  const sessionsOf = async vids => { const ids = new Set(vids.map(v => v.videoId)); return (await DB.getAllSessions()).filter(s => ids.has(s.videoId)); };
  const afterDelete = msg => { toast(msg); closeForm(); return load(); };

  function rangeForm(mode) {
    const del = mode === "delete";
    const f = openForm('<div class="form-row"><label>From <input type="date" id="rgFrom" class="input compact"></label><label>To <input type="date" id="rgTo" class="input compact"></label></div><div class="lock-error" id="fmErr" role="alert" hidden></div><div class="data-actions">' + goBtn(del, del ? "Delete…" : "Export") + "</div>");
    const q = id => f.querySelector("#" + id); let armed = false;
    q("fmCancel").onclick = closeForm;
    const bounds = () => {
      if (!q("rgFrom").value || !q("rgTo").value) { q("fmErr").textContent = "Pick both dates."; q("fmErr").hidden = false; return null; }
      const a = new Date(q("rgFrom").value + "T00:00:00").getTime(), b = new Date(q("rgTo").value + "T23:59:59.999").getTime();
      if (a > b) { q("fmErr").textContent = "'From' is after 'To'."; q("fmErr").hidden = false; return null; }
      q("fmErr").hidden = true; return [a, b];
    };
    q("fmGo").onclick = async () => {
      const b = bounds(); if (!b) return;
      const hit = videos.filter(v => inRange(v, b[0], b[1]));
      if (!del) { exportJson("yt-range", hit, await sessionsOf(hit)); return closeForm(); }
      if (!armed) { armed = true; q("fmGo").textContent = "Click again to delete " + hit.length + " video(s)"; return; }
      await afterDelete("Deleted " + (await DB.deleteByRange(b[0], b[1])) + " video(s)");
    };
  }
  function channelForm(mode) {
    const channels = Array.from(new Set(videos.map(v => v.channel || ""))).sort();
    if (!channels.length) return toast("No channels recorded yet");
    const del = mode === "delete";
    const f = openForm('<div class="form-row"><label>Channel <select id="chSel" class="input compact">' + channels.map(c => '<option value="' + esc(c) + '">' + esc(c || "(unknown)") + "</option>").join("") + '</select></label></div><div class="data-actions">' + goBtn(del, del ? "Delete…" : "Export") + "</div>");
    const q = id => f.querySelector("#" + id); let armed = false;
    q("fmCancel").onclick = closeForm;
    q("fmGo").onclick = async () => {
      const hit = videos.filter(v => (v.channel || "") === q("chSel").value);
      if (!del) { exportJson("yt-channel", hit, await sessionsOf(hit)); return closeForm(); }
      if (!armed) { armed = true; q("fmGo").textContent = "Click again to delete " + hit.length + " video(s)"; return; }
      await afterDelete("Deleted " + (await DB.deleteByChannel(q("chSel").value)) + " video(s)");
    };
  }
  function deleteAllForm() {
    const f = openForm('<p>This permanently deletes every recorded video and session in this browser.</p><div class="data-actions"><button class="btn btn-danger" id="fmGo" type="button">Delete all…</button><button class="btn" id="fmCancel" type="button">Cancel</button></div>');
    let armed = false; f.querySelector("#fmCancel").onclick = closeForm;
    f.querySelector("#fmGo").onclick = () => {
      if (!armed) { armed = true; f.querySelector("#fmGo").textContent = "Click again to confirm deleting everything"; return; }
      chrome.runtime.sendMessage({ type: "CLEAR_ALL" }, () => { void chrome.runtime.lastError; afterDelete("All data deleted"); });
    };
  }
  $("exportAll").onclick = async () => exportJson("yt-export", videos, await DB.getAllSessions());
  $("exportRange").onclick = () => rangeForm("export");
  $("delRange").onclick = () => rangeForm("delete");
  $("delChannel").onclick = () => channelForm("delete");
  $("delAll").onclick = deleteAllForm;
})();
