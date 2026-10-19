/* lib/charts.js — tiny SVG bar chart. self.YTCharts.
   Bars are SVG that stretch to the container; the axis labels are HTML, so text keeps its size on a phone. */
(function (root) {
  "use strict";
  // data: [{label, value}]; fmt(value) -> string for the tooltip and the peak line.
  function barChart(el, data, fmt) {
    const esc = root.YTUtil.escapeHtml;
    const n = Math.max(1, data.length), H = 100, bw = 7, gap = 3, W = n * (bw + gap);
    const max = Math.max.apply(null, data.map(d => d.value).concat([1]));
    let peak = null;
    const bars = data.map((d, i) => {
      if (d.value > 0 && (!peak || d.value > peak.value)) peak = d;
      const h = d.value > 0 ? Math.max(2, Math.round((H - 4) * d.value / max)) : 1.5;
      return '<rect class="bar" x="' + (i * (bw + gap) + gap / 2) + '" y="' + (H - h) + '" width="' + bw + '" height="' + h + '" rx="1.5"' + (d.value > 0 ? "" : ' opacity=".35"') + '><title>' + esc(d.label + ": " + fmt(d.value)) + "</title></rect>";
    }).join("");
    const lines = [0.25, 0.5, 0.75].map(f => '<line class="grid-line" x1="0" x2="' + W + '" y1="' + (H * f) + '" y2="' + (H * f) + '"/>').join("");
    // At most 6 axis labels, always including the first and the last bar.
    const want = Math.min(n, 6), idx = [];
    for (let k = 0; k < want; k++) { const i = want === 1 ? 0 : Math.round(k * (n - 1) / (want - 1)); if (idx.indexOf(i) < 0) idx.push(i); }
    const axis = idx.map(i => "<span>" + esc(data[i] ? data[i].label : "") + "</span>").join("");
    el.innerHTML = '<div class="chart"><svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="Watch time per day">' + lines + bars + "</svg>" +
      '<div class="axis" aria-hidden="true">' + axis + "</div>" +
      (peak ? '<p class="caption chart-peak">Peak: <span class="num">' + esc(fmt(peak.value)) + "</span> on " + esc(peak.label) + "</p>" : "") + "</div>";
  }
  root.YTCharts = { barChart };
})(typeof self !== "undefined" ? self : this);
