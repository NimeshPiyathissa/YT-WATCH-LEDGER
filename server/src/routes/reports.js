import { encryptJSON, decryptJSON, uuid } from "../lib/crypto.js";
import { audit } from "../lib/helpers.js";
import { loadIntervals } from "../lib/playbackIntervals.js";
import { DISPLAY_TZ } from "../lib/analytics.js";
import { validateSpec, resolvePeriod, buildReport, toCsv, toJson, toPrintHtml, fileStem, CSV_SCOPES } from "../lib/reports.js";

// Reports Studio. Owner-only (every route), and every read is scoped to the owner's own devices: a device of another account, or one that
// was removed, answers 404 and never says whether it exists. Specs are validated in full before anything is read; the arithmetic is the
// Analytics engine's (src/lib/reports.js, src/lib/analytics.js). Exports are written to the audit log.
const DAY = 86400000, MAX_SAVED = 50;
const SAVED_ID = /^[0-9a-f-]{36}$/;

export default async function (app, { db }) {
  app.addHook("preHandler", app.authAdmin);

  const ownsDevice = (adminId, id) => !!db.prepare("SELECT 1 FROM devices WHERE id=? AND admin_id=?").get(id, adminId);
  // A checked spec for this owner -> { report } or { code, error, field }.
  function run(req, input) {
    const v = validateSpec(input);
    if (!v.ok) return { code: 400, error: v.error, field: v.field };
    const spec = v.spec;
    if (spec.device && !ownsDevice(req.admin.id, spec.device)) return { code: 404, error: "not_found", field: "device" };
    const now = Date.now();
    // the period, the one before it (for the comparison), and a day more: a session that starts before a boundary can play across it
    const { from, to } = resolvePeriod(spec, now, DISPLAY_TZ);
    const data = loadIntervals(db, req.admin.id, spec.device || null, from - (to - from) - DAY, to);
    return { report: buildReport({ data, spec, now, tz: DISPLAY_TZ }) };
  }

  app.get("/api/reports", (req, reply) => {
    const r = run(req, req.query || {});
    if (r.error) return reply.code(r.code).send({ error: r.error, field: r.field });
    return r.report;
  });

  app.get("/api/reports/export", (req, reply) => {
    const q = req.query || {}, format = q.format === undefined ? "json" : String(q.format), scope = q.scope === undefined ? "days" : String(q.scope);
    if (!["csv", "json", "print"].includes(format)) return reply.code(400).send({ error: "bad_format", field: "format" });
    if (format === "csv" && !CSV_SCOPES.includes(scope)) return reply.code(400).send({ error: "bad_scope", field: "scope" });
    const r = run(req, q);
    if (r.error) return reply.code(r.code).send({ error: r.error, field: r.field });
    const rep = r.report, stem = fileStem(rep);
    audit(db, req.admin.id, rep.filters.device, "export_report", req.ip, { format, ...(format === "csv" ? { scope } : {}), period: rep.period.type, from: rep.period.fromDate, to: rep.period.toDate,
      filtered: !!(rep.filters.channel || rep.filters.video) });
    if (format === "csv") return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="${stem}-${scope}.csv"`).send(toCsv(rep, scope));
    if (format === "json") return reply.header("Content-Disposition", `attachment; filename="${stem}.json"`).send(toJson(rep));
    return reply.header("Content-Type", "text/html; charset=utf-8").send(toPrintHtml(rep));
  });

  /* ---- saved report configurations ---- */
  const list = adminId => db.prepare("SELECT id, enc, created_at, updated_at FROM saved_reports WHERE admin_id=? ORDER BY updated_at DESC, id").all(adminId)
    .map(r => { const x = decryptJSON(r.enc); return { id: r.id, name: x.name, spec: x.spec, createdAt: r.created_at, updatedAt: r.updated_at }; });
  // name: 1 to 80 characters, no control characters; unique for the owner (ignoring case).
  function checkBody(req, body, { partial = false, id = null } = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "bad_request" };
    for (const k of Object.keys(body)) if (k !== "name" && k !== "spec") return { error: "unknown_field", field: k };
    const out = {};
    if (body.name !== undefined || !partial) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return { error: "bad_name", field: "name" };
      if (list(req.admin.id).some(s => s.id !== id && s.name.toLowerCase() === name.toLowerCase())) return { code: 409, error: "name_taken", field: "name" };
      out.name = name;
    }
    if (body.spec !== undefined || !partial) {
      const v = validateSpec(body.spec, { strict: true });
      if (!v.ok) return { error: v.error, field: v.field ? "spec." + v.field : "spec" };
      if (v.spec.device && !ownsDevice(req.admin.id, v.spec.device)) return { code: 404, error: "not_found", field: "spec.device" };
      out.spec = v.spec;
    }
    return { ok: true, value: out };
  }
  const fail = (reply, c) => reply.code(c.code || 400).send({ error: c.error, ...(c.field ? { field: c.field } : {}) });

  app.get("/api/reports/saved", req => ({ items: list(req.admin.id), max: MAX_SAVED }));

  app.post("/api/reports/saved", (req, reply) => {
    const c = checkBody(req, req.body);
    if (!c.ok) return fail(reply, c);
    if (db.prepare("SELECT COUNT(*) n FROM saved_reports WHERE admin_id=?").get(req.admin.id).n >= MAX_SAVED) return reply.code(409).send({ error: "too_many", max: MAX_SAVED });
    const id = uuid(), now = Date.now();
    db.prepare("INSERT INTO saved_reports(id,admin_id,enc,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, req.admin.id, encryptJSON(c.value), now, now);
    audit(db, req.admin.id, null, "report_saved", req.ip, { id, period: c.value.spec.period });
    return reply.code(201).send({ id, ...c.value, createdAt: now, updatedAt: now });
  });

  app.put("/api/reports/saved/:id", (req, reply) => {
    const id = String(req.params.id);
    const cur = SAVED_ID.test(id) ? list(req.admin.id).find(s => s.id === id) : null;
    if (!cur) return reply.code(404).send({ error: "not_found" }); // another owner's id looks exactly like one that does not exist
    const c = checkBody(req, req.body, { partial: true, id });
    if (!c.ok) return fail(reply, c);
    const next = { name: c.value.name ?? cur.name, spec: c.value.spec ?? cur.spec }, now = Date.now();
    db.prepare("UPDATE saved_reports SET enc=?, updated_at=? WHERE id=? AND admin_id=?").run(encryptJSON(next), now, id, req.admin.id);
    audit(db, req.admin.id, null, "report_updated", req.ip, { id });
    return { id, ...next, createdAt: cur.createdAt, updatedAt: now };
  });

  app.delete("/api/reports/saved/:id", (req, reply) => {
    const id = String(req.params.id);
    const n = SAVED_ID.test(id) ? db.prepare("DELETE FROM saved_reports WHERE id=? AND admin_id=?").run(id, req.admin.id).changes : 0;
    if (!n) return reply.code(404).send({ error: "not_found" });
    audit(db, req.admin.id, null, "report_deleted", req.ip, { id });
    return { ok: true };
  });
}
