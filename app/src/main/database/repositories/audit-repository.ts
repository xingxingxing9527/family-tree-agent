import { randomUUID } from "node:crypto";
import type { WorkspaceDatabase } from "../open-database.js";

export interface AuditAppendInput {
  entityType: string;
  entityId: string;
  action: string;
  before: unknown | null;
  after: unknown | null;
}

export interface AuditRecord {
  id: string;
  workspaceId: string;
  operationGroupId: string;
  entityType: string;
  entityId: string;
  action: string;
  before: unknown | null;
  after: unknown | null;
  createdAt: string;
}

interface AuditRow {
  id: string;
  workspace_id: string;
  operation_group_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

const parseJson = (value: string | null): unknown | null => value === null ? null : JSON.parse(value);

export class AuditRepository {
  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly workspaceId: string,
    private readonly operationGroupId: string
  ) {}

  append(input: AuditAppendInput): AuditRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO audit_log (
        id, workspace_id, operation_group_id, entity_type, entity_id, action,
        before_json, after_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      this.workspaceId,
      this.operationGroupId,
      input.entityType,
      input.entityId,
      input.action,
      input.before === null ? null : JSON.stringify(input.before),
      input.after === null ? null : JSON.stringify(input.after),
      now,
      now
    );
    return { id, workspaceId: this.workspaceId, operationGroupId: this.operationGroupId, ...input, createdAt: now };
  }

  list(): AuditRecord[] {
    return (this.database.prepare(`
      SELECT id, workspace_id, operation_group_id, entity_type, entity_id, action,
             before_json, after_json, created_at
      FROM audit_log WHERE workspace_id = ? ORDER BY created_at, id
    `).all(this.workspaceId) as AuditRow[]).map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      operationGroupId: row.operation_group_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      before: parseJson(row.before_json),
      after: parseJson(row.after_json),
      createdAt: row.created_at
    }));
  }
}
