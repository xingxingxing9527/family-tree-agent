// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppResult } from "../../../src/shared/contracts";
import type { MutationApi, MutationPreview, MutationReceipt } from "../../../src/shared/mutations";
import { useStagedMutation } from "../../../src/renderer/src/features/mutations/useStagedMutation";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const preview: MutationPreview = {
  id: "draft-1",
  workspaceId: "workspace-1",
  version: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  expectedVersions: {},
  changes: [{
    id: "change-1",
    disposition: "update",
    entityType: "parentChild",
    entityId: "relation-1",
    summary: "移除旧关系",
    fieldChanges: [],
    originKind: "explicit",
    selectedByDefault: true,
    dependsOnChangeIds: []
  }],
  issues: [],
  canConfirm: true
};

const receipt: MutationReceipt = {
  draftId: preview.id,
  operationGroupId: "group-1",
  changedEntityIds: ["person-created"]
};

function apiWithConfirm(confirm: MutationApi["confirm"]): MutationApi {
  return {
    stage: vi.fn().mockResolvedValue({ ok: true, value: preview }),
    confirm,
    revise: vi.fn()
  };
}

async function stagePreview(result: { current: ReturnType<typeof useStagedMutation> }): Promise<void> {
  await act(async () => {
    expect(await result.current.stage([{ type: "parentChild.remove", relationId: "relation-1", expectedVersion: 2 }])).toBe(true);
  });
}

describe("useStagedMutation commit lifecycle", () => {
  it("notifies persisted success once but suppresses the owner callback after reset", async () => {
    const pending = deferred<AppResult<MutationReceipt>>();
    const onCommitted = vi.fn();
    const onPersisted = vi.fn();
    const { result } = renderHook(() => useStagedMutation(apiWithConfirm(vi.fn().mockReturnValue(pending.promise)), onCommitted, { onPersisted }));
    await stagePreview(result);

    let confirmation!: Promise<boolean>;
    act(() => { confirmation = result.current.confirm(["change-1"], []); });
    act(() => { result.current.reset(); });
    await act(async () => {
      pending.resolve({ ok: true, value: receipt });
      expect(await confirmation).toBe(false);
    });

    expect(onPersisted).toHaveBeenCalledOnce();
    expect(onPersisted).toHaveBeenCalledWith(receipt);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("does not notify persistence or the owner callback when confirmation fails", async () => {
    const onCommitted = vi.fn();
    const onPersisted = vi.fn();
    const api = apiWithConfirm(vi.fn().mockResolvedValue({ ok: false, error: { code: "CONFLICT", message: "确认冲突" } }));
    const { result } = renderHook(() => useStagedMutation(api, onCommitted, { onPersisted }));
    await stagePreview(result);

    await act(async () => {
      expect(await result.current.confirm(["change-1"], [])).toBe(false);
    });

    expect(onPersisted).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(result.current.error).toBe("确认冲突");
  });

  it("keeps both persistence and owner callbacks for the current owner", async () => {
    const onCommitted = vi.fn();
    const onPersisted = vi.fn();
    const api = apiWithConfirm(vi.fn().mockResolvedValue({ ok: true, value: receipt }));
    const { result } = renderHook(() => useStagedMutation(api, onCommitted, { onPersisted }));
    await stagePreview(result);

    await act(async () => {
      expect(await result.current.confirm(["change-1"], [])).toBe(true);
    });

    expect(onPersisted).toHaveBeenCalledOnce();
    expect(onPersisted).toHaveBeenCalledWith(receipt);
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledWith(receipt);
    expect(result.current.preview).toBeNull();
  });
});
