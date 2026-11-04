import { securityOverview } from "../lib/security.js";

// Owner-only: one read of everything security-relevant, with plain-language findings. Sign-in management is in routes/auth.js.
export default async function (app, { db }) {
  app.addHook("preHandler", app.authAdmin);
  app.get("/api/security/overview", req => securityOverview(db, req.admin.id, { trustProxy: process.env.TRUST_PROXY === "true", baseUrl: process.env.BASE_URL || "" }));
}
