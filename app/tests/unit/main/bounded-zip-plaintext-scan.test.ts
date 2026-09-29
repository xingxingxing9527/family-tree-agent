import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPlaintextInBoundedZip } from "../../support/bounded-zip-plaintext-scan";
import { writeZip } from "../../integration/backup/backup-test-support";

describe("bounded ZIP plaintext scanner", () => {
  it("decompresses entries before checking UTF-8 and UTF-16 plaintext", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-zip-scan-"));
    const archive = join(root, "compressed.zip");
    const sentinel = "sk-task15-COMPRESSED-PLAINTEXT-20260916";
    try {
      await writeZip(archive, [
        { name: "utf8.txt", data: Buffer.from(`${sentinel}\n`.repeat(20), "utf8") },
        { name: "utf16.bin", data: Buffer.from(`${sentinel}\n`.repeat(20), "utf16le") }
      ]);
      const raw = await readFile(archive);
      expect(raw.includes(Buffer.from(sentinel, "utf8"))).toBe(false);

      await expect(findPlaintextInBoundedZip(archive, sentinel)).resolves.toEqual([
        { entryName: "utf16.bin", encoding: "utf16le" },
        { entryName: "utf8.txt", encoding: "utf8" }
      ]);
      await expect(findPlaintextInBoundedZip(archive, sentinel, {
        maxEntries: 10,
        maxEntryBytes: 8,
        maxTotalBytes: 16,
        maxCompressionRatio: 100
      })).rejects.toThrow(/bound|entry|size/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
