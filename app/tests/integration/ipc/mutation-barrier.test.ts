import { describe, expect, it } from "vitest";
import { CHAT_CHANNELS, registerChatIpc } from "../../../src/main/ipc/chat-ipc";
import { DATA_MANAGEMENT_CHANNELS, registerDataManagementIpc } from "../../../src/main/ipc/data-management-ipc";
import { FACT_CHANNELS, registerFactsIpc } from "../../../src/main/ipc/facts-ipc";
import { IMPORT_CHANNELS, registerImportIpc } from "../../../src/main/ipc/import-ipc";
import { MEDIA_CHANNELS, registerMediaIpc } from "../../../src/main/ipc/media-ipc";
import { MERGE_CHANNELS, registerMergeIpc } from "../../../src/main/ipc/merge-ipc";
import { QUERY_CHANNELS, registerQueryIpc } from "../../../src/main/ipc/query-ipc";
import { registerWorkspaceIpc, WORKSPACE_CHANNELS } from "../../../src/main/ipc/register-ipc";
import { registerWikiIpc, WIKI_CHANNELS } from "../../../src/main/ipc/wiki-ipc";
import { WorkspaceMutationGate } from "../../../src/main/workspaces/workspace-mutation-gate";

type Handler = (event: { sender: { id: number } }, input?: unknown) => unknown;
const uuidA = "11111111-1111-4111-8111-111111111111";
const uuidB = "22222222-2222-4222-8222-222222222222";
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("workspace operation IPC barrier", () => {
  it("holds every database or workspace-file operation behind the same restore-exclusive lease", async () => {
    const handlers = new Map<string, Handler>();
    const ipc = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
    const gate = new WorkspaceMutationGate();
    const calls: string[] = [];
    const mark = (name: string) => async () => { calls.push(name); return { ok: true, value: null }; };

    registerFactsIpc(ipc as never, () => 7, {
      listPeople: mark("facts-read"), getPerson: mark("facts-read"), savePerson: mark("facts-save"), updatePerson: mark("facts-update"),
      addParentChild: mark("facts-parent"), addMarriage: mark("facts-marriage"), divorce: mark("facts-divorce")
    } as never, gate);
    registerImportIpc(ipc as never, () => 7, {
      selectImportFile: mark("import-select"), parseImport: mark("import-parse"), commitImport: mark("import-commit"), exportTemplate: mark("import-template")
    } as never, gate);
    registerMergeIpc(ipc as never, () => 7, {
      findDuplicateCandidates: mark("merge-read"), preview: mark("merge-read"), merge: mark("merge"), history: mark("merge-read"),
      canUnmerge: mark("merge-read"), unmerge: mark("unmerge")
    } as never, gate);
    registerQueryIpc(ipc as never, () => 7, {
      workspaceSnapshot: mark("query-snapshot"), projectTree: mark("query-tree"),
      searchPeople: mark("query-search"), getPerson: mark("query-person"), listRelatives: mark("query-relatives"),
      calculateRelationship: mark("query-relationship"), summarizeLineage: mark("query-lineage"), searchWiki: mark("query-wiki")
    } as never, gate as never);
    registerMediaIpc(ipc as never, () => 7, {
      select: mark("media-select"), import: mark("media-import"), attach: mark("media-attach"), listForPerson: mark("media-read")
    } as never, gate);
    registerWikiIpc(ipc as never, () => 7, {
      list: mark("wiki-list"), create: mark("wiki-create"), update: mark("wiki-update"), remove: mark("wiki-remove"), get: mark("wiki-read")
    } as never, gate);
    registerChatIpc(ipc as never, () => 7, {
      authorize: mark("chat-read"), stageMutation: mark("chat-stage"), ask: mark("chat-read"), confirm: mark("chat-confirm"), revise: mark("chat-revise")
    } as never, gate);
    registerDataManagementIpc(ipc as never, () => 7, {
      listAudit: mark("audit-read"), undoOperationGroup: mark("undo"), createBackup: mark("backup"), listRestoreTargets: mark("targets"),
      selectRestoreFile: mark("restore-select"), inspectBackup: mark("restore-inspect"), restoreBackup: mark("restore"), exportWorkspace: mark("export")
    } as never, gate);
    registerWorkspaceIpc(ipc as never, () => 7, {
      list: mark("workspace-read"), create: mark("workspace-create"), open: mark("workspace-open"), close: mark("workspace-close")
    } as never, gate);

    const invoke = (channel: string, input: unknown = {}) => Promise.resolve(handlers.get(channel)!({ sender: { id: 7 } }, input));
    const lease = await gate.acquireExclusive();
    const pending = [
      invoke(FACT_CHANNELS.peopleSave, { draft: { displayName: "A", aliases: [], gender: "unknown", birth: null, death: null, notes: null, sourceDescription: "test" }, confirmWarnings: true }),
      invoke(FACT_CHANNELS.peopleList, { limit: 20, offset: 0 }),
      invoke(FACT_CHANNELS.peopleGet, { personId: uuidA }),
      invoke(QUERY_CHANNELS.workspaceSnapshot),
      invoke(QUERY_CHANNELS.projectTree, { view: "full", collapseDepth: 4 }),
      invoke(QUERY_CHANNELS.searchPeople, { query: "A", limit: 20 }),
      invoke(QUERY_CHANNELS.getPerson, { personId: uuidA }),
      invoke(QUERY_CHANNELS.listRelatives, { personId: uuidA, kinds: ["parent"] }),
      invoke(QUERY_CHANNELS.calculateRelationship, { viewpointId: uuidA, targetId: uuidB }),
      invoke(QUERY_CHANNELS.summarizeLineage, { lineageId: uuidA }),
      invoke(QUERY_CHANNELS.searchWiki, { query: "A", limit: 20 }),
      invoke(IMPORT_CHANNELS.commit, { planId: "plan", selectedActionIds: [] }),
      invoke(IMPORT_CHANNELS.parse, { fileToken: uuidA, sourceKey: "source" }),
      invoke(MERGE_CHANNELS.candidates, { personId: uuidA }),
      invoke(MERGE_CHANNELS.preview, { primaryPersonId: uuidA, secondaryPersonId: uuidB }),
      invoke(MERGE_CHANNELS.merge, { primaryPersonId: "a", secondaryPersonId: "b", scalarChoices: {}, expectedVersions: {} }),
      invoke(MERGE_CHANNELS.history),
      invoke(MERGE_CHANNELS.canUnmerge, { mergeId: uuidA }),
      invoke(MERGE_CHANNELS.unmerge, { mergeId: "merge" }),
      invoke(MEDIA_CHANNELS.import, { fileToken: uuidA }),
      invoke(MEDIA_CHANNELS.attach, { mediaAssetId: uuidA, personId: uuidB }),
      invoke(MEDIA_CHANNELS.listForPerson, { personId: uuidA }),
      invoke(WIKI_CHANNELS.list, { limit: 100, offset: 0 }),
      invoke(WIKI_CHANNELS.create, { title: "Entry", body: "", personIds: [], sourceIds: [] }),
      invoke(WIKI_CHANNELS.update, { wikiEntryId: uuidA, title: "Entry", body: "", personIds: [], sourceIds: [], expectedVersion: 1 }),
      invoke(WIKI_CHANNELS.remove, { wikiEntryId: uuidA, expectedVersion: 1 }),
      invoke(WIKI_CHANNELS.get, { wikiEntryId: uuidA }),
      invoke(CHAT_CHANNELS.stageMutation, { sessionId: "session", authorizationToken: "token", payload: { text: "stage", candidatePeople: [] } }),
      invoke(CHAT_CHANNELS.ask, { sessionId: "session", authorizationToken: "token", payload: { question: "ask", viewpointId: uuidA, selectedPersonId: null } }),
      invoke(CHAT_CHANNELS.confirm, { draftId: "draft", draftVersion: 1, selectedChangeIds: [], expectedVersions: {}, acknowledgedWarningCodes: [] }),
      invoke(DATA_MANAGEMENT_CHANNELS.auditUndo, { operationGroupId: uuidA }),
      invoke(DATA_MANAGEMENT_CHANNELS.auditList),
      invoke(DATA_MANAGEMENT_CHANNELS.backupCreate),
      invoke(DATA_MANAGEMENT_CHANNELS.exportCreate),
      invoke(WORKSPACE_CHANNELS.create, { name: "Family" }),
      invoke(WORKSPACE_CHANNELS.list),
      invoke(WORKSPACE_CHANNELS.open, { id: uuidA }),
      invoke(WORKSPACE_CHANNELS.close)
    ];

    await tick();
    expect(calls).toEqual([]);
    lease.release();
    await Promise.all(pending);
    expect(calls.sort()).toEqual([
      "audit-read", "backup", "chat-confirm", "chat-read", "chat-stage", "export", "facts-read", "facts-read", "facts-save",
      "import-commit", "import-parse", "media-attach", "media-import", "media-read", "merge", "merge-read", "merge-read", "merge-read", "merge-read",
      "query-lineage", "query-person", "query-relationship", "query-relatives", "query-search", "query-snapshot", "query-tree", "query-wiki", "undo", "unmerge",
      "wiki-create", "wiki-list", "wiki-read", "wiki-remove", "wiki-update", "workspace-close", "workspace-create", "workspace-open", "workspace-read"
    ].sort());
  });
});
