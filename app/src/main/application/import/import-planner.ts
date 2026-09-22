import { randomUUID } from "node:crypto";
import type { PartialDate } from "../../../shared/domain.js";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { ImportIdentityRepository } from "../../database/repositories/import-identity-repository.js";
import { PersonRepository, type Gender, type PersonRecord } from "../../database/repositories/person-repository.js";
import { RelationRepository, type MarriageStatus, type ParentRole } from "../../database/repositories/relation-repository.js";
import { wouldCreateParentCycle, type ParentEdge } from "../../domain/validation/graph-cycle-detector.js";
import { enumValue, issueFor, partialDateFromRow, requiredText } from "./import-validator.js";
import type {
  ImportAction,
  ImportActionKind,
  ImportIssue,
  ImportMarriagePayload,
  ImportParentChildPayload,
  ImportPersonPayload,
  ImportPlan,
  ParsedImport,
  ParsedImportRow
} from "./import-types.js";

export class ImportPlanStore {
  private readonly plans = new Map<string, ImportPlan>();

  save(plan: ImportPlan): void {
    this.plans.set(plan.id, plan);
  }

  get(planId: string): ImportPlan | null {
    return this.plans.get(planId) ?? null;
  }
}

interface PlannedPerson {
  action: ImportAction;
  externalId: string;
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const value = (raw: unknown): string => raw === null || raw === undefined ? "" : String(raw);
const actionId = (row: ParsedImportRow, type: ImportAction["entityType"]): string => `${row.sheet}:${row.row}:${type}`;

export class ImportPlanner {
  private readonly identities: ImportIdentityRepository;
  private readonly people: PersonRepository;
  private readonly relations: RelationRepository;

  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly workspaceId: string,
    private readonly store: ImportPlanStore
  ) {
    this.identities = new ImportIdentityRepository(database, workspaceId);
    this.people = new PersonRepository(database, workspaceId);
    this.relations = new RelationRepository(database, workspaceId);
  }

  plan(input: ParsedImport): ImportPlan {
    if (!input.sourceKey.trim()) throw new Error("Source key is required");
    const actions: ImportAction[] = [];
    const issues: ImportIssue[] = [];
    const peopleRows = input.rows.filter((row) => row.sheet === "People");
    const counts = new Map<string, number>();
    for (const row of peopleRows) {
      const externalId = value(row.raw.person_external_id);
      if (externalId.trim()) counts.set(externalId, (counts.get(externalId) ?? 0) + 1);
    }

    const plannedPeople = new Map<string, PlannedPerson>();
    for (const row of peopleRows) {
      const action = this.planPerson(input.sourceKey, row, counts);
      actions.push(action.action);
      issues.push(...action.issues);
      if (action.externalId && !plannedPeople.has(action.externalId)) plannedPeople.set(action.externalId, { action: action.action, externalId: action.externalId });
    }

    const parentRows = input.rows.filter((row) => row.sheet === "ParentChild");
    const cycleRows = this.findCycleRows(parentRows);
    for (const row of parentRows) {
      const result = this.planParentChild(input.sourceKey, row, plannedPeople, cycleRows.has(row.row));
      actions.push(result.action);
      issues.push(...result.issues);
    }

    for (const row of input.rows.filter((entry) => entry.sheet === "Marriages")) {
      const result = this.planMarriage(input.sourceKey, row, plannedPeople);
      actions.push(result.action);
      issues.push(...result.issues);
    }

    const plan: ImportPlan = {
      id: randomUUID(),
      sourceKey: input.sourceKey,
      fileName: input.fileName,
      actions,
      issues,
      summary: {
        creates: actions.filter((action) => action.kind === "create").length,
        updates: actions.filter((action) => action.kind === "update").length,
        unchanged: actions.filter((action) => action.kind === "unchanged").length,
        blocked: actions.filter((action) => action.kind === "blocked").length
      }
    };
    this.store.save(plan);
    return plan;
  }

  private planPerson(sourceKey: string, row: ParsedImportRow, counts: Map<string, number>): { action: ImportAction; issues: ImportIssue[]; externalId: string } {
    const id = actionId(row, "person");
    const rowIssues: ImportIssue[] = [];
    const external = requiredText(row, "person_external_id");
    const name = requiredText(row, "name");
    const gender = enumValue(row, "gender", ["male", "female", "unknown"] as const);
    const birth = partialDateFromRow(row, "birth");
    rowIssues.push(...[external.issue, name.issue, gender.issue].filter((entry): entry is ImportIssue => Boolean(entry)), ...birth.issues);
    const externalId = external.value ?? value(row.raw.person_external_id);
    if (external.value && (counts.get(external.value) ?? 0) > 1) {
      rowIssues.push(issueFor(row, "error", "DUPLICATE_EXTERNAL_ID", "The external person ID occurs more than once", {
        column: "person_external_id",
        value: external.value
      }));
    }

    const payload: ImportPersonPayload = {
      type: "person",
      externalId,
      displayName: name.value ?? value(row.raw.name),
      gender: gender.value ?? "unknown",
      birth: birth.value,
      notes: value(row.raw.notes) === "" ? null : value(row.raw.notes),
      newEntityId: randomUUID()
    };
    const errorIssues = rowIssues.filter((issue) => issue.severity === "error");
    if (errorIssues.length > 0) {
      return { externalId, issues: this.attachIssues(id, rowIssues), action: this.action(id, row, "person", "blocked", payload, rowIssues) };
    }

    const identity = this.identities.get(sourceKey, externalId);
    if (identity) {
      const person = this.people.get(identity.personId);
      if (!person) {
        rowIssues.push(issueFor(row, "error", "MISSING_REFERENCE", "The import identity points to a missing person", { externalId, entityId: identity.personId }));
        return { externalId, issues: this.attachIssues(id, rowIssues), action: this.action(id, row, "person", "blocked", payload, rowIssues, identity.personId, identity.rowVersion) };
      }
      const changes = this.personChanges(person, payload);
      const kind: ImportActionKind = changes.length === 0 ? "unchanged" : "update";
      const action = this.action(id, row, "person", kind, payload, rowIssues, person.id, person.rowVersion);
      action.changes = changes;
      return { externalId, action, issues: this.attachIssues(id, rowIssues) };
    }

    const candidates = this.people.list().filter((person) => person.displayName === payload.displayName).map((person) => person.id);
    if (candidates.length > 0) {
      rowIssues.push(issueFor(row, "warning", "SAME_NAME_CANDIDATE", "A same-name person exists; review before creating a separate person", {
        externalId,
        candidateEntityIds: candidates
      }));
    }
    return { externalId, action: this.action(id, row, "person", "create", payload, rowIssues), issues: this.attachIssues(id, rowIssues) };
  }

  private planParentChild(
    sourceKey: string,
    row: ParsedImportRow,
    plannedPeople: Map<string, PlannedPerson>,
    createsCycle: boolean
  ): { action: ImportAction; issues: ImportIssue[] } {
    const id = actionId(row, "parentChild");
    const rowIssues: ImportIssue[] = [];
    const parent = requiredText(row, "parent_external_id");
    const child = requiredText(row, "child_external_id");
    const role = enumValue(row, "parent_role", ["father", "mother"] as const);
    rowIssues.push(...[parent.issue, child.issue, role.issue].filter((entry): entry is ImportIssue => Boolean(entry)));
    const payload: ImportParentChildPayload = {
      type: "parentChild",
      parentExternalId: parent.value ?? value(row.raw.parent_external_id),
      childExternalId: child.value ?? value(row.raw.child_external_id),
      parentRole: role.value ?? "father"
    };
    const parentId = this.resolvePerson(sourceKey, payload.parentExternalId, plannedPeople, row, "parent_external_id", rowIssues);
    const childId = this.resolvePerson(sourceKey, payload.childExternalId, plannedPeople, row, "child_external_id", rowIssues);
    if (createsCycle) rowIssues.push(issueFor(row, "error", "PARENT_CYCLE", "The imported parent-child rows would create a cycle", {
      parentExternalId: payload.parentExternalId,
      childExternalId: payload.childExternalId
    }));

    let kind: ImportActionKind = rowIssues.some((issue) => issue.severity === "error") ? "blocked" : "create";
    let entityId: string | undefined;
    let expectedRowVersion: number | undefined;
    if (kind !== "blocked" && parentId && childId) {
      const existing = this.relations.listParentChild().find((edge) => edge.parentId === parentId && edge.childId === childId);
      if (existing?.parentRole === payload.parentRole) {
        kind = "unchanged";
        entityId = existing.id;
        expectedRowVersion = existing.rowVersion;
      } else if (existing) {
        rowIssues.push(issueFor(row, "error", "RELATION_CONFLICT", "The parent-child pair already exists with a different role", { entityId: existing.id }));
        kind = "blocked";
      }
    }
    return { action: this.action(id, row, "parentChild", kind, payload, rowIssues, entityId, expectedRowVersion), issues: this.attachIssues(id, rowIssues) };
  }

  private planMarriage(sourceKey: string, row: ParsedImportRow, plannedPeople: Map<string, PlannedPerson>): { action: ImportAction; issues: ImportIssue[] } {
    const id = actionId(row, "marriage");
    const rowIssues: ImportIssue[] = [];
    const spouseA = requiredText(row, "spouse_a_external_id");
    const spouseB = requiredText(row, "spouse_b_external_id");
    const status = enumValue(row, "status", ["active", "divorced"] as const);
    const start = partialDateFromRow(row, "start");
    const end = partialDateFromRow(row, "end");
    rowIssues.push(...[spouseA.issue, spouseB.issue, status.issue].filter((entry): entry is ImportIssue => Boolean(entry)), ...start.issues, ...end.issues);
    const payload: ImportMarriagePayload = {
      type: "marriage",
      spouseAExternalId: spouseA.value ?? value(row.raw.spouse_a_external_id),
      spouseBExternalId: spouseB.value ?? value(row.raw.spouse_b_external_id),
      status: status.value ?? "active",
      start: start.value,
      end: end.value
    };
    const spouseAId = this.resolvePerson(sourceKey, payload.spouseAExternalId, plannedPeople, row, "spouse_a_external_id", rowIssues);
    const spouseBId = this.resolvePerson(sourceKey, payload.spouseBExternalId, plannedPeople, row, "spouse_b_external_id", rowIssues);
    if (payload.spouseAExternalId === payload.spouseBExternalId && payload.spouseAExternalId) {
      rowIssues.push(issueFor(row, "error", "SELF_RELATION", "A person cannot marry themselves", { externalId: payload.spouseAExternalId }));
    }
    let kind: ImportActionKind = rowIssues.some((issue) => issue.severity === "error") ? "blocked" : "create";
    let entityId: string | undefined;
    let expectedRowVersion: number | undefined;
    if (kind !== "blocked" && spouseAId && spouseBId) {
      const pair = [spouseAId, spouseBId].sort();
      const existing = this.relations.listMarriages().find((marriage) => marriage.spouseAId === pair[0] && marriage.spouseBId === pair[1]);
      if (existing && existing.status === payload.status && same(existing.start, payload.start) && same(existing.end, payload.end)) {
        kind = "unchanged";
        entityId = existing.id;
        expectedRowVersion = existing.rowVersion;
      } else if (existing) {
        rowIssues.push(issueFor(row, "error", "RELATION_CONFLICT", "The marriage already exists with different fields", { entityId: existing.id }));
        kind = "blocked";
      }
    }
    return { action: this.action(id, row, "marriage", kind, payload, rowIssues, entityId, expectedRowVersion), issues: this.attachIssues(id, rowIssues) };
  }

  private resolvePerson(
    sourceKey: string,
    externalId: string,
    plannedPeople: Map<string, PlannedPerson>,
    row: ParsedImportRow,
    column: string,
    issues: ImportIssue[]
  ): string | null {
    const planned = plannedPeople.get(externalId);
    if (planned && planned.action.kind !== "blocked") return planned.action.entityId ?? null;
    const identity = this.identities.get(sourceKey, externalId);
    if (identity && this.people.get(identity.personId)) return identity.personId;
    issues.push(issueFor(row, "error", "MISSING_REFERENCE", "The external person reference was not found in this source", {
      column,
      value: externalId
    }));
    return null;
  }

  private findCycleRows(rows: ParsedImportRow[]): Set<number> {
    const edges: ParentEdge[] = [];
    const cycleRows = new Set<number>();
    for (const row of rows) {
      const parent = value(row.raw.parent_external_id);
      const child = value(row.raw.child_external_id);
      if (!parent.trim() || !child.trim()) continue;
      if (wouldCreateParentCycle(parent, child, edges)) cycleRows.add(row.row);
      else edges.push({ parentId: parent, childId: child });
    }
    return cycleRows;
  }

  private personChanges(person: PersonRecord, payload: ImportPersonPayload): ImportAction["changes"] {
    const desired: Array<[string, unknown, unknown]> = [
      ["displayName", person.displayName, payload.displayName],
      ["gender", person.gender, payload.gender],
      ["birth", person.birth, payload.birth],
      ["notes", person.notes, payload.notes]
    ];
    return desired.filter(([, before, after]) => !same(before, after)).map(([field, before, after]) => ({ field, before, after }));
  }

  private action(
    id: string,
    row: ParsedImportRow,
    entityType: ImportAction["entityType"],
    kind: ImportActionKind,
    payload: ImportAction["payload"],
    issues: ImportIssue[],
    entityId?: string,
    expectedRowVersion?: number
  ): ImportAction {
    return {
      id,
      entityType,
      kind,
      sourceRow: row,
      payload,
      ...(entityId ? { entityId } : {}),
      ...(expectedRowVersion === undefined ? {} : { expectedRowVersion }),
      changes: [],
      issueIds: issues.map((issue) => issue.id)
    };
  }

  private attachIssues(action: string, issues: ImportIssue[]): ImportIssue[] {
    return issues.map((entry) => ({ ...entry, actionId: action }));
  }
}
