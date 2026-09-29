import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import extract from "extract-zip";
import yauzl from "yauzl";
import { applyMigrations, LATEST_SCHEMA_VERSION, validateCurrentSchema, validateMigrationLedger } from "../../database/migrations/index.js";
import { openDatabase } from "../../database/open-database.js";
import { canonicalPlainDirectory, normalizePathIdentity, pathContains } from "../../workspaces/workspace-path-security.js";
import type { WorkspaceExclusiveLease } from "../../workspaces/workspace-mutation-gate.js";
import { workspaceSummarySchema, type StrictWorkspaceSummary } from "../../workspaces/workspace-schema.js";
import { backupManifestSchema, canonicalArchivePath, type BackupManifest } from "./backup-manifest.js";

export type BackupValidationCode =
  | "ENTRY_PATH" | "ENTRY_COLLISION" | "ENTRY_TYPE" | "ARCHIVE_LIMIT" | "ENTRY_WHITELIST"
  | "HASH_MISMATCH" | "MANIFEST_INVALID" | "DATABASE_INVALID" | "SCHEMA_UNSUPPORTED"
  | "WORKSPACE_MISMATCH" | "MEDIA_INVALID" | "TOKEN_INVALID" | "TARGET_INVALID"
  | "STAGING_INVALID" | "CONFIRMATION_REQUIRED" | "ACTIVATION_FAILED" | "ROLLBACK_FAILED";

export class BackupValidationError extends Error {
  constructor(public readonly code: BackupValidationCode, message: string) {
    super(message);
    this.name = "BackupValidationError";
  }
}

export interface ArchiveBounds {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
  minRatioBytes: number;
  maxNameBytes: number;
  maxSegmentBytes: number;
  maxBackupManifestBytes: number;
  maxWorkspaceManifestBytes: number;
}

const DEFAULT_BOUNDS: ArchiveBounds = {
  maxArchiveBytes: 4 * 1024 * 1024 * 1024,
  maxEntries: 100_001,
  maxEntryBytes: 2 * 1024 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024 * 1024,
  maxCompressionRatio: 1_000,
  minRatioBytes: 1024 * 1024,
  maxNameBytes: 1_024,
  maxSegmentBytes: 255,
  maxBackupManifestBytes: 1024 * 1024,
  maxWorkspaceManifestBytes: 64 * 1024
};

interface ZipEntryMetadata {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
}

export interface InspectedBackupArchive {
  manifest: BackupManifest;
  workspaceManifest: StrictWorkspaceSummary;
  stagingPath: string;
  archiveSha256: string;
  migratedSchemaVersion: number;
  dispose(): Promise<void>;
}

export interface RestoreTarget {
  workspaceId: string;
  workspaceName: string;
  originPersonId: string | null;
  directory: string;
  rootPath: string;
  databasePath: string;
  mediaPath: string;
  manifestPath: string;
  backupsPath: string;
}

export interface RestoreController {
  resolveTarget(workspaceId: string): Promise<RestoreTarget | null>;
  acquireExclusive(workspaceId: string): Promise<WorkspaceExclusiveLease>;
  createVerifiedSnapshot(target: RestoreTarget): Promise<void>;
  deactivate(target: RestoreTarget): Promise<void>;
  commitActivation(target: RestoreTarget, manifest: BackupManifest, schemaVersion: number): Promise<void>;
  rollbackActivation(target: RestoreTarget): Promise<void>;
  completeActivation?(target: RestoreTarget): void;
}

export interface RestoreInspection {
  restoreToken: string;
  targetWorkspaceId: string;
  verified: true;
  expiresAt: string;
  manifest: BackupManifest;
  archiveSha256: string;
}

interface StoredInspection {
  targetWorkspaceId: string;
  targetRoot: string;
  stagingPath: string;
  manifest: BackupManifest;
  schemaVersion: number;
  archiveSha256: string;
  workspace: StrictWorkspaceSummary;
  seal: readonly StagedTreeEntry[];
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const reservedWindowsName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
interface StagedTreeEntry {
  path: string;
  type: "directory" | "file";
  size?: number;
  sha256?: string;
}

const inside = (root: string, candidate: string): boolean => {
  const part = relative(root, candidate);
  return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
};

const hashFile = async (path: string): Promise<{ sha256: string; size: number }> => {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.from(chunk as Buffer);
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha256: hash.digest("hex"), size };
};

function validateEntryPath(raw: string, bounds: ArchiveBounds): string {
  const normalized = raw.replaceAll("\\", "/").normalize("NFC");
  if (Buffer.byteLength(normalized) > bounds.maxNameBytes || normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:/u.test(normalized) || normalized.includes("\0")) {
    throw new BackupValidationError("ENTRY_PATH", "Archive contains an unsafe entry path");
  }
  const parts = normalized.split("/");
  if (canonicalArchivePath(normalized) !== normalized || parts.some((part) => Buffer.byteLength(part) > bounds.maxSegmentBytes || part.includes(":") || /[. ]$/u.test(part) || reservedWindowsName.test(part))) {
    throw new BackupValidationError("ENTRY_PATH", "Archive contains an unsafe entry path");
  }
  return normalized;
}

async function readZipMetadata(archivePath: string, bounds: ArchiveBounds): Promise<ZipEntryMetadata[]> {
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile() || archiveStat.size > bounds.maxArchiveBytes) throw new BackupValidationError("ARCHIVE_LIMIT", "Archive exceeds the configured size limit");
  const zip = await new Promise<yauzl.ZipFile>((resolveZip, reject) => yauzl.open(archivePath, {
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: false
  }, (error, value) => error || !value ? reject(error ?? new Error("Archive unavailable")) : resolveZip(value)));
  const entries: ZipEntryMetadata[] = [];
  const exact = new Set<string>();
  const folded = new Set<string>();
  let total = 0;
  let totalCompressed = 0;
  try {
    await new Promise<void>((resolveEntries, reject) => {
      zip.once("error", reject);
      zip.once("end", resolveEntries);
      zip.on("entry", (entry) => {
        try {
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = unixMode & 0xf000;
          const windowsDirectory = ((entry.versionMadeBy >>> 8) === 0) && (entry.externalFileAttributes & 0x10) !== 0;
          if (entry.fileName.endsWith("/") || windowsDirectory || (fileType !== 0 && fileType !== 0x8000) || (entry.generalPurposeBitFlag & 1) !== 0) {
            throw new BackupValidationError("ENTRY_TYPE", "Archive contains a link, directory, encrypted, or special entry");
          }
          const path = validateEntryPath(entry.fileName, bounds);
          const key = path.toLocaleLowerCase("en-US");
          if (exact.has(path) || folded.has(key)) throw new BackupValidationError("ENTRY_COLLISION", "Archive contains colliding entry names");
          exact.add(path); folded.add(key);
          if (entries.length + 1 > bounds.maxEntries || entry.uncompressedSize > bounds.maxEntryBytes) throw new BackupValidationError("ARCHIVE_LIMIT", "Archive exceeds configured entry limits");
          total += entry.uncompressedSize;
          totalCompressed += entry.compressedSize;
          if (total > bounds.maxTotalBytes) throw new BackupValidationError("ARCHIVE_LIMIT", "Archive exceeds the configured total size limit");
          if (entry.uncompressedSize >= bounds.minRatioBytes) {
            const ratio = entry.compressedSize === 0 ? Number.POSITIVE_INFINITY : entry.uncompressedSize / entry.compressedSize;
            if (ratio > bounds.maxCompressionRatio) throw new BackupValidationError("ARCHIVE_LIMIT", "Archive compression ratio is unsafe");
          }
          if (path === "backup-manifest.json" && entry.uncompressedSize > bounds.maxBackupManifestBytes) throw new BackupValidationError("ARCHIVE_LIMIT", "Backup manifest exceeds its control-file limit");
          if (path === "workspace.json" && entry.uncompressedSize > bounds.maxWorkspaceManifestBytes) throw new BackupValidationError("ARCHIVE_LIMIT", "Workspace manifest exceeds its control-file limit");
          if (total >= bounds.minRatioBytes) {
            const aggregateRatio = totalCompressed === 0 ? Number.POSITIVE_INFINITY : total / totalCompressed;
            if (aggregateRatio > bounds.maxCompressionRatio) throw new BackupValidationError("ARCHIVE_LIMIT", "Archive aggregate compression ratio is unsafe");
          }
          entries.push({ path, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize });
          zip.readEntry();
        } catch (error) {
          reject(error);
          zip.close();
        }
      });
      zip.readEntry();
    });
    return entries;
  } catch (error) {
    if (error instanceof BackupValidationError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/absolute path|invalid relative path|invalid characters in fileName/iu.test(message)) {
      throw new BackupValidationError("ENTRY_PATH", "Archive contains an unsafe entry path");
    }
    throw error;
  } finally {
    zip.close();
  }
}

async function enumerateExtracted(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new BackupValidationError("ENTRY_TYPE", "Extracted archive contains a special file");
      if (info.isDirectory()) await visit(absolute, relativePath);
      else found.push(relativePath.replaceAll("\\", "/"));
    }
  };
  await visit(root, "");
  return found.sort();
}

const countRows = (database: Database.Database): BackupManifest["counts"] => ({
  people: Number(database.prepare("SELECT COUNT(*) FROM person").pluck().get()),
  parentChild: Number(database.prepare("SELECT COUNT(*) FROM parent_child").pluck().get()),
  marriages: Number(database.prepare("SELECT COUNT(*) FROM marriage").pluck().get()),
  wikiEntries: Number(database.prepare("SELECT COUNT(*) FROM wiki_entry").pluck().get()),
  auditRows: Number(database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()),
  mediaAssets: Number(database.prepare("SELECT COUNT(*) FROM media_asset").pluck().get())
});

function validateDatabase(stagingPath: string, manifest: BackupManifest, expectedOriginPersonId: string | null): number {
  const databasePath = join(stagingPath, "genealogy.sqlite");
  let database: Database.Database;
  try { database = new Database(databasePath, { readonly: true, fileMustExist: true }); }
  catch { throw new BackupValidationError("DATABASE_INVALID", "Backup database could not be opened"); }
  let schemaVersion: number;
  try {
    database.pragma("foreign_keys = ON");
    const integrity = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new BackupValidationError("DATABASE_INVALID", "Backup database failed integrity_check");
    if ((database.pragma("foreign_key_check") as unknown[]).length > 0) throw new BackupValidationError("DATABASE_INVALID", "Backup database failed foreign_key_check");
    schemaVersion = Number(database.pragma("user_version", { simple: true }));
    if (schemaVersion !== manifest.schemaVersion) throw new BackupValidationError("DATABASE_INVALID", "Backup schema version does not match its manifest");
    if (schemaVersion > LATEST_SCHEMA_VERSION) throw new BackupValidationError("SCHEMA_UNSUPPORTED", "Backup schema is newer than this application");
    try {
      validateMigrationLedger(database, schemaVersion);
      if (schemaVersion === LATEST_SCHEMA_VERSION) validateCurrentSchema(database);
    } catch {
      throw new BackupValidationError("DATABASE_INVALID", "Backup migration ledger or schema is inconsistent");
    }
    const identity = database.prepare("SELECT workspace_id, name, origin_person_id FROM workspace_meta").all() as Array<{ workspace_id: string; name: string; origin_person_id: string | null }>;
    if (
      identity.length !== 1 || identity[0]?.workspace_id !== manifest.workspaceId || identity[0]?.name !== manifest.workspaceName ||
      expectedOriginPersonId === null || identity[0]?.origin_person_id !== expectedOriginPersonId
    ) {
      throw new BackupValidationError("WORKSPACE_MISMATCH", "Backup workspace identity does not match its manifest");
    }
    const origin = database.prepare("SELECT 1 FROM person WHERE id=? AND workspace_id=? AND deleted_at IS NULL")
      .get(expectedOriginPersonId, manifest.workspaceId);
    if (!origin) throw new BackupValidationError("WORKSPACE_MISMATCH", "Backup origin person is missing or archived");
    if (JSON.stringify(countRows(database)) !== JSON.stringify(manifest.counts)) throw new BackupValidationError("DATABASE_INVALID", "Backup row counts do not match its manifest");
    const files = new Map(manifest.files.map((file) => [file.path, file]));
    const semanticPaths = new Set(["genealogy.sqlite", "workspace.json"]);
    const mediaPaths = new Set<string>();
    const media = database.prepare("SELECT relative_path, sha256, byte_size FROM media_asset ORDER BY id").all() as Array<{ relative_path: string; sha256: string; byte_size: number }>;
    for (const item of media) {
      const path = item.relative_path.replaceAll("\\", "/");
      if (!path.startsWith("media/") || canonicalArchivePath(path) !== path) throw new BackupValidationError("MEDIA_INVALID", "Backup database declares an unsafe media path");
      const folded = path.toLocaleLowerCase("en-US");
      if (mediaPaths.has(folded)) throw new BackupValidationError("MEDIA_INVALID", "Backup database declares duplicate media payloads");
      mediaPaths.add(folded);
      semanticPaths.add(path);
      const file = files.get(path);
      if (!file || file.sha256 !== item.sha256 || file.size !== item.byte_size) throw new BackupValidationError("MEDIA_INVALID", "Backup media declaration does not match its payload");
    }
    const declaredPaths = [...files.keys()].sort((left, right) => left.localeCompare(right, "en"));
    const exactPaths = [...semanticPaths].sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(declaredPaths) !== JSON.stringify(exactPaths)) throw new BackupValidationError("ENTRY_WHITELIST", "Archive manifest contains a payload outside the format-1 semantic set");
  } finally {
    database.close();
  }
  return schemaVersion;
}

async function hashStableTreeFile(path: string): Promise<{ size: number; sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new BackupValidationError("STAGING_INVALID", "Restore staging contains a non-file payload");
    const hash = createHash("sha256");
    let offset = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || offset !== before.size) {
      throw new BackupValidationError("STAGING_INVALID", "Restore staging changed while it was being sealed");
    }
    return { size: offset, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function collectStagedTree(root: string): Promise<StagedTreeEntry[]> {
  const canonicalRoot = await canonicalPlainDirectory(root).catch(() => {
    throw new BackupValidationError("STAGING_INVALID", "Restore staging root is not a plain directory");
  });
  const entries: StagedTreeEntry[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new BackupValidationError("STAGING_INVALID", "Restore staging contains a linked or special entry");
      const canonical = await realpath(absolute);
      if (!pathContains(canonicalRoot, canonical)) throw new BackupValidationError("STAGING_INVALID", "Restore staging entry escaped its root");
      if (info.isDirectory()) {
        entries.push({ path: path.replaceAll("\\", "/"), type: "directory" });
        await visit(absolute, path);
      } else {
        entries.push({ path: path.replaceAll("\\", "/"), type: "file", ...await hashStableTreeFile(absolute) });
      }
    }
  };
  await visit(canonicalRoot, "");
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en") || left.type.localeCompare(right.type, "en"));
}

function validateStagedDatabase(stagingPath: string, expected: StrictWorkspaceSummary): string[] {
  let database: Database.Database;
  try { database = new Database(join(stagingPath, "genealogy.sqlite"), { readonly: true, fileMustExist: true }); }
  catch { throw new BackupValidationError("STAGING_INVALID", "Restore staging database could not be opened"); }
  try {
    database.pragma("foreign_keys = ON");
    if (database.pragma("integrity_check", { simple: true }) !== "ok" || (database.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw new BackupValidationError("STAGING_INVALID", "Restore staging database failed integrity verification");
    }
    if (Number(database.pragma("user_version", { simple: true })) !== LATEST_SCHEMA_VERSION) throw new BackupValidationError("STAGING_INVALID", "Restore staging schema is incomplete");
    try { validateCurrentSchema(database); }
    catch { throw new BackupValidationError("STAGING_INVALID", "Restore staging migration ledger or schema is inconsistent"); }
    const identity = database.prepare("SELECT workspace_id, name, origin_person_id FROM workspace_meta").all() as Array<{ workspace_id: string; name: string; origin_person_id: string | null }>;
    if (
      identity.length !== 1 || identity[0]?.workspace_id !== expected.id || identity[0]?.name !== expected.name ||
      identity[0]?.origin_person_id !== expected.originPersonId || expected.originPersonId === null
    ) throw new BackupValidationError("WORKSPACE_MISMATCH", "Restore staging identity or origin does not match its workspace manifest");
    const origin = database.prepare("SELECT 1 FROM person WHERE id=? AND workspace_id=? AND deleted_at IS NULL").get(expected.originPersonId, expected.id);
    if (!origin) throw new BackupValidationError("WORKSPACE_MISMATCH", "Restore origin person does not exist in the restored workspace");
    const media = database.prepare("SELECT relative_path FROM media_asset ORDER BY id").pluck().all() as string[];
    const paths = new Set<string>();
    for (const raw of media) {
      const path = raw.replaceAll("\\", "/").normalize("NFC");
      const folded = path.toLocaleLowerCase("en-US");
      if (!path.startsWith("media/") || canonicalArchivePath(path) !== path || paths.has(folded)) throw new BackupValidationError("MEDIA_INVALID", "Restore staging has unsafe or duplicate media declarations");
      paths.add(folded);
    }
    return media.map((raw) => raw.replaceAll("\\", "/").normalize("NFC"));
  } finally {
    database.close();
  }
}

async function validateAndSealStaging(stagingPath: string, expected: StrictWorkspaceSummary, expectedSeal?: readonly StagedTreeEntry[]): Promise<readonly StagedTreeEntry[]> {
  let persisted: StrictWorkspaceSummary;
  try { persisted = workspaceSummarySchema.parse(JSON.parse(await readFile(join(stagingPath, "workspace.json"), "utf8"))); }
  catch { throw new BackupValidationError("STAGING_INVALID", "Restore staging workspace manifest is invalid"); }
  if (JSON.stringify(persisted) !== JSON.stringify(expected)) throw new BackupValidationError("STAGING_INVALID", "Restore staging workspace manifest changed after inspection");
  const mediaPaths = validateStagedDatabase(stagingPath, expected);
  const expectedFiles = new Set(["genealogy.sqlite", "workspace.json", ...mediaPaths]);
  const expectedDirectories = new Set(["backups", "media"]);
  for (const path of mediaPaths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join("/"));
  }
  const seal = await collectStagedTree(stagingPath);
  const actualFiles = seal.filter((entry) => entry.type === "file").map((entry) => entry.path).sort();
  const actualDirectories = seal.filter((entry) => entry.type === "directory").map((entry) => entry.path).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort()) || JSON.stringify(actualDirectories) !== JSON.stringify([...expectedDirectories].sort())) {
    throw new BackupValidationError("STAGING_INVALID", "Restore staging tree does not match the restored database");
  }
  if (expectedSeal && JSON.stringify(seal) !== JSON.stringify(expectedSeal)) throw new BackupValidationError("STAGING_INVALID", "Restore staging tree changed after inspection");
  return seal;
}

export async function inspectBackupArchive(
  archivePath: string,
  options: { stagingParent: string; bounds?: Partial<ArchiveBounds> }
): Promise<InspectedBackupArchive> {
  const bounds = { ...DEFAULT_BOUNDS, ...options.bounds };
  let stagingPath: string | null = null;
  try {
    const entries = await readZipMetadata(archivePath, bounds);
    await mkdir(options.stagingParent, { recursive: true });
    stagingPath = await mkdtemp(join(options.stagingParent, ".family-restore-stage-"));
    await extract(archivePath, { dir: stagingPath });
    const extracted = await enumerateExtracted(stagingPath);
    const expectedEntries = entries.map((entry) => entry.path).sort();
    if (JSON.stringify(extracted) !== JSON.stringify(expectedEntries)) throw new BackupValidationError("ENTRY_WHITELIST", "Extracted archive entries changed during validation");
    if (!extracted.includes("backup-manifest.json")) throw new BackupValidationError("MANIFEST_INVALID", "Backup manifest is missing");
    let manifest: BackupManifest;
    try { manifest = backupManifestSchema.parse(JSON.parse(await readFile(join(stagingPath, "backup-manifest.json"), "utf8"))); }
    catch { throw new BackupValidationError("MANIFEST_INVALID", "Backup manifest is invalid"); }
    const whitelist = ["backup-manifest.json", ...manifest.files.map((file) => file.path)].sort();
    if (JSON.stringify(extracted) !== JSON.stringify(whitelist)) throw new BackupValidationError("ENTRY_WHITELIST", "Archive contains missing or extra payloads");
    const canonicalStage = await realpath(stagingPath);
    for (const file of manifest.files) {
      const absolute = resolve(canonicalStage, ...file.path.split("/"));
      if (!inside(canonicalStage, absolute) || !inside(canonicalStage, await realpath(absolute))) throw new BackupValidationError("ENTRY_PATH", "Extracted payload escaped its staging directory");
      const actual = await hashFile(absolute);
      if (actual.size !== file.size || actual.sha256 !== file.sha256) throw new BackupValidationError("HASH_MISMATCH", "Backup payload hash or size does not match its manifest");
    }
    const workspaceManifest = workspaceSummarySchema.safeParse(JSON.parse(await readFile(join(stagingPath, "workspace.json"), "utf8")));
    if (
      !workspaceManifest.success ||
      workspaceManifest.data.id !== manifest.workspaceId ||
      workspaceManifest.data.name !== manifest.workspaceName ||
      workspaceManifest.data.schemaVersion !== manifest.schemaVersion
    ) {
      throw new BackupValidationError("WORKSPACE_MISMATCH", "Workspace manifest does not match the backup manifest");
    }
    const originalSchemaVersion = validateDatabase(stagingPath, manifest, workspaceManifest.data.originPersonId);
    let migratedSchemaVersion = originalSchemaVersion;
    if (originalSchemaVersion < LATEST_SCHEMA_VERSION) {
      const database = openDatabase(join(stagingPath, "genealogy.sqlite"));
      try { migratedSchemaVersion = applyMigrations(database); }
      finally { database.close(); }
      const updatedWorkspaceManifest = { ...workspaceManifest.data, schemaVersion: migratedSchemaVersion };
      await writeFile(join(stagingPath, "workspace.json"), JSON.stringify(updatedWorkspaceManifest, null, 2));
      const verified = new Database(join(stagingPath, "genealogy.sqlite"), { readonly: true });
      try {
        if (verified.pragma("integrity_check", { simple: true }) !== "ok" || (verified.pragma("foreign_key_check") as unknown[]).length > 0) {
          throw new BackupValidationError("DATABASE_INVALID", "Migrated backup database failed verification");
        }
        try { validateCurrentSchema(verified); }
        catch { throw new BackupValidationError("DATABASE_INVALID", "Migrated backup schema is incomplete or inconsistent"); }
      } finally { verified.close(); }
    } else {
      const verified = new Database(join(stagingPath, "genealogy.sqlite"), { readonly: true });
      try { validateCurrentSchema(verified); }
      catch { throw new BackupValidationError("DATABASE_INVALID", "Backup schema is incomplete or inconsistent"); }
      finally { verified.close(); }
    }
    const finalized = new Database(join(stagingPath, "genealogy.sqlite"));
    try {
      finalized.pragma("wal_checkpoint(TRUNCATE)");
      finalized.pragma("journal_mode = DELETE");
      validateCurrentSchema(finalized);
    } catch {
      throw new BackupValidationError("DATABASE_INVALID", "Migrated backup database could not be sealed");
    } finally {
      finalized.close();
    }
    await Promise.all([
      rm(join(stagingPath, "genealogy.sqlite-wal"), { force: true }),
      rm(join(stagingPath, "genealogy.sqlite-shm"), { force: true })
    ]);
    const archiveHash = await hashFile(archivePath);
    const ownedStage = stagingPath;
    stagingPath = null;
    return {
      manifest,
      workspaceManifest: { ...workspaceManifest.data, schemaVersion: migratedSchemaVersion },
      stagingPath: ownedStage,
      archiveSha256: archiveHash.sha256,
      migratedSchemaVersion,
      dispose: () => rm(ownedStage, { recursive: true, force: true })
    };
  } catch (error) {
    if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
    if (error instanceof BackupValidationError) throw error;
    throw new BackupValidationError("MANIFEST_INVALID", "Backup archive could not be validated");
  }
}

export class RestoreService {
  private readonly inspections = new Map<string, StoredInspection>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly bounds?: Partial<ArchiveBounds>;
  private readonly removeRollbackDirectory: (path: string) => Promise<void>;

  constructor(private readonly controller: RestoreController, options: {
    ttlMs?: number;
    now?: () => number;
    bounds?: Partial<ArchiveBounds>;
    removeRollbackDirectory?: (path: string) => Promise<void>;
  } = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.bounds = options.bounds;
    this.removeRollbackDirectory = options.removeRollbackDirectory ?? ((path) => rm(path, { recursive: true, force: true }));
  }

  async inspectBackup(input: { archivePath: string; targetWorkspaceId: string }): Promise<RestoreInspection> {
    const target = await this.controller.resolveTarget(input.targetWorkspaceId);
    if (!target) throw new BackupValidationError("TARGET_INVALID", "Restore target was not found");
    const parent = await canonicalPlainDirectory(dirname(target.rootPath)).catch(() => null);
    const targetRoot = await canonicalPlainDirectory(target.rootPath).catch(() => null);
    if (
      !parent || !targetRoot || !inside(parent, targetRoot) || targetRoot === parent || basename(targetRoot) === "" ||
      basename(targetRoot).toLocaleLowerCase("en-US") !== target.directory.toLocaleLowerCase("en-US")
    ) throw new BackupValidationError("TARGET_INVALID", "Restore target is unsafe");
    const inspected = await inspectBackupArchive(input.archivePath, { stagingParent: parent, bounds: this.bounds });
    let transferred = false;
    try {
      if (inspected.manifest.workspaceId !== input.targetWorkspaceId) throw new BackupValidationError("WORKSPACE_MISMATCH", "Backup belongs to a different workspace");
      const stagedWorkspace = workspaceSummarySchema.parse({
        ...inspected.workspaceManifest,
        id: target.workspaceId,
        name: inspected.manifest.workspaceName,
        directory: target.directory,
        schemaVersion: LATEST_SCHEMA_VERSION
      });
      if (stagedWorkspace.originPersonId === null) throw new BackupValidationError("WORKSPACE_MISMATCH", "Restore workspace must have an origin person");
      await writeFile(join(inspected.stagingPath, "workspace.json"), JSON.stringify(stagedWorkspace, null, 2));
      await rm(join(inspected.stagingPath, "backup-manifest.json"), { force: false });
      await mkdir(join(inspected.stagingPath, "media"), { recursive: true });
      await mkdir(join(inspected.stagingPath, "backups"), { recursive: false });
      const seal = await validateAndSealStaging(inspected.stagingPath, stagedWorkspace);
      const restoreToken = randomUUID();
      const expiresAt = this.now() + this.ttlMs;
      const timer = setTimeout(() => { void this.expire(restoreToken); }, Math.max(0, expiresAt - this.now()));
      timer.unref();
      this.inspections.set(restoreToken, {
        targetWorkspaceId: input.targetWorkspaceId,
        targetRoot,
        stagingPath: inspected.stagingPath,
        manifest: inspected.manifest,
        schemaVersion: inspected.migratedSchemaVersion,
        archiveSha256: inspected.archiveSha256,
        workspace: stagedWorkspace,
        seal,
        expiresAt,
        timer
      });
      transferred = true;
      return {
        restoreToken,
        targetWorkspaceId: input.targetWorkspaceId,
        verified: true,
        expiresAt: new Date(expiresAt).toISOString(),
        manifest: inspected.manifest,
        archiveSha256: inspected.archiveSha256
      };
    } finally {
      if (!transferred) await inspected.dispose();
    }
  }

  async restoreBackup(input: { restoreToken: string; targetWorkspaceId: string; confirmReplace: boolean }): Promise<{ restored: true; automaticSnapshotVerified: true; cleanupPending: boolean }> {
    if (!input.confirmReplace) throw new BackupValidationError("CONFIRMATION_REQUIRED", "Workspace replacement must be confirmed");
    const stored = this.inspections.get(input.restoreToken);
    if (stored) { this.inspections.delete(input.restoreToken); clearTimeout(stored.timer); }
    if (!stored || stored.expiresAt < this.now() || stored.targetWorkspaceId !== input.targetWorkspaceId) {
      if (stored) await rm(stored.stagingPath, { recursive: true, force: true });
      throw new BackupValidationError("TOKEN_INVALID", "Restore inspection expired or was already used");
    }
    let lease: WorkspaceExclusiveLease | null = null;
    try {
      lease = await this.controller.acquireExclusive(input.targetWorkspaceId);
      const target = await this.controller.resolveTarget(input.targetWorkspaceId);
      const currentTargetRoot = target ? await canonicalPlainDirectory(target.rootPath).catch(() => null) : null;
      if (
        !target || !currentTargetRoot || normalizePathIdentity(currentTargetRoot) !== normalizePathIdentity(stored.targetRoot) ||
        target.directory.toLocaleLowerCase("en-US") !== stored.workspace.directory.toLocaleLowerCase("en-US")
      ) throw new BackupValidationError("TARGET_INVALID", "Restore target changed after inspection");
      await validateAndSealStaging(stored.stagingPath, stored.workspace, stored.seal);
      let originalMoved = false;
      let stagedActivated = false;
      let deactivated = false;
      const parent = dirname(stored.targetRoot);
      const rollbackPath = join(parent, `.family-restore-original-${randomUUID()}`);
      const failedPath = join(parent, `.family-restore-failed-${randomUUID()}`);
      try {
        deactivated = true;
        await this.controller.deactivate(target);
        await this.controller.createVerifiedSnapshot(target);
        await validateAndSealStaging(stored.stagingPath, stored.workspace, stored.seal);
        await rename(stored.targetRoot, rollbackPath);
        originalMoved = true;
        await rename(stored.stagingPath, stored.targetRoot);
        stagedActivated = true;
        await this.controller.commitActivation(target, stored.manifest, stored.schemaVersion);
      } catch (error) {
        try {
          if (stagedActivated) await rename(stored.targetRoot, failedPath);
          if (originalMoved) await rename(rollbackPath, stored.targetRoot);
          if (deactivated) await this.controller.rollbackActivation(target);
          if (stagedActivated) await rm(failedPath, { recursive: true, force: true });
          else await rm(stored.stagingPath, { recursive: true, force: true });
        } catch {
          throw new BackupValidationError("ROLLBACK_FAILED", "Restore activation failed and automatic rollback could not be confirmed");
        }
        if (error instanceof BackupValidationError && !originalMoved) throw error;
        throw new BackupValidationError("ACTIVATION_FAILED", "Restore activation failed; the original workspace was restored");
      }
      let cleanupPending = false;
      try { this.controller.completeActivation?.(target); }
      catch { cleanupPending = true; }
      const cleanupPath = join(parent, `.family-restore-cleanup-pending-${randomUUID()}`);
      try {
        await rename(rollbackPath, cleanupPath);
        try { await this.removeRollbackDirectory(cleanupPath); }
        catch { cleanupPending = true; }
      } catch {
        cleanupPending = true;
      }
      return { restored: true, automaticSnapshotVerified: true, cleanupPending };
    } catch (error) {
      await rm(stored.stagingPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      lease?.release();
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.inspections.keys()].map((token) => this.expire(token)));
  }

  private async expire(token: string): Promise<void> {
    const value = this.inspections.get(token);
    if (!value) return;
    this.inspections.delete(token);
    clearTimeout(value.timer);
    await rm(value.stagingPath, { recursive: true, force: true });
  }
}
