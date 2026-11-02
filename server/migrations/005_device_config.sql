-- Server-managed device configuration: a small allowlist of settings the owner can set per device from the dashboard
-- (see src/lib/config.js). `version` counts changes; the device reports back which version it applied (or failed to).
-- Nothing here executes anything on the device: it only carries validated values the extension chooses to apply.
CREATE TABLE device_config (
  device_id TEXT PRIMARY KEY,
  config TEXT NOT NULL DEFAULT '{}',      -- JSON: only the keys the owner has set
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER, updated_by TEXT,
  applied_version INTEGER NOT NULL DEFAULT 0, applied_at INTEGER,
  failed_version INTEGER, failed_error TEXT, failed_at INTEGER,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- Every change, who made it, and what became of it on the device.
CREATE TABLE device_config_history (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, version INTEGER NOT NULL,
  changes TEXT NOT NULL,                   -- JSON: { key: { from, to } }
  actor_id TEXT NOT NULL, actor_label TEXT, created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|applied|failed|superseded
  status_at INTEGER, error TEXT,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX idx_config_history_dev ON device_config_history(device_id, version DESC);
