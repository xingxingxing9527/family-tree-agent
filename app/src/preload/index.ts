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
  },
  people: {
    list: (input) => ipcRenderer.invoke("people:list", input),
    get: (input) => ipcRenderer.invoke("people:get", input),
    save: (input) => ipcRenderer.invoke("people:save", input),
    update: (input) => ipcRenderer.invoke("people:update", input)
  },
  relations: {
    addParentChild: (input) => ipcRenderer.invoke("relations:add-parent-child", input),
    addMarriage: (input) => ipcRenderer.invoke("relations:add-marriage", input),
    divorce: (input) => ipcRenderer.invoke("relations:divorce", input)
  }
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
