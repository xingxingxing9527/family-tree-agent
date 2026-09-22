import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AppResult } from "../../shared/contracts.js";
import type { WorkspaceManager } from "../workspaces/workspace-manager.js";

export { FACT_CHANNELS, registerFactsIpc } from "./facts-ipc.js";
export { QUERY_CHANNELS, registerQueryIpc } from "./query-ipc.js";
export { IMPORT_CHANNELS, registerImportIpc } from "./import-ipc.js";

export const WORKSPACE_CHANNELS = { list: "workspaces:list", create: "workspaces:create", open: "workspaces:open", close: "workspaces:close" } as const;
type IpcMainLike = Pick<IpcMain, "handle">;
const createSchema = z.object({ name: z.string().trim().min(1).max(200) });
const openSchema = z.object({ id: z.string().uuid() });
const denied = <T>(): AppResult<T> => ({ ok: false, error: { code: "PATH_DENIED", message: "IPC sender was denied" } });
const invalid = <T>(field: string): AppResult<T> => ({ ok: false, error: { code: "VALIDATION", message: "Invalid request", details: { field } } });

export function registerWorkspaceIpc(ipc: IpcMainLike, mainWindowId: () => number | undefined, manager: WorkspaceManager): void {
  const trusted = (event: IpcMainInvokeEvent) => event.sender.id === mainWindowId();
  ipc.handle(WORKSPACE_CHANNELS.list, (event) => trusted(event) ? manager.list() : denied());
  ipc.handle(WORKSPACE_CHANNELS.create, (event, input: unknown) => { if (!trusted(event)) return denied(); const parsed = createSchema.safeParse(input); return parsed.success ? manager.create(parsed.data) : invalid("name"); });
  ipc.handle(WORKSPACE_CHANNELS.open, (event, input: unknown) => { if (!trusted(event)) return denied(); const parsed = openSchema.safeParse(input); return parsed.success ? manager.open(parsed.data) : invalid("id"); });
  ipc.handle(WORKSPACE_CHANNELS.close, (event) => trusted(event) ? manager.close() : denied());
}
