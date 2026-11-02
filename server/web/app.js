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
  let toastT = null, timer = null, devices = [], lastPath = null, pairing = null, cpTimer = null, evSource = null;

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
  const prog = (p, anim) => p == null ? '<span class="muted">n/a</span>' : `<svg class="prog" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${p}% watched"><rect class="track" width="100" height="6" rx="3"/><rect class="fill" width="${anim ? 0 : p}" data-w="${p}" height="6" rx="3"/></svg> <span class="num small">${p}%</span>`;
  // Grow freshly rendered bars from 0 to their value (the CSS transition lives behind prefers-reduced-motion; with it set they just snap).
  const growBars = root => {
    const bars = root.querySelectorAll(".prog .fill[data-w]");
    const set = () => bars.forEach(b => b.setAttribute("width", b.dataset.w));
    if (!bars.length) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) set(); else requestAnimationFrame(() => requestAnimationFrame(set));
  };
  const clock = ms => { const t = Math.max(0, Math.floor((ms || 0) / 1000)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), x = t % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
  async function loadDevices() {
    devices = (await api("GET", "/api/devices")).slice().sort((a, b) => a.enrolled_at - b.enrolled_at);
    // the sidebar badge counts devices awaiting approval plus session deletion requests awaiting a decision
    const n = devices.filter(d => d.status === "pending").length + devices.reduce((t, d) => t + (d.pending_requests || 0), 0), b = $("pendingBadge");
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
    clearInterval(timer); timer = null; clearInterval(cpTimer); cpTimer = null; closeEvents();
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
    const dm = h.match(/^#\/devices(?:\/(requests|sessions|pairing))?$/);
    if (dm) return pageGuard(pageDevices)(dm[1]);
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
  // A session is "live" only if it has not ended AND the server accepted a push for it within LIVE_MS. The extension flushes every 5 s
  // while playing and syncs ~5 s later, so a healthy live session is at most ~10-15 s old; a paused tab stops flushing and so stops being live.
  const LIVE_MS = 30000, POLL_MS = 10000;
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
    let offset = 0, liveTick = null, livePoll = null;
    const serverNow = () => Date.now() + offset;
    const isLive = it => !it.endTs && it.updatedAt != null && serverNow() - it.updatedAt < LIVE_MS;
    function renderRows(r) {
      const box = $("hres");
      offset = r.serverNow - Date.now();
      clearInterval(liveTick); clearInterval(livePoll);
      const live = new Map();
      for (const it of r.items) if (isLive(it)) live.set(it.sessionId, { base: it.watchedMs, at: it.updatedAt });
      if (!r.items.length) {
        const clean = r.total === 0 && !hf.q && !hf.url && !hf.from && !hf.to && hf.device === "all";
        box.innerHTML = clean ? empty("film", "No viewing recorded yet", "Sessions appear here a few seconds after a paired device finishes or pauses a video.") : empty("search", "No sessions match these filters", "Try a wider date range, or clear the filters.");
        return;
      }
      box.innerHTML = `<p class="caption result-meta">${r.total} session${r.total === 1 ? "" : "s"}${r.truncated ? " (list capped; narrow the dates)" : ""}</p><table class="table rtable"><thead><tr><th>Video</th><th>Device</th><th>Started</th><th class="right">Watched</th><th class="right">Progress</th><th class="right">Seeks / pauses</th></tr></thead><tbody>
        ${r.items.map((it, i) => `<tr class="click" tabindex="0" data-i="${i}" aria-expanded="false"><td data-primary><div class="cell-primary clip">${esc(it.title || it.videoId)}</div><div class="cell-sub">${esc(it.channel)}</div></td><td data-label="Device">${chip(it.deviceId, it.deviceLabel)}</td><td class="num" data-label="Started">${esc(U.fmtDateTime(it.startTs))}</td><td class="num right" data-label="Watched">${live.has(it.sessionId) ? `<span class="pill on live"><span class="dot"></span><span>Live</span></span> <span class="live-t" data-sid="${esc(it.sessionId)}">${clock(it.watchedMs)}</span>` : dur(it.watchedMs)}</td><td class="right" data-label="Progress"><span class="cell-prog">${prog(it.progress, true)}${it.completed ? ' <span class="pill on"><span class="dot"></span><span>Finished</span></span>' : ""}</span></td><td class="num right" data-label="Seeks / pauses">${it.seeks} / ${it.pauses}</td></tr>`).join("")}</tbody></table>
        <div class="pager"><button class="btn" id="pPrev" type="button" ${hf.offset === 0 ? "disabled" : ""}>${ic("chevron-left")}Previous</button><span class="caption num">${hf.offset + 1} to ${hf.offset + r.items.length} of ${r.total}</span><button class="btn" id="pNext" type="button" ${hf.offset + PAGE >= r.total ? "disabled" : ""}>Next${ic("chevron-right")}</button></div>`;
      growBars(box);
      if (live.size) {
        const gone = () => !document.body.contains(box);
        liveTick = setInterval(() => {
          if (gone()) { clearInterval(liveTick); clearInterval(livePoll); return; }
          for (const el of box.querySelectorAll(".live-t")) {
            const st = live.get(el.dataset.sid); if (!st) continue;
            const age = serverNow() - st.at;
            if (age >= LIVE_MS) { // no push for LIVE_MS: stop pretending, show the last synced figure
              live.delete(el.dataset.sid);
              el.parentElement.innerHTML = dur(st.base);
            } else el.textContent = clock(st.base + age);
          }
          if (!live.size) { clearInterval(liveTick); clearInterval(livePoll); }
        }, 1000);
        livePoll = setInterval(async () => { // pick up fresh pushes (or an ended session) without disturbing an open detail row
          if (gone()) { clearInterval(liveTick); clearInterval(livePoll); return; }
          try {
            const n = await api("GET", "/api/history" + qs({ limit: PAGE, offset: hf.offset, device: hf.device, from: dayStart(hf.from), to: dayEnd(hf.to), q: hf.q, url: hf.url }));
            offset = n.serverNow - Date.now();
            let rerender = false;
            for (const it of n.items) {
              const st = live.get(it.sessionId); if (!st) continue;
              if (it.endTs || it.updatedAt == null) rerender = true;
              else if (it.updatedAt > st.at) { st.at = it.updatedAt; st.base = it.watchedMs; }
            }
            if (rerender) renderRows(n);
          } catch (_e) { /* transient; the ticker will drop the live state by itself */ }
        }, POLL_MS);
      }
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
        const ev = [
          `<li><b>Started</b><span class="num">${esc(when(it.startTs))}</span><span class="small muted">${it.startSec == null ? "start position not recorded" : "at " + clock(it.startSec * 1000) + " in the video"}</span></li>`,
          it.seeks || it.pauses ? `<li class="gap"><b>During the session</b><span class="num">${it.seeks} seek${it.seeks === 1 ? "" : "s"} (${it.rewinds} backwards), ${it.pauses} pause${it.pauses === 1 ? "" : "s"}</span><span class="small muted">The extension records only how many, not when, from/to where, or how long a pause lasted.</span></li>` : "",
          it.endTs ? `<li><b>Ended</b><span class="num">${esc(when(it.endTs))}</span><span class="small muted">at ${clock(it.positionSec * 1000)}, furthest ${clock(it.furthestSec * 1000)}</span></li>`
            : `<li><b>${isLive(it) ? "Live now" : "Last update"}</b><span class="num">${it.updatedAt ? esc(when(it.updatedAt)) : "unknown"}</span><span class="small muted">${isLive(it) ? "still being watched" : "not ended cleanly, or the device has not synced since"}</span></li>`
        ].join("");
        tr.insertAdjacentHTML("afterend", `<tr class="detail"><td colspan="6"><ol class="tl" aria-label="Session timeline">${ev}</ol><dl class="kv tr-detail-box">
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

  /* ---- devices: pairing, connection status, sessions, deletion requests, pairing history ---- */
  // Connection state comes from the server (device status + sessions + live socket), see connectionOf() in src/lib/sessions.js.
  const CONN = { online: d => ({ cls: "on" + (d.realtime ? " live" : ""), text: "Online" }), offline: () => ({ cls: "", text: "Offline" }),
    disconnected: () => ({ cls: "", text: "Disconnected" }), pending: () => ({ cls: "warn", text: "Awaiting approval" }), revoked: () => ({ cls: "bad", text: "Revoked" }) };
  const connPill = d => pill((CONN[d.connection] || CONN.offline)(d));
  const shortId = id => `<span class="mono sid" title="${esc(id)}">${esc(String(id).slice(0, 8))}</span>`;
  const REQ = { pending: ["warn", "Pending"], approved: ["on", "Approved"], denied: ["bad", "Denied"], cancelled: ["", "Cancelled"] };
  const reqPill = s => pill({ cls: (REQ[s] || REQ.cancelled)[0], text: (REQ[s] || REQ.cancelled)[1] });
  const CODE = { active: ["info", "Active"], used: ["on", "Used"], expired: ["", "Expired"], cancelled: ["bad", "Cancelled"] };
  const REVOKED_WHY = { admin_revoked: "revoked by you", device_revoked: "device revoked", deletion_approved: "deleted on request", replaced: "replaced" };
  const mmss = ms => { const t = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };

  // Accessible confirmation dialog (native <dialog>: focus trap, Esc to cancel, returns focus). Resolves true/false.
  function confirmDialog({ title, body, ok, danger }) {
    return new Promise(resolve => {
      const dlg = document.createElement("dialog"); dlg.className = "dlg"; dlg.setAttribute("aria-labelledby", "dlgT");
      dlg.innerHTML = `<h3 id="dlgT">${esc(title)}</h3><p class="muted">${esc(body)}</p><div class="row"><button class="btn" value="no" type="button" data-r="0">Cancel</button><button class="btn ${danger ? "btn-danger" : "btn-accent"}" type="button" data-r="1">${esc(ok)}</button></div>`;
      document.body.appendChild(dlg);
      const end = v => { dlg.close(); dlg.remove(); resolve(v); };
      dlg.querySelectorAll("[data-r]").forEach(b => b.onclick = () => end(b.dataset.r === "1"));
      dlg.addEventListener("cancel", e => { e.preventDefault(); end(false); });
      dlg.showModal(); dlg.querySelector('[data-r="0"]').focus();
    });
  }

  function deviceCard(d) {
    const idx = colorIdx(d.id);
    if (d.status === "pending") return `<article class="card dev pendingcard dc${idx}" data-id="${esc(d.id)}"><div class="top"><div><h2>${esc(d.label || "New device")}</h2><span class="muted small">${esc(d.platform || "")} · asked to join ${esc(ago(d.enrolled_at))}</span></div>${connPill(d)}</div>
      <p>This device used a pairing code that needs your approval. Confirm that the code on the device matches:</p><div class="confirm">${esc(d.confirm_code || "")}</div>
      <p class="muted small">Approving lets this device upload its viewing history to the ledger. Rejecting deletes it and its pairing credential.</p>
      <div class="actions"><button class="btn btn-accent" data-act="approve" type="button">${ic("check")}Approve device</button><button class="btn btn-danger" data-act="reject" type="button">${ic("x")}Reject</button></div></article>`;
    const req = d.pending_requests ? `<a class="alert warn dev-req" href="#/devices/requests">${ic("inbox")}<span><b>Session deletion requested.</b> Review it under Session deletion requests.</span></a>` : "";
    return `<article class="card dev dc${idx}" data-id="${esc(d.id)}"><div class="top"><div class="row"><span class="chip dc${idx}"><b>${esc(d.label || "Device")}</b></span><span class="muted small">${esc(d.platform || "")}</span></div>${connPill(d)}</div>
      ${req}
      <div class="dev-facts">
        <div><span class="k">Extension</span><span class="v num">${d.client_version ? "v" + esc(d.client_version) : "unknown"}</span></div>
        <div><span class="k">Last active</span><span class="v" title="${esc(d.last_active ? U.fmtDateTime(d.last_active) : "")}">${esc(d.realtime ? "now" : ago(d.last_active))}</span></div>
        <div><span class="k">Sessions</span><span class="v num">${d.active_sessions} active</span></div>
        <div><span class="k">Channel</span><span class="v">${d.realtime ? "Live" : d.connection === "online" ? "Polling" : "None"}</span></div>
      </div>
      <dl class="kv"><dt>Last upload</dt><dd>${esc(ago(d.last_push_at))}${d.last_push_at ? ` <span class="muted small">(${esc(U.fmtDateTime(d.last_push_at))})</span>` : ""}</dd>
        <dt>Pending on device</dt><dd class="num">${d.pending_count || 0} event${d.pending_count === 1 ? "" : "s"} waiting to upload</dd>
        <dt>Records here</dt><dd class="num">${d.counts.sessions} sessions · ${d.counts.videos} videos</dd>
        <dt>Device clock</dt><dd class="num">${d.clock_skew_ms ? Math.abs(Math.round(d.clock_skew_ms / 60000)) + " min " + (d.clock_skew_ms > 0 ? "behind" : "ahead") + ", corrected" : "in step with the server"}</dd>
        <dt>Paired</dt><dd>${esc(when(d.approved_at || d.enrolled_at))}${d.pairings > 1 ? ` <span class="muted small">(${d.pairings} pairings)</span>` : ""}</dd>
        ${d.last_error ? `<dt>Last error on device</dt><dd class="err">${esc(d.last_error)}</dd>` : ""}</dl>
      <div class="actions"><a class="btn" href="#/history" data-act="hist">${ic("history")}View history</a><a class="btn" href="#/device/${esc(d.id)}">${ic("sliders-horizontal")}Controls</a><button class="btn" data-act="rename" type="button">${ic("pencil")}Rename</button>
        <button class="btn btn-danger" data-act="revoke" type="button" ${d.status !== "active" ? "disabled" : ""}>${ic("unlink")}Revoke access</button><button class="btn btn-danger" data-act="remove" type="button">${ic("trash-2")}Remove device</button></div></article>`;
  }

  const DTABS = [["devices", "Devices"], ["requests", "Session deletion requests"], ["sessions", "Active sessions"], ["pairing", "Pairing history"]];

  async function pageDevices(tab) {
    tab = DTABS.some(t => t[0] === tab) ? tab : "devices";
    let requests = [], sessions = [], codes = [], live = false;
    const loadAll = async () => { [requests, sessions, codes] = await Promise.all([api("GET", "/api/session-requests"), api("GET", "/api/sessions"), api("GET", "/api/pairing-codes"), loadDevices()]); };
    await loadAll();
    app.innerHTML = head("Devices", "Pair a browser with a one-time code, see which devices are connected right now, and decide on requests to delete a session. Revoking cuts a device off at once.", `<span id="liveDot" class="live-dot" role="status">Updating every few seconds</span>`) + `
      <section class="statbar" id="dStats" aria-label="Devices at a glance"></section>
      <section class="card pair-card"><div class="card-head"><h3>${ic("key-round")}Pair a device</h3><span class="sub">Codes work once and expire after 15 minutes</span></div>
        <div class="pair-grid">
          <ol class="steps"><li>Name the device (optional) and generate a pairing code.</li>
            <li>In the Chrome extension, click its toolbar icon and enter the code (server <span class="mono">${esc(location.origin)}</span>).</li>
            <li>The extension shows <b>Connected Successfully</b> and the device appears below as <b>Online</b>.</li></ol>
          <div class="pair-form">
            <div class="row"><input class="input compact" id="lbl" placeholder="Device name, e.g. Laptop 2" maxlength="80" aria-label="Device name" /><button class="btn btn-accent" id="mk" type="button">${ic("key-round")}Generate pairing code</button></div>
            <label class="check"><input type="checkbox" id="reqAppr" /> <span>Require my approval after the code is used</span></label>
          </div>
        </div>
        <div id="codeBox" aria-live="polite"></div></section>
      <div class="tabs dtabs" role="group" aria-label="Device views" id="dTabs"></div>
      <div id="dPanel"></div>`;

    function drawStats() {
      const online = devices.filter(d => d.connection === "online").length, pend = requests.filter(r => r.status === "pending").length;
      $("dStats").innerHTML = `<div class="stat lead"><div class="k">Online now</div><div class="v num">${online}</div><div class="s">of ${devices.filter(d => d.status === "active").length} connected device${devices.length === 1 ? "" : "s"}</div></div>
        <div class="stat"><div class="k">Devices</div><div class="v num">${devices.length}</div><div class="s">${devices.filter(d => d.status === "pending").length} awaiting approval</div></div>
        <div class="stat"><div class="k">Active sessions</div><div class="v num">${sessions.length}</div><div class="s">${sessions.filter(s => s.live).length} with a live connection</div></div>
        <div class="stat${pend ? " attn" : ""}"><div class="k">Deletion requests</div><div class="v num">${pend}</div><div class="s">${pend ? "waiting for your decision" : "nothing to review"}</div></div>`;
    }
    function drawTabs() {
      const n = { requests: requests.filter(r => r.status === "pending").length, devices: devices.length, sessions: sessions.length };
      $("dTabs").innerHTML = DTABS.map(([v, t]) => `<button type="button" data-tab="${v}" aria-pressed="${v === tab}">${t}${n[v] ? ` <span class="badge${v === "requests" ? " warn" : ""}">${n[v]}</span>` : ""}</button>`).join("");
      $("dTabs").querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { tab = b.dataset.tab; history.replaceState(null, "", "#/devices" + (tab === "devices" ? "" : "/" + tab)); lastPath = location.hash; draw(); });
    }
    const act = (fn, msg) => guarded(async () => { await fn(); toast(msg); await refresh(); });

    function drawDevices(box) {
      const order = devices.slice().sort((a, b) => (b.status === "pending") - (a.status === "pending") || (b.connection === "online") - (a.connection === "online"));
      box.innerHTML = `<div id="list" class="grid">${order.map(deviceCard).join("") || `<section class="card">${empty("monitor-smartphone", "No devices yet", "Generate a pairing code above and enter it in the extension to connect your first device.")}</section>`}</div>`;
      box.querySelectorAll("article").forEach(card => {
        const id = card.dataset.id, d = devices.find(x => x.id === id), btn = a => card.querySelector(`[data-act="${a}"]`);
        if (btn("approve")) btn("approve").onclick = act(() => api("POST", `/api/devices/${id}/approve`), "Approved. The device is connected.");
        twoStep(btn("reject"), "Click again to reject", act(() => api("DELETE", `/api/devices/${id}`), "Rejected and removed."));
        twoStep(btn("revoke"), "Click again to revoke", act(() => api("POST", `/api/devices/${id}/revoke`), "Revoked. It can no longer upload or read anything."));
        twoStep(btn("remove"), "Click again: delete device and its data", act(() => api("DELETE", `/api/devices/${id}`), "Device and its synced data deleted."));
        if (btn("hist")) btn("hist").onclick = () => { hf.device = id; };
        if (btn("rename")) btn("rename").onclick = () => {
          const h = card.querySelector(".top .row, .top div");
          h.innerHTML = `<div class="rename-row"><input class="input" id="rn" maxlength="80" value="${esc(d.label || "")}" aria-label="New name" /><button class="btn btn-accent" id="rnGo" type="button">Save</button></div>`;
          card.querySelector("#rn").focus();
          const save = act(() => api("PATCH", `/api/devices/${id}`, { label: card.querySelector("#rn").value.trim() }), "Renamed.");
          card.querySelector("#rnGo").onclick = save; card.querySelector("#rn").onkeydown = e => { if (e.key === "Enter") save(); };
        };
      });
    }

    function drawRequests(box) {
      const open = requests.filter(r => r.status === "pending"), past = requests.filter(r => r.status !== "pending");
      const row = r => `<tr data-id="${esc(r.id)}"><td data-primary><span class="cell-primary">${chip(r.deviceId, r.label)}</span>${r.reason ? `<div class="cell-sub">“${esc(r.reason)}”</div>` : ""}</td>
        <td data-label="Session ID">${shortId(r.sessionId)}</td><td class="num" data-label="Requested">${esc(U.fmtDateTime(r.requestedAt))}<div class="cell-sub">${esc(ago(r.requestedAt))}</div></td>
        <td data-label="Status">${reqPill(r.status)}${r.decidedAt ? `<div class="cell-sub">${esc(U.fmtDateTime(r.decidedAt))}${r.decisionNote ? " · " + esc(r.decisionNote) : ""}</div>` : ""}</td>
        <td class="right" data-label="Decision">${r.status === "pending" ? `<span class="row end"><button class="btn btn-accent btn-sm" data-act="approve" type="button">${ic("check")}Approve</button><button class="btn btn-sm" data-act="deny" type="button">${ic("x")}Deny</button></span>` : '<span class="muted small">Decided</span>'}</td></tr>`;
      const table = list => `<table class="table rtable"><thead><tr><th>Device</th><th>Session ID</th><th>Requested</th><th>Status</th><th class="right">Decision</th></tr></thead><tbody>${list.map(row).join("")}</tbody></table>`;
      box.innerHTML = `<section class="card flush"><div class="card-head"><h3>Session deletion requests</h3><span class="sub">The person at a device can only ask; nothing is deleted until you approve</span></div>
          ${open.length ? table(open) : empty("inbox", "No requests waiting", "When someone clicks Delete session in the extension, the request appears here for you to approve or deny.")}</section>
        ${past.length ? `<section class="card flush"><div class="card-head"><h3>Decided</h3></div>${table(past.slice(0, 30))}</section>` : ""}`;
      box.querySelectorAll("tr[data-id]").forEach(tr => {
        const id = tr.dataset.id, r = requests.find(x => x.id === id), b = a => tr.querySelector(`[data-act="${a}"]`);
        if (b("approve")) b("approve").onclick = async () => {
          if (await confirmDialog({ title: "Delete this session?", body: `${r.label || "This device"} will be disconnected and its session ${String(r.sessionId).slice(0, 8)} deleted. It has to pair again with a new code to reconnect. Its synced history stays on the server.`, ok: "Approve and delete", danger: true }))
            await act(() => api("POST", `/api/session-requests/${id}/approve`), "Approved. The session was deleted and the device disconnected.")();
        };
        if (b("deny")) b("deny").onclick = async () => {
          if (await confirmDialog({ title: "Deny this request?", body: `${r.label || "This device"} stays connected and is told the request was denied.`, ok: "Deny request" }))
            await act(() => api("POST", `/api/session-requests/${id}/deny`, {}), "Denied. The session stays active.")();
        };
      });
    }

    function drawSessions(box) {
      box.innerHTML = `<section class="card flush"><div class="card-head"><h3>Active sessions</h3><span class="sub">One per pairing; revoking a session disconnects only that session</span></div>${sessions.length ? `<table class="table rtable"><thead><tr><th>Device</th><th>Session ID</th><th>Paired</th><th>Last seen</th><th>Status</th><th class="right">Action</th></tr></thead><tbody>
        ${sessions.map(s => `<tr data-id="${esc(s.id)}"><td data-primary>${chip(s.device_id, s.label)}<div class="cell-sub">${s.client_version ? "extension v" + esc(s.client_version) : ""}</div></td><td data-label="Session ID">${shortId(s.id)}</td><td class="num" data-label="Paired">${esc(U.fmtDateTime(s.created_at))}</td><td data-label="Last seen">${esc(ago(s.last_seen))}</td>
          <td data-label="Status">${pill(s.live ? { cls: "on live", text: "Live" } : { cls: "info", text: "Active" })}</td><td class="right" data-label="Action"><button class="btn btn-danger btn-sm" data-act="revoke" type="button">${ic("unlink")}Revoke</button></td></tr>`).join("")}</tbody></table>`
        : empty("link", "No active sessions", "Sessions appear here when a device connects with a pairing code.")}</section>`;
      box.querySelectorAll("tr[data-id]").forEach(tr => {
        const id = tr.dataset.id, s = sessions.find(x => x.id === id);
        tr.querySelector('[data-act="revoke"]').onclick = async () => {
          if (await confirmDialog({ title: "Revoke this session?", body: `${s.label || "The device"} is disconnected right away. This session cannot be used again.`, ok: "Revoke session", danger: true }))
            await act(() => api("POST", `/api/sessions/${id}/revoke`), "Session revoked.")();
        };
      });
    }

    function drawPairing(box) {
      box.innerHTML = `<section class="card flush"><div class="card-head"><h3>Pairing history</h3><span class="sub">Codes are shown once and stored hashed; this lists who used each one</span></div>${codes.length ? `<table class="table rtable"><thead><tr><th>Code label</th><th>Created</th><th>Status</th><th>Used by</th><th>Mode</th><th class="right">Action</th></tr></thead><tbody>
        ${codes.map(c => `<tr data-id="${esc(c.id)}"><td data-primary><span class="cell-primary">${esc(c.label || "Unnamed")}</span><div class="cell-sub">${shortId(c.id)}</div></td><td class="num" data-label="Created">${esc(U.fmtDateTime(c.created_at))}</td>
          <td data-label="Status">${pill({ cls: CODE[c.status][0], text: CODE[c.status][1] })}${c.status === "active" ? `<div class="cell-sub">expires ${esc(U.fmtDateTime(c.expires_at))}</div>` : ""}</td>
          <td data-label="Used by">${c.used_at ? `${esc(c.device_label || "Device")}<div class="cell-sub">${esc(U.fmtDateTime(c.used_at))}${c.used_ip ? " · " + esc(c.used_ip) : ""}</div>` : '<span class="muted">—</span>'}</td>
          <td data-label="Mode">${c.require_approval ? "Needs approval" : "Connects at once"}</td><td class="right" data-label="Action">${c.status === "active" ? '<button class="btn btn-sm" data-act="cancel" type="button">Cancel code</button>' : ""}</td></tr>`).join("")}</tbody></table>`
        : empty("key-round", "No pairing codes yet", "Generate a code above; every code and the device that used it is recorded here.")}</section>`;
      box.querySelectorAll('[data-act="cancel"]').forEach(b => b.onclick = act(() => api("POST", `/api/pairing-codes/${b.closest("tr").dataset.id}/revoke`), "Code cancelled."));
    }

    function draw() {
      drawStats(); drawTabs();
      const box = $("dPanel");
      ({ devices: drawDevices, requests: drawRequests, sessions: drawSessions, pairing: drawPairing })[tab](box);
      growBars(box);
    }
    async function refresh() { await loadAll(); if (pairing && !pairing.done) { const c = codes.find(x => x.id === pairing.id); if (c && c.status === "used") { pairing.done = c; toast("Device connected: " + (c.device_label || "new device")); } } draw(); drawCode(); }

    /* pairing code panel with a live countdown (the code is only known here, right after it is generated) */
    function drawCode() {
      clearInterval(cpTimer); const box = $("codeBox");
      if (!pairing) { box.innerHTML = ""; return; }
      const p = pairing, total = p.expiresAt - p.createdAt;
      const paint = () => {
        const left = p.expiresAt - Date.now(), dead = !p.done && left <= 0;
        const state = p.done ? "done" : dead ? "dead" : "";
        box.innerHTML = `<div class="pair-code ${state}"><div class="stack-sm"><div class="code" aria-label="Pairing code">${esc(p.code)}</div><button class="btn btn-sm" id="cpCopy" type="button">${ic("copy")}Copy code</button></div>
          <div class="pair-meta">${p.done ? `${pill({ cls: "on", text: "Connected" })}<span>${esc(p.done.device_label || "A device")} used this code.</span>`
            : dead ? `${pill({ cls: "", text: "Expired" })}<span>This code can no longer be used. Generate a new one.</span>`
            : `<span class="muted small">Expires in</span><span class="countdown" role="timer">${mmss(left)}</span><svg class="meter-bar" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="Time left"><rect class="track" width="100" height="4"/><rect class="fill" width="${(Math.max(0, left / total) * 100).toFixed(1)}" height="4"/></svg><span class="muted small">${p.requireApproval ? "You will be asked to approve the device." : "The device connects as soon as the code is entered."}</span>`}
            <div class="row">${!p.done && !dead ? '<button class="btn btn-sm" id="cpCancel" type="button">Cancel code</button>' : ""}<button class="btn btn-sm" id="cpClose" type="button">Dismiss</button></div></div></div>`;
        if (p.done || dead) clearInterval(cpTimer);
        $("cpCopy").onclick = guarded(async () => { await navigator.clipboard.writeText(p.code); toast("Code copied."); });
        $("cpClose").onclick = () => { pairing = null; drawCode(); };
        if ($("cpCancel")) $("cpCancel").onclick = act(() => api("POST", `/api/pairing-codes/${p.id}/revoke`), "Code cancelled.");
      };
      paint(); if (!p.done) cpTimer = setInterval(paint, 1000);
    }
    $("mk").onclick = guarded(async () => {
      const r = await api("POST", "/api/devices/enroll-code", { label: $("lbl").value.trim(), requireApproval: $("reqAppr").checked });
      pairing = { ...r, createdAt: Date.now(), done: null }; drawCode(); await refresh();
    });

    draw(); drawCode();
    // Real time: the server pushes an event for every change; any event refreshes the page. Polling is the fallback.
    const setLive = on => { live = on; const el = $("liveDot"); if (el) { el.className = "live-dot" + (on ? " on" : ""); el.textContent = on ? "Live" : "Updating every few seconds"; } };
    let debounce = null;
    const kick = () => { clearTimeout(debounce); debounce = setTimeout(() => { if (document.body.contains($("dPanel"))) refresh().catch(() => {}); }, 250); };
    const connect = () => {
      if (!window.EventSource || !document.body.contains($("dPanel"))) return;
      closeEvents(); evSource = new EventSource("/api/events");
      evSource.onopen = () => setLive(true);
      evSource.onerror = () => { setLive(false); closeEvents(); setTimeout(() => { if (document.body.contains($("dPanel"))) refreshed().then(ok => ok && connect()); }, 3000); };
      ["device_connected", "device_disconnected", "device_presence", "pairing_completed", "device_updated", "session_deletion_requested", "session_request_approved", "session_request_denied", "session_revoked", "pairing_code_cancelled"]
        .forEach(t => evSource.addEventListener(t, kick));
      evSource.addEventListener("reconnect", () => { closeEvents(); connect(); });
    };
    connect();
    timer = setInterval(() => { if (!live && !(document.activeElement && document.activeElement.tagName === "INPUT")) refresh().catch(() => {}); }, 10000);
  }
  function closeEvents() { if (evSource) { evSource.close(); evSource = null; } }

  /* ---- one device: remote controls ---- */
  async function pageDevice(id) {
    await loadDevices();
    const dev = devices.find(d => d.id === id);
    if (!dev) { location.hash = "#/devices"; return; }
    const commands = await api("GET", `/api/devices/${id}/commands`);
    const active = dev.status === "active", dis = active ? "" : "disabled";
    app.innerHTML = `<div><a class="back" href="#/devices">${ic("arrow-left")}Devices</a></div>
      ${head(`<span class="row">${esc(dev.label || "Device")} ${pill(syncState(dev))}</span>`, "Commands wait on the server and are applied the next time the extension syncs (within about five minutes). They are visible on the device. They change data stored <b>on that laptop</b>; to delete what is stored on this server use <a href=\"#/data\">Data &amp; backups</a>.")}
      <section class="card stack" id="cfgCard" aria-labelledby="cfgT"><div class="card-head"><h3 id="cfgT">${ic("sliders-horizontal")}Configuration</h3><span id="cfgState"></span></div>
        <p class="muted">Settings the extension applies on this device. It checks every value and reports back; an offline device picks them up when it reconnects. These settings cannot turn tracking on or off or change what is collected, and the person using the browser can still pause tracking, delete their data or remove the extension.</p>
        <div class="filters"><label class="field">Keep history for<select class="input" id="cfgRet"><option value="">Device's own setting</option><option value="0">Forever</option>${[7, 30, 90, 180, 365, 730].map(n => `<option value="${n}">${n} days</option>`).join("")}</select></label>
          <label class="field">Sync every<select class="input" id="cfgSync"><option value="">Device default (5 min)</option>${[5, 10, 15, 30, 60].map(n => `<option value="${n}">${n} minutes</option>`).join("")}</select></label></div>
        <div class="row"><button class="btn btn-accent" id="cfgSave" type="button" ${dis}>${ic("check")}Save changes</button><span class="caption" id="cfgMsg" role="status"></span></div>
        <div id="cfgHist"></div></section>
      <section class="card stack"><div class="card-head"><h3>Controls</h3></div>
        <div class="group-row stack-sm"><span class="eyebrow">Tracking</span><div class="row"><button class="btn" data-cmd="pause_tracking" type="button" ${dis}>${ic("pause")}Pause tracking</button><button class="btn" data-cmd="resume_tracking" type="button" ${dis}>${ic("play")}Resume tracking</button></div></div>
        <div class="group-row stack-sm"><span class="eyebrow">Delete data on the device</span><div class="row"><label class="field">From<input type="date" class="input" id="dFrom" /></label><label class="field">To<input type="date" class="input" id="dTo" /></label></div>
          <div class="row"><button class="btn btn-danger" id="dRange" type="button" ${dis}>${ic("trash-2")}Delete range on device</button><button class="btn btn-danger" id="dAll" type="button" ${dis}>${ic("trash-2")}Delete all on device</button></div></div>
        ${active ? "" : '<p class="note">Only approved, non-revoked devices can receive commands.</p>'}<div class="err" id="cErr" role="alert" hidden></div></section>
      <section class="card flush"><div class="card-head"><h3>Recent commands</h3></div>${commands.length ? `<table class="table rtable"><thead><tr><th>Command</th><th>Status</th><th>Queued</th><th>Result</th></tr></thead><tbody>
        ${commands.map(c => `<tr><td data-primary><span class="cell-primary mono">${esc(c.type)}</span> <span class="cell-sub">${esc(Object.keys(c.payload).length ? JSON.stringify(c.payload) : "")}</span></td><td data-label="Status">${esc(c.status)}</td><td class="num" data-label="Queued">${esc(when(c.created_at))}</td><td data-label="Result">${esc(c.result ? c.result.status + (c.result.error ? ": " + c.result.error : "") : "waiting")}</td></tr>`).join("")}</tbody></table>` : empty("terminal", "No commands yet", "Commands you send to this device are listed here with their result.")}</section>`;
    const send = guarded(async (type, payload) => { await api("POST", `/api/devices/${id}/commands`, { type, payload }); toast("Queued. It applies on the device's next sync."); await pageDevice(id); });
    app.querySelectorAll("[data-cmd]").forEach(b => b.onclick = () => send(b.dataset.cmd, {}));
    setupConfig(id, active);
    twoStep($("dAll"), "Click again: delete ALL history on the device", () => send("delete_all", {}));
    twoStep($("dRange"), "Click again to confirm range delete", () => {
      if (!$("dFrom").value || !$("dTo").value) { $("cErr").textContent = "Pick both dates."; $("cErr").hidden = false; return; }
      $("cErr").hidden = true; return send("delete_range", { from: dayStart($("dFrom").value), to: dayEnd($("dTo").value) });
    });
  }

  /* ---- one device: server-managed configuration (owner only; the server re-checks every request) ---- */
  const CFG_STATE = { none: ["", "Not managed"], pending: ["warn", "Waiting for the device"], applied: ["on", "Applied"], failed: ["bad", "Could not apply"] };
  const CFG_LABEL = { retention_days: "Keep history for", sync_interval_minutes: "Sync every" };
  const cfgValue = (k, v) => v === null || v === undefined ? "device's own setting" : k === "retention_days" ? (v === 0 ? "forever" : v + " days") : v + " minutes";
  const HIST_STATE = { pending: ["warn", "Pending"], applied: ["on", "Applied"], failed: ["bad", "Failed"], superseded: ["", "Replaced"] };
  async function setupConfig(id, active) {
    let cur = null;
    const paint = (st, hist) => {
      cur = st;
      const [cls, text] = CFG_STATE[st.state] || CFG_STATE.none;
      $("cfgState").innerHTML = pill({ cls, text: st.state === "pending" && !st.online ? "Waiting: device offline" : text });
      if (document.activeElement !== $("cfgRet")) $("cfgRet").value = st.config.retention_days === undefined ? "" : String(st.config.retention_days);
      if (document.activeElement !== $("cfgSync")) $("cfgSync").value = st.config.sync_interval_minutes === undefined ? "" : String(st.config.sync_interval_minutes);
      $("cfgMsg").textContent = st.state === "failed" ? "The device refused this version: " + (st.error || "unknown reason") : st.state === "applied" ? "Applied " + ago(st.appliedAt) + " (version " + st.version + ")" : st.state === "pending" ? "Version " + st.version + " saved; " + (st.online ? "the device is connected and will apply it now." : "it applies when the device reconnects.") : "";
      $("cfgHist").innerHTML = hist.length ? `<table class="table rtable"><thead><tr><th>Version</th><th>When</th><th>By</th><th>Change</th><th>Result</th></tr></thead><tbody>${hist.map(h => `<tr><td class="num" data-primary>${h.version}</td><td class="num" data-label="When">${esc(U.fmtDateTime(h.created_at))}</td><td data-label="By">${esc(h.actor_label || "owner")}</td><td data-label="Change">${esc(Object.keys(h.changes).map(k => (CFG_LABEL[k] || k) + ": " + cfgValue(k, h.changes[k].from) + " → " + cfgValue(k, h.changes[k].to)).join("; "))}</td><td data-label="Result">${pill({ cls: HIST_STATE[h.status][0], text: HIST_STATE[h.status][1] })}${h.error ? `<div class="cell-sub">${esc(h.error)}</div>` : ""}</td></tr>`).join("")}</tbody></table>` : '<p class="caption">No changes yet. Every change is listed here and in the Audit log.</p>';
    };
    const load = guarded(async () => { const [st, hist] = await Promise.all([api("GET", `/api/devices/${id}/config`), api("GET", `/api/devices/${id}/config/history`)]); if (document.body.contains($("cfgCard"))) paint(st, hist); });
    await load();
    $("cfgSave").onclick = guarded(async () => {
      const want = { retention_days: $("cfgRet").value, sync_interval_minutes: $("cfgSync").value }, changes = {};
      for (const k of Object.keys(want)) {
        const has = Object.prototype.hasOwnProperty.call(cur.config, k);
        if (want[k] === "") { if (has) changes[k] = null; } else if (!has || cur.config[k] !== Number(want[k])) changes[k] = Number(want[k]);
      }
      if (!Object.keys(changes).length) return toast("Nothing to change.");
      const r = await api("PUT", `/api/devices/${id}/config`, { changes });
      toast(r.state === "pending" ? "Saved. The device will apply it" + (r.online ? " now." : " when it reconnects.") : "Saved.");
      await load();
    });
    // Live: the server pushes an event when a change is saved and when the device reports back; polling is the fallback.
    if (window.EventSource) {
      closeEvents(); evSource = new EventSource("/api/events");
      ["config_updated", "config_status", "device_presence", "device_connected", "device_disconnected"].forEach(t => evSource.addEventListener(t, () => { if (document.body.contains($("cfgCard"))) load(); }));
      evSource.onerror = () => closeEvents();
    }
    timer = setInterval(() => { if (!document.activeElement || document.activeElement.tagName !== "SELECT") load(); }, 10000);
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
  const ACT_CLASS = { login: "ok", approve: "ok", backup: "ok", pairing_code_created: "ok", pair_completed: "ok", session_deletion_approved: "del", session_deletion_denied: "sec", session_deletion_requested: "sec", session_revoked: "sec", pairing_failed: "sec", pairing_code_cancelled: "sec", config_changed: "sec", config_applied: "ok", config_failed: "del", pair_requested: "sec", revoke: "sec", device_unenrolled: "sec", refresh_reuse_detected: "sec", delete_data: "del", delete_device: "del" };
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
