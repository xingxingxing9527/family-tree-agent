import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceMediaGateway } from "../../../src/main/ipc/media-ipc";
import { openSelectedMediaFile } from "../../../src/main/media/media-service";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("media capability lifecycle", () => {
  it("expires unused selections and disposes selections on workspace change", async () => {
    vi.useFakeTimers(); const root = await mkdtemp(join(tmpdir(), "family-agent-media-capability-")); roots.push(root); const image = join(root, "image.jpg"); await writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0x00])); let workspaceId = "one";
    const gateway = new WorkspaceMediaGateway({ getOpenWorkspaceContext: () => ({ workspaceId, databasePath: join(root, "missing.sqlite"), mediaPath: join(root, "media") }) }, { showOpenDialog: async () => ({ canceled: false, filePaths: [image] }) }, 10);
    expect((await gateway.select()).ok).toBe(true); expect(gateway.pendingSelectionCount()).toBe(1); await vi.advanceTimersByTimeAsync(11); expect(gateway.pendingSelectionCount()).toBe(0);
    expect((await gateway.select()).ok).toBe(true); workspaceId = "two"; expect((await gateway.select()).ok).toBe(true); expect(gateway.pendingSelectionCount()).toBe(1); await gateway.dispose(); expect(gateway.pendingSelectionCount()).toBe(0);
  });

  it("awaits the close of an actual retained file handle before disposal resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-media-capability-"));
    roots.push(root);
    const image = join(root, "retained.jpg");
    const moved = join(root, "released.jpg");
    await writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const selected = await openSelectedMediaFile(image, "one");
    const originalClose = selected.handle.close.bind(selected.handle);
    let allowClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { allowClose = resolve; });
    let closeStarted!: () => void;
    const started = new Promise<void>((resolve) => { closeStarted = resolve; });
    selected.handle.close = async () => {
      closeStarted();
      await closeGate;
      await originalClose();
    };
    try {
      const gateway = new WorkspaceMediaGateway({
        getOpenWorkspaceContext: () => ({ workspaceId: "one", databasePath: join(root, "missing.sqlite"), mediaPath: join(root, "media") })
      }, { showOpenDialog: async () => ({ canceled: false, filePaths: [image] }) }, 300_000, {
        open: async () => selected,
        close: async (selection) => selection.handle.close()
      });
      expect((await gateway.select()).ok).toBe(true);
      let disposed = false;
      const disposal = Promise.resolve(gateway.dispose()).then(() => { disposed = true; });
      await started;
      await Promise.resolve();
      expect(disposed).toBe(false);
      expect(gateway.pendingSelectionCount()).toBe(0);
      allowClose();
      await disposal;
      await expect(rename(image, moved)).resolves.toBeUndefined();
    } finally {
      allowClose();
      await originalClose().catch(() => undefined);
    }
  });

  it("closes every retained handle, clears every token, and reports disposal failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-media-capability-"));
    roots.push(root);
    const paths = [join(root, "first.jpg"), join(root, "second.jpg")];
    await Promise.all(paths.map((path) => writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0x00]))));
    const selections = await Promise.all(paths.map((path) => openSelectedMediaFile(path, "one")));
    let selectedIndex = 0;
    const closed: string[] = [];
    const gateway = new WorkspaceMediaGateway({
      getOpenWorkspaceContext: () => ({ workspaceId: "one", databasePath: join(root, "missing.sqlite"), mediaPath: join(root, "media") })
    }, { showOpenDialog: async () => ({ canceled: false, filePaths: [paths[selectedIndex]!] }) }, 300_000, {
      open: async () => selections[selectedIndex++]!,
      close: async (selection) => {
        await selection.handle.close();
        closed.push(selection.fileName);
        if (selection.fileName === "first.jpg") throw new Error("injected close report");
      }
    });
    expect((await gateway.select()).ok).toBe(true);
    expect((await gateway.select()).ok).toBe(true);

    await expect(gateway.dispose()).rejects.toThrow(/close every selected media file/i);
    expect(closed.sort()).toEqual(["first.jpg", "second.jpg"]);
    expect(gateway.pendingSelectionCount()).toBe(0);
    await expect(rename(paths[0]!, join(root, "first-released.jpg"))).resolves.toBeUndefined();
    await expect(rename(paths[1]!, join(root, "second-released.jpg"))).resolves.toBeUndefined();
  });
});
