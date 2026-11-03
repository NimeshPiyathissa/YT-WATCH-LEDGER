// Advanced analytics over playback intervals. Pure: no database, no clock of its own, no I/O.
//
// Input is a list of intervals of REAL playback, { deviceId, sessionId, videoId, title, channel, start, end } in epoch ms on the
// server's clock. They come from the recorded playback runs (event based) and, for sessions recorded before events existed, from
// the session summary. This module never trusts a total: it recomputes everything from the intervals.
//
// Counting rule (no double counting): on one device, time during which several intervals overlap (two tabs, a replayed
// session that was uploaded twice) is counted ONCE. Within an overlap the single span is shared equally between the videos that
// were playing, so the per-video and per-channel totals add up to the device total. Different devices are different people or
// screens, so their times add up.
//
// Day / week / month boundaries are those of the display zone (Asia/Colombo by default), resolved with Intl, never the server's
// or the browser's zone. Intervals that cross a boundary are split at it.
export const DISPLAY_TZ = "Asia/Colombo";
const DAY = 86400000, HOUR = 3600000;
const pad = n => (n < 10 ? "0" + n : String(n));
const dtf = new Map();

// Offset of `tz` from UTC at instant `ts`, in ms (Colombo: +19 800 000).
export function tzOffsetMs(ts, tz = DISPLAY_TZ) {
  let f = dtf.get(tz);
  if (!f) dtf.set(tz, f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  const o = {};
  for (const p of f.formatToParts(new Date(Math.floor(ts / 1000) * 1000))) o[p.type] = Number(p.value);
  return Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second) - Math.floor(ts / 1000) * 1000;
}
const mod = (a, n) => ((a % n) + n) % n;
// Local midnight (as an instant) of the day containing `ts`.
export function dayStart(ts, tz = DISPLAY_TZ) {
  const off = tzOffsetMs(ts, tz), local = ts + off, mid = local - mod(local, DAY);
  return mid - tzOffsetMs(mid - off, tz);
}
// Start of the bucket (day / week starting Monday / month) containing `ts`.
export function bucketStart(ts, gran, tz = DISPLAY_TZ) {
  const d = dayStart(ts, tz);
  if (gran === "day") return d;
  const off = tzOffsetMs(d, tz), local = d + off;
  if (gran === "week") return d - mod(Math.floor(local / DAY) + 3, 7) * DAY; // 1970-01-01 was a Thursday; Monday = 0
  const dt = new Date(local); // gran === "month": first of the local month
  const first = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1);
  return first - tzOffsetMs(first - off, tz);
}
export const nextBucketStart = (start, gran, tz = DISPLAY_TZ) => bucketStart(start + (gran === "day" ? 1.5 * DAY : gran === "week" ? 7.5 * DAY : 31.5 * DAY), gran, tz);
export function bucketKey(start, gran, tz = DISPLAY_TZ) {
  const dt = new Date(start + tzOffsetMs(start + 6 * HOUR, tz)), y = dt.getUTCFullYear(), m = pad(dt.getUTCMonth() + 1);
  return gran === "month" ? y + "-" + m : y + "-" + m + "-" + pad(dt.getUTCDate());
}
// Local hour (0-23) and weekday (Monday = 0) of an instant.
const localHour = (ts, tz) => Math.floor(mod(ts + tzOffsetMs(ts, tz), DAY) / HOUR);
const localWeekday = (ts, tz) => mod(Math.floor((ts + tzOffsetMs(ts, tz)) / DAY) + 3, 7);

// Granularity for a range when the caller says "auto".
export function autoGranularity(from, to) {
  const days = (to - from) / DAY;
  return days <= 45 ? "day" : days <= 180 ? "week" : "month";
}

// Walks [t0, t1) in pieces that do not cross a boundary produced by `next(t)`, calling fn(pieceStart, pieceEnd).
function eachPiece(t0, t1, next, fn) {
  let t = t0;
  while (t < t1) { const n = Math.min(next(t), t1); fn(t, n); t = n > t ? n : t1; }
}

// One pass over every device: clip to [from, to), merge overlaps, share overlapping spans, and bucket the result.
function sweep(intervals, from, to, gran, tz) {
  const byDevice = new Map();
  for (const it of intervals) {
    const s = Math.max(it.start, from), e = Math.min(it.end, to);
    if (!(e > s)) continue;
    if (!byDevice.has(it.deviceId)) byDevice.set(it.deviceId, []);
    byDevice.get(it.deviceId).push({ ...it, s, e });
  }
  const out = {
    totalMs: 0, rawMs: 0, devices: new Map(), videos: new Map(), channels: new Map(), sessions: new Map(),
    buckets: new Map(), hours: new Array(24).fill(0), weekdays: new Array(7).fill(0), days: new Set()
  };
  const bump = (m, k, ms, init) => { const v = m.get(k) || init(); v.ms += ms; m.set(k, v); return v; };
  for (const [deviceId, list] of byDevice) {
    const points = [];
    list.forEach((it, i) => { out.rawMs += it.e - it.s; points.push([it.s, 1, i], [it.e, -1, i]); });
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // an interval that ends where another starts never overlaps it
    const active = new Set();
    let prev = null, deviceMs = 0;
    for (const [t, d, i] of points) {
      if (prev !== null && t > prev && active.size) {
        const span = t - prev, share = span / active.size;
        deviceMs += span;
        for (const j of active) {
          const it = list[j];
          bump(out.videos, it.videoId, share, () => ({ videoId: it.videoId, title: it.title || "", ms: 0, sessions: new Set(), last: 0 }));
          const v = out.videos.get(it.videoId); v.sessions.add(it.deviceId + "/" + it.sessionId); if (it.title) v.title = it.title; v.last = Math.max(v.last, t);
          bump(out.channels, it.channel || "(unknown)", share, () => ({ channel: it.channel || "(unknown)", ms: 0, videos: new Set() })).videos.add(it.videoId);
          bump(out.sessions, it.deviceId + "/" + it.sessionId, share, () => ({ ms: 0 }));
        }
        eachPiece(prev, t, x => nextBucketStart(bucketStart(x, gran, tz), gran, tz), (a, b) => {
          const k = bucketStart(a, gran, tz);
          out.buckets.set(k, (out.buckets.get(k) || 0) + (b - a));
        });
        eachPiece(prev, t, x => dayStart(x, tz) + DAY, (a, b) => out.days.add(dayStart(a, tz)));
        eachPiece(prev, t, x => { const o = tzOffsetMs(x, tz); return x - mod(x + o, HOUR) + HOUR; }, (a, b) => {
          out.hours[localHour(a, tz)] += b - a; out.weekdays[localWeekday(a, tz)] += b - a;
        });
      }
      if (d === 1) active.add(i); else active.delete(i);
      prev = t;
    }
    out.totalMs += deviceMs;
    bump(out.devices, deviceId, deviceMs, () => ({ deviceId, ms: 0, sessions: new Set() }));
    for (const it of list) out.devices.get(deviceId).sessions.add(it.sessionId);
  }
  return out;
}

const round = n => Math.round(n);
const trendOf = pct => (pct === null ? "none" : pct > 5 ? "up" : pct < -5 ? "down" : "flat");

// params: { intervals, from, to, granularity ('auto'|'day'|'week'|'month'), tz, labels: {deviceId: label}, sessionMeta?: [..] }
export function computeAnalytics({ intervals, from, to, granularity = "auto", tz = DISPLAY_TZ, labels = {}, sessions = [] }) {
  const gran = ["day", "week", "month"].includes(granularity) ? granularity : autoGranularity(from, to);
  const cur = sweep(intervals, from, to, gran, tz);
  const len = to - from, pFrom = from - len, pTo = from;
  const prev = sweep(intervals, pFrom, pTo, gran, tz);

  const series = [];
  for (let b = bucketStart(from, gran, tz), n = 0; b < to && n < 800; b = nextBucketStart(b, gran, tz), n++) {
    series.push({ key: bucketKey(b, gran, tz), start: b, watchMs: round(cur.buckets.get(b) || 0) });
  }
  const watchMs = round(cur.totalMs), prevMs = round(prev.totalMs);
  const deltaPct = prevMs > 0 ? Math.round((watchMs - prevMs) / prevMs * 1000) / 10 : (watchMs > 0 ? null : 0);
  const activeDays = cur.days.size;
  const inRange = sessions.filter(s => s.start >= from && s.start < to);
  const perSession = [...cur.sessions.values()].map(v => v.ms);
  const sorted = (m, f) => [...m.values()].sort((a, b) => b.ms - a.ms || String(f(a)).localeCompare(String(f(b))));
  return {
    timeZone: tz,
    range: { from, to, granularity: gran },
    totals: {
      watchMs, sessions: Math.max(inRange.length, cur.sessions.size), videos: cur.videos.size, channels: cur.channels.size,
      activeDays, avgPerActiveDayMs: activeDays ? round(cur.totalMs / activeDays) : 0,
      avgPerDayMs: round(cur.totalMs / Math.max(1, len / DAY)),
      avgSessionMs: cur.sessions.size ? round(cur.totalMs / cur.sessions.size) : 0,
      longestSessionMs: perSession.length ? round(Math.max(...perSession)) : 0,
      completed: inRange.filter(s => s.completed).length, pauses: inRange.reduce((a, s) => a + (s.pauses || 0), 0), seeks: inRange.reduce((a, s) => a + (s.seeks || 0), 0),
      overlapRemovedMs: round(Math.max(0, cur.rawMs - cur.totalMs))
    },
    series,
    comparison: { from: pFrom, to: pTo, watchMs: prevMs, deltaMs: watchMs - prevMs, deltaPct, trend: trendOf(deltaPct) },
    topVideos: sorted(cur.videos, v => v.videoId).slice(0, 10).map(v => ({ videoId: v.videoId, title: v.title, watchMs: round(v.ms), sessions: v.sessions.size, lastWatchedAt: v.last })),
    topChannels: sorted(cur.channels, c => c.channel).slice(0, 10).map(c => ({ channel: c.channel, watchMs: round(c.ms), videos: c.videos.size })),
    byDevice: sorted(cur.devices, d => d.deviceId).map(d => ({ deviceId: d.deviceId, label: labels[d.deviceId] || "Device", watchMs: round(d.ms), sessions: d.sessions.size, share: cur.totalMs ? Math.round(d.ms / cur.totalMs * 1000) / 10 : 0 })),
    byHour: cur.hours.map(round),
    byWeekday: cur.weekdays.map(round)
  };
}
