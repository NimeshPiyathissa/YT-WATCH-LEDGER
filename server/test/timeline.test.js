import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
// the browser file (an IIFE on window) loaded the way a page loads it
globalThis.window = {}; vm.runInThisContext(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "timeline.js"), "utf8"), { filename: "timeline.js" });
const T = globalThis.window.WLTimeline; delete globalThis.window;

const ev = (id, sessionId, seq, type, tsAdj, extra = {}) => ({ id, sessionId, seq, type, tsAdj, ts: tsAdj, pos: seq, ...extra });
const S = 1000;

test("quick filters map to event types and back; a custom mix matches none", () => {
  assert.deepEqual(T.typesOf("all"), []);
  assert.deepEqual(T.typesOf("seek"), ["VIDEO_SEEKED"]);
  assert.equal(T.groupOf(new Set()), "all");
  assert.equal(T.groupOf(new Set(["VIDEO_SEEKED"])), "seek");
  assert.equal(T.groupOf(T.typesOf("playpause")), "playpause");
  assert.equal(T.groupOf(new Set(["VIDEO_SEEKED", "VIDEO_PAUSED"])), "");
  assert.deepEqual(T.typesOf("nonsense"), []);
  for (const g of T.GROUPS) assert.ok(g.label && Array.isArray(g.types), g.key);
});

test("chronological order: by time, then viewing, then sequence; ties never reorder one viewing's events", () => {
  const list = [ev("b:e2", "b", 2, "VIDEO_PAUSED", 5 * S), ev("a:e2", "a", 2, "VIDEO_PAUSED", 5 * S), ev("a:e1", "a", 1, "VIDEO_STARTED", 5 * S), ev("a:e3", "a", 3, "VIDEO_RESUMED", 5 * S), ev("c:e1", "c", 1, "VIDEO_STARTED", 1 * S)];
  assert.deepEqual(T.normalize(list).map(e => e.id), ["c:e1", "a:e1", "a:e2", "a:e3", "b:e2"]);
  const shuffled = list.slice().reverse();
  assert.deepEqual(T.normalize(shuffled).map(e => e.id), T.normalize(list).map(e => e.id), "input order never matters");
});

test("duplicates (a replayed upload, a live push racing a refresh) are kept once, the first copy wins", () => {
  const a = ev("x:e1", "x", 1, "VIDEO_STARTED", S, { pos: 0 }), dup = ev("x:e1", "x", 1, "VIDEO_STARTED", S, { pos: 99 });
  const out = T.normalize([a, dup, ev("x:e2", "x", 2, "VIDEO_PAUSED", 2 * S), null, undefined]);
  assert.deepEqual(out.map(e => e.id), ["x:e1", "x:e2"]); assert.equal(out[0].pos, 0);
  assert.equal(T.normalize([]).length, 0);
});

test("viewing boundaries: a start row before the first event and an end row after the last, per viewing", () => {
  const list = T.normalize([ev("a:e1", "a", 1, "VIDEO_STARTED", 1 * S), ev("a:e2", "a", 2, "VIDEO_SESSION_ENDED", 9 * S), ev("b:e1", "b", 1, "VIDEO_STARTED", 20 * S), ev("b:e2", "b", 2, "VIDEO_PAUSED", 25 * S)]);
  const out = T.withBoundaries(list, { a: { deviceLabel: "Laptop" } });
  assert.deepEqual(out.map(x => x.kind === "event" ? x.e.id : x.edge + ":" + x.sessionId), ["start:a", "a:e1", "a:e2", "end:a", "start:b", "b:e1", "b:e2", "end:b"]);
  assert.equal(out[3].open, false, "a viewing that ended is closed");
  assert.equal(out[7].open, true, "a viewing whose last event is a pause is still open");
  assert.equal(out[0].deviceLabel, "Laptop");
});

test("interleaved viewings (two devices at once) keep their own boundaries", () => {
  const list = T.normalize([ev("a:e1", "a", 1, "VIDEO_STARTED", 1 * S), ev("b:e1", "b", 1, "VIDEO_STARTED", 2 * S), ev("a:e2", "a", 2, "VIDEO_SESSION_ENDED", 3 * S), ev("b:e2", "b", 2, "VIDEO_SESSION_ENDED", 4 * S)]);
  const out = T.withBoundaries(list).map(x => x.kind === "event" ? x.e.id : x.edge + ":" + x.sessionId);
  assert.deepEqual(out, ["start:a", "a:e1", "start:b", "b:e1", "a:e2", "end:a", "b:e2", "end:b"]);
});

test("the ribbon positions events on one shared axis, one lane per viewing, with pauses as spans", () => {
  const evs = [ev("a:e1", "a", 1, "VIDEO_STARTED", 0), ev("a:e2", "a", 2, "VIDEO_PAUSED", 40 * S), ev("a:e3", "a", 3, "VIDEO_RESUMED", 60 * S), ev("a:e4", "a", 4, "VIDEO_SESSION_ENDED", 100 * S), ev("b:e1", "b", 1, "VIDEO_STARTED", 50 * S)];
  const r = T.ribbon(evs, [{ sessionId: "a", pausedAt: 40 * S, resumedAt: 60 * S, status: "resumed" }], { axis: "shared" });
  assert.equal(r.span, 100 * S); assert.equal(r.lanes.length, 2);
  const a = r.lanes.find(l => l.sessionId === "a"), b = r.lanes.find(l => l.sessionId === "b");
  assert.deepEqual(a.markers.map(m => m.x), [0, 400, 600, 1000]);
  assert.deepEqual([a.x0, a.x1, b.x0], [0, 1000, 500]);
  assert.deepEqual(a.pauses.map(p => [p.x0, p.x1]), [[400, 600]]);
  assert.equal(b.pauses.length, 0, "a pause belongs to its own viewing's lane");
});

test("open and unresolved pauses get a span that never runs past the data", () => {
  const evs = [ev("a:e1", "a", 1, "VIDEO_STARTED", 0), ev("a:e2", "a", 2, "VIDEO_PAUSED", 50 * S), ev("a:e3", "a", 3, "VIDEO_SESSION_INTERRUPTED", 100 * S)];
  const r = T.ribbon(evs, [{ sessionId: "a", pausedAt: 50 * S, resumedAt: null, status: "unresolved", minDurationMs: 30 * S }, { sessionId: "a", pausedAt: 80 * S, resumedAt: null, status: "open" }], { axis: "shared" });
  const spans = r.lanes[0].pauses;
  assert.deepEqual(spans[0], { x0: 500, x1: 800, status: "unresolved" }, "known lower bound only: 50 s + 30 s");
  assert.ok(spans[1].x1 <= 1000 && spans[1].x1 >= spans[1].x0, "an open pause ends at the last event");
});

test("a very long viewing is merged into counted buckets, never more markers than the limit", () => {
  const evs = Array.from({ length: 1000 }, (_, i) => ev("a:e" + (i + 1), "a", i + 1, i % 2 ? "VIDEO_PAUSED" : "VIDEO_RESUMED", i * S));
  const r = T.ribbon(evs, [], { maxMarkers: 100 });
  const m = r.lanes[0].markers;
  assert.ok(m.length <= 100 + 1, "markers: " + m.length);
  assert.equal(m.reduce((n, x) => n + x.count, 0), 1000, "every event is accounted for in a bucket");
  assert.ok(m.some(x => x.type === "MIXED"), "buckets of different types say so");
});

test("an empty or single-event ribbon is safe", () => {
  assert.deepEqual(T.ribbon([], []).lanes, []);
  const one = T.ribbon([ev("a:e1", "a", 1, "VIDEO_STARTED", 5 * S)], []);
  assert.equal(one.lanes.length, 1); assert.equal(one.lanes[0].markers[0].x, 0); assert.ok(one.lanes[0].x1 > one.lanes[0].x0);
});

test("lane axis (the default): each viewing fills its own row, so a short viewing is readable even when viewings are days apart", () => {
  const day = 86400 * S;
  const evs = [ev("a:e1", "a", 1, "VIDEO_STARTED", 0), ev("a:e2", "a", 2, "VIDEO_PAUSED", 30 * S), ev("a:e3", "a", 3, "VIDEO_SESSION_ENDED", 60 * S),
    ev("b:e1", "b", 1, "VIDEO_STARTED", 3 * day), ev("b:e2", "b", 2, "VIDEO_PAUSED", 3 * day + 10 * S), ev("b:e3", "b", 3, "VIDEO_SESSION_ENDED", 3 * day + 20 * S)];
  const r = T.ribbon(evs, [{ sessionId: "a", pausedAt: 30 * S, resumedAt: 45 * S, status: "resumed" }]);
  assert.equal(r.axis, "lane");
  const a = r.lanes.find(l => l.sessionId === "a"), b = r.lanes.find(l => l.sessionId === "b");
  assert.deepEqual(a.markers.map(m => m.x), [0, 500, 1000]); assert.deepEqual(b.markers.map(m => m.x), [0, 500, 1000], "the second viewing is just as readable");
  assert.deepEqual(a.pauses.map(p => [p.x0, p.x1]), [[500, 750]]);
  assert.deepEqual([a.durationMs, b.durationMs], [60 * S, 20 * S]); assert.equal(a.first, 0);
  assert.equal(T.ribbon(evs, [], { axis: "shared" }).lanes.find(l => l.sessionId === "a").markers[1].x < 1, true, "on a shared axis the same viewing is a sliver");
});
