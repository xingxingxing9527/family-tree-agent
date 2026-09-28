import { randomUUID } from "node:crypto";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { MergeRepository, type MergeSnapshot, type PostVersion } from "../../database/repositories/merge-repository.js";
import { PersonRepository, type PersonRecord } from "../../database/repositories/person-repository.js";
import { SqliteUnitOfWork, type TransactionContext } from "../../database/unit-of-work.js";
import { MergePreviewService } from "./merge-preview-service.js";
import type { MergeDecision } from "./merge-types.js";

type Raw = Record<string, unknown>;
type Table = "person" | "person_alias" | "lineage" | "lineage_membership" | "parent_child" | "marriage" | "import_identity" | "media_person" | "wiki_person" | "workspace_meta";
const idFor = (table: Table, row: Raw): string => String(table === "workspace_meta" ? row.workspace_id : row.id);
const now = (): string => new Date().toISOString();

export class PersonMergeService {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}

  resolveRedirect(id: string): string {
    let current = id;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const redirect = this.database.prepare("SELECT new_person_id FROM id_redirect WHERE workspace_id = ? AND old_person_id = ?").get(this.workspaceId, current) as { new_person_id: string } | undefined;
      if (!redirect) return current;
      current = redirect.new_person_id;
    }
    throw new Error("Redirect cycle detected");
  }

  mergePeople(decision: MergeDecision): { id: string; status: "active"; operationGroupId: string } {
    if (decision.primaryPersonId === decision.secondaryPersonId) throw new Error("People must be different");
    const preview = new MergePreviewService(this.database, this.workspaceId).previewMerge(decision.primaryPersonId, decision.secondaryPersonId);
    this.assertFresh(preview.expectedVersions, decision.expectedVersions);
    const snapshot = this.snapshot(preview);
    this.assertProjectedInvariants(decision.primaryPersonId, decision.secondaryPersonId);
    const mergeId = randomUUID();
    const redirectId = randomUUID();
    return new SqliteUnitOfWork(this.database, this.workspaceId).run("person.merge", (ctx) => {
      const changed: Array<{ table: Table; id: string; entityType: string }> = [];
      const touch = (table: Table, id: string, entityType = table): void => { if (!changed.some((entry) => entry.table === table && entry.id === id)) changed.push({ table, id, entityType }); };
      const primary = new PersonRepository(this.database, this.workspaceId).get(decision.primaryPersonId)!;
      const secondary = new PersonRepository(this.database, this.workspaceId).get(decision.secondaryPersonId)!;
      const personFields: Record<string, unknown> = {
        display_name: this.choice("displayName", primary.displayName, secondary.displayName, decision),
        gender: this.choice("gender", primary.gender, secondary.gender, decision),
        ...this.dateColumns("birth", this.choice("birth", primary.birth, secondary.birth, decision) as PersonRecord["birth"]),
        ...this.dateColumns("death", this.choice("death", primary.death, secondary.death, decision) as PersonRecord["death"]),
        notes: this.choice("notes", primary.notes, secondary.notes, decision)
      };
      this.update("person", decision.primaryPersonId, personFields); touch("person", decision.primaryPersonId);
      this.archive("person", decision.secondaryPersonId); touch("person", decision.secondaryPersonId);
      for (const entry of snapshot.rows.person_alias ?? []) { this.migrateOrArchive("person_alias", entry, "person_id", decision.primaryPersonId, ["person_id", "normalized_name"]); touch("person_alias", String(entry.id)); }
      for (const entry of snapshot.rows.lineage ?? []) { this.update("lineage", String(entry.id), { founder_person_id: decision.primaryPersonId }); touch("lineage", String(entry.id)); }
      for (const entry of (snapshot.rows.lineage_membership ?? []).filter((row) => row.person_id === decision.secondaryPersonId)) { this.migrateMembership(entry, decision.primaryPersonId); touch("lineage_membership", String(entry.id)); }
      for (const entry of snapshot.rows.parent_child ?? []) {
        if (entry.parent_id !== decision.secondaryPersonId && entry.child_id !== decision.secondaryPersonId) continue;
        const parent = entry.parent_id === decision.secondaryPersonId ? decision.primaryPersonId : String(entry.parent_id);
        const child = entry.child_id === decision.secondaryPersonId ? decision.primaryPersonId : String(entry.child_id);
        this.migrateRelationOrArchive("parent_child", entry, { parent_id: parent, child_id: child }, ["parent_id", "child_id"]); touch("parent_child", String(entry.id));
      }
      for (const entry of snapshot.rows.marriage ?? []) {
        if (entry.spouse_a_id !== decision.secondaryPersonId && entry.spouse_b_id !== decision.secondaryPersonId) continue;
        const a = entry.spouse_a_id === decision.secondaryPersonId ? decision.primaryPersonId : String(entry.spouse_a_id);
        const b = entry.spouse_b_id === decision.secondaryPersonId ? decision.primaryPersonId : String(entry.spouse_b_id);
        const [spouseA, spouseB] = [a, b].sort(); this.migrateRelationOrArchive("marriage", entry, { spouse_a_id: spouseA, spouse_b_id: spouseB }, ["spouse_a_id", "spouse_b_id"]); touch("marriage", String(entry.id));
      }
      for (const [table, column] of [["import_identity", "person_id"], ["media_person", "person_id"], ["wiki_person", "person_id"]] as const) {
        for (const entry of snapshot.rows[table] ?? []) { this.migrateOrArchive(table, entry, column, decision.primaryPersonId, table === "media_person" ? ["media_asset_id", "person_id"] : table === "wiki_person" ? ["wiki_entry_id", "person_id"] : []); touch(table, String(entry.id)); }
      }
      for (const entry of snapshot.rows.workspace_meta ?? []) { this.update("workspace_meta", String(entry.workspace_id), { origin_person_id: decision.primaryPersonId }); touch("workspace_meta", String(entry.workspace_id)); }
      const predicted: PostVersion[] = changed.map(({ table, id, entityType }) => ({ entityType, entityId: id, rowVersion: Number(this.current(table, id).row_version) }));
      predicted.push({ entityType: "merge_record", entityId: mergeId, rowVersion: 1 }, { entityType: "id_redirect", entityId: redirectId, rowVersion: 1 });
      const timestamp = now();
      this.database.prepare("INSERT INTO merge_record (id, workspace_id, survivor_person_id, merged_person_id, operation_group_id, status, snapshot_json, post_versions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)")
        .run(mergeId, this.workspaceId, decision.primaryPersonId, decision.secondaryPersonId, ctx.operationGroupId, JSON.stringify(snapshot), JSON.stringify(predicted), timestamp, timestamp);
      this.database.prepare("INSERT INTO id_redirect (id, workspace_id, old_person_id, new_person_id, merge_record_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(redirectId, this.workspaceId, decision.secondaryPersonId, decision.primaryPersonId, mergeId, timestamp, timestamp);
      for (const change of changed) this.audit(ctx, change.entityType, change.id, "merge-migrate", this.findSnapshot(snapshot, change.table, change.id), this.current(change.table, change.id));
      this.audit(ctx, "merge_record", mergeId, "merge", null, this.current("merge_record" as Table, mergeId));
      this.audit(ctx, "id_redirect", redirectId, "merge-redirect", null, this.current("id_redirect" as Table, redirectId));
      return { id: mergeId, status: "active" as const, operationGroupId: ctx.operationGroupId };
    });
  }

  private snapshot(preview: ReturnType<MergePreviewService["previewMerge"]>): MergeSnapshot {
    const rows: Record<string, Raw[]> = { person: [this.current("person", preview.primary.id), this.current("person", preview.secondary.id)] };
    const add = (table: Table, values: readonly Raw[]): void => { if (values.length) rows[table] = [...new Map(values.map((entry) => [idFor(table, entry), this.current(table, idFor(table, entry))])).values()]; };
    add("person_alias", preview.aliases); add("parent_child", [...preview.parents, ...preview.children].filter((entry) => entry.parent_id === preview.secondary.id || entry.child_id === preview.secondary.id)); add("marriage", preview.spouses.filter((entry) => entry.spouse_a_id === preview.secondary.id || entry.spouse_b_id === preview.secondary.id));
    add("lineage", preview.lineages.filter((entry) => entry.membership_id === null).map((entry) => ({ id: entry.lineage_id })));
    add("lineage_membership", preview.lineages.filter((entry) => entry.membership_id !== null && entry.person_id === preview.secondary.id).map((entry) => ({ id: entry.membership_id })));
    add("media_person", preview.media); add("wiki_person", this.rows("wiki_person", "person_id = ?", preview.secondary.id)); add("import_identity", this.rows("import_identity", "person_id = ?", preview.secondary.id));
    add("workspace_meta", this.rows("workspace_meta", "origin_person_id = ?", preview.secondary.id));
    return { rows };
  }
  private rows(table: Table, filter: string, value: string): Raw[] {
    const archived = table === "workspace_meta" ? "" : " AND deleted_at IS NULL";
    return this.database.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND ${filter}${archived}`).all(this.workspaceId, value) as Raw[];
  }
  private current(table: Table, id: string): Raw {
    const sql = table === "workspace_meta" ? "SELECT * FROM workspace_meta WHERE workspace_id = ?" : `SELECT * FROM ${table} WHERE workspace_id = ? AND id = ?`;
    const value = table === "workspace_meta" ? this.database.prepare(sql).get(this.workspaceId) : this.database.prepare(sql).get(this.workspaceId, id);
    if (!value) throw new Error(`Missing ${table}: ${id}`); return value as Raw;
  }
  private findSnapshot(snapshot: MergeSnapshot, table: Table, id: string): Raw | null { return snapshot.rows[table]?.find((entry) => idFor(table, entry) === id) ?? null; }
  private update(table: Table, id: string, fields: Raw): void {
    const assignments = [...Object.keys(fields).map((key) => `${key} = ?`), "updated_at = ?", "row_version = row_version + 1"].join(", ");
    const sql = table === "workspace_meta" ? `UPDATE ${table} SET ${assignments} WHERE workspace_id = ?` : `UPDATE ${table} SET ${assignments} WHERE workspace_id = ? AND id = ?`;
    const values = [...Object.values(fields), now(), this.workspaceId, ...(table === "workspace_meta" ? [] : [id])]; this.database.prepare(sql).run(...values);
  }
  private archive(table: Table, id: string): void { this.update(table, id, { deleted_at: now() }); }
  private migrateOrArchive(table: Table, entry: Raw, column: string, value: string, uniqueColumns: string[]): void {
    const id = String(entry.id);
    if (uniqueColumns.length) {
      const where = uniqueColumns.map((key) => `${key} = ?`).join(" AND ");
      const values = uniqueColumns.map((key) => key === column ? value : entry[key]);
      const duplicate = this.database.prepare(`SELECT id FROM ${table} WHERE workspace_id = ? AND deleted_at IS NULL AND ${where} AND id <> ?`).get(this.workspaceId, ...values, id);
      if (duplicate) {
        this.archive(table, id);
        // Retain the canonical ID even on the archived duplicate so no live or historical reference points at the merged person.
        this.update(table, id, { [column]: value });
        return;
      }
    }
    this.update(table, id, { [column]: value });
  }
  private migrateRelationOrArchive(table: "parent_child" | "marriage", entry: Raw, fields: Raw, uniqueColumns: string[]): void {
    const id = String(entry.id); const where = uniqueColumns.map((key) => `${key} = ?`).join(" AND "); const values = uniqueColumns.map((key) => fields[key]);
    const duplicate = this.database.prepare(`SELECT id FROM ${table} WHERE workspace_id = ? AND deleted_at IS NULL AND ${where} AND id <> ?`).get(this.workspaceId, ...values, id);
    if (duplicate) { this.archive(table, id); this.update(table, id, fields); return; }
    this.update(table, id, fields);
  }
  private migrateMembership(entry: Raw, primaryId: string): void {
    const id = String(entry.id); const sameLineage = this.database.prepare("SELECT id FROM lineage_membership WHERE workspace_id = ? AND lineage_id = ? AND person_id = ? AND deleted_at IS NULL AND id <> ?").get(this.workspaceId, entry.lineage_id, primaryId, id);
    if (sameLineage) { this.archive("lineage_membership", id); this.update("lineage_membership", id, { person_id: primaryId, is_primary: 0 }); return; }
    const primaryMembership = this.database.prepare("SELECT id FROM lineage_membership WHERE workspace_id = ? AND person_id = ? AND is_primary = 1 AND deleted_at IS NULL").get(this.workspaceId, primaryId) as { id: string } | undefined;
    this.update("lineage_membership", id, { person_id: primaryId, ...(entry.is_primary === 1 && primaryMembership ? { is_primary: 0 } : {}) });
  }
  private choice(field: string, primary: unknown, secondary: unknown, decision: MergeDecision): unknown { return decision.scalarChoices[field] === "secondary" ? secondary : primary; }
  private dateColumns(prefix: "birth" | "death", date: PersonRecord["birth"]): Raw {
    if (!date) return { [`${prefix}_calendar`]: null, [`${prefix}_year`]: null, [`${prefix}_month`]: null, [`${prefix}_day`]: null, [`${prefix}_leap_month`]: 0, [`${prefix}_precision`]: null };
    return { [`${prefix}_calendar`]: date.calendar, [`${prefix}_year`]: date.year, [`${prefix}_month`]: date.month, [`${prefix}_day`]: date.day, [`${prefix}_leap_month`]: date.leapMonth ? 1 : 0, [`${prefix}_precision`]: date.precision };
  }
  private assertFresh(actual: Record<string, number>, expected: Record<string, number>): void {
    const actualIds = Object.keys(actual).sort(); const expectedIds = Object.keys(expected).sort();
    if (actualIds.join("|") !== expectedIds.join("|") || actualIds.some((id) => actual[id] !== expected[id])) throw new Error("Merge data changed since preview");
  }
  private assertProjectedInvariants(primaryId: string, secondaryId: string): void {
    const map = (id: string): string => id === secondaryId ? primaryId : id;
    const edges = this.database.prepare("SELECT parent_id, child_id, parent_role FROM parent_child WHERE workspace_id = ? AND deleted_at IS NULL").all(this.workspaceId) as Array<{ parent_id: string; child_id: string; parent_role: "father" | "mother" }>;
    const prospective = [...new Map(edges.map((edge) => { const parent = map(edge.parent_id); const child = map(edge.child_id); return [`${parent}|${child}`, { parent, child, role: edge.parent_role }]; })).values()];
    if (prospective.some((edge) => edge.parent === edge.child)) throw new Error("A person cannot be their own parent");
    for (const role of ["father", "mother"] as const) {
      const counts = new Map<string, number>(); for (const edge of prospective.filter((entry) => entry.role === role)) counts.set(edge.child, (counts.get(edge.child) ?? 0) + 1);
      if ([...counts.values()].some((count) => count > 1)) throw new Error(`Merge would create a second biological ${role}`);
    }
    const graph = new Map<string, string[]>(); for (const edge of prospective) graph.set(edge.parent, [...(graph.get(edge.parent) ?? []), edge.child]);
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); if ((graph.get(id) ?? []).some(visit)) return true; visiting.delete(id); visited.add(id); return false; };
    if ([...graph.keys()].some(visit)) throw new Error("Merge would create a parent cycle");
    const marriages = [...new Map((this.database.prepare("SELECT spouse_a_id, spouse_b_id FROM marriage WHERE workspace_id = ? AND deleted_at IS NULL").all(this.workspaceId) as Array<{ spouse_a_id: string; spouse_b_id: string }>).map((entry) => { const [a, b] = [map(entry.spouse_a_id), map(entry.spouse_b_id)].sort(); return [`${a}|${b}`, { spouse_a_id: a, spouse_b_id: b }]; })).values()];
    if (marriages.some((entry) => map(entry.spouse_a_id) === map(entry.spouse_b_id))) throw new Error("A person cannot marry themselves");
  }
  private audit(ctx: TransactionContext, entityType: string, entityId: string, action: string, before: unknown, after: unknown): void { ctx.audit.append({ entityType, entityId, action, before, after }); }
}
