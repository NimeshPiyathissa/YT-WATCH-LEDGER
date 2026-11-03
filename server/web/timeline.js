/* timeline.js: the pure parts of the Video Timeline (window.WLTimeline). No DOM, no network, no clock: everything the timeline needs to
   decide is here so it can be tested exactly. Events arrive from the server already on its clock (tsAdj); this module only orders,
   de-duplicates, groups and positions them. */
(function (root) {
  "use strict";
  // Quick filters: each is a set of event types. "all" is no filter at all.
  const GROUPS = [
    { key: "all", label: "All events", types: [] },
    { key: "playpause", label: "Play and pause", types: ["VIDEO_STARTED", "VIDEO_PAUSED", "VIDEO_RESUMED", "VIDEO_REPLAYED", "VIDEO_COMPLETED"] },
    { key: "seek", label: "Seeks", types: ["VIDEO_SEEKED"] },
    { key: "buffering", label: "Buffering", types: ["VIDEO_BUFFERING_STARTED", "VIDEO_BUFFERING_ENDED"] },
    { key: "attention", label: "Tab and speed", types: ["VIDEO_TAB_HIDDEN", "VIDEO_TAB_VISIBLE", "VIDEO_PLAYING"] },
    { key: "boundaries", label: "Viewing start and end", types: ["VIDEO_STARTED", "VIDEO_SESSION_ENDED", "VIDEO_SESSION_INTERRUPTED"] }
  ];
  const sameSet = (set, arr) => set.size === arr.length && arr.every(t => set.has(t));
  // Which quick filter the current type selection equals, or "" when it is a custom mix.
  const groupOf = types => { const s = types instanceof Set ? types : new Set(types || []); return (GROUPS.find(g => sameSet(s, g.types)) || { key: "" }).key; };
  const typesOf = key => { const g = GROUPS.find(x => x.key === key); return g ? g.types.slice() : []; };

  // Chronological order: server time, then the viewing, then the event's own sequence number inside it. The sequence number is the
  // tie-breaker that keeps events of one viewing in the order they happened even when their timestamps are equal.
  const cmp = (a, b) => (a.tsAdj - b.tsAdj) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) || (a.seq - b.seq);
  // The same event delivered twice (a replayed upload, a live push that raced a refresh) is kept once; the first copy wins.
  function dedupe(list) { const seen = new Set(), out = []; for (const e of list) { if (!e || seen.has(e.id)) continue; seen.add(e.id); out.push(e); } return out; }
  const normalize = list => dedupe(list).sort(cmp);

  // Interleaves "viewing" boundary rows with the events of an ascending list: a start row before the first event of each viewing and an
  // end row after its last event. `sessions` is optional metadata { sessionId: { deviceLabel, startedAt, endedAt, state, completed } }.
  function withBoundaries(sorted, sessions) {
    const meta = sessions || {}, out = [], last = new Map(), first = new Set();
    sorted.forEach((e, i) => { last.set(e.sessionId, i); });
    sorted.forEach((e, i) => {
      if (!first.has(e.sessionId)) { first.add(e.sessionId); out.push({ kind: "boundary", edge: "start", sessionId: e.sessionId, at: e.tsAdj, deviceLabel: e.deviceLabel || (meta[e.sessionId] || {}).deviceLabel || "Device", meta: meta[e.sessionId] || null }); }
      out.push({ kind: "event", e });
      if (last.get(e.sessionId) === i) out.push({ kind: "boundary", edge: "end", sessionId: e.sessionId, at: e.tsAdj, deviceLabel: e.deviceLabel || (meta[e.sessionId] || {}).deviceLabel || "Device", meta: meta[e.sessionId] || null, open: !/^VIDEO_SESSION_(ENDED|INTERRUPTED)$/.test(e.type) });
    });
    return out;
  }

  // The interactive ribbon: one lane per viewing. Markers are the events; a pause is a shaded span.
  //   axis "lane" (default): every viewing is stretched over the full width, so a ten-minute viewing is readable even when the next one is
  //                          days away. axis "shared": all viewings on one common time axis (shows how they overlap).
  // When there are more markers than maxMarkers in a lane they are merged into counted buckets, so a very long viewing stays readable.
  function ribbon(events, pauses, opts) {
    const o = Object.assign({ maxMarkers: 120, width: 1000, axis: "lane" }, opts), list = normalize(events);
    if (!list.length) return { from: 0, to: 0, lanes: [], span: 0, axis: o.axis };
    const from = list[0].tsAdj, to = list[list.length - 1].tsAdj, span = Math.max(1, to - from);
    const lanes = new Map();
    for (const e of list) {
      if (!lanes.has(e.sessionId)) lanes.set(e.sessionId, { sessionId: e.sessionId, deviceLabel: e.deviceLabel || "Device", events: [], first: e.tsAdj, last: e.tsAdj });
      const l = lanes.get(e.sessionId); l.events.push(e); l.last = e.tsAdj;
    }
    const out = [...lanes.values()].map(l => {
      const lo = o.axis === "shared" ? from : l.first, sp = o.axis === "shared" ? span : Math.max(1, l.last - l.first);
      const x = t => Math.max(0, Math.min(o.width, Math.round((t - lo) / sp * o.width * 10) / 10));
      const markers = l.events.map(e => ({ id: e.id, x: x(e.tsAdj), type: e.type, at: e.tsAdj, pos: e.pos, count: 1 }));
      let merged = markers;
      if (markers.length > o.maxMarkers) {
        const size = o.width / o.maxMarkers, buckets = new Map();
        for (const m of markers) {
          const k = Math.floor(m.x / size), b = buckets.get(k);
          if (!b) buckets.set(k, { id: m.id, x: m.x, type: m.type, at: m.at, pos: m.pos, count: 1 });
          else { b.count++; if (m.type !== b.type) b.type = "MIXED"; }
        }
        merged = [...buckets.values()];
      }
      const ps = (pauses || []).filter(p => p.sessionId === l.sessionId).map(p => {
        const a = Math.max(p.pausedAt, from), b = Math.min(p.resumedAt != null ? p.resumedAt : (p.status === "unresolved" ? p.pausedAt + (p.minDurationMs || 0) : l.last), to);
        return { x0: x(a), x1: Math.max(x(b), x(a) + 1), status: p.status };
      });
      return { sessionId: l.sessionId, deviceLabel: l.deviceLabel, x0: x(l.first), x1: Math.max(x(l.last), x(l.first) + 1), markers: merged, pauses: ps, events: l.events.length, first: l.first, last: l.last, durationMs: l.last - l.first };
    });
    return { from, to, span, lanes: out, axis: o.axis };
  }

  const api = { GROUPS, groupOf, typesOf, cmp, dedupe, normalize, withBoundaries, ribbon };
  root.WLTimeline = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : this);
