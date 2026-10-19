CREATE TABLE admins (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, revoked INTEGER DEFAULT 0, created_at INTEGER NOT NULL,
  FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE CASCADE
);
CREATE INDEX idx_refresh_hash ON refresh_tokens(token_hash);
CREATE TABLE enroll_codes (
  code_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL, label TEXT,
  expires_at INTEGER NOT NULL, used_at INTEGER,
  FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE CASCADE
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, label TEXT, install_id TEXT,
  platform TEXT, token_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', -- active|revoked
  enrolled_at INTEGER NOT NULL, last_seen INTEGER,
  FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE CASCADE
);
CREATE INDEX idx_devices_admin ON devices(admin_id);
CREATE UNIQUE INDEX idx_devices_token ON devices(token_hash);
-- watch data is per-device; `enc` holds AES-256-GCM ciphertext of the JSON record
CREATE TABLE videos (
  device_id TEXT NOT NULL, video_id TEXT NOT NULL, enc BLOB NOT NULL,
  last_watched INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, video_id),
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE TABLE sessions (
  device_id TEXT NOT NULL, session_id TEXT NOT NULL, enc BLOB NOT NULL,
  video_id TEXT NOT NULL, start_ts INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, session_id),
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX idx_sessions_dev_vid ON sessions(device_id, video_id);
CREATE TABLE commands (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|acked
  result TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, acked_at INTEGER,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX idx_commands_dev ON commands(device_id, status);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, admin_id TEXT, device_id TEXT, action TEXT NOT NULL,
  detail TEXT, ip TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_admin ON audit_log(admin_id, created_at);
