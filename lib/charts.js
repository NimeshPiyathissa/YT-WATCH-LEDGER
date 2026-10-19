/* lib/charts.js — tiny SVG bar chart. self.YTCharts. */
(function (root) {
  "use strict";
  // data: [{label, value}]; fmt(value) -> string for the tooltip.
  function barChart(el, data, fmt) {
    const esc = root.YTUtil.escapeHtml;
    const W = 560, H = 160, pad = 22, max = Math.max.apply(null, data.map(d => d.value).concat([1]));
    const bw = (W - pad * 2) / Math.max(1, data.length);
    const bars = data.map((d, i) => {
      const h = Math.round((H - pad * 2) * d.value / max);
      const x = pad + i * bw + 3, y = H - pad - h;
      return '<rect class="bar" x="' + x.toFixed(1) + '" y="' + y + '" width="' + (bw - 6).toFixed(1) + '" height="' + h + '" rx="3"><title>' +
        esc(d.label + ": " + fmt(d.value)) + '</title></rect>' +
        (i % 2 === 0 ? '<text class="tick" x="' + (x + (bw - 6) / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(d.label) + '</text>' : "");
    }).join("");
    el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Watch time per day">' + bars + "</svg>";
  }
  root.YTCharts = { barChart };
})(typeof self !== "undefined" ? self : this);
