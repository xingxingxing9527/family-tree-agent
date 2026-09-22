import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { IMPORT_TEMPLATE_COLUMNS, parseImport, preflightXlsxArchive } from "../../../src/main/application/import/workbook-parser";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const u16 = (value: number) => Buffer.from([value & 255, value >>> 8]);
const u32 = (value: number) => Buffer.from([value & 255, value >>> 8, value >>> 16, value >>> 24]);
const zip = (name: string, uncompressed: number, compressed = 1): Buffer => {
  const fileName = Buffer.from(name);
  const local = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(compressed), u32(uncompressed), u16(fileName.length), u16(0), fileName, Buffer.alloc(compressed)]);
  const central = Buffer.concat([Buffer.from([0x50, 0x4b, 1, 2]), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(compressed), u32(uncompressed), u16(fileName.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), fileName]);
  return Buffer.concat([local, central, Buffer.from([0x50, 0x4b, 5, 6]), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)]);
};

describe("XLSX import preflight", () => {
  it.each([
    ["xl/vbaProject.bin", 1, 1, /forbidden/i],
    ["../xl/workbook.xml", 1, 1, /unsafe/i],
    ["xl/worksheets/sheet1.xml", 30 * 1024 * 1024, 1, /uncompressed|ratio/i]
  ])("rejects hostile archive entry %s before workbook expansion", async (entry, size, compressed, expected) => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-import-zip-")); roots.push(root);
    const file = join(root, "hostile.xlsx"); await writeFile(file, zip(entry, size, compressed));
    await expect(preflightXlsxArchive(file)).rejects.toThrow(expected);
  });

  it("rejects an XLSX workbook with extra sheets or columns", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-import-template-")); roots.push(root);
    const file = join(root, "extra.xlsx"); const workbook = new ExcelJS.Workbook();
    for (const [sheet, columns] of Object.entries(IMPORT_TEMPLATE_COLUMNS)) workbook.addWorksheet(sheet).addRow([...columns, "unexpected"]);
    workbook.addWorksheet("Extra"); await workbook.xlsx.writeFile(file);
    await expect(parseImport(file, "strict-template")).rejects.toThrow(/exact template/i);
  });
});
