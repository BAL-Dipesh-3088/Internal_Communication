-- Login audit trail — one row per successful credential login to the ICP portal.
-- Powers Admin Panel → "Users Login" (who signed in, when, from where).
-- Distinct from admin_audit_logs (that records admin operations, not user sign-ins).
-- NEVER stores passwords or tokens.

CREATE TABLE IF NOT EXISTS login_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address VARCHAR(45),          -- real client IP (X-Forwarded-For via nginx)
  user_agent TEXT                  -- raw UA string; parsed to browser/OS at read time
);

-- Date-range queries (Today / Last 7 days / …) scan by time, newest first.
CREATE INDEX IF NOT EXISTS idx_login_events_time ON login_events(logged_in_at DESC);
-- Per-user lookups (login count / last login).
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id);
