import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { BackupService } from "../../../src/main/application/backup/backup-service";
import { BackupValidationError, inspectBackupArchive, RestoreService, type ArchiveBounds } from "../../../src/main/application/backup/restore-service";
import { createBackupFixture } from "./backup-fixture";
import { readZipEntries, replaceZipEntryName, rewriteZip, writeZip } from "./backup-test-support";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const failure = (code: string) => expect.objectContaining<Partial<BackupValidationError>>({ code });
const entriesFrom = (entries: Map<string, Buffer>) => [...entries].map(([name, data]) => ({ name, data }));

describe("backup archive security preflight", () => {
  it("rejects parent traversal before extract-zip can create an outside directory", async () => {
    const value = await createBackupFixture(cleanup);
    const archive = join(value.root, "archives", "traversal.zip");
    await writeZip(archive, [{ name: "aa/escape.txt", data: Buffer.from("escape") }]);
    await replaceZipEntryName(archive, "aa/escape.txt", "../escape.txt");
    const stageParent = join(value.root, "staging"); await mkdir(stageParent);

    await expect(inspectBackupArchive(archive, { stagingParent: stageParent })).rejects.toThrowError(failure("ENTRY_PATH"));
    await expect(stat(join(value.root, "escape.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects case-insensitive collisions and duplicate-normalized names", async () => {
    const value = await createBackupFixture(cleanup);
    const archive = join(value.root, "archives", "collision.zip");
    await writeZip(archive, [{ name: "A.txt", data: Buffer.from("a") }, { name: "a.txt", data: Buffer.from("b") }]);
    await expect(inspectBackupArchive(archive, { stagingParent: value.root })).rejects.toThrowError(failure("ENTRY_COLLISION"));
  });

  it("rejects symlinks and directory or special entries", async () => {
    const value = await createBackupFixture(cleanup);
    const symlink = join(value.root, "archives", "symlink.zip");
    await writeZip(symlink, [{ name: "linked", symlinkTarget: "genealogy.sqlite" }]);
    await expect(inspectBackupArchive(symlink, { stagingParent: value.root })).rejects.toThrowError(failure("ENTRY_TYPE"));
    const directory = join(value.root, "archives", "directory.zip");
    await writeZip(directory, [{ name: "folder", directory: true }]);
    await expect(inspectBackupArchive(directory, { stagingParent: value.root })).rejects.toThrowError(failure("ENTRY_TYPE"));
  });

  it("rejects extra and missing entries against the signed manifest whitelist", async () => {
    const value = await createBackupFixture(cleanup);
    await new BackupService(value.workspace).createBackup(value.archivePath);
    const extra = join(value.root, "archives", "extra.zip");
    await writeZip(extra, [...entriesFrom(await readZipEntries(value.archivePath)), { name: "extra.txt", data: Buffer.from("extra") }]);
    await expect(inspectBackupArchive(extra, { stagingParent: value.root })).rejects.toThrowError(failure("ENTRY_WHITELIST"));

    const missing = join(value.root, "archives", "missing.zip");
    const entries = await readZipEntries(value.archivePath);
    const manifest = JSON.parse(entries.get("backup-manifest.json")!.toString("utf8")) as { files: Array<{ path: string }> };
    entries.delete(manifest.files[0]!.path);
    await writeZip(missing, entriesFrom(entries));
    await expect(inspectBackupArchive(missing, { stagingParent: value.root })).rejects.toThrowError(failure("ENTRY_WHITELIST"));
  });

  it("rejects a correctly hashed payload outside the format-1 semantic set and removes its stage", async () => {
    const value = await createBackupFixture(cleanup);
    await new BackupService(value.workspace).createBackup(value.archivePath);
    const forged = join(value.root, "archives", "forged-extra.zip");
    await writeZip(forged, entriesFrom(await readZipEntries(value.archivePath)));
    await rewriteZip(forged, (entries) => {
      const extra = Buffer.from("correctly hashed but not semantically allowed");
      entries.set("notes.txt", extra);
      const manifest = JSON.parse(entries.get("backup-manifest.json")!.toString("utf8")) as { files: Array<{ path: string; size: number; sha256: string }> };
      manifest.files.push({ path: "notes.txt", size: extra.length, sha256: createHash("sha256").update(extra).digest("hex") });
      entries.set("backup-manifest.json", Buffer.from(JSON.stringify(manifest)));
      return entriesFrom(entries);
    });

    await expect(inspectBackupArchive(forged, { stagingParent: value.root })).rejects.toThrowError(failure("ENTRY_WHITELIST"));
    expect((await readdir(value.root)).filter((name) => name.startsWith(".family-restore-stage-"))).toEqual([]);
  });

  it("rejects a payload whose bytes no longer match the manifest hash", async () => {
    const value = await createBackupFixture(cleanup);
    await new BackupService(value.workspace).createBackup(value.archivePath);
    const tampered = join(value.root, "archives", "tampered.zip");
    await writeZip(tampered, entriesFrom(await readZipEntries(value.archivePath)));
    await rewriteZip(tampered, (entries) => {
      entries.set("workspace.json", Buffer.from("{\"tampered\":true}"));
      return entriesFrom(entries);
    });
    await expect(inspectBackupArchive(tampered, { stagingParent: value.root })).rejects.toThrowError(failure("HASH_MISMATCH"));
  });

  it("rejects a workspace manifest schema that disagrees with the verified database and backup manifest", async () => {
    const value = await createBackupFixture(cleanup);
    await new BackupService(value.workspace).createBackup(value.archivePath);
    const tampered = join(value.root, "archives", "workspace-schema.zip");
    await writeZip(tampered, entriesFrom(await readZipEntries(value.archivePath)));
    await rewriteZip(tampered, (entries) => {
      const workspace = JSON.parse(entries.get("workspace.json")!.toString("utf8")) as { schemaVersion: number };
      const bytes = Buffer.from(JSON.stringify({ ...workspace, schemaVersion: 3 }));
      entries.set("workspace.json", bytes);
      const manifest = JSON.parse(entries.get("backup-manifest.json")!.toString("utf8")) as { files: Array<{ path: string; size: number; sha256: string }> };
      const file = manifest.files.find((entry) => entry.path === "workspace.json")!;
      file.size = bytes.length;
      file.sha256 = createHash("sha256").update(bytes).digest("hex");
      entries.set("backup-manifest.json", Buffer.from(JSON.stringify(manifest)));
      return entriesFrom(entries);
    });
    await expect(inspectBackupArchive(tampered, { stagingParent: value.root })).rejects.toThrowError(failure("WORKSPACE_MISMATCH"));
  });

  it.each([
    ["a missing person.notes column", "ALTER TABLE person DROP COLUMN notes"],
    ["a missing wiki FTS trigger", "DROP TRIGGER wiki_fts_after_update"]
  ])("rejects a hash-correct archive with %s", async (_case, mutation) => {
    const value = await createBackupFixture(cleanup);
    await new BackupService(value.workspace).createBackup(value.archivePath);
    const forged = join(value.root, "archives", `schema-${createHash("sha256").update(mutation).digest("hex").slice(0, 8)}.zip`);
    await writeZip(forged, entriesFrom(await readZipEntries(value.archivePath)));
    await rewriteZip(forged, (entries) => entriesFrom(entries));
    const entries = await readZipEntries(forged);
    const databasePath = join(value.root, "tampered-schema.sqlite");
    await writeFile(databasePath, entries.get("genealogy.sqlite")!);
    const database = new Database(databasePath);
    database.exec(mutation);
    database.close();
    const bytes = await readFile(databasePath);
    entries.set("genealogy.sqlite", bytes);
    const manifest = JSON.parse(entries.get("backup-manifest.json")!.toString("utf8")) as { files: Array<{ path: string; size: number; sha256: string }> };
    const file = manifest.files.find((entry) => entry.path === "genealogy.sqlite")!;
    file.size = bytes.length;
    file.sha256 = createHash("sha256").update(bytes).digest("hex");
    entries.set("backup-manifest.json", Buffer.from(JSON.stringify(manifest)));
    const corrupted = `${forged}.corrupted`;
    await writeZip(corrupted, entriesFrom(entries));

    await expect(inspectBackupArchive(corrupted, { stagingParent: value.root })).rejects.toThrowError(failure("DATABASE_INVALID"));
  });

  it.each([
    ["entry count", { maxEntries: 1 }, "ARCHIVE_LIMIT"],
    ["entry size", { maxEntryBytes: 8 }, "ARCHIVE_LIMIT"],
    ["total size", { maxTotalBytes: 16 }, "ARCHIVE_LIMIT"],
    ["compression ratio", { maxCompressionRatio: 1.01, minRatioBytes: 1 }, "ARCHIVE_LIMIT"]
  ] as Array<[string, Partial<ArchiveBounds>, string]>)("rejects the configured %s bound", async (_name, bounds, code) => {
    const value = await createBackupFixture(cleanup);
    await new BackupService(value.workspace).createBackup(value.archivePath);
    await expect(inspectBackupArchive(value.archivePath, { stagingParent: value.root, bounds })).rejects.toThrowError(failure(code));
  });

  it("enforces aggregate compression-ratio limits when entries individually stay below the threshold", async () => {
    const value = await createBackupFixture(cleanup);
    const archive = join(value.root, "archives", "split-ratio.zip");
    await writeZip(archive, ["a", "b", "c", "d"].map((name) => ({ name: `${name}.txt`, data: Buffer.alloc(100, 0x41) })));

    await expect(inspectBackupArchive(archive, {
      stagingParent: value.root,
      bounds: { minRatioBytes: 150, maxCompressionRatio: 2 }
    })).rejects.toThrowError(failure("ARCHIVE_LIMIT"));
  });

  it("applies independent tight limits to backup and workspace control files", async () => {
    const value = await createBackupFixture(cleanup);
    await new BackupService(value.workspace).createBackup(value.archivePath);

    await expect(inspectBackupArchive(value.archivePath, {
      stagingParent: value.root,
      bounds: { maxBackupManifestBytes: 16 }
    })).rejects.toThrowError(failure("ARCHIVE_LIMIT"));
    await expect(inspectBackupArchive(value.archivePath, {
      stagingParent: value.root,
      bounds: { maxWorkspaceManifestBytes: 16 }
    })).rejects.toThrowError(failure("ARCHIVE_LIMIT"));
  });

  it("rejects a restore without an existing non-null origin person", async () => {
    const value = await createBackupFixture(cleanup);
    await new BackupService(value.workspace).createBackup(value.archivePath);
    const invalid = join(value.root, "archives", "missing-origin.zip");
    await writeZip(invalid, entriesFrom(await readZipEntries(value.archivePath)));
    await rewriteZip(invalid, (entries) => {
      const workspace = JSON.parse(entries.get("workspace.json")!.toString("utf8")) as Record<string, unknown>;
      const bytes = Buffer.from(JSON.stringify({ ...workspace, originPersonId: null }));
      entries.set("workspace.json", bytes);
      const manifest = JSON.parse(entries.get("backup-manifest.json")!.toString("utf8")) as { files: Array<{ path: string; size: number; sha256: string }> };
      const file = manifest.files.find((entry) => entry.path === "workspace.json")!;
      file.size = bytes.length;
      file.sha256 = createHash("sha256").update(bytes).digest("hex");
      entries.set("backup-manifest.json", Buffer.from(JSON.stringify(manifest)));
      return entriesFrom(entries);
    });
    const restore = new RestoreService({
      resolveTarget: async () => value.target,
      acquireExclusive: async () => ({ release: () => undefined }),
      createVerifiedSnapshot: async () => undefined,
      deactivate: async () => undefined,
      commitActivation: async () => undefined,
      rollbackActivation: async () => undefined
    });

    await expect(restore.inspectBackup({ archivePath: invalid, targetWorkspaceId: value.target.workspaceId }))
      .rejects.toThrowError(failure("WORKSPACE_MISMATCH"));
    expect((await readdir(join(value.root, "workspaces"))).filter((name) => name.startsWith(".family-restore-stage-"))).toEqual([]);
  });

  it("rejects Windows drive, ADS, reserved, trailing-dot, empty, and overlong names", async () => {
    const invalidNames = ["C:/evil.txt", "safe/name:stream", "CON.txt", "bad./file", "a//b", `${"a".repeat(256)}.txt`];
    for (const [index, name] of invalidNames.entries()) {
      const value = await createBackupFixture(cleanup);
      const archive = join(value.root, "archives", `invalid-${index}.zip`);
      if (name === "C:/evil.txt") {
        await writeZip(archive, [{ name: "aa/evil.txt", data: Buffer.from("x") }]);
        await replaceZipEntryName(archive, "aa/evil.txt", name);
      } else if (name === "a//b") {
        // Archiver normalizes empty segments, so patch both ZIP headers to exercise the reader boundary.
        await writeZip(archive, [{ name: "aa/b", data: Buffer.from("x") }]);
        await replaceZipEntryName(archive, "aa/b", name);
      } else {
        await writeZip(archive, [{ name, data: Buffer.from("x") }]);
      }
      await expect(inspectBackupArchive(archive, { stagingParent: value.root }), name).rejects.toThrowError(failure("ENTRY_PATH"));
    }
  });
});
