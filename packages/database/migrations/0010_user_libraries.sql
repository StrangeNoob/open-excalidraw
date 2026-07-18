-- Per-account shape library. One row per user holds their .excalidrawlib
-- items as a single JSONB blob; last write wins, no revisions.
CREATE TABLE user_libraries (
  user_id UUID PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  items JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
