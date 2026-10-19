/* Watch Ledger: the owner's private dashboard. Plain JS, hash routing, HttpOnly cookie session (no secrets live here).
   Everything that originates from a device (titles, channels, labels, errors) is untrusted and goes through escapeHtml.
   No inline styles or scripts: the server's CSP forbids them, so colour and size come from classes and SVG attributes. */
(function () {
  "use strict";
  const U = window.YTUtil, C = window.YTCharts, ic = window.YTIcons.icon, esc = U.escapeHtml;
  const $ = id => document.getElementById(id);
  const app = $("app");
  const STALE_MS = 15 * 60 * 1000;        // an approved device that hasn't uploaded for this long shows as offline
  const PAGE = 50;
  let toastT = null, timer = null, devices = [], lastPath = null;

  const toast = m => { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); };

  /* ---- API: cookie session; one silent refresh on 401, then back to sign-in ---- */
  async function refreshed() { const r = await fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" }); return r.ok; }
  async function api(method, path, body, retry) {
    const res = await fetch(path, { method, credentials: "same-origin", headers: body !== undefined ? { "Content-Type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (res.status === 401 && retry !== false && path.indexOf("/api/auth/") !== 0) {
      if (await refreshed()) return api(method, path, body, false);
      location.hash = "#/login"; throw new Error("unauthorized");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || "http_" + res.status); e.status = res.status; throw e; }
    return data;
  }
  async function download(path, name, retry) {
    const res = await fetch(path, { credentials: "same-origin" });
    if (res.status === 401 && retry !== false) { if (await refreshed()) return download(path, name, false); location.hash = "#/login"; throw new Error("unauthorized"); }
    if (!res.ok) throw new Error("http_" + res.status);
    const a = document.createElement("a"); a.href = URL.createObjectURL(await res.blob()); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const ERR = { invalid_credentials: "Wrong email or password.", bad_label: "Use a name of 1 to 80 characters.", bad_command: "The server rejected that command.", device_not_active: "Only approved devices can receive commands.",
    forbidden: "Not allowed.", not_found: "That item no longer exists.", not_pending: "That device was already handled.", confirmation_required: "Confirmation is required.", bad_retention: "Choose 0 to 3650 days." };
  const errText = e => (e && e.status === 429) ? "Too many attempts. Wait a few minutes." : ERR[e && e.message] || "Something went wrong (" + (e && e.message) + ").";
  const guarded = fn => async (...a) => { try { return await fn(...a); } catch (e) { if (e.message !== "unauthorized") toast(errText(e)); } };
  // Page loaders show a styled error state (with a retry) instead of leaving the skeleton on screen.
  const pageGuard = fn => async (...a) => { try { return await fn(...a); } catch (e) { if (e.message !== "unauthorized") showError(e); } };

  /* ---- helpers ---- */
  const when = ts => ts ? U.fmtDateTime(ts) : "Never";
  const ago = ts => { if (!ts) return "Never"; const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; };
  const dur = ms => U.fmtDuration(ms || 0);
  const tz = () => new Date().getTimezoneOffset();
  const qs = o => { const p = new URLSearchParams(); for (const k of Object.keys(o)) if (o[k] !== "" && o[k] != null && o[k] !== "all") p.set(k, o[k]); const s = p.toString(); return s ? "?" + s : ""; };
  const dayStart = v => v ? new Date(v + "T00:00:00").getTime() : "";
  const dayEnd = v => v ? new Date(v + "T23:59:59.999").getTime() : "";
  const colorIdx = id => Math.max(0, devices.findIndex(d => d.id === id)) % 6;
  const chip = (id, label) => `<span class="chip dc${colorIdx(id)}">${esc(label || "Device")}</span>`;
  const safeUrl = u => /^https:\/\/www\.youtube\.com\//.test(u || "") ? u : "";
  function syncState(d) {
    if (d.status === "pending") return { cls: "warn", text: "Awaiting approval" };
    if (d.status === "revoked") return { cls: "bad", text: "Revoked" };
    if (!d.last_push_at) return { cls: "warn", text: "Never synced" };
    return Date.now() - d.last_push_at > STALE_MS ? { cls: "warn", text: "Offline" } : { cls: "on", text: "Synced" };
  }
  const pill = s => `<span class="pill ${s.cls}"><span class="dot"></span><span>${esc(s.text)}</span></span>`;
  // First click arms the button, second runs the action.
  function twoStep(btn, armedText, run) {
    if (!btn) return; let armed = false; const orig = btn.innerHTML;
    btn.addEventListener("click", async () => {
      if (!armed) { armed = true; btn.textContent = armedText; setTimeout(() => { armed = false; btn.innerHTML = orig; }, 6000); return; }
      armed = false; btn.innerHTML = orig; await run();
    });
  }
  const meter = (pct, idx) => `<span class="dc${idx}"><svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="8" rx="4"/><rect class="fill" width="${Math.max(pct > 0 ? 2 : 0, Math.min(100, pct))}" height="8" rx="4"/></svg></span>`;
  const prog = p => p == null ? '<span class="muted">n/a</span>' : `<svg class="prog" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${p}% watched"><rect class="track" width="100" height="6" rx="3"/><rect class="fill" width="${p}" height="6" rx="3"/></svg> <span class="num small">${p}%</span>`;
  async function loadDevices() {
    devices = (await api("GET", "/api/devices")).slice().sort((a, b) => a.enrolled_at - b.enrolled_at);
    const n = devices.filter(d => d.status === "pending").length, b = $("pendingBadge");
    b.textContent = n; b.hidden = n === 0;
    return devices;
  }
  const deviceSelect = (id, val, allLabel) => `<select class="input" id="${id}"><option value="all">${esc(allLabel || "All devices")}</option>${devices.map(d => `<option value="${esc(d.id)}"${d.id === val ? " selected" : ""}>${esc(d.label || "Device")}</option>`).join("")}</select>`;

  /* ---- shared page pieces: header, empty state, loading and error states ---- */
  // title/lede/actions are trusted markup built in this file (never device data).
  const head = (title, lede, actions) => `<header class="page-head"><div><h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ""}</div>${actions ? `<div class="row">${actions}</div>` : ""}</header>`;
  const empty = (icon, title, text, extra, cls) => `<div class="empty${cls ? " " + cls : ""}"><span class="empty-icon">${ic(icon)}</span><h3>${esc(title)}</h3><p>${esc(text)}</p>${extra || ""}</div>`;
  const SKELETON = `<div class="stack" role="status" aria-label="Loading"><span class="skel h-title"></span><div class="grid g4"><span class="skel h-card"></span><span class="skel h-card"></span><span class="skel h-card"></span><span class="skel h-card"></span></div><span class="skel h-block"></span></div>`;
  function showError(e) {
    app.innerHTML = `<section class="card">${empty("triangle-alert", "This page could not load", errText(e), `<button class="btn btn-accent" id="retry">${ic("refresh-cw")}Try again</button>`, "bad")}</section>`;
    $("retry").onclick = route;
  }

  /* ---- navigation drawer (below 960px the sidebar slides over the page) ---- */
  const side = $("side"), scrim = $("scrim"), menuBtn = $("menuBtn");
  function setNav(open) {
    side.classList.toggle("open", open); scrim.hidden = !open; document.body.classList.toggle("nav-open", open);
    menuBtn.setAttribute("aria-expanded", String(open)); menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    if (open) side.querySelector("nav a").focus();
  }
  const closeNav = refocus => { if (side.classList.contains("open")) { setNav(false); if (refocus) menuBtn.focus(); } };
  menuBtn.addEventListener("click", () => setNav(!side.classList.contains("open")));
  scrim.addEventListener("click", () => closeNav(true));
  document.addEventListener("keydown", e => {
    if (!side.classList.contains("open")) return;
    if (e.key === "Escape") return closeNav(true);
    if (e.key !== "Tab") return;
    const f = Array.from(side.querySelectorAll("a[href], button, select")).filter(x => !x.disabled && !x.hidden);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  window.matchMedia("(min-width: 960px)").addEventListener("change", e => { if (e.matches) closeNav(false); });

  /* ---- router ---- */
  function route() {
    clearInterval(timer); timer = null;
    const h = location.hash || "#/overview";
    const login = h === "#/login";
    $("login").hidden = !login; $("shell").hidden = login;
    closeNav(false);
    document.querySelectorAll("[data-nav]").forEach(a => {
      const on = h.indexOf("#/" + a.dataset.nav) === 0 || (a.dataset.nav === "devices" && h.indexOf("#/device/") === 0);
      a.classList.toggle("active", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (h !== lastPath) { window.scrollTo(0, 0); lastPath = h; }
    if (login) return pageLogin();
    app.innerHTML = SKELETON;
    const m = h.match(/^#\/device\/([\w-]+)$/);
    if (m) return pageGuard(pageDevice)(m[1]);
    if (h === "#/history") return pageGuard(pageHistory)();
    if (h === "#/devices") return pageGuard(pageDevices)();
    if (h === "#/data") return pageGuard(pageData)();
    if (h === "#/audit") return pageGuard(pageAudit)();
    return pageGuard(pageOverview)();
  }
  window.addEventListener("hashchange", route);
  $("themeSel").value = window.YTTheme.current();
  $("themeSel").addEventListener("change", () => window.YTTheme.set($("themeSel").value));
  $("logout").addEventListener("click", async () => { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); location.hash = "#/login"; });

  /* ---- sign-in (single owner; the account is created on the server, never through the browser) ---- */
  function loginBars() {
    // Decorative only: a fixed pattern of bars, not data.
    const h = [18, 32, 24, 44, 30, 52, 38, 26, 48, 34, 58, 40, 28, 46, 36, 54, 42, 30, 50, 38], cls = ["", "", "o", "", "v"];
    return `<svg class="login-bars" viewBox="0 0 200 72" preserveAspectRatio="none" aria-hidden="true">${h.map((v, i) => `<rect class="${cls[i % 5]}" x="${i * 10 + 1}" y="${72 - v}" width="7" height="${v}" rx="1.5"/>`).join("")}</svg>`;
  }
  function pageLogin() {
    $("login").innerHTML = `<aside class="login-panel">
        <a class="brand" href="#/login"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>Watch Ledger</a>
        <div class="stack"><h2>Your watch history, kept on your own server.</h2>
          <ul class="facts">
            <li>${ic("lock")}<span><b>Encrypted at rest</b>Every stored record is encrypted with a key that only your server holds.</span></li>
            <li>${ic("shield-check")}<span><b>You approve every device</b>A laptop can upload only after you pair it with a one-time code and approve it.</span></li>
            <li>${ic("scroll-text")}<span><b>Everything is logged</b>Sign-ins, approvals, exports and deletions are written to the audit log.</span></li>
          </ul></div>
        ${loginBars()}
      </aside>
      <section class="login-form"><div class="login-card">
        <a class="brand login-brand-mobile" href="#/login"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>Watch Ledger</a>
        <div class="stack-sm"><h1>Sign in</h1><p class="muted">Private dashboard. Use the owner account.</p></div>
        <div class="form">
          <label class="field">Email<input class="input" id="em" type="email" autocomplete="username" autocapitalize="off" spellcheck="false" /></label>
          <label class="field">Password<input class="input" id="pw" type="password" autocomplete="current-password" /></label>
          <div class="alert bad" id="err" role="alert" hidden></div>
          <button class="btn btn-accent btn-block" id="go" type="button">Sign in</button>
        </div>
        <p class="caption">There is no sign-up. The owner account is created on the server with <span class="mono">node scripts/create-owner.js</span>.</p>
      </div></section>`;
    const submit = async () => {
      const go = $("go"); go.setAttribute("aria-busy", "true"); $("err").hidden = true;
      try { await api("POST", "/api/auth/login", { email: $("em").value.trim(), password: $("pw").value }); location.hash = "#/overview"; }
      catch (e) { $("err").textContent = errText(e); $("err").hidden = false; }
      finally { go.removeAttribute("aria-busy"); }
    };
    $("go").onclick = submit;
    $("login").querySelectorAll("input").forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") submit(); }));
    $("em").focus();
  }

  /* ---- overview: totals, per-device lanes, trend, top lists ---- */
  const ov = { range: "30", device: "all", gran: "daily" };
  // One row of 30 daily bars per device. The bars are SVG that stretches; names and dates are HTML so they never shrink.
  function lanesHtml(series) {
    const n = series[0].daily.length, bw = 7, gap = 3, W = n * (bw + gap), H = 44;
    const max = Math.max(1, ...series.flatMap(s => s.daily.map(d => d.value)));
    const rows = series.map(s => {
      const bars = s.daily.map((d, j) => {
        const h = d.value > 0 ? Math.max(2, Math.round((H - 4) * d.value / max)) : 1.5;
        return `<rect class="${d.value > 0 ? "b" : "z"}" x="${j * (bw + gap) + gap / 2}" y="${H - h}" width="${bw}" height="${h}" rx="1.5"><title>${esc(s.label + ", " + d.key + ": " + dur(d.value))}</title></rect>`;
      }).join("");
      return `<div class="lane dc${s.idx}"><div>${chip(s.id, s.label)}</div><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(s.label)}: daily watch time, last ${n} days"><line class="base" x1="0" x2="${W}" y1="${H}" y2="${H}"/>${bars}</svg></div>`;
    }).join("");
    const ticks = series[0].daily.map((d, j) => (n - 1 - j) % 7 === 0 ? `<span>${esc(d.label)}</span>` : "").join("");
    return `<div class="lanes">${rows}<div class="lane-axis" aria-hidden="true"><span></span><div>${ticks}</div></div></div>`;
  }
  const HOW = `<ol class="steps"><li>Generate a one-time pairing code on the <b>Devices</b> page.</li><li>In the extension, open <b>Admin console</b> and enter this server's address and the code.</li><li>Check the confirmation code matches, then approve the device.</li></ol>`;
  async function pageOverview() {
    await loadDevices();
    const from = ov.range === "0" ? "" : ov.range[0] === "h" ? Date.now() - Number(ov.range.slice(1)) * 3600000 : Date.now() - Number(ov.range) * 86400000;
    const q = qs({ tz: tz(), device: ov.device, from });
    const [s, ...per] = await Promise.all([api("GET", "/api/stats" + q)].concat(devices.map(d => api("GET", "/api/stats" + qs({ tz: tz(), device: d.id })))));
    const series = devices.map((d, i) => ({ id: d.id, label: d.label || "Device", idx: colorIdx(d.id), daily: per[i].daily })).filter((x, i) => devices[i].status !== "pending");
    const max = Math.max(1, ...s.byDevice.map(d => d.totalMs));
    const approved = devices.filter(d => d.status === "active").length;
    const filters = devices.length ? `<label class="field">Period<select class="input" id="ovRange">${[["1", "Last 1 day"]].concat(Array.from({ length: 24 }, (_, i) => ["h" + (i + 1), "Last " + (i + 1) + (i ? " hours" : " hour")]), [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["0", "All time"]]).map(([v, t]) => `<option value="${v}"${v === ov.range ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field">Device${deviceSelect("ovDev", ov.device)}</label>` : "";
    const lede = devices.length ? `${approved} approved device${approved === 1 ? "" : "s"} syncing into this one ledger.` : "Watch time from every device you approve is collected here.";
    app.innerHTML = head("Overview", lede, filters) + (!devices.length ? `<section class="card">${empty("monitor-smartphone", "No devices paired yet", "Pair a laptop and its YouTube watch time starts building your ledger. Nothing is uploaded until you approve the device.", `<a class="btn btn-accent" href="#/devices">${ic("plus")}Add your first device</a>`)}<div class="note">${HOW}</div></section>` : `
      <section class="statbar" aria-label="Totals">
        <div class="stat lead"><div class="k">Watched in period</div><div class="v num">${dur(s.totalMs)}</div><div class="s">${s.sessions} sessions · ${s.videos} videos</div></div>
        <div class="stat"><div class="k">Today</div><div class="v num">${dur(s.todayMs)}</div></div>
        <div class="stat"><div class="k">Last 7 days</div><div class="v num">${dur(s.last7Ms)}</div></div>
        <div class="stat"><div class="k">Last 30 days</div><div class="v num">${dur(s.last30Ms)}</div><div class="s">${s.completions} finished · ${s.seeks} seeks · ${s.pauses} pauses</div></div>
      </section>
      <section class="card"><div class="card-head"><h3>Activity by device</h3><span class="sub">Last 30 days</span></div>
        ${series.length ? lanesHtml(series) : empty("clock", "No approved devices yet", "Approve a pending device on the Devices page and its activity appears here.")}</section>
      <section class="card"><div class="card-head"><h3>Watch time</h3>
        <div class="tabs" role="group" aria-label="Chart range">${[["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]].map(([v, t]) => `<button type="button" data-g="${v}" aria-pressed="${v === ov.gran}">${t}</button>`).join("")}</div></div>
        <div id="trend"></div></section>
      <div class="grid g2">
        <section class="card"><div class="card-head"><h3>Time per device</h3></div>${s.byDevice.map(d => `<div class="meter"><span>${chip(d.deviceId, d.label)}</span><span class="num">${dur(d.totalMs)}</span>${meter(Math.round(d.totalMs / max * 100), colorIdx(d.deviceId))}</div>`).join("") || '<p class="muted">No data in this period.</p>'}</section>
        <section class="card"><div class="card-head"><h3>Top channels</h3></div>${s.topChannels.length ? `<ul class="ledger">${s.topChannels.slice(0, 6).map(c => `<li><span class="name">${esc(c.channel)}</span><span class="lead"></span><span class="amt">${dur(c.totalMs)}</span></li>`).join("")}</ul>` : '<p class="muted">No data in this period.</p>'}</section>
      </div>
      <section class="card flush"><div class="card-head"><h3>Most watched videos</h3></div>${s.topVideos.length ? `<table class="table rtable"><thead><tr><th>Video</th><th class="right">Views</th><th class="right">Total</th></tr></thead><tbody>
        ${s.topVideos.slice(0, 8).map(v => `<tr><td data-primary class="cell-primary">${safeUrl(v.url) ? `<a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${esc(v.title || v.videoId)}</a>` : esc(v.title || v.videoId)}</td><td class="num right" data-label="Views">${v.views}</td><td class="num right" data-label="Total">${dur(v.totalMs)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty"><p>No data in this period.</p></div>`}</section>`);
    if (!devices.length) return;
    const drawTrend = () => { C.barChart($("trend"), s[ov.gran], dur); app.querySelectorAll("[data-g]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.g === ov.gran))); };
    drawTrend();
    app.querySelectorAll("[data-g]").forEach(b => b.onclick = () => { ov.gran = b.dataset.g; drawTrend(); });
    $("ovRange").onchange = () => { ov.range = $("ovRange").value; route(); };
    $("ovDev").onchange = () => { ov.device = $("ovDev").value; route(); };
  }

  /* ---- history: every device in one list, with filters, export and per-session detail ---- */
  const hf = { device: "all", from: "", to: "", q: "", url: "", offset: 0 };
  async function pageHistory() {
    await loadDevices();
    app.innerHTML = head("History", "Every viewing session from every approved device, newest first. Times are placed on the server's clock, so a laptop with a wrong clock still lines up.",
        `<button class="btn" id="exCsv" type="button">${ic("download")}Export CSV</button><button class="btn" id="exJson" type="button">${ic("download")}Export JSON</button>`) + `
      <form class="card filters" id="hform" autocomplete="off">
        <label class="field">Device${deviceSelect("hDev", hf.device)}</label>
        <label class="field">From<input class="input" type="date" id="hFrom" value="${esc(hf.from)}" /></label>
        <label class="field">To<input class="input" type="date" id="hTo" value="${esc(hf.to)}" /></label>
        <label class="field">Title or channel<input class="input" id="hQ" value="${esc(hf.q)}" placeholder="e.g. rust" /></label>
        <label class="field">URL contains<input class="input" id="hUrl" value="${esc(hf.url)}" placeholder="video id or /shorts/" /></label>
        <button class="btn" type="button" id="hClear">${ic("x")}Clear filters</button></form>
      <section class="card flush"><div id="hres"><span class="skel h-block"></span></div></section>`;
    let t = null;
    const load = guarded(async () => {
      const r = await api("GET", "/api/history" + qs({ limit: PAGE, offset: hf.offset, device: hf.device, from: dayStart(hf.from), to: dayEnd(hf.to), q: hf.q, url: hf.url }));
      renderRows(r);
    });
    const sync = () => { hf.device = $("hDev").value; hf.from = $("hFrom").value; hf.to = $("hTo").value; hf.q = $("hQ").value.trim(); hf.url = $("hUrl").value.trim(); hf.offset = 0; };
    $("hform").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { sync(); load(); }, 250); });
    $("hform").addEventListener("submit", e => e.preventDefault());
    $("hClear").onclick = () => { Object.assign(hf, { device: "all", from: "", to: "", q: "", url: "", offset: 0 }); pageHistory(); };
    $("exCsv").onclick = guarded(() => download("/api/export" + qs({ format: "csv", device: hf.device, from: dayStart(hf.from), to: dayEnd(hf.to), q: hf.q, url: hf.url }), "watch-history.csv"));
    $("exJson").onclick = guarded(() => download("/api/export" + qs({ format: "json", device: hf.device, from: dayStart(hf.from), to: dayEnd(hf.to), q: hf.q, url: hf.url }), "watch-history.json"));
    function renderRows(r) {
      const box = $("hres");
      if (!r.items.length) {
        const clean = r.total === 0 && !hf.q && !hf.url && !hf.from && !hf.to && hf.device === "all";
        box.innerHTML = clean ? empty("film", "No viewing recorded yet", "Sessions appear here a few seconds after a paired device finishes or pauses a video.") : empty("search", "No sessions match these filters", "Try a wider date range, or clear the filters.");
        return;
      }
      box.innerHTML = `<p class="caption result-meta">${r.total} session${r.total === 1 ? "" : "s"}${r.truncated ? " (list capped; narrow the dates)" : ""}</p><table class="table rtable"><thead><tr><th>Video</th><th>Device</th><th>Started</th><th class="right">Watched</th><th class="right">Progress</th><th class="right">Seeks / pauses</th></tr></thead><tbody>
        ${r.items.map((it, i) => `<tr class="click" tabindex="0" data-i="${i}" aria-expanded="false"><td data-primary><div class="cell-primary clip">${esc(it.title || it.videoId)}</div><div class="cell-sub">${esc(it.channel)}</div></td><td data-label="Device">${chip(it.deviceId, it.deviceLabel)}</td><td class="num" data-label="Started">${esc(U.fmtDateTime(it.startTs))}</td><td class="num right" data-label="Watched">${dur(it.watchedMs)}</td><td class="right" data-label="Progress"><span class="cell-prog">${prog(it.progress)}${it.completed ? ' <span class="pill on"><span class="dot"></span><span>Finished</span></span>' : ""}</span></td><td class="num right" data-label="Seeks / pauses">${it.seeks} / ${it.pauses}</td></tr>`).join("")}</tbody></table>
        <div class="pager"><button class="btn" id="pPrev" type="button" ${hf.offset === 0 ? "disabled" : ""}>${ic("chevron-left")}Previous</button><span class="caption num">${hf.offset + 1} to ${hf.offset + r.items.length} of ${r.total}</span><button class="btn" id="pNext" type="button" ${hf.offset + PAGE >= r.total ? "disabled" : ""}>Next${ic("chevron-right")}</button></div>`;
      $("pPrev").onclick = () => { hf.offset = Math.max(0, hf.offset - PAGE); load(); };
      $("pNext").onclick = () => { hf.offset += PAGE; load(); };
      const toggle = tr => {
        const open = tr.nextElementSibling && tr.nextElementSibling.classList.contains("detail");
        box.querySelectorAll("tr.detail").forEach(x => x.remove());
        box.querySelectorAll("tr.click").forEach(x => x.setAttribute("aria-expanded", "false"));
        if (open) return;
        tr.setAttribute("aria-expanded", "true");
        const it = r.items[Number(tr.dataset.i)], url = safeUrl(it.url);
        const skew = it.skewMs ? `, device clock was ${Math.abs(Math.round(it.skewMs / 60000))} min ${it.skewMs > 0 ? "behind" : "ahead"}` : "";
        tr.insertAdjacentHTML("afterend", `<tr class="detail"><td colspan="6"><dl class="kv tr-detail-box">
          <dt>Source device</dt><dd>${chip(it.deviceId, it.deviceLabel)}</dd>
          <dt>Video</dt><dd>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : esc(it.videoId)} (${esc(it.kind)})</dd>
          <dt>Started</dt><dd class="num">${esc(when(it.startTs))}${it.endTs ? " to " + esc(when(it.endTs)) : " (still open or not ended cleanly)"}</dd>
          <dt>As the device saw it</dt><dd class="num">${esc(when(it.deviceStartTs))}${esc(skew)}</dd>
          <dt>Watched</dt><dd class="num">${dur(it.watchedMs)} of ${it.duration ? dur(it.duration * 1000) : "unknown length"}</dd>
          <dt>Position</dt><dd class="num">started at ${it.startSec == null ? "n/a" : it.startSec + " s"}, ended at ${it.positionSec} s, furthest ${it.furthestSec} s</dd>
          <dt>Interaction</dt><dd>${it.seeks} seeks (${it.rewinds} backwards), ${it.pauses} pauses${it.completed ? ", finished" : ""}</dd>
          <dt>Session</dt><dd class="num small">${esc(it.sessionId)} · revision ${it.rev}</dd></dl></td></tr>`);
      };
      box.querySelectorAll("tr.click").forEach(tr => { tr.onclick = () => toggle(tr); tr.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(tr); } }; });
    }
    load();
  }

  /* ---- devices: pairing, approval, sync health, rename / revoke / remove ---- */
  function deviceCard(d) {
    const st = syncState(d), idx = colorIdx(d.id);
    if (d.status === "pending") return `<article class="card dev pendingcard dc${idx}" data-id="${esc(d.id)}"><div class="top"><div><h2>${esc(d.label || "New device")}</h2><span class="muted small">${esc(d.platform || "")} · asked to join ${esc(ago(d.enrolled_at))}</span></div>${pill(st)}</div>
      <p>Confirm that the code on the device matches before you approve it:</p><div class="confirm">${esc(d.confirm_code || "")}</div>
      <p class="muted small">Approving lets this device upload its viewing history to the ledger. Rejecting deletes it and its pairing credential.</p>
      <div class="actions"><button class="btn btn-accent" data-act="approve" type="button">${ic("check")}Approve device</button><button class="btn btn-danger" data-act="reject" type="button">${ic("x")}Reject</button></div></article>`;
    return `<article class="card dev dc${idx}" data-id="${esc(d.id)}"><div class="top"><div class="row"><span class="chip dc${idx}"><b>${esc(d.label || "Device")}</b></span><span class="muted small">${esc(d.platform || "")}</span></div>${pill(st)}</div>
      <dl class="kv"><dt>Last upload</dt><dd>${esc(ago(d.last_push_at))}${d.last_push_at ? ` <span class="muted small">(${esc(U.fmtDateTime(d.last_push_at))})</span>` : ""}</dd>
        <dt>Pending on device</dt><dd class="num">${d.pending_count || 0} event${d.pending_count === 1 ? "" : "s"} waiting to upload</dd>
        <dt>Last contact</dt><dd>${esc(ago(d.last_seen))}</dd>
        <dt>Records here</dt><dd class="num">${d.counts.sessions} sessions · ${d.counts.videos} videos</dd>
        <dt>Device clock</dt><dd class="num">${d.clock_skew_ms ? Math.abs(Math.round(d.clock_skew_ms / 60000)) + " min " + (d.clock_skew_ms > 0 ? "behind" : "ahead") + ", corrected" : "in step with the server"}</dd>
        <dt>Paired</dt><dd>${esc(when(d.approved_at || d.enrolled_at))}${d.client_version ? ` · extension ${esc(d.client_version)}` : ""}</dd>
        ${d.last_error ? `<dt>Last error on device</dt><dd class="err">${esc(d.last_error)}</dd>` : ""}</dl>
      <div class="actions"><a class="btn" href="#/history" data-act="hist">${ic("history")}View history</a><a class="btn" href="#/device/${esc(d.id)}">${ic("sliders-horizontal")}Controls</a><button class="btn" data-act="rename" type="button">${ic("pencil")}Rename</button>
        <button class="btn btn-danger" data-act="revoke" type="button" ${d.status !== "active" ? "disabled" : ""}>${ic("unlink")}Revoke access</button><button class="btn btn-danger" data-act="remove" type="button">${ic("trash-2")}Remove device</button></div></article>`;
  }
  async function pageDevices() {
    await loadDevices();
    const origin = location.origin;
    app.innerHTML = head("Devices", "Only devices you pair and approve can upload. Revoking cuts a device off at once; removing it also deletes everything it synced.") + `
      <section class="card stack"><div class="card-head"><h3>Add a device</h3></div>
        <ol class="steps"><li>Name it and generate a one-time pairing code (valid 15 minutes, works once).</li>
          <li>On that laptop, open the extension: <b>Admin console → Private sync</b>. Enter <span class="mono">${esc(origin)}</span> and the code.</li>
          <li>It appears below as <b>Awaiting approval</b>. Check the confirmation code matches, then approve it.</li></ol>
        <div class="row"><input class="input compact" id="lbl" placeholder="e.g. Laptop 2" maxlength="80" aria-label="Device name" /><button class="btn btn-accent" id="mk" type="button">${ic("key-round")}Generate pairing code</button></div>
        <div id="codeBox" class="stack" hidden></div></section>
      <div id="list" class="grid"></div>`;
    const draw = () => {
      // Devices waiting for a decision come first.
      $("list").innerHTML = devices.slice().sort((a, b) => (b.status === "pending") - (a.status === "pending")).map(deviceCard).join("") || `<section class="card">${empty("monitor-smartphone", "No devices yet", "Generate a pairing code above to add your first one.")}</section>`;
      $("list").querySelectorAll("article").forEach(card => {
        const id = card.dataset.id, d = devices.find(x => x.id === id), btn = a => card.querySelector(`[data-act="${a}"]`);
        const done = async (msg, fn) => { await guarded(fn)(); toast(msg); await loadDevices(); draw(); };
        if (btn("approve")) btn("approve").onclick = () => done("Approved. It will start uploading within a minute.", () => api("POST", `/api/devices/${id}/approve`));
        twoStep(btn("reject"), "Click again to reject", () => done("Rejected and removed.", () => api("DELETE", `/api/devices/${id}`)));
        twoStep(btn("revoke"), "Click again to revoke", () => done("Revoked. It can no longer upload or read anything.", () => api("POST", `/api/devices/${id}/revoke`)));
        twoStep(btn("remove"), "Click again: delete device and its data", () => done("Device and its synced data deleted.", () => api("DELETE", `/api/devices/${id}`)));
        if (btn("hist")) btn("hist").onclick = () => { hf.device = id; };
        if (btn("rename")) btn("rename").onclick = () => {
          const h = card.querySelector(".top .row, .top div");
          h.innerHTML = `<div class="rename-row"><input class="input" id="rn" maxlength="80" value="${esc(d.label || "")}" aria-label="New name" /><button class="btn btn-accent" id="rnGo" type="button">Save</button></div>`;
          card.querySelector("#rn").focus();
          const save = () => done("Renamed.", () => api("PATCH", `/api/devices/${id}`, { label: card.querySelector("#rn").value.trim() }));
          card.querySelector("#rnGo").onclick = save; card.querySelector("#rn").onkeydown = e => { if (e.key === "Enter") save(); };
        };
      });
    };
    draw();
    $("mk").onclick = guarded(async () => {
      const r = await api("POST", "/api/devices/enroll-code", { label: $("lbl").value.trim() });
      const b = $("codeBox"); b.hidden = false;
      b.innerHTML = `<div class="code" aria-label="Pairing code">${esc(r.code)}</div><div class="caption">Shown once. Expires ${esc(U.fmtDateTime(r.expiresAt))}.</div>`;
    });
    // Live sync status, unless the owner is typing.
    timer = setInterval(async () => { if (document.activeElement && document.activeElement.tagName === "INPUT") return; try { await loadDevices(); draw(); } catch (_e) { /* signed out */ } }, 10000);
  }

  /* ---- one device: remote controls ---- */
  async function pageDevice(id) {
    await loadDevices();
    const dev = devices.find(d => d.id === id);
    if (!dev) { location.hash = "#/devices"; return; }
    const commands = await api("GET", `/api/devices/${id}/commands`);
    const active = dev.status === "active", dis = active ? "" : "disabled";
    app.innerHTML = `<div><a class="back" href="#/devices">${ic("arrow-left")}Devices</a></div>
      ${head(`<span class="row">${esc(dev.label || "Device")} ${pill(syncState(dev))}</span>`, "Commands wait on the server and are applied the next time the extension syncs (within about five minutes). They are visible on the device. They change data stored <b>on that laptop</b>; to delete what is stored on this server use <a href=\"#/data\">Data &amp; backups</a>.")}
      <section class="card stack"><div class="card-head"><h3>Controls</h3></div>
        <div class="group-row stack-sm"><span class="eyebrow">Tracking</span><div class="row"><button class="btn" data-cmd="pause_tracking" type="button" ${dis}>${ic("pause")}Pause tracking</button><button class="btn" data-cmd="resume_tracking" type="button" ${dis}>${ic("play")}Resume tracking</button></div></div>
        <div class="group-row stack-sm"><span class="eyebrow">Retention on the device</span><div class="row"><select class="input compact" id="retSel" aria-label="Retention on device"><option value="0">Keep forever</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option></select><button class="btn" id="retGo" type="button" ${dis}>Set retention on device</button></div></div>
        <div class="group-row stack-sm"><span class="eyebrow">Delete data on the device</span><div class="row"><label class="field">From<input type="date" class="input" id="dFrom" /></label><label class="field">To<input type="date" class="input" id="dTo" /></label></div>
          <div class="row"><button class="btn btn-danger" id="dRange" type="button" ${dis}>${ic("trash-2")}Delete range on device</button><button class="btn btn-danger" id="dAll" type="button" ${dis}>${ic("trash-2")}Delete all on device</button></div></div>
        ${active ? "" : '<p class="note">Only approved, non-revoked devices can receive commands.</p>'}<div class="err" id="cErr" role="alert" hidden></div></section>
      <section class="card flush"><div class="card-head"><h3>Recent commands</h3></div>${commands.length ? `<table class="table rtable"><thead><tr><th>Command</th><th>Status</th><th>Queued</th><th>Result</th></tr></thead><tbody>
        ${commands.map(c => `<tr><td data-primary><span class="cell-primary mono">${esc(c.type)}</span> <span class="cell-sub">${esc(Object.keys(c.payload).length ? JSON.stringify(c.payload) : "")}</span></td><td data-label="Status">${esc(c.status)}</td><td class="num" data-label="Queued">${esc(when(c.created_at))}</td><td data-label="Result">${esc(c.result ? c.result.status + (c.result.error ? ": " + c.result.error : "") : "waiting")}</td></tr>`).join("")}</tbody></table>` : empty("terminal", "No commands yet", "Commands you send to this device are listed here with their result.")}</section>`;
    const send = guarded(async (type, payload) => { await api("POST", `/api/devices/${id}/commands`, { type, payload }); toast("Queued. It applies on the device's next sync."); await pageDevice(id); });
    app.querySelectorAll("[data-cmd]").forEach(b => b.onclick = () => send(b.dataset.cmd, {}));
    $("retSel").value = String(dev.retention_days || 0);
    $("retGo").onclick = () => send("set_retention", { days: Number($("retSel").value) });
    twoStep($("dAll"), "Click again: delete ALL history on the device", () => send("delete_all", {}));
    twoStep($("dRange"), "Click again to confirm range delete", () => {
      if (!$("dFrom").value || !$("dTo").value) { $("cErr").textContent = "Pick both dates."; $("cErr").hidden = false; return; }
      $("cErr").hidden = true; return send("delete_range", { from: dayStart($("dFrom").value), to: dayEnd($("dTo").value) });
    });
  }

  /* ---- data: export, server-side deletion, retention, backups ---- */
  async function pageData() {
    await loadDevices();
    const [sys, set] = await Promise.all([api("GET", "/api/system"), api("GET", "/api/settings")]);
    app.innerHTML = head("Data &amp; backups", "Everything here is about the copy stored on this server. Each laptop keeps its own local copy, which you control from the extension or from a device's Controls page.") + `
      <div class="grid g2">
        <section class="card stack"><div class="card-head"><h3>Export</h3></div><p class="muted">Download all synced history from every device.</p>
          <div class="row"><button class="btn" id="exCsv" type="button">${ic("download")}Download CSV</button><button class="btn" id="exJson" type="button">${ic("download")}Download JSON</button></div></section>
        <section class="card stack"><div class="card-head"><h3>Retention on the server</h3></div><p class="muted">Older sessions are removed automatically. Applies immediately.</p>
          <div class="row"><select class="input compact" id="retSel" aria-label="Server retention">${[[0, "Keep forever"], [30, "30 days"], [90, "90 days"], [180, "180 days"], [365, "1 year"], [730, "2 years"]].map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select><button class="btn" id="retGo" type="button">Apply</button></div></section>
      </div>
      <section class="card flush"><div class="card-head"><h3>Backups</h3><button class="btn btn-accent" id="bkNow" type="button">${ic("hard-drive")}Back up now</button></div>
        <div class="stack result-meta"><p class="muted">Database ${esc(U.fmtBytes(sys.dbBytes))} · keeping the newest ${sys.backupKeep}. Last backup: ${esc(sys.lastBackupAt ? U.fmtDateTime(sys.lastBackupAt) : "never")}. Backups hold encrypted records: restoring one needs the same <span class="mono">MASTER_KEY</span>. Restore steps are in <span class="mono">docs/OPERATIONS.md</span>.</p></div>
        ${sys.backups.length ? `<table class="table rtable"><thead><tr><th>File</th><th>Created</th><th class="right">Size</th></tr></thead><tbody>${sys.backups.map(b => `<tr><td data-primary class="num cell-primary">${esc(b.name)}</td><td class="num" data-label="Created">${esc(U.fmtDateTime(b.createdAt))}</td><td class="num right" data-label="Size">${esc(U.fmtBytes(b.size))}</td></tr>`).join("")}</tbody></table>` : empty("hard-drive", "No backups yet", "Use Back up now to take the first one.")}</section>
      <section class="card danger-zone stack"><div class="card-head"><h3>Delete synced data</h3></div><p class="muted">Permanently removes sessions from this server. This cannot be undone; restore a backup if you change your mind.</p>
        <div class="filters"><label class="field">Device${deviceSelect("xDev", "all")}</label><label class="field">From<input class="input" type="date" id="xFrom" /></label><label class="field">To<input class="input" type="date" id="xTo" /></label>
          <label class="field">Type DELETE to confirm<input class="input" id="xOk" autocomplete="off" /></label></div>
        <div><button class="btn btn-danger" id="xGo" type="button">${ic("trash-2")}Delete matching data</button></div>
        <p class="caption">Leave the dates empty to delete everything for the chosen device(s).</p><div class="err" id="xErr" role="alert" hidden></div></section>`;
    $("retSel").value = String(set.server_retention_days || 0);
    $("exCsv").onclick = guarded(() => download("/api/export?format=csv", "watch-history.csv"));
    $("exJson").onclick = guarded(() => download("/api/export?format=json", "watch-history.json"));
    $("retGo").onclick = guarded(async () => { const r = await api("PUT", "/api/settings", { server_retention_days: Number($("retSel").value) }); toast(r.removed ? `Retention applied. ${r.removed} old sessions removed.` : "Retention applied."); });
    $("bkNow").onclick = guarded(async () => { $("bkNow").disabled = true; try { await api("POST", "/api/system/backup"); toast("Backup created."); } finally { await pageData(); } });
    $("xGo").onclick = guarded(async () => {
      const bad = m => { $("xErr").textContent = m; $("xErr").hidden = false; };
      if ($("xOk").value !== "DELETE") return bad("Type DELETE (capitals) to confirm.");
      $("xErr").hidden = true;
      const r = await api("POST", "/api/data/delete", { confirm: true, device: $("xDev").value === "all" ? undefined : $("xDev").value, from: dayStart($("xFrom").value) || undefined, to: dayEnd($("xTo").value) || undefined });
      toast(`Deleted ${r.deleted} session${r.deleted === 1 ? "" : "s"}.`); $("xOk").value = "";
    });
  }

  /* ---- audit log ---- */
  const ACT_CLASS = { login: "ok", approve: "ok", backup: "ok", pairing_code_created: "ok", pair_requested: "sec", revoke: "sec", device_unenrolled: "sec", refresh_reuse_detected: "sec", delete_data: "del", delete_device: "del" };
  const actClass = a => ACT_CLASS[a] || (a.indexOf("enqueue:delete") === 0 ? "del" : "");
  // Detail is stored as JSON text; show it as "key: value" pairs when it parses, otherwise as-is.
  function fmtDetail(s) {
    if (!s) return "";
    try { const o = JSON.parse(s); if (o && typeof o === "object" && !Array.isArray(o)) return Object.keys(o).map(k => k + ": " + (o[k] !== null && typeof o[k] === "object" ? JSON.stringify(o[k]) : String(o[k]))).join("  ·  "); } catch (_e) { /* not JSON */ }
    return String(s);
  }
  async function pageAudit() {
    const [log] = await Promise.all([api("GET", "/api/audit"), loadDevices()]);
    const name = id => { const d = devices.find(x => x.id === id); return id ? (d ? d.label || "Device" : "(removed device)") : "—"; };
    app.innerHTML = head("Audit log", "The 200 most recent security-relevant events: sign-ins, pairing, approvals, revocations, exports, deletions and backups.") + `
      <section class="card flush">${log.length ? `<table class="table rtable"><thead><tr><th>When</th><th>Action</th><th>Device</th><th>IP</th></tr></thead><tbody>
      ${log.map(r => `<tr><td data-primary class="when">${esc(U.fmtDateTime(r.created_at))}</td><td data-label="Action"><span class="act ${actClass(r.action)}">${esc(r.action)}</span>${r.detail ? `<pre class="detail">${esc(fmtDetail(r.detail))}</pre>` : ""}</td><td data-label="Device">${esc(name(r.device_id))}</td><td class="num" data-label="IP">${esc(r.ip || "—")}</td></tr>`).join("")}</tbody></table>` : empty("scroll-text", "Nothing recorded yet", "Sign-ins, pairing, exports and deletions are listed here as they happen.")}</section>`;
  }

  route();
})();
