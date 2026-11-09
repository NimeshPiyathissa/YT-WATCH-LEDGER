import { computeAnalytics, DISPLAY_TZ } from "../lib/analytics.js";
import { loadIntervals } from "../lib/playbackIntervals.js";

// Owner-only analytics. Every query is scoped to the owner's own devices (devices.admin_id). The intervals are read by
// src/lib/playbackIntervals.js (shared with Reports); the arithmetic lives in src/lib/analytics.js and is unit tested on its own.
const DAY = 86400000, MAX_RANGE_DAYS = 366;
const RANGES = { today: 1, "7": 7, "30": 30, "90": 90, "365": 365 };
const num = v => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export default async function (app, { db }) {
  app.addHook("preHandler", app.authAdmin);

  app.get("/api/analytics", (req, reply) => {
    const q = req.query || {};
    const now = Date.now();
    let to = num(q.to), from = num(q.from);
    if (from === null && to === null && q.range !== undefined) {
      if (!Object.hasOwn(RANGES, String(q.range))) return reply.code(400).send({ error: "bad_range" });
      to = now; from = now - RANGES[String(q.range)] * DAY;
    }
    if (to === null) to = now;
    if (from === null) from = to - 30 * DAY;
    if (!(from >= 0) || !(to > from) || to - from > MAX_RANGE_DAYS * DAY) return reply.code(400).send({ error: "bad_range" });
    const granularity = q.granularity === undefined || q.granularity === "" ? "auto" : String(q.granularity);
    if (!["auto", "day", "week", "month"].includes(granularity)) return reply.code(400).send({ error: "bad_granularity" });
    let device = q.device && q.device !== "all" ? String(q.device).slice(0, 64) : null;
    if (device && !db.prepare("SELECT 1 FROM devices WHERE id=? AND admin_id=?").get(device, req.admin.id)) return reply.code(404).send({ error: "not_found" });
    // devices of another account are unreachable; a session that starts up to a day before `from` can still reach into the range
    const { intervals, sessions, labels, truncated } = loadIntervals(db, req.admin.id, device, from - (to - from) - DAY, to);
    return { ...computeAnalytics({ intervals, sessions, from, to, granularity, tz: DISPLAY_TZ, labels }), truncated, generatedAt: now };
  });
}
