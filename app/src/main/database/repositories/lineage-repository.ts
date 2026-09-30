import { randomUUID } from "node:crypto";
import type { TransactionContext } from "../unit-of-work.js";
import type { WorkspaceDatabase } from "../open-database.js";
import type { ReadOptions } from "./person-repository.js";

export type LineageRole = "blood" | "married_in" | "associated";
export interface LineageRecord { id: string; workspaceId: string; name: string; founderPersonId: string; description: string | null; createdAt: string; updatedAt: string; deletedAt: string | null; rowVersion: number; }
export interface MembershipRecord { id: string; workspaceId: string; lineageId: string; personId: string; lineageRole: LineageRole; isPrimary: boolean; declaredGeneration: number | null; generationMarker: string | null; createdAt: string; updatedAt: string; deletedAt: string | null; rowVersion: number; }
interface LineageRow { id: string; workspace_id: string; name: string; founder_person_id: string; description: string | null; created_at: string; updated_at: string; deleted_at: string | null; row_version: number; }
interface MembershipRow { id: string; workspace_id: string; lineage_id: string; person_id: string; lineage_role: LineageRole; is_primary: number; declared_generation: number | null; generation_marker: string | null; created_at: string; updated_at: string; deleted_at: string | null; row_version: number; }
const lineageRecord = (row: LineageRow): LineageRecord => ({ id: row.id, workspaceId: row.workspace_id, name: row.name, founderPersonId: row.founder_person_id, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, rowVersion: row.row_version });
const membershipRecord = (row: MembershipRow): MembershipRecord => ({ id: row.id, workspaceId: row.workspace_id, lineageId: row.lineage_id, personId: row.person_id, lineageRole: row.lineage_role, isPrimary: row.is_primary === 1, declaredGeneration: row.declared_generation, generationMarker: row.generation_marker, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, rowVersion: row.row_version });

export class LineageRepository {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}
  get(id: string, options: ReadOptions = {}): LineageRecord | null { const row = this.database.prepare(`SELECT * FROM lineage WHERE workspace_id = ? AND id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"}`).get(this.workspaceId, id) as LineageRow | undefined; return row ? lineageRecord(row) : null; }
  getMembership(id: string, options: ReadOptions = {}): MembershipRecord | null { const row = this.database.prepare(`SELECT * FROM lineage_membership WHERE workspace_id = ? AND id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"}`).get(this.workspaceId, id) as MembershipRow | undefined; return row ? membershipRecord(row) : null; }
  listMemberships(lineageId: string, options: ReadOptions = {}): MembershipRecord[] { return (this.database.prepare(`SELECT * FROM lineage_membership WHERE workspace_id = ? AND lineage_id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"} ORDER BY person_id, id`).all(this.workspaceId, lineageId) as MembershipRow[]).map(membershipRecord); }
  listMembershipsForPerson(personId: string, options: ReadOptions = {}): MembershipRecord[] { return (this.database.prepare(`SELECT * FROM lineage_membership WHERE workspace_id = ? AND person_id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"} ORDER BY lineage_id, id`).all(this.workspaceId, personId) as MembershipRow[]).map(membershipRecord); }
  create(ctx: TransactionContext, input: { id?: string; name: string; founderPersonId: string; description?: string | null }): LineageRecord {
    this.requireActiveWorkspacePerson(input.founderPersonId);
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.prepare("INSERT INTO lineage (id, workspace_id, name, founder_person_id, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, this.workspaceId, input.name, input.founderPersonId, input.description ?? null, now, now);
    const after = this.requireLineage(id, true);
    ctx.audit.append({ entityType: "lineage", entityId: id, action: "create", before: null, after });
    this.ensureFounderMembership(ctx, id, input.founderPersonId);
    return after;
  }
  update(ctx: TransactionContext, id: string, input: { name?: string; founderPersonId?: string; description?: string | null }): LineageRecord {
    const before = this.requireLineage(id, false);
    const founderPersonId = input.founderPersonId ?? before.founderPersonId;
    this.requireActiveWorkspacePerson(founderPersonId);
    const now = new Date().toISOString();
    this.database.prepare("UPDATE lineage SET name = ?, founder_person_id = ?, description = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").run(input.name ?? before.name, founderPersonId, input.description === undefined ? before.description : input.description, now, this.workspaceId, id);
    const after = this.requireLineage(id, false);
    ctx.audit.append({ entityType: "lineage", entityId: id, action: "update", before, after });
    this.ensureFounderMembership(ctx, id, founderPersonId);
    return after;
  }
  archive(ctx: TransactionContext, id: string): LineageRecord { const before = this.requireLineage(id, false); const now = new Date().toISOString(); this.database.prepare("UPDATE lineage SET deleted_at = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").run(now, now, this.workspaceId, id); const after = this.requireLineage(id, true); ctx.audit.append({ entityType: "lineage", entityId: id, action: "archive", before, after }); return after; }
  addMembership(ctx: TransactionContext, input: { id?: string; lineageId: string; personId: string; lineageRole: LineageRole; isPrimary?: boolean; declaredGeneration?: number | null; generationMarker?: string | null }): MembershipRecord {
    this.requireLineage(input.lineageId, false);
    this.requireActiveWorkspacePerson(input.personId);
    const id = input.id ?? randomUUID(); const now = new Date().toISOString();
    this.database.prepare("INSERT INTO lineage_membership (id, workspace_id, lineage_id, person_id, lineage_role, is_primary, declared_generation, generation_marker, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, this.workspaceId, input.lineageId, input.personId, input.lineageRole, input.isPrimary ? 1 : 0, input.declaredGeneration ?? null, input.generationMarker ?? null, now, now);
    const after = this.requireMembership(id, true); ctx.audit.append({ entityType: "lineage_membership", entityId: id, action: "create", before: null, after }); return after;
  }
  updateMembership(ctx: TransactionContext, id: string, input: { lineageRole?: LineageRole; isPrimary?: boolean; declaredGeneration?: number | null; generationMarker?: string | null }): MembershipRecord {
    const before = this.requireMembership(id, false);
    if (this.isFounderMembership(before) && input.lineageRole !== undefined && input.lineageRole !== "blood") {
      throw new Error("Cannot remove the active founder blood membership");
    }
    const now = new Date().toISOString();
    this.database.prepare("UPDATE lineage_membership SET lineage_role = ?, is_primary = ?, declared_generation = ?, generation_marker = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").run(input.lineageRole ?? before.lineageRole, input.isPrimary === undefined ? (before.isPrimary ? 1 : 0) : (input.isPrimary ? 1 : 0), input.declaredGeneration === undefined ? before.declaredGeneration : input.declaredGeneration, input.generationMarker === undefined ? before.generationMarker : input.generationMarker, now, this.workspaceId, id);
    const after = this.requireMembership(id, false);
    ctx.audit.append({ entityType: "lineage_membership", entityId: id, action: "update", before, after });
    return after;
  }
  archiveMembership(ctx: TransactionContext, id: string): MembershipRecord {
    const before = this.requireMembership(id, false);
    if (this.isFounderMembership(before)) throw new Error("Cannot archive the active founder blood membership");
    const now = new Date().toISOString();
    this.database.prepare("UPDATE lineage_membership SET deleted_at = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").run(now, now, this.workspaceId, id);
    const after = this.requireMembership(id, true);
    ctx.audit.append({ entityType: "lineage_membership", entityId: id, action: "archive", before, after });
    return after;
  }
  private ensureFounderMembership(ctx: TransactionContext, lineageId: string, founderPersonId: string): void {
    const membership = this.listMemberships(lineageId).find((candidate) => candidate.personId === founderPersonId);
    if (!membership) {
      this.addMembership(ctx, { lineageId, personId: founderPersonId, lineageRole: "blood" });
      return;
    }
    if (membership.lineageRole !== "blood") this.updateMembership(ctx, membership.id, { lineageRole: "blood" });
  }
  private requireActiveWorkspacePerson(personId: string): void {
    const person = this.database.prepare("SELECT 1 FROM person WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL").get(personId, this.workspaceId);
    if (!person) throw new Error(`Lineage founder must be an active person in workspace: ${personId}`);
  }
  private isFounderMembership(membership: MembershipRecord): boolean {
    const lineage = this.get(membership.lineageId);
    return lineage?.founderPersonId === membership.personId;
  }
  private requireLineage(id: string, includeArchived: boolean): LineageRecord { const row = this.get(id, { includeArchived }); if (!row) throw new Error(`Lineage not found: ${id}`); return row; }
  private requireMembership(id: string, includeArchived: boolean): MembershipRecord { const row = this.getMembership(id, { includeArchived }); if (!row) throw new Error(`Lineage membership not found: ${id}`); return row; }
}
