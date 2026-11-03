import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectHealth, createCpuSampler, readVersion } from "../lib/health.js";

// Owner-only. The public /api/health stays a bare { ok: true } for load balancers; the details below (memory, disk, versions,
// device counts) are for the signed-in owner only.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export default async function (app, { db, config }) {
  const startedAt = Date.now(), cpu = createCpuSampler(), version = readVersion(ROOT);
  app.get("/api/system/health", { preHandler: app.authAdmin }, () =>
    collectHealth({ db, config, hub: app.hub, version, startedAt, cpu, root: ROOT }));
}
