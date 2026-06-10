-- Phase A — Online meeting integration for calendar events
--
-- Adds:
--   1. `is_online_meeting` flag on calendar_events
--   2. `livekit_call_id` link from event → call_history row that backs the meeting
--   3. `calendar_event_id` reverse link from call_history → event
--   4. 'scheduled' status added to call_history.status enum
--      (used for meetings that exist in the calendar but haven't started yet —
--       the room is dormant in LiveKit until first participant joins)
--
-- Rationale: meeting links must be predictable BEFORE the meeting starts
-- (so the .ics invite emails carry a real, working link). We pre-create the
-- call_history row at event-creation time but defer actual LiveKit room
-- creation until the first participant joins (LiveKit auto-creates on first
-- publisher anyway). This avoids cluttering LiveKit with idle rooms for
-- meetings scheduled days/weeks in advance.

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS is_online_meeting BOOLEAN NOT NULL DEFAULT false;

-- Forward link: event → its associated call_history row. NULL when not an online meeting.
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS livekit_call_id UUID;

-- iCalendar SEQUENCE counter: increments on every update so recipient
-- calendars (Outlook etc.) know to replace the previous version rather than
-- treating it as a duplicate. Starts at 0 for new events.
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS ical_sequence INTEGER NOT NULL DEFAULT 0;

-- Reverse link: call_history → event (NULL for ad-hoc conversation calls)
ALTER TABLE call_history
  ADD COLUMN IF NOT EXISTS calendar_event_id UUID;

-- Add foreign keys with ON DELETE SET NULL so deleting one side doesn't
-- cascade-delete the other (we want history preserved for audit).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_calendar_events_livekit_call'
  ) THEN
    ALTER TABLE calendar_events
      ADD CONSTRAINT fk_calendar_events_livekit_call
        FOREIGN KEY (livekit_call_id) REFERENCES call_history(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_call_history_calendar_event'
  ) THEN
    ALTER TABLE call_history
      ADD CONSTRAINT fk_call_history_calendar_event
        FOREIGN KEY (calendar_event_id) REFERENCES calendar_events(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Add 'scheduled' to the status CHECK constraint.
-- (We must drop the old one and re-create — PostgreSQL doesn't support ALTER CHECK.)
ALTER TABLE call_history DROP CONSTRAINT IF EXISTS call_history_status_check;
ALTER TABLE call_history
  ADD CONSTRAINT call_history_status_check
    CHECK (status IN ('initiated', 'ringing', 'answered', 'ended', 'missed', 'rejected', 'failed', 'scheduled'));

-- Indexes for the new lookups
CREATE INDEX IF NOT EXISTS idx_calendar_events_livekit_call
  ON calendar_events(livekit_call_id) WHERE livekit_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_history_calendar_event
  ON call_history(calendar_event_id) WHERE calendar_event_id IS NOT NULL;
