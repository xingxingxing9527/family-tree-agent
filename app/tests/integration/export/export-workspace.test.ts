import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parse } from "csv-parse/sync";
import { afterEach, describe, expect, it } from "vitest";
import { ExportService, ExportValidationError, type ExportWorkspace } from "../../../src/main/application/export/export-service";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";

interface ExportFixture {
  root: string;
  workspace: ExportWorkspace;
  mediaPath: string;
  destination(name: string): Promise<string>;
}

const workspaceId = "11111111-1111-4111-8111-111111111111";
const personId = "-person-formula-id";
const childId = "person-child-id";
const mediaBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);

async function fixture(cleanup: string[]): Promise<ExportFixture> {
  const root = await mkdtemp(join(tmpdir(), "family-agent-export-"));
  cleanup.push(root);
  const appDataRoot = join(root, "app-data");
  const workspaceRoot = join(appDataRoot, "workspaces", "family-one");
  const databasePath = join(workspaceRoot, "genealogy.sqlite");
  const mediaRoot = join(workspaceRoot, "media");
  await mkdir(mediaRoot, { recursive: true });
  await writeFile(join(appDataRoot, "model.key"), "MODEL-KEY-MUST-NOT-LEAK");
  await writeFile(join(workspaceRoot, "unrelated-private.txt"), "UNRELATED-WORKSPACE-DATA");

  const now = "2026-09-16T00:00:00.000Z";
  const database = openDatabase(databasePath);
  applyMigrations(database);
  database.prepare("INSERT INTO workspace_meta (workspace_id, name, created_at, updated_at) VALUES (?, '王氏家谱', ?, ?)").run(workspaceId, now, now);
  database.prepare(`
    INSERT INTO person (
      id, workspace_id, display_name, gender,
      birth_calendar, birth_year, birth_month, birth_day, birth_leap_month, birth_precision,
      notes, created_at, updated_at
    ) VALUES (?, ?, '=HYPERLINK("https://evil.invalid")', 'male', 'lunar', 1980, 4, 2, 1, 'day', '+cmd|calc', ?, ?)
  `).run(personId, workspaceId, now, now);
  database.prepare(`
    INSERT INTO person (id, workspace_id, display_name, gender, death_calendar, death_year, death_month, death_day, death_leap_month, death_precision, created_at, updated_at)
    VALUES (?, ?, '孩子', 'unknown', 'solar', 2050, 8, NULL, 0, 'month', ?, ?)
  `).run(childId, workspaceId, now, now);
  database.prepare("INSERT INTO person_alias (id, workspace_id, person_id, name, normalized_name, created_at, updated_at) VALUES ('alias-one', ?, ?, '@alias', '@alias', ?, ?)")
    .run(workspaceId, personId, now, now);
  database.prepare("INSERT INTO parent_child (id, workspace_id, parent_id, child_id, parent_role, relationship_type, created_at, updated_at) VALUES ('parent-child-one', ?, ?, ?, 'father', 'biological', ?, ?)")
    .run(workspaceId, personId, childId, now, now);
  database.prepare(`
    INSERT INTO marriage (
      id, workspace_id, spouse_a_id, spouse_b_id, marriage_status,
      start_calendar, start_year, start_month, start_day, start_leap_month, start_precision,
      end_calendar, end_year, end_month, end_day, end_leap_month, end_precision,
      created_at, updated_at
    ) VALUES ('marriage-one', ?, ?, ?, 'divorced', 'lunar', 2000, 6, 1, 1, 'day', 'solar', 2010, 7, NULL, 0, 'month', ?, ?)
  `).run(workspaceId, personId, childId, now, now);
  database.prepare("INSERT INTO lineage (id, workspace_id, name, founder_person_id, description, created_at, updated_at) VALUES ('lineage-one', ?, '@formula-lineage', ?, '-description', ?, ?)")
    .run(workspaceId, personId, now, now);
  database.prepare("INSERT INTO lineage_membership (id, workspace_id, lineage_id, person_id, lineage_role, is_primary, declared_generation, created_at, updated_at) VALUES ('membership-one', ?, 'lineage-one', ?, 'blood', 1, 3, ?, ?)")
    .run(workspaceId, personId, now, now);
  database.prepare("INSERT INTO source (id, workspace_id, source_key, title, created_at, updated_at) VALUES ('source-one', ?, 'source-key', '来源', ?, ?)")
    .run(workspaceId, now, now);
  database.prepare("INSERT INTO wiki_entry (id, workspace_id, slug, title, content, created_at, updated_at) VALUES ('wiki-one', ?, 'family-rules', '家训', '=wiki text is JSON, not a spreadsheet cell', ?, ?)")
    .run(workspaceId, now, now);
  database.prepare("INSERT INTO wiki_person (id, workspace_id, wiki_entry_id, person_id, sort_order, created_at, updated_at) VALUES ('wiki-person-one', ?, 'wiki-one', ?, 0, ?, ?)")
    .run(workspaceId, personId, now, now);
  database.prepare("INSERT INTO wiki_source (id, workspace_id, wiki_entry_id, source_id, sort_order, created_at, updated_at) VALUES ('wiki-source-one', ?, 'wiki-one', 'source-one', 0, ?, ?)")
    .run(workspaceId, now, now);

  const sha256 = createHash("sha256").update(mediaBytes).digest("hex");
  const mediaRelativePath = `media/${sha256.slice(0, 2)}/${sha256}.jpg`;
  const mediaPath = join(workspaceRoot, mediaRelativePath);
  await mkdir(dirname(mediaPath), { recursive: true });
  await writeFile(mediaPath, mediaBytes);
  database.prepare("INSERT INTO media_asset (id, workspace_id, sha256, original_name, mime_type, byte_size, relative_path, created_at, updated_at) VALUES ('media-one', ?, ?, '=portrait.jpg', 'image/jpeg', ?, ?, ?, ?)")
    .run(workspaceId, sha256, mediaBytes.length, mediaRelativePath.replaceAll("/", "\\"), now, now);
  database.prepare("INSERT INTO media_person (id, workspace_id, media_asset_id, person_id, caption, sort_order, created_at, updated_at) VALUES ('media-person-one', ?, 'media-one', ?, '@caption', 2, ?, ?)")
    .run(workspaceId, personId, now, now);
  database.prepare("INSERT INTO operation_group (id, workspace_id, kind, created_at, updated_at) VALUES ('private-operation', ?, 'manual.edit', ?, ?)").run(workspaceId, now, now);
  database.prepare("INSERT INTO audit_log (id, workspace_id, operation_group_id, entity_type, entity_id, action, before_json, after_json, created_at, updated_at) VALUES (?, ?, 'private-operation', 'person', ?, 'update', '{}', '{}', ?, ?)")
    .run(randomUUID(), workspaceId, personId, now, now);
  database.close();

  return {
    root,
    workspace: { workspaceId, workspaceRoot, appDataRoot, databasePath, mediaRoot },
    mediaPath,
    async destination(name) {
      const value = join(root, "exports", name);
      await mkdir(value, { recursive: true });
      return value;
    }
  };
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  await visit(root);
  return result.sort();
}

const rows = async (path: string): Promise<Record<string, string>[]> => parse(await readFile(path, "utf8"), { columns: true, bom: true, skip_empty_lines: true });
const code = (value: string): Partial<ExportValidationError> => ({ code: value as ExportValidationError["code"] });

describe("workspace export", () => {
  const cleanup: string[] = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  it("writes a deterministic, privacy-safe portable export with stable IDs and complete date fields", async () => {
    const value = await fixture(cleanup);
    const first = await value.destination("first");
    const second = await value.destination("second");
    const service = new ExportService(value.workspace);

    await service.exportWorkspace(first);
    await service.exportWorkspace(second);

    const mediaManifest = JSON.parse(await readFile(join(first, "media-manifest.json"), "utf8")) as { assets: Array<{ id: string; path: string; people: Array<{ personId: string; caption: string; sortOrder: number }> }> };
    expect(await listFiles(first)).toEqual([
      "lineages.csv", "marriages.csv", "media-manifest.json", mediaManifest.assets[0]!.path,
      "parent-child.csv", "people.csv", "wiki.json"
    ].sort());
    expect(mediaManifest.assets).toEqual([expect.objectContaining({
      id: "media-one", path: expect.stringMatching(/^media\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/u),
      people: [{ personId, caption: "@caption", sortOrder: 2 }]
    })]);
    expect(mediaManifest.assets[0]!.path).not.toContain("\\");
    expect(await readFile(join(first, mediaManifest.assets[0]!.path))).toEqual(mediaBytes);

    const people = await rows(join(first, "people.csv"));
    expect(people[0]).toMatchObject({
      id: personId,
      display_name: "'=HYPERLINK(\"https://evil.invalid\")",
      aliases: "'@alias",
      birth_calendar: "lunar", birth_year: "1980", birth_month: "4", birth_day: "2", birth_leap_month: "1", birth_precision: "day",
      notes: "'+cmd|calc"
    });
    expect(people[1]).toMatchObject({ death_calendar: "solar", death_year: "2050", death_month: "8", death_day: "", death_leap_month: "0", death_precision: "month" });
    expect((await rows(join(first, "parent-child.csv")))[0]).toMatchObject({ id: "parent-child-one", parent_id: personId, child_id: childId });
    expect((await rows(join(first, "marriages.csv")))[0]).toMatchObject({
      id: "marriage-one", spouse_a_id: personId, start_calendar: "lunar", start_year: "2000", start_month: "6", start_day: "1", start_leap_month: "1", start_precision: "day",
      end_calendar: "solar", end_year: "2010", end_month: "7", end_day: "", end_leap_month: "0", end_precision: "month"
    });
    expect((await rows(join(first, "lineages.csv")))[0]).toMatchObject({ lineage_id: "lineage-one", lineage_name: "'@formula-lineage", founder_person_id: personId, description: "'-description", membership_id: "membership-one", person_id: personId });
    expect(JSON.parse(await readFile(join(first, "wiki.json"), "utf8"))).toEqual({ entries: [{ id: "wiki-one", slug: "family-rules", title: "家训", content: "=wiki text is JSON, not a spreadsheet cell", personIds: [personId], sourceIds: ["source-one"] }] });

    const firstFiles = await listFiles(first);
    expect(await listFiles(second)).toEqual(firstFiles);
    for (const file of firstFiles) expect(await readFile(join(second, file))).toEqual(await readFile(join(first, file)));
    const text = (await Promise.all(firstFiles.filter((file) => !file.startsWith("media/")).map((file) => readFile(join(first, file), "utf8")))).join("\n");
    expect(text).not.toContain(value.root);
    expect(text).not.toContain("MODEL-KEY-MUST-NOT-LEAK");
    expect(text).not.toContain("UNRELATED-WORKSPACE-DATA");
    expect(text).not.toContain("private-operation");
  });

  it("refuses protected or non-empty destinations without changing them", async () => {
    const value = await fixture(cleanup);
    const nonEmpty = await value.destination("non-empty");
    await writeFile(join(nonEmpty, "keep.txt"), "keep");
    const service = new ExportService(value.workspace);

    await expect(service.exportWorkspace(value.workspace.workspaceRoot)).rejects.toMatchObject(code("TARGET_INVALID"));
    await expect(service.exportWorkspace(value.workspace.appDataRoot)).rejects.toMatchObject(code("TARGET_INVALID"));
    await expect(service.exportWorkspace(nonEmpty)).rejects.toMatchObject(code("TARGET_NOT_EMPTY"));
    expect(await readFile(join(nonEmpty, "keep.txt"), "utf8")).toBe("keep");
  });

  it("refuses a selected destination that is itself a directory link", async () => {
    const value = await fixture(cleanup);
    const actual = await value.destination("actual-empty");
    const linked = join(value.root, "exports", "linked-empty");
    await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");

    await expect(new ExportService(value.workspace).exportWorkspace(linked)).rejects.toMatchObject(code("TARGET_INVALID"));
    expect(await readdir(actual)).toEqual([]);
  });

  it("rejects a workspace media root replaced by a directory link even when every file stays hash-valid", async () => {
    const value = await fixture(cleanup);
    const destination = await value.destination("linked-media-root");
    const linkedTarget = join(value.root, "outside-media-root");
    await rename(value.workspace.mediaRoot, linkedTarget);
    await symlink(linkedTarget, value.workspace.mediaRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(new ExportService(value.workspace).exportWorkspace(destination)).rejects.toMatchObject(code("MEDIA_INVALID"));
    expect(await readdir(destination)).toEqual([]);
  });

  it("fails atomically on a changed media object and removes only its staging directory", async () => {
    const value = await fixture(cleanup);
    const destination = await value.destination("media-failure");
    await writeFile(value.mediaPath, "tampered");

    await expect(new ExportService(value.workspace).exportWorkspace(destination)).rejects.toMatchObject(code("MEDIA_INVALID"));
    expect(await readdir(destination)).toEqual([]);
    expect((await readdir(dirname(destination))).filter((name) => name.startsWith(".family-export-"))).toEqual([]);
  });

  it("rechecks emptiness immediately before activation and preserves a racing file", async () => {
    const value = await fixture(cleanup);
    const destination = await value.destination("raced");
    const service = new ExportService(value.workspace, {
      beforeActivate: async () => { await writeFile(join(destination, "arrived.txt"), "do not remove"); }
    });

    await expect(service.exportWorkspace(destination)).rejects.toMatchObject(code("TARGET_NOT_EMPTY"));
    expect(await readFile(join(destination, "arrived.txt"), "utf8")).toBe("do not remove");
    expect((await readdir(dirname(destination))).filter((name) => name.startsWith(".family-export-"))).toEqual([]);
  });
});
