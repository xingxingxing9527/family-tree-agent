import { randomUUID } from "node:crypto";
import type { TransactionContext } from "../unit-of-work.js";
import type { WorkspaceDatabase } from "../open-database.js";
import type { ReadOptions } from "./person-repository.js";

export interface SourceRecord {
  id: string; workspaceId: string; sourceKey: string; title: string; kind: string | null;
  uri: string | null; citation: string | null; notes: string | null; createdAt: string;
  updatedAt: string; deletedAt: string | null; rowVersion: number;
}
export interface CreateSourceInput {
  id?: string; sourceKey: string; title: string; kind?: string | null; uri?: string | null;
  citation?: string | null; notes?: string | null;
}
export type UpdateSourceInput = Partial<Omit<CreateSourceInput, "id">>;
interface SourceRow {
  id: string; workspace_id: string; source_key: string; title: string; kind: string | null;
  uri: string | null; citation: string | null; notes: string | null; created_at: string;
  updated_at: string; deleted_at: string | null; row_version: number;
}
const toRecord = (row: SourceRow): SourceRecord => ({ id: row.id, workspaceId: row.workspace_id, sourceKey: row.source_key, title: row.title, kind: row.kind, uri: row.uri, citation: row.citation, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, rowVersion: row.row_version });

export class SourceRepository {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}
  get(id: string, options: ReadOptions = {}): SourceRecord | null {
    const row = this.database.prepare(`SELECT * FROM source WHERE workspace_id = ? AND id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"}`).get(this.workspaceId, id) as SourceRow | undefined;
    return row ? toRecord(row) : null;
  }
  list(options: ReadOptions = {}): SourceRecord[] {
    return (this.database.prepare(`SELECT * FROM source WHERE workspace_id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"} ORDER BY title, id`).all(this.workspaceId) as SourceRow[]).map(toRecord);
  }
  create(ctx: TransactionContext, input: CreateSourceInput): SourceRecord {
    const id = input.id ?? randomUUID(); const now = new Date().toISOString();
    this.database.prepare("INSERT INTO source (id, workspace_id, source_key, title, kind, uri, citation, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, this.workspaceId, input.sourceKey, input.title, input.kind ?? null, input.uri ?? null, input.citation ?? null, input.notes ?? null, now, now);
    const after = this.require(id, true); ctx.audit.append({ entityType: "source", entityId: id, action: "create", before: null, after }); return after;
  }
  update(ctx: TransactionContext, id: string, input: UpdateSourceInput): SourceRecord {
    const before = this.require(id, false); const now = new Date().toISOString();
    this.database.prepare("UPDATE source SET source_key = ?, title = ?, kind = ?, uri = ?, citation = ?, notes = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").run(input.sourceKey ?? before.sourceKey, input.title ?? before.title, input.kind === undefined ? before.kind : input.kind, input.uri === undefined ? before.uri : input.uri, input.citation === undefined ? before.citation : input.citation, input.notes === undefined ? before.notes : input.notes, now, this.workspaceId, id);
    const after = this.require(id, false); ctx.audit.append({ entityType: "source", entityId: id, action: "update", before, after }); return after;
  }
  archive(ctx: TransactionContext, id: string): SourceRecord { return this.setArchived(ctx, id, true); }
  restore(ctx: TransactionContext, id: string): SourceRecord { return this.setArchived(ctx, id, false); }
  private setArchived(ctx: TransactionContext, id: string, archived: boolean): SourceRecord {
    const before = this.require(id, true);
    if ((before.deletedAt !== null) === archived) throw new Error(`Source archive state unchanged: ${id}`);
    const now = new Date().toISOString();
    this.database.prepare("UPDATE source SET deleted_at = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ?").run(archived ? now : null, now, this.workspaceId, id);
    const after = this.require(id, true); ctx.audit.append({ entityType: "source", entityId: id, action: archived ? "archive" : "restore", before, after }); return after;
  }
  private require(id: string, includeArchived: boolean): SourceRecord { const row = this.get(id, { includeArchived }); if (!row) throw new Error(`Source not found: ${id}`); return row; }
}
