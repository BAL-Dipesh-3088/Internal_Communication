-- Meeting reminders — how many minutes before start_time the attendee gets a
-- Teams-style "your meeting is starting" popup. 0 = no reminder. Default 15
-- matches Teams/Outlook. Reminders are delivered client-side (the app schedules
-- the popup from GET /calendar/reminders/upcoming), so no server scheduler.

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS reminder_minutes INTEGER NOT NULL DEFAULT 15;
