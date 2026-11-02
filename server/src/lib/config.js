// Server-managed device configuration: the allowlist, validation, and diffing. The extension applies the same rules
// (lib/sync.js validateManagedConfig) and refuses anything it cannot validate, so neither side trusts the other.
//
// Deliberately NOT here: tracking on/off, what is collected, anything executable. A setting is only ever a bounded value.
export const SPEC = {
  retention_days: { min: 0, max: 3650, label: "Keep history for (days, 0 = forever)" },
  sync_interval_minutes: { min: 5, max: 60, label: "Sync every (minutes)" }
};
export const KEYS = Object.keys(SPEC);

// changes: { key: integer | null }. null clears the key (the setting goes back to being local to the device).
// Returns { ok: true, clean } or { ok: false, error }.
export function validateChanges(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return { ok: false, error: "bad_changes" };
  const entries = Object.entries(changes);
  if (!entries.length || entries.length > KEYS.length) return { ok: false, error: "bad_changes" };
  const clean = {};
  for (const [k, v] of entries) {
    if (!Object.hasOwn(SPEC, k)) return { ok: false, error: "unknown_setting", setting: k };
    if (v === null) { clean[k] = null; continue; }
    if (!Number.isInteger(v) || v < SPEC[k].min || v > SPEC[k].max) return { ok: false, error: "bad_value", setting: k };
    clean[k] = v;
  }
  return { ok: true, clean };
}

// Applies validated changes to the stored config; returns the new config and a { key: { from, to } } diff of what really changed.
export function applyChanges(current, clean) {
  const next = { ...current }, diff = {};
  for (const [k, v] of Object.entries(clean)) {
    const from = Object.hasOwn(current, k) ? current[k] : null;
    if (v === null) delete next[k]; else next[k] = v;
    if ((v === null ? null : v) !== from) diff[k] = { from, to: v };
  }
  return { next, diff };
}

// Whole-config check used on the way out of the database and by tests: drops anything not on the allowlist.
export function cleanStored(obj) {
  const out = {};
  for (const k of KEYS) if (obj && Number.isInteger(obj[k]) && obj[k] >= SPEC[k].min && obj[k] <= SPEC[k].max) out[k] = obj[k];
  return out;
}

// pending: saved, the device has not confirmed yet (it may be offline); applied: the device confirmed this version;
// failed: the device refused or could not apply this version; none: the owner has never set anything.
export function stateOf(row) {
  if (!row || row.version === 0) return "none";
  if (row.failed_version === row.version) return "failed";
  return row.applied_version === row.version ? "applied" : "pending";
}
