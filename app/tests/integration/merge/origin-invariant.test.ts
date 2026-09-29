import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceFactsGateway } from "../../../src/main/application/facts/facts-gateway";
import { openDatabase } from "../../../src/main/database/open-database";
import { WorkspaceChatGateway } from "../../../src/main/ipc/chat-ipc";
import { WorkspaceDataManagementGateway } from "../../../src/main/ipc/data-management-ipc";
import { WorkspaceImportGateway } from "../../../src/main/ipc/import-ipc";
import { WorkspaceMergeGateway } from "../../../src/main/ipc/merge-ipc";
import { WorkspaceManager } from "../../../src/main/workspaces/workspace-manager";
import { WorkspaceIndex } from "../../../src/main/workspaces/workspace-index";
import type { ConversationMutationDraft } from "../../../src/shared/chat";

describe("workspace origin-person invariant", () => {
  const roots: string[] = [];
  const importFixture = fileURLToPath(new URL("../../fixtures/import/valid-family.xlsx", import.meta.url));
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  async function controlledManager(root: string) {
    const workspaceRoot = join(root, "workspaces");
    const index = new WorkspaceIndex(workspaceRoot);
    const state = { failWrites: false };
    const manager = new WorkspaceManager(workspaceRoot, {
      index: {
        read: () => index.read(),
        write: async (workspaces) => {
          if (state.failWrites) throw new Error("injected persistent index publication failure");
          await index.write(workspaces);
        }
      }
    });
    const created = await manager.create({ name: "Origin invariant" });
    if (!created.ok) throw new Error("workspace fixture failed");
    const opened = await manager.open({ id: created.value.id });
    if (!opened.ok) throw new Error("workspace open failed");
    return { manager, state, workspaceId: created.value.id };
  }

  it("publishes the database origin through first save, merge, and unmerge", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-origin-"));
    roots.push(root);
    const { manager, state, workspaceId } = await controlledManager(root);
    const facts = new WorkspaceFactsGateway(manager);
    const save = (displayName: string) => facts.savePerson({
      draft: { displayName, aliases: [], gender: "unknown" as const, birth: null, death: null, notes: null, sourceDescription: "test" },
      confirmWarnings: true
    });
    const first = await save("First");
    const second = await save("Second");
    if (!first.ok || !first.value.entityId || !second.ok || !second.value.entityId) throw new Error("person fixture failed");
    await expectOrigin(manager, workspaceId, first.value.entityId);

    const merges = new WorkspaceMergeGateway(manager);
    const preview = await merges.preview({ primaryPersonId: second.value.entityId, secondaryPersonId: first.value.entityId });
    if (!preview.ok) throw new Error("merge preview failed");
    state.failWrites = true;
    const merged = await merges.merge({
      primaryPersonId: second.value.entityId,
      secondaryPersonId: first.value.entityId,
      scalarChoices: {},
      expectedVersions: preview.value.expectedVersions
    });
    expect(merged).toMatchObject({ ok: true });
    if (!merged.ok) throw new Error("merge failed");
    await expectDatabaseOrigin(manager, workspaceId, second.value.entityId);
    state.failWrites = false;
    await manager.synchronizeOriginPerson();
    await expectOrigin(manager, workspaceId, second.value.entityId);

    state.failWrites = true;
    await expect(merges.unmerge({ mergeId: merged.value.id })).resolves.toMatchObject({ ok: true });
    await expectDatabaseOrigin(manager, workspaceId, first.value.entityId);
    state.failWrites = false;
    await manager.synchronizeOriginPerson();
    await expectOrigin(manager, workspaceId, first.value.entityId);
  });

  it("keeps import and chat-confirm commits successful while origin publication is pending", async () => {
    const importRoot = await mkdtemp(join(tmpdir(), "family-agent-origin-import-"));
    roots.push(importRoot);
    const imported = await controlledManager(importRoot);
    const imports = new WorkspaceImportGateway(imported.manager, {
      showOpenDialog: async () => ({ canceled: false, filePaths: [importFixture] }),
      showSaveDialog: async () => ({ canceled: true })
    });
    const selected = await imports.selectImportFile();
    if (!selected.ok) throw new Error("import selection failed");
    const plan = await imports.parseImport({ fileToken: selected.value.fileToken, sourceKey: "origin-recovery" });
    if (!plan.ok) throw new Error("import planning failed");
    imported.state.failWrites = true;
    const committed = await imports.commitImport({
      planId: plan.value.id,
      selectedActionIds: plan.value.actions.filter((action) => action.kind === "create" || action.kind === "update").map((action) => action.id)
    });
    expect(committed).toMatchObject({ ok: true });
    const importedOrigin = await readDatabaseOrigin(imported.manager, imported.workspaceId);
    expect(importedOrigin).toEqual(expect.any(String));
    imported.state.failWrites = false;
    await imported.manager.synchronizeOriginPerson();
    await expectOrigin(imported.manager, imported.workspaceId, importedOrigin);

    const chatRoot = await mkdtemp(join(tmpdir(), "family-agent-origin-chat-"));
    roots.push(chatRoot);
    const chatted = await controlledManager(chatRoot);
    const draft: ConversationMutationDraft = {
      candidatePeople: [{
        referenceId: "origin", statedFields: ["displayName", "aliases", "gender", "birth", "death", "notes"],
        displayName: "Chat origin", aliases: [], gender: "unknown", birth: null, death: null, notes: null, matchedPersonId: null
      }],
      parentChildFacts: [], marriages: [], sources: [], fieldConfidence: [], unresolvedReferences: []
    };
    const chat = new WorkspaceChatGateway(
      chatted.manager,
      { readKey: async () => "sk-test" },
      () => ({ extractDraft: async () => draft, continueWithTools: async () => ({ answer: "unused", toolCalls: [] }) }) as never
    );
    const payload = { text: "create origin", candidatePeople: [] };
    const authorization = await chat.authorize({ sessionId: "origin-session", operation: "extract", payload });
    if (!authorization.ok) throw new Error("chat authorization failed");
    const preview = await chat.stageMutation({ sessionId: "origin-session", authorizationToken: authorization.value.authorizationToken, payload });
    if (!preview.ok) throw new Error("chat preview failed");
    chatted.state.failWrites = true;
    const confirmed = await chat.confirm({
      draftId: preview.value.id,
      draftVersion: preview.value.version,
      selectedChangeIds: preview.value.changes.map((change) => change.id),
      expectedVersions: {},
      acknowledgedWarningCodes: preview.value.warnings.map((warning) => warning.code)
    });
    expect(confirmed).toMatchObject({ ok: true });
    const chatOrigin = await readDatabaseOrigin(chatted.manager, chatted.workspaceId);
    expect(chatOrigin).toEqual(expect.any(String));
    chat.dispose();
    chatted.state.failWrites = false;
    await chatted.manager.synchronizeOriginPerson();
    await expectOrigin(chatted.manager, chatted.workspaceId, chatOrigin);
  });

  it("keeps undo successful while clearing an origin through pending publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-origin-undo-"));
    roots.push(root);
    const { manager, state, workspaceId } = await controlledManager(root);
    const facts = new WorkspaceFactsGateway(manager);
    const saved = await facts.savePerson({
      draft: { displayName: "Undo origin", aliases: [], gender: "unknown", birth: null, death: null, notes: null, sourceDescription: "test" },
      confirmWarnings: true
    });
    if (!saved.ok) throw new Error("person fixture failed");
    const data = new WorkspaceDataManagementGateway(manager, { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) });
    const groups = await data.listAudit();
    if (!groups.ok || groups.value.length === 0) throw new Error("audit fixture failed");
    state.failWrites = true;
    await expect(data.undoOperationGroup({ operationGroupId: groups.value[0]!.id })).resolves.toMatchObject({ ok: true });
    await expectDatabaseOrigin(manager, workspaceId, null);
    state.failWrites = false;
    await manager.synchronizeOriginPerson();
    await expectOrigin(manager, workspaceId, null);
    await data.dispose();
  });

  async function readDatabaseOrigin(manager: WorkspaceManager, workspaceId: string): Promise<string | null> {
    const details = manager.getOpenWorkspaceDetails();
    if (!details) throw new Error("workspace is not open");
    const database = openDatabase(details.databasePath);
    try {
      return database.prepare("SELECT origin_person_id FROM workspace_meta WHERE workspace_id=?").pluck().get(workspaceId) as string | null;
    } finally { database.close(); }
  }

  async function expectDatabaseOrigin(manager: WorkspaceManager, workspaceId: string, personId: string | null): Promise<void> {
    expect(await readDatabaseOrigin(manager, workspaceId)).toBe(personId);
  }

  async function expectOrigin(manager: WorkspaceManager, workspaceId: string, personId: string | null): Promise<void> {
    await expectDatabaseOrigin(manager, workspaceId, personId);
    const details = manager.getOpenWorkspaceDetails();
    if (!details) throw new Error("workspace is not open");
    const listed = await manager.list();
    expect(listed.ok && listed.value.find((entry) => entry.id === workspaceId)?.originPersonId).toBe(personId);
    expect(JSON.parse(await readFile(details.manifestPath, "utf8")).originPersonId).toBe(personId);
  }
});
