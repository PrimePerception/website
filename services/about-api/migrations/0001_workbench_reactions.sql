-- Only sanitized minute aggregates and anonymous reaction data belong in this database.
CREATE TABLE workbench_samples (
  minute INTEGER PRIMARY KEY,
  utilization_percent REAL CHECK(utilization_percent IS NULL OR utilization_percent BETWEEN 0 AND 100)
) STRICT;

CREATE TABLE workbench_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  tracking_started_at INTEGER,
  last_success_at INTEGER,
  last_attempt_at INTEGER
) STRICT;
INSERT INTO workbench_meta(singleton) VALUES(1);

CREATE TABLE reaction_totals (
  kind TEXT PRIMARY KEY CHECK(kind IN ('gg', 'touch-grass', 'shower', 'league')),
  total INTEGER NOT NULL DEFAULT 0 CHECK(total >= 0)
) STRICT;
INSERT INTO reaction_totals(kind) VALUES('gg'), ('touch-grass'), ('shower'), ('league');

CREATE TABLE reaction_events (
  visitor TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL REFERENCES reaction_totals(kind),
  created_at INTEGER NOT NULL,
  utc_day INTEGER NOT NULL,
  PRIMARY KEY(visitor, request_id)
) STRICT;
CREATE INDEX reaction_limits ON reaction_events(visitor, kind, utc_day, created_at);

-- The INSERT is conditional; this trigger and the inserted event are one SQLite transaction.
CREATE TRIGGER increment_reaction AFTER INSERT ON reaction_events BEGIN
  UPDATE reaction_totals SET total = total + 1 WHERE kind = NEW.kind;
END;
