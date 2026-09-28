import { describe, expect, it, vi } from "vitest";
import type { AppResult, AuditOperationGroupDto, BackupInspectionDto, DataManagementApi } from "../../../src/shared/contracts";
import { DATA_MANAGEMENT_CHANNELS, registerDataManagementIpc, type DataManagementGateway } from "../../../src/main/ipc/data-management-ipc";

type Handler = (event: { sender: { id: number } }, payload: unknown) => Promise<unknown>;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
const groupId = "33333333-3333-4333-8333-333333333333";
const counts = { people: 1, parentChild: 0, marriages: 0, wikiEntries: 1, auditRows: 2, mediaAssets: 1 };
const inspection: BackupInspectionDto = {
  restoreToken: token,
  targetWorkspaceId: workspaceId,
  verified: true,
  expiresAt: "2026-09-16T00:10:00.000Z",
  manifest: { formatVersion: 1, workspaceId, workspaceName: "王氏家谱", schemaVersion: 4, createdAt: "2026-09-16T00:00:00.000Z", counts }
};
const audit: AuditOperationGroupDto = { id: groupId, kind: "manual.edit", createdAt: "2026-09-16T00:00:00.000Z", status: "available", affectedEntities: [{ entityType: "person", entityId: workspaceId }], undoable: true, reason: null, undoneAt: null };

function gateway(): DataManagementGateway {
  return {
    listAudit: vi.fn().mockResolvedValue({ ok: true, value: [audit] }),
    undoOperationGroup: vi.fn().mockResolvedValue({ ok: true, value: { operationGroupId: groupId, undoneAt: "2026-09-16T00:01:00.000Z", restoredEntities: 1 } }),
    createBackup: vi.fn().mockResolvedValue({ ok: true, value: { saved: true, verified: true, createdAt: inspection.manifest.createdAt, schemaVersion: 4, counts } }),
    listRestoreTargets: vi.fn().mockResolvedValue({ ok: true, value: [{ id: workspaceId, name: "王氏家谱", directory: "opaque", originPersonId: null, lastOpenedAt: null, schemaVersion: 4 }] }),
    selectRestoreFile: vi.fn().mockResolvedValue({ ok: true, value: { selected: true, fileToken: token, fileName: "backup.zip" } }),
    inspectBackup: vi.fn().mockResolvedValue({ ok: true, value: inspection }),
    restoreBackup: vi.fn().mockResolvedValue({ ok: true, value: { restored: true, automaticSnapshotVerified: true } }),
    exportWorkspace: vi.fn().mockResolvedValue({ ok: true, value: { saved: true, files: 7, mediaAssets: 1 } })
  };
}

function setup(data = gateway()): { handlers: Map<string, Handler>; data: DataManagementGateway } {
  const handlers = new Map<string, Handler>();
  registerDataManagementIpc({ handle: (channel, handler) => handlers.set(channel, handler as Handler) }, () => 7, data);
  return { handlers, data };
}

describe("data-management IPC contracts", () => {
  it("registers only narrow fixed data-management channels", () => {
    expect([...setup().handlers.keys()].sort()).toEqual(Object.values(DATA_MANAGEMENT_CHANNELS).sort());
  });

  it.each([
    [DATA_MANAGEMENT_CHANNELS.auditList, { databasePath: "C:\\private\\genealogy.sqlite" }],
    [DATA_MANAGEMENT_CHANNELS.auditUndo, { operationGroupId: "not-a-uuid" }],
    [DATA_MANAGEMENT_CHANNELS.backupCreate, { destinationPath: "C:\\private\\backup.zip" }],
    [DATA_MANAGEMENT_CHANNELS.restoreTargets, { rootPath: "C:\\private" }],
    [DATA_MANAGEMENT_CHANNELS.restoreSelect, { archivePath: "C:\\private\\backup.zip" }],
    [DATA_MANAGEMENT_CHANNELS.restoreInspect, { fileToken: token, targetWorkspaceId: workspaceId, archivePath: "C:\\private\\backup.zip" }],
    [DATA_MANAGEMENT_CHANNELS.restoreActivate, { restoreToken: token, targetWorkspaceId: workspaceId, confirmReplace: false }],
    [DATA_MANAGEMENT_CHANNELS.exportCreate, { destinationPath: "C:\\private\\export" }]
  ])("rejects malformed or path-bearing payloads on %s", async (channel, payload) => {
    const { handlers, data } = setup();
    await expect(handlers.get(channel)!({ sender: { id: 7 } }, payload)).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION", message: "Invalid request" } });
    expect(Object.values(data).every((method) => !vi.mocked(method).mock.calls.length)).toBe(true);
  });

  it("rejects untrusted senders before invoking any operation", async () => {
    const { handlers, data } = setup();
    await expect(handlers.get(DATA_MANAGEMENT_CHANNELS.restoreInspect)!({ sender: { id: 8 } }, { fileToken: token, targetWorkspaceId: workspaceId })).resolves.toEqual({ ok: false, error: { code: "PATH_DENIED", message: "IPC sender was denied" } });
    expect(data.inspectBackup).not.toHaveBeenCalled();
  });

  it("forwards only opaque tokens, IDs, and an explicit true replacement confirmation", async () => {
    const { handlers, data } = setup();
    await expect(handlers.get(DATA_MANAGEMENT_CHANNELS.restoreInspect)!({ sender: { id: 7 } }, { fileToken: token, targetWorkspaceId: workspaceId })).resolves.toEqual({ ok: true, value: inspection });
    await expect(handlers.get(DATA_MANAGEMENT_CHANNELS.restoreActivate)!({ sender: { id: 7 } }, { restoreToken: token, targetWorkspaceId: workspaceId, confirmReplace: true })).resolves.toMatchObject({ ok: true });
    expect(data.inspectBackup).toHaveBeenCalledWith({ fileToken: token, targetWorkspaceId: workspaceId });
    expect(data.restoreBackup).toHaveBeenCalledWith({ restoreToken: token, targetWorkspaceId: workspaceId, confirmReplace: true });
  });

  it("sanitizes unexpected exceptions without leaking paths or stacks", async () => {
    const data = gateway();
    vi.mocked(data.inspectBackup).mockRejectedValue(new Error("SQL at C:\\private\\family.zip\nstack"));
    const { handlers } = setup(data);
    const result = await handlers.get(DATA_MANAGEMENT_CHANNELS.restoreInspect)!({ sender: { id: 7 } }, { fileToken: token, targetWorkspaceId: workspaceId });
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", message: "Unable to complete data-management request" } } satisfies AppResult<never>);
    expect(JSON.stringify(result)).not.toMatch(/private|family\.zip|stack|SQL/i);
  });
});

// Compile-time assertion that preload and components receive the same narrow shape.
const _apiShape: DataManagementApi = gateway();
void _apiShape;
