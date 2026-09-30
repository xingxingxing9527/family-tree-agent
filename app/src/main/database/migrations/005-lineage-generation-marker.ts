export const lineageGenerationMarkerMigration = {
  version: 5,
  name: "lineage membership generation marker",
  sql: String.raw`
    ALTER TABLE lineage_membership
      ADD COLUMN generation_marker TEXT
      CHECK (
        generation_marker IS NULL
        OR (length(trim(generation_marker)) BETWEEN 1 AND 50)
      );
  `
} as const;
