import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WikiService } from "../../../src/main/application/wiki/wiki-service";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
import { searchWiki } from "../../../src/main/application/query/search-wiki";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("wiki FTS search", () => {
  it("finds Chinese terms and keeps source-linked results current after update and soft delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-wiki-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    expect(applyMigrations(database)).toBe(4);
    const now = new Date().toISOString();
    database.prepare("INSERT INTO source (id, workspace_id, source_key, title, created_at, updated_at) VALUES ('source-a', 'workspace-1', 'a', '家谱底本', ?, ?)").run(now, now);
    database.prepare("INSERT INTO source (id, workspace_id, source_key, title, created_at, updated_at) VALUES ('source-b', 'workspace-1', 'b', '口述记录', ?, ?)").run(now, now);
    try {
      const wiki = new WikiService(database, "workspace-1");

      const first = wiki.create({ title: "张氏家谱", body: "家谱记载张家在苏州的迁徙历史。", personIds: [], sourceIds: ["source-a"] });
      const second = wiki.create({ title: "李氏家谱", body: "李家支系的旧谱补录。", personIds: [], sourceIds: ["source-b"] });
      expect(new Set(wiki.list({ limit: 100, offset: 0 }).map((entry) => entry.id))).toEqual(new Set([first.id, second.id]));
      expect(searchWiki(database, "workspace-1", { query: "家谱", limit: 10 })).toEqual(expect.arrayContaining([
        expect.objectContaining({ wikiEntryId: first.id, sourceIds: ["source-a"], excerpt: expect.stringContaining("家谱") }),
        expect.objectContaining({ wikiEntryId: second.id, sourceIds: ["source-b"] })
      ]));

      wiki.update({ wikiEntryId: first.id, title: "张氏家谱校订", body: "家谱校订后确认迁居杭州。", personIds: [], sourceIds: ["source-a", "source-b"], expectedVersion: first.rowVersion });
      expect(searchWiki(database, "workspace-1", { query: "苏州", limit: 10 })).toEqual([]);
      expect(searchWiki(database, "workspace-1", { query: "杭州", limit: 10 })).toEqual([expect.objectContaining({ wikiEntryId: first.id, sourceIds: ["source-a", "source-b"] })]);

      wiki.softDelete({ wikiEntryId: second.id, expectedVersion: second.rowVersion });
      expect(wiki.list({ limit: 100, offset: 0 }).map((entry) => entry.id)).toEqual([first.id]);
      expect(searchWiki(database, "workspace-1", { query: "李氏", limit: 10 })).toEqual([]);
      expect(searchWiki(database, "workspace-1", { query: "家谱", limit: 10 }).every((hit) => hit.excerpt.length <= 184)).toBe(true);
      expect(database.prepare("SELECT COUNT(*) FROM person").pluck().get()).toBe(0);
      expect(database.prepare("SELECT COUNT(*) FROM parent_child").pluck().get()).toBe(0);
    } finally { database.close(); }
  });
});
