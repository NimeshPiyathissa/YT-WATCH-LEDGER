/* notifications.js: the Notification Center page (#/notifications) and the unread badge in the sidebar (window.WLNotifications).
   In-dashboard only: nothing is sent anywhere. Every value shown comes from the server and goes through esc(). No inline styles or scripts. */
(function () {
  "use strict";
  const WL = new Proxy({}, { get: (_t, k) => window.WL[k] }), U = window.YTUtil, esc = U.escapeHtml, ic = window.YTIcons.icon;
  const $ = id => document.getElementById(id);
  const SEV = { critical: ["bad", "Urgent"], warn: ["warn", "Needs attention"], info: ["info", "For your information"] };
  const THRESHOLD = { device_offline: { field: "hours", label: "hours without contact", min: 1, max: 720 }, security: { field: "failedLogins", label: "failed attempts in 24 hours", min: 1, max: 100 } };
  const pill = (cls, text) => `<span class="pill ${cls}"><span class="dot"></span><span>${esc(text)}</span></span>`;
  let seq = 0, badgeTimer = null, view = "active";

  /* ---- the sidebar badge ---- */
  async function refreshBadge() {
    const b = $("notifBadge");
    if (!b || document.hidden || location.hash === "#/login") return; // not while signed out
    try {
      const s = await WL.api("GET", "/api/notifications/summary");
      b.textContent = s.unread > 99 ? "99+" : String(s.unread);
      b.hidden = s.unread === 0;
      b.className = "badge" + (s.bySeverity.critical ? " bad" : "");
      b.setAttribute("aria-label", s.unread + " unread notification" + (s.unread === 1 ? "" : "s"));
    } catch (_e) { /* signed out or offline: the badge simply stays as it was */ }
  }
  function startBadge() { if (badgeTimer) return; refreshBadge(); badgeTimer = setInterval(refreshBadge, 60000); }

  /* ---- the page ---- */
  const item = n => `<li class="notif${n.read ? "" : " unread"}" data-id="${esc(n.id)}">
      <div class="notif-main">${pill(SEV[n.severity] ? SEV[n.severity][0] : "info", SEV[n.severity] ? SEV[n.severity][1] : n.severity)}
        <b>${esc(n.title)}</b>${n.read ? "" : `<span class="caption"> new</span>`}
        <p class="muted">${esc(n.body)}</p>
        <span class="caption">${esc(U.fmtDateTime(n.createdAt))}${n.resolvedAt ? " · resolved " + esc(U.fmtDateTime(n.resolvedAt)) : ""}${n.dismissedAt && !n.resolvedAt ? " · dismissed" : ""}${n.deviceId ? ` · <a href="#/device/${esc(n.deviceId)}">Open device</a>` : ""}</span></div>
      <div class="notif-actions">${!n.read && !n.resolvedAt ? `<button class="btn btn-sm" type="button" data-read="${esc(n.id)}">Mark read</button>` : ""}${!n.resolvedAt && !n.dismissedAt ? `<button class="btn btn-sm" type="button" data-dismiss="${esc(n.id)}">Dismiss</button>` : ""}</div></li>`;

  function prefsForm(p, kinds) {
    return `<section class="card stack"><div class="card-head"><h3>What to be notified about</h3></div>
      <p class="muted">Notifications appear here only. Nothing is emailed or sent anywhere. A dismissed notification does not come back while its problem lasts.</p>
      <form id="npForm" class="stack" autocomplete="off">
        <label class="row"><input type="checkbox" id="npEnabled"${p.enabled ? " checked" : ""} /> <b>Notifications on</b></label>
        ${Object.keys(kinds).map(k => { const t = THRESHOLD[k], v = p.kinds[k];
          return `<div class="row"><label class="row"><input type="checkbox" data-kind="${esc(k)}"${v.on ? " checked" : ""} /> <span>${esc(kinds[k])}</span></label>${t ? `<label class="row caption">after <input class="input compact" type="number" data-th="${esc(k)}" min="${t.min}" max="${t.max}" value="${esc(String(v[t.field]))}" aria-label="${esc(t.label)}" /> ${esc(t.label)}</label>` : ""}</div>`; }).join("")}
        <label class="field">Keep resolved notifications for (days)<input class="input compact" id="npRet" type="number" min="7" max="365" value="${esc(String(p.retentionDays))}" /></label>
        <div class="err" id="npErr" role="alert" hidden></div>
        <div><button class="btn btn-accent" id="npSave" type="submit">Save</button></div>
      </form></section>`;
  }

  async function render(app) {
    const mine = ++seq;
    app.innerHTML = WL.head("Notifications", "Things that need your attention, shown here only. Only you can see this page.",
      `<div class="row"><button class="btn" type="button" id="ntNow">${ic("refresh-cw")}Check now</button><button class="btn" type="button" id="ntAll">Mark all read</button></div>`) +
      `<div id="ntBody" class="stack" aria-live="polite"><div class="tiles"><span class="skel h-card"></span><span class="skel h-card"></span></div></div>`;
    const load = async () => {
      const box = $("ntBody");
      try {
        const [list, prefs] = await Promise.all([WL.api("GET", "/api/notifications?status=" + (view === "active" ? "active" : "all") + "&limit=100"), WL.api("GET", "/api/notifications/preferences")]);
        if (mine !== seq || !document.body.contains(box)) return;
        box.innerHTML = `<div class="row"><button class="btn${view === "active" ? " btn-accent" : ""}" type="button" id="ntVActive">Active</button><button class="btn${view === "all" ? " btn-accent" : ""}" type="button" id="ntVAll">History</button></div>
          <section class="card flush">${list.items.length ? `<ul class="notifs">${list.items.map(item).join("")}</ul>` : WL.empty("bell", view === "active" ? "Nothing needs your attention" : "No notifications yet", view === "active" ? "New problems will appear here and in the sidebar badge." : "")}</section>` + prefsForm(prefs, list.kinds);
        wire(load, prefs); refreshBadge();
      } catch (e) {
        if (e.message === "unauthorized" || e.message === "navigated" || mine !== seq) return;
        box.innerHTML = `<section class="card">${WL.empty("bell", "Notifications could not load", WL.errText(e), `<button class="btn btn-accent" type="button" id="ntRetry">${ic("refresh-cw")}Try again</button>`, "bad")}</section>`;
        $("ntRetry").onclick = () => load();
      }
    };
    $("ntNow").onclick = WL.guarded(async () => { await WL.api("POST", "/api/notifications/evaluate", {}); await load(); });
    $("ntAll").onclick = WL.guarded(async () => { await WL.api("POST", "/api/notifications/read-all", {}); await load(); });
    await load();
  }

  function wire(reload, prefs) {
    $("ntVActive").onclick = () => { view = "active"; reload(); };
    $("ntVAll").onclick = () => { view = "all"; reload(); };
    document.querySelectorAll("[data-read]").forEach(b => { b.onclick = WL.guarded(async () => { await WL.api("POST", `/api/notifications/${encodeURIComponent(b.getAttribute("data-read"))}/read`, {}); await reload(); }); });
    document.querySelectorAll("[data-dismiss]").forEach(b => { b.onclick = WL.guarded(async () => { await WL.api("POST", `/api/notifications/${encodeURIComponent(b.getAttribute("data-dismiss"))}/dismiss`, {}); await reload(); }); });
    $("npForm").onsubmit = WL.guarded(async ev => {
      ev.preventDefault();
      const bad = m => { $("npErr").textContent = m; $("npErr").hidden = false; };
      $("npErr").hidden = true;
      const kinds = {};
      document.querySelectorAll("[data-kind]").forEach(c => { kinds[c.getAttribute("data-kind")] = { on: c.checked }; });
      document.querySelectorAll("[data-th]").forEach(i => { const k = i.getAttribute("data-th"); kinds[k][THRESHOLD[k].field] = Number(i.value); });
      $("npSave").disabled = true;
      try {
        await WL.api("PUT", "/api/notifications/preferences", { enabled: $("npEnabled").checked, kinds, retentionDays: Number($("npRet").value) });
        WL.toast("Notification settings saved."); await reload();
      } catch (e) { bad(e.status === 400 ? "One of the numbers is outside its allowed range." : WL.errText(e)); } finally { const s = $("npSave"); if (s) s.disabled = false; }
    });
  }

  window.WLNotifications = { render, startBadge, refreshBadge };
})();
