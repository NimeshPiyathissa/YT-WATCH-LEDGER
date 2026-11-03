-- Event-level playback history (v0.7.0). Purely additive: no existing table is rewritten and no row is touched.
-- Sessions recorded before this migration have no events and are shown as "summary only"; nothing is back-filled.
-- Event payloads (position, speed, states, metadata) are AES-GCM encrypted like sessions; the columns that must be
-- queried, ordered or filtered (ids, type, timestamps) stay in the clear. Timestamps are UTC milliseconds.
-- `ts` is the device clock (durations are computed from it); `ts_adj` is `ts` moved onto the server's clock using the
-- skew measured at upload, and is what ordering across devices and every date filter use.
CREATE TABLE video_playback_events (
  device_id TEXT NOT NULL, id TEXT NOT NULL,          -- id = "<sessionId>:e<seq>", stable, so re-sending is a no-op
  session_id TEXT NOT NULL, video_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, ts_adj INTEGER NOT NULL, enc BLOB NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, id),
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX idx_vpe_video_time ON video_playback_events(device_id, video_id, ts_adj);
CREATE INDEX idx_vpe_session_seq ON video_playback_events(device_id, session_id, seq);
CREATE INDEX idx_vpe_type_time ON video_playback_events(device_id, type, ts_adj);

-- One row per recorded viewing session that has events. `enc` holds the folded metrics; everything in it can be rebuilt
-- from the events (see src/lib/videoEvents.js recomputeSession).
CREATE TABLE video_sessions (
  device_id TEXT NOT NULL, session_id TEXT NOT NULL, video_id TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, last_event_at INTEGER NOT NULL,
  state TEXT NOT NULL,                                -- open | ended | interrupted
  completed INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0, skew_ms INTEGER NOT NULL DEFAULT 0,
  enc BLOB NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, session_id),
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX idx_vsess_video ON video_sessions(device_id, video_id, started_at);
CREATE INDEX idx_vsess_time ON video_sessions(started_at);

-- Every pause, in order, never overwritten. resumed_at is NULL while the pause is open or when it is unresolved.
CREATE TABLE video_pause_intervals (
  device_id TEXT NOT NULL, session_id TEXT NOT NULL, n INTEGER NOT NULL, video_id TEXT NOT NULL,
  paused_at INTEGER NOT NULL, resumed_at INTEGER,
  status TEXT NOT NULL,                               -- open | resumed | session_ended | ad_break | unresolved
  duration_ms INTEGER,                                -- NULL unless the end is known
  enc BLOB NOT NULL,                                  -- positions and the known lower bound of an unresolved pause
  PRIMARY KEY(device_id, session_id, n),
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX idx_vpi_video ON video_pause_intervals(device_id, video_id, paused_at);

-- Merged ranges of the video's own timeline that were actually played in a session (skipped content is never in here).
CREATE TABLE video_watch_segments (
  device_id TEXT NOT NULL, session_id TEXT NOT NULL, video_id TEXT NOT NULL, enc BLOB NOT NULL,
  PRIMARY KEY(device_id, session_id),
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX idx_vws_video ON video_watch_segments(device_id, video_id);

-- Per device and video roll-up across sessions, for fast lists.
CREATE TABLE video_analytics (
  device_id TEXT NOT NULL, video_id TEXT NOT NULL, last_event_at INTEGER NOT NULL, enc BLOB NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, video_id),
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);

ALTER TABLE devices ADD COLUMN last_events_at INTEGER;
