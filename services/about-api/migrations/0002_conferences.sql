-- Public conference facts only. Source HTML is never retained.
CREATE TABLE IF NOT EXISTS conference_records (
  id TEXT PRIMARY KEY CHECK (id IN ('cvpr', 'icml', 'iccv', 'neurips', 'aaai', 'iclr', 'eccv')),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  checked_at TEXT,
  verified_at TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1))
);
