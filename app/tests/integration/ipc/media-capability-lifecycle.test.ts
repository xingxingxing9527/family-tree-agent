import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceMediaGateway } from "../../../src/main/ipc/media-ipc";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("media capability lifecycle", () => {
  it("expires unused selections and disposes selections on workspace change", async () => {
    vi.useFakeTimers(); const root = await mkdtemp(join(tmpdir(), "family-agent-media-capability-")); roots.push(root); const image = join(root, "image.jpg"); await writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0x00])); let workspaceId = "one";
    const gateway = new WorkspaceMediaGateway({ getOpenWorkspaceContext: () => ({ workspaceId, databasePath: join(root, "missing.sqlite"), mediaPath: join(root, "media") }) }, { showOpenDialog: async () => ({ canceled: false, filePaths: [image] }) }, 10);
    expect((await gateway.select()).ok).toBe(true); expect(gateway.pendingSelectionCount()).toBe(1); await vi.advanceTimersByTimeAsync(11); expect(gateway.pendingSelectionCount()).toBe(0);
    expect((await gateway.select()).ok).toBe(true); workspaceId = "two"; expect((await gateway.select()).ok).toBe(true); expect(gateway.pendingSelectionCount()).toBe(1); gateway.dispose(); expect(gateway.pendingSelectionCount()).toBe(0);
  });
});
