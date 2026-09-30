import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceImportGateway, type ImportDialogs } from "../../../src/main/ipc/import-ipc";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";

const roots: string[] = [];
const fixture = fileURLToPath(new URL("../../fixtures/import/valid-family.xlsx", import.meta.url));

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("import file capabilities", () => {
  it("consumes a dialog-issued token once and rejects it after a workspace change", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-import-capability-")); roots.push(root);
    const databasePath = join(root, "genealogy.sqlite"); const database = openDatabase(databasePath); applyMigrations(database); database.close();
    let workspaceId = "workspace-a";
    const dialogs: ImportDialogs = { showOpenDialog: async () => ({ canceled: false, filePaths: [fixture] }), showSaveDialog: async () => ({ canceled: true }) };
    const gateway = new WorkspaceImportGateway({ getOpenWorkspaceContext: () => ({ workspaceId, databasePath }) }, dialogs);
    const selected = await gateway.selectImportFile(); expect(selected.ok).toBe(true); if (!selected.ok) return;
    workspaceId = "workspace-b";
    await expect(gateway.parseImport({ fileToken: selected.value.fileToken, sourceKey: "archive" })).resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
  });

  it("uses the native save dialog and never accepts a renderer target path", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-import-save-")); roots.push(root);
    const target = join(root, "template.xlsx"); const dialogs: ImportDialogs = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: false, filePath: target }) };
    const gateway = new WorkspaceImportGateway({ getOpenWorkspaceContext: () => null }, dialogs);
    await expect(gateway.exportTemplate()).resolves.toEqual({ ok: true, value: { saved: true } });
    await expect(access(target)).resolves.toBeUndefined();
  });

  it("rejects a preview after switching workspaces before opening either database", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-import-workspace-binding-")); roots.push(root);
    const databaseA = join(root, "a.sqlite");
    const databaseB = join(root, "b.sqlite");
    for (const path of [databaseA, databaseB]) {
      const database = openDatabase(path);
      applyMigrations(database);
      database.close();
    }
    let context = { workspaceId: "workspace-a", databasePath: databaseA, openContextId: "open-a-1" };
    const dialogs: ImportDialogs = {
      showOpenDialog: async () => ({ canceled: false, filePaths: [fixture] }),
      showSaveDialog: async () => ({ canceled: true })
    };
    const gateway = new WorkspaceImportGateway({ getOpenWorkspaceContext: () => context }, dialogs);
    const selected = await gateway.selectImportFile();
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const preview = await gateway.parseImport({ fileToken: selected.value.fileToken, sourceKey: "archive:bound" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    context = { workspaceId: "workspace-b", databasePath: databaseB, openContextId: "open-b-1" };
    const result = await gateway.commitImport({
      planId: preview.value.id,
      selectedActionIds: preview.value.actions.filter((action) => action.kind === "create").map((action) => action.id)
    });

    expect(result).toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    for (const path of [databaseA, databaseB]) {
      const database = openDatabase(path);
      expect(database.prepare("SELECT COUNT(*) FROM person").pluck().get()).toBe(0);
      expect(database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get()).toBe(0);
      database.close();
    }
  });

  it("consumes a same-workspace plan once and rejects replay or a reopened context", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-import-plan-lifecycle-")); roots.push(root);
    const databasePath = join(root, "genealogy.sqlite");
    const database = openDatabase(databasePath); applyMigrations(database); database.close();
    let context = { workspaceId: "workspace-a", databasePath, openContextId: "open-a-1" };
    const dialogs: ImportDialogs = {
      showOpenDialog: async () => ({ canceled: false, filePaths: [fixture] }),
      showSaveDialog: async () => ({ canceled: true })
    };
    const gateway = new WorkspaceImportGateway({ getOpenWorkspaceContext: () => context }, dialogs);
    const selectAndPreview = async () => {
      const selected = await gateway.selectImportFile();
      expect(selected.ok).toBe(true);
      if (!selected.ok) throw new Error("selection failed");
      const preview = await gateway.parseImport({ fileToken: selected.value.fileToken, sourceKey: "archive:lifecycle" });
      expect(preview.ok).toBe(true);
      if (!preview.ok) throw new Error("preview failed");
      return preview.value;
    };

    const first = await selectAndPreview();
    const actionIds = first.actions.filter((action) => action.kind === "create").map((action) => action.id);
    await expect(gateway.commitImport({ planId: first.id, selectedActionIds: actionIds })).resolves.toMatchObject({ ok: true });
    await expect(gateway.commitImport({ planId: first.id, selectedActionIds: actionIds })).resolves.toMatchObject({
      ok: false,
      error: { code: "CONFLICT" }
    });

    const reopened = await selectAndPreview();
    context = { ...context, openContextId: "open-a-2" };
    await expect(gateway.commitImport({ planId: reopened.id, selectedActionIds: [] })).resolves.toMatchObject({
      ok: false,
      error: { code: "PATH_DENIED" }
    });
  });
});
