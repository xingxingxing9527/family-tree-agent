export const mergeHistoryMigration = {
  version: 2,
  name: "merge history",
  sql: String.raw`
    ALTER TABLE merge_record ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed'));
    ALTER TABLE merge_record ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE merge_record ADD COLUMN post_versions_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE merge_record ADD COLUMN reversed_operation_group_id TEXT;
  `
} as const;
