-- In-call chat messages (Teams-style chat inside a group meeting)
--
-- Persisted to the DB so late joiners can see prior messages, and so chat
-- transcripts survive after the call ends (useful for compliance / minutes).
-- Real-time delivery to currently-connected participants uses LiveKit's data
-- channel (useChat hook on the client) — this table is the canonical store.

CREATE TABLE IF NOT EXISTS call_chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Which call this message belongs to. Cascade delete: if a call is purged,
  -- its chat is purged with it.
  call_id UUID NOT NULL REFERENCES call_history(id) ON DELETE CASCADE,

  -- Sender. Set NULL if the user is later deleted so chat history is preserved
  -- but unattributed. sender_display_name keeps the name visible in that case.
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sender_display_name VARCHAR(255) NOT NULL,

  -- Client-generated UUID used for deduplication between the LiveKit data-channel
  -- delivery and the DB hydration path on late join. The client sends the same
  -- clientMsgId both via useChat.send() AND via POST /chat, so receivers can
  -- recognise the same logical message arriving from two sources.
  client_msg_id UUID NOT NULL,

  content TEXT NOT NULL CHECK (length(content) > 0 AND length(content) <= 4000),

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Fast history fetch on join: SELECT WHERE call_id = $1 ORDER BY created_at ASC
CREATE INDEX IF NOT EXISTS idx_call_chat_messages_call_time
  ON call_chat_messages(call_id, created_at);

-- Prevent double-persist if the same client retries a POST
CREATE UNIQUE INDEX IF NOT EXISTS uniq_call_chat_client_msg_id
  ON call_chat_messages(call_id, client_msg_id);
