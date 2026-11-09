import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authAdmin } from "./middleware/authAdmin.js";
import { authDevice } from "./middleware/authDevice.js";
import authRoutes from "./routes/auth.js";
import devicesRoutes from "./routes/devices.js";
import enrollRoutes from "./routes/enroll.js";
import syncRoutes from "./routes/sync.js";
import adminDataRoutes from "./routes/adminData.js";
import deviceAuthRoutes from "./routes/deviceAuth.js";
import dataRoutes from "./routes/data.js";
import deviceSessionRoutes from "./routes/deviceSessions.js";
import eventRoutes from "./routes/events.js";
import deviceConfigRoutes from "./routes/deviceConfig.js";
import videoIngestRoutes from "./routes/videoIngest.js";
import videoRoutes from "./routes/videos.js";
import analyticsRoutes from "./routes/analytics.js";
import healthRoutes from "./routes/health.js";
import deviceCenterRoutes from "./routes/deviceCenter.js";
import securityRoutes from "./routes/security.js";
import notificationRoutes from "./routes/notifications.js";
import settingsStudioRoutes from "./routes/settingsStudio.js";
import reportRoutes from "./routes/reports.js";
import updateRoutes from "./routes/updates.js";
import { applyRuntime } from "./lib/settings.js";
import { createHub } from "./lib/realtime.js";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

const DEFAULT_CONFIG = { dbPath: ":memory:", backupDir: "./data/backups", backupKeep: 14 };

export async function buildApp({ db, logger = false, https = null, config = {} }) {
  config = { ...DEFAULT_CONFIG, ...config };
  const app = Fastify({ logger, trustProxy: process.env.TRUST_PROXY === "true", bodyLimit: 2 * 1024 * 1024, forceCloseConnections: true, ...(https ? { https } : {}) });

  await app.register(cookie, { secret: process.env.COOKIE_SECRET });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  // CORS only matters for the dashboard origin; the extension uses host permissions + bearer tokens.
  await app.register(cors, { origin: process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : false, credentials: true });

  app.addHook("onSend", async (req, reply) => {
    reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' https://i.ytimg.com data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  });

  // One place decides what a failure looks like on the wire: never a stack trace, never internal detail.
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || 500;
    if (status === 429) return reply.code(429).send({ error: "rate_limited" });
    if (status === 413) return reply.code(413).send({ error: "payload_too_large" });
    if (err.validation || (status >= 400 && status < 500)) return reply.code(status === 404 ? 404 : 400).send({ error: status === 404 ? "not_found" : "bad_request" });
    req.log.error({ err, reqId: req.id }, "unhandled error");
    return reply.code(500).send({ error: "internal_error", requestId: req.id });
  });

  app.decorate("hub", createHub()); // real-time fan-out: SSE to the dashboard, WebSocket to devices
  app.decorate("authAdmin", authAdmin(db));
  app.decorate("authDevice", authDevice(db));
  app.decorate("authDeviceAny", authDevice(db, { allowPending: true }));

  await app.register(authRoutes, { db });
  await app.register(enrollRoutes, { db });
  await app.register(devicesRoutes, { db });
  await app.register(adminDataRoutes, { db });
  await app.register(syncRoutes, { db });
  await app.register(deviceAuthRoutes, { db });
  await app.register(dataRoutes, { db, config });
  await app.register(deviceSessionRoutes, { db });
  await app.register(eventRoutes, { db });
  await app.register(deviceConfigRoutes, { db });
  await app.register(videoIngestRoutes, { db });
  await app.register(videoRoutes, { db });
  await app.register(analyticsRoutes, { db });
  await app.register(healthRoutes, { db, config });
  await app.register(deviceCenterRoutes, { db, config });
  await app.register(securityRoutes, { db });
  await app.register(notificationRoutes, { db, config });
  await app.register(settingsStudioRoutes, { db, config });
  await app.register(reportRoutes, { db });
  await app.register(updateRoutes, { db, config });
  app.decorate("wlConfig", config); // the live configuration the owner can change; the timers in server.js read it too
  applyRuntime(db, config);          // the owner's saved values win over the environment from the first request
  await app.register(fastifyStatic, { root: WEB }); // admin SPA (PART B §B7)

  app.get("/api/health", async () => ({ ok: true }));
  return app;
}
