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
});
