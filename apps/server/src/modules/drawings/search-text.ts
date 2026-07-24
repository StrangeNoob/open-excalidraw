import type { PoolClient } from "pg";

/**
 * Rebuilds a drawing's full-text search row from its current scene. Call this
 * inside the same transaction as, and immediately after, every statement that
 * writes drawings.scene, so search reads a side table instead of scanning scene
 * jsonb at query time.
 *
 * The extraction is identical in shape to migration 0015's backfill (keep them
 * in sync): visible text of non-deleted elements — text elements' "text" plus
 * frame/magicFrame names — string_agg'd, with a jsonb_typeof guard so a scene
 * whose "elements" is missing or not an array yields '' rather than erroring.
 *
 * The DO UPDATE's WHERE makes an unchanged save write nothing — no row update,
 * no generated-tsvector recompute, updated_at untouched — which is the
 * write-amplification defense against idle collab sessions re-saving identical
 * scenes.
 *
 * ponytail: one jsonb scan per scene write, including the collab hot path. If
 * profiling ever shows it hot, gate this call behind a staleness check or
 * piggyback it on checkpointDue at the collab persistence site.
 */
const UPSERT_SEARCH_TEXT = `
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
  FROM drawings d
  WHERE d.id = $1
  ON CONFLICT (drawing_id) DO UPDATE
    SET extracted_text = EXCLUDED.extracted_text, updated_at = now()
    WHERE drawing_search_texts.extracted_text <> EXCLUDED.extracted_text
`;

export async function updateDrawingSearchText(
  client: Pick<PoolClient, "query">,
  drawingId: string,
): Promise<void> {
  await client.query(UPSERT_SEARCH_TEXT, [drawingId]);
}
