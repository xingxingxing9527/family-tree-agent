import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktopApi", {
  app: {
    getVersion: () => ipcRenderer.invoke("desktop:get-version")
  }
});
