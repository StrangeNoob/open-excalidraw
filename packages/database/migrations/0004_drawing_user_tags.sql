-- Per-user private tags on drawings. Tags are personal organisation: each
-- user sees only their own tags, on owned and shared drawings alike.
CREATE TABLE drawing_user_tags (
  drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  tag VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drawing_user_tags_pkey PRIMARY KEY (drawing_id, user_id, tag),
  CONSTRAINT drawing_user_tags_tag_normalized
    CHECK (tag = lower(btrim(tag)) AND char_length(tag) BETWEEN 1 AND 32)
);

CREATE INDEX drawing_user_tags_user_id_idx ON drawing_user_tags (user_id);
