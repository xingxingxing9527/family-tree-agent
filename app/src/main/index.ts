import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session } from "electron";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { installNavigationPolicy } from "./security/navigation-policy.js";
import { createSecureWebPreferences } from "./security/window-options.js";
import { registerChatIpc, registerDataManagementIpc, registerFactsIpc, registerImportIpc, registerMediaIpc, registerMergeIpc, registerModelSettingsIpc, registerQueryIpc, registerWikiIpc, registerWorkspaceIpc } from "./ipc/register-ipc.js";
import { WorkspaceMergeGateway } from "./ipc/merge-ipc.js";
import { WorkspaceImportGateway, type ImportDialogs } from "./ipc/import-ipc.js";
import { WorkspaceFactsGateway } from "./application/facts/facts-gateway.js";
import { WorkspaceQueryGateway } from "./ipc/query-ipc.js";
import { WorkspaceManager } from "./workspaces/workspace-manager.js";
import { WorkspaceMediaGateway, type MediaDialogs } from "./ipc/media-ipc.js";
import { WorkspaceWikiGateway } from "./ipc/wiki-ipc.js";
import { resolveWorkspaceMediaRequest } from "./media/media-protocol.js";
import { CredentialVault } from "./security/credential-vault.js";
import { WorkspaceChatGateway } from "./ipc/chat-ipc.js";
import { OpenAIResponsesAdapter } from "./llm/openai-responses-adapter.js";
import { WorkspaceDataManagementGateway, type DataManagementDialogs } from "./ipc/data-management-ipc.js";
import { WorkspaceMutationGate } from "./workspaces/workspace-mutation-gate.js";
import { DeterministicE2EAdapter } from "./llm/deterministic-e2e-adapter.js";

const rendererRoot = resolve(__dirname, "../renderer");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { secure: true, standard: true, supportFetchAPI: true }
  }
  , { scheme: "app-media", privileges: { secure: true, standard: true, supportFetchAPI: true } }
]);

function registerAppProtocol(workspaces?: WorkspaceManager, operations?: WorkspaceMutationGate): void {
  protocol.handle("app", (request) => {
    const requestPath = new URL(request.url).pathname;
    const filePath = resolve(rendererRoot, `.${normalize(requestPath)}`);

    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${sep}`)) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
  protocol.handle("app-media", (request) => {
    return workspaces && operations
      ? resolveWorkspaceMediaRequest(request.url, workspaces, operations)
      : new Response("Not found", { status: 404 });
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "家谱智能体",
    webPreferences: createSecureWebPreferences(join(__dirname, "../preload/index.cjs"))
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  installNavigationPolicy(window);

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadURL("app://renderer/index.html");
  }

  return window;
}

app.enableSandbox();

app.whenReady().then(() => {
  let mainWindow: BrowserWindow | null = null;
  const workspaceManager = new WorkspaceManager(join(app.getPath("userData"), "workspaces"));
  const workspaceMutations = new WorkspaceMutationGate();
  registerAppProtocol(workspaceManager, workspaceMutations);
  ipcMain.handle("desktop:get-version", () => app.getVersion());
  mainWindow = createWindow();
  registerWorkspaceIpc(ipcMain, () => mainWindow?.webContents.id, workspaceManager, workspaceMutations);
  registerFactsIpc(ipcMain, () => mainWindow?.webContents.id, new WorkspaceFactsGateway(workspaceManager), workspaceMutations);
  registerQueryIpc(ipcMain, () => mainWindow?.webContents.id, new WorkspaceQueryGateway(workspaceManager), workspaceMutations);
  const testFixturePath = (name: string): string | undefined => !app.isPackaged ? process.env[name]?.trim() || undefined : undefined;
  const importPath = testFixturePath("FAMILY_AGENT_E2E_IMPORT_PATH");
  const importDialogs: ImportDialogs | undefined = importPath ? {
    showOpenDialog: async () => ({ canceled: false, filePaths: [importPath] }),
    showSaveDialog: async () => ({ canceled: true })
  } : undefined;
  registerImportIpc(ipcMain, () => mainWindow?.webContents.id, new WorkspaceImportGateway(workspaceManager, importDialogs), workspaceMutations);
  registerMergeIpc(ipcMain, () => mainWindow?.webContents.id, new WorkspaceMergeGateway(workspaceManager), workspaceMutations);
  const mediaPath = testFixturePath("FAMILY_AGENT_E2E_MEDIA_PATH");
  const mediaDialogs: MediaDialogs | undefined = mediaPath ? { showOpenDialog: async () => ({ canceled: false, filePaths: [mediaPath] }) } : undefined;
  const mediaGateway = new WorkspaceMediaGateway(workspaceManager, mediaDialogs);
  registerMediaIpc(ipcMain, () => mainWindow?.webContents.id, mediaGateway, workspaceMutations);
  const credentialVault = new CredentialVault(join(app.getPath("userData"), "secrets"), safeStorage);
  const deterministicChat = !app.isPackaged && process.env.FAMILY_AGENT_E2E_CHAT === "1";
  const chatGateway = new WorkspaceChatGateway(
    workspaceManager,
    deterministicChat ? { readKey: async () => "e2e-local-only" } : credentialVault,
    deterministicChat ? () => new DeterministicE2EAdapter() : (apiKey) => new OpenAIResponsesAdapter({
      apiKey,
      model: process.env.FAMILY_AGENT_MODEL?.trim() || "gpt-4o-mini"
    })
  );
  registerChatIpc(ipcMain, () => mainWindow?.webContents.id, chatGateway, workspaceMutations);
  const disposeWorkspaceRuntime = async (): Promise<void> => {
    const results = await Promise.allSettled([
      mediaGateway.dispose(),
      Promise.resolve().then(() => chatGateway.dispose())
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), "Unable to dispose workspace services");
  };
  const backupPath = testFixturePath("FAMILY_AGENT_E2E_BACKUP_PATH");
  const dataDialogs: DataManagementDialogs | undefined = backupPath ? {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: false, filePath: backupPath })
  } : undefined;
  const dataManagementGateway = new WorkspaceDataManagementGateway(workspaceManager, dataDialogs, {
    disposeWorkspaceServices: disposeWorkspaceRuntime,
    mutationGate: workspaceMutations
  });
  registerDataManagementIpc(ipcMain, () => mainWindow?.webContents.id, dataManagementGateway, workspaceMutations);
  app.once("before-quit", () => { void disposeWorkspaceRuntime().catch(() => undefined); void dataManagementGateway.dispose(); });
  registerWikiIpc(ipcMain, () => mainWindow?.webContents.id, new WorkspaceWikiGateway(workspaceManager), workspaceMutations);
  registerModelSettingsIpc(ipcMain, () => mainWindow?.webContents.id, credentialVault);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
