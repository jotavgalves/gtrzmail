PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1));
UPDATE users
SET is_admin = 1
WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1);

ALTER TABLE messages ADD COLUMN previous_folder TEXT;
ALTER TABLE messages ADD COLUMN html_r2_key TEXT;
ALTER TABLE messages ADD COLUMN html_body_iv TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_user_state ON messages(folder, is_read, is_starred, received_at DESC);
