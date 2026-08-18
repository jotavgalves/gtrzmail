PRAGMA foreign_keys = ON;

-- New inbound messages keep a compact encrypted body for fast reading while
-- the original encrypted RFC822 source can live in an optional sidecar.
ALTER TABLE messages ADD COLUMN raw_r2_key TEXT;
ALTER TABLE messages ADD COLUMN raw_body_iv TEXT;

-- Hot paths used by inbox, unread counters and thread views.
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_folder_read_date
  ON messages(mailbox_id, folder, is_read, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread_folder_date
  ON messages(thread_id, folder, received_at DESC);
