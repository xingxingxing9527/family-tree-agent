import { readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AppResult, FamilyAgentApi } from "../../shared/contracts.js";
import { WorkspaceFactsGateway } from "../../main/application/facts/facts-gateway.js";
import { UndoError, UndoService } from "../../main/application/audit/undo-service.js";
import { BackupService } from "../../main/application/backup/backup-service.js";
import { ImportCommitter } from "../../main/application/import/import-committer.js";
import { ImportPlanAccessError, ImportPlanner, ImportPlanStore } from "../../main/application/import/import-planner.js";
import { exportImportTemplate, parseImport } from "../../main/application/import/workbook-parser.js";
import { applyMigrations } from "../../main/database/migrations/index.js";
import { openDatabase } from "../../main/database/open-database.js";
import { WorkspaceChatGateway } from "../../main/ipc/chat-ipc.js";
import { WorkspaceLineageGateway } from "../../main/ipc/lineage-ipc.js";
import { WorkspaceMergeGateway } from "../../main/ipc/merge-ipc.js";
import { WorkspaceQueryGateway } from "../../main/ipc/query-ipc.js";
import { WorkspaceWikiGateway } from "../../main/ipc/wiki-ipc.js";
import { OpenAIResponsesAdapter } from "../../main/llm/openai-responses-adapter.js";
import type { ModelAdapter } from "../../main/llm/model-adapter.js";
import { ManagedMediaService, openSelectedMediaFile } from "../../main/media/media-service.js";
import type { DownloadStore } from "../http/download-store.js";
import type { UploadStore } from "../http/upload-store.js";
import { BrowserRestoreManager } from "./browser-restore-manager.js";
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
  uploads?: UploadStore;
  downloads?: DownloadStore;
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
  private readonly importPlans = new ImportPlanStore();
  private readonly restoreManager: BrowserRestoreManager | null;
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
    this.restoreManager = options.uploads ? new BrowserRestoreManager(runtime, options.uploads) : null;
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
      update: (input) => gated(() => facts.updatePerson(input)),
      setChildrenCompleteness: (input) => gated(() => facts.setChildrenCompleteness(input)),
      getChildrenCountStatus: (input) => gated(() => facts.getChildrenCountStatus(input))
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
      parse: (input) => gated(() => this.parseUploadedImport(input, options.uploads)),
      commit: (input) => gated(() => this.commitImport(input)),
      exportTemplate: () => this.exportTemplate(options.downloads)
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
      import: (input) => gated(() => this.importMedia(input.fileToken, options.uploads)),
      attach: (input) => gated(() => this.withMedia((service) => service.attachMedia(input))),
      listForPerson: (input) => gated(() => this.withMedia((service) => ({ ok: true, value: service.listForPerson(input.personId) })))
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
      createBackup: () => gated(() => this.createBackup(options.downloads)),
      listRestoreTargets: () => runtime.listFamilies(),
      selectRestoreFile: () => unavailable(),
      inspectBackup: (input) => this.restoreManager ? gated(() => this.restoreManager!.inspectBackup(input)) : unavailable(),
      restoreBackup: (input) => this.restoreManager ? this.restoreManager.restoreBackup(input) : unavailable(),
      exportWorkspace: () => unavailable()
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.chatGateway.dispose();
    await this.restoreManager?.dispose();
  }

  private async listAudit(): ReturnType<FamilyAgentApi["dataManagement"]["listAudit"]> {
    const context = this.runtime.workspaceManager.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    const database = openDatabase(context.databasePath);
    try { applyMigrations(database); return { ok: true, value: new UndoService(database, context.workspaceId).listOperationGroups() }; }
    catch { return failure("INTERNAL", "Unable to read operation history"); }
    finally { database.close(); }
  }

  private contextId(): string | null {
    const context = this.runtime.workspaceManager.getOpenWorkspaceContext();
    return context ? `${context.workspaceId}\u0000${context.openContextId}` : null;
  }

  private async parseUploadedImport(input: Parameters<FamilyAgentApi["imports"]["parse"]>[0], uploads?: UploadStore): ReturnType<FamilyAgentApi["imports"]["parse"]> {
    const context = this.runtime.workspaceManager.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    if (!uploads) return unavailable();
    const claimed = await uploads.claim(input.fileToken, "import");
    if (!claimed.ok) return { ok: false, error: { code: "PATH_DENIED", message: "Import upload expired or has the wrong purpose" } };
    try {
      const parsed = await parseImport(claimed.path, input.sourceKey, { csvEntityType: input.csvEntityType, fieldMapping: input.fieldMapping });
      parsed.fileName = claimed.fileName;
      const database = openDatabase(context.databasePath);
      try {
        applyMigrations(database);
        const plan = new ImportPlanner(database, context.workspaceId, this.importPlans, this.contextId() ?? context.workspaceId).plan(parsed);
        const { workspaceId: _workspaceId, openContextId: _openContextId, ...publicPlan } = plan;
        return { ok: true, value: publicPlan };
      } finally { database.close(); }
    } catch { return { ok: false, error: { code: "VALIDATION", message: "Import file is invalid" } }; }
    finally { await rm(claimed.path, { force: true }); }
  }

  private async commitImport(input: Parameters<FamilyAgentApi["imports"]["commit"]>[0]): ReturnType<FamilyAgentApi["imports"]["commit"]> {
    const context = this.runtime.workspaceManager.getOpenWorkspaceContext();
    const contextId = this.contextId();
    if (!context || !contextId) return failure("NOT_FOUND", "No workspace is open");
    const database = openDatabase(context.databasePath);
    let value: ReturnType<ImportCommitter["commitImport"]>;
    try {
      applyMigrations(database);
      value = new ImportCommitter(database, context.workspaceId, this.importPlans, contextId).commitImport(input.planId, input.selectedActionIds);
    } catch (error) {
      return { ok: false, error: { code: error instanceof ImportPlanAccessError ? error.code : "VALIDATION", message: "Import preview is invalid or expired" } };
    } finally { database.close(); }
    try { await this.runtime.workspaceManager.synchronizeOriginPerson(); }
    catch { return failure("INTERNAL", "Import was committed but the family origin could not be refreshed"); }
    return { ok: true, value };
  }

  private async exportTemplate(downloads?: DownloadStore): ReturnType<FamilyAgentApi["imports"]["exportTemplate"]> {
    if (!downloads) return unavailable();
    const context = this.runtime.workspaceManager.getOpenWorkspaceDetails();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    const path = join(context.backupsPath, `.template-${Date.now()}.xlsx`);
    try {
      await exportImportTemplate(path);
      const download = downloads.createDownload({ fileName: "family-import-template.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: await readFile(path) });
      return { ok: true, value: { saved: true, download } };
    } catch { return failure("INTERNAL", "Unable to create import template"); }
    finally { await rm(path, { force: true }); }
  }

  private async importMedia(fileToken: string, uploads?: UploadStore): ReturnType<FamilyAgentApi["media"]["import"]> {
    if (!uploads) return unavailable();
    const context = this.runtime.workspaceManager.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    const claimed = await uploads.claim(fileToken, "media");
    if (!claimed.ok) return { ok: false, error: { code: "PATH_DENIED", message: "Media upload expired or has the wrong purpose" } };
    try {
      const selection = await openSelectedMediaFile(claimed.path, context.workspaceId);
      selection.fileName = claimed.fileName;
      selection.extension = extname(claimed.fileName).toLocaleLowerCase("en-US");
      return await this.withMedia((service) => service.importMedia({ selection }));
    } finally { await rm(claimed.path, { force: true }); }
  }

  private async withMedia<T>(operation: (service: ManagedMediaService) => AppResult<T> | Promise<AppResult<T>>): Promise<AppResult<T>> {
    const context = this.runtime.workspaceManager.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    const database = openDatabase(context.databasePath);
    try {
      applyMigrations(database);
      return await operation(new ManagedMediaService(database, context.workspaceId, context.mediaPath, { assetUrl: (id) => `/api/media/${id}` }));
    } catch { return failure("INTERNAL", "Unable to complete media request"); }
    finally { database.close(); }
  }

  private async createBackup(downloads?: DownloadStore): ReturnType<FamilyAgentApi["dataManagement"]["createBackup"]> {
    if (!downloads) return unavailable();
    const context = this.runtime.workspaceManager.getOpenWorkspaceDetails();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    const path = join(context.backupsPath, `.download-${Date.now()}.zip`);
    try {
      const result = await new BackupService({ workspaceId: context.workspaceId, workspaceName: context.workspaceName, originPersonId: context.originPersonId, workspaceRoot: context.workspaceRoot, databasePath: context.databasePath, mediaRoot: context.mediaPath, manifestPath: context.manifestPath, backupsRoot: context.backupsPath }).createBackup(path);
      const download = downloads.createDownload({ fileName: `family-backup-${new Date().toISOString().slice(0, 10)}.zip`, mimeType: "application/zip", bytes: await readFile(path) });
      return { ok: true, value: { saved: true, verified: true, createdAt: result.manifest.createdAt, schemaVersion: result.manifest.schemaVersion, counts: result.manifest.counts, download } };
    } catch { return failure("INTERNAL", "Unable to create backup"); }
    finally { await rm(path, { force: true }); }
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
