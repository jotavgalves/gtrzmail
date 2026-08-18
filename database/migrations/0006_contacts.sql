PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  notes TEXT NOT NULL DEFAULT '',
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contact_emails (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'E-mail',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, email)
);

CREATE INDEX IF NOT EXISTS idx_contacts_user_favorite_name
  ON contacts(user_id, is_favorite DESC, display_name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_contact_emails_user_email
  ON contact_emails(user_id, email COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_contact_emails_contact
  ON contact_emails(contact_id, is_primary DESC, created_at ASC);
