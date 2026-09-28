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
  const ftsQuery = query.split(/\s+/).filter(Boolean).map((term) => `"${[...term].map((character) => character.replace(/"/g, '""')).join(" ")}"`).join(" AND ");
  const limit = Math.max(1, Math.min(20, Math.trunc(input.limit)));
  if (!/[\p{L}\p{N}]/u.test(query)) {
    const pattern = `%${escapeLike(query)}%`;
    const rows = database.prepare("SELECT id, title, content FROM wiki_entry WHERE workspace_id = ? AND deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY title, id LIMIT ?").all(workspaceId, pattern, pattern, limit) as WikiRow[];
    return rows.map((row) => ({ wikiEntryId: row.id, title: row.title, excerpt: excerpt(row.content, query), sourceIds: database.prepare("SELECT source_id FROM wiki_source WHERE workspace_id = ? AND wiki_entry_id = ? AND deleted_at IS NULL ORDER BY sort_order, id").pluck().all(workspaceId, row.id) as string[] }));
  }
  const rows = database.prepare(`
    SELECT entry.id, entry.title, entry.content
    FROM wiki_fts
    JOIN wiki_entry AS entry ON entry.id = wiki_fts.wiki_entry_id
    WHERE wiki_fts.workspace_id = ? AND wiki_fts MATCH ? AND entry.deleted_at IS NULL
    ORDER BY bm25(wiki_fts), entry.title, entry.id
    LIMIT ?
  `).all(workspaceId, ftsQuery, limit) as WikiRow[];
  return rows.map((row) => ({
    wikiEntryId: row.id,
    title: row.title,
    excerpt: excerpt(row.content, query),
    sourceIds: database.prepare("SELECT source_id FROM wiki_source WHERE workspace_id = ? AND wiki_entry_id = ? AND deleted_at IS NULL ORDER BY sort_order, id").pluck().all(workspaceId, row.id) as string[]
  }));
}
