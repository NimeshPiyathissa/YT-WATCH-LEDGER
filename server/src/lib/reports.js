// Reports Studio: daily, weekly, monthly and custom reports over the same analytics engine as the Analytics page (src/lib/analytics.js),
// so a report and the Analytics page can never disagree. Pure: no database, no I/O, the clock is passed in.
//
//   A report spec is { period: "day"|"week"|"month"|"custom", date?, from?, to?, device?, channel?, video? }. Dates are calendar days in
//   Sri Lanka (YYYY-MM-DD, Asia/Colombo); storage and every timestamp leaving the server stay UTC milliseconds. A day, week or month
//   report covers the period that contains `date` (today when it is left out, so a saved weekly report always opens on the current week).
//   A custom report covers `from` to `to`, both days included, at most 366 days. Weeks start on Monday.
//
//   Filters: device (the owner's own, checked by the route), channel and video. Filtering never changes how overlapping playback on one
//   device is shared (see `match` in analytics.js), so a channel's report total equals that channel's figure on the Analytics page.
import { computeAnalytics, bucketStart, nextBucketStart, DISPLAY_TZ } from "./analytics.js";
import pb from "./playback.cjs";

const DAY = 86400000;
export const MAX_CUSTOM_DAYS = 366, MAX_VIEWINGS = 5000, MAX_OPTIONS = 500, MAX_PRINT_VIEWINGS = 1000;
export const PERIODS = ["day", "week", "month", "custom"];
export const CSV_SCOPES = ["days", "viewings", "videos", "channels", "devices", "hours"];
export const UNKNOWN_CHANNEL = "(unknown)"; // what the engine calls playback whose channel was never recorded
const SPEC_KEYS = ["period", "date", "from", "to", "device", "channel", "video"];
const VID = /^[\w-]{1,32}$/, DEV = /^[\w-]{1,64}$/;
const TZ_LABEL = "SLST (UTC+05:30)";

// A real calendar date "YYYY-MM-DD" -> { y, m, d }, or null (2026-02-30 is not a date).
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === "string" ? s : "");
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2000 && y <= 2100 && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? { y, m: mo, d } : null;
}
// Midnight in the display zone at the start of a calendar date, as a UTC instant.
export const midnightOf = (s, tz = DISPLAY_TZ) => { const p = parseDate(s); return p ? pb.zonedToUtc(p.y, p.m, p.d, 0, 0, 0, 0, tz) : null; };
const dayKey = (ts, tz) => pb.dayKey(ts, tz);

// Checks a spec (from a query string or a saved report). Returns { ok: true, spec } with only known keys, or { ok: false, error, field }.
// `strict` (saved reports) also refuses keys it does not know, so nothing unexpected is ever stored.
export function validateSpec(input, { strict = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "bad_spec" };
  if (strict) for (const k of Object.keys(input)) if (!SPEC_KEYS.includes(k)) return { ok: false, error: "unknown_field", field: k };
  const str = k => (input[k] === undefined || input[k] === null || input[k] === "" ? null : input[k]);
  const period = str("period") ?? "week";
  if (!PERIODS.includes(period)) return { ok: false, error: "bad_period", field: "period" };
  const spec = { period };
  if (period === "custom") {
    const from = str("from"), to = str("to");
    if (!parseDate(from)) return { ok: false, error: "bad_date", field: "from" };
    if (!parseDate(to)) return { ok: false, error: "bad_date", field: "to" };
    if (to < from) return { ok: false, error: "bad_range", field: "to" };
    if ((midnightOf(to) - midnightOf(from)) / DAY + 1 > MAX_CUSTOM_DAYS) return { ok: false, error: "range_too_long", field: "to" };
    spec.from = from; spec.to = to;
  } else {
    const date = str("date");
    if (date !== null && !parseDate(date)) return { ok: false, error: "bad_date", field: "date" };
    if (date !== null) spec.date = date;
  }
  const device = str("device");
  if (device !== null && device !== "all") { if (typeof device !== "string" || !DEV.test(device)) return { ok: false, error: "bad_device", field: "device" }; spec.device = device; }
  const channel = str("channel");
  if (channel !== null) { if (typeof channel !== "string" || channel.length > 200 || /[\u0000-\u001f]/.test(channel)) return { ok: false, error: "bad_channel", field: "channel" }; spec.channel = channel; }
  const video = str("video");
  if (video !== null) { if (typeof video !== "string" || !VID.test(video)) return { ok: false, error: "bad_video", field: "video" }; spec.video = video; }
  return { ok: true, spec };
}

// The instants a spec covers: [from, to) in UTC, plus labels in the display zone and the dates of the periods either side.
export function resolvePeriod(spec, now, tz = DISPLAY_TZ) {
  let from, to;
  if (spec.period === "custom") { from = midnightOf(spec.from, tz); to = nextBucketStart(midnightOf(spec.to, tz), "day", tz); } // both days included
  else {
    const anchor = spec.date ? midnightOf(spec.date, tz) + DAY / 2 : now; // noon of the chosen day: never on a boundary
    from = bucketStart(anchor, spec.period, tz); to = nextBucketStart(from, spec.period, tz);
  }
  const fromDate = dayKey(from, tz), toDate = dayKey(to - 1, tz);
  const fmt = (ts, o) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...o }).format(new Date(ts));
  const dmy = ts => fmt(ts, { day: "numeric", month: "short", year: "numeric" });
  const label = spec.period === "day" ? fmt(from, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : spec.period === "week" ? `Week of Mon ${dmy(from)} to Sun ${dmy(to - 1)}`
    : spec.period === "month" ? fmt(from, { month: "long", year: "numeric" })
    : fromDate === toDate ? dmy(from) : `${dmy(from)} to ${dmy(to - 1)}`;
  const days = (to - from) / DAY, granularity = spec.period !== "custom" || days <= 62 ? "day" : days <= 190 ? "week" : "month";
  const out = { type: spec.period, from, to, fromDate, toDate, days: Math.round(days), label, granularity, timeZone: tz, isCurrent: now >= from && now < to, isFuture: from > now };
  if (spec.period !== "custom") { out.prevDate = dayKey(bucketStart(from - DAY / 2, spec.period, tz), tz); out.nextDate = dayKey(to, tz); }
  return out;
}

// What a report counts: the shares of the intervals (and the sessions) that match the channel / video filters.
export function matcher(spec) {
  if (!spec.channel && !spec.video) return null;
  return it => (!spec.video || it.videoId === spec.video) && (!spec.channel || (spec.channel === UNKNOWN_CHANNEL ? !it.channel : it.channel === spec.channel));
}

// The choices the filter menus offer for this period (and device): every channel and video that played in it, before the
// channel / video filters are applied, so changing one filter never hides the others' choices.
function optionsOf(intervals, from, to) {
  const ch = new Map(), vids = new Map();
  for (const it of intervals) {
    if (!(Math.min(it.end, to) > Math.max(it.start, from))) continue;
    const c = it.channel || UNKNOWN_CHANNEL; ch.set(c, (ch.get(c) || 0) + 1);
    const v = vids.get(it.videoId) || { videoId: it.videoId, title: "", channel: "" };
    if (it.title) v.title = it.title; if (it.channel) v.channel = it.channel; vids.set(it.videoId, v);
  }
  const byName = (a, b) => a.localeCompare(b, "en", { sensitivity: "base" });
  return {
    channels: [...ch.keys()].sort(byName).slice(0, MAX_OPTIONS),
    videos: [...vids.values()].sort((a, b) => byName(a.title || a.videoId, b.title || b.videoId)).slice(0, MAX_OPTIONS)
  };
}

// The whole report. `data` is what loadIntervals() returned for the device (or all of the owner's devices).
export function buildReport({ data, spec, now, tz = DISPLAY_TZ, deviceLabel = null }) {
  const period = resolvePeriod(spec, now, tz), match = matcher(spec);
  const a = computeAnalytics({ intervals: data.intervals, sessions: data.sessions, labels: data.labels, from: period.from, to: period.to, granularity: period.granularity, tz, match, detail: true });
  const options = optionsOf(data.intervals, period.from, period.to);
  const videoTitle = spec.video ? ((options.videos.find(v => v.videoId === spec.video) || {}).title || "") : null;
  const { viewings, ...rest } = a;
  return {
    kind: "watch-ledger-report", generatedAt: now, timeZone: tz, timeZoneLabel: TZ_LABEL,
    spec, period,
    filters: { device: spec.device || null, deviceLabel: spec.device ? deviceLabel || data.labels[spec.device] || "Device" : null, channel: spec.channel || null, video: spec.video || null, videoTitle },
    ...rest,
    viewings: viewings.slice(0, MAX_VIEWINGS), viewingsTotal: viewings.length,
    options, truncated: !!data.truncated
  };
}

/* ---- exports ---- */
const sec = ms => Math.round(ms) / 1000; // exact to the millisecond, so the rows of a CSV add up to the total
const iso = ms => (ms == null ? "" : new Date(ms).toISOString());
// Titles and channel names come from the web: a leading = + - @ (or tab / CR) is neutralised so a spreadsheet never runs one as a formula.
export function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(r, scope) {
  const S = ms => pb.formatStamp(ms, r.timeZone);
  let head, rows;
  if (scope === "viewings") {
    head = ["device", "session_id", "video_id", "title", "channel", "first_played_utc", "first_played_slst", "last_played_utc", "last_played_slst", "watch_seconds"];
    rows = r.viewings.map(v => [v.deviceLabel, v.sessionId, v.videoId, v.title, v.channel, iso(v.firstPlayedAt), S(v.firstPlayedAt), iso(v.lastPlayedAt), S(v.lastPlayedAt), sec(v.watchMs)]);
  } else if (scope === "videos") {
    head = ["video_id", "title", "watch_seconds", "viewings", "last_played_utc", "last_played_slst"];
    rows = r.videos.map(v => [v.videoId, v.title, sec(v.watchMs), v.sessions, iso(v.lastWatchedAt), v.lastWatchedAt ? S(v.lastWatchedAt) : ""]);
  } else if (scope === "channels") {
    head = ["channel", "watch_seconds", "videos"];
    rows = r.channels.map(c => [c.channel, sec(c.watchMs), c.videos]);
  } else if (scope === "devices") {
    head = ["device", "watch_seconds", "share_percent", "sessions"];
    rows = r.byDevice.map(d => [d.label, sec(d.watchMs), d.share, d.sessions]);
  } else if (scope === "hours") {
    head = ["hour_slst", "watch_seconds"];
    rows = r.byHour.map((ms, h) => [String(h).padStart(2, "0") + ":00", sec(ms)]);
  } else {
    head = [r.period.granularity === "day" ? "day_slst" : r.period.granularity + "_starting_slst", "starts_utc", "watch_seconds"];
    rows = r.series.map(b => [b.key, iso(b.start), sec(b.watchMs)]);
  }
  return "﻿" + [head.join(",")].concat(rows.map(l => l.map(csvCell).join(","))).join("\r\n") + "\r\n";
}
export function toJson(r) {
  return { ...r, exportedAt: new Date(r.generatedAt).toISOString(), note: "Timestamps are UTC milliseconds; dates and the day / week / month boundaries are those of Asia/Colombo (SLST, UTC+05:30). Watch time counts only real playback, with overlapping playback on one device counted once." };
}
export function fileStem(r) {
  const p = r.period, base = p.type === "custom" ? `${p.fromDate}_to_${p.toDate}` : p.type === "month" ? p.fromDate.slice(0, 7) : p.type === "week" ? "week-" + p.fromDate : p.fromDate;
  return `watch-report-${p.type}-${base}`;
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const D = ms => pb.formatDuration(ms);
// Print-ready HTML (the browser's print dialog saves it as PDF). External stylesheet and script only: the CSP forbids inline ones.
export function toPrintHtml(r) {
  const S = ms => pb.formatStamp(ms, r.timeZone), t = r.totals, f = r.filters;
  const row = (cells, right = []) => "<tr>" + cells.map((c, i) => `<td${right.includes(i) ? ' class="r"' : ""}>${esc(c)}</td>`).join("") + "</tr>";
  const table = (head, rows, right = []) => rows.length ? `<table><thead><tr>${head.map((h, i) => `<th${right.includes(i) ? ' class="r"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>` : `<p class="muted">Nothing in this period.</p>`;
  const max = Math.max(1, ...r.series.map(b => b.watchMs));
  const bar = ms => `<svg class="pbar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="8" rx="2" class="pbar-track"/><rect width="${(ms / max * 100).toFixed(2)}" height="8" rx="2" class="pbar-fill"/></svg>`;
  const filt = [f.deviceLabel ? "Device: " + f.deviceLabel : "All devices", f.channel ? "Channel: " + f.channel : null, f.video ? "Video: " + (f.videoTitle || f.video) : null].filter(Boolean).join(" · ");
  const c = r.comparison, delta = c.deltaPct === null ? "new activity (nothing in the previous period)" : `${c.deltaMs >= 0 ? "+" : "−"}${D(Math.abs(c.deltaMs))} (${c.deltaPct >= 0 ? "+" : ""}${c.deltaPct}%) vs the previous period`;
  const shown = r.viewings.slice(0, MAX_PRINT_VIEWINGS);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Watch report — ${esc(r.period.label)}</title>
<link rel="stylesheet" href="/print.css"></head><body class="report">
<header><button id="printBtn" type="button" class="noprint">Save as PDF / Print</button><p class="eyebrow">Watch Ledger report · ${esc({ day: "Daily", week: "Weekly", month: "Monthly", custom: "Custom period" }[r.period.type])}</p>
<h1>${esc(r.period.label)}</h1><p>${esc(filt)}</p>
<p class="muted">Generated ${esc(S(r.generatedAt))}. All times are Sri Lanka Standard Time (Asia/Colombo, UTC+05:30); they are stored in UTC. Watch time counts only real playback; overlapping playback on one device is counted once.</p></header>
<h2>Summary</h2><table class="kv">${[["Watch time", D(t.watchMs)], ["Compared with the previous period", delta], ["Viewing sessions", t.sessions], ["Videos", t.videos], ["Channels", t.channels],
    ["Active days", `${t.activeDays} of ${r.period.days}`], ["Average per active day", D(t.avgPerActiveDayMs)], ["Longest session", D(t.longestSessionMs)], ["Finished videos / pauses / seeks", `${t.completed} / ${t.pauses} / ${t.seeks}`],
    ...(t.overlapRemovedMs > 0 ? [["Overlapping playback counted once", D(t.overlapRemovedMs)]] : [])].map(x => row(x)).join("")}</table>
${r.truncated ? `<p class="warn">This period has more sessions than the server reads at once; narrow the dates for exact totals.</p>` : ""}
<h2>Watch time by ${esc(r.period.granularity)}</h2>${table([r.period.granularity === "day" ? "Day (SLST)" : "Starting (SLST)", "Watch time", ""], r.series.map(b => `<tr><td>${esc(b.key)}</td><td class="r">${esc(D(b.watchMs))}</td><td class="barcell">${bar(b.watchMs)}</td></tr>`), [1])}
<h2>By hour of the day (SLST)</h2>${table(["Hour", "Watch time"], r.byHour.map((ms, h) => ms > 0 ? row([String(h).padStart(2, "0") + ":00 to " + String(h).padStart(2, "0") + ":59", D(ms)], [1]) : "").filter(Boolean), [1])}
<h2>Devices</h2>${table(["Device", "Watch time", "Share", "Sessions"], r.byDevice.map(d => row([d.label, D(d.watchMs), d.share + "%", d.sessions], [1, 2, 3])), [1, 2, 3])}
<h2>Channels (${r.channels.length})</h2>${table(["Channel", "Watch time", "Videos"], r.channels.map(x => row([x.channel, D(x.watchMs), x.videos], [1, 2])), [1, 2])}
<h2>Videos (${r.videos.length})</h2>${table(["Video", "Watch time", "Sessions", "Last played (SLST)"], r.videos.map(v => row([v.title || v.videoId, D(v.watchMs), v.sessions, v.lastWatchedAt ? S(v.lastWatchedAt) : ""], [1, 2])), [1, 2])}
<h2>Viewing sessions (${shown.length}${r.viewingsTotal > shown.length ? " of " + r.viewingsTotal : ""})</h2>${table(["First played (SLST)", "Device", "Video", "Channel", "Watch time"], shown.map(v => row([S(v.firstPlayedAt), v.deviceLabel, v.title || v.videoId, v.channel || UNKNOWN_CHANNEL, D(v.watchMs)], [4])), [4])}
<script src="/print.js"></script></body></html>`;
}
