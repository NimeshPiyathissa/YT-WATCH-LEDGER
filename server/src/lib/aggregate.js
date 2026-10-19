// Pure aggregation over decrypted session items for the combined dashboard. No database, no clock of its own.
// Times are epoch ms on the SERVER's clock (device skew already applied). tzOffsetMin is the browser's
// Date#getTimezoneOffset() (minutes, positive west of UTC) so day/week/month boundaries match the viewer's calendar.
const DAY = 86400000;
const pad = n => (n < 10 ? "0" + n : String(n));
const shifted = (ts, tz) => new Date(ts - tz * 60000); // read with UTC getters = viewer-local wall clock

export const dayKey = (ts, tz = 0) => { const d = shifted(ts, tz); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); };
export const monthKey = (ts, tz = 0) => { const d = shifted(ts, tz); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1); };
// Weeks start on Monday; the key is that Monday's date.
export function weekKey(ts, tz = 0) {
  const d = shifted(ts, tz), dow = (d.getUTCDay() + 6) % 7;
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY;
  const m = new Date(monday);
  return m.getUTCFullYear() + "-" + pad(m.getUTCMonth() + 1) + "-" + pad(m.getUTCDate());
}

const when = it => it.startTsAdj ?? it.startTs ?? 0;

export function summarize(items, { now = Date.now(), tzOffsetMin = 0 } = {}) {
  const tz = tzOffsetMin;
  const byDay = {}, byWeek = {}, byMonth = {}, byDevice = {}, byChannel = {}, byVideo = {};
  let totalMs = 0, completions = 0, seeks = 0, pauses = 0;
  const videos = new Set();
  for (const it of items) {
    const ms = it.watchedMs || 0, t = when(it);
    totalMs += ms; seeks += it.seeks || 0; pauses += it.pauses || 0; if (it.completed) completions++;
    videos.add(it.videoId);
    byDay[dayKey(t, tz)] = (byDay[dayKey(t, tz)] || 0) + ms;
    byWeek[weekKey(t, tz)] = (byWeek[weekKey(t, tz)] || 0) + ms;
    byMonth[monthKey(t, tz)] = (byMonth[monthKey(t, tz)] || 0) + ms;
    const dv = byDevice[it.deviceId] || (byDevice[it.deviceId] = { deviceId: it.deviceId, label: it.deviceLabel || "", totalMs: 0, sessions: 0 });
    dv.totalMs += ms; dv.sessions++;
    const chName = it.channel || "(unknown)";
    byChannel[chName] = (byChannel[chName] || 0) + ms;
    const v = byVideo[it.videoId] || (byVideo[it.videoId] = { videoId: it.videoId, title: it.title || "", url: it.url || "", totalMs: 0, views: 0 });
    v.totalMs += ms; v.views++; if (it.title) v.title = it.title; if (it.url) v.url = it.url;
  }

  const daily = [];
  for (let i = 29; i >= 0; i--) { const k = dayKey(now - i * DAY, tz); daily.push({ key: k, label: k.slice(5), value: byDay[k] || 0 }); }
  const weekly = [];
  for (let i = 11; i >= 0; i--) { const k = weekKey(now - i * 7 * DAY, tz); weekly.push({ key: k, label: k.slice(5), value: byWeek[k] || 0 }); }
  const monthly = [];
  const nl = shifted(now, tz);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Date.UTC(nl.getUTCFullYear(), nl.getUTCMonth() - i, 1));
    const k = m.getUTCFullYear() + "-" + pad(m.getUTCMonth() + 1);
    monthly.push({ key: k, label: k, value: byMonth[k] || 0 });
  }
  const sum = (arr, n) => arr.slice(-n).reduce((a, d) => a + d.value, 0);
  // Ties break by name so equal totals always list in the same order.
  const top = (obj, n, f) => Object.values(obj).sort((a, b) => b.totalMs - a.totalMs || (a.title || "").localeCompare(b.title || "") || a.videoId.localeCompare(b.videoId)).slice(0, n).map(f);
  return {
    totalMs, sessions: items.length, videos: videos.size, completions, seeks, pauses,
    todayMs: daily[daily.length - 1].value, last7Ms: sum(daily, 7), last30Ms: sum(daily, 30),
    daily, weekly, monthly,
    byDevice: Object.values(byDevice).sort((a, b) => b.totalMs - a.totalMs),
    topChannels: Object.entries(byChannel).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([channel, ms]) => ({ channel, totalMs: ms })),
    topVideos: top(byVideo, 10, v => v)
  };
}
