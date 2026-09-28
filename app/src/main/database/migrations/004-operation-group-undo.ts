export const operationGroupUndoMigration = {
  version: 4,
  name: "operation group undo state",
  sql: String.raw`
    ALTER TABLE operation_group ADD COLUMN undone_at TEXT;
    CREATE INDEX operation_group_history_idx
      ON operation_group(workspace_id, created_at DESC, id DESC);
  `
} as const;
