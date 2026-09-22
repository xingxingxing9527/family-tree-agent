import { randomUUID } from "node:crypto";
import type { TransactionContext } from "../unit-of-work.js";
import type { WorkspaceDatabase } from "../open-database.js";

export interface ImportIdentityRecord {
  id: string;
  workspaceId: string;
  sourceId: string | null;
  sourceKey: string;
  externalPersonId: string;
  personId: string;
  rawJson: string | null;
  rowVersion: number;
}

interface ImportIdentityRow {
  id: string;
  workspace_id: string;
  source_id: string | null;
  source_key: string;
  external_person_id: string;
  person_id: string;
  raw_json: string | null;
  row_version: number;
}

const record = (row: ImportIdentityRow): ImportIdentityRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  sourceId: row.source_id,
  sourceKey: row.source_key,
  externalPersonId: row.external_person_id,
  personId: row.person_id,
  rawJson: row.raw_json,
  rowVersion: row.row_version
});

export class ImportIdentityRepository {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}

  get(sourceKey: string, externalPersonId: string): ImportIdentityRecord | null {
    const row = this.database.prepare(`
      SELECT id, workspace_id, source_id, source_key, external_person_id, person_id, raw_json, row_version
      FROM import_identity
      WHERE workspace_id = ? AND source_key = ? AND external_person_id = ? AND deleted_at IS NULL
    `).get(this.workspaceId, sourceKey, externalPersonId) as ImportIdentityRow | undefined;
    return row ? record(row) : null;
  }

  create(ctx: TransactionContext, input: { sourceId: string; sourceKey: string; externalPersonId: string; personId: string; raw: unknown }): ImportIdentityRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO import_identity (id, workspace_id, source_id, source_key, external_person_id, person_id, raw_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, this.workspaceId, input.sourceId, input.sourceKey, input.externalPersonId, input.personId, JSON.stringify(input.raw), now, now);
    const after = this.get(input.sourceKey, input.externalPersonId)!;
    ctx.audit.append({ entityType: "import_identity", entityId: id, action: "create", before: null, after });
    return after;
  }

  update(ctx: TransactionContext, input: { sourceId: string; sourceKey: string; externalPersonId: string; raw: unknown }): ImportIdentityRecord {
    const before = this.get(input.sourceKey, input.externalPersonId);
    if (!before) throw new Error(`Import identity not found: ${input.externalPersonId}`);
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE import_identity SET source_id = ?, raw_json = ?, updated_at = ?, row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL
    `).run(input.sourceId, JSON.stringify(input.raw), now, this.workspaceId, before.id);
    const after = this.get(input.sourceKey, input.externalPersonId)!;
    ctx.audit.append({ entityType: "import_identity", entityId: before.id, action: "update", before, after });
    return after;
  }
}
