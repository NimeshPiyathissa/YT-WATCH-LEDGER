import { ingestEvents, MAX_BATCH } from "../lib/videoEvents.js";

// POST /api/sync/events — the device's playback events. Authenticated like every other device route (a revoked or pending
// device is refused before this runs). Idempotent: every event has a stable id, a re-sent id is acknowledged and ignored.
export default async function (app, { db }) {
  app.addHook("preHandler", app.authDevice);

  app.post("/api/sync/events", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = req.body || {};
    if (!Array.isArray(body.events)) return reply.code(400).send({ error: "bad_request" });
    if (body.events.length > MAX_BATCH) return reply.code(413).send({ error: "too_many_events" });
    const dev = req.device, now = Date.now();
    const { acked, rejected, fresh, skew } = ingestEvents(db, dev, body.events, { clientNow: body.clientNow, now });

    // Tell the owner's open Video Details pages straight away. The payload is exactly what the page needs to add the
    // events to its timeline; the page folds them with the same code the server uses. Timestamps are on the server's clock.
    if (fresh.length) {
      const byVideo = new Map();
      for (const e of fresh) { if (!byVideo.has(e.videoId)) byVideo.set(e.videoId, []); byVideo.get(e.videoId).push(e); }
      for (const [videoId, list] of byVideo) {
        app.hub.toAdmin(dev.admin_id, "video_event", {
          deviceId: dev.id, videoId, skewMs: skew,
          events: list.slice(0, 50).map(e => ({ id: e.id, sessionId: e.sessionId, seq: e.seq, type: e.type, ts: e.ts, pos: e.pos, rate: e.rate, prev: e.prev, next: e.next, meta: e.meta })),
          more: list.length > 50
        });
      }
    }
    return { ok: true, acked, rejected, serverNow: now, skewMs: skew };
  });
}
