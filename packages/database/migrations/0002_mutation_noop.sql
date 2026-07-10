ALTER TABLE drawing_mutations
  DROP CONSTRAINT drawing_mutations_resulting_revision_valid;

ALTER TABLE drawing_mutations
  ADD CONSTRAINT drawing_mutations_resulting_revision_valid
  CHECK (resulting_revision >= base_revision);
