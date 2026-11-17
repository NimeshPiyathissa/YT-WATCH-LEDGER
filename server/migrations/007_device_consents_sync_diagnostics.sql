-- v0.8.0-beta.1. Purely additive: no existing column or row is rewritten, every new column has a default that preserves the
-- behaviour a v0.7.0 database had, and a v0.7.0 extension (which reports none of this) keeps working.
--
-- Consent states are REPORTED BY THE DEVICE; the server never sets them and the owner cannot change them.
--   live_view        0 = the person at the device has not allowed live viewing (the default for every existing device)
--   consent_tracking / consent_detail   NULL = not reported yet (an older extension); otherwise 0 or 1
ALTER TABLE devices ADD COLUMN live_view INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN live_view_at INTEGER;
ALTER TABLE devices ADD COLUMN consent_tracking INTEGER;
ALTER TABLE devices ADD COLUMN consent_detail INTEGER;
-- What the device says about its own upload queue.
ALTER TABLE devices ADD COLUMN queue_events INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN queue_dropped INTEGER NOT NULL DEFAULT 0;   -- events kept on the device only because its queue hit its limit

-- A short history of what a device reported going wrong (newest first), capped per device by the application.
CREATE TABLE device_sync_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL, at INTEGER NOT NULL,
  kind TEXT NOT NULL,                                -- network | server | auth | rejected | quota | other
  message TEXT NOT NULL,                             -- the device's own message, truncated; never a credential
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX idx_dse_device_time ON device_sync_errors(device_id, at DESC);
