import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { UploadKind, UploadedFileToken } from "../../shared/contracts.js";
import { preflightXlsxArchive } from "../../main/application/import/workbook-parser.js";
import { sniffMediaHandle, type SniffedMediaMime } from "../../main/media/media-sniffer.js";

const FIFTEEN_MINUTES = 15 * 60_000;
const maximumBytes: Record<UploadKind, number> = { import: 32 * 1024 * 1024, media: 256 * 1024 * 1024, backup: 512 * 1024 * 1024 };
const mediaByExtension = new Map<string, SniffedMediaMime>([
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"],
  [".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".m4a", "audio/mp4"], [".mp4", "audio/mp4"], [".ogg", "audio/ogg"]
]);

export class UploadValidationError extends Error {
  constructor(public readonly statusCode: 400 | 413 | 415, message: string) { super(message); }
}

interface UploadEntry { path: string; fileName: string; kind: UploadKind; expiresAt: number; }
export type UploadClaim = { ok: true; path: string; fileName: string } | { ok: false; reason: "missing" | "expired" | "purpose" };
export interface UploadStoreOptions { root: string; now?: () => number; ttlMs?: number; }
export interface UploadFileInput { fileName: string; bytes?: Buffer; stream?: AsyncIterable<Buffer | Uint8Array | string>; }

const safeName = (value: string): string => {
  const normalized = basename(value).replace(/[\r\n\0]/gu, "").slice(0, 255);
  if (!normalized || normalized !== value) throw new UploadValidationError(400, "Invalid file name");
  return normalized;
};

export class UploadStore {
  private readonly entries = new Map<string, UploadEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly options: UploadStoreOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? FIFTEEN_MINUTES;
  }

  async uploadFile(kind: UploadKind, input: UploadFileInput): Promise<UploadedFileToken> {
    const fileName = safeName(input.fileName);
    this.assertExtension(kind, fileName);
    await mkdir(this.options.root, { recursive: true });
    const path = join(this.options.root, `${randomUUID()}${extname(fileName).toLocaleLowerCase("en-US")}`);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    let size = 0;
    try {
      const source: AsyncIterable<Buffer | Uint8Array | string> = input.stream ?? (async function* () { yield input.bytes ?? Buffer.alloc(0); })();
      for await (const value of source) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > maximumBytes[kind]) throw new UploadValidationError(413, "File exceeds the upload limit");
        await handle.write(chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(path, { force: true });
      throw error;
    }
    await handle.close();
    try { await this.validate(kind, fileName, path, size); }
    catch (error) { await rm(path, { force: true }); throw error; }
    const fileToken = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(fileToken, { path, fileName, kind, expiresAt });
    return { fileToken, fileName, kind, expiresAt: new Date(expiresAt).toISOString() };
  }

  async claim(token: string, kind: UploadKind): Promise<UploadClaim> {
    const entry = this.entries.get(token);
    if (!entry) return { ok: false, reason: "missing" };
    this.entries.delete(token);
    if (entry.expiresAt < this.now()) { await rm(entry.path, { force: true }); return { ok: false, reason: "expired" }; }
    if (entry.kind !== kind) { await rm(entry.path, { force: true }); return { ok: false, reason: "purpose" }; }
    return { ok: true, path: entry.path, fileName: entry.fileName };
  }

  async dispose(): Promise<void> {
    const paths = [...this.entries.values()].map((entry) => entry.path);
    this.entries.clear();
    await Promise.all(paths.map((path) => rm(path, { force: true })));
    await rm(this.options.root, { recursive: true, force: true });
  }

  private assertExtension(kind: UploadKind, fileName: string): void {
    const extension = extname(fileName).toLocaleLowerCase("en-US");
    const allowed = kind === "import" ? new Set([".xlsx", ".csv"]) : kind === "backup" ? new Set([".zip"]) : new Set(mediaByExtension.keys());
    if (!allowed.has(extension)) throw new UploadValidationError(415, "Unsupported file type");
  }

  private async validate(kind: UploadKind, fileName: string, path: string, size: number): Promise<void> {
    if (size === 0) throw new UploadValidationError(415, "Empty files are not supported");
    const extension = extname(fileName).toLocaleLowerCase("en-US");
    if (kind === "import" && extension === ".xlsx") {
      try { await preflightXlsxArchive(path); }
      catch { throw new UploadValidationError(415, "Invalid or unsafe Excel workbook"); }
    }
    if (kind === "backup") {
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { const header = Buffer.alloc(4); await handle.read(header, 0, 4, 0); if (!header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new UploadValidationError(415, "Invalid backup archive"); }
      finally { await handle.close(); }
    }
    if (kind === "media") {
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const header = Buffer.alloc(Math.min(65_536, size));
        await handle.read(header, 0, header.length, 0);
        const actual = await sniffMediaHandle(handle, header, size);
        if (actual !== mediaByExtension.get(extension)) throw new UploadValidationError(415, "Media bytes do not match the file extension");
      } finally { await handle.close(); }
    }
  }
}
