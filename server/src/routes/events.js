// Server-Sent Events for the owner's dashboard: GET /api/events (cookie session, same origin).
// The stream is closed after at most STREAM_MAX_MS so a signed-out or expired session can't keep listening; the
// dashboard reconnects (refreshing its session first if needed).
const HEARTBEAT_MS = 25000, STREAM_MAX_MS = 10 * 60 * 1000;

export default async function (app) {
  app.get("/api/events", { preHandler: app.authAdmin }, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive",
      "X-Accel-Buffering": "no", // nginx: don't buffer the stream
      "X-Content-Type-Options": "nosniff", "Strict-Transport-Security": "max-age=63072000; includeSubDomains"
    });
    const write = (type, data) => { if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    res.write("retry: 3000\n\n");
    write("hello", { serverNow: Date.now() });
    const unsub = app.hub.subscribeAdmin(req.admin.id, write);
    const beat = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, HEARTBEAT_MS);
    const max = setTimeout(() => { write("reconnect", {}); res.end(); }, STREAM_MAX_MS);
    const done = () => { clearInterval(beat); clearTimeout(max); unsub(); };
    req.raw.on("close", done);
    res.on("close", done);
  });
}
