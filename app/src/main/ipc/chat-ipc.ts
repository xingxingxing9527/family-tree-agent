import { createHash, randomUUID } from "node:crypto";
import type { AppResult, PersonCandidate } from "../../shared/contracts.js";
import type { ConversationAnswer, ConversationConfirmationReceipt, ConversationDraftPreview } from "../../shared/chat.js";
import { askRequestSchema, confirmDraftRequestSchema, disclosureRequestSchema, reviseDraftRequestSchema, stageMutationRequestSchema, type ConversationMutationDraft } from "../../shared/chat.js";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { ZodType } from "zod";
import { z } from "zod";
import type { CredentialVault } from "../security/credential-vault.js";
import { applyMigrations } from "../database/migrations/index.js";
import { openDatabase, type WorkspaceDatabase } from "../database/open-database.js";
import { QueryToolRegistry } from "../application/query/query-tool-registry.js";
import { DraftService } from "../application/chat/draft-service.js";
import { ConversationService } from "../application/chat/conversation-service.js";
import type { ModelAdapter } from "../llm/model-adapter.js";
import type { OpenWorkspaceContext, OpenWorkspaceContextProvider } from "../application/facts/facts-gateway.js";

type Operation = "extract" | "ask";
interface Binding { workspaceId: string; sessionId: string; operation: Operation; payload: unknown; }
interface Capability { digest: string; expiresAt: number; }

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
  return JSON.stringify(value);
};
const digest = (binding: Binding): string => createHash("sha256").update(canonical(binding)).digest("hex");
const failure = <T>(code: "NOT_FOUND" | "PATH_DENIED" | "MODEL_UNAVAILABLE" | "VALIDATION" | "CONFLICT", message: string): AppResult<T> => ({ ok: false, error: { code, message } });

export class DisclosureCapabilityService {
  private readonly capabilities = new Map<string, Capability>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 60_000, private readonly maxOutstanding = 256) {}
  issue(binding: Binding): { authorizationToken: string; expiresAt: string } {
    for (const [token, capability] of this.capabilities) if (capability.expiresAt < this.now()) this.capabilities.delete(token);
    while (this.capabilities.size >= Math.max(1, this.maxOutstanding)) this.capabilities.delete(this.capabilities.keys().next().value!);
    const token = randomUUID(); const expiresAt = this.now() + this.ttlMs;
    this.capabilities.set(token, { digest: digest(binding), expiresAt });
    return { authorizationToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }
  consume(token: string, binding: Binding): boolean {
    const capability = this.capabilities.get(token); this.capabilities.delete(token);
    return Boolean(capability && capability.expiresAt >= this.now() && capability.digest === digest(binding));
  }
}

export class ControlledChatGateway {
  constructor(
    private readonly getWorkspace: () => Pick<OpenWorkspaceContext, "workspaceId"> | null,
    private readonly capabilities: DisclosureCapabilityService,
    private readonly drafts: DraftService,
    private readonly conversation: ConversationService
  ) {}

  async authorize(input: { sessionId: string; operation: Operation; payload: unknown }): Promise<AppResult<{ authorizationToken: string; expiresAt: string }>> {
    const workspace = this.getWorkspace();
    if (!workspace) return failure("NOT_FOUND", "No workspace is open");
    return { ok: true, value: this.capabilities.issue({ workspaceId: workspace.workspaceId, ...input }) };
  }

  async stageMutation(input: { sessionId: string; authorizationToken: string; payload: { text: string; candidatePeople: PersonCandidate[] } }): Promise<AppResult<ConversationDraftPreview>> {
    const workspace = this.getWorkspace();
    if (!workspace) return failure("NOT_FOUND", "No workspace is open");
    if (!this.capabilities.consume(input.authorizationToken, { workspaceId: workspace.workspaceId, sessionId: input.sessionId, operation: "extract", payload: input.payload })) return failure("PATH_DENIED", "Online model authorization is invalid or expired");
    try { return { ok: true, value: await this.drafts.stageFromText(input.payload.text, input.payload.candidatePeople) }; }
    catch { return failure("MODEL_UNAVAILABLE", "The online model is unavailable"); }
  }

  async ask(input: { sessionId: string; authorizationToken: string; payload: { question: string; viewpointId: string; selectedPersonId: string | null } }): Promise<AppResult<ConversationAnswer>> {
    const workspace = this.getWorkspace();
    if (!workspace) return failure("NOT_FOUND", "No workspace is open");
    if (!this.capabilities.consume(input.authorizationToken, { workspaceId: workspace.workspaceId, sessionId: input.sessionId, operation: "ask", payload: input.payload })) return failure("PATH_DENIED", "Online model authorization is invalid or expired");
    try { return { ok: true, value: await this.conversation.ask(input.payload) }; }
    catch { return failure("MODEL_UNAVAILABLE", "The online model is unavailable"); }
  }

  async confirm(input: { draftId: string; selectedChangeIds: string[]; expectedVersions: Record<string, number> }): Promise<AppResult<ConversationConfirmationReceipt>> {
    try { return { ok: true, value: this.drafts.confirm(input.draftId, input.selectedChangeIds, input.expectedVersions) }; }
    catch (error) { return failure("VALIDATION", error instanceof Error ? error.message.slice(0, 500) : "Draft confirmation failed"); }
  }

  async revise(input: { draftId: string; replacement: ConversationMutationDraft }): Promise<AppResult<ConversationDraftPreview>> {
    try { return { ok: true, value: this.drafts.revise(input.draftId, input.replacement) }; }
    catch (error) { return failure("VALIDATION", error instanceof Error ? error.message.slice(0, 500) : "Draft revision failed"); }
  }
}

export class WorkspaceChatGateway implements ChatGateway {
  private runtime: { workspaceId: string; databasePath: string; database: WorkspaceDatabase; drafts: DraftService; registry: QueryToolRegistry } | null = null;
  constructor(
    private readonly workspaces: OpenWorkspaceContextProvider,
    private readonly vault: Pick<CredentialVault, "readKey">,
    private readonly modelFactory: (apiKey: string) => ModelAdapter,
    private readonly capabilities = new DisclosureCapabilityService()
  ) {}

  async authorize(input: Parameters<ChatGateway["authorize"]>[0]): ReturnType<ChatGateway["authorize"]> {
    const workspace = this.workspaces.getOpenWorkspaceContext();
    if (!workspace) return failure("NOT_FOUND", "No workspace is open");
    return { ok: true, value: this.capabilities.issue({ workspaceId: workspace.workspaceId, ...input }) };
  }

  async stageMutation(input: Parameters<ChatGateway["stageMutation"]>[0]): ReturnType<ChatGateway["stageMutation"]> {
    const workspace = this.workspaces.getOpenWorkspaceContext();
    if (!workspace) return failure("NOT_FOUND", "No workspace is open");
    if (!this.capabilities.consume(input.authorizationToken, { workspaceId: workspace.workspaceId, sessionId: input.sessionId, operation: "extract", payload: input.payload })) return failure("PATH_DENIED", "Online model authorization is invalid or expired");
    try {
      const key = await this.vault.readKey();
      if (!key) return failure("MODEL_UNAVAILABLE", "The online model is unavailable");
      const modelDraft = await this.modelFactory(key).extractDraft(input.payload);
      return { ok: true, value: this.getRuntime(workspace).drafts.stage(modelDraft) };
    } catch { return failure("MODEL_UNAVAILABLE", "The online model is unavailable"); }
  }

  async ask(input: Parameters<ChatGateway["ask"]>[0]): ReturnType<ChatGateway["ask"]> {
    const workspace = this.workspaces.getOpenWorkspaceContext();
    if (!workspace) return failure("NOT_FOUND", "No workspace is open");
    if (!this.capabilities.consume(input.authorizationToken, { workspaceId: workspace.workspaceId, sessionId: input.sessionId, operation: "ask", payload: input.payload })) return failure("PATH_DENIED", "Online model authorization is invalid or expired");
    try {
      const key = await this.vault.readKey();
      if (!key) return failure("MODEL_UNAVAILABLE", "The online model is unavailable");
      const runtime = this.getRuntime(workspace);
      return { ok: true, value: await new ConversationService(this.modelFactory(key), runtime.registry).ask(input.payload) };
    } catch { return failure("MODEL_UNAVAILABLE", "The online model is unavailable"); }
  }

  async confirm(input: Parameters<ChatGateway["confirm"]>[0]): ReturnType<ChatGateway["confirm"]> {
    const workspace = this.workspaces.getOpenWorkspaceContext();
    if (!workspace) return failure("NOT_FOUND", "No workspace is open");
    try { return { ok: true, value: this.getRuntime(workspace).drafts.confirm(input.draftId, input.selectedChangeIds, input.expectedVersions) }; }
    catch (error) { return failure("VALIDATION", error instanceof Error ? error.message.slice(0, 500) : "Draft confirmation failed"); }
  }

  async revise(input: Parameters<ChatGateway["revise"]>[0]): ReturnType<ChatGateway["revise"]> {
    const workspace = this.workspaces.getOpenWorkspaceContext();
    if (!workspace) return failure("NOT_FOUND", "No workspace is open");
    try { return { ok: true, value: this.getRuntime(workspace).drafts.revise(input.draftId, input.replacement) }; }
    catch (error) { return failure("VALIDATION", error instanceof Error ? error.message.slice(0, 500) : "Draft revision failed"); }
  }

  dispose(): void {
    this.runtime?.drafts.invalidate();
    this.runtime?.database.close();
    this.runtime = null;
  }

  private getRuntime(workspace: { workspaceId: string; databasePath: string }) {
    if (this.runtime?.workspaceId === workspace.workspaceId && this.runtime.databasePath === workspace.databasePath) return this.runtime;
    this.dispose();
    const database = openDatabase(workspace.databasePath);
    applyMigrations(database);
    this.runtime = {
      workspaceId: workspace.workspaceId,
      databasePath: workspace.databasePath,
      database,
      drafts: new DraftService(database, workspace.workspaceId),
      registry: new QueryToolRegistry(database, workspace.workspaceId)
    };
    return this.runtime;
  }
}

export interface ChatGateway {
  authorize(input: Parameters<ControlledChatGateway["authorize"]>[0]): ReturnType<ControlledChatGateway["authorize"]>;
  stageMutation(input: Parameters<ControlledChatGateway["stageMutation"]>[0]): ReturnType<ControlledChatGateway["stageMutation"]>;
  ask(input: Parameters<ControlledChatGateway["ask"]>[0]): ReturnType<ControlledChatGateway["ask"]>;
  confirm(input: Parameters<ControlledChatGateway["confirm"]>[0]): ReturnType<ControlledChatGateway["confirm"]>;
  revise(input: Parameters<ControlledChatGateway["revise"]>[0]): ReturnType<ControlledChatGateway["revise"]>;
}

export const CHAT_CHANNELS = {
  authorize: "chat:authorize-online", stageMutation: "chat:stage-mutation", ask: "chat:ask", confirm: "chat:confirm-draft", revise: "chat:revise-draft"
} as const;
type IpcMainLike = Pick<IpcMain, "handle">;
const invalid = (): AppResult<never> => failure("VALIDATION", "Invalid request");
const denied = (): AppResult<never> => failure("PATH_DENIED", "IPC sender was denied");

const handler = <T>(trusted: (event: IpcMainInvokeEvent) => boolean, schema: ZodType<T>, operation: (input: T) => Promise<unknown>) =>
  async (event: IpcMainInvokeEvent, raw: unknown): Promise<unknown> => {
    if (!trusted(event)) return denied();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return invalid();
    return operation(parsed.data);
  };

export function registerChatIpc(ipc: IpcMainLike, mainWindowId: () => number | undefined, gateway: ChatGateway): void {
  const trusted = (event: IpcMainInvokeEvent) => event.sender.id === mainWindowId();
  ipc.handle(CHAT_CHANNELS.authorize, handler(trusted, disclosureRequestSchema, (input) => gateway.authorize(input)));
  ipc.handle(CHAT_CHANNELS.stageMutation, handler(trusted, stageMutationRequestSchema, (input) => gateway.stageMutation(input)));
  ipc.handle(CHAT_CHANNELS.ask, handler(trusted, askRequestSchema, (input) => gateway.ask(input)));
  ipc.handle(CHAT_CHANNELS.confirm, handler(trusted, confirmDraftRequestSchema, (input) => gateway.confirm(input)));
  ipc.handle(CHAT_CHANNELS.revise, handler(trusted, reviseDraftRequestSchema, (input) => gateway.revise(input)));
}

export const MODEL_SETTINGS_CHANNELS = { status: "model-settings:status", saveKey: "model-settings:save-key", clearKey: "model-settings:clear-key" } as const;
const saveKeySchema = z.object({ key: z.string().trim().min(1).max(512) }).strict();

export function registerModelSettingsIpc(
  ipc: IpcMainLike,
  mainWindowId: () => number | undefined,
  vault: Pick<CredentialVault, "readKey" | "saveKey" | "clearKey">
): void {
  const trusted = (event: IpcMainInvokeEvent) => event.sender.id === mainWindowId();
  ipc.handle(MODEL_SETTINGS_CHANNELS.status, async (event) => {
    if (!trusted(event)) return denied();
    try { return { ok: true, value: { configured: (await vault.readKey()) !== null } }; }
    catch { return { ok: false, error: { code: "INTERNAL", message: "Unable to read model-key status" } }; }
  });
  ipc.handle(MODEL_SETTINGS_CHANNELS.saveKey, async (event, raw: unknown) => {
    if (!trusted(event)) return denied();
    const parsed = saveKeySchema.safeParse(raw); if (!parsed.success) return invalid();
    try { await vault.saveKey(parsed.data.key); return { ok: true, value: null }; }
    catch { return { ok: false, error: { code: "INTERNAL", message: "Unable to save the model key securely" } }; }
  });
  ipc.handle(MODEL_SETTINGS_CHANNELS.clearKey, async (event) => {
    if (!trusted(event)) return denied();
    try { await vault.clearKey(); return { ok: true, value: null }; }
    catch { return { ok: false, error: { code: "INTERNAL", message: "Unable to remove the model key" } }; }
  });
}
