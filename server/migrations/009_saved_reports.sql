-- Reports Studio: the owner's saved report configurations. Additive: nothing existing is changed.
-- enc holds { name, spec } encrypted like every other record (a spec can name a channel or a video, which are stored encrypted elsewhere).
CREATE TABLE saved_reports (
  id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, enc BLOB NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE CASCADE
);
CREATE INDEX idx_saved_reports ON saved_reports(admin_id, updated_at);
