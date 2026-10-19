(function () {
  "use strict";
  const L = window.YTLock;
  const $ = id => document.getElementById(id);
  let toastT = null;
  const toast = m => { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2200); };

  L.gate($("lockGate"), $("app"), $("lockInput"), $("lockError"), $("lockUnlock"), init);

  async function init() {
    const cfg = await L.getCfg({ tracking_enabled: true, retention_days: 0 });
    $("trackToggle").checked = cfg.tracking_enabled !== false;
    $("retentionSel").value = String(cfg.retention_days || 0);
    $("themeSel").value = window.YTTheme.current();
    $("trackToggle").addEventListener("change", async () => { await L.setCfg({ tracking_enabled: $("trackToggle").checked }); toast($("trackToggle").checked ? "Tracking on" : "Tracking off"); });
    $("retentionSel").addEventListener("change", async () => {
      await L.setCfg({ retention_days: Number($("retentionSel").value) });
      chrome.runtime.sendMessage({ type: "ENFORCE_RETENTION" }, () => { void chrome.runtime.lastError; toast("Retention updated"); });
    });
    $("themeSel").addEventListener("change", () => window.YTTheme.set($("themeSel").value));
    $("toAdmin").addEventListener("click", e => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL("admin/admin.html") }); });
    renderPw();
    const c = await window.YTSync.cfg(), t = window.YTSync.syncNoticeText(c);
    if (t) { $("syncNote").textContent = t; $("syncNote").hidden = false; }
  }
  async function renderPw() {
    const set = await L.isSet();
    $("pwState").textContent = set ? "A password is set; admin pages are locked until it's entered." : "No password set.";
    $("removePw").hidden = !set;
    const done = m => { toast(m); renderPw(); };
    $("setPw").onclick = () => L.renderPwForm($("pwForm"), set, false, done);
    $("removePw").onclick = () => L.renderPwForm($("pwForm"), set, true, done);
  }
})();
