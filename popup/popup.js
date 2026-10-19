(function () {
  "use strict";
  const U = window.YTUtil, DB = window.YTDB, S = window.YTStats;
  const $ = id => document.getElementById(id);
  const open = path => { chrome.tabs.create({ url: chrome.runtime.getURL(path) }); window.close(); };

  $("openDash").addEventListener("click", () => open("dashboard/dashboard.html"));
  $("openSettings").addEventListener("click", () => open("settings/settings.html"));
  $("openAdmin").addEventListener("click", () => open("admin/admin.html"));

  chrome.storage.local.get({ tracking_enabled: true }, c => {
    const on = c.tracking_enabled !== false;
    $("state").className = "pill " + (on ? "on" : "off");
    $("state").lastElementChild.textContent = on ? "Tracking on" : "Tracking off";
  });

  // While enrolled, say plainly that data leaves this device (and where it goes).
  window.YTSync.cfg().then(async c => {
    const t = window.YTSync.syncNoticeText(c);
    if (!t) return;
    let line = t;
    if (c.sync_status !== "pending") {
      const queued = await DB.outboxCount().catch(() => 0);
      line += " " + (c.sync_last_ok ? "Last sync " + U.fmtDateTime(c.sync_last_ok) + "." : "Not synced yet.") + (queued ? " " + queued + " pending." : "");
      if (c.sync_last_error) line += " Last error: " + c.sync_last_error;
    } else if (c.confirm_code) line += " Code: " + c.confirm_code + ".";
    $("syncNote").textContent = line; $("syncNote").hidden = false; $("localNote").hidden = true;
  });

  Promise.all([DB.getAllVideos(), DB.getAllSessions()]).then(r => {
    const s = S.summarize(r[0], r[1], Date.now(), U.dayKey);
    $("today").textContent = U.fmtDuration(s.todayMs);
    $("week").textContent = U.fmtDuration(s.last7Ms);
  });
})();
