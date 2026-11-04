import { describe, readSettings, validateUpdate, writeSetting, applyRuntime } from "../lib/settings.js";
import { getPrefs, KINDS } from "../lib/notifications.js";
import { previewRetention, purgeAll } from "../lib/retention.js";
import { audit } from "../lib/helpers.js";

// Owner-only. Reads every setting with its source and limits; writes are validated as a whole (one bad value rejects the request),
// applied at once without a restart, and written to the audit log with the old and new value of each setting that changed.
export default async function (app, { db, config }) {
  app.addHook("preHandler", app.authAdmin);

  app.get("/api/settings/studio", () => {
    const d = describe(db);
    return { ...d, notifications: getPrefs(db), notificationKinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.label])) };
  });

  // How many sessions a server-wide retention window would delete right now. Deletes nothing.
  app.get("/api/settings/retention-preview", (req, reply) => {
    const raw = req.query && req.query.days, n = Number(raw);
    if (raw === undefined || raw === "" || !Number.isInteger(n) || n < 0 || n > 3650) return reply.code(400).send({ error: "bad_days" });
    return { days: n, wouldRemove: n > 0 ? previewRetention(db, n) : 0 };
  });

  app.put("/api/settings/studio", (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply.code(400).send({ error: "bad_request" });
    const v = validateUpdate(body.changes);
    if (!v.ok) return reply.code(400).send({ error: v.error, key: v.key });
    const before = readSettings(db).values;
    // only what really changes: a value equal to the current effective one is not a change
    const real = v.changes.filter(c => (c.value === null ? readSettings(db).sources[c.key] === "owner" : before[c.key] !== c.value));
    if (!real.length) return { ok: true, changed: [], restartRequired: false, removedSessions: 0 };

    // Shortening the retention window deletes data. The owner must have been shown the count and confirmed that exact number.
    const ret = real.find(c => c.key === "server_retention_days");
    let removedSessions = 0;
    if (ret) {
      const days = ret.value === null ? 0 : ret.value, wouldRemove = days > 0 ? previewRetention(db, days) : 0;
      if (wouldRemove > 0 && body.confirmRemoveSessions !== wouldRemove) return reply.code(409).send({ error: "confirmation_required", key: "server_retention_days", days, wouldRemove });
    }
    db.transaction(() => { for (const c of real) writeSetting(db, c.key, c.value); })();
    applyRuntime(db, config);
    if (ret) removedSessions = purgeAll(db);
    const after = readSettings(db).values;
    const changed = real.map(c => ({ key: c.key, from: before[c.key], to: after[c.key] }));
    audit(db, req.admin.id, null, "settings_changed", req.ip, { changes: changed, ...(ret ? { removedSessions } : {}) });
    return { ok: true, changed, restartRequired: false, removedSessions };
  });
}
