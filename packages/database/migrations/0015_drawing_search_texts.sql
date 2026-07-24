-- Full-text search over drawing content. A side table holds the visible canvas
-- text of each drawing's current scene, maintained on every scene write; search
-- reads it instead of scanning scene jsonb at query time. The tsvector is a
-- generated column so Postgres keeps it in sync with extracted_text, and the
-- per-scene extraction below is the same shape the runtime upsert reuses
-- (apps/server .../drawings/search-text.ts) — keep them identical.
CREATE TABLE drawing_search_texts (
  drawing_id UUID PRIMARY KEY REFERENCES drawings (id) ON DELETE CASCADE,
  extracted_text TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'simple' regconfig: drawing labels are arbitrary-language, so no stemming
  -- beats stemming the wrong language. left() bounds the tsvector work.
  search_tsv TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('simple', left(extracted_text, 300000)))
    STORED
);

CREATE INDEX drawing_search_texts_search_tsv_idx
  ON drawing_search_texts USING GIN (search_tsv);

-- Backfill every existing drawing, trashed included. A scene whose 'elements'
-- is missing or not an array yields '' (the CASE substitutes an empty array)
-- so a malformed scene never fails the migration.
INSERT INTO drawing_search_texts (drawing_id, extracted_text)
SELECT
  d.id,
  COALESCE(
    (
      SELECT string_agg(
        CASE
          WHEN el ->> 'type' = 'text' THEN left(el ->> 'text', 10000)
          ELSE left(el ->> 'name', 1000)
        END,
        ' '
      )
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(d.scene -> 'elements') = 'array'
            THEN d.scene -> 'elements'
          ELSE '[]'::jsonb
        END
      ) AS el
      WHERE el ->> 'isDeleted' IS DISTINCT FROM 'true'
        AND (
          el ->> 'type' = 'text'
          OR el ->> 'type' IN ('frame', 'magicFrame')
        )
    ),
    ''
  )
-- Backfill every drawing, trashed included: the search query filters
-- deleted_at itself, purge cascades the row away, and a restored drawing
-- must be searchable without waiting for its next edit.
FROM drawings d;
