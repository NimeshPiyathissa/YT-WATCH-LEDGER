/* reports.js: the Reports Studio page (#/reports) of Watch Ledger (window.WLReports).
   Daily, weekly, monthly and custom reports from GET /api/reports (the same engine as Analytics), with device, channel and video filters,
   saved report configurations (/api/reports/saved), CSV and JSON downloads, and a print-ready page for Save as PDF. The server validates
   everything; this file only draws. The chosen report lives in the address (#/reports?period=week&date=...), so a link or the back button
   reopens it. Everything from a device (titles, channels, labels) is untrusted and goes through esc(). No inline styles or scripts. */
(function () {
  "use strict";
  const WL = new Proxy({}, { get: (_t, k) => window.WL[k] }), U = window.YTUtil, C = window.YTCharts, esc = U.escapeHtml, ic = window.YTIcons.icon;
  const $ = id => document.getElementById(id);
  const dur = ms => U.fmtDuration(ms || 0);
  const PERIODS = [["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"], ["custom", "Custom"]];
  const KIND = { day: "Daily report", week: "Weekly report", month: "Monthly report", custom: "Custom period" };
  const NOUN = { day: "day", week: "week", month: "month" };
  const EXPORTS = [["csv:days", "By day (CSV)"], ["csv:viewings", "Viewing sessions (CSV)"], ["csv:videos", "Videos (CSV)"], ["csv:channels", "Channels (CSV)"], ["csv:devices", "Devices (CSV)"], ["csv:hours", "By hour (CSV)"], ["json", "Everything (JSON)"]];
  const MAX_DAYS = 366, SHORT = 10;
  const ERR = { bad_date: "That date is not valid.", bad_range: "The end date is before the start date.", range_too_long: "A custom report covers at most 366 days.", not_found: "That device is no longer paired. Choose another device.",
    bad_name: "Use a name of 1 to 80 characters.", name_taken: "You already have a saved report with that name.", too_many: "You can keep up to 50 saved reports. Delete one first." };
  const errText = e => ERR[e && e.message] || WL.errText(e);

  const blank = () => ({ period: "week", date: "", from: "", to: "", device: "all", channel: "", video: "" });
  let st = blank(), saved = [], openId = null, report = null, seq = 0, showAll = { videos: false, viewings: false };

  // the state <-> the report spec the server takes (and that is saved), and the address
  function spec(s = st) {
    const o = { period: s.period };
    if (s.period === "custom") { o.from = s.from; o.to = s.to; } else if (s.date) o.date = s.date;
    if (s.device && s.device !== "all") o.device = s.device;
    if (s.channel) o.channel = s.channel;
    if (s.video) o.video = s.video;
    return o;
  }
  const qs = o => new URLSearchParams(o).toString();
  const fromSpec = o => ({ ...blank(), ...o, date: o.date || "", device: o.device || "all", channel: o.channel || "", video: o.video || "" });
  function readHash(h) {
    const q = new URLSearchParams((h.split("?")[1]) || ""), o = {};
    for (const k of ["period", "date", "from", "to", "device", "channel", "video"]) if (q.get(k)) o[k] = q.get(k);
    if (!PERIODS.some(p => p[0] === o.period)) o.period = "week";
    openId = q.get("saved") || null;
    return fromSpec(o);
  }
  function writeHash() {
    const q = qs({ ...spec(), ...(openId ? { saved: openId } : {}) });
    const h = "#/reports" + (q ? "?" + q : "");
    if (location.hash !== h) history.replaceState(null, "", h);
  }
  const savedSpec = () => spec({ ...st, date: "" }); // a saved day / week / month report always opens on the current period
  const sameSpec = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const openSaved = () => saved.find(x => x.id === openId) || null;

  // A custom range the server would refuse is caught here first, with the reason next to the dates.
  function customProblem() {
    if (st.period !== "custom") return "";
    if (!st.from || !st.to) return "Choose a start and an end date.";
    if (st.to < st.from) return ERR.bad_range;
    if ((U.dayStart(st.to) - U.dayStart(st.from)) / 86400000 + 1 > MAX_DAYS) return ERR.range_too_long;
    return "";
  }

  /* ---- drawing ---- */
  const skeleton = `<div class="stack" role="status" aria-label="Loading the report"><span class="skel h-title"></span><div class="kpis"><span class="skel h-card"></span><span class="skel h-card"></span><span class="skel h-card"></span><span class="skel h-card"></span></div><span class="skel h-block"></span></div>`;

  function shell(devices) {
    const today = U.dayKey(Date.now());
    return WL.head("Reports", "Daily, weekly, monthly and custom watch reports from the recorded playback, with overlapping playback counted once. Save the ones you use, download them, or print them to PDF. Days follow Sri Lanka time.",
        `<span class="range-note">All times: SLST (UTC+05:30)</span>`) + `
      <div class="rp-layout">
        <div class="rp-main stack">
          <form class="card rp-controls" id="rpForm" autocomplete="off" novalidate>
            <div class="rp-row">
              <div class="field"><span>Report</span><div class="tabs" role="group" aria-label="Report period">${PERIODS.map(([v, t]) => `<button type="button" data-p="${v}" aria-pressed="${v === st.period}">${t}</button>`).join("")}</div></div>
              <div class="rp-nav" id="rpNav" ${st.period === "custom" ? "hidden" : ""}>
                <button class="btn btn-icon" type="button" id="rpPrev" aria-label="Previous period">${ic("chevron-left")}</button>
                <label class="field rp-date">Date<input class="input" type="date" id="rpDate" max="${today}" value="${esc(st.date)}" aria-describedby="rpPeriodLabel" /></label>
                <button class="btn btn-icon" type="button" id="rpNext" aria-label="Next period">${ic("chevron-right")}</button>
                <button class="btn btn-sm" type="button" id="rpNow">Current</button>
              </div>
              <div class="rp-custom" id="rpCustom" ${st.period === "custom" ? "" : "hidden"}>
                <label class="field">From<input class="input" type="date" id="rpFrom" max="${today}" value="${esc(st.from)}" /></label>
                <label class="field">To<input class="input" type="date" id="rpTo" max="${today}" value="${esc(st.to)}" /></label>
              </div>
            </div>
            <div class="rp-row">
              <label class="field">Device<select class="input" id="rpDevice"><option value="all">All devices</option>${devices.map(d => `<option value="${esc(d.id)}"${d.id === st.device ? " selected" : ""}>${esc(d.label || "Device")}</option>`).join("")}</select></label>
              <label class="field">Channel<select class="input" id="rpChannel"><option value="">All channels</option></select></label>
              <label class="field rp-grow">Video<select class="input" id="rpVideo"><option value="">All videos</option></select></label>
              <button class="btn btn-sm rp-clear" type="button" id="rpClear" hidden>${ic("x")}Clear filters</button>
            </div>
            <p class="err" id="rpFormErr" role="alert" hidden></p>
          </form>
          <div id="rpBody" aria-live="polite" aria-busy="true">${skeleton}</div>
        </div>
        <aside class="card rp-saved" aria-labelledby="rpSavedH">
          <div class="card-head"><h3 id="rpSavedH">Saved reports</h3><span class="sub" id="rpSavedN"></span></div>
          <div id="rpSavedList"><span class="skel h-card"></span></div>
          <div class="rp-save-actions"><button class="btn btn-accent" type="button" id="rpSave">${ic("plus")}Save this report</button><button class="btn" type="button" id="rpUpdate" hidden>${ic("check")}Update saved report</button></div>
        </aside>
      </div>`;
  }

  // The filter menus offer what played in this period; a chosen value that did not play stays selectable so it can be seen and cleared.
  function fillFilters(r) {
    const ch = $("rpChannel"), vd = $("rpVideo");
    if (!ch || !vd) return;
    const chans = r.options.channels.slice(), vids = r.options.videos.slice();
    if (st.channel && !chans.includes(st.channel)) chans.unshift(st.channel);
    if (st.video && !vids.some(v => v.videoId === st.video)) vids.unshift({ videoId: st.video, title: r.filters.videoTitle || st.video });
    ch.innerHTML = `<option value="">All channels</option>` + chans.map(c => `<option value="${esc(c)}"${c === st.channel ? " selected" : ""}>${esc(c)}</option>`).join("");
    vd.innerHTML = `<option value="">All videos</option>` + vids.map(v => `<option value="${esc(v.videoId)}"${v.videoId === st.video ? " selected" : ""}>${esc(v.title || v.videoId)}</option>`).join("");
    ch.disabled = !chans.length; vd.disabled = !vids.length;
  }
  function syncControls() {
    const f = $("rpForm"); if (!f) return;
    f.querySelectorAll("[data-p]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.p === st.period)));
    $("rpNav").hidden = st.period === "custom"; $("rpCustom").hidden = st.period !== "custom";
    $("rpDate").value = st.date || (report && !report.period.isCurrent ? report.period.fromDate : U.dayKey(Date.now())); $("rpFrom").value = st.from; $("rpTo").value = st.to; $("rpDevice").value = st.device;
    $("rpClear").hidden = !(st.device !== "all" || st.channel || st.video);
    const p = report && report.period;
    $("rpNext").disabled = !p || p.isCurrent || p.isFuture;
    $("rpNow").disabled = !st.date;
    const o = openSaved();
    $("rpUpdate").hidden = !o || sameSpec(o.spec, savedSpec());
    if (o) $("rpUpdate").innerHTML = `${ic("check")}Update “${esc(o.name)}”`;
  }

  function filterChips(r) {
    const f = r.filters, chips = [];
    chips.push(f.deviceLabel ? `${ic("laptop")}${esc(f.deviceLabel)}` : `${ic("monitor-smartphone")}All devices`);
    if (f.channel) chips.push(`${ic("film")}${esc(f.channel)}`);
    if (f.video) chips.push(`${ic("play")}${esc(f.videoTitle || f.video)}`);
    return chips.map(c => `<span class="rp-chip">${c}</span>`).join("");
  }
  const deltaLabel = r => (r.period.type === "custom" ? `${r.period.days} day${r.period.days === 1 ? "" : "s"} before` : NOUN[r.period.type]);
  const table = (cls, head, rows) => `<div class="table-wrap"><table class="table rtable ${cls}"><thead><tr>${head.map(([t, right]) => `<th${right ? ' class="right"' : ""}>${esc(t)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const more = (key, n) => n > SHORT ? `<div class="rp-more"><button class="btn btn-sm" type="button" data-more="${key}" aria-expanded="${showAll[key]}">${showAll[key] ? "Show fewer" : `Show all ${n}`}</button></div>` : "";

  function body(r, devices) {
    const t = r.totals, p = r.period;
    const idx = id => Math.max(0, devices.findIndex(d => d.id === id)) % 6;
    const title = `<header class="rp-title"><div><p class="eyebrow">${esc(KIND[p.type])}${p.isCurrent ? ` · <span class="pill on"><span class="dot"></span><span>in progress</span></span>` : ""}</p>
        <h2 id="rpPeriodLabel">${esc(p.label)}</h2><div class="rp-chips">${filterChips(r)}</div></div>
        <div class="rp-actions">
          <div class="rp-menu"><button class="btn" id="rpExport" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="rpExportMenu">${ic("download")}Download</button>
            <div class="rp-pop" id="rpExportMenu" hidden role="menu">${EXPORTS.map(([k, l]) => `<button role="menuitem" type="button" data-ex="${k}">${esc(l)}</button>`).join("")}</div></div>
          <button class="btn btn-accent" id="rpPrint" type="button">${ic("file-text")}Print / Save as PDF</button>
        </div></header>`;
    if (!t.watchMs && !r.comparison.watchMs) {
      const filtered = r.filters.device || r.filters.channel || r.filters.video;
      return title + `<section class="card">${WL.empty("calendar", p.isFuture ? "This period has not started yet" : "No watch time in this period",
        p.isFuture ? "Choose an earlier date, or go back to the current period." : filtered ? "Nothing matching these filters was played in this period. Clear the filters or choose another period." : "Nothing was played on the selected devices in this period. Choose another period, or check that a paired device is connected.",
        filtered ? `<button class="btn" type="button" data-clear>${ic("x")}Clear filters</button>` : "")}</section>`;
    }
    const maxDev = Math.max(1, ...r.byDevice.map(d => d.watchMs)), maxDay = Math.max(1, ...r.series.map(b => b.watchMs));
    const vids = showAll.videos ? r.videos : r.videos.slice(0, SHORT), views = showAll.viewings ? r.viewings : r.viewings.slice(0, SHORT);
    const chart = p.type === "day"
      ? `<section class="card"><div class="card-head"><h3>By hour of the day</h3><span class="sub">SLST</span></div>${window.WLAnalytics.hourBars(r.byHour)}</section>`
      : `<section class="card"><div class="card-head"><h3>Watch time by ${esc(p.granularity)}</h3><span class="sub">${r.series.length} ${esc(p.granularity)}${r.series.length === 1 ? "" : "s"}</span></div><div id="rpTrend"></div></section>`;
    const second = p.type === "day"
      ? ""
      : `<div class="grid g2"><section class="card"><div class="card-head"><h3>By hour of the day</h3><span class="sub">SLST</span></div>${window.WLAnalytics.hourBars(r.byHour)}</section>
         <section class="card"><div class="card-head"><h3>By day of the week</h3></div>${window.WLAnalytics.weekdayBars(r.byWeekday)}</section></div>`;
    return title + `
      <section class="kpis" aria-label="Watch time">
        <div class="kpi hero"><div class="k">Watch time</div><div class="v num" id="rpTotal">${esc(dur(t.watchMs))}</div><div>${window.WLAnalytics.deltaHtml(r.comparison, deltaLabel(r))}</div>${window.WLAnalytics.spark(r.series)}</div>
      </section>
      <section class="kpis" aria-label="Summary">
        <div class="kpi"><div class="k">Viewing sessions</div><div class="v num">${t.sessions}</div><div class="s">${t.completed} finished · ${t.pauses} pauses · ${t.seeks} seeks</div></div>
        <div class="kpi"><div class="k">Videos</div><div class="v num">${t.videos}</div><div class="s">${t.channels} channel${t.channels === 1 ? "" : "s"}</div></div>
        <div class="kpi"><div class="k">Active days</div><div class="v num">${t.activeDays}<span class="kpi-of"> of ${p.days}</span></div><div class="s">${esc(dur(t.avgPerActiveDayMs))} per active day</div></div>
        <div class="kpi"><div class="k">Longest session</div><div class="v num">${esc(dur(t.longestSessionMs))}</div><div class="s">average ${esc(dur(t.avgSessionMs))}</div></div>
      </section>
      ${chart}${second}
      <div class="grid g2">
        <section class="card"><div class="card-head"><h3>Devices</h3></div>${r.byDevice.length ? r.byDevice.map(d => `<div class="meter"><span>${WL.chip(d.deviceId, d.label)}</span><span class="num">${esc(dur(d.watchMs))} · ${d.share}%</span><span class="dc${idx(d.deviceId)}"><svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="8" rx="4"/><rect class="fill" width="${Math.round(d.watchMs / maxDev * 100)}" height="8" rx="4"/></svg></span></div>`).join("") : WL.empty("laptop", "No device activity", "")}</section>
        <section class="card"><div class="card-head"><h3>Channels</h3><span class="sub">${r.channels.length}</span></div>${r.channels.length ? `<ul class="ledger">${r.channels.slice(0, 8).map(c => `<li><button class="linkbtn rp-pick" type="button" data-channel="${esc(c.channel)}" title="Show only this channel">${esc(c.channel)}</button><span class="lead"></span><span class="amt">${esc(dur(c.watchMs))}</span></li>`).join("")}</ul>${r.channels.length > 8 ? `<p class="caption">${r.channels.length - 8} more in the CSV and PDF.</p>` : ""}` : WL.empty("film", "No channels", "")}</section>
      </div>
      ${p.type !== "day" ? `<section class="card flush"><div class="card-head"><h3>Day by day</h3><span class="sub">SLST days</span></div>${table("rp-days", [["Day"], ["Watch time", true], [""]], r.series.map(b => `<tr><td data-primary class="cell-primary">${esc(b.key)}</td><td class="num right" data-label="Watch time">${b.watchMs ? esc(dur(b.watchMs)) : '<span class="muted">none</span>'}</td><td data-label="" class="rp-barcell"><svg class="rp-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="8" rx="3"/><rect class="fill" width="${(b.watchMs / maxDay * 100).toFixed(1)}" height="8" rx="3"/></svg></td></tr>`))}</section>` : ""}
      <section class="card flush"><div class="card-head"><h3>Videos</h3><span class="sub">time is shared fairly when two videos played at once</span></div>${r.videos.length ? table("rp-videos", [["Video"], ["Sessions", true], ["Watched", true], ["Last played", true]], vids.map(v => `<tr><td data-primary class="cell-primary"><a href="#/video/${esc(encodeURIComponent(v.videoId))}">${esc(v.title || v.videoId)}</a></td><td class="num right" data-label="Sessions">${v.sessions}</td><td class="num right" data-label="Watched">${esc(dur(v.watchMs))}</td><td class="right" data-label="Last played">${v.lastWatchedAt ? esc(U.fmtDateTime(v.lastWatchedAt)) : "n/a"}</td></tr>`)) + more("videos", r.videos.length) : WL.empty("film", "No videos", "")}</section>
      <section class="card flush"><div class="card-head"><h3>Viewing sessions</h3><span class="sub">${r.viewingsTotal} in this report${r.viewingsTotal > r.viewings.length ? `, the first ${r.viewings.length} listed` : ""}</span></div>${r.viewings.length ? table("rp-viewings", [["Video"], ["Device"], ["First played"], ["Watched", true]], views.map(v => `<tr><td data-primary class="cell-primary">${esc(v.title || v.videoId)}<span class="caption rp-sub">${esc(v.channel || "(unknown)")}</span></td><td data-label="Device">${WL.chip(v.deviceId, v.deviceLabel)}</td><td data-label="First played">${esc(U.fmtDateTime(v.firstPlayedAt))}</td><td class="num right" data-label="Watched">${esc(dur(v.watchMs))}</td></tr>`)) + more("viewings", r.viewings.length) : WL.empty("history", "No viewing sessions", "")}</section>
      ${t.overlapRemovedMs > 0 ? `<p class="caption">${esc(dur(t.overlapRemovedMs))} of overlapping playback on the same device (for example two tabs) was counted once.</p>` : ""}
      ${r.truncated ? `<p class="caption">This period has more sessions than the server reads at once; narrow the dates for exact totals.</p>` : ""}`;
  }

  function drawSaved() {
    const box = $("rpSavedList"); if (!box) return;
    $("rpSavedN").textContent = saved.length ? String(saved.length) : "";
    box.innerHTML = saved.length ? `<ul class="rp-saved-list">${saved.map(x => `<li class="${x.id === openId ? "open" : ""}">
        <button class="rp-open" type="button" data-open="${esc(x.id)}" aria-current="${x.id === openId ? "true" : "false"}"><b>${esc(x.name)}</b><span class="caption">${esc(describe(x.spec))}</span></button>
        <span class="rp-saved-tools"><button class="btn btn-ghost btn-icon btn-sm" type="button" data-rename="${esc(x.id)}" aria-label="Rename ${esc(x.name)}">${ic("pencil")}</button><button class="btn btn-ghost btn-icon btn-sm" type="button" data-del="${esc(x.id)}" aria-label="Delete ${esc(x.name)}">${ic("trash-2")}</button></span></li>`).join("")}</ul>`
      : `<p class="muted rp-saved-empty">Nothing saved yet. Pick a period and filters, then save them here to open the same report again in one click. A saved daily, weekly or monthly report always opens on the current period.</p>`;
  }
  function describe(o) {
    const d = WL.devices().find(x => x.id === o.device);
    const when = o.period === "custom" ? `${o.from} to ${o.to}` : (o.date ? `${KIND[o.period]}, ${o.date}` : `${KIND[o.period]}, current ${NOUN[o.period]}`);
    return [when, o.device ? (d ? d.label || "Device" : "removed device") : null, o.channel, o.video ? "one video" : null].filter(Boolean).join(" · ");
  }

  /* ---- the name dialog (save / rename) ---- */
  function nameDialog({ title, value, ok }) {
    return new Promise(resolve => {
      const dlg = document.createElement("dialog"); dlg.className = "dlg"; dlg.setAttribute("aria-labelledby", "rpDlgT");
      dlg.innerHTML = `<form class="stack" id="rpDlgF" novalidate><h3 id="rpDlgT">${esc(title)}</h3><label class="field">Name<input class="input" id="rpDlgName" maxlength="80" required value="${esc(value || "")}" /></label>
        <p class="err" id="rpDlgErr" role="alert" hidden></p><div class="row"><button class="btn" type="button" data-r="0">Cancel</button><button class="btn btn-accent" type="submit">${esc(ok)}</button></div></form>`;
      document.body.appendChild(dlg);
      const done = v => { dlg.close(); dlg.remove(); resolve(v); };
      const err = dlg.querySelector("#rpDlgErr");
      dlg.querySelector("[data-r='0']").onclick = () => done(null);
      dlg.addEventListener("cancel", e => { e.preventDefault(); done(null); });
      dlg.querySelector("form").onsubmit = e => {
        e.preventDefault();
        const v = dlg.querySelector("#rpDlgName").value.trim();
        if (!v || v.length > 80) { err.textContent = ERR.bad_name; err.hidden = false; return; }
        done({ name: v });
      };
      dlg.showModal(); const i = dlg.querySelector("#rpDlgName"); i.focus(); i.select();
    });
  }
  // A name the server refuses (taken, or not allowed) is asked for again, with the reason.
  async function askName(opts, save) {
    let value = opts.value;
    for (;;) {
      const r = await nameDialog({ ...opts, value });
      if (!r) return null;
      try { return await save(r.name); }
      catch (e) { if (e.message === "unauthorized") return null; value = r.name; WL.toast(errText(e)); if (e.message !== "name_taken" && e.message !== "bad_name") return null; }
    }
  }

  /* ---- loading ---- */
  async function loadSaved() {
    try { saved = (await WL.api("GET", "/api/reports/saved")).items; }
    catch (e) { if (e.message === "unauthorized" || e.message === "navigated") return; saved = []; const b = $("rpSavedList"); if (b) b.innerHTML = `<p class="err">Saved reports could not load (${esc(errText(e))}).</p>`; return; }
    drawSaved(); syncControls();
  }

  async function load(devices) {
    const box = $("rpBody"); if (!box) return;
    writeHash(); syncControls(); drawSaved();
    const problem = customProblem(), fe = $("rpFormErr");
    fe.hidden = !problem; fe.textContent = problem;
    if (problem) { box.removeAttribute("aria-busy"); box.innerHTML = `<section class="card">${WL.empty("calendar", "Choose the dates", problem)}</section>`; return; }
    const mine = ++seq;
    box.setAttribute("aria-busy", "true");
    if (!box.querySelector(".rp-title")) box.innerHTML = skeleton; else box.classList.add("rp-loading"); // keep the old report on screen, dimmed, while the new one loads
    try {
      const r = await WL.api("GET", "/api/reports?" + qs(spec()));
      if (mine !== seq || !document.body.contains(box)) return; // a newer request or another page replaced this one
      report = r;
      box.classList.remove("rp-loading"); box.removeAttribute("aria-busy");
      box.innerHTML = body(r, devices);
      fillFilters(r); syncControls();
      const tr = $("rpTrend");
      if (tr) C.barChart(tr, r.series.map(b => ({ label: b.key, value: b.watchMs })), dur);
      wireBody(devices);
    } catch (e) {
      if (e.message === "unauthorized" || e.message === "navigated" || mine !== seq) return;
      box.classList.remove("rp-loading"); box.removeAttribute("aria-busy");
      box.innerHTML = `<section class="card">${WL.empty("triangle-alert", "The report could not load", errText(e), `<button class="btn btn-accent" type="button" id="rpRetry">${ic("refresh-cw")}Try again</button>`, "bad")}</section>`;
      $("rpRetry").onclick = () => load(devices);
    }
  }

  function exportUrl(format, scope) { return "/api/reports/export?" + qs({ ...spec(), format, ...(scope ? { scope } : {}) }); }
  function wireBody(devices) {
    const menu = $("rpExportMenu"), btn = $("rpExport");
    const close = () => { if (menu && !menu.hidden) { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); } };
    if (btn) btn.onclick = () => { menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); if (!menu.hidden) menu.querySelector("button").focus(); };
    if (menu) {
      menu.onkeydown = e => { if (e.key === "Escape") { close(); btn.focus(); } };
      menu.onclick = WL.guarded(async e => {
        const b = e.target.closest("[data-ex]"); if (!b) return; close();
        const [format, scope] = b.dataset.ex.split(":"), stem = fileStem(report);
        await WL.download(exportUrl(format, scope), format === "csv" ? `${stem}-${scope}.csv` : `${stem}.json`);
        WL.toast("Downloaded " + b.textContent.replace(/\s*\(.*\)$/, "").toLowerCase() + ".");
      });
    }
    const pr = $("rpPrint");
    if (pr) pr.onclick = WL.guarded(() => WL.openPage(exportUrl("print") + "&print=1"));
    const bx = $("rpBody");
    bx.onclick = e => {
      const m = e.target.closest("[data-more]");
      if (m) { showAll[m.dataset.more] = !showAll[m.dataset.more]; bx.innerHTML = body(report, devices); const tr = $("rpTrend"); if (tr) C.barChart(tr, report.series.map(b => ({ label: b.key, value: b.watchMs })), dur); wireBody(devices); const again = bx.querySelector(`[data-more="${m.dataset.more}"]`); if (again) again.focus(); return; }
      const c = e.target.closest("[data-channel]");
      if (c) { st.channel = c.dataset.channel; showAll = { videos: false, viewings: false }; load(devices); return; }
      if (e.target.closest("[data-clear]")) clearFilters(devices);
    };
    if (!wireBody.doc) document.addEventListener("click", wireBody.doc = e => { if (!e.target.closest(".rp-menu")) { const m = $("rpExportMenu"); if (m && !m.hidden) { m.hidden = true; $("rpExport").setAttribute("aria-expanded", "false"); } } });
  }
  // Same names as the server's (src/lib/reports.js fileStem), for the browser's download.
  function fileStem(r) {
    const p = r.period, base = p.type === "custom" ? `${p.fromDate}_to_${p.toDate}` : p.type === "month" ? p.fromDate.slice(0, 7) : p.type === "week" ? "week-" + p.fromDate : p.fromDate;
    return `watch-report-${p.type}-${base}`;
  }
  function clearFilters(devices) { st.device = "all"; st.channel = ""; st.video = ""; load(devices); }

  /* ---- the page ---- */
  async function render(app, hash) {
    st = readHash(hash || location.hash); report = null; showAll = { videos: false, viewings: false };
    const devices = await WL.loadDevices();
    app.innerHTML = shell(devices);
    const f = $("rpForm"), go = () => { showAll = { videos: false, viewings: false }; load(devices); };
    f.addEventListener("submit", e => e.preventDefault());
    f.querySelectorAll("[data-p]").forEach(b => b.onclick = () => {
      if (st.period === b.dataset.p) return;
      st.period = b.dataset.p;
      if (st.period === "custom" && !st.from) { const p = report && report.period; st.from = p ? p.fromDate : U.dayKey(Date.now() - 6 * 86400000); st.to = p ? (p.toDate > U.dayKey(Date.now()) ? U.dayKey(Date.now()) : p.toDate) : U.dayKey(Date.now()); }
      go();
    });
    $("rpPrev").onclick = () => { if (report && report.period.prevDate) { st.date = report.period.prevDate; go(); } };
    $("rpNext").onclick = () => { if (report && report.period.nextDate) { st.date = report.period.nextDate > U.dayKey(Date.now()) ? "" : report.period.nextDate; go(); } };
    $("rpNow").onclick = () => { st.date = ""; go(); };
    $("rpDate").onchange = () => { st.date = $("rpDate").value; go(); };
    $("rpFrom").onchange = () => { st.from = $("rpFrom").value; go(); };
    $("rpTo").onchange = () => { st.to = $("rpTo").value; go(); };
    $("rpDevice").onchange = () => { st.device = $("rpDevice").value; go(); };
    $("rpChannel").onchange = () => { st.channel = $("rpChannel").value; go(); };
    $("rpVideo").onchange = () => { st.video = $("rpVideo").value; go(); };
    $("rpClear").onclick = () => clearFilters(devices);

    $("rpSave").onclick = WL.guarded(async () => {
      const r = await askName({ title: "Save this report", value: report ? report.period.label.replace(/^Week of /, "Week ") : "", ok: "Save" },
        name => WL.api("POST", "/api/reports/saved", { name, spec: savedSpec() }));
      if (!r) return;
      openId = r.id; await loadSaved(); writeHash(); WL.toast(`Saved “${r.name}”.`);
    });
    $("rpUpdate").onclick = WL.guarded(async () => {
      const o = openSaved(); if (!o) return;
      await WL.api("PUT", "/api/reports/saved/" + encodeURIComponent(o.id), { spec: savedSpec() });
      await loadSaved(); WL.toast(`Updated “${o.name}”.`);
    });
    $("rpSavedList").onclick = WL.guarded(async e => {
      const op = e.target.closest("[data-open]"), rn = e.target.closest("[data-rename]"), dl = e.target.closest("[data-del]");
      if (op) { const x = saved.find(s => s.id === op.dataset.open); if (!x) return; openId = x.id; st = fromSpec(x.spec); go(); return; }
      if (rn) {
        const x = saved.find(s => s.id === rn.dataset.rename); if (!x) return;
        const r = await askName({ title: "Rename saved report", value: x.name, ok: "Rename" }, name => WL.api("PUT", "/api/reports/saved/" + encodeURIComponent(x.id), { name }));
        if (r) { await loadSaved(); WL.toast(`Renamed to “${r.name}”.`); }
        return;
      }
      if (dl) {
        const x = saved.find(s => s.id === dl.dataset.del); if (!x) return;
        if (!(await WL.confirmDialog({ title: `Delete “${x.name}”?`, body: "Only the saved settings are deleted. No watch data is removed.", ok: "Delete", danger: true }))) return;
        await WL.api("DELETE", "/api/reports/saved/" + encodeURIComponent(x.id));
        if (openId === x.id) { openId = null; writeHash(); }
        await loadSaved(); WL.toast(`Deleted “${x.name}”.`);
      }
    });
    await Promise.all([loadSaved(), load(devices)]);
  }

  window.WLReports = { render };
})();
