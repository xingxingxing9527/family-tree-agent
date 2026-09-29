import { randomUUID } from "node:crypto";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { createUnitOfWork } from "../../database/unit-of-work.js";

export interface WikiEntryDto {
  id: string;
  slug: string;
  title: string;
  body: string;
  personIds: string[];
  sourceIds: string[];
  rowVersion: number;
}

export interface WikiDraft {
  title: string;
  body: string;
  personIds: string[];
  sourceIds: string[];
}

interface WikiRow { id: string; slug: string; title: string; content: string; row_version: number; }
interface WikiPersonLinkRow { wiki_entry_id: string; person_id: string; }
interface WikiSourceLinkRow { wiki_entry_id: string; source_id: string; }

const uniqueIds = (ids: string[]): string[] => [...new Set(ids)];
const slugFor = (title: string): string => {
  const normalized = title.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${normalized || "wiki"}-${randomUUID().slice(0, 8)}`;
};

export class WikiService {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}

  create(input: WikiDraft): WikiEntryDto {
    const title = input.title.trim();
    if (!title) throw new Error("Wiki title is required");
    return createUnitOfWork(this.database, this.workspaceId).run("wiki-create", (ctx) => {
      const id = randomUUID(); const now = new Date().toISOString();
      this.database.prepare("INSERT INTO wiki_entry (id, workspace_id, slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, this.workspaceId, slugFor(title), title, input.body, now, now);
      this.replaceLinks(ctx.audit, id, input.personIds, input.sourceIds, now);
      const after = this.read(id);
      ctx.audit.append({ entityType: "wiki_entry", entityId: id, action: "create", before: null, after });
      return after;
    });
  }

  update(input: WikiDraft & { wikiEntryId: string; expectedVersion: number }): WikiEntryDto {
    const title = input.title.trim();
    if (!title) throw new Error("Wiki title is required");
    return createUnitOfWork(this.database, this.workspaceId).run("wiki-update", (ctx) => {
      const before = this.read(input.wikiEntryId); const now = new Date().toISOString();
      const changed = this.database.prepare("UPDATE wiki_entry SET title = ?, content = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND row_version = ?")
        .run(title, input.body, now, input.wikiEntryId, this.workspaceId, input.expectedVersion).changes;
      if (changed !== 1) throw new Error("Wiki entry changed since it was opened");
      this.archiveLinks(ctx.audit, input.wikiEntryId, now);
      this.replaceLinks(ctx.audit, input.wikiEntryId, input.personIds, input.sourceIds, now);
      const after = this.read(input.wikiEntryId);
      ctx.audit.append({ entityType: "wiki_entry", entityId: input.wikiEntryId, action: "update", before, after });
      return after;
    });
  }

  softDelete(input: { wikiEntryId: string; expectedVersion: number }): void {
    createUnitOfWork(this.database, this.workspaceId).run("wiki-delete", (ctx) => {
      const before = this.read(input.wikiEntryId); const now = new Date().toISOString();
      const changed = this.database.prepare("UPDATE wiki_entry SET deleted_at = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND row_version = ?")
        .run(now, now, input.wikiEntryId, this.workspaceId, input.expectedVersion).changes;
      if (changed !== 1) throw new Error("Wiki entry changed since it was opened");
      this.archiveLinks(ctx.audit, input.wikiEntryId, now);
      ctx.audit.append({ entityType: "wiki_entry", entityId: input.wikiEntryId, action: "delete", before, after: null });
    });
  }

  get(wikiEntryId: string): WikiEntryDto { return this.read(wikiEntryId); }

  list(input: { limit: number; offset: number }): WikiEntryDto[] {
    const rows = this.database.prepare(`
      SELECT id, slug, title, content, row_version FROM wiki_entry
      WHERE workspace_id = ? AND deleted_at IS NULL
      ORDER BY title, id LIMIT ? OFFSET ?
    `).all(this.workspaceId, input.limit, input.offset) as WikiRow[];
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(", ");
    const ids = rows.map((row) => row.id);
    const personLinks = this.database.prepare(`
      SELECT wiki_entry_id, person_id FROM wiki_person
      WHERE workspace_id = ? AND deleted_at IS NULL AND wiki_entry_id IN (${placeholders})
      ORDER BY wiki_entry_id, sort_order, id
    `).all(this.workspaceId, ...ids) as WikiPersonLinkRow[];
    const sourceLinks = this.database.prepare(`
      SELECT wiki_entry_id, source_id FROM wiki_source
      WHERE workspace_id = ? AND deleted_at IS NULL AND wiki_entry_id IN (${placeholders})
      ORDER BY wiki_entry_id, sort_order, id
    `).all(this.workspaceId, ...ids) as WikiSourceLinkRow[];
    const peopleByEntry = new Map<string, string[]>();
    for (const link of personLinks) {
      const linked = peopleByEntry.get(link.wiki_entry_id) ?? [];
      linked.push(link.person_id);
      peopleByEntry.set(link.wiki_entry_id, linked);
    }
    const sourcesByEntry = new Map<string, string[]>();
    for (const link of sourceLinks) {
      const linked = sourcesByEntry.get(link.wiki_entry_id) ?? [];
      linked.push(link.source_id);
      sourcesByEntry.set(link.wiki_entry_id, linked);
    }
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      body: row.content,
      personIds: peopleByEntry.get(row.id) ?? [],
      sourceIds: sourcesByEntry.get(row.id) ?? [],
      rowVersion: row.row_version
    }));
  }

  private read(id: string): WikiEntryDto {
    const row = this.database.prepare("SELECT id, slug, title, content, row_version FROM wiki_entry WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL").get(id, this.workspaceId) as WikiRow | undefined;
    if (!row) throw new Error("Wiki entry not found");
    const personIds = this.database.prepare("SELECT person_id FROM wiki_person WHERE workspace_id = ? AND wiki_entry_id = ? AND deleted_at IS NULL ORDER BY sort_order, id").pluck().all(this.workspaceId, id) as string[];
    const sourceIds = this.database.prepare("SELECT source_id FROM wiki_source WHERE workspace_id = ? AND wiki_entry_id = ? AND deleted_at IS NULL ORDER BY sort_order, id").pluck().all(this.workspaceId, id) as string[];
    return { id: row.id, slug: row.slug, title: row.title, body: row.content, personIds, sourceIds, rowVersion: row.row_version };
  }

  private archiveLinks(audit: { append(input: { entityType: string; entityId: string; action: string; before: unknown; after: unknown }): unknown }, wikiEntryId: string, now: string): void {
    for (const table of ["wiki_person", "wiki_source"] as const) {
      const rows = this.database.prepare(`SELECT id FROM ${table} WHERE workspace_id = ? AND wiki_entry_id = ? AND deleted_at IS NULL`).pluck().all(this.workspaceId, wikiEntryId) as string[];
      this.database.prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ?, row_version = row_version + 1 WHERE workspace_id = ? AND wiki_entry_id = ? AND deleted_at IS NULL`).run(now, now, this.workspaceId, wikiEntryId);
      for (const id of rows) audit.append({ entityType: table, entityId: id, action: "archive", before: { wikiEntryId }, after: null });
    }
  }

  private replaceLinks(audit: { append(input: { entityType: string; entityId: string; action: string; before: unknown; after: unknown }): unknown }, wikiEntryId: string, personIds: string[], sourceIds: string[], now: string): void {
    for (const [table, column, ids] of [["wiki_person", "person_id", uniqueIds(personIds)], ["wiki_source", "source_id", uniqueIds(sourceIds)]] as const) {
      ids.forEach((linkedId, sortOrder) => {
        const id = randomUUID();
        this.database.prepare(`INSERT INTO ${table} (id, workspace_id, wiki_entry_id, ${column}, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, this.workspaceId, wikiEntryId, linkedId, sortOrder, now, now);
        audit.append({ entityType: table, entityId: id, action: "create", before: null, after: { wikiEntryId, linkedId } });
      });
    }
  }
}
