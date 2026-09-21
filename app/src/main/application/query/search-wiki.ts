import type { WorkspaceDatabase } from "../../database/open-database.js";
import type { WikiSearchHit } from "../../../shared/contracts.js";

interface WikiRow { id: string; title: string; content: string }

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (character) => `\\${character}`);

const excerpt = (content: string, query: string): string => {
  const index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, index < 0 ? 0 : index - 50);
  const bounded = content.slice(start, start + 180).trim();
  return `${start > 0 ? "…" : ""}${bounded}${start + bounded.length < content.length ? "…" : ""}`;
};

export function searchWiki(
  database: WorkspaceDatabase,
  workspaceId: string,
  input: { query: string; limit: number }
): WikiSearchHit[] {
  const query = input.query.trim();
  if (!query) return [];
  const pattern = `%${escapeLike(query)}%`;
  const limit = Math.max(1, Math.min(20, Math.trunc(input.limit)));
  const rows = database.prepare(`
    SELECT id, title, content
    FROM wiki_entry
    WHERE workspace_id = ?
      AND deleted_at IS NULL
      AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
    ORDER BY title, id
    LIMIT ?
  `).all(workspaceId, pattern, pattern, limit) as WikiRow[];
  return rows.map((row) => ({
    wikiEntryId: row.id,
    title: row.title,
    excerpt: excerpt(row.content, query),
    sourceIds: []
  }));
}
