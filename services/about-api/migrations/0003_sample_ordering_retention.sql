-- Keep collection order distinct from the chart's minute bucket.
ALTER TABLE workbench_samples ADD COLUMN collected_at INTEGER NOT NULL DEFAULT 0;
UPDATE workbench_samples SET collected_at = minute WHERE collected_at = 0;
CREATE INDEX reaction_event_retention ON reaction_events(created_at);
