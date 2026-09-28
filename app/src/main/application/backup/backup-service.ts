import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { once } from "node:events";
import archiver from "archiver";
import { z } from "zod";
import { openDatabase } from "../../database/open-database.js";
import { backupManifestSchema, canonicalArchivePath, type BackupManifest } from "./backup-manifest.js";
import { BackupValidationError, inspectBackupArchive } from "./restore-service.js";

export interface BackupWorkspace {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  databasePath: string;
  mediaRoot: string;
  manifestPath: string;
  backupsRoot: string;
}

export interface BackupResult {
  manifest: BackupManifest;
  archiveSha256: string;
}

interface MediaRow { relative_path: string; sha256: string; byte_size: number; }
interface Payload { path: string; sourcePath: string; size: number; sha256: string; }

const workspaceManifestSchema = z.object({
  id: z.string().min(1).max(500),
  name: z.string().min(1).max(500),
  directory: z.string().min(1).max(500),
  originPersonId: z.string().nullable(),
  lastOpenedAt: z.string().datetime().nullable(),
  schemaVersion: z.number().int().positive()
}).strict();

const inside = (root: string, candidate: string): boolean => {
  const part = relative(root, candidate);
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
};

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash("sha256");
    let size = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { sha256: hash.digest("hex"), size };
  } finally { await handle.close(); }
}

async function snapshotVerifiedFile(sourcePath: string, destinationPath: string, expected: { sha256: string; size: number }): Promise<void> {
  const source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size !== expected.size) throw new BackupValidationError("MEDIA_INVALID", "A declared media object is missing or invalid");
    await mkdir(dirname(destinationPath), { recursive: true });
    const destination = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const hash = createHash("sha256");
      let readOffset = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await source.read(buffer, 0, buffer.length, readOffset);
        if (!bytesRead) break;
        const bytes = buffer.subarray(0, bytesRead);
        hash.update(bytes);
        for (let written = 0; written < bytes.length;) {
          const result = await destination.write(bytes.subarray(written));
          if (result.bytesWritten < 1) throw new BackupValidationError("MEDIA_INVALID", "A media snapshot write made no progress");
          written += result.bytesWritten;
        }
        readOffset += bytesRead;
      }
      await destination.sync();
      const after = await source.stat();
      if (readOffset !== expected.size || hash.digest("hex") !== expected.sha256 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.dev !== before.dev || after.ino !== before.ino) {
        throw new BackupValidationError("MEDIA_INVALID", "A declared media object changed during backup");
      }
    } finally { await destination.close(); }
  } catch (error) {
    if (error instanceof BackupValidationError) throw error;
    throw new BackupValidationError("MEDIA_INVALID", "A declared media object is missing or invalid");
  } finally { await source.close(); }
}

export class BackupService {
  constructor(private readonly workspace: BackupWorkspace, private readonly now: () => Date = () => new Date()) {}

  async createBackup(destinationPath: string): Promise<BackupResult> {
    const parent = dirname(destinationPath);
    await mkdir(parent, { recursive: true });
    await this.requireAbsent(destinationPath);
    const temporaryArchive = join(parent, `.${randomUUID()}.backup.tmp`);
    const staging = await mkdtemp(join(tmpdir(), "family-agent-backup-stage-"));
    try {
      const workspaceRoot = await realpath(this.workspace.workspaceRoot);
      const mediaRoot = await realpath(this.workspace.mediaRoot);
      if (!inside(workspaceRoot, mediaRoot) || !inside(workspaceRoot, await realpath(this.workspace.databasePath)) || !inside(workspaceRoot, await realpath(this.workspace.manifestPath))) {
        throw new BackupValidationError("WORKSPACE_MISMATCH", "Workspace paths are inconsistent");
      }
      const snapshotDatabase = join(staging, "genealogy.sqlite");
      const sourceDatabase = openDatabase(this.workspace.databasePath);
      try {
        const checkpoint = sourceDatabase.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
        if (checkpoint.some((entry) => entry.busy !== 0)) throw new BackupValidationError("DATABASE_INVALID", "Workspace database is busy and could not be checkpointed");
        await sourceDatabase.backup(snapshotDatabase);
      } finally { sourceDatabase.close(); }

      const snapshot = openDatabase(snapshotDatabase);
      let schemaVersion: number;
      let counts: BackupManifest["counts"];
      let media: MediaRow[];
      try {
        schemaVersion = Number(snapshot.pragma("user_version", { simple: true }));
        const integrity = snapshot.pragma("integrity_check", { simple: true });
        if (integrity !== "ok" || (snapshot.pragma("foreign_key_check") as unknown[]).length > 0) throw new BackupValidationError("DATABASE_INVALID", "Workspace database failed verification");
        const identity = snapshot.prepare("SELECT workspace_id, name FROM workspace_meta").all() as Array<{ workspace_id: string; name: string }>;
        if (identity.length !== 1 || identity[0]?.workspace_id !== this.workspace.workspaceId || identity[0]?.name !== this.workspace.workspaceName) {
          throw new BackupValidationError("WORKSPACE_MISMATCH", "Workspace database identity does not match the selected workspace");
        }
        counts = {
          people: Number(snapshot.prepare("SELECT COUNT(*) FROM person").pluck().get()),
          parentChild: Number(snapshot.prepare("SELECT COUNT(*) FROM parent_child").pluck().get()),
          marriages: Number(snapshot.prepare("SELECT COUNT(*) FROM marriage").pluck().get()),
          wikiEntries: Number(snapshot.prepare("SELECT COUNT(*) FROM wiki_entry").pluck().get()),
          auditRows: Number(snapshot.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()),
          mediaAssets: Number(snapshot.prepare("SELECT COUNT(*) FROM media_asset").pluck().get())
        };
        media = snapshot.prepare("SELECT relative_path, sha256, byte_size FROM media_asset ORDER BY relative_path, id").all() as MediaRow[];
      } finally { snapshot.close(); }

      const persistedWorkspace = workspaceManifestSchema.parse(JSON.parse(await readFile(this.workspace.manifestPath, "utf8")));
      if (persistedWorkspace.id !== this.workspace.workspaceId || persistedWorkspace.name !== this.workspace.workspaceName) throw new BackupValidationError("WORKSPACE_MISMATCH", "Workspace manifest identity does not match");
      const snapshotWorkspacePath = join(staging, "workspace.json");
      await writeFile(snapshotWorkspacePath, JSON.stringify({ ...persistedWorkspace, schemaVersion }, null, 2));

      const payloads: Payload[] = [];
      for (const [path, sourcePath] of [["genealogy.sqlite", snapshotDatabase], ["workspace.json", snapshotWorkspacePath]] as const) {
        const digest = await hashFile(sourcePath);
        payloads.push({ path, sourcePath, ...digest });
      }
      const mediaPaths = new Set<string>();
      for (const row of media) {
        const path = row.relative_path.replaceAll("\\", "/").normalize("NFC");
        if (!path.startsWith("media/") || canonicalArchivePath(path) !== path || mediaPaths.has(path.toLocaleLowerCase("en-US"))) {
          throw new BackupValidationError("MEDIA_INVALID", "Database declares an unsafe or duplicate media path");
        }
        mediaPaths.add(path.toLocaleLowerCase("en-US"));
        const sourcePath = resolve(workspaceRoot, ...path.split("/"));
        if (!inside(mediaRoot, sourcePath)) throw new BackupValidationError("MEDIA_INVALID", "Database media path leaves the managed media root");
        const canonicalSourcePath = await realpath(sourcePath).catch(() => {
          throw new BackupValidationError("MEDIA_INVALID", "A declared media object is missing or invalid");
        });
        if (!inside(mediaRoot, canonicalSourcePath)) throw new BackupValidationError("MEDIA_INVALID", "Database media path leaves the managed media root");
        const snapshotPath = resolve(staging, ...path.split("/"));
        await snapshotVerifiedFile(canonicalSourcePath, snapshotPath, { sha256: row.sha256, size: row.byte_size });
        payloads.push({ path, sourcePath: snapshotPath, size: row.byte_size, sha256: row.sha256 });
      }
      payloads.sort((left, right) => left.path.localeCompare(right.path, "en"));
      const manifest = backupManifestSchema.parse({
        formatVersion: 1,
        workspaceId: this.workspace.workspaceId,
        workspaceName: this.workspace.workspaceName,
        schemaVersion,
        createdAt: this.now().toISOString(),
        files: payloads.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
        counts
      });
      await this.writeArchive(temporaryArchive, manifest, payloads);
      const verified = await inspectBackupArchive(temporaryArchive, { stagingParent: staging });
      try {
        if (JSON.stringify(verified.manifest) !== JSON.stringify(manifest)) throw new BackupValidationError("MANIFEST_INVALID", "Created archive did not re-inspect to its manifest");
      } finally { await verified.dispose(); }
      await this.requireAbsent(destinationPath);
      await rename(temporaryArchive, destinationPath);
      return { manifest, archiveSha256: (await hashFile(destinationPath)).sha256 };
    } catch (error) {
      await rm(temporaryArchive, { force: true });
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async writeArchive(path: string, manifest: BackupManifest, payloads: readonly Payload[]): Promise<void> {
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    const archive = archiver("zip", { zlib: { level: 9 } });
    const closed = once(output, "close");
    archive.pipe(output);
    const date = new Date(manifest.createdAt);
    archive.append(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), { name: "backup-manifest.json", date });
    for (const payload of payloads) archive.file(payload.sourcePath, { name: payload.path, date });
    await archive.finalize();
    await closed;
    const handle = await open(path, constants.O_RDWR);
    try { await handle.sync(); }
    finally { await handle.close(); }
  }

  private async requireAbsent(path: string): Promise<void> {
    try {
      await lstat(path);
      throw new BackupValidationError("TARGET_INVALID", "Backup destination already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
