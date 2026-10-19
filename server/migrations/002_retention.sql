-- Mirrors the device's own retention setting: set when the device acknowledges a set_retention command.
ALTER TABLE devices ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 0;
