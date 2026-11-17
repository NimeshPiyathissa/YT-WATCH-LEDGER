/* analytics.js — the Analytics page (#/analytics) of Watch Ledger. Everything from a device (titles, channels, labels) is untrusted and
   goes through esc(). No inline styles or scripts. Numbers come from GET /api/analytics, which counts overlapping playback once and
   splits time at Sri Lanka midnight; this file only draws them. */
(function () {
  "use strict";
  const WL = new Proxy({}, { get: (_t, k) => window.WL[k] }), U = window.YTUtil, C = window.YTCharts, esc = U.escapeHtml, ic = window.YTIcons.icon;
  const $ = id => document.getElementById(id);
  const dur = ms => U.fmtDuration(ms || 0);
  const safeUrl = u => (/^https:\/\/www\.youtube\.com\//.test(u || "") ? u : "");
  const PRESETS = [["today", "Today"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["custom", "Custom"]];
  const st = { range: "7", from: "", to: "", gran: "auto", device: "all" };
  let seq = 0;

  const arrow = t => (t === "up" ? "↑" : t === "down" ? "↓" : t === "flat" ? "→" : "·");
  function deltaHtml(c, label) {
    if (c.deltaPct === null) return `<span class="delta none">${arrow("none")} new activity</span><span class="s"> no data in the previous ${esc(label)}</span>`;
    const sign = c.deltaMs > 0 ? "+" : c.deltaMs < 0 ? "−" : "";
    return `<span class="delta ${c.trend}">${arrow(c.trend)} ${sign}${Math.abs(c.deltaPct)}%</span><span class="s"> ${sign}${esc(dur(Math.abs(c.deltaMs)))} vs the previous ${esc(label)}</span>`;
  }
  function spark(series) {
    if (series.length < 2) return "";
    const W = 100, H = 40, max = Math.max(1, ...series.map(s => s.watchMs));
    const pts = series.map((s, i) => [i * W / (series.length - 1), H - 3 - (H - 8) * s.watchMs / max]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Trend of the selected period"><path class="area" d="${line} L${W} ${H} L0 ${H} Z"/><path class="line" d="${line}"/></svg>`;
  }
  function hourBars(hours) {
    const max = Math.max(1, ...hours), bw = 10, gap = 2, W = 24 * (bw + gap), H = 96;
    const bars = hours.map((v, i) => {
      const h = v > 0 ? Math.max(2, Math.round((H - 4) * v / max)) : 1.5;
      return `<rect class="${v > 0 ? "b" : "z"}" x="${i * (bw + gap) + gap / 2}" y="${H - h}" width="${bw}" height="${h}" rx="2"><title>${String(i).padStart(2, "0")}:00 to ${String(i).padStart(2, "0")}:59 · ${esc(dur(v))}</title></rect>`;
    }).join("");
    return `<svg class="hb" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Watch time by hour of the day">${bars}</svg>
      <div class="hb-axis" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>`;
  }
  function weekdayBars(days) {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], max = Math.max(1, ...days);
    return `<div class="wk" role="img" aria-label="Watch time by day of the week">${days.map((v, i) => {
      const h = v > 0 ? Math.max(3, Math.round(88 * v / max)) : 2;
      return `<div class="col"><svg viewBox="0 0 20 100" preserveAspectRatio="none" aria-hidden="true"><rect class="${v > 0 ? "b" : "z"}" x="2" y="${100 - h}" width="16" height="${h}" rx="3"><title>${names[i]} · ${esc(dur(v))}</title></rect></svg><span class="d">${names[i]}</span></div>`;
    }).join("")}</div>`;
  }
  function meter(pct, idx) {
    return `<span class="dc${idx}"><svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="8" rx="4"/><rect class="fill" width="${Math.max(0, Math.min(100, pct))}" height="8" rx="4"/></svg></span>`;
  }

  function query() {
    const p = new URLSearchParams();
    if (st.range === "custom") {
      const f = U.dayStart(st.from), t = U.dayEnd(st.to);
      if (!f || !t) return null;
      p.set("from", f); p.set("to", t + 1);
    } else p.set("range", st.range);
    if (st.gran !== "auto") p.set("granularity", st.gran);
    if (st.device !== "all") p.set("device", st.device);
    return p.toString();
  }
  const prevLabel = r => (r.range.to - r.range.from <= 90000000 ? "day" : (r.range.to - r.range.from) / 86400000 <= 8 ? "week" : "period");

  function shell(devices) {
    const today = U.dayKey(Date.now());
    return WL.head("Analytics", "Watch time from the recorded playback itself: only the seconds a video was actually playing, with overlapping playback counted once. Days follow Sri Lanka time.",
        `<span class="range-note">All times: SLST (UTC+05:30)</span>`) + `
      <form class="card range-bar" id="anForm" autocomplete="off">
        <div class="field"><span>Period</span><div class="tabs" role="group" aria-label="Period">${PRESETS.map(([v, t]) => `<button type="button" data-r="${v}" aria-pressed="${v === st.range}">${t}</button>`).join("")}</div></div>
        <label class="field" id="anFromW" ${st.range === "custom" ? "" : "hidden"}>From<input class="input" type="date" id="anFrom" max="${today}" value="${esc(st.from)}" /></label>
        <label class="field" id="anToW" ${st.range === "custom" ? "" : "hidden"}>To<input class="input" type="date" id="anTo" max="${today}" value="${esc(st.to)}" /></label>
        <label class="field">Group by<select class="input" id="anGran">${[["auto", "Automatic"], ["day", "Day"], ["week", "Week"], ["month", "Month"]].map(([v, t]) => `<option value="${v}"${v === st.gran ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field">Device<select class="input" id="anDev"><option value="all">All devices</option>${devices.map(d => `<option value="${esc(d.id)}"${d.id === st.device ? " selected" : ""}>${esc(d.label || "Device")}</option>`).join("")}</select></label>
      </form>
      <div id="anBody" aria-live="polite"><div class="stack" role="status" aria-label="Loading"><div class="kpis"><span class="skel h-card"></span><span class="skel h-card"></span><span class="skel h-card"></span></div><span class="skel h-block"></span></div></div>`;
  }

  function body(r, devices) {
    const t = r.totals, label = prevLabel(r);
    const idx = id => Math.max(0, devices.findIndex(d => d.id === id)) % 6;
    if (!t.watchMs && !r.comparison.watchMs) {
      return `<section class="card">${WL.empty("activity", "No watch time in this period", "Nothing was played in the selected dates on the selected devices. Try a longer period, or check that a paired device is connected.")}</section>`;
    }
    const max = Math.max(1, ...r.byDevice.map(d => d.watchMs));
    const days = r.series.length;
    return `
      <section class="kpis" aria-label="Watch time">
        <div class="kpi hero"><div class="k">Watch time</div><div class="v num">${esc(dur(t.watchMs))}</div><div>${deltaHtml(r.comparison, label)}</div>${spark(r.series)}</div>
      </section>
      <section class="kpis" aria-label="Summary">
        <div class="kpi"><div class="k">Sessions</div><div class="v num">${t.sessions}</div><div class="s">${t.completed} finished · ${t.pauses} pauses · ${t.seeks} seeks</div></div>
        <div class="kpi"><div class="k">Videos</div><div class="v num">${t.videos}</div><div class="s">${t.channels} channel${t.channels === 1 ? "" : "s"}</div></div>
        <div class="kpi"><div class="k">Per active day</div><div class="v num">${esc(dur(t.avgPerActiveDayMs))}</div><div class="s">${t.activeDays} active day${t.activeDays === 1 ? "" : "s"} · ${esc(dur(t.avgPerDayMs))} per calendar day</div></div>
        <div class="kpi"><div class="k">Longest session</div><div class="v num">${esc(dur(t.longestSessionMs))}</div><div class="s">average ${esc(dur(t.avgSessionMs))}</div></div>
      </section>
      <section class="card"><div class="card-head"><h3>Watch time over time</h3><span class="sub">${days} ${r.range.granularity}${days === 1 ? "" : "s"} · grouped by ${r.range.granularity}</span></div><div id="anTrend"></div></section>
      <div class="grid g2">
        <section class="card"><div class="card-head"><h3>By hour of the day</h3><span class="sub">SLST</span></div>${hourBars(r.byHour)}</section>
        <section class="card"><div class="card-head"><h3>By day of the week</h3></div>${weekdayBars(r.byWeekday)}</section>
      </div>
      <div class="grid g2">
        <section class="card"><div class="card-head"><h3>Devices</h3></div>${r.byDevice.length ? r.byDevice.map(d => `<div class="meter"><span>${WL.chip(d.deviceId, d.label)}</span><span class="num">${esc(dur(d.watchMs))} · ${d.share}%</span>${meter(Math.round(d.watchMs / max * 100), idx(d.deviceId))}</div>`).join("") : WL.empty("laptop", "No device activity", "")}</section>
        <section class="card"><div class="card-head"><h3>Top channels</h3></div>${r.topChannels.length ? `<ul class="ledger">${r.topChannels.slice(0, 8).map(c => `<li><span class="name">${esc(c.channel)}</span><span class="lead"></span><span class="amt">${esc(dur(c.watchMs))}</span></li>`).join("")}</ul>` : WL.empty("film", "No channels", "")}</section>
      </div>
      <section class="card flush"><div class="card-head"><h3>Most watched videos</h3><span class="sub">time is shared fairly when two videos played at once</span></div>${r.topVideos.length ? `<div class="table-wrap"><table class="table rtable"><thead><tr><th>Video</th><th class="right">Sessions</th><th class="right">Watched</th><th class="right">Last watched</th></tr></thead><tbody>
        ${r.topVideos.map(v => `<tr><td data-primary class="cell-primary"><a href="#/video/${esc(encodeURIComponent(v.videoId))}">${esc(v.title || v.videoId)}</a></td><td class="num right" data-label="Sessions">${v.sessions}</td><td class="num right" data-label="Watched">${esc(dur(v.watchMs))}</td><td class="right" data-label="Last watched">${v.lastWatchedAt ? esc(U.fmtDateTime(v.lastWatchedAt)) : "n/a"}</td></tr>`).join("")}</tbody></table></div>` : WL.empty("film", "No videos", "")}</section>
      ${t.overlapRemovedMs > 0 ? `<p class="caption">${esc(dur(t.overlapRemovedMs))} of overlapping playback on the same device (for example two tabs) was counted once.</p>` : ""}
      ${r.truncated ? `<p class="caption">This period has more sessions than the dashboard reads at once; narrow the dates for exact totals.</p>` : ""}`;
  }

  async function render(app) {
    const devices = await WL.loadDevices();
    app.innerHTML = shell(devices);
    const form = $("anForm");
    const load = async () => {
      const q = query(), box = $("anBody");
      if (q === null) { box.innerHTML = `<section class="card">${WL.empty("calendar", "Pick both dates", "Choose a start and an end date for the custom period.")}</section>`; return; }
      const mine = ++seq;
      try {
        const r = await WL.api("GET", "/api/analytics?" + q);
        if (mine !== seq || !document.body.contains(box)) return; // a newer request or another page replaced this one
        box.innerHTML = body(r, devices);
        const tr = $("anTrend");
        if (tr) C.barChart(tr, r.series.map(s => ({ label: s.key, value: s.watchMs })), dur);
      } catch (e) {
        if (e.message === "unauthorized" || e.message === "navigated" || mine !== seq) return;
        box.innerHTML = `<section class="card">${WL.empty("triangle-alert", "Analytics could not load", e.message === "bad_range" ? "That date range is not allowed (up to 366 days)." : WL.errText(e), `<button class="btn btn-accent" type="button" id="anRetry">${ic("refresh-cw")}Try again</button>`, "bad")}</section>`;
        const b = $("anRetry"); if (b) b.onclick = load;
      }
    };
    form.addEventListener("submit", e => e.preventDefault());
    form.querySelectorAll("[data-r]").forEach(b => b.onclick = () => {
      st.range = b.dataset.r;
      form.querySelectorAll("[data-r]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      const c = st.range === "custom"; $("anFromW").hidden = !c; $("anToW").hidden = !c;
      if (c && !st.from) { st.to = U.dayKey(Date.now()); st.from = U.dayKey(Date.now() - 6 * 86400000); $("anFrom").value = st.from; $("anTo").value = st.to; }
      load();
    });
    $("anFrom").onchange = () => { st.from = $("anFrom").value; load(); };
    $("anTo").onchange = () => { st.to = $("anTo").value; load(); };
    $("anGran").onchange = () => { st.gran = $("anGran").value; load(); };
    $("anDev").onchange = () => { st.device = $("anDev").value; load(); };
    await load();
  }

  window.WLAnalytics = { render, deltaHtml, spark, hourBars, weekdayBars }; // the charts are shared with Reports (reports.js)
})();
