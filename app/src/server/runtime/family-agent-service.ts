import type { AppResult, FamilyAgentApi } from "../../shared/contracts.js";
import { WorkspaceFactsGateway } from "../../main/application/facts/facts-gateway.js";
import { UndoError, UndoService } from "../../main/application/audit/undo-service.js";
import { applyMigrations } from "../../main/database/migrations/index.js";
import { openDatabase } from "../../main/database/open-database.js";
import { WorkspaceChatGateway } from "../../main/ipc/chat-ipc.js";
import { WorkspaceLineageGateway } from "../../main/ipc/lineage-ipc.js";
import { WorkspaceMergeGateway } from "../../main/ipc/merge-ipc.js";
import { WorkspaceQueryGateway } from "../../main/ipc/query-ipc.js";
import { WorkspaceWikiGateway } from "../../main/ipc/wiki-ipc.js";
import { OpenAIResponsesAdapter } from "../../main/llm/openai-responses-adapter.js";
import type { ModelAdapter } from "../../main/llm/model-adapter.js";
import type { FamilyRuntime } from "./family-runtime.js";

const unavailable = <T>(message = "Browser file transfer is not available yet"): Promise<AppResult<T>> => Promise.resolve({
  ok: false,
  error: { code: "PATH_DENIED", message }
});
const failure = <T>(code: "NOT_FOUND" | "CONFLICT" | "INTERNAL", message: string): AppResult<T> => ({ ok: false, error: { code, message } });

class MemoryModelKeyStore {
  constructor(private key: string | null) {}
  async readKey(): Promise<string | null> { return this.key; }
  async saveKey(key: string): Promise<void> { this.key = key.trim(); }
  async clearKey(): Promise<void> { this.key = null; }
}

export interface FamilyAgentServiceOptions {
  runtime: FamilyRuntime;
  initialModelKey?: string | null;
  modelFactory?: (apiKey: string) => ModelAdapter;
}

export class FamilyAgentService implements FamilyAgentApi {
  readonly app: FamilyAgentApi["app"];
  readonly workspaces: FamilyAgentApi["workspaces"];
  readonly people: FamilyAgentApi["people"];
  readonly relations: FamilyAgentApi["relations"];
  readonly lineages: FamilyAgentApi["lineages"];
  readonly imports: FamilyAgentApi["imports"];
  readonly merges: FamilyAgentApi["merges"];
  readonly media: FamilyAgentApi["media"];
  readonly wiki: FamilyAgentApi["wiki"];
  readonly query: FamilyAgentApi["query"];
  readonly chat: FamilyAgentApi["chat"];
  readonly modelSettings: FamilyAgentApi["modelSettings"];
  readonly dataManagement: FamilyAgentApi["dataManagement"];

  private readonly chatGateway: WorkspaceChatGateway;
  private disposed = false;

  constructor(private readonly runtime: FamilyRuntime, options: Omit<FamilyAgentServiceOptions, "runtime"> = {}) {
    const facts = new WorkspaceFactsGateway(runtime.workspaceManager);
    const lineages = new WorkspaceLineageGateway(runtime.workspaceManager);
    const merges = new WorkspaceMergeGateway(runtime.workspaceManager);
    const wiki = new WorkspaceWikiGateway(runtime.workspaceManager);
    const query = new WorkspaceQueryGateway(runtime.workspaceManager);
    const keys = new MemoryModelKeyStore(options.initialModelKey ?? process.env.FAMILY_AGENT_OPENAI_API_KEY?.trim() ?? null);
    const modelFactory = options.modelFactory ?? ((apiKey: string) => new OpenAIResponsesAdapter({ apiKey, model: process.env.FAMILY_AGENT_MODEL?.trim() || "gpt-4o-mini" }));
    this.chatGateway = new WorkspaceChatGateway(runtime.workspaceManager, keys, modelFactory);
    const gated = <T>(operation: () => Promise<T>): Promise<T> => runtime.mutationGate.runOperation(operation);

    this.app = { getVersion: async () => "1.0.0" };
    this.workspaces = {
      list: () => runtime.listFamilies(),
      create: ({ name }) => runtime.createFamily(name),
      open: ({ id }) => runtime.openFamily(id),
      close: () => runtime.closeFamily()
    };
    this.people = {
      list: (input) => gated(() => facts.listPeople(input)),
      get: (input) => gated(() => facts.getPerson(input)),
      save: (input) => gated(() => facts.savePerson(input)),
      update: (input) => gated(() => facts.updatePerson(input))
    };
    this.relations = {
      addParentChild: (input) => gated(() => facts.addParentChild(input)),
      addMarriage: (input) => gated(() => facts.addMarriage(input)),
      divorce: (input) => gated(() => facts.divorce(input))
    };
    this.lineages = {
      createLineage: (input) => gated(() => lineages.createLineage(input)),
      updateLineage: (input) => gated(() => lineages.updateLineage(input)),
      archiveLineage: (input) => gated(() => lineages.archiveLineage(input)),
      addMembership: (input) => gated(() => lineages.addMembership(input)),
      updateMembership: (input) => gated(() => lineages.updateMembership(input)),
      removeMembership: (input) => gated(() => lineages.removeMembership(input))
    };
    this.imports = {
      selectFile: () => unavailable(),
      parse: () => unavailable(),
      commit: () => unavailable(),
      exportTemplate: () => unavailable()
    };
    this.merges = {
      findDuplicateCandidates: (input) => gated(() => merges.findDuplicateCandidates(input)),
      preview: (input) => gated(() => merges.preview(input)),
      merge: (input) => gated(() => merges.merge(input)),
      history: () => gated(() => merges.history()),
      canUnmerge: (input) => gated(() => merges.canUnmerge(input)),
      unmerge: (input) => gated(() => merges.unmerge(input))
    };
    this.media = {
      select: () => unavailable(),
      import: () => unavailable(),
      attach: () => unavailable(),
      listForPerson: () => unavailable()
    };
    this.wiki = {
      list: (input) => gated(() => wiki.list(input)),
      create: (input) => gated(() => wiki.create(input)),
      update: (input) => gated(() => wiki.update(input)),
      remove: (input) => gated(() => wiki.remove(input)),
      get: (input) => gated(() => wiki.get(input))
    };
    this.query = {
      workspaceSnapshot: () => gated(() => query.workspaceSnapshot()),
      projectTree: (input) => gated(() => query.projectTree(input)),
      searchPeople: (input) => gated(() => query.searchPeople(input)),
      getPerson: (input) => gated(() => query.getPerson(input)),
      listRelatives: (input) => gated(() => query.listRelatives(input)),
      calculateRelationship: (input) => gated(() => query.calculateRelationship(input)),
      summarizeLineage: (input) => gated(() => query.summarizeLineage(input)),
      searchWiki: (input) => gated(() => query.searchWiki(input))
    };
    this.chat = {
      authorize: (input) => gated(() => this.chatGateway.authorize(input)),
      stageMutation: (input) => gated(() => this.chatGateway.stageMutation(input)),
      ask: (input) => gated(() => this.chatGateway.ask(input)),
      confirm: (input) => gated(() => this.chatGateway.confirm(input)),
      revise: (input) => gated(() => this.chatGateway.revise(input))
    };
    this.modelSettings = {
      status: async () => ({ ok: true, value: { configured: (await keys.readKey()) !== null } }),
      saveKey: async ({ key }) => { await keys.saveKey(key); return { ok: true, value: null }; },
      clearKey: async () => { await keys.clearKey(); return { ok: true, value: null }; }
    };
    this.dataManagement = {
      listAudit: () => gated(() => this.listAudit()),
      undoOperationGroup: (input) => gated(() => this.undo(input.operationGroupId)),
      createBackup: () => unavailable(),
      listRestoreTargets: () => runtime.listFamilies(),
      selectRestoreFile: () => unavailable(),
      inspectBackup: () => unavailable(),
      restoreBackup: () => unavailable(),
      exportWorkspace: () => unavailable()
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.chatGateway.dispose();
  }

  private async listAudit(): ReturnType<FamilyAgentApi["dataManagement"]["listAudit"]> {
    const context = this.runtime.workspaceManager.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    const database = openDatabase(context.databasePath);
    try { applyMigrations(database); return { ok: true, value: new UndoService(database, context.workspaceId).listOperationGroups() }; }
    catch { return failure("INTERNAL", "Unable to read operation history"); }
    finally { database.close(); }
  }

  private async undo(operationGroupId: string): ReturnType<FamilyAgentApi["dataManagement"]["undoOperationGroup"]> {
    const context = this.runtime.workspaceManager.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    const database = openDatabase(context.databasePath);
    try {
      applyMigrations(database);
      const value = new UndoService(database, context.workspaceId).undoOperationGroup(operationGroupId);
      await this.runtime.workspaceManager.synchronizeOriginPerson();
      return { ok: true, value };
    } catch (error) {
      if (error instanceof UndoError && error.code === "NOT_FOUND") return failure("NOT_FOUND", "Operation group was not found");
      if (error instanceof UndoError) return failure("CONFLICT", "Operation group cannot be safely undone");
      return failure("INTERNAL", "Unable to undo operation group");
    } finally { database.close(); }
  }
}

export function createFamilyAgentService(options: FamilyAgentServiceOptions): FamilyAgentService {
  return new FamilyAgentService(options.runtime, options);
}
