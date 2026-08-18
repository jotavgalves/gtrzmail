PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS auth_ip_security (
  ip_hash TEXT PRIMARY KEY,
  ip_address TEXT NOT NULL,
  stage INTEGER NOT NULL DEFAULT 1 CHECK (stage IN (1, 2)),
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  captcha_required INTEGER NOT NULL DEFAULT 0 CHECK (captcha_required IN (0, 1)),
  permanently_blocked INTEGER NOT NULL DEFAULT 0 CHECK (permanently_blocked IN (0, 1)),
  blocked_at INTEGER,
  last_failed_at INTEGER,
  last_email TEXT,
  protected_email_hash TEXT,
  mixed_targets INTEGER NOT NULL DEFAULT 0 CHECK (mixed_targets IN (0, 1)),
  verification_lock_until INTEGER NOT NULL DEFAULT 0,
  verification_nonce TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_ip_security_blocked
  ON auth_ip_security(permanently_blocked, blocked_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_ip_security_updated
  ON auth_ip_security(updated_at);

CREATE TABLE IF NOT EXISTS password_reauth_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_hash TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  blocked_until INTEGER NOT NULL DEFAULT 0,
  verification_lock_until INTEGER NOT NULL DEFAULT 0,
  verification_nonce TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ip_hash)
);

CREATE INDEX IF NOT EXISTS idx_password_reauth_limits_updated
  ON password_reauth_limits(updated_at);
