import { randomUUID } from "node:crypto";
import { parsePartialDate, type PartialDate } from "../../../shared/domain.js";
import type { TransactionContext } from "../unit-of-work.js";
import type { WorkspaceDatabase } from "../open-database.js";
import type { ReadOptions } from "./person-repository.js";

export type ParentRole = "father" | "mother";
export type MarriageStatus = "active" | "divorced";
export type ParentChildOriginKind = "explicit" | "spouse_default";
export interface ParentChildRecord { id: string; workspaceId: string; parentId: string; childId: string; parentRole: ParentRole; relationshipType: "biological"; originKind: ParentChildOriginKind; inferredFromMarriageId: string | null; createdAt: string; updatedAt: string; deletedAt: string | null; rowVersion: number; }
export interface MarriageRecord { id: string; workspaceId: string; spouseAId: string; spouseBId: string; status: MarriageStatus; start: PartialDate | null; end: PartialDate | null; createdAt: string; updatedAt: string; deletedAt: string | null; rowVersion: number; }
export interface CreateParentChildInput { id?: string; parentId: string; childId: string; parentRole: ParentRole; originKind?: ParentChildOriginKind; inferredFromMarriageId?: string | null; }
export interface CreateMarriageInput { id?: string; spouseAId: string; spouseBId: string; status?: MarriageStatus; start?: PartialDate | null; end?: PartialDate | null; }
interface ParentRow { id: string; workspace_id: string; parent_id: string; child_id: string; parent_role: ParentRole; relationship_type: "biological"; origin_kind: ParentChildOriginKind; inferred_from_marriage_id: string | null; created_at: string; updated_at: string; deleted_at: string | null; row_version: number; }
interface MarriageRow { id: string; workspace_id: string; spouse_a_id: string; spouse_b_id: string; marriage_status: MarriageStatus; start_calendar: PartialDate["calendar"] | null; start_year: number | null; start_month: number | null; start_day: number | null; start_leap_month: number; start_precision: PartialDate["precision"] | null; end_calendar: PartialDate["calendar"] | null; end_year: number | null; end_month: number | null; end_day: number | null; end_leap_month: number; end_precision: PartialDate["precision"] | null; created_at: string; updated_at: string; deleted_at: string | null; row_version: number; }
const parentRecord = (row: ParentRow): ParentChildRecord => ({ id: row.id, workspaceId: row.workspace_id, parentId: row.parent_id, childId: row.child_id, parentRole: row.parent_role, relationshipType: row.relationship_type, originKind: row.origin_kind, inferredFromMarriageId: row.inferred_from_marriage_id, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, rowVersion: row.row_version });
function rowDate(row: MarriageRow, prefix: "start" | "end"): PartialDate | null { const calendar = row[`${prefix}_calendar`]; return calendar === null ? null : { calendar, year: row[`${prefix}_year`]!, month: row[`${prefix}_month`]!, day: row[`${prefix}_day`], leapMonth: row[`${prefix}_leap_month`] === 1, precision: row[`${prefix}_precision`]! }; }
const marriageRecord = (row: MarriageRow): MarriageRecord => ({ id: row.id, workspaceId: row.workspace_id, spouseAId: row.spouse_a_id, spouseBId: row.spouse_b_id, status: row.marriage_status, start: rowDate(row, "start"), end: rowDate(row, "end"), createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, rowVersion: row.row_version });
const dateValues = (date: PartialDate | null | undefined): readonly unknown[] => {
  if (!date) return [null, null, null, null, 0, null];
  const validated = parsePartialDate(date);
  return [validated.calendar, validated.year, validated.month, validated.day, validated.leapMonth ? 1 : 0, validated.precision];
};

export class RelationRepository {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}
  getParentChild(id: string, options: ReadOptions = {}): ParentChildRecord | null { const row = this.database.prepare(`SELECT * FROM parent_child WHERE workspace_id = ? AND id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"}`).get(this.workspaceId, id) as ParentRow | undefined; return row ? parentRecord(row) : null; }
  getMarriage(id: string, options: ReadOptions = {}): MarriageRecord | null { const row = this.database.prepare(`SELECT * FROM marriage WHERE workspace_id = ? AND id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"}`).get(this.workspaceId, id) as MarriageRow | undefined; return row ? marriageRecord(row) : null; }
  listParentChild(options: ReadOptions = {}): ParentChildRecord[] { return (this.database.prepare(`SELECT * FROM parent_child WHERE workspace_id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"} ORDER BY created_at, id`).all(this.workspaceId) as ParentRow[]).map(parentRecord); }
  listMarriages(options: ReadOptions = {}): MarriageRecord[] { return (this.database.prepare(`SELECT * FROM marriage WHERE workspace_id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"} ORDER BY created_at, id`).all(this.workspaceId) as MarriageRow[]).map(marriageRecord); }
  createParentChild(ctx: TransactionContext, input: CreateParentChildInput): ParentChildRecord {
    const id = input.id ?? randomUUID(); const now = new Date().toISOString();
    const originKind = input.originKind ?? "explicit";
    const inferredFromMarriageId = originKind === "spouse_default" ? input.inferredFromMarriageId ?? null : null;
    if (originKind === "spouse_default" && (!inferredFromMarriageId || !this.database.prepare("SELECT 1 FROM marriage WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL AND marriage_status IN ('active', 'divorced')").get(this.workspaceId, inferredFromMarriageId))) {
      throw new Error("Spouse-default parent-child relations require an active or divorced marriage from this workspace");
    }
    this.database.prepare("INSERT INTO parent_child (id, workspace_id, parent_id, child_id, parent_role, relationship_type, origin_kind, inferred_from_marriage_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'biological', ?, ?, ?, ?)").run(id, this.workspaceId, input.parentId, input.childId, input.parentRole, originKind, inferredFromMarriageId, now, now);
    const after = this.requireParentChild(id, true); ctx.audit.append({ entityType: "parent_child", entityId: id, action: "create", before: null, after }); return after;
  }
  archiveParentChild(ctx: TransactionContext, id: string): ParentChildRecord { const before = this.requireParentChild(id, false); const now = new Date().toISOString(); this.database.prepare("UPDATE parent_child SET deleted_at = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").run(now, now, this.workspaceId, id); const after = this.requireParentChild(id, true); ctx.audit.append({ entityType: "parent_child", entityId: id, action: "archive", before, after }); return after; }
  createMarriage(ctx: TransactionContext, input: CreateMarriageInput): MarriageRecord {
    const id = input.id ?? randomUUID(); const [spouseAId, spouseBId] = [input.spouseAId, input.spouseBId].sort(); const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO marriage (id, workspace_id, spouse_a_id, spouse_b_id, marriage_status, start_calendar, start_year, start_month, start_day, start_leap_month, start_precision, end_calendar, end_year, end_month, end_day, end_leap_month, end_precision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, this.workspaceId, spouseAId, spouseBId, input.status ?? "active", ...dateValues(input.start), ...dateValues(input.end), now, now);
    const after = this.requireMarriage(id, true); ctx.audit.append({ entityType: "marriage", entityId: id, action: "create", before: null, after }); return after;
  }
  setMarriageStatus(ctx: TransactionContext, id: string, status: MarriageStatus): MarriageRecord { const before = this.requireMarriage(id, false); const now = new Date().toISOString(); this.database.prepare("UPDATE marriage SET marriage_status = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").run(status, now, this.workspaceId, id); const after = this.requireMarriage(id, false); ctx.audit.append({ entityType: "marriage", entityId: id, action: "update", before, after }); return after; }
  divorceMarriage(ctx: TransactionContext, id: string, end: PartialDate | null): MarriageRecord {
    const before = this.requireMarriage(id, false); const now = new Date().toISOString();
    this.database.prepare("UPDATE marriage SET marriage_status = 'divorced', end_calendar = ?, end_year = ?, end_month = ?, end_day = ?, end_leap_month = ?, end_precision = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL")
      .run(...dateValues(end), now, this.workspaceId, id);
    const after = this.requireMarriage(id, false); ctx.audit.append({ entityType: "marriage", entityId: id, action: "update", before, after }); return after;
  }
  archiveMarriage(ctx: TransactionContext, id: string): MarriageRecord { const before = this.requireMarriage(id, false); const now = new Date().toISOString(); this.database.prepare("UPDATE marriage SET deleted_at = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").run(now, now, this.workspaceId, id); const after = this.requireMarriage(id, true); ctx.audit.append({ entityType: "marriage", entityId: id, action: "archive", before, after }); return after; }
  private requireParentChild(id: string, includeArchived: boolean): ParentChildRecord { const row = this.getParentChild(id, { includeArchived }); if (!row) throw new Error(`Parent-child relation not found: ${id}`); return row; }
  private requireMarriage(id: string, includeArchived: boolean): MarriageRecord { const row = this.getMarriage(id, { includeArchived }); if (!row) throw new Error(`Marriage not found: ${id}`); return row; }
}
