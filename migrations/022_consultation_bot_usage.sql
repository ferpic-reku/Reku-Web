-- Anti-abuse metadata only: no messages, audio, clinical data or report content.
CREATE TABLE IF NOT EXISTS consultation_bot_usage (
  appointment_id BIGINT PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  audio_count INTEGER NOT NULL DEFAULT 0 CHECK (audio_count >= 0),
  active_request_hash TEXT,
  active_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
