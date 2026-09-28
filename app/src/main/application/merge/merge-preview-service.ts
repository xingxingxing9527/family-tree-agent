import type { WorkspaceDatabase } from "../../database/open-database.js";
import { PersonRepository } from "../../database/repositories/person-repository.js";
import type { MergePreview } from "./merge-types.js";

const row = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const ordered = (db: WorkspaceDatabase, sql: string, ...values: unknown[]): Array<Record<string, unknown>> => db.prepare(sql).all(...values).map(row);
const version = (value: Record<string, unknown>): [string, number] => [String(value.id ?? value.workspace_id), Number(value.row_version)];

export class MergePreviewService {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}

  previewMerge(primaryId: string, secondaryId: string): MergePreview {
    if (primaryId === secondaryId) throw new Error("People must be different");
    const people = new PersonRepository(this.database, this.workspaceId);
    const primary = people.get(primaryId);
    const secondary = people.get(secondaryId);
    if (!primary || !secondary) throw new Error("Person not found");
    const aliases = ordered(this.database, "SELECT * FROM person_alias WHERE workspace_id = ? AND person_id = ? AND deleted_at IS NULL", this.workspaceId, secondaryId);
    const parents = ordered(this.database, "SELECT * FROM parent_child WHERE workspace_id = ? AND child_id IN (?, ?) AND deleted_at IS NULL", this.workspaceId, primaryId, secondaryId);
    const children = ordered(this.database, "SELECT * FROM parent_child WHERE workspace_id = ? AND parent_id IN (?, ?) AND deleted_at IS NULL", this.workspaceId, primaryId, secondaryId);
    const spouses = ordered(this.database, "SELECT * FROM marriage WHERE workspace_id = ? AND (spouse_a_id IN (?, ?) OR spouse_b_id IN (?, ?)) AND deleted_at IS NULL", this.workspaceId, primaryId, secondaryId, primaryId, secondaryId);
    const lineageRows = [
      ...ordered(this.database, "SELECT l.*, l.id AS lineage_id, l.row_version AS lineage_row_version, NULL AS membership_id FROM lineage l WHERE l.workspace_id = ? AND l.founder_person_id = ? AND l.deleted_at IS NULL", this.workspaceId, secondaryId),
      ...ordered(this.database, "SELECT lm.*, lm.id AS membership_id FROM lineage_membership lm WHERE lm.workspace_id = ? AND lm.person_id IN (?, ?) AND lm.deleted_at IS NULL", this.workspaceId, primaryId, secondaryId)
    ];
    const lineages: Array<Record<string, unknown> & { membershipId?: string }> = lineageRows.map((entry) => ({ ...entry, membershipId: entry.membership_id === null ? undefined : String(entry.membership_id) }));
    const media = ordered(this.database, "SELECT mp.*, mp.id AS link_id FROM media_person mp WHERE mp.workspace_id = ? AND mp.person_id = ? AND mp.deleted_at IS NULL", this.workspaceId, secondaryId).map((entry) => ({ ...entry, linkId: String(entry.link_id) }));
    const wiki = ordered(this.database, "SELECT * FROM wiki_person WHERE workspace_id = ? AND person_id = ? AND deleted_at IS NULL", this.workspaceId, secondaryId);
    const imports = ordered(this.database, "SELECT * FROM import_identity WHERE workspace_id = ? AND person_id = ? AND deleted_at IS NULL", this.workspaceId, secondaryId);
    const workspace = ordered(this.database, "SELECT workspace_id, row_version FROM workspace_meta WHERE workspace_id = ? AND origin_person_id = ?", this.workspaceId, secondaryId);
    const sources = ordered(this.database, "SELECT DISTINCT s.* FROM source s JOIN import_identity i ON i.source_id = s.id WHERE i.workspace_id = ? AND i.person_id = ? AND s.deleted_at IS NULL", this.workspaceId, secondaryId);
    const expectedVersions = Object.fromEntries([
      [primary.id, primary.rowVersion], [secondary.id, secondary.rowVersion], ...aliases.map(version), ...parents.map(version), ...children.map(version), ...spouses.map(version),
      ...lineages.filter((entry) => entry.membershipId !== undefined).map(version), ...lineages.filter((entry) => entry.membershipId === undefined).map((entry) => [String(entry.lineage_id), Number(entry.lineage_row_version)] as [string, number]),
      ...media.map(version), ...wiki.map(version), ...imports.map(version), ...workspace.map((entry) => [String(entry.workspace_id), Number(entry.row_version)] as [string, number])
    ]);
    const scalarConflicts = (["displayName", "gender", "birth", "death", "notes"] as const).filter((field) => JSON.stringify(primary[field]) !== JSON.stringify(secondary[field])).map((field) => ({ field, primary: primary[field], secondary: secondary[field] }));
    return { primary, secondary, scalarConflicts, aliases, parents, children, spouses, lineages, media, sources, wikiLinks: wiki, importIdentities: imports, workspaceOrigins: workspace, expectedVersions };
  }
}
