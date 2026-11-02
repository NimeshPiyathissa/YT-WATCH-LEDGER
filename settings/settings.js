(function () {
  "use strict";
  // Read-only: this page never writes to storage and has no controls that change anything.
  const U = window.YTUtil, ST = window.YTStatus, I = window.YTIcons, { esc, badge, rows } = ST.ui;
  const $ = id => document.getElementById(id);
  const when = ts => (ts ? U.fmtDateTime(ts) : "Never");
  const ago = ts => { if (!ts) return "never"; const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; };
  const card = (icon, title, tone, text, body) => '<section class="card ro-card"><div class="card-head"><h3>' + I.icon(icon) + esc(title) + "</h3>" + badge(tone, text) + "</div>" + body + "</section>";

  function managedLine(m) {
    if (!m) return '<p class="muted small">Your administrator has not set anything for this device.</p>';
    const tone = m.status === "applied" ? "on" : "bad";
    return '<div class="ro-lead">' + badge(tone, m.status === "applied" ? "Applied" : "Could not apply") + '<span class="small muted">Configuration version ' + esc(m.version) + " · " + esc(ago(m.at)) + (m.status === "applied" && !m.acked ? " · confirmation pending" : "") + "</span></div>" + (m.error ? '<p class="small">' + esc(m.error) + "</p>" : "");
  }

  function render(m) {
    $("trackPill").className = "pill " + m.tracking.tone; $("trackPill").lastElementChild.textContent = m.tracking.label;
    const c = m.connection, s = m.sync, p = m.pairing;
    $("view").innerHTML =
      card("activity", "Tracking", m.tracking.tone, m.tracking.label,
        '<div class="ro-headline"><span class="big">' + esc(m.tracking.on ? "Recording YouTube watch time" : "Recording is paused") + "</span><p>" + esc(m.tracking.detail) + "</p></div>" +
        rows([["Pause or resume", "From the toolbar popup"], ["Your history", '<a href="../dashboard/dashboard.html">Review or delete it on the Dashboard</a>', true]])) +
      card("server", "Server connection", c.tone, c.label,
        '<div class="ro-headline"><span class="big">' + esc(c.host || "Not connected") + "</span><p>" + esc(c.detail) + "</p></div>" +
        rows([["Channel", c.channel], ["Pairing", p.label]].concat(p.name ? [["Device name", p.name]] : []))) +
      card("refresh-cw", "Synchronization", s.tone, s.label,
        rows([["Last successful sync", when(s.lastOk)], ["Waiting to upload", s.queued + " event" + (s.queued === 1 ? "" : "s")], ["Sync interval", s.intervalMin + " minutes"], ["Last error", s.error || "None"]])) +
      card("sliders-horizontal", "Current configuration", m.managed ? (m.managed.status === "applied" ? "on" : "bad") : "off", m.managed ? (m.managed.status === "applied" ? "Managed" : "Needs attention") : "Local",
        '<div class="ro-rows">' + m.config.map(x => '<div class="ro-row"><span class="name">' + esc(x.label) + '</span><span class="val">' + esc(x.value) + ' <span class="ro-tag' + (x.managed ? "" : " local") + '">' + (x.managed ? "Managed by administrator" : "Local") + "</span></span></div>").join("") + "</div>" + managedLine(m.managed)) +
      card("laptop", "This device", "off", "v" + (m.device.version || "?"),
        rows([["Extension version", m.device.version], ["Device", p.name || "This browser"], ["Session", p.session || "—"], ["Browser", m.device.browser.text]]) +
        '<div class="ro-actions"><a class="btn btn-sm" href="../admin/admin.html">' + I.icon("laptop") + "Device information</a></div>") +
      (m.remote ? card("scroll-text", "Administrator activity", "warn", "Last action",
        '<div class="ro-headline"><span class="big">' + esc(m.remote.text) + "</span><p>" + esc(when(m.remote.at)) + "</p></div>") : "");
  }

  async function refresh() {
    try { const m = await ST.gather(); render(m); $("notice").hidden = !m.notice; $("notice").textContent = m.notice; }
    catch (e) { $("view").innerHTML = '<section class="card"><div class="empty bad"><h3>Could not read status</h3><p>Reload this page. ' + esc(e && e.message) + "</p></div></section>"; }
  }
  refresh();
  I.hydrate(document);
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local") refresh().then(() => I.hydrate(document)); });
  setInterval(() => refresh().then(() => I.hydrate(document)), 15000);
})();
