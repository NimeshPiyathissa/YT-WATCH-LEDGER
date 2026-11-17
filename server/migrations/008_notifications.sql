-- Notification Center (in-dashboard only). Additive: nothing existing is changed.
-- One row per condition while it lasts: dedupe_key names the condition ("dev:<id>:pending", "backup:stale"), and at most one UNRESOLVED
-- row per key exists, so a condition notifies once however often it is evaluated. A condition that ends is marked resolved (kept as
-- history until the owner's retention removes it); if it comes back it is a new notification.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL, dedupe_key TEXT NOT NULL,
  device_id TEXT, title TEXT NOT NULL, body TEXT,
  created_at INTEGER NOT NULL, read_at INTEGER, dismissed_at INTEGER, resolved_at INTEGER,
  FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_notif_open ON notifications(admin_id, dedupe_key) WHERE resolved_at IS NULL;
CREATE INDEX idx_notif_list ON notifications(admin_id, resolved_at, created_at);
