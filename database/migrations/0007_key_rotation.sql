PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS key_rotation_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_slot TEXT NOT NULL DEFAULT 'A' CHECK (active_slot IN ('A', 'B')),
  active_version INTEGER NOT NULL DEFAULT 1,
  target_slot TEXT CHECK (target_slot IN ('A', 'B')),
  target_version INTEGER,
  phase TEXT NOT NULL DEFAULT 'stable' CHECK (phase IN ('stable', 'rewrapping')),
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO key_rotation_state (
  id, active_slot, active_version, target_slot, target_version, phase,
  started_at, completed_at, updated_at
) VALUES (1, 'A', 1, NULL, NULL, 'stable', NULL, NULL, unixepoch());
