import type { WorkspaceDatabase } from "./open-database.js";

interface AllocatedRow { allocated: number; }

export function allocatePersonCode(database: WorkspaceDatabase, workspaceId: string): string {
  database.prepare(`
    INSERT INTO person_code_counter (workspace_id, last_value)
    VALUES (?, 0)
    ON CONFLICT(workspace_id) DO NOTHING
  `).run(workspaceId);
  const row = database.prepare(`
    UPDATE person_code_counter
    SET last_value = last_value + 1
    WHERE workspace_id = ?
    RETURNING last_value AS allocated
  `).get(workspaceId) as AllocatedRow | undefined;
  if (!row || row.allocated < 1 || row.allocated > 999999) throw new Error("Person code space is exhausted");
  return `P${String(row.allocated).padStart(6, "0")}`;
}
