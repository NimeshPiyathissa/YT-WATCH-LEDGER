/* video-charts.js — the Video Details charts (window.WLVideoCharts). Pure functions: recorded data in, HTML/SVG string out.
   Every number plotted comes from recorded events (runs, pauses, session metrics); nothing is interpolated or invented.
   The server's CSP forbids inline styles, so geometry lives in SVG attributes and colour in classes; axis text is HTML so it
   keeps its size on a phone. Each chart has a text alternative (aria-label / visible figures). */
(function (root) {
  "use strict";
  const P = root.YTPlayback, esc = root.YTUtil.escapeHtml;
  const fmtMin = ms => (ms >= 3600000 ? (ms / 3600000).toFixed(1) + " h" : ms >= 60000 ? (ms / 60000).toFixed(1) + " min" : Math.round(ms / 1000) + " s");
  // m:ss, or h:mm:ss from an hour up
  const clock = sec => { const t = Math.max(0, Math.round(sec)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0"); };
  const shortDay = (ts, tz) => new Intl.DateTimeFormat("en-US", { timeZone: P.validZone(tz) ? tz : "UTC", month: "short", day: "numeric" }).format(new Date(ts));
  const none = text => `<p class="vd-chart-empty">${esc(text)}</p>`;

  // Start of the hour / day containing ts, on the wall clock of `tz`.
  function bucketStart(ts, tz, unit) {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric" }), o = {};
    f.formatToParts(new Date(ts)).forEach(p => { o[p.type] = Number(p.value); });
    return P.zonedToUtc(o.year, o.month, o.day, unit === "hour" ? o.hour : 0, 0, 0, 0, tz);
  }
  // the next boundary after bucket b: stepping 90 minutes (hour) or 36 hours (day) always lands inside the following bucket, even across a daylight-saving change
  const nextBucket = (b, tz, unit) => bucketStart(b + (unit === "hour" ? 5400000 : 129600000), tz, unit);

  // 1. Watch activity: active playing time per hour (or per day for longer spans), from the recorded playing runs.
  function activity(runs, tz) {
    if (!runs || !runs.length) return none("No playback runs recorded yet.");
    const lo = runs[0].ts, hi = runs.reduce((m, r) => Math.max(m, r.ts + r.ms), 0);
    const unit = hi - lo <= 2 * 86400000 ? "hour" : "day", buckets = new Map();
    for (const r of runs) {   // a run that crosses a bucket boundary is split in proportion
      let t = r.ts; const end = r.ts + r.ms;
      while (t < end) { const b = bucketStart(t, tz, unit), cut = Math.min(end, nextBucket(b, tz, unit)); buckets.set(b, (buckets.get(b) || 0) + (cut - t)); t = Math.max(cut, t + 1); }
    }
    const keys = [...buckets.keys()].sort((a, b) => a - b), series = [];
    for (let t = keys[0], i = 0; i < 4000 && t <= keys[keys.length - 1]; i++) { series.push({ t, v: buckets.get(t) || 0 }); t = nextBucket(t, tz, unit); }
    if (series.length > 60) series.splice(0, series.length - 60);
    const max = Math.max(...series.map(s => s.v), 1), n = series.length, W = n * 12, H = 100;
    const label = t => (unit === "hour" ? P.formatTime(t, tz).replace(/:00:00\s/, " ") : shortDay(t, tz));
    const bars = series.map((s, i) => { const h = s.v > 0 ? Math.max(3, Math.round((H - 6) * s.v / max)) : 1.5;
      return `<rect class="vd-bar${s.v ? "" : " vd-bar-zero"}" x="${i * 12 + 2}" y="${H - h}" width="8" height="${h}" rx="2"><title>${esc(label(s.t) + ": " + fmtMin(s.v) + " playing")}</title></rect>`; }).join("");
    const idx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
    const total = series.reduce((a, s) => a + s.v, 0);
    return `<div class="vd-chart" role="img" aria-label="Active watch time per ${unit}: ${esc(fmtMin(total))} in total, busiest ${esc(label(series.reduce((a, b) => (b.v > a.v ? b : a)).t))}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${[0.25, 0.5, 0.75].map(f => `<line class="vd-grid" x1="0" x2="${W}" y1="${H * f}" y2="${H * f}"/>`).join("")}${bars}</svg>
      <div class="vd-axis" aria-hidden="true">${idx.map(i => `<span>${esc(label(series[i].t))}</span>`).join("")}</div>
      <p class="vd-chart-note">Peak <b class="num">${esc(fmtMin(max))}</b> per ${unit} · ${esc(fmtMin(total))} playing in total</p></div>`;
  }

  // 2. Playback progress of one viewing: position in the video against time since it began, with pauses shaded and the
  // content that was actually played drawn underneath. Jumps (seeks) show as the gaps between steps.
  function progress(session, runs, pauses, duration) {
    const rs = (runs || []).filter(r => r.sessionId === session.sessionId).sort((a, b) => a.ts - b.ts);
    if (!rs.length) return none("No playback runs were recorded for this viewing.");
    const t0 = session.startedAt, tEnd = Math.max(...rs.map(r => r.ts + r.ms), ...pauses.map(p => (p.resumedAt || p.pausedAt) + 0), t0 + 1000);
    const span = Math.max(1000, tEnd - t0), top = Math.max(duration || 0, ...rs.map(r => r.to), 1), W = 600, H = 200;
    const X = t => ((t - t0) / span * W).toFixed(1), Y = pos => (H - 8 - (pos / top) * (H - 16)).toFixed(1);
    const bands = pauses.filter(p => p.sessionId === session.sessionId).map(p => {
      const a = p.pausedAt, b = p.resumedAt != null ? p.resumedAt : p.status === "unresolved" ? p.pausedAt + (p.minDurationMs || 0) : tEnd;
      return `<rect class="vd-band${p.status === "unresolved" ? " vd-band-unres" : ""}" x="${X(a)}" y="0" width="${Math.max(2, ((b - a) / span * W)).toFixed(1)}" height="${H}"><title>${esc(p.status === "unresolved" ? "Unresolved pause (at least " + P.formatDuration(p.minDurationMs) + ")" : "Pause: " + (p.durationMs != null ? P.formatDuration(p.durationMs) : "still paused"))}</title></rect>`;
    }).join("");
    let d = "", prev = null;
    for (const r of rs) {
      const x1 = X(r.ts), y1 = Y(r.from), x2 = X(r.ts + r.ms), y2 = Y(r.to);
      d += prev ? ` L${x1},${prev.y} L${x1},${y1}` : `M${x1},${y1}`;
      d += ` L${x2},${y2}`; prev = { y: y2 };
    }
    const ticksY = [1, 0.75, 0.5, 0.25, 0].map(f => clock(Math.round(top * f)));
    const ticksX = [0, 0.5, 1].map(f => P.formatDuration(span * f).replace(/ seconds?| 0 seconds/, "s").replace(/ minutes?/, "m").replace(/ hours?/, "h"));
    return `<div class="vd-chart vd-chart-y" role="img" aria-label="Playback position over the viewing; furthest ${esc(clock(Math.max(...rs.map(r => r.to))))} of ${esc(clock(top))}">
      <div class="vd-yaxis" aria-hidden="true">${ticksY.map(t => `<span>${esc(t)}</span>`).join("")}</div>
      <div class="vd-plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${[0.25, 0.5, 0.75].map(f => `<line class="vd-grid" x1="0" x2="${W}" y1="${H * f}" y2="${H * f}"/>`).join("")}${bands}<path class="vd-line" d="${d}"/></svg>
      <div class="vd-axis" aria-hidden="true">${ticksX.map(t => `<span>${esc(t)}</span>`).join("")}</div></div></div>`;
  }

  // Which parts of the video were really played (union of every viewing): a strip, 0 to the end.
  function coverage(segments, duration) {
    const top = Math.max(duration || 0, ...(segments || []).map(s => s.to), 1);
    if (!segments || !segments.length) return none("No watched content recorded yet.");
    const got = segments.reduce((n, s) => n + (s.to - s.from), 0);
    return `<div class="vd-cover" role="img" aria-label="${Math.round(got / top * 100)}% of the video was actually played"><svg viewBox="0 0 1000 14" preserveAspectRatio="none" aria-hidden="true"><rect class="vd-cover-bg" width="1000" height="14" rx="4"/>${segments.map(s => `<rect class="vd-cover-fill" x="${(s.from / top * 1000).toFixed(1)}" y="0" width="${Math.max(2, (s.to - s.from) / top * 1000).toFixed(1)}" height="14"><title>${esc(clock(s.from) + " – " + clock(s.to))}</title></rect>`).join("")}</svg>
      <div class="vd-axis" aria-hidden="true"><span>0:00</span><span>${esc(clock(top / 2))}</span><span>${esc(clock(top))}</span></div>
      <p class="vd-chart-note"><b class="num">${esc(clock(got))}</b> of ${esc(clock(top))} actually played (${Math.round(got / top * 100)}%). Reaching the end does not mean every part was watched.</p></div>`;
  }

  // 3. How long the pauses were.
  function pauseDistribution(dist) {
    const total = dist.reduce((n, b) => n + b.count, 0);
    if (!total) return none("No completed pauses yet.");
    const max = Math.max(...dist.map(b => b.count), 1), W = dist.length * 20, H = 90;
    return `<div class="vd-chart" role="img" aria-label="Pause lengths: ${esc(dist.filter(b => b.count).map(b => b.count + " of " + b.label).join(", "))}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${dist.map((b, i) => { const h = b.count ? Math.max(4, Math.round((H - 6) * b.count / max)) : 1.5;
        return `<rect class="vd-bar vd-bar-amber${b.count ? "" : " vd-bar-zero"}" x="${i * 20 + 3}" y="${H - h}" width="14" height="${h}" rx="3"><title>${esc(b.label + ": " + b.count)}</title></rect>`; }).join("")}</svg>
      <div class="vd-bins" aria-hidden="true">${dist.map(b => `<span><b class="num">${b.count}</b>${esc(b.label)}</span>`).join("")}</div></div>`;
  }

  // 4. Where the time went.
  const PARTS = [["activeMs", "Playing", "vd-s-active"], ["pausedMs", "Paused", "vd-s-paused"], ["bufferingMs", "Buffering", "vd-s-buffer"], ["adMs", "Ads", "vd-s-ad"], ["unresolvedPausedMs", "Unresolved pause (at least)", "vd-s-unres"]];
  function breakdown(b) {
    const total = PARTS.reduce((n, p) => n + (b[p[0]] || 0), 0);
    if (!total) return none("No time recorded yet.");
    let x = 0;
    const rects = PARTS.filter(p => b[p[0]] > 0).map(p => { const w = b[p[0]] / total * 1000, r = `<rect class="${p[2]}" x="${x.toFixed(1)}" y="0" width="${Math.max(2, w).toFixed(1)}" height="22"><title>${esc(p[1] + ": " + P.formatDuration(b[p[0]]))}</title></rect>`; x += w; return r; }).join("");
    return `<div class="vd-chart" role="img" aria-label="Time breakdown: ${esc(PARTS.filter(p => b[p[0]] > 0).map(p => p[1] + " " + P.formatDuration(b[p[0]])).join(", "))}">
      <svg class="vd-stack" viewBox="0 0 1000 22" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>
      <ul class="vd-legend">${PARTS.filter(p => b[p[0]] > 0).map(p => `<li><i class="${p[2]}"></i><span>${esc(p[1])}</span><b class="num">${esc(P.formatDuration(b[p[0]]))}</b><em class="num">${Math.round(b[p[0]] / total * 100)}%</em></li>`).join("")}</ul></div>`;
  }

  // 5. Viewings side by side: playing / paused / buffering time, one bar per viewing on a shared scale.
  function sessionsComparison(sessions, tz) {
    if (!sessions.length) return none("No viewings with event history yet.");
    const rows = sessions.slice(-12), max = Math.max(...rows.map(s => s.activeMs + s.pausedMs + s.bufferingMs + (s.unresolvedPausedMs || 0)), 1);
    return `<div class="vd-chart" role="img" aria-label="Comparison of ${rows.length} viewings">${rows.map(s => {
      let x = 0; const seg = [["activeMs", "vd-s-active"], ["pausedMs", "vd-s-paused"], ["bufferingMs", "vd-s-buffer"], ["unresolvedPausedMs", "vd-s-unres"]].filter(p => s[p[0]] > 0).map(p => { const w = s[p[0]] / max * 1000, r = `<rect class="${p[1]}" x="${x.toFixed(1)}" y="0" width="${Math.max(2, w).toFixed(1)}" height="12"/>`; x += w; return r; }).join("");
      return `<div class="vd-cmp"><span class="vd-cmp-l">${esc(shortDay(s.startedAt, tz))} ${esc(P.formatTime(s.startedAt, tz).replace(/:\d{2}\s/, " "))}${s.completed ? " ✓" : ""}</span>
        <svg viewBox="0 0 1000 12" preserveAspectRatio="none" aria-hidden="true"><rect class="vd-cover-bg" width="1000" height="12" rx="3"/>${seg}</svg>
        <span class="vd-cmp-v num">${esc(fmtMin(s.activeMs))} <small>playing</small> · ${esc(fmtMin(s.pausedMs))} <small>paused</small></span></div>`; }).join("")}
      <ul class="vd-legend vd-legend-row">${PARTS.filter(p => p[0] !== "adMs").map(p => `<li><i class="${p[2]}"></i><span>${esc(p[1])}</span></li>`).join("")}</ul></div>`;
  }

  root.WLVideoCharts = { activity, progress, coverage, pauseDistribution, breakdown, sessionsComparison, bucketStart };
})(typeof self !== "undefined" ? self : this);
