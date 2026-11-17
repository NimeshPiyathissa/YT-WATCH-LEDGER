// Settings Studio: the one place that knows every setting the owner can change from the dashboard, what is allowed, where the value comes
// from, and how a change takes effect.
//
//   Precedence: the owner's saved value, then the server's environment (when it is a valid value), then the built-in default.
//   Editable settings take effect immediately, with no restart. Anything that is only read when the server starts is listed in
//   READONLY: the studio shows its current value and the variable that controls it, but never changes it.
//   Secrets (MASTER_KEY, COOKIE_SECRET) and filesystem paths are never read here.
import { getGlobalRetention, setGlobalRetention } from "./retention.js";

const PAGES = ["overview", "analytics", "reports", "history", "videos", "devices", "notifications", "health"];

export const SETTINGS = {
  server_retention_days: { group: "retention", type: "int", min: 0, max: 3650, def: 0, unit: "days", label: "Keep watch history on the server for",
    help: "Sessions older than this are deleted from the server. 0 keeps everything. A device can set a shorter window of its own; the shorter one wins. Shortening this deletes data, so you are shown how much first." },
  audit_retention_days: { group: "retention", type: "int", min: 30, max: 3650, def: 365, unit: "days", label: "Keep the audit log for",
    help: "Entries older than this are removed. The log is also capped at 100,000 entries." },
  backup_interval_hours: { group: "backups", type: "int", min: 0, max: 720, def: 24, unit: "hours", env: "BACKUP_INTERVAL_HOURS", label: "Back up automatically every",
    help: "0 switches scheduled backups off (you can still back up by hand). The server checks every ten minutes." },
  backup_keep: { group: "backups", type: "int", min: 1, max: 365, def: 14, unit: "backups", env: "BACKUP_KEEP", label: "Keep the newest",
    help: "Older automatic backups are deleted when a new one is made. Backups made with the backup script are never deleted." },
  pairing_code_ttl_min: { group: "security", type: "int", min: 1, max: 120, def: 15, unit: "minutes", env: "PAIRING_CODE_TTL_MIN", label: "A pairing code stays valid for",
    help: "Applies to codes you create from now on." },
  pairing_max_fails: { group: "security", type: "int", min: 1, max: 50, def: 5, unit: "wrong codes", env: "PAIRING_MAX_FAILS", label: "Lock out an address after",
    help: "Wrong pairing codes from one address within 15 minutes, then that address is locked out for 15 minutes. Held in memory: a restart clears it." },
  update_check_enabled: { group: "updates", type: "bool", def: false, label: "Check GitHub for new releases",
    help: "Off by default. When on, the Updates page can ask GitHub's public releases list whether a newer version exists, only when you press Check now. No account, token or data of yours is sent; GitHub sees this server's address. Nothing is ever installed from the dashboard." },
  update_include_prereleases: { group: "updates", type: "bool", def: false, label: "Also offer newer pre-releases",
    help: "Only applies while this server runs a pre-release (beta or release candidate): newer pre-releases of the same release line are offered as well as stable releases. A stable server is only ever offered stable releases. Never a downgrade." },
  default_page: { group: "preferences", type: "enum", values: PAGES, def: "overview", label: "Open the dashboard on",
    help: "The page shown when you open the dashboard without a link to a specific page." },
  compact_tables: { group: "preferences", type: "bool", def: false, label: "Compact tables",
    help: "Tighter rows in tables, to show more on one screen." }
};

// Read when the server starts (or by the reverse proxy), so they cannot be changed here. Shown with their current, non-secret value.
export const READONLY = ["ACCESS_TTL", "REFRESH_TTL", "TRUST_PROXY", "ENROLL_RATE_MAX", "CORS_ORIGIN", "BASE_URL", "PORT"];
const READONLY_INFO = {
  ACCESS_TTL: { label: "Sign-in cookie lifetime", help: "Seconds a dashboard access cookie works before it is renewed.", def: "900" },
  REFRESH_TTL: { label: "Stay signed in for", help: "Seconds until you must sign in again.", def: "" },
  TRUST_PROXY: { label: "Trust the reverse proxy", help: "true behind nginx or similar, so limits and lock-outs apply to each visitor.", def: "false" },
  ENROLL_RATE_MAX: { label: "Pairing attempts per hour", help: "Per address, registered when the server starts.", def: "20" },
  CORS_ORIGIN: { label: "Allowed dashboard origin", help: "The one origin allowed to call the API from a browser.", def: "(none)" },
  BASE_URL: { label: "Public address", help: "The address people use to reach this server.", def: "" },
  PORT: { label: "Listening port", help: "The local port the server listens on.", def: "8443" }
};

export const GROUPS = [
  { key: "retention", title: "Data retention", intro: "How long the server keeps what your devices send." },
  { key: "backups", title: "Backups", intro: "Automatic backups of the database. Keep copies off this server too." },
  { key: "security", title: "Pairing and access", intro: "How new devices are admitted." },
  { key: "updates", title: "Updates", intro: "Whether the Updates page may look for new releases. Updates are always installed on the server with scripts/update.sh." },
  { key: "preferences", title: "Your preferences", intro: "How the dashboard looks and where it opens." }
];

// A whole number within [min, max], or the default (and `valid:false` so the caller can say so). Unset or empty is simply the default.
export function resolveInt(raw, { min, max, def }) {
  if (raw === undefined || raw === null || raw === "") return { value: def, valid: true, unset: true };
  const s = String(raw).trim();
  if (!/^-?\d+$/.test(s)) return { value: def, valid: false };
  const n = Number(s);
  return n >= min && n <= max ? { value: n, valid: true } : { value: def, valid: false };
}

const DBKEY = k => (k === "server_retention_days" ? "server_retention_days" : "setting." + k);
const readRow = (db, k) => { const r = db.prepare("SELECT value FROM settings WHERE key=?").get(DBKEY(k)); return r ? r.value : null; };

function parseStored(spec, text) {
  if (spec.type === "int") { const r = resolveInt(text, spec); return r.valid && !r.unset ? r.value : undefined; }
  if (spec.type === "bool") return text === "true" ? true : text === "false" ? false : undefined;
  if (spec.type === "enum") return spec.values.includes(text) ? text : undefined;
  return undefined;
}

// The effective value of every editable setting, where it came from, and any problem with the environment.
export function readSettings(db, env = process.env) {
  const values = {}, sources = {}, warnings = [];
  for (const [k, spec] of Object.entries(SETTINGS)) {
    const stored = readRow(db, k), own = stored === null ? undefined : parseStored(spec, stored);
    if (own !== undefined) { values[k] = own; sources[k] = "owner"; continue; }
    if (spec.env) {
      const r = resolveInt(env[spec.env], spec);
      if (!r.valid) warnings.push(`${spec.env} is "${String(env[spec.env]).slice(0, 40)}", which is not a whole number from ${spec.min} to ${spec.max}; the default ${spec.def} is used. Fix it in the server's environment file.`);
      else if (!r.unset) { values[k] = r.value; sources[k] = "environment"; continue; }
    }
    values[k] = spec.def; sources[k] = "default";
  }
  return { values, sources, warnings };
}

// ---- applying: the running server picks the owner's values up without a restart ----
const originalEnv = new Map(); // what the environment said before the owner overrode it, so "use the server default" can put it back
const ENV_APPLIED = { pairing_code_ttl_min: "PAIRING_CODE_TTL_MIN", pairing_max_fails: "PAIRING_MAX_FAILS" };
const callerConfig = new WeakMap(); // what the caller put in `config` before the first apply, so a value nobody set explicitly does not replace it
const CONFIG_FIELDS = { backup_keep: "backupKeep", backup_interval_hours: "backupIntervalHours" };
export function applyRuntime(db, config, env = process.env) {
  const { values, sources } = readSettings(db, env);
  if (config) {
    if (!callerConfig.has(config)) callerConfig.set(config, { ...config });
    const given = callerConfig.get(config);
    // An explicit value (the owner's, or the environment's) wins; otherwise the caller's own value stands, and only then the built-in default.
    for (const [k, field] of Object.entries(CONFIG_FIELDS)) {
      config[field] = sources[k] !== "default" || given[field] === undefined ? values[k] : given[field];
    }
  }
  for (const [k, name] of Object.entries(ENV_APPLIED)) {
    if (sources[k] === "owner") { if (!originalEnv.has(name)) originalEnv.set(name, env[name]); env[name] = String(values[k]); }
    else if (originalEnv.has(name)) { const o = originalEnv.get(name); if (o === undefined) delete env[name]; else env[name] = o; originalEnv.delete(name); }
  }
  return values;
}

// Checks an update ({ key: value | null }) and returns { ok, changes } or { ok:false, error, key }. null means "go back to the server default".
export function validateUpdate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "bad_request" };
  const keys = Object.keys(input);
  if (!keys.length) return { ok: false, error: "no_changes" };
  const changes = [];
  for (const k of keys) {
    const spec = SETTINGS[k], v = input[k];
    if (!spec) return { ok: false, error: READONLY.includes(k) ? "restart_required" : "unknown_setting", key: k };
    if (v === null) { changes.push({ key: k, value: null }); continue; }
    if (spec.type === "int" && !(Number.isInteger(v) && v >= spec.min && v <= spec.max)) return { ok: false, error: "bad_value", key: k };
    if (spec.type === "bool" && typeof v !== "boolean") return { ok: false, error: "bad_value", key: k };
    if (spec.type === "enum" && !spec.values.includes(v)) return { ok: false, error: "bad_value", key: k };
    changes.push({ key: k, value: v });
  }
  return { ok: true, changes };
}

export function writeSetting(db, key, value) {
  if (value === null) { db.prepare("DELETE FROM settings WHERE key=?").run(DBKEY(key)); return; }
  if (key === "server_retention_days") { setGlobalRetention(db, value); return; }
  db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(DBKEY(key), String(value));
}

// The shape the dashboard draws.
export function describe(db, env = process.env) {
  const { values, sources, warnings } = readSettings(db, env);
  const item = k => { const s = SETTINGS[k]; return { key: k, group: s.group, label: s.label, help: s.help, type: s.type, unit: s.unit || null, min: s.min ?? null, max: s.max ?? null, values: s.values || null,
    value: values[k], default: s.def, source: sources[k], env: s.env || null, editable: true, restart: false }; };
  const groups = GROUPS.map(g => ({ ...g, items: Object.keys(SETTINGS).filter(k => SETTINGS[k].group === g.key).map(item) }));
  const restartRequired = READONLY.map(name => ({ env: name, label: READONLY_INFO[name].label, help: READONLY_INFO[name].help, value: env[name] || READONLY_INFO[name].def || "(not set)", editable: false, restart: true }));
  return { groups, restartRequired, warnings };
}

export { getGlobalRetention };
