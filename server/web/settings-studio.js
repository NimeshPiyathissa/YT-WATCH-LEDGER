/* settings-studio.js: the Settings Studio page (#/settings) of Watch Ledger (window.WLSettings).
   Reads GET /api/settings/studio and saves with PUT /api/settings/studio; the server validates everything and the page only helps. Each group is
   its own form with its own Save and Discard, so nothing is saved by accident. Changes apply at once; what needs a restart is listed read-only.
   Every value shown goes through esc(). No inline styles or scripts. */
(function () {
  "use strict";
  const WL = new Proxy({}, { get: (_t, k) => window.WL[k] }), U = window.YTUtil, esc = U.escapeHtml, ic = window.YTIcons.icon;
  const $ = id => document.getElementById(id);
  let seq = 0;
  const SOURCE = { owner: ["on", "Your setting"], environment: ["info", "From the server's settings file"], default: ["", "Built-in default"] };
  const PAGE_NAMES = { overview: "Overview", analytics: "Analytics", reports: "Reports", history: "History", videos: "Videos", devices: "Devices", notifications: "Notifications", health: "Health" };
  const NAV = [["retention", "Data retention", "database"], ["backups", "Backups", "hard-drive"], ["security", "Pairing and access", "shield-check"], ["notifications", "Notifications", "bell"], ["updates", "Updates", "refresh-cw"], ["preferences", "Your preferences", "settings"], ["restart", "Needs a restart", "server"]];
  const pill = (cls, text) => `<span class="pill ${cls}"><span class="dot"></span><span>${esc(text)}</span></span>`;

  function control(i) {
    const id = "st_" + i.key;
    if (i.type === "bool") return `<label class="switch"><input type="checkbox" id="${id}" data-set="${esc(i.key)}" aria-label="${esc(i.label)}"${i.value ? " checked" : ""}><span class="slider"></span></label>`;
    if (i.type === "enum") return `<select class="input" id="${id}" data-set="${esc(i.key)}" aria-label="${esc(i.label)}">${i.values.map(v => `<option value="${esc(v)}"${v === i.value ? " selected" : ""}>${esc(PAGE_NAMES[v] || v)}</option>`).join("")}</select>`;
    return `<div class="set-num"><input class="input compact" type="number" inputmode="numeric" step="1" min="${i.min}" max="${i.max}" id="${id}" data-set="${esc(i.key)}" aria-label="${esc(i.label)}" value="${esc(String(i.value))}" /><span class="caption">${esc(i.unit || "")}</span></div>`;
  }
  const row = i => `<div class="set-row" data-row="${esc(i.key)}">
      <div class="set-text"><label for="st_${esc(i.key)}"><b>${esc(i.label)}</b></label><p class="muted">${esc(i.help)}</p>
        <span class="caption set-meta">${pill(...(SOURCE[i.source] || SOURCE.default))}${i.env && i.source !== "owner" ? ` <span>variable <span class="mono">${esc(i.env)}</span></span>` : ""}<span>default ${esc(String(i.default === false ? "off" : i.default === true ? "on" : (PAGE_NAMES[i.default] || i.default)))}${i.unit && i.type === "int" ? " " + esc(i.unit) : ""}</span>${i.source === "owner" ? ` <button class="linkbtn" type="button" data-reset="${esc(i.key)}">Use the server default</button>` : ""}</span></div>
      <div class="set-control">${control(i)}</div></div>`;
  const group = g => `<section class="card studio-card" id="sec_${esc(g.key)}" aria-labelledby="h_${esc(g.key)}"><form data-group="${esc(g.key)}" class="stack" autocomplete="off">
      <div class="card-head"><h3 id="h_${esc(g.key)}">${esc(g.title)}</h3></div><p class="muted">${esc(g.intro)}</p>
      <div class="set-rows">${g.items.map(row).join("")}</div>
      <div class="savebar" hidden><span class="caption" role="status">You have unsaved changes.</span><span class="row"><button class="btn" type="button" data-discard>Discard</button><button class="btn btn-accent" type="submit" data-save>Save changes</button></span></div>
      <div class="err" data-err role="alert" hidden></div></form></section>`;

  function view(s) {
    const warn = s.warnings.length ? `<div class="alert warn" role="status">${ic("triangle-alert")}<span><b>Check the server's settings file.</b><br>${s.warnings.map(esc).join("<br>")}</span></div>` : "";
    const byKey = Object.fromEntries(s.groups.map(g => [g.key, g]));
    return `${warn}
      <div class="studio">
        <nav class="studio-nav" aria-label="Settings sections">${NAV.map(([k, t, icn]) => `<button type="button" class="studio-link" data-jump="${k}">${ic(icn)}<span>${esc(t)}</span></button>`).join("")}</nav>
        <div class="studio-main stack">
          ${group(byKey.retention)}${group(byKey.backups)}${group(byKey.security)}
          <section class="card studio-card" id="sec_notifications"><div class="card-head"><h3>Notifications</h3></div><p class="muted">What the dashboard tells you about, and when. These are the same settings as on the Notifications page.</p><div id="stNotif"></div></section>
          ${group(byKey.updates)}${group(byKey.preferences)}
          <section class="card studio-card" id="sec_restart"><div class="card-head"><h3>Needs a restart</h3></div>
            <p class="muted">These are read when the server starts, so they cannot be changed here. To change one, edit the server's settings file (on the installer's layout: <span class="mono">/etc/watch-ledger/watch-ledger.env</span>) and run <span class="mono">sudo systemctl restart watch-ledger</span>. Keys and passwords are never shown.</p>
            <div class="set-rows">${s.restartRequired.map(r => `<div class="set-row"><div class="set-text"><b>${esc(r.label)}</b><p class="muted">${esc(r.help)}</p><span class="caption">variable <span class="mono">${esc(r.env)}</span></span></div><div class="set-control"><span class="mono set-ro">${esc(String(r.value))}</span> ${pill("", "Restart to change")}</div></div>`).join("")}</div></section>
        </div>
      </div>`;
  }

  async function render(app) {
    const mine = ++seq;
    app.innerHTML = WL.head("Settings", "How this server keeps data, backs up and admits devices. Changes apply at once; only you can see this page.") +
      `<div id="stBody" aria-live="polite"><div class="tiles"><span class="skel h-card"></span><span class="skel h-card"></span><span class="skel h-card"></span></div></div>`;
    const load = async () => {
      const box = $("stBody");
      try {
        const s = await WL.api("GET", "/api/settings/studio");
        if (mine !== seq || !document.body.contains(box)) return;
        box.innerHTML = view(s);
        wire(s, load);
        window.WLNotifications.mountPrefs($("stNotif"), { prefs: s.notifications, kinds: s.notificationKinds, onSaved: load });
      } catch (e) {
        if (e.message === "unauthorized" || e.message === "navigated" || mine !== seq) return;
        box.innerHTML = `<section class="card">${WL.empty("triangle-alert", "Settings could not load", WL.errText(e), `<button class="btn btn-accent" type="button" id="stRetry">${ic("refresh-cw")}Try again</button>`, "bad")}</section>`;
        $("stRetry").onclick = () => load();
      }
    };
    await load();
  }

  const valueOf = el => (el.type === "checkbox" ? el.checked : el.tagName === "SELECT" ? el.value : (el.value === "" ? NaN : Number(el.value)));

  function wire(s, reload) {
    const items = {}; s.groups.forEach(g => g.items.forEach(i => { items[i.key] = i; }));
    document.querySelectorAll("[data-jump]").forEach(b => { b.onclick = () => { const el = $("sec_" + b.getAttribute("data-jump")); if (el) el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }; });

    async function save(changes, errBox, confirmCount) {
      try {
        const body = { changes }; if (confirmCount !== undefined) body.confirmRemoveSessions = confirmCount;
        const r = await WL.api("PUT", "/api/settings/studio", body);
        WL.toast(r.changed.length ? `Saved. ${r.changed.length} setting${r.changed.length === 1 ? "" : "s"} changed${r.removedSessions ? `, ${r.removedSessions} old session${r.removedSessions === 1 ? "" : "s"} removed` : ""}.` : "Nothing needed changing.");
        if (WL.applyPrefs) await WL.applyPrefs();
        await reload();
      } catch (e) {
        if (e.status === 409) { // the data changed since the owner looked: ask again with the new number
          const again = await WL.api("GET", "/api/settings/retention-preview?days=" + (changes.server_retention_days === null ? 0 : changes.server_retention_days));
          return confirmThenSave(changes, errBox, again.wouldRemove);
        }
        errBox.textContent = e.status === 400 ? "One of the values is outside its allowed range." : WL.errText(e); errBox.hidden = false;
      }
    }
    async function confirmThenSave(changes, errBox, count) {
      if (count > 0) {
        const ok = await WL.confirmDialog({ title: `Delete ${count} old session${count === 1 ? "" : "s"}?`, body: `Keeping history for ${changes.server_retention_days === null ? "the default" : changes.server_retention_days + " days"} permanently deletes ${count} session${count === 1 ? "" : "s"} older than that from this server. Backups made earlier still contain them. Devices keep their own copy.`, ok: `Delete ${count} and save`, danger: true });
        if (!ok) return;
      }
      return save(changes, errBox, count > 0 ? count : undefined);
    }
    async function submit(changes, errBox) {
      if ("server_retention_days" in changes) {
        const days = changes.server_retention_days === null ? 0 : changes.server_retention_days;
        const p = days > 0 ? await WL.api("GET", "/api/settings/retention-preview?days=" + days) : { wouldRemove: 0 };
        return confirmThenSave(changes, errBox, p.wouldRemove);
      }
      return save(changes, errBox);
    }

    document.querySelectorAll("form[data-group]").forEach(form => {
      const bar = form.querySelector(".savebar"), errBox = form.querySelector("[data-err]");
      const dirty = () => [...form.querySelectorAll("[data-set]")].some(el => { const v = valueOf(el); return v !== items[el.getAttribute("data-set")].value; });
      const refresh = () => { bar.hidden = !dirty(); };
      form.addEventListener("input", refresh); form.addEventListener("change", refresh);
      form.querySelector("[data-discard]").onclick = () => { form.querySelectorAll("[data-set]").forEach(el => { const i = items[el.getAttribute("data-set")]; if (el.type === "checkbox") el.checked = !!i.value; else el.value = String(i.value); }); errBox.hidden = true; refresh(); };
      form.onsubmit = WL.guarded(async ev => {
        ev.preventDefault(); errBox.hidden = true;
        if (!form.checkValidity()) { form.reportValidity(); return; }
        const changes = {};
        form.querySelectorAll("[data-set]").forEach(el => { const k = el.getAttribute("data-set"), v = valueOf(el); if (v !== items[k].value) changes[k] = v; });
        if (!Object.keys(changes).length) { refresh(); return; }
        const btn = form.querySelector("[data-save]"); btn.disabled = true;
        try { await submit(changes, errBox); } finally { btn.disabled = false; }
      });
    });
    document.querySelectorAll("[data-reset]").forEach(b => { b.onclick = WL.guarded(async () => { const k = b.getAttribute("data-reset"), errBox = b.closest("form").querySelector("[data-err]"); await submit({ [k]: null }, errBox); }); });
  }

  window.WLSettings = { render, view };
})();
