PRAGMA foreign_keys = ON;

-- A login counter must survive normal IPv6 privacy-address rotation and normal
-- network changes made by the same browser. Only hashes are stored here.
CREATE TABLE IF NOT EXISTS auth_identity_aliases (
  alias_hash TEXT PRIMARY KEY,
  canonical_hash TEXT NOT NULL,
  alias_kind TEXT NOT NULL CHECK (alias_kind IN ('network', 'device')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_identity_aliases_canonical
  ON auth_identity_aliases(canonical_hash, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_identity_aliases_updated
  ON auth_identity_aliases(updated_at);
