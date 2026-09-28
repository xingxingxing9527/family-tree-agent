import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppErrorCode, AppResult } from "../../shared/contracts.js";
import type { WorkspaceDatabase } from "../database/open-database.js";
import { createUnitOfWork } from "../database/unit-of-work.js";

export type ManagedMediaMime = "image/jpeg" | "image/png" | "image/webp" | "audio/mpeg" | "audio/wav" | "audio/mp4" | "audio/ogg";
export interface MediaAssetDto { id: string; fileName: string; mimeType: ManagedMediaMime; byteSize: number; sha256: string; url: string; }
export interface MediaPersonDto extends MediaAssetDto { caption: string | null; }
type Result<T> = AppResult<T>;
const failure = <T>(code: AppErrorCode, message: string): Result<T> => ({ ok: false, error: { code, message } });

const allowed = new Map<string, ManagedMediaMime>([
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"],
  [".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".m4a", "audio/mp4"], [".mp4", "audio/mp4"], [".ogg", "audio/ogg"]
]);
const canonicalExtension = new Map<ManagedMediaMime, string>([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"], ["audio/mpeg", "mp3"], ["audio/wav", "wav"], ["audio/mp4", "m4a"], ["audio/ogg", "ogg"]]);
const allowedMimeValues = new Set<ManagedMediaMime>(canonicalExtension.keys());

function sniffMime(bytes: Buffer): ManagedMediaMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return "audio/mp4";
  if (bytes.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  return null;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class ManagedMediaService {
  private readonly workspaceRoot: string;
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string, private readonly mediaRoot: string) {
    this.workspaceRoot = resolve(mediaRoot, "..");
  }

  async importMedia(input: { sourcePath: string; selectedSourcePath: string }): Promise<Result<MediaAssetDto>> {
    let source: string; let selected: string;
    try { [source, selected] = await Promise.all([realpath(input.sourcePath), realpath(input.selectedSourcePath)]); }
    catch { return failure("PATH_DENIED", "Selected media file is unavailable"); }
    if (source !== selected) return failure("PATH_DENIED", "Media source does not match the selected file");
    const expectedMime = allowed.get(extname(source).toLocaleLowerCase());
    if (!expectedMime) return failure("VALIDATION", "Selected media type is not supported");
    let bytes: Buffer; let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(source); const handle = await open(source, "r");
      try { const buffer = Buffer.alloc(32); const read = await handle.read(buffer, 0, buffer.length, 0); bytes = buffer.subarray(0, read.bytesRead); } finally { await handle.close(); }
    } catch { return failure("VALIDATION", "Selected media file is unavailable"); }
    const detectedMime = sniffMime(bytes);
    if (!metadata.isFile() || detectedMime !== expectedMime) return failure("VALIDATION", "Selected media content does not match its supported type");

    const hash = createHash("sha256"); let byteSize = 0;
    const destinationDirectory = join(resolve(this.mediaRoot), "pending");
    const temporary = join(destinationDirectory, `.${randomUUID()}.tmp`);
    try {
      await mkdir(destinationDirectory, { recursive: true });
      await pipeline(createReadStream(source), new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); byteSize += chunk.length; callback(null, chunk); } }), createWriteStream(temporary, { flags: "wx" }));
      const sha256 = hash.digest("hex"); const extension = canonicalExtension.get(detectedMime)!;
      const targetDirectory = join(resolve(this.mediaRoot), sha256.slice(0, 2));
      const destination = join(targetDirectory, `${sha256}.${extension}`);
      if (!isWithin(resolve(this.mediaRoot), destination)) return failure("PATH_DENIED", "Managed media path was denied");
      await mkdir(targetDirectory, { recursive: true });
      const temporaryFile = await open(temporary, "r+");
      try { await temporaryFile.sync(); } finally { await temporaryFile.close(); }
      try { await rename(temporary, destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const relativePath = relative(this.workspaceRoot, destination);
      if (!relativePath.replaceAll("\\", "/").startsWith("media/")) return failure("PATH_DENIED", "Managed media path was denied");
      const existing = this.database.prepare("SELECT id, original_name, mime_type, byte_size, sha256 FROM media_asset WHERE workspace_id = ? AND sha256 = ? AND deleted_at IS NULL").get(this.workspaceId, sha256) as { id: string; original_name: string; mime_type: ManagedMediaMime; byte_size: number; sha256: string } | undefined;
      if (existing) return { ok: true, value: this.asset(existing) };
      const record = createUnitOfWork(this.database, this.workspaceId).run("media-import", (ctx) => {
        const id = randomUUID(); const now = new Date().toISOString(); const after = { id, sha256, originalName: basename(source), mimeType: detectedMime, byteSize, relativePath };
        this.database.prepare("INSERT INTO media_asset (id, workspace_id, sha256, original_name, mime_type, byte_size, relative_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, this.workspaceId, sha256, basename(source), detectedMime, byteSize, relativePath, now, now);
        ctx.audit.append({ entityType: "media_asset", entityId: id, action: "create", before: null, after });
        return after;
      });
      return { ok: true, value: { id: record.id, fileName: record.originalName, mimeType: record.mimeType, byteSize: record.byteSize, sha256: record.sha256, url: `app-media://asset/${record.id}` } };
    } catch { return failure("INTERNAL", "Unable to import media"); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  attachMedia(input: { mediaAssetId: string; personId: string; caption?: string | null }): Result<null> {
    try {
      createUnitOfWork(this.database, this.workspaceId).run("media-attach", (ctx) => {
        const asset = this.database.prepare("SELECT id FROM media_asset WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL").get(input.mediaAssetId, this.workspaceId);
        if (!asset) throw new Error("Media asset not found");
        const id = randomUUID(); const now = new Date().toISOString();
        this.database.prepare("INSERT INTO media_person (id, workspace_id, media_asset_id, person_id, caption, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, this.workspaceId, input.mediaAssetId, input.personId, input.caption?.trim() || null, now, now);
        ctx.audit.append({ entityType: "media_person", entityId: id, action: "create", before: null, after: { mediaAssetId: input.mediaAssetId, personId: input.personId } });
      });
      return { ok: true, value: null };
    } catch (error) { return failure(/not found|FOREIGN KEY/i.test(error instanceof Error ? error.message : "") ? "NOT_FOUND" : "CONFLICT", "Unable to attach media"); }
  }

  listForPerson(personId: string): MediaPersonDto[] {
    const rows = this.database.prepare(`SELECT asset.id, asset.original_name, asset.mime_type, asset.byte_size, asset.sha256, link.caption
      FROM media_person AS link JOIN media_asset AS asset ON asset.id = link.media_asset_id
      WHERE link.workspace_id = ? AND link.person_id = ? AND link.deleted_at IS NULL AND asset.deleted_at IS NULL ORDER BY link.sort_order, link.id`).all(this.workspaceId, personId) as Array<{ id: string; original_name: string; mime_type: ManagedMediaMime; byte_size: number; sha256: string; caption: string | null }>;
    return rows.map((row) => ({ ...this.asset(row), caption: row.caption }));
  }

  private asset(row: { id: string; original_name: string; mime_type: ManagedMediaMime; byte_size: number; sha256: string }): MediaAssetDto {
    return { id: row.id, fileName: row.original_name, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256, url: `app-media://asset/${row.id}` };
  }
}

export const isAllowedMediaMime = (mimeType: string): mimeType is ManagedMediaMime => allowedMimeValues.has(mimeType as ManagedMediaMime);
