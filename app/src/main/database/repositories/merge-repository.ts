import type { WorkspaceDatabase } from "../open-database.js";

export interface PostVersion { entityType: string; entityId: string; rowVersion: number; }
export interface MergeSnapshot { rows: Record<string, Record<string, unknown>[]>; }
export interface MergeRecord {
  id: string; workspaceId: string; survivorPersonId: string; mergedPersonId: string;
  operationGroupId: string; status: "active" | "reversed"; snapshot: MergeSnapshot;
  postVersions: PostVersion[]; reversedOperationGroupId: string | null; createdAt: string; updatedAt: string; rowVersion: number;
}

interface Row {
  id: string; workspace_id: string; survivor_person_id: string; merged_person_id: string;
  operation_group_id: string; status: "active" | "reversed"; snapshot_json: string;
  post_versions_json: string; reversed_operation_group_id: string | null;
  created_at: string; updated_at: string; row_version: number;
}

const record = (row: Row): MergeRecord => ({
  id: row.id, workspaceId: row.workspace_id, survivorPersonId: row.survivor_person_id,
  mergedPersonId: row.merged_person_id, operationGroupId: row.operation_group_id,
  status: row.status, snapshot: JSON.parse(row.snapshot_json) as MergeSnapshot,
  postVersions: JSON.parse(row.post_versions_json) as PostVersion[],
  reversedOperationGroupId: row.reversed_operation_group_id, createdAt: row.created_at,
  updatedAt: row.updated_at, rowVersion: row.row_version
});

export class MergeRepository {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}
  get(id: string): MergeRecord | null {
    const row = this.database.prepare("SELECT * FROM merge_record WHERE workspace_id = ? AND id = ?").get(this.workspaceId, id) as Row | undefined;
    return row ? record(row) : null;
  }
  list(): MergeRecord[] {
    return (this.database.prepare("SELECT * FROM merge_record WHERE workspace_id = ? ORDER BY created_at DESC, id DESC").all(this.workspaceId) as Row[]).map(record);
  }
}
