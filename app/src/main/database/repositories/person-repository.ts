import { randomUUID } from "node:crypto";
import type { PartialDate } from "../../../shared/domain.js";
import type { TransactionContext } from "../unit-of-work.js";
import type { WorkspaceDatabase } from "../open-database.js";

export type Gender = "male" | "female" | "unknown";

export interface PersonRecord {
  id: string;
  workspaceId: string;
  displayName: string;
  gender: Gender;
  birth: PartialDate | null;
  death: PartialDate | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  rowVersion: number;
}

export interface CreatePersonInput {
  id?: string;
  displayName: string;
  gender: Gender;
  birth?: PartialDate | null;
  death?: PartialDate | null;
  notes?: string | null;
}

export type UpdatePersonInput = Partial<Omit<CreatePersonInput, "id">>;
export interface ReadOptions { includeArchived?: boolean; }

export interface PersonAliasRecord {
  id: string;
  workspaceId: string;
  personId: string;
  name: string;
  normalizedName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  rowVersion: number;
}

export interface CreatePersonAliasInput { id?: string; personId: string; name: string; }

interface PersonRow {
  id: string; workspace_id: string; display_name: string; gender: Gender;
  birth_calendar: PartialDate["calendar"] | null; birth_year: number | null; birth_month: number | null;
  birth_day: number | null; birth_leap_month: number; birth_precision: PartialDate["precision"] | null;
  death_calendar: PartialDate["calendar"] | null; death_year: number | null; death_month: number | null;
  death_day: number | null; death_leap_month: number; death_precision: PartialDate["precision"] | null;
  notes: string | null; created_at: string; updated_at: string; deleted_at: string | null; row_version: number;
}

interface PersonAliasRow {
  id: string; workspace_id: string; person_id: string; name: string; normalized_name: string;
  created_at: string; updated_at: string; deleted_at: string | null; row_version: number;
}

const aliasRecord = (row: PersonAliasRow): PersonAliasRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  personId: row.person_id,
  name: row.name,
  normalizedName: row.normalized_name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  rowVersion: row.row_version
});

function dateFromRow(row: PersonRow, prefix: "birth" | "death"): PartialDate | null {
  const calendar = row[`${prefix}_calendar`];
  if (calendar === null) return null;
  return {
    calendar,
    year: row[`${prefix}_year`]!,
    month: row[`${prefix}_month`]!,
    day: row[`${prefix}_day`],
    leapMonth: row[`${prefix}_leap_month`] === 1,
    precision: row[`${prefix}_precision`]!
  };
}

function toRecord(row: PersonRow): PersonRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    gender: row.gender,
    birth: dateFromRow(row, "birth"),
    death: dateFromRow(row, "death"),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    rowVersion: row.row_version
  };
}

const dateValues = (date: PartialDate | null | undefined): readonly unknown[] => date ?
  [date.calendar, date.year, date.month, date.day, date.leapMonth ? 1 : 0, date.precision] :
  [null, null, null, null, 0, null];

export class PersonRepository {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}

  get(id: string, options: ReadOptions = {}): PersonRecord | null {
    const archived = options.includeArchived ? "" : " AND deleted_at IS NULL";
    const row = this.database.prepare(`SELECT * FROM person WHERE workspace_id = ? AND id = ?${archived}`).get(this.workspaceId, id) as PersonRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(options: ReadOptions = {}): PersonRecord[] {
    const archived = options.includeArchived ? "" : " AND deleted_at IS NULL";
    return (this.database.prepare(`SELECT * FROM person WHERE workspace_id = ?${archived} ORDER BY display_name, id`).all(this.workspaceId) as PersonRow[]).map(toRecord);
  }

  getAlias(id: string, options: ReadOptions = {}): PersonAliasRecord | null {
    const row = this.database.prepare(`SELECT * FROM person_alias WHERE workspace_id = ? AND id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"}`).get(this.workspaceId, id) as PersonAliasRow | undefined;
    return row ? aliasRecord(row) : null;
  }

  listAliases(personId: string, options: ReadOptions = {}): PersonAliasRecord[] {
    return (this.database.prepare(`SELECT * FROM person_alias WHERE workspace_id = ? AND person_id = ?${options.includeArchived ? "" : " AND deleted_at IS NULL"} ORDER BY name, id`).all(this.workspaceId, personId) as PersonAliasRow[]).map(aliasRecord);
  }

  create(ctx: TransactionContext, input: CreatePersonInput): PersonRecord {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO person (
        id, workspace_id, display_name, gender,
        birth_calendar, birth_year, birth_month, birth_day, birth_leap_month, birth_precision,
        death_calendar, death_year, death_month, death_day, death_leap_month, death_precision,
        notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, this.workspaceId, input.displayName, input.gender, ...dateValues(input.birth), ...dateValues(input.death), input.notes ?? null, now, now);
    const created = this.require(id, true);
    ctx.audit.append({ entityType: "person", entityId: id, action: "create", before: null, after: created });
    return created;
  }

  update(ctx: TransactionContext, id: string, input: UpdatePersonInput): PersonRecord {
    const before = this.require(id, false);
    const birth = input.birth === undefined ? before.birth : input.birth;
    const death = input.death === undefined ? before.death : input.death;
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE person SET display_name = ?, gender = ?,
        birth_calendar = ?, birth_year = ?, birth_month = ?, birth_day = ?, birth_leap_month = ?, birth_precision = ?,
        death_calendar = ?, death_year = ?, death_month = ?, death_day = ?, death_leap_month = ?, death_precision = ?,
        notes = ?, updated_at = ?, row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL
    `).run(input.displayName ?? before.displayName, input.gender ?? before.gender, ...dateValues(birth), ...dateValues(death), input.notes === undefined ? before.notes : input.notes, now, this.workspaceId, id);
    const after = this.require(id, false);
    ctx.audit.append({ entityType: "person", entityId: id, action: "update", before, after });
    return after;
  }

  archive(ctx: TransactionContext, id: string): PersonRecord {
    const before = this.require(id, false);
    const now = new Date().toISOString();
    this.database.prepare("UPDATE person SET deleted_at = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").run(now, now, this.workspaceId, id);
    const after = this.require(id, true);
    ctx.audit.append({ entityType: "person", entityId: id, action: "archive", before, after });
    return after;
  }

  restore(ctx: TransactionContext, id: string): PersonRecord {
    const before = this.require(id, true);
    if (before.deletedAt === null) throw new Error(`Person is not archived: ${id}`);
    const now = new Date().toISOString();
    this.database.prepare("UPDATE person SET deleted_at = NULL, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NOT NULL").run(now, this.workspaceId, id);
    const after = this.require(id, false);
    ctx.audit.append({ entityType: "person", entityId: id, action: "restore", before, after });
    return after;
  }

  addAlias(ctx: TransactionContext, input: CreatePersonAliasInput): PersonAliasRecord {
    this.require(input.personId, false);
    const id = input.id ?? randomUUID();
    const name = input.name.trim();
    if (!name) throw new Error("Alias name is required");
    const now = new Date().toISOString();
    this.database.prepare("INSERT INTO person_alias (id, workspace_id, person_id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, this.workspaceId, input.personId, name, name.toLowerCase(), now, now);
    const after = this.requireAlias(id, true);
    ctx.audit.append({ entityType: "person_alias", entityId: id, action: "create", before: null, after });
    return after;
  }

  archiveAlias(ctx: TransactionContext, id: string): PersonAliasRecord {
    const before = this.requireAlias(id, false);
    const now = new Date().toISOString();
    this.database.prepare("UPDATE person_alias SET deleted_at = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").run(now, now, this.workspaceId, id);
    const after = this.requireAlias(id, true);
    ctx.audit.append({ entityType: "person_alias", entityId: id, action: "archive", before, after });
    return after;
  }

  restoreAlias(ctx: TransactionContext, id: string): PersonAliasRecord {
    const before = this.requireAlias(id, true);
    if (before.deletedAt === null) throw new Error(`Person alias is not archived: ${id}`);
    const now = new Date().toISOString();
    this.database.prepare("UPDATE person_alias SET deleted_at = NULL, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND deleted_at IS NOT NULL").run(now, this.workspaceId, id);
    const after = this.requireAlias(id, false);
    ctx.audit.append({ entityType: "person_alias", entityId: id, action: "restore", before, after });
    return after;
  }

  private require(id: string, includeArchived: boolean): PersonRecord {
    const person = this.get(id, { includeArchived });
    if (!person) throw new Error(`Person not found: ${id}`);
    return person;
  }

  private requireAlias(id: string, includeArchived: boolean): PersonAliasRecord {
    const alias = this.getAlias(id, { includeArchived });
    if (!alias) throw new Error(`Person alias not found: ${id}`);
    return alias;
  }
}
