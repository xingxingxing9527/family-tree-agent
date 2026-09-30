import { describe, expect, it, vi } from "vitest";
import type { AppResult, FactMutationReceipt } from "../../../src/shared/contracts";
import { LINEAGE_CHANNELS, registerLineageIpc, type LineageGateway } from "../../../src/main/ipc/lineage-ipc";

type Handler = (event: { sender: { id: number } }, payload?: unknown) => Promise<unknown> | unknown;
const success: AppResult<FactMutationReceipt> = { ok: true, value: { entityId: "entity-1", saved: true, warnings: [] } };

function gateway(): LineageGateway {
  return {
    createLineage: vi.fn().mockResolvedValue(success),
    updateLineage: vi.fn().mockResolvedValue(success),
    archiveLineage: vi.fn().mockResolvedValue(success),
    addMembership: vi.fn().mockResolvedValue(success),
    updateMembership: vi.fn().mockResolvedValue(success),
    removeMembership: vi.fn().mockResolvedValue(success)
  };
}

function setup(lineages = gateway()): { lineages: LineageGateway; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  registerLineageIpc({ handle: (channel, handler) => handlers.set(channel, handler as Handler) }, () => 7, lineages);
  return { lineages, handlers };
}

describe("lineage IPC contracts", () => {
  it("registers only the fixed lineage and membership mutation channels", () => {
    expect([...setup().handlers.keys()].sort()).toEqual(Object.values(LINEAGE_CHANNELS).sort());
  });

  it.each([
    [LINEAGE_CHANNELS.create, { name: "", founderPersonId: "person", description: null }],
    [LINEAGE_CHANNELS.update, { lineageId: "lineage", expectedVersion: 1, patch: {} }],
    [LINEAGE_CHANNELS.archive, { lineageId: "", expectedVersion: 1 }],
    [LINEAGE_CHANNELS.addMembership, { lineageId: "lineage", personId: "person", lineageRole: "blood", isPrimary: false, declaredGeneration: 0, generationMarker: "承" }],
    [LINEAGE_CHANNELS.addMembership, { lineageId: "lineage", personId: "person", lineageRole: "unknown", isPrimary: false, declaredGeneration: null, generationMarker: null }],
    [LINEAGE_CHANNELS.updateMembership, { membershipId: "membership", expectedVersion: 1, patch: { generationMarker: "" } }],
    [LINEAGE_CHANNELS.removeMembership, { membershipId: "membership", expectedVersion: 0 }]
  ])("rejects malformed payloads on %s before invoking the gateway", async (channel, payload) => {
    const { lineages, handlers } = setup();
    const result = await handlers.get(channel)!({ sender: { id: 7 } }, payload);
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION", message: "Invalid request" } });
    expect(Object.values(lineages).every((method) => !vi.mocked(method).mock.calls.length)).toBe(true);
  });

  it("rejects non-main-window callers and forwards normalized production payloads", async () => {
    const { lineages, handlers } = setup();
    await expect(handlers.get(LINEAGE_CHANNELS.create)!({ sender: { id: 9 } }, { name: "长房", founderPersonId: "person", description: null })).resolves.toEqual({
      ok: false,
      error: { code: "PATH_DENIED", message: "IPC sender was denied" }
    });
    const payload = { lineageId: "lineage", personId: "person", lineageRole: "associated", isPrimary: true, declaredGeneration: 3, generationMarker: "承" };
    await expect(handlers.get(LINEAGE_CHANNELS.addMembership)!({ sender: { id: 7 } }, payload)).resolves.toEqual(success);
    expect(lineages.addMembership).toHaveBeenCalledWith(payload);
  });

  it("sanitizes unexpected exceptions without exposing SQL or workspace paths", async () => {
    const lineages = gateway();
    vi.mocked(lineages.updateMembership).mockRejectedValue(new Error("SQL UPDATE at C:\\private\\genealogy.sqlite"));
    const { handlers } = setup(lineages);
    const result = await handlers.get(LINEAGE_CHANNELS.updateMembership)!({ sender: { id: 7 } }, {
      membershipId: "membership",
      expectedVersion: 1,
      patch: { generationMarker: "承" }
    });
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", message: "Unable to complete lineage request" } });
    expect(JSON.stringify(result)).not.toMatch(/UPDATE|private|genealogy\.sqlite|stack/i);
  });
});
