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
  },
  imports: {
    selectFile: () => ipcRenderer.invoke("imports:select-file", {}),
    parse: (input) => ipcRenderer.invoke("imports:parse", input),
    commit: (input) => ipcRenderer.invoke("imports:commit", input),
    exportTemplate: () => ipcRenderer.invoke("imports:export-template", {})
  },
  merges: {
    findDuplicateCandidates: (input) => ipcRenderer.invoke("merges:candidates", input),
    preview: (input) => ipcRenderer.invoke("merges:preview", input),
    merge: (input) => ipcRenderer.invoke("merges:merge", input),
    history: () => ipcRenderer.invoke("merges:history"),
    canUnmerge: (input) => ipcRenderer.invoke("merges:can-unmerge", input),
    unmerge: (input) => ipcRenderer.invoke("merges:unmerge", input)
  },
  media: {
    select: () => ipcRenderer.invoke("media:select", {}),
    import: (input) => ipcRenderer.invoke("media:import", input),
    attach: (input) => ipcRenderer.invoke("media:attach", input),
    listForPerson: (input) => ipcRenderer.invoke("media:list-for-person", input)
  },
  wiki: {
    create: (input) => ipcRenderer.invoke("wiki:create", input),
    update: (input) => ipcRenderer.invoke("wiki:update", input),
    remove: (input) => ipcRenderer.invoke("wiki:remove", input),
    get: (input) => ipcRenderer.invoke("wiki:get", input)
  },
  query: {
    searchPeople: (input) => ipcRenderer.invoke("query:search-people", input),
    getPerson: (input) => ipcRenderer.invoke("query:get-person", input),
    listRelatives: (input) => ipcRenderer.invoke("query:list-relatives", input),
    calculateRelationship: (input) => ipcRenderer.invoke("query:calculate-relationship", input),
    summarizeLineage: (input) => ipcRenderer.invoke("query:summarize-lineage", input),
    searchWiki: (input) => ipcRenderer.invoke("query:search-wiki", input)
  }
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
