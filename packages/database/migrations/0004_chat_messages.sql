CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_id UUID NOT NULL REFERENCES drawings (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_body_length CHECK (char_length(body) BETWEEN 1 AND 4000)
);

CREATE INDEX chat_messages_drawing_created_idx
  ON chat_messages (drawing_id, created_at DESC, id DESC);
