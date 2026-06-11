-- Outlook-style email pinning.
--
-- A pin keeps a message at the top of its folder for THAT user only.
-- `email_key` is the client-side message identifier:
--   - inbox messages: the IMAP UID (stable per mailbox)
--   - sent/drafts:    the sent_emails row UUID
-- Stored server-side (not localStorage) so pins survive refreshes, browser
-- changes, and follow the user across machines.

CREATE TABLE IF NOT EXISTS email_pins (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_key TEXT NOT NULL,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, email_key)
);

CREATE INDEX IF NOT EXISTS idx_email_pins_user ON email_pins(user_id);
