import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { openQueryDatabase } from "../../database/open-query-database.js";

export interface ExportWorkspace {
  workspaceId: string;
  workspaceRoot: string;
  appDataRoot: string;
  databasePath: string;
  mediaRoot: string;
}

export interface ExportResult {
  files: number;
  mediaAssets: number;
}

export interface ExportHooks {
  beforeActivate?(): Promise<void>;
}

export type ExportErrorCode = "TARGET_INVALID" | "TARGET_NOT_EMPTY" | "DATABASE_INVALID" | "MEDIA_INVALID" | "EXPORT_FAILED";

export class ExportValidationError extends Error {
  readonly name = "ExportValidationError";
  constructor(readonly code: ExportErrorCode, message: string) { super(message); }
}

type Scalar = string | number | null;
type Row = Record<string, Scalar>;
interface AliasRow { person_id: string; name: string; }
interface WikiLinkRow { wiki_entry_id: string; linked_id: string; sort_order: number; link_id: string; }
interface MediaRow { id: string; sha256: string; original_name: string; mime_type: string; byte_size: number; relative_path: string; }
interface MediaPersonRow { media_asset_id: string; person_id: string; caption: string | null; sort_order: number; link_id: string; }

interface ExportSnapshot {
  people: Row[];
  parentChild: Row[];
  marriages: Row[];
  lineages: Row[];
  wiki: Array<{ id: string; slug: string; title: string; content: string; personIds: string[]; sourceIds: string[] }>;
  media: Array<MediaRow & { path: string; people: Array<{ personId: string; caption: string | null; sortOrder: number }> }>;
}

const peopleHeaders = [
  "id", "display_name", "aliases", "gender",
  "birth_calendar", "birth_year", "birth_month", "birth_day", "birth_leap_month", "birth_precision",
  "death_calendar", "death_year", "death_month", "death_day", "death_leap_month", "death_precision", "notes"
] as const;
const parentChildHeaders = ["id", "parent_id", "child_id", "parent_role", "relationship_type"] as const;
const marriageHeaders = [
  "id", "spouse_a_id", "spouse_b_id", "marriage_status",
  "start_calendar", "start_year", "start_month", "start_day", "start_leap_month", "start_precision",
  "end_calendar", "end_year", "end_month", "end_day", "end_leap_month", "end_precision"
] as const;
const lineageHeaders = ["lineage_id", "lineage_name", "founder_person_id", "description", "membership_id", "person_id", "lineage_role", "is_primary", "declared_generation"] as const;

const humanColumns = {
  people: new Set(["display_name", "aliases", "notes"]),
  lineages: new Set(["lineage_name", "description"])
};

const normalizeCase = (path: string): string => process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
const contains = (root: string, candidate: string): boolean => {
  const part = relative(root, candidate);
  return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
};
const overlaps = (first: string, second: string): boolean => contains(first, second) || contains(second, first);

const neutralizeFormula = (value: Scalar): Scalar => {
  if (typeof value !== "string" || !/^[\u0000-\u0020]*[=+@-]/u.test(value)) return value;
  return `'${value}`;
};

const quoteCsv = (value: Scalar): string => `"${String(value ?? "").replaceAll('"', '""')}"`;
const makeCsv = (headers: readonly string[], values: readonly Row[], human: ReadonlySet<string> = new Set()): string => {
  const lines = [headers.map(quoteCsv).join(",")];
  for (const row of values) lines.push(headers.map((header) => quoteCsv(human.has(header) ? neutralizeFormula(row[header] ?? null) : row[header] ?? null)).join(","));
  return `${lines.join("\r\n")}\r\n`;
};

function canonicalMediaPath(raw: string): string {
  const normalized = raw.replaceAll("\\", "/").normalize("NFC");
  const parts = normalized.split("/");
  if (
    normalized.length === 0 || normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:/u.test(normalized) || normalized.includes("\0") ||
    parts.some((part) => part === "" || part === "." || part === ".." || part.includes(":")) ||
    parts[0] !== "media"
  ) throw new ExportValidationError("MEDIA_INVALID", "A managed media path is unsafe");
  return parts.join("/");
}

function readRows(database: Database.Database, sql: string, workspaceId: string): Row[] {
  return database.prepare(sql).all(workspaceId) as Row[];
}

function appendLinks(rows: readonly WikiLinkRow[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const values = result.get(row.wiki_entry_id) ?? [];
    values.push(row.linked_id);
    result.set(row.wiki_entry_id, values);
  }
  return result;
}

function collectSnapshot(database: Database.Database, workspaceId: string): ExportSnapshot {
  const meta = database.prepare("SELECT workspace_id FROM workspace_meta WHERE workspace_id = ?").get(workspaceId) as { workspace_id: string } | undefined;
  if (!meta) throw new ExportValidationError("DATABASE_INVALID", "Workspace database identity does not match");

  const aliases = database.prepare(`
    SELECT person_id, name FROM person_alias
    WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY person_id, normalized_name, id
  `).all(workspaceId) as AliasRow[];
  const aliasesByPerson = new Map<string, string[]>();
  for (const alias of aliases) {
    const values = aliasesByPerson.get(alias.person_id) ?? [];
    values.push(alias.name);
    aliasesByPerson.set(alias.person_id, values);
  }
  const people = readRows(database, `
    SELECT id, display_name, gender,
      birth_calendar, birth_year, birth_month, birth_day, birth_leap_month, birth_precision,
      death_calendar, death_year, death_month, death_day, death_leap_month, death_precision, notes
    FROM person WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY id
  `, workspaceId).map((row) => ({ ...row, aliases: (aliasesByPerson.get(String(row.id)) ?? []).join(" | ") }));

  const parentChild = readRows(database, `
    SELECT id, parent_id, child_id, parent_role, relationship_type
    FROM parent_child WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY id
  `, workspaceId);
  const marriages = readRows(database, `
    SELECT id, spouse_a_id, spouse_b_id, marriage_status,
      start_calendar, start_year, start_month, start_day, start_leap_month, start_precision,
      end_calendar, end_year, end_month, end_day, end_leap_month, end_precision
    FROM marriage WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY id
  `, workspaceId);
  const lineages = readRows(database, `
    SELECT lineage.id AS lineage_id, lineage.name AS lineage_name, lineage.founder_person_id, lineage.description,
      membership.id AS membership_id, membership.person_id, membership.lineage_role, membership.is_primary, membership.declared_generation
    FROM lineage
    LEFT JOIN lineage_membership AS membership
      ON membership.lineage_id = lineage.id AND membership.workspace_id = lineage.workspace_id AND membership.deleted_at IS NULL
    WHERE lineage.workspace_id = ? AND lineage.deleted_at IS NULL
    ORDER BY lineage.id, membership.id
  `, workspaceId);

  const personLinks = appendLinks(database.prepare(`
    SELECT wiki_entry_id, person_id AS linked_id, sort_order, id AS link_id
    FROM wiki_person WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY wiki_entry_id, sort_order, id
  `).all(workspaceId) as WikiLinkRow[]);
  const sourceLinks = appendLinks(database.prepare(`
    SELECT wiki_entry_id, source_id AS linked_id, sort_order, id AS link_id
    FROM wiki_source WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY wiki_entry_id, sort_order, id
  `).all(workspaceId) as WikiLinkRow[]);
  const wikiRows = database.prepare(`
    SELECT id, slug, title, content FROM wiki_entry
    WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY id
  `).all(workspaceId) as Array<{ id: string; slug: string; title: string; content: string }>;
  const wiki = wikiRows.map((row) => ({ ...row, personIds: personLinks.get(row.id) ?? [], sourceIds: sourceLinks.get(row.id) ?? [] }));

  const mediaRows = database.prepare(`
    SELECT id, sha256, original_name, mime_type, byte_size, relative_path
    FROM media_asset WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY id
  `).all(workspaceId) as MediaRow[];
  const mediaPeopleRows = database.prepare(`
    SELECT media_asset_id, person_id, caption, sort_order, id AS link_id
    FROM media_person WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY media_asset_id, sort_order, id
  `).all(workspaceId) as MediaPersonRow[];
  const mediaPeople = new Map<string, Array<{ personId: string; caption: string | null; sortOrder: number }>>();
  for (const link of mediaPeopleRows) {
    const values = mediaPeople.get(link.media_asset_id) ?? [];
    values.push({ personId: link.person_id, caption: link.caption, sortOrder: link.sort_order });
    mediaPeople.set(link.media_asset_id, values);
  }
  const seenPaths = new Set<string>();
  const media = mediaRows.map((row) => {
    if (!/^[0-9a-f]{64}$/u.test(row.sha256) || !Number.isSafeInteger(row.byte_size) || row.byte_size < 0) throw new ExportValidationError("MEDIA_INVALID", "Managed media metadata is invalid");
    const path = canonicalMediaPath(row.relative_path);
    const folded = path.toLocaleLowerCase("en-US");
    if (seenPaths.has(folded)) throw new ExportValidationError("MEDIA_INVALID", "Managed media paths collide");
    seenPaths.add(folded);
    return { ...row, path, people: mediaPeople.get(row.id) ?? [] };
  });
  return { people, parentChild, marriages, lineages, wiki, media };
}

async function copyVerifiedMedia(sourcePath: string, destinationPath: string, expected: { sha256: string; byte_size: number }): Promise<void> {
  let source;
  try { source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { throw new ExportValidationError("MEDIA_INVALID", "A managed media object is missing or invalid"); }
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size !== expected.byte_size) throw new ExportValidationError("MEDIA_INVALID", "A managed media object is missing or invalid");
    await mkdir(dirname(destinationPath), { recursive: true });
    const destination = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const hash = createHash("sha256");
      let offset = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const result = await source.read(buffer, 0, buffer.length, offset);
        if (!result.bytesRead) break;
        const bytes = buffer.subarray(0, result.bytesRead);
        hash.update(bytes);
        let written = 0;
        while (written < bytes.length) {
          const write = await destination.write(bytes.subarray(written));
          if (write.bytesWritten < 1) throw new ExportValidationError("EXPORT_FAILED", "Export media copy made no progress");
          written += write.bytesWritten;
        }
        offset += result.bytesRead;
      }
      await destination.sync();
      const after = await source.stat();
      if (offset !== expected.byte_size || hash.digest("hex") !== expected.sha256 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new ExportValidationError("MEDIA_INVALID", "A managed media object changed during export");
      }
    } finally { await destination.close(); }
  } finally { await source.close(); }
}

async function requirePlainDirectory(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); }
  catch { throw new ExportValidationError("TARGET_INVALID", "Export destination must be an existing empty directory"); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ExportValidationError("TARGET_INVALID", "Export destination must be an existing empty directory");
}

async function requireEmptyDirectory(path: string): Promise<void> {
  await requirePlainDirectory(path);
  if ((await readdir(path)).length !== 0) throw new ExportValidationError("TARGET_NOT_EMPTY", "Export destination is not empty");
}

export class ExportService {
  constructor(private readonly workspace: ExportWorkspace, private readonly hooks: ExportHooks = {}) {}

  async exportWorkspace(selectedDestination: string): Promise<ExportResult> {
    const destination = resolve(selectedDestination);
    if (dirname(destination) === destination) throw new ExportValidationError("TARGET_INVALID", "Export destination is unsafe");
    await requirePlainDirectory(destination);
    const [realDestination, realWorkspace, realAppData, realMedia] = await Promise.all([
      realpath(destination), realpath(this.workspace.workspaceRoot), realpath(this.workspace.appDataRoot), realpath(this.workspace.mediaRoot)
    ]).catch(() => { throw new ExportValidationError("TARGET_INVALID", "Export roots are unavailable"); });
    if (overlaps(normalizeCase(realDestination), normalizeCase(realWorkspace)) || overlaps(normalizeCase(realDestination), normalizeCase(realAppData))) {
      throw new ExportValidationError("TARGET_INVALID", "Export destination overlaps protected application data");
    }
    await requireEmptyDirectory(realDestination);

    let snapshot: ExportSnapshot;
    const database = openQueryDatabase(this.workspace.databasePath);
    try {
      database.exec("BEGIN");
      try {
        snapshot = collectSnapshot(database, this.workspace.workspaceId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (error instanceof ExportValidationError) throw error;
      throw new ExportValidationError("DATABASE_INVALID", "Workspace data could not be exported");
    } finally { database.close(); }

    const staging = await mkdtemp(join(dirname(realDestination), `.family-export-${basename(realDestination)}-${randomUUID()}-`));
    let activated = false;
    try {
      await Promise.all([
        writeFile(join(staging, "people.csv"), makeCsv(peopleHeaders, snapshot.people, humanColumns.people), { encoding: "utf8", flag: "wx", mode: 0o600 }),
        writeFile(join(staging, "parent-child.csv"), makeCsv(parentChildHeaders, snapshot.parentChild), { encoding: "utf8", flag: "wx", mode: 0o600 }),
        writeFile(join(staging, "marriages.csv"), makeCsv(marriageHeaders, snapshot.marriages), { encoding: "utf8", flag: "wx", mode: 0o600 }),
        writeFile(join(staging, "lineages.csv"), makeCsv(lineageHeaders, snapshot.lineages, humanColumns.lineages), { encoding: "utf8", flag: "wx", mode: 0o600 }),
        writeFile(join(staging, "wiki.json"), `${JSON.stringify({ entries: snapshot.wiki }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
      ]);
      for (const asset of snapshot.media) {
        const source = await realpath(resolve(this.workspace.workspaceRoot, ...asset.path.split("/"))).catch(() => { throw new ExportValidationError("MEDIA_INVALID", "A managed media object is missing or invalid"); });
        if (!contains(normalizeCase(realMedia), normalizeCase(source))) throw new ExportValidationError("MEDIA_INVALID", "A managed media object escapes the media root");
        await copyVerifiedMedia(source, join(staging, ...asset.path.split("/")), asset);
      }
      const manifest = {
        assets: snapshot.media.map((asset) => ({
          id: asset.id, path: asset.path, originalName: asset.original_name, mimeType: asset.mime_type,
          byteSize: asset.byte_size, sha256: asset.sha256, people: asset.people
        }))
      };
      await writeFile(join(staging, "media-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });

      await this.hooks.beforeActivate?.();
      await requireEmptyDirectory(destination);
      const currentDestination = await realpath(destination).catch(() => {
        throw new ExportValidationError("TARGET_INVALID", "Export destination changed before activation");
      });
      if (normalizeCase(currentDestination) !== normalizeCase(realDestination)) {
        throw new ExportValidationError("TARGET_INVALID", "Export destination changed before activation");
      }
      await rmdir(realDestination);
      try {
        await rename(staging, realDestination);
        activated = true;
      } catch (error) {
        await mkdir(realDestination).catch(() => undefined);
        throw error;
      }
      return { files: 6 + snapshot.media.length, mediaAssets: snapshot.media.length };
    } catch (error) {
      if (error instanceof ExportValidationError) throw error;
      throw new ExportValidationError("EXPORT_FAILED", "Workspace export failed");
    } finally {
      if (!activated) await rm(staging, { recursive: true, force: true });
    }
  }
}
