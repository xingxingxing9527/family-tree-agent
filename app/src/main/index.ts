import { app, BrowserWindow, ipcMain, net, protocol, session } from "electron";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { installNavigationPolicy } from "./security/navigation-policy.js";
import { createSecureWebPreferences } from "./security/window-options.js";
import { registerFactsIpc, registerImportIpc, registerMediaIpc, registerMergeIpc, registerQueryIpc, registerWikiIpc, registerWorkspaceIpc } from "./ipc/register-ipc.js";
import { WorkspaceMergeGateway } from "./ipc/merge-ipc.js";
import { WorkspaceImportGateway } from "./ipc/import-ipc.js";
import { WorkspaceFactsGateway } from "./application/facts/facts-gateway.js";
import { WorkspaceQueryGateway } from "./ipc/query-ipc.js";
import { WorkspaceManager } from "./workspaces/workspace-manager.js";
import { WorkspaceMediaGateway } from "./ipc/media-ipc.js";
import { WorkspaceWikiGateway } from "./ipc/wiki-ipc.js";
import { resolveMediaAssetRequest } from "./media/media-protocol.js";

const rendererRoot = resolve(__dirname, "../renderer");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { secure: true, standard: true, supportFetchAPI: true }
  }
  , { scheme: "app-media", privileges: { secure: true, standard: true, supportFetchAPI: true } }
]);

function registerAppProtocol(workspaces?: WorkspaceManager): void {
  protocol.handle("app", (request) => {
    const requestPath = new URL(request.url).pathname;
    const filePath = resolve(rendererRoot, `.${normalize(requestPath)}`);

    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${sep}`)) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
  protocol.handle("app-media", (request) => {
    const context = workspaces?.getOpenWorkspaceContext();
    return context ? resolveMediaAssetRequest(request.url, context) : new Response("Not found", { status: 404 });
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
  registerAppProtocol(workspaceManager);
  ipcMain.handle("desktop:get-version", () => app.getVersion());
  mainWindow = createWindow();
  registerWorkspaceIpc(ipcMain, () => mainWindow?.webContents.id, workspaceManager);
  registerFactsIpc(ipcMain, () => mainWindow?.webContents.id, new WorkspaceFactsGateway(workspaceManager));
  registerQueryIpc(ipcMain, () => mainWindow?.webContents.id, new WorkspaceQueryGateway(workspaceManager));
  registerImportIpc(ipcMain, () => mainWindow?.webContents.id, new WorkspaceImportGateway(workspaceManager));
  registerMergeIpc(ipcMain, () => mainWindow?.webContents.id, new WorkspaceMergeGateway(workspaceManager));
  const mediaGateway = new WorkspaceMediaGateway(workspaceManager);
  registerMediaIpc(ipcMain, () => mainWindow?.webContents.id, mediaGateway);
  app.once("before-quit", () => mediaGateway.dispose());
  registerWikiIpc(ipcMain, () => mainWindow?.webContents.id, new WorkspaceWikiGateway(workspaceManager));

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
