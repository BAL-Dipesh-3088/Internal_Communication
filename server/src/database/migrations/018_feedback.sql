-- User feedback, submitted from the login page ("Give feedback").
-- Stored in-app and reviewed in Admin Panel → Feedback (replaces the earlier
-- behaviour of emailing every admin).

CREATE TABLE IF NOT EXISTS feedback (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mood       VARCHAR(10),          -- emoji from the mood picker (optional)
  category   VARCHAR(40),          -- 'Login issue' / 'Bug report' / ...
  message    TEXT NOT NULL,
  name       VARCHAR(100),         -- optional, 'Anonymous' allowed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
