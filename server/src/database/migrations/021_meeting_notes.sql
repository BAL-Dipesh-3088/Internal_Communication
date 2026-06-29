-- ============================================
-- 021: Meeting transcription & AI auto-notes
-- ============================================
-- Opt-in per meeting (the creator enables it). Stores the egress→Whisper→Qwen
-- pipeline state and the generated notes. One row per recorded meeting.

CREATE TABLE IF NOT EXISTS meeting_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- The group call this belongs to (call_history.id). Nullable so a row survives
  -- if the call record is later purged.
  call_id UUID REFERENCES call_history(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  room_name VARCHAR(64) NOT NULL,
  host_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(300),
  -- LiveKit egress job id (so the egress webhook can find this row).
  egress_id VARCHAR(128),
  -- Path/key of the recorded audio (shared egress volume).
  audio_path VARCHAR(1000),
  -- Pipeline state machine.
  status VARCHAR(20) NOT NULL DEFAULT 'recording'
    CHECK (status IN ('recording','transcribing','summarizing','completed','failed','no_audio')),
  transcript TEXT,
  summary TEXT,
  decisions JSONB DEFAULT '[]',
  action_items JSONB DEFAULT '[]',
  -- Snapshot of attendees (name + email) for the summary header + email delivery.
  attendees JSONB DEFAULT '[]',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_meeting_notes_egress ON meeting_notes(egress_id) WHERE egress_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meeting_notes_room ON meeting_notes(room_name);
CREATE INDEX IF NOT EXISTS idx_meeting_notes_conversation ON meeting_notes(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_notes_call ON meeting_notes(call_id);

-- Opt-in flag carried on the meeting itself. For instant group calls it's set at
-- /start; for scheduled (calendar) online meetings it's set at provision time and
-- egress is started lazily when the first participant joins.
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS transcribe_enabled BOOLEAN NOT NULL DEFAULT false;
