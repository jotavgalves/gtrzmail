PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN signature_html TEXT NOT NULL DEFAULT '';
