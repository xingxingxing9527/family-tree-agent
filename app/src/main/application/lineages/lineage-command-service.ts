import type { WorkspaceDatabase } from "../../database/open-database.js";
import { createUnitOfWork, type TransactionContext } from "../../database/unit-of-work.js";
import { LineageRepository, type LineageRecord, type LineageRole, type MembershipRecord } from "../../database/repositories/lineage-repository.js";

export type LineageCommandErrorCode = "VALIDATION" | "NOT_FOUND" | "CONFLICT";

export class LineageCommandError extends Error {
  constructor(public readonly code: LineageCommandErrorCode, message: string, public readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
  }
}

export interface LineageMutation<T> {
  value: T;
  operationGroupId: string;
}

type MembershipValues = {
  lineageRole: LineageRole;
  isPrimary: boolean;
  declaredGeneration: number | null;
  generationMarker: string | null;
};

export class LineageCommandService {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}

  createLineage(input: { name: string; founderPersonId: string; description: string | null }): LineageMutation<LineageRecord> {
    const name = this.text(input.name, "name", 200);
    const description = this.optionalText(input.description, "description", 10_000);
    this.requirePerson(input.founderPersonId);
    return this.run("lineage.create", (ctx) => ctx.lineages.create(ctx, { name, founderPersonId: input.founderPersonId, description }));
  }

  updateLineage(input: { lineageId: string; expectedVersion: number; patch: { name?: string; founderPersonId?: string; description?: string | null } }): LineageMutation<LineageRecord> {
    const lineage = this.requireLineage(input.lineageId);
    this.requireVersion(lineage.rowVersion, input.expectedVersion, "lineage", lineage.id);
    if (Object.keys(input.patch).length === 0) throw new LineageCommandError("VALIDATION", "Lineage patch cannot be empty", { field: "patch" });
    const founderPersonId = input.patch.founderPersonId;
    if (founderPersonId !== undefined) this.requirePerson(founderPersonId);
    const patch = {
      ...(input.patch.name === undefined ? {} : { name: this.text(input.patch.name, "name", 200) }),
      ...(founderPersonId === undefined ? {} : { founderPersonId }),
      ...(input.patch.description === undefined ? {} : { description: this.optionalText(input.patch.description, "description", 10_000) })
    };
    return this.run("lineage.update", (ctx) => ctx.lineages.update(ctx, lineage.id, patch));
  }

  archiveLineage(input: { lineageId: string; expectedVersion: number }): LineageMutation<LineageRecord> {
    const lineage = this.requireLineage(input.lineageId);
    this.requireVersion(lineage.rowVersion, input.expectedVersion, "lineage", lineage.id);
    return this.run("lineage.archive", (ctx) => ctx.lineages.archive(ctx, lineage.id));
  }

  addMembership(input: { lineageId: string; personId: string } & MembershipValues): LineageMutation<MembershipRecord> {
    this.requireLineage(input.lineageId);
    this.requirePerson(input.personId);
    const values = this.membershipValues(input);
    return this.run("lineage-membership.create", (ctx) => {
      if (values.isPrimary) this.demoteOtherPrimaries(ctx, input.personId);
      try {
        return ctx.lineages.addMembership(ctx, { lineageId: input.lineageId, personId: input.personId, ...values });
      } catch (error) {
        if (this.isConstraint(error)) throw new LineageCommandError("CONFLICT", "This person already has an active membership in the lineage");
        throw error;
      }
    });
  }

  updateMembership(input: { membershipId: string; expectedVersion: number; patch: Partial<MembershipValues> }): LineageMutation<MembershipRecord> {
    const membership = this.requireMembership(input.membershipId);
    this.requireVersion(membership.rowVersion, input.expectedVersion, "lineage_membership", membership.id);
    if (Object.keys(input.patch).length === 0) throw new LineageCommandError("VALIDATION", "Membership patch cannot be empty", { field: "patch" });
    const patch = this.membershipPatch(input.patch);
    if (patch.lineageRole !== undefined && patch.lineageRole !== "blood" && this.requireLineage(membership.lineageId).founderPersonId === membership.personId) {
      throw new LineageCommandError("VALIDATION", "The active founder membership must remain a blood membership", { field: "lineageRole", entityId: membership.id, entityType: "lineage_membership" });
    }
    return this.run("lineage-membership.update", (ctx) => {
      if (patch.isPrimary === true) this.demoteOtherPrimaries(ctx, membership.personId, membership.id);
      return ctx.lineages.updateMembership(ctx, membership.id, patch);
    });
  }

  removeMembership(input: { membershipId: string; expectedVersion: number }): LineageMutation<MembershipRecord> {
    const membership = this.requireMembership(input.membershipId);
    this.requireVersion(membership.rowVersion, input.expectedVersion, "lineage_membership", membership.id);
    return this.run("lineage-membership.remove", (ctx) => {
      try { return ctx.lineages.archiveMembership(ctx, membership.id); }
      catch (error) {
        if (/founder/i.test(error instanceof Error ? error.message : "")) throw new LineageCommandError("VALIDATION", "The active founder membership cannot be removed");
        throw error;
      }
    });
  }

  private run<T>(kind: string, operation: (ctx: TransactionContext) => T): LineageMutation<T> {
    return createUnitOfWork(this.database, this.workspaceId).run(kind, (ctx) => ({ value: operation(ctx), operationGroupId: ctx.operationGroupId }));
  }

  private demoteOtherPrimaries(ctx: TransactionContext, personId: string, exceptId?: string): void {
    for (const membership of ctx.lineages.listMembershipsForPerson(personId)) {
      if (membership.isPrimary && membership.id !== exceptId) ctx.lineages.updateMembership(ctx, membership.id, { isPrimary: false });
    }
  }

  private membershipValues(input: MembershipValues): MembershipValues {
    return {
      lineageRole: input.lineageRole,
      isPrimary: input.isPrimary,
      declaredGeneration: this.declaredGeneration(input.declaredGeneration),
      generationMarker: this.optionalText(input.generationMarker, "generationMarker", 50)
    };
  }

  private membershipPatch(input: Partial<MembershipValues>): Partial<MembershipValues> {
    return {
      ...(input.lineageRole === undefined ? {} : { lineageRole: input.lineageRole }),
      ...(input.isPrimary === undefined ? {} : { isPrimary: input.isPrimary }),
      ...(input.declaredGeneration === undefined ? {} : { declaredGeneration: this.declaredGeneration(input.declaredGeneration) }),
      ...(input.generationMarker === undefined ? {} : { generationMarker: this.optionalText(input.generationMarker, "generationMarker", 50) })
    };
  }

  private declaredGeneration(value: number | null): number | null {
    if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 10_000)) throw new LineageCommandError("VALIDATION", "Declared generation must be a positive integer", { field: "declaredGeneration" });
    return value;
  }

  private text(value: string, field: string, maximum: number): string {
    const normalized = value.trim();
    if (!normalized || normalized.length > maximum) throw new LineageCommandError("VALIDATION", `Invalid ${field}`, { field });
    return normalized;
  }

  private optionalText(value: string | null, field: string, maximum: number): string | null {
    if (value === null) return null;
    return this.text(value, field, maximum);
  }

  private requirePerson(personId: string): void {
    const person = this.database.prepare("SELECT 1 FROM person WHERE workspace_id=? AND id=? AND deleted_at IS NULL").get(this.workspaceId, personId);
    if (!person) throw new LineageCommandError("NOT_FOUND", "Person was not found", { entityId: personId, entityType: "person" });
  }

  private requireLineage(lineageId: string): LineageRecord {
    const repository = new LineageRepository(this.database, this.workspaceId);
    const value = repository.get(lineageId);
    if (!value) throw new LineageCommandError("NOT_FOUND", "Lineage was not found", { entityId: lineageId, entityType: "lineage" });
    return value;
  }

  private requireMembership(membershipId: string): MembershipRecord {
    const repository = new LineageRepository(this.database, this.workspaceId);
    const value = repository.getMembership(membershipId);
    if (!value) throw new LineageCommandError("NOT_FOUND", "Lineage membership was not found", { entityId: membershipId, entityType: "lineage_membership" });
    return value;
  }

  private requireVersion(actual: number, expected: number, entityType: string, entityId: string): void {
    if (actual !== expected) throw new LineageCommandError("CONFLICT", "Lineage data changed since it was loaded", { entityType, entityId, expectedVersion: expected, actualVersion: actual });
  }

  private isConstraint(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && String((error as { code: unknown }).code).startsWith("SQLITE_CONSTRAINT");
  }
}
