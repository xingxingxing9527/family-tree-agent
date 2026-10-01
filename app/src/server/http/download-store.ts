import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { DownloadDescriptor } from "../../shared/contracts.js";

const FIFTEEN_MINUTES = 15 * 60_000;
interface DownloadPayload { fileName: string; mimeType: string; bytes: Buffer; }
interface DownloadEntry extends DownloadPayload { expiresAt: number; }
export type DownloadClaim = { status: "ok"; value: DownloadPayload } | { status: "missing" } | { status: "expired" };
export interface DownloadStoreOptions { now?: () => number; ttlMs?: number; }

export class DownloadStore {
  private readonly entries = new Map<string, DownloadEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(options: DownloadStoreOptions = {}) { this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? FIFTEEN_MINUTES; }

  createDownload(payload: DownloadPayload): DownloadDescriptor {
    const fileName = basename(payload.fileName).replace(/[\r\n\0]/gu, "").slice(0, 255) || "download.bin";
    const token = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(token, { ...payload, fileName, expiresAt });
    return { downloadUrl: `/api/downloads/${token}`, fileName, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(token: string): DownloadClaim {
    const entry = this.entries.get(token);
    if (!entry) return { status: "missing" };
    this.entries.delete(token);
    if (entry.expiresAt < this.now()) return { status: "expired" };
    return { status: "ok", value: { fileName: entry.fileName, mimeType: entry.mimeType, bytes: entry.bytes } };
  }

  dispose(): void { this.entries.clear(); }
}
