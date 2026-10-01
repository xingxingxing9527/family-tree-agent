import type { WorkspaceDatabase } from "../open-database.js";

export class FactSourceLinkRepository {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}

  link(entityType: string, entityId: string, sourceId: string, operationGroupId: string): void {
    this.database.prepare(`
      INSERT INTO fact_source_link (
        workspace_id, entity_type, entity_id, source_id, operation_group_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, entity_type, entity_id, source_id) DO NOTHING
    `).run(this.workspaceId, entityType, entityId, sourceId, operationGroupId, new Date().toISOString());
  }
}
