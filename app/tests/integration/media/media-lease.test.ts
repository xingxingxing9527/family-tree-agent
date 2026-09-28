import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface LeaseMessage {
  type: "acquired" | "asserted" | "released" | "error";
  token?: string;
  released?: boolean;
  message?: string;
}

const roots: string[] = [];
const children = new Set<ChildProcess>();
const childScript = fileURLToPath(new URL("./media-lease-child.mjs", import.meta.url));
const leaseModule = pathToFileURL(fileURLToPath(new URL("../../../src/main/media/media-lease.mjs", import.meta.url))).href;
const hash = "a".repeat(64);

class LeaseChild {
  readonly messages: LeaseMessage[] = [];
  private readonly waiters: Array<{ type: LeaseMessage["type"]; resolve: (message: LeaseMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor(readonly process: ChildProcess) {
    process.on("message", (value) => {
      const message = value as LeaseMessage;
      this.messages.push(message);
      const index = this.waiters.findIndex((waiter) => waiter.type === message.type);
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(message);
      }
      if (message.type === "error") {
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(message.message ?? "Lease child failed"));
        }
      }
    });
    process.once("exit", () => children.delete(process));
  }

  send(message: "assert" | "release"): void {
    this.process.send?.(message);
  }

  waitFor(type: LeaseMessage["type"], timeoutMs = 5_000): Promise<LeaseMessage> {
    const existing = this.messages.find((message) => message.type === type);
    if (existing) return Promise.resolve(existing);
    const error = this.messages.find((message) => message.type === "error");
    if (error && type !== "error") return Promise.reject(new Error(error.message ?? "Lease child failed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for child message: ${type}`)), timeoutMs);
      this.waiters.push({ type, resolve, reject, timer });
    });
  }
}

const startLeaseChild = (directory: string, options: Record<string, number>): LeaseChild => {
  const child = fork(childScript, [leaseModule, directory, hash, JSON.stringify(options)], { silent: true });
  children.add(child);
  return new LeaseChild(child);
};

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

afterEach(async () => {
  for (const child of children) child.kill();
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cross-process media hash lease", () => {
  it("waits beyond 800ms for a live owner and acquires only after its release", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-lease-"));
    roots.push(root);
    const directory = dirname(join(root, "hash-directory", "placeholder"));
    const options = { maxWaitMs: 3_000, staleMs: 180, heartbeatMs: 25, retryMinMs: 5, retryMaxMs: 30 };
    const owner = startLeaseChild(directory, options);
    await owner.waitFor("acquired");

    const waiterStarted = Date.now();
    const waiter = startLeaseChild(directory, options);
    await delay(850);
    expect(waiter.messages.some((message) => message.type === "acquired" || message.type === "error")).toBe(false);

    owner.send("release");
    expect(await owner.waitFor("released")).toMatchObject({ released: true });
    expect(await waiter.waitFor("acquired")).toMatchObject({ type: "acquired" });
    expect(Date.now() - waiterStarted).toBeGreaterThanOrEqual(800);
    waiter.send("release");
    expect(await waiter.waitFor("released")).toMatchObject({ released: true });
  });

  it("takes over an abandoned stale lease and removes its quarantine", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-lease-"));
    roots.push(root);
    const directory = join(root, "hash-directory");
    const abandoned = startLeaseChild(directory, { maxWaitMs: 1_000, staleMs: 100, heartbeatMs: 10_000, retryMinMs: 5, retryMaxMs: 20 });
    await abandoned.waitFor("acquired");
    abandoned.process.kill();
    await new Promise<void>((resolve) => abandoned.process.once("exit", () => resolve()));
    await delay(140);

    const replacement = startLeaseChild(directory, { maxWaitMs: 1_000, staleMs: 100, heartbeatMs: 20, retryMinMs: 5, retryMaxMs: 20 });
    await replacement.waitFor("acquired");
    expect((await readdir(directory)).some((name) => name.includes(".quarantine."))).toBe(false);
    replacement.send("release");
    expect(await replacement.waitFor("released")).toMatchObject({ released: true });
  });

  it("keeps a heartbeat lease live past the stale threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-lease-"));
    roots.push(root);
    const directory = join(root, "hash-directory");
    const owner = startLeaseChild(directory, { maxWaitMs: 1_000, staleMs: 100, heartbeatMs: 20, retryMinMs: 5, retryMaxMs: 20 });
    await owner.waitFor("acquired");
    const waiter = startLeaseChild(directory, { maxWaitMs: 320, staleMs: 100, heartbeatMs: 20, retryMinMs: 5, retryMaxMs: 20 });
    expect(await waiter.waitFor("error", 1_000)).toMatchObject({ type: "error", message: expect.stringMatching(/timed out/i) });
    owner.send("assert");
    expect(await owner.waitFor("asserted")).toMatchObject({ type: "asserted" });
    owner.send("release");
    expect(await owner.waitFor("released")).toMatchObject({ released: true });
  });

  it("does not let an old owner release a replacement lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-lease-"));
    roots.push(root);
    const directory = join(root, "hash-directory");
    const oldOwner = startLeaseChild(directory, { maxWaitMs: 1_000, staleMs: 100, heartbeatMs: 10_000, retryMinMs: 5, retryMaxMs: 20 });
    await oldOwner.waitFor("acquired");
    await delay(140);
    const replacement = startLeaseChild(directory, { maxWaitMs: 1_000, staleMs: 100, heartbeatMs: 20, retryMinMs: 5, retryMaxMs: 20 });
    await replacement.waitFor("acquired");

    oldOwner.send("release");
    expect(await oldOwner.waitFor("released")).toMatchObject({ released: false });
    replacement.send("assert");
    expect(await replacement.waitFor("asserted")).toMatchObject({ type: "asserted" });
    replacement.send("release");
    expect(await replacement.waitFor("released")).toMatchObject({ released: true });
  });
});
