import type { WorkspaceDatabase } from "../../database/open-database.js";
import { MergeRepository, type MergeRecord } from "../../database/repositories/merge-repository.js";
import { SqliteUnitOfWork, type TransactionContext } from "../../database/unit-of-work.js";
import type { CanUnmergeResult } from "./merge-types.js";

type Raw = Record<string, unknown>;
const tableFor = (entityType: string): string => entityType;

export class UnmergeService {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}
  canUnmerge(mergeId: string): CanUnmergeResult {
    const record = this.require(mergeId);
    if (record.status !== "active") return { allowed: false, blockingEntityIds: [mergeId], reasons: [{ entityId: mergeId, entityType: "merge_record", expectedVersion: 1, actualVersion: record.rowVersion }] };
    const reasons = record.postVersions.flatMap((expected) => {
      const actual = this.version(expected.entityType, expected.entityId);
      return actual === expected.rowVersion ? [] : [{ entityId: expected.entityId, entityType: expected.entityType, expectedVersion: expected.rowVersion, actualVersion: actual }];
    }).sort((a, b) => a.entityId.localeCompare(b.entityId));
    return { allowed: reasons.length === 0, blockingEntityIds: reasons.map((reason) => reason.entityId), reasons };
  }
  unmerge(mergeId: string): { id: string; status: "reversed"; reversedOperationGroupId: string } {
    const record = this.require(mergeId);
    if (record.status === "reversed") throw new Error("Merge was already reversed");
    const check = this.canUnmerge(mergeId);
    if (!check.allowed) throw new Error("Merge cannot be reversed because affected records changed");
    return new SqliteUnitOfWork(this.database, this.workspaceId).run("person.unmerge", (ctx) => {
      const again = this.canUnmerge(mergeId);
      if (!again.allowed) throw new Error("Merge cannot be reversed because affected records changed");
      for (const [table, rows] of Object.entries(record.snapshot.rows)) {
        for (const snapshot of rows) {
          const id = String(table === "workspace_meta" ? snapshot.workspace_id : snapshot.id);
          const before = this.current(table, id);
          this.restore(table, id, snapshot);
          this.audit(ctx, table, id, "unmerge-restore", before, this.current(table, id));
        }
      }
      const redirect = this.database.prepare("SELECT * FROM id_redirect WHERE workspace_id = ? AND merge_record_id = ?").get(this.workspaceId, mergeId) as Raw | undefined;
      if (!redirect) throw new Error("Merge redirect was not found");
      this.database.prepare("DELETE FROM id_redirect WHERE workspace_id = ? AND id = ?").run(this.workspaceId, redirect.id);
      this.audit(ctx, "id_redirect", String(redirect.id), "unmerge-delete", redirect, null);
      const beforeRecord = this.current("merge_record", mergeId);
      this.database.prepare("UPDATE merge_record SET status = 'reversed', reversed_operation_group_id = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ?")
        .run(ctx.operationGroupId, new Date().toISOString(), this.workspaceId, mergeId);
      this.audit(ctx, "merge_record", mergeId, "unmerge", beforeRecord, this.current("merge_record", mergeId));
      return { id: mergeId, status: "reversed" as const, reversedOperationGroupId: ctx.operationGroupId };
    });
  }
  private require(id: string): MergeRecord { const value = new MergeRepository(this.database, this.workspaceId).get(id); if (!value) throw new Error("Merge record not found"); return value; }
  private version(entityType: string, id: string): number | null { const row = this.current(entityType, id); return row ? Number(row.row_version) : null; }
  private current(table: string, id: string): Raw | null {
    const query = table === "workspace_meta" ? "SELECT * FROM workspace_meta WHERE workspace_id = ?" : `SELECT * FROM ${tableFor(table)} WHERE workspace_id = ? AND id = ?`;
    return (table === "workspace_meta" ? this.database.prepare(query).get(this.workspaceId) : this.database.prepare(query).get(this.workspaceId, id)) as Raw | null;
  }
  private restore(table: string, id: string, snapshot: Raw): void {
    const fields = Object.entries(snapshot).filter(([key]) => key !== "id" && key !== "workspace_id");
    const sql = table === "workspace_meta"
      ? `UPDATE workspace_meta SET ${fields.map(([key]) => `${key} = ?`).join(", ")} WHERE workspace_id = ?`
      : `UPDATE ${tableFor(table)} SET ${fields.map(([key]) => `${key} = ?`).join(", ")} WHERE workspace_id = ? AND id = ?`;
    this.database.prepare(sql).run(...fields.map(([, value]) => value), this.workspaceId, ...(table === "workspace_meta" ? [] : [id]));
  }
  private audit(ctx: TransactionContext, entityType: string, entityId: string, action: string, before: unknown, after: unknown): void { ctx.audit.append({ entityType, entityId, action, before, after }); }
}
