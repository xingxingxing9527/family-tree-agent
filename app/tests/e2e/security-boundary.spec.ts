import { expect, test, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { findPlaintextInBoundedZip } from "../support/bounded-zip-plaintext-scan";

const isolatedEnvironment = (root: string): NodeJS.ProcessEnv => ({
  ...process.env,
  APPDATA: join(root, "appdata"),
  LOCALAPPDATA: join(root, "localappdata")
});

const contained = (root: string, candidate: string): boolean => {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

async function filesBelow(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(root);
  return output.sort();
}

test("enforces renderer, CSP, navigation, permission, API and main-validation boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "family-agent-security-e2e-"));
  await mkdir(join(root, "appdata"), { recursive: true });
  await mkdir(join(root, "localappdata"), { recursive: true });
  const app = await electron.launch({
    args: [resolve("out/main/index.js"), `--user-data-dir=${join(root, "profile")}`],
    env: isolatedEnvironment(root)
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "家谱智能体" })).toBeVisible();
    expect(await window.evaluate(() => ({
      requireType: typeof window.require,
      processType: typeof window.process,
      apiKeys: Object.keys(window.desktopApi).sort(),
      dangerousKeys: Object.entries(window.desktopApi).flatMap(([group, value]) =>
        Object.keys(value).filter((key) => ["invoke", "send", "on", "ipcRenderer", "require"].includes(key)).map((key) => `${group}.${key}`)
      )
    }))).toEqual({
      requireType: "undefined",
      processType: "undefined",
      apiKeys: ["app", "chat", "dataManagement", "imports", "media", "merges", "modelSettings", "people", "query", "relations", "wiki", "workspaces"],
      dangerousKeys: []
    });

    const inlineExecuted = await window.evaluate(async () => {
      const global = window as unknown as Record<string, unknown>;
      global.__securityInlineExecuted = false;
      const script = document.createElement("script");
      script.textContent = "window.__securityInlineExecuted = true";
      document.head.append(script);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      return global.__securityInlineExecuted;
    });
    expect(inlineExecuted).toBe(false);

    const initialUrl = window.url();
    expect(await window.evaluate(() => window.open("https://example.invalid/security-boundary"))).toBeNull();
    await window.waitForTimeout(100);
    expect(app.windows()).toHaveLength(1);
    await window.evaluate(() => { window.location.href = "https://example.invalid/navigation-boundary"; });
    await window.waitForTimeout(100);
    expect(window.url()).toBe(initialUrl);

    expect(await window.evaluate(async () => (await navigator.permissions.query({ name: "geolocation" })).state)).toBe("denied");

    const validation = await window.evaluate(async () => {
      const created = await window.desktopApi.workspaces.create({ name: "安全边界谱册" });
      if (!created.ok) return { created: false };
      const opened = await window.desktopApi.workspaces.open({ id: created.value.id });
      if (!opened.ok) return { created: true, opened: false };
      const person = await window.desktopApi.people.get({ personId: "../../etc/passwd" });
      const restore = await window.desktopApi.dataManagement.inspectBackup({
        fileToken: "../outside.zip",
        targetWorkspaceId: created.value.id
      });
      return { created: true, opened: true, personOk: person.ok, restoreOk: restore.ok };
    });
    expect(validation).toEqual({ created: true, opened: true, personOk: false, restoreOk: false });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("never writes a model key in plaintext to data, backup, logs or crash staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "family-agent-key-boundary-"));
  await mkdir(join(root, "appdata"), { recursive: true });
  await mkdir(join(root, "localappdata"), { recursive: true });
  const profile = join(root, "profile");
  const backup = join(root, "workspace-backup.zip");
  const sentinel = "sk-task15-PLAINTEXT-MUST-NOT-LEAK-20260916";
  const app = await electron.launch({
    args: [resolve("out/main/index.js"), `--user-data-dir=${profile}`],
    env: { ...isolatedEnvironment(root), FAMILY_AGENT_E2E_BACKUP_PATH: backup }
  });

  try {
    const window = await app.firstWindow();
    const result = await window.evaluate(async (key) => {
      const workspace = await window.desktopApi.workspaces.create({ name: "密钥边界谱册" });
      if (!workspace.ok) return { workspace: false, key: false, person: false, backup: false };
      const opened = await window.desktopApi.workspaces.open({ id: workspace.value.id });
      if (!opened.ok) return { workspace: true, opened: false, key: false, person: false, backup: false };
      const saved = await window.desktopApi.modelSettings.saveKey({ key });
      const person = await window.desktopApi.people.save({
        draft: {
          displayName: "不含密钥的人物",
          aliases: [],
          gender: "unknown",
          birth: null,
          death: null,
          notes: null,
          sourceDescription: "安全边界测试"
        },
        confirmWarnings: true
      });
      const archived = await window.desktopApi.dataManagement.createBackup();
      return {
        workspace: true,
        opened: true,
        key: saved.ok,
        person: person.ok,
        personError: person.ok ? null : person.error,
        backup: archived.ok,
        backupError: archived.ok ? null : archived.error
      };
    }, sentinel);
    expect(result).toEqual({ workspace: true, opened: true, key: true, person: true, personError: null, backup: true, backupError: null });

    const appPaths = await app.evaluate(({ app }) => ({ logs: app.getPath("logs"), crashDumps: app.getPath("crashDumps") }));
    expect(contained(root, appPaths.logs)).toBe(true);
    expect(contained(root, appPaths.crashDumps)).toBe(true);
    await mkdir(appPaths.logs, { recursive: true });
    await mkdir(appPaths.crashDumps, { recursive: true });
  } finally {
    await app.close();
  }

  try {
    const files = await filesBelow(root);
    expect(files.some((path) => path.endsWith("genealogy.sqlite"))).toBe(true);
    expect(files).toContain(backup);
    expect(files.some((path) => path.endsWith("openai-api-key.bin"))).toBe(true);
    expect(await findPlaintextInBoundedZip(backup, sentinel), "plaintext leaked inside a decompressed backup entry").toEqual([]);
    const utf8 = Buffer.from(sentinel, "utf8");
    const utf16 = Buffer.from(sentinel, "utf16le");
    for (const file of files) {
      const bytes = await readFile(file);
      expect(bytes.includes(utf8), `UTF-8 plaintext leaked in ${relative(root, file)}`).toBe(false);
      expect(bytes.includes(utf16), `UTF-16 plaintext leaked in ${relative(root, file)}`).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
