import { describe, expect, it } from "vitest";
import { WorkspaceMutationGate } from "../../../src/main/workspaces/workspace-mutation-gate";

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("workspace mutation gate", () => {
  it("drains an in-flight mutation before granting restore exclusivity", async () => {
    const gate = new WorkspaceMutationGate();
    let finishMutation!: () => void;
    const mutationCanFinish = new Promise<void>((resolve) => { finishMutation = resolve; });
    const mutation = gate.runMutation(async () => { await mutationCanFinish; });
    let exclusiveGranted = false;
    const exclusive = gate.acquireExclusive().then((lease) => { exclusiveGranted = true; return lease; });

    await turn();
    expect(exclusiveGranted).toBe(false);
    finishMutation();
    await mutation;
    const lease = await exclusive;
    expect(exclusiveGranted).toBe(true);
    lease.release();
  });

  it("holds a late mutation until restore exclusivity is released", async () => {
    const gate = new WorkspaceMutationGate();
    const lease = await gate.acquireExclusive();
    let ran = false;
    const mutation = gate.runMutation(() => { ran = true; });

    await turn();
    expect(ran).toBe(false);
    lease.release();
    await mutation;
    expect(ran).toBe(true);
  });
});
