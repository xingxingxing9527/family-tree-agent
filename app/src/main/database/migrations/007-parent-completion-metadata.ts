export const parentCompletionMetadataMigration = {
  version: 7,
  name: "parent completion metadata",
  sql: String.raw`
    ALTER TABLE parent_child ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'explicit' CHECK (origin_kind IN ('explicit', 'spouse_default'));
    ALTER TABLE parent_child ADD COLUMN inferred_from_marriage_id TEXT REFERENCES marriage(id);

    CREATE INDEX parent_child_inferred_marriage_idx
      ON parent_child(workspace_id, inferred_from_marriage_id)
      WHERE inferred_from_marriage_id IS NOT NULL;
  `
} as const;
