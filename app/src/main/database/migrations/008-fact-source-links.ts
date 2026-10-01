export const factSourceLinksMigration = {
  version: 8,
  name: "fact source links",
  sql: `
    CREATE TABLE fact_source_link (
      workspace_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      operation_group_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, entity_type, entity_id, source_id),
      FOREIGN KEY (source_id) REFERENCES source(id) ON DELETE CASCADE,
      FOREIGN KEY (operation_group_id) REFERENCES operation_group(id) ON DELETE CASCADE
    );

    CREATE INDEX fact_source_link_entity_idx
      ON fact_source_link (workspace_id, entity_type, entity_id);
  `
} as const;
