import { randomUUID } from "node:crypto";
import type ExcelJS from "exceljs";
import { CHINESE_WORKBOOK_SCHEMA_VERSION, type ChineseWorkbookKind } from "./chinese-workbook-schema.js";

export interface WorkbookMetadata {
  workbookId: string;
  batchId: string;
  workspaceId: string;
  kind: ChineseWorkbookKind;
  schemaVersion: number;
}

const keys = ["workbookId", "batchId", "workspaceId", "kind", "schemaVersion"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const createWorkbookMetadata = (workspaceId: string, kind: ChineseWorkbookKind): WorkbookMetadata => ({
  workbookId: randomUUID(),
  batchId: randomUUID(),
  workspaceId,
  kind,
  schemaVersion: CHINESE_WORKBOOK_SCHEMA_VERSION
});

export function writeWorkbookMetadata(worksheet: ExcelJS.Worksheet, metadata: WorkbookMetadata): void {
  worksheet.addRow(["键", "值"]);
  for (const key of keys) worksheet.addRow([key, metadata[key]]);
  worksheet.state = "veryHidden";
}

export function readWorkbookMetadata(worksheet: ExcelJS.Worksheet): WorkbookMetadata {
  const values = new Map<string, unknown>();
  for (let row = 2; row <= 6; row += 1) values.set(String(worksheet.getCell(row, 1).value ?? ""), worksheet.getCell(row, 2).value);
  const metadata = {
    workbookId: String(values.get("workbookId") ?? ""),
    batchId: String(values.get("batchId") ?? ""),
    workspaceId: String(values.get("workspaceId") ?? ""),
    kind: String(values.get("kind") ?? "") as ChineseWorkbookKind,
    schemaVersion: Number(values.get("schemaVersion"))
  };
  if (!uuid.test(metadata.workbookId) || !uuid.test(metadata.batchId) || !metadata.workspaceId.trim()) throw new Error("Workbook metadata is invalid");
  if (metadata.kind !== "current" && metadata.kind !== "blank") throw new Error("Workbook metadata kind is invalid");
  if (metadata.schemaVersion !== CHINESE_WORKBOOK_SCHEMA_VERSION) throw new Error("Workbook schema version is not supported");
  return metadata;
}

export const workbookSourceKey = (metadata: WorkbookMetadata): string => `family-workbook:${metadata.workbookId}:${metadata.batchId}`;
