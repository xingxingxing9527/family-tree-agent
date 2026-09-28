import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { WorkspaceDatabase } from "../../database/open-database.js";

export type UndoErrorCode = "NOT_FOUND" | "NOT_UNDOABLE" | "CONFLICT" | "ALREADY_UNDONE";

export class UndoError extends Error {
  constructor(public readonly code: UndoErrorCode, message: string) {
    super(message);
    this.name = "UndoError";
  }
}

export interface AuditOperationGroup {
  id: string;
  kind: string;
  createdAt: string;
  status: "available" | "undone" | "blocked";
  affectedEntities: Array<{ entityType: string; entityId: string }>;
  undoable: boolean;
  reason: string | null;
  undoneAt: string | null;
}

export interface UndoReceipt {
  operationGroupId: string;
  undoneAt: string;
  restoredEntities: number;
}

const bounded = z.string().min(1).max(10_000);
const nullableBounded = bounded.nullable();
const timestamp = z.string().datetime();
const nullableTimestamp = timestamp.nullable();
const rowVersion = z.number().int().positive();
const partialDateSchema = z.object({
  calendar: z.enum(["solar", "lunar"]),
  year: z.number().int().positive(),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31).nullable(),
  leapMonth: z.boolean(),
  precision: z.enum(["month", "day"])
}).strict();

const common = {
  id: bounded,
  workspaceId: bounded,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: nullableTimestamp,
  rowVersion
};

const personSchema = z.object({
  ...common,
  displayName: bounded,
  gender: z.enum(["male", "female", "unknown"]),
  birth: partialDateSchema.nullable(),
  death: partialDateSchema.nullable(),
  notes: nullableBounded
}).strict();
const personAliasSchema = z.object({ ...common, personId: bounded, name: bounded, normalizedName: bounded }).strict();
const sourceSchema = z.object({
  ...common,
  sourceKey: bounded,
  title: bounded,
  kind: nullableBounded,
  uri: nullableBounded,
  citation: nullableBounded,
  notes: nullableBounded
}).strict();
const parentChildSchema = z.object({
  ...common,
  parentId: bounded,
  childId: bounded,
  parentRole: z.enum(["father", "mother"]),
  relationshipType: z.literal("biological")
}).strict();
const marriageSchema = z.object({
  ...common,
  spouseAId: bounded,
  spouseBId: bounded,
  status: z.enum(["active", "divorced"]),
  start: partialDateSchema.nullable(),
  end: partialDateSchema.nullable()
}).strict();
const lineageSchema = z.object({
  ...common,
  name: bounded,
  founderPersonId: bounded,
  description: nullableBounded
}).strict();
const membershipSchema = z.object({
  ...common,
  lineageId: bounded,
  personId: bounded,
  lineageRole: z.enum(["blood", "married_in", "associated"]),
  isPrimary: z.boolean(),
  declaredGeneration: z.number().int().positive().nullable()
}).strict();
const importIdentitySchema = z.object({
  id: bounded,
  workspaceId: bounded,
  sourceId: bounded.nullable(),
  sourceKey: bounded,
  externalPersonId: bounded,
  personId: bounded,
  rawJson: z.string().max(1_000_000).nullable(),
  rowVersion
}).strict();

type Snapshot = Record<string, unknown> & { id: string; workspaceId: string; rowVersion: number };
type Dependency = { entityType: string; entityId: string };
interface SnapshotAdapter {
  readonly table: string;
  readonly schema: z.ZodType<Snapshot>;
  readonly supportsRestore: boolean;
  read(id: string): Snapshot | null;
  restore(snapshot: Snapshot): void;
  dependencies(id: string): Dependency[];
}

interface OperationRow {
  id: string;
  kind: string;
  created_at: string;
  undone_at: string | null;
}

interface AuditRow {
  audit_rowid: number;
  entity_type: string;
  entity_id: string;
  action: string;
  before_json: string | null;
  after_json: string | null;
}

interface PreparedAudit {
  rowid: number;
  entityType: string;
  entityId: string;
  action: "create" | "update" | "archive" | "restore";
  adapter: SnapshotAdapter;
  before: Snapshot | null;
  after: Snapshot;
}

const sqlDate = (value: z.infer<typeof partialDateSchema> | null): readonly unknown[] => value
  ? [value.calendar, value.year, value.month, value.day, value.leapMonth ? 1 : 0, value.precision]
  : [null, null, null, null, 0, null];

const distinct = (values: Dependency[]): Dependency[] => [...new Map(values.map((value) => [`${value.entityType}\u0000${value.entityId}`, value])).values()];

export class UndoService {
  private readonly adapters: Readonly<Record<string, SnapshotAdapter>>;

  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {
    this.adapters = this.createAdapters();
  }

  listOperationGroups(): AuditOperationGroup[] {
    const groups = this.database.prepare(`
      SELECT id, kind, created_at, undone_at
      FROM operation_group
      WHERE workspace_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(this.workspaceId) as OperationRow[];
    return groups.map((group) => {
      const affectedEntities = this.rawAudit(group.id).map((row) => ({ entityType: row.entity_type, entityId: row.entity_id }));
      if (group.undone_at) return {
        id: group.id, kind: group.kind, createdAt: group.created_at, status: "undone" as const,
        affectedEntities, undoable: false, reason: "This operation group was already undone", undoneAt: group.undone_at
      };
      try {
        this.preflight(group);
        return {
          id: group.id, kind: group.kind, createdAt: group.created_at, status: "available" as const,
          affectedEntities, undoable: true, reason: null, undoneAt: null
        };
      } catch (error) {
        return {
          id: group.id, kind: group.kind, createdAt: group.created_at, status: "blocked" as const,
          affectedEntities, undoable: false, reason: error instanceof Error ? error.message : "Unsupported operation group", undoneAt: null
        };
      }
    });
  }

  undoOperationGroup(operationGroupId: string): UndoReceipt {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const group = this.operation(operationGroupId);
      const prepared = this.preflight(group);
      for (const item of prepared) {
        if (item.action === "create") {
          const removed = this.database.prepare(`DELETE FROM ${item.adapter.table} WHERE workspace_id = ? AND id = ?`).run(this.workspaceId, item.entityId).changes;
          if (removed !== 1) throw new UndoError("CONFLICT", `Entity changed while undoing ${item.entityType}:${item.entityId}`);
        } else {
          if (!item.before || !item.adapter.supportsRestore) throw new UndoError("NOT_UNDOABLE", `Unsupported restore shape for ${item.entityType}`);
          item.adapter.restore(item.before);
        }
      }
      const undoneAt = new Date().toISOString();
      const marked = this.database.prepare("UPDATE operation_group SET undone_at = ? WHERE workspace_id = ? AND id = ? AND undone_at IS NULL")
        .run(undoneAt, this.workspaceId, operationGroupId).changes;
      if (marked !== 1) throw new UndoError("ALREADY_UNDONE", "This operation group was already undone");
      this.database.exec("COMMIT");
      return { operationGroupId, undoneAt, restoredEntities: prepared.length };
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      if (error instanceof UndoError) throw error;
      throw new UndoError("CONFLICT", "The operation group could not be safely undone");
    }
  }

  private operation(id: string): OperationRow {
    const group = this.database.prepare(`
      SELECT id, kind, created_at, undone_at
      FROM operation_group WHERE workspace_id = ? AND id = ?
    `).get(this.workspaceId, id) as OperationRow | undefined;
    if (!group) throw new UndoError("NOT_FOUND", "Operation group was not found");
    if (group.undone_at) throw new UndoError("ALREADY_UNDONE", "This operation group was already undone");
    return group;
  }

  private rawAudit(operationGroupId: string): AuditRow[] {
    return this.database.prepare(`
      SELECT rowid AS audit_rowid, entity_type, entity_id, action, before_json, after_json
      FROM audit_log
      WHERE workspace_id = ? AND operation_group_id = ?
      ORDER BY rowid DESC
    `).all(this.workspaceId, operationGroupId) as AuditRow[];
  }

  private preflight(group: OperationRow): PreparedAudit[] {
    if (group.undone_at) throw new UndoError("ALREADY_UNDONE", "This operation group was already undone");
    if (group.kind === "person.merge" || group.kind === "person.unmerge") {
      throw new UndoError("NOT_UNDOABLE", "Merge groups require the dedicated unmerge workflow");
    }
    const rows = this.rawAudit(group.id);
    if (rows.length === 0) throw new UndoError("NOT_UNDOABLE", "Operation group has no reversible audit records");
    const prepared = rows.map((row) => this.prepareAudit(row));
    const createRows = new Map(prepared.filter((item) => item.action === "create").map((item) => [`${item.entityType}\u0000${item.entityId}`, item]));

    for (const item of prepared) {
      const current = item.adapter.read(item.entityId);
      if (!current || !isDeepStrictEqual(current, item.after)) {
        throw new UndoError("CONFLICT", `Current entity does not match audited state for ${item.entityType}:${item.entityId}`);
      }
      if (item.action !== "create") continue;
      for (const dependency of item.adapter.dependencies(item.entityId)) {
        const dependent = createRows.get(`${dependency.entityType}\u0000${dependency.entityId}`);
        if (!dependent || dependent.rowid < item.rowid) {
          throw new UndoError("NOT_UNDOABLE", `Unexpected dependent entity blocks undo: ${dependency.entityType}:${dependency.entityId}`);
        }
      }
    }
    return prepared;
  }

  private prepareAudit(row: AuditRow): PreparedAudit {
    const adapter = this.adapters[row.entity_type];
    if (!adapter) throw new UndoError("NOT_UNDOABLE", `Unsupported audit entity type: ${row.entity_type}`);
    if (!["create", "update", "archive", "restore"].includes(row.action)) {
      throw new UndoError("NOT_UNDOABLE", `Unsupported audit action: ${row.action}`);
    }
    let rawBefore: unknown;
    let rawAfter: unknown;
    try {
      rawBefore = row.before_json === null ? null : JSON.parse(row.before_json);
      rawAfter = row.after_json === null ? null : JSON.parse(row.after_json);
    } catch {
      throw new UndoError("NOT_UNDOABLE", `Malformed audit snapshot for ${row.entity_type}:${row.entity_id}`);
    }
    const action = row.action as PreparedAudit["action"];
    if (action === "create") {
      if (rawBefore !== null || rawAfter === null) throw new UndoError("NOT_UNDOABLE", "Create audit snapshots are incomplete");
    } else if (rawBefore === null || rawAfter === null || !adapter.supportsRestore) {
      throw new UndoError("NOT_UNDOABLE", `Audit snapshots cannot restore ${row.entity_type}`);
    }
    const after = this.parseSnapshot(adapter, rawAfter, row);
    const before = rawBefore === null ? null : this.parseSnapshot(adapter, rawBefore, row);
    return { rowid: row.audit_rowid, entityType: row.entity_type, entityId: row.entity_id, action, adapter, before, after };
  }

  private parseSnapshot(adapter: SnapshotAdapter, value: unknown, row: AuditRow): Snapshot {
    const parsed = adapter.schema.safeParse(value);
    if (!parsed.success || parsed.data.id !== row.entity_id || parsed.data.workspaceId !== this.workspaceId) {
      throw new UndoError("NOT_UNDOABLE", `Invalid audit snapshot for ${row.entity_type}:${row.entity_id}`);
    }
    return parsed.data;
  }

  private createAdapters(): Readonly<Record<string, SnapshotAdapter>> {
    const row = <T extends Snapshot>(sql: string, id: string, map: (value: Record<string, unknown>) => T): T | null => {
      const found = this.database.prepare(sql).get(this.workspaceId, id) as Record<string, unknown> | undefined;
      return found ? map(found) : null;
    };
    const dependencyRows = (sql: string, id: string, entityType: string): Dependency[] =>
      (this.database.prepare(sql).all(this.workspaceId, id) as Array<{ id: string }>).map((value) => ({ entityType, entityId: value.id }));
    const base = (value: Record<string, unknown>) => ({
      id: String(value.id), workspaceId: String(value.workspace_id), createdAt: String(value.created_at), updatedAt: String(value.updated_at),
      deletedAt: value.deleted_at === null ? null : String(value.deleted_at), rowVersion: Number(value.row_version)
    });
    const date = (value: Record<string, unknown>, prefix: string) => value[`${prefix}_calendar`] === null ? null : ({
      calendar: value[`${prefix}_calendar`] as "solar" | "lunar", year: Number(value[`${prefix}_year`]), month: Number(value[`${prefix}_month`]),
      day: value[`${prefix}_day`] === null ? null : Number(value[`${prefix}_day`]), leapMonth: Number(value[`${prefix}_leap_month`]) === 1,
      precision: value[`${prefix}_precision`] as "month" | "day"
    });
    const none = (): Dependency[] => [];
    return {
      person: {
        table: "person", schema: personSchema as z.ZodType<Snapshot>, supportsRestore: true,
        read: (id) => row("SELECT * FROM person WHERE workspace_id = ? AND id = ?", id, (value) => ({ ...base(value), displayName: String(value.display_name), gender: value.gender as "male" | "female" | "unknown", birth: date(value, "birth"), death: date(value, "death"), notes: value.notes === null ? null : String(value.notes) })),
        restore: (snapshot) => { const value = personSchema.parse(snapshot); this.database.prepare(`UPDATE person SET display_name=?, gender=?, birth_calendar=?, birth_year=?, birth_month=?, birth_day=?, birth_leap_month=?, birth_precision=?, death_calendar=?, death_year=?, death_month=?, death_day=?, death_leap_month=?, death_precision=?, notes=?, created_at=?, updated_at=?, deleted_at=?, row_version=? WHERE workspace_id=? AND id=?`).run(value.displayName, value.gender, ...sqlDate(value.birth), ...sqlDate(value.death), value.notes, value.createdAt, value.updatedAt, value.deletedAt, value.rowVersion, this.workspaceId, value.id); },
        dependencies: (id) => distinct([
          ...dependencyRows("SELECT id FROM person_alias WHERE workspace_id=? AND person_id=?", id, "person_alias"),
          ...((this.database.prepare("SELECT id FROM parent_child WHERE workspace_id=? AND (parent_id=? OR child_id=?)").all(this.workspaceId, id, id) as Array<{ id: string }>).map((value) => ({ entityType: "parent_child", entityId: value.id }))),
          ...((this.database.prepare("SELECT id FROM marriage WHERE workspace_id=? AND (spouse_a_id=? OR spouse_b_id=?)").all(this.workspaceId, id, id) as Array<{ id: string }>).map((value) => ({ entityType: "marriage", entityId: value.id }))),
          ...dependencyRows("SELECT id FROM lineage WHERE workspace_id=? AND founder_person_id=?", id, "lineage"),
          ...dependencyRows("SELECT id FROM lineage_membership WHERE workspace_id=? AND person_id=?", id, "lineage_membership"),
          ...dependencyRows("SELECT id FROM import_identity WHERE workspace_id=? AND person_id=?", id, "import_identity")
        ])
      },
      person_alias: {
        table: "person_alias", schema: personAliasSchema as z.ZodType<Snapshot>, supportsRestore: true,
        read: (id) => row("SELECT * FROM person_alias WHERE workspace_id=? AND id=?", id, (value) => ({ ...base(value), personId: String(value.person_id), name: String(value.name), normalizedName: String(value.normalized_name) })),
        restore: (snapshot) => { const value = personAliasSchema.parse(snapshot); this.database.prepare("UPDATE person_alias SET person_id=?, name=?, normalized_name=?, created_at=?, updated_at=?, deleted_at=?, row_version=? WHERE workspace_id=? AND id=?").run(value.personId, value.name, value.normalizedName, value.createdAt, value.updatedAt, value.deletedAt, value.rowVersion, this.workspaceId, value.id); },
        dependencies: none
      },
      source: {
        table: "source", schema: sourceSchema as z.ZodType<Snapshot>, supportsRestore: true,
        read: (id) => row("SELECT * FROM source WHERE workspace_id=? AND id=?", id, (value) => ({ ...base(value), sourceKey: String(value.source_key), title: String(value.title), kind: value.kind === null ? null : String(value.kind), uri: value.uri === null ? null : String(value.uri), citation: value.citation === null ? null : String(value.citation), notes: value.notes === null ? null : String(value.notes) })),
        restore: (snapshot) => { const value = sourceSchema.parse(snapshot); this.database.prepare("UPDATE source SET source_key=?, title=?, kind=?, uri=?, citation=?, notes=?, created_at=?, updated_at=?, deleted_at=?, row_version=? WHERE workspace_id=? AND id=?").run(value.sourceKey, value.title, value.kind, value.uri, value.citation, value.notes, value.createdAt, value.updatedAt, value.deletedAt, value.rowVersion, this.workspaceId, value.id); },
        dependencies: (id) => distinct([
          ...dependencyRows("SELECT id FROM import_identity WHERE workspace_id=? AND source_id=?", id, "import_identity"),
          ...dependencyRows("SELECT id FROM wiki_source WHERE workspace_id=? AND source_id=?", id, "wiki_source")
        ])
      },
      parent_child: {
        table: "parent_child", schema: parentChildSchema as z.ZodType<Snapshot>, supportsRestore: true,
        read: (id) => row("SELECT * FROM parent_child WHERE workspace_id=? AND id=?", id, (value) => ({ ...base(value), parentId: String(value.parent_id), childId: String(value.child_id), parentRole: value.parent_role as "father" | "mother", relationshipType: "biological" as const })),
        restore: (snapshot) => { const value = parentChildSchema.parse(snapshot); this.database.prepare("UPDATE parent_child SET parent_id=?, child_id=?, parent_role=?, relationship_type=?, created_at=?, updated_at=?, deleted_at=?, row_version=? WHERE workspace_id=? AND id=?").run(value.parentId, value.childId, value.parentRole, value.relationshipType, value.createdAt, value.updatedAt, value.deletedAt, value.rowVersion, this.workspaceId, value.id); },
        dependencies: none
      },
      marriage: {
        table: "marriage", schema: marriageSchema as z.ZodType<Snapshot>, supportsRestore: true,
        read: (id) => row("SELECT * FROM marriage WHERE workspace_id=? AND id=?", id, (value) => ({ ...base(value), spouseAId: String(value.spouse_a_id), spouseBId: String(value.spouse_b_id), status: value.marriage_status as "active" | "divorced", start: date(value, "start"), end: date(value, "end") })),
        restore: (snapshot) => { const value = marriageSchema.parse(snapshot); this.database.prepare(`UPDATE marriage SET spouse_a_id=?, spouse_b_id=?, marriage_status=?, start_calendar=?, start_year=?, start_month=?, start_day=?, start_leap_month=?, start_precision=?, end_calendar=?, end_year=?, end_month=?, end_day=?, end_leap_month=?, end_precision=?, created_at=?, updated_at=?, deleted_at=?, row_version=? WHERE workspace_id=? AND id=?`).run(value.spouseAId, value.spouseBId, value.status, ...sqlDate(value.start), ...sqlDate(value.end), value.createdAt, value.updatedAt, value.deletedAt, value.rowVersion, this.workspaceId, value.id); },
        dependencies: none
      },
      lineage: {
        table: "lineage", schema: lineageSchema as z.ZodType<Snapshot>, supportsRestore: true,
        read: (id) => row("SELECT * FROM lineage WHERE workspace_id=? AND id=?", id, (value) => ({ ...base(value), name: String(value.name), founderPersonId: String(value.founder_person_id), description: value.description === null ? null : String(value.description) })),
        restore: (snapshot) => { const value = lineageSchema.parse(snapshot); this.database.prepare("UPDATE lineage SET name=?, founder_person_id=?, description=?, created_at=?, updated_at=?, deleted_at=?, row_version=? WHERE workspace_id=? AND id=?").run(value.name, value.founderPersonId, value.description, value.createdAt, value.updatedAt, value.deletedAt, value.rowVersion, this.workspaceId, value.id); },
        dependencies: (id) => dependencyRows("SELECT id FROM lineage_membership WHERE workspace_id=? AND lineage_id=?", id, "lineage_membership")
      },
      lineage_membership: {
        table: "lineage_membership", schema: membershipSchema as z.ZodType<Snapshot>, supportsRestore: true,
        read: (id) => row("SELECT * FROM lineage_membership WHERE workspace_id=? AND id=?", id, (value) => ({ ...base(value), lineageId: String(value.lineage_id), personId: String(value.person_id), lineageRole: value.lineage_role as "blood" | "married_in" | "associated", isPrimary: Number(value.is_primary) === 1, declaredGeneration: value.declared_generation === null ? null : Number(value.declared_generation) })),
        restore: (snapshot) => { const value = membershipSchema.parse(snapshot); this.database.prepare("UPDATE lineage_membership SET lineage_id=?, person_id=?, lineage_role=?, is_primary=?, declared_generation=?, created_at=?, updated_at=?, deleted_at=?, row_version=? WHERE workspace_id=? AND id=?").run(value.lineageId, value.personId, value.lineageRole, value.isPrimary ? 1 : 0, value.declaredGeneration, value.createdAt, value.updatedAt, value.deletedAt, value.rowVersion, this.workspaceId, value.id); },
        dependencies: none
      },
      import_identity: {
        table: "import_identity", schema: importIdentitySchema as z.ZodType<Snapshot>, supportsRestore: false,
        read: (id) => row("SELECT * FROM import_identity WHERE workspace_id=? AND id=?", id, (value) => ({ id: String(value.id), workspaceId: String(value.workspace_id), sourceId: value.source_id === null ? null : String(value.source_id), sourceKey: String(value.source_key), externalPersonId: String(value.external_person_id), personId: String(value.person_id), rawJson: value.raw_json === null ? null : String(value.raw_json), rowVersion: Number(value.row_version) })),
        restore: () => { throw new UndoError("NOT_UNDOABLE", "Import identity updates are not safely reversible"); },
        dependencies: none
      }
    };
  }
}
