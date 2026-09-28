import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import archiver from "archiver";
import yauzl from "yauzl";

export interface ZipEntryFixture {
  name: string;
  data?: Buffer;
  symlinkTarget?: string;
  directory?: boolean;
}

export async function readZipEntries(path: string): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true }, (error, value) => error || !value ? reject(error ?? new Error("zip unavailable")) : resolve(value)));
  const entries = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.once("error", reject);
    zip.once("end", resolve);
    zip.on("entry", (entry) => {
      if (entry.fileName.endsWith("/")) { entries.set(entry.fileName, Buffer.alloc(0)); zip.readEntry(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { reject(error ?? new Error("entry stream unavailable")); return; }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        stream.once("error", reject);
        stream.once("end", () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
  zip.close();
  return entries;
}

export async function writeZip(path: string, entries: readonly ZipEntryFixture[]): Promise<void> {
  const output = createWriteStream(path, { flags: "wx" });
  const archive = archiver("zip", { zlib: { level: 9 } });
  const closed = once(output, "close");
  archive.pipe(output);
  for (const entry of entries) {
    if (entry.symlinkTarget !== undefined) archive.symlink(entry.name, entry.symlinkTarget);
    else if (entry.directory) archive.append(Buffer.alloc(0), { name: entry.name.endsWith("/") ? entry.name : `${entry.name}/`, type: "directory" });
    else archive.append(entry.data ?? Buffer.alloc(0), { name: entry.name });
  }
  await archive.finalize();
  await closed;
}

export async function rewriteZip(path: string, mutate: (entries: Map<string, Buffer>) => ZipEntryFixture[]): Promise<void> {
  const entries = await readZipEntries(path);
  await writeZip(`${path}.next`, mutate(entries));
  await writeFile(path, await readFile(`${path}.next`));
}

export async function replaceZipEntryName(path: string, from: string, to: string): Promise<void> {
  const source = Buffer.from(from);
  const replacement = Buffer.from(to);
  if (source.length !== replacement.length) throw new Error("replacement names must have equal byte length");
  const bytes = await readFile(path);
  let replacements = 0;
  for (let offset = 0; offset <= bytes.length - source.length; offset += 1) {
    if (!bytes.subarray(offset, offset + source.length).equals(source)) continue;
    replacement.copy(bytes, offset);
    replacements += 1;
    offset += source.length - 1;
  }
  if (replacements < 2) throw new Error("zip name was not found in local and central headers");
  await writeFile(path, bytes);
}
