import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/contracts.js";

const desktopApi: DesktopApi = {
  app: {
    getVersion: () => ipcRenderer.invoke("desktop:get-version")
  },
  workspaces: {
    list: () => ipcRenderer.invoke("workspaces:list"),
    create: (input) => ipcRenderer.invoke("workspaces:create", input),
    open: (input) => ipcRenderer.invoke("workspaces:open", input),
    close: () => ipcRenderer.invoke("workspaces:close")
  }
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
