-- Single owner: the admins table may hold at most one row (the owner). Enforced by the database,
-- not just by the API, so no code path can create a second account.
CREATE UNIQUE INDEX idx_single_owner ON admins((1));

-- Device pairing: a redeemed pairing code creates a 'pending' device that cannot sync until the owner approves it.
ALTER TABLE devices ADD COLUMN approved_at INTEGER;
UPDATE devices SET approved_at = enrolled_at WHERE status = 'active';

-- Per-device sync status reported by the device on every push.
ALTER TABLE devices ADD COLUMN last_push_at INTEGER;
ALTER TABLE devices ADD COLUMN pending_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN last_error TEXT;
ALTER TABLE devices ADD COLUMN client_version TEXT;
-- (server time - device time) at the last push; used to put every device on the server's clock.
ALTER TABLE devices ADD COLUMN clock_skew_ms INTEGER NOT NULL DEFAULT 0;

-- Sessions: conflict resolution uses a per-session revision counter, never the device's wall clock;
-- start_ts_adj is the device start time corrected by the device's measured clock skew.
ALTER TABLE sessions ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN start_ts_adj INTEGER;
UPDATE sessions SET start_ts_adj = start_ts;
CREATE INDEX idx_sessions_adj ON sessions(start_ts_adj);
CREATE INDEX idx_sessions_dev_adj ON sessions(device_id, start_ts_adj);

-- Owner-level settings (e.g. server_retention_days).
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
