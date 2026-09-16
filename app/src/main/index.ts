import { app, BrowserWindow, ipcMain, net, protocol, session } from "electron";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { installNavigationPolicy } from "./security/navigation-policy.js";
import { createSecureWebPreferences } from "./security/window-options.js";
import { registerWorkspaceIpc } from "./ipc/register-ipc.js";
import { WorkspaceManager } from "./workspaces/workspace-manager.js";

const rendererRoot = resolve(__dirname, "../renderer");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { secure: true, standard: true, supportFetchAPI: true }
  }
]);

function registerAppProtocol(): void {
  protocol.handle("app", (request) => {
    const requestPath = new URL(request.url).pathname;
    const filePath = resolve(rendererRoot, `.${normalize(requestPath)}`);

    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${sep}`)) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
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
  registerAppProtocol();
  ipcMain.handle("desktop:get-version", () => app.getVersion());
  mainWindow = createWindow();
  registerWorkspaceIpc(ipcMain, () => mainWindow?.webContents.id, new WorkspaceManager(join(app.getPath("userData"), "workspaces")));

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
