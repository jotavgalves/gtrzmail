PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS request_rate_limits (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_request_rate_limits_window ON request_rate_limits(window_started_at);
