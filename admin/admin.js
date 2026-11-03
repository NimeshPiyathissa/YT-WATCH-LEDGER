(function () {
  "use strict";
  // Device information: read-only. The only action is copying the diagnostics log to the clipboard.
  // (Pairing is done in the toolbar popup; settings and administration are in the web dashboard.)
  const U = window.YTUtil, ST = window.YTStatus, I = window.YTIcons, D = window.YTDiag, { esc, badge, rows } = ST.ui;
  const $ = id => document.getElementById(id);
  const when = ts => (ts ? U.fmtDateTime(ts) : "Never");
  const card = (icon, title, tone, text, body) => '<section class="card ro-card"><div class="card-head"><h3>' + I.icon(icon) + esc(title) + "</h3>" + (text ? badge(tone, text) : "") + "</div>" + body + "</section>";
  let toastT = null; const toast = m => { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2200); };

  function render(m) {
    const d = m.device, p = m.pairing, c = m.connection, s = m.sync;
    $("livePill").className = "pill " + (m.tracking.live ? "on" : "off");
    $("livePill").lastElementChild.textContent = m.tracking.live ? "Tracking a video now" : "Idle";
    $("view").innerHTML =
      card("laptop", "This installation", "off", "v" + (d.version || "?"),
        rows([["Installation ID", '<span class="mono">' + esc(d.installId || "—") + "</span>", true], ["Extension version", d.version], ["Browser / OS", d.browser.text], ["Installed", when(d.installedAt)]])) +
      card("shield-check", "Status", c.tone, c.label,
        rows([["Connection", c.label + (c.host ? " · " + c.host : "")], ["Channel", c.channel], ["Tracking", m.tracking.label], ["Pairing", p.label], ["Session", p.session || "—"],
          ["Paired", p.pairedAt ? U.fmtDateTime(p.pairedAt) : "—"], ["Deletion request", p.requestLabel]])) +
      card("activity", "Activity", s.tone, s.label,
        rows([["Last activity", when(d.lastActivity)], ["Last sync", when(s.lastOk)], ["Waiting to upload", String(s.queued)],
          ["Videos stored", String(d.counts.videos)], ["Sessions stored", String(d.counts.sessions)], ["Storage used (approx.)", d.storageBytes == null ? "—" : U.fmtBytes(d.storageBytes)]]));
  }
  async function renderDiag() {
    const l = (await D.read()).slice(-80), box = $("diagLog"), pill = { info: "info", warn: "warn", error: "bad" };
    box.innerHTML = l.map(e => '<div class="log-row ' + esc(e.level) + '"><time datetime="' + new Date(e.t).toISOString() + '">' + esc(U.fmtDateTime(e.t, true)) + '</time><span class="pill ' + (pill[e.level] || "off") + '">' + esc(e.level) + '</span><span class="msg">' + esc(e.msg) + "</span>" + (e.extra ? '<span class="extra">' + esc(JSON.stringify(e.extra)) + "</span>" : "") + "</div>").join("") || '<div class="log-empty">No events recorded yet.</div>';
    box.scrollTop = box.scrollHeight;
  }
  async function refresh() {
    try { render(await ST.gather()); await renderDiag(); }
    catch (e) { $("view").innerHTML = '<section class="card"><div class="empty bad"><h3>Could not read device information</h3><p>Reload this page. ' + esc(e && e.message) + "</p></div></section>"; }
  }
  $("copyDiag").addEventListener("click", async () => {
    const l = await D.read();
    try { await navigator.clipboard.writeText(l.map(e => new Date(e.t).toISOString() + " (" + U.fmtDateTime(e.t, true) + ") [" + e.level + "] " + e.msg + (e.extra ? " " + JSON.stringify(e.extra) : "")).join("\n")); toast("Log copied"); }
    catch (_e) { toast("Could not copy"); }
  });
  refresh(); I.hydrate(document);
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local") refresh(); });
  setInterval(refresh, 15000);
})();
