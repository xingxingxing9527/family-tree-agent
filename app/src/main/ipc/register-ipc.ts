import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AppResult } from "../../shared/contracts.js";
import type { WorkspaceManager } from "../workspaces/workspace-manager.js";
import type { WorkspaceMutationGate } from "../workspaces/workspace-mutation-gate.js";

export { FACT_CHANNELS, registerFactsIpc } from "./facts-ipc.js";
export { QUERY_CHANNELS, registerQueryIpc } from "./query-ipc.js";
export { IMPORT_CHANNELS, registerImportIpc } from "./import-ipc.js";
export { MERGE_CHANNELS, registerMergeIpc } from "./merge-ipc.js";
export { MEDIA_CHANNELS, registerMediaIpc } from "./media-ipc.js";
export { WIKI_CHANNELS, registerWikiIpc } from "./wiki-ipc.js";
export { CHAT_CHANNELS, MODEL_SETTINGS_CHANNELS, registerChatIpc, registerModelSettingsIpc } from "./chat-ipc.js";
export { DATA_MANAGEMENT_CHANNELS, registerDataManagementIpc } from "./data-management-ipc.js";
export { LINEAGE_CHANNELS, registerLineageIpc } from "./lineage-ipc.js";

export const WORKSPACE_CHANNELS = { list: "workspaces:list", create: "workspaces:create", open: "workspaces:open", close: "workspaces:close" } as const;
type IpcMainLike = Pick<IpcMain, "handle">;
const createSchema = z.object({ name: z.string().trim().min(1).max(200) });
const openSchema = z.object({ id: z.string().uuid() });
const denied = <T>(): AppResult<T> => ({ ok: false, error: { code: "PATH_DENIED", message: "IPC sender was denied" } });
const invalid = <T>(field: string): AppResult<T> => ({ ok: false, error: { code: "VALIDATION", message: "Invalid request", details: { field } } });

export function registerWorkspaceIpc(ipc: IpcMainLike, mainWindowId: () => number | undefined, manager: WorkspaceManager, mutations?: WorkspaceMutationGate): void {
  const trusted = (event: IpcMainInvokeEvent) => event.sender.id === mainWindowId();
  const run = <T>(operation: () => Promise<T>): Promise<T> => mutations ? mutations.runOperation(operation) : operation();
  ipc.handle(WORKSPACE_CHANNELS.list, (event) => trusted(event) ? run(() => manager.list()) : denied());
  ipc.handle(WORKSPACE_CHANNELS.create, (event, input: unknown) => { if (!trusted(event)) return denied(); const parsed = createSchema.safeParse(input); return parsed.success ? run(() => manager.create(parsed.data)) : invalid("name"); });
  ipc.handle(WORKSPACE_CHANNELS.open, (event, input: unknown) => { if (!trusted(event)) return denied(); const parsed = openSchema.safeParse(input); return parsed.success ? run(() => manager.open(parsed.data)) : invalid("id"); });
  ipc.handle(WORKSPACE_CHANNELS.close, (event) => trusted(event) ? run(() => manager.close()) : denied());
}
