-- Device sessions: the long-lived device credential moves out of `devices` into its own table, so each pairing is a
-- session that can be listed, revoked and (on the device's request, with the owner's approval) deleted on its own.
CREATE TABLE device_sessions (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active|revoked
  created_at INTEGER NOT NULL, last_seen INTEGER, ip TEXT, client_version TEXT,
  revoked_at INTEGER, revoked_reason TEXT, -- admin_revoked|device_revoked|deletion_approved|replaced
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_dsess_token ON device_sessions(token_hash);
CREATE INDEX idx_dsess_device ON device_sessions(device_id, status);

-- Every existing device keeps working: its current credential becomes its first session.
INSERT INTO device_sessions(id,device_id,token_hash,status,created_at,last_seen,client_version,revoked_at,revoked_reason)
  SELECT lower(hex(randomblob(16))), id, token_hash, CASE WHEN status='revoked' THEN 'revoked' ELSE 'active' END,
         enrolled_at, last_seen, client_version,
         CASE WHEN status='revoked' THEN COALESCE(last_seen, enrolled_at) END,
         CASE WHEN status='revoked' THEN 'device_revoked' END
  FROM devices;
DROP INDEX idx_devices_token;
ALTER TABLE devices DROP COLUMN token_hash;

-- Pairing history: codes are kept (hashed) after use or expiry, with the device that redeemed them.
ALTER TABLE enroll_codes ADD COLUMN id TEXT;
UPDATE enroll_codes SET id = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX idx_enroll_codes_id ON enroll_codes(id);
ALTER TABLE enroll_codes ADD COLUMN created_at INTEGER;
UPDATE enroll_codes SET created_at = expires_at - 15 * 60 * 1000;
ALTER TABLE enroll_codes ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enroll_codes ADD COLUMN device_id TEXT;
ALTER TABLE enroll_codes ADD COLUMN session_id TEXT;
ALTER TABLE enroll_codes ADD COLUMN revoked_at INTEGER;
ALTER TABLE enroll_codes ADD COLUMN used_ip TEXT;

-- Session deletion requests: a device may only ASK for its session to be deleted; the owner approves or denies.
CREATE TABLE session_deletion_requests (
  id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, device_id TEXT NOT NULL, session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|denied|cancelled
  reason TEXT, requested_at INTEGER NOT NULL, request_ip TEXT,
  decided_at INTEGER, decided_by TEXT, decision_note TEXT,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY(session_id) REFERENCES device_sessions(id) ON DELETE CASCADE
);
-- At most one open request per session: a double click or a retried request can never create a second one.
CREATE UNIQUE INDEX idx_sdr_one_pending ON session_deletion_requests(session_id) WHERE status='pending';
CREATE INDEX idx_sdr_admin ON session_deletion_requests(admin_id, status, requested_at);
