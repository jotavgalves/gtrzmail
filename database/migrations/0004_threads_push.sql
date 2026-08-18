PRAGMA foreign_keys = ON;

ALTER TABLE messages ADD COLUMN thread_id TEXT;
UPDATE messages SET thread_id = id WHERE thread_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
