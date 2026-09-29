import { isAbsolute } from "node:path";
import yauzl from "yauzl";

export interface ZipScanBounds {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
}

const DEFAULT_BOUNDS: ZipScanBounds = {
  maxEntries: 4_096,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 1_000
};

export interface PlaintextZipLeak {
  entryName: string;
  encoding: "utf8" | "utf16le";
}

function safeEntryName(raw: string): string {
  const normalized = raw.replaceAll("\\", "/");
  const comparable = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (!normalized || isAbsolute(normalized) || normalized.startsWith("/")
    || !comparable || comparable.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`ZIP scan rejected unsafe entry name: ${raw}`);
  }
  return normalized;
}

export async function findPlaintextInBoundedZip(
  archivePath: string,
  sentinel: string,
  bounds: ZipScanBounds = DEFAULT_BOUNDS
): Promise<PlaintextZipLeak[]> {
  if (!sentinel) throw new Error("ZIP plaintext sentinel is required");
  const archive = await new Promise<yauzl.ZipFile>((resolveOpen, rejectOpen) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error || !zip) rejectOpen(error ?? new Error("ZIP scan could not open archive"));
      else resolveOpen(zip);
    });
  });
  const utf8 = Buffer.from(sentinel, "utf8");
  const utf16 = Buffer.from(sentinel, "utf16le");
  const leaks: PlaintextZipLeak[] = [];
  let entries = 0;
  let totalBytes = 0;

  try {
    await new Promise<void>((resolveScan, rejectScan) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        rejectScan(error);
      };
      archive.once("error", fail);
      archive.once("end", () => {
        if (settled) return;
        settled = true;
        resolveScan();
      });
      archive.on("entry", (entry) => {
        try {
          entries += 1;
          if (entries > bounds.maxEntries) throw new Error("ZIP scan entry-count bound exceeded");
          const entryName = safeEntryName(entry.fileName);
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new Error("ZIP scan rejects encrypted entries");
          if (entryName.endsWith("/")) {
            archive.readEntry();
            return;
          }
          if (entry.uncompressedSize > bounds.maxEntryBytes) throw new Error("ZIP scan entry-size bound exceeded");
          if (entry.uncompressedSize > 0 && entry.compressedSize === 0) throw new Error("ZIP scan compression bound exceeded");
          if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > bounds.maxCompressionRatio) {
            throw new Error("ZIP scan compression-ratio bound exceeded");
          }
          totalBytes += entry.uncompressedSize;
          if (totalBytes > bounds.maxTotalBytes) throw new Error("ZIP scan total-size bound exceeded");
          archive.openReadStream(entry, (error, stream) => {
            if (error || !stream) { fail(error ?? new Error("ZIP scan could not decompress entry")); return; }
            const chunks: Buffer[] = [];
            let actualBytes = 0;
            stream.on("data", (chunk: Buffer) => {
              actualBytes += chunk.length;
              if (actualBytes > entry.uncompressedSize || actualBytes > bounds.maxEntryBytes) {
                stream.destroy(new Error("ZIP scan decompressed entry exceeded its bound"));
                return;
              }
              chunks.push(chunk);
            });
            stream.once("error", fail);
            stream.once("end", () => {
              if (settled) return;
              const bytes = Buffer.concat(chunks);
              if (bytes.includes(utf8)) leaks.push({ entryName, encoding: "utf8" });
              if (bytes.includes(utf16)) leaks.push({ entryName, encoding: "utf16le" });
              archive.readEntry();
            });
          });
        } catch (error) {
          fail(error);
        }
      });
      archive.readEntry();
    });
  } finally {
    archive.close();
  }
  return leaks.sort((left, right) => left.entryName.localeCompare(right.entryName) || left.encoding.localeCompare(right.encoding));
}
