import { describe, expect, it, vi } from "vitest";
import type { AppResult, ImportCommitReportDto, ImportPlanDto } from "../../../src/shared/contracts";
import { IMPORT_CHANNELS, registerImportIpc, type ImportGateway } from "../../../src/main/ipc/import-ipc";

type Handler = (event: { sender: { id: number } }, payload?: unknown) => Promise<unknown> | unknown;

const plan: ImportPlanDto = {
  id: "plan-1",
  sourceKey: "archive:one",
  fileName: "family.xlsx",
  actions: [],
  issues: [],
  summary: { creates: 0, updates: 0, unchanged: 0, blocked: 0 }
};
const report: ImportCommitReportDto = { planId: "plan-1", sourceKey: "archive:one", operationGroupId: null, rows: [] };

function gateway(): ImportGateway {
  return {
    selectImportFile: vi.fn().mockResolvedValue({ ok: true, value: { fileToken: "11111111-1111-4111-8111-111111111111", fileName: "family.xlsx" } }),
    parseImport: vi.fn().mockResolvedValue({ ok: true, value: plan } satisfies AppResult<ImportPlanDto>),
    commitImport: vi.fn().mockResolvedValue({ ok: true, value: report } satisfies AppResult<ImportCommitReportDto>),
    exportTemplate: vi.fn().mockResolvedValue({ ok: true, value: { saved: true } })
  };
}

function setup(imports = gateway()): { imports: ImportGateway; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  registerImportIpc({ handle: (channel, handler) => handlers.set(channel, handler as Handler) }, () => 7, imports);
  return { imports, handlers };
}

describe("import IPC contracts", () => {
  it("registers only the fixed import channels", () => {
    expect([...setup().handlers.keys()].sort()).toEqual(["imports:commit", "imports:export-template", "imports:parse", "imports:select-file"].sort());
  });

  it("asks the main process to select a file without accepting a renderer path", async () => {
    const { imports, handlers } = setup();
    const result = await handlers.get(IMPORT_CHANNELS.selectFile)!({ sender: { id: 7 } }, {});
    expect(result).toMatchObject({ ok: true, value: { fileToken: expect.any(String), fileName: "family.xlsx" } });
    expect(imports.selectImportFile).toHaveBeenCalledWith();
  });

  it.each([
    [IMPORT_CHANNELS.parse, { fileToken: "not-a-token", sourceKey: "archive" }],
    [IMPORT_CHANNELS.parse, { fileToken: "11111111-1111-4111-8111-111111111111", sourceKey: "", csvEntityType: "People" }],
    [IMPORT_CHANNELS.parse, { fileToken: "11111111-1111-4111-8111-111111111111", sourceKey: "archive", csvEntityType: "Unknown" }],
    [IMPORT_CHANNELS.commit, { planId: "", selectedActionIds: [] }],
    [IMPORT_CHANNELS.commit, { planId: "plan", selectedActionIds: ["same", "same"] }],
    [IMPORT_CHANNELS.exportTemplate, { targetFile: "template.csv" }]
  ])("rejects malformed payloads on %s before invoking the gateway", async (channel, payload) => {
    const { imports, handlers } = setup();
    const result = await handlers.get(channel)!({ sender: { id: 7 } }, payload);
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION", message: "Invalid request" } });
    expect(Object.values(imports).every((method) => !vi.mocked(method).mock.calls.length)).toBe(true);
  });

  it("rejects calls from a non-main-window sender", async () => {
    const { imports, handlers } = setup();
    const result = await handlers.get(IMPORT_CHANNELS.parse)!({ sender: { id: 8 } }, { fileToken: "11111111-1111-4111-8111-111111111111", sourceKey: "archive" });
    expect(result).toEqual({ ok: false, error: { code: "PATH_DENIED", message: "IPC sender was denied" } });
    expect(imports.parseImport).not.toHaveBeenCalled();
  });

  it("forwards exact source keys and field mappings without renderer file parsing", async () => {
    const { imports, handlers } = setup();
    const payload = { fileToken: "11111111-1111-4111-8111-111111111111", sourceKey: " Archive Key ", csvEntityType: "People", fieldMapping: { name: "姓名" } };
    const result = await handlers.get(IMPORT_CHANNELS.parse)!({ sender: { id: 7 } }, payload);
    expect(result).toEqual({ ok: true, value: plan });
    expect(imports.parseImport).toHaveBeenCalledWith(payload);
  });

  it("sanitizes unexpected exceptions without returning paths, SQL, or stacks", async () => {
    const imports = gateway();
    vi.mocked(imports.parseImport).mockRejectedValue(new Error("SQL SELECT at C:\\private\\family.xlsx"));
    const { handlers } = setup(imports);
    const result = await handlers.get(IMPORT_CHANNELS.parse)!({ sender: { id: 7 } }, { fileToken: "11111111-1111-4111-8111-111111111111", sourceKey: "archive" });
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", message: "Unable to complete import request" } });
    expect(JSON.stringify(result)).not.toMatch(/SELECT|private|family\.xlsx|stack/i);
  });
});
