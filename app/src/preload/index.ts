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
    update: (input) => ipcRenderer.invoke("people:update", input),
    setChildrenCompleteness: (input) => ipcRenderer.invoke("people:children-completeness-set", input),
    getChildrenCountStatus: (input) => ipcRenderer.invoke("people:children-count-status", input)
  },
  relations: {
    addParentChild: (input) => ipcRenderer.invoke("relations:add-parent-child", input),
    addMarriage: (input) => ipcRenderer.invoke("relations:add-marriage", input),
    divorce: (input) => ipcRenderer.invoke("relations:divorce", input),
    planRelativePath: (input) => ipcRenderer.invoke("relations:plan-relative-path", input)
  },
  lineages: {
    createLineage: (input) => ipcRenderer.invoke("lineages:create", input),
    updateLineage: (input) => ipcRenderer.invoke("lineages:update", input),
    archiveLineage: (input) => ipcRenderer.invoke("lineages:archive", input),
    addMembership: (input) => ipcRenderer.invoke("lineages:add-membership", input),
    updateMembership: (input) => ipcRenderer.invoke("lineages:update-membership", input),
    removeMembership: (input) => ipcRenderer.invoke("lineages:remove-membership", input)
  },
  imports: {
    selectFile: () => ipcRenderer.invoke("imports:select-file", {}),
    parse: (input) => ipcRenderer.invoke("imports:parse", input),
    commit: (input) => ipcRenderer.invoke("imports:commit", input),
    exportTemplate: () => ipcRenderer.invoke("imports:export-template", {}),
    exportCurrentWorkbook: () => ipcRenderer.invoke("imports:export-current-workbook", {}),
    exportBlankWorkbook: () => ipcRenderer.invoke("imports:export-blank-workbook", {})
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
    list: (input) => ipcRenderer.invoke("wiki:list", input),
    create: (input) => ipcRenderer.invoke("wiki:create", input),
    update: (input) => ipcRenderer.invoke("wiki:update", input),
    remove: (input) => ipcRenderer.invoke("wiki:remove", input),
    get: (input) => ipcRenderer.invoke("wiki:get", input)
  },
  query: {
    workspaceSnapshot: () => ipcRenderer.invoke("query:workspace-snapshot", {}),
    projectTree: (input) => ipcRenderer.invoke("query:project-tree", input),
    searchPeople: (input) => ipcRenderer.invoke("query:search-people", input),
    getPerson: (input) => ipcRenderer.invoke("query:get-person", input),
    listRelatives: (input) => ipcRenderer.invoke("query:list-relatives", input),
    calculateRelationship: (input) => ipcRenderer.invoke("query:calculate-relationship", input),
    summarizeLineage: (input) => ipcRenderer.invoke("query:summarize-lineage", input),
    searchWiki: (input) => ipcRenderer.invoke("query:search-wiki", input)
  },
  mutations: {
    stage: (input) => ipcRenderer.invoke("mutations:stage", input),
    confirm: (input) => ipcRenderer.invoke("mutations:confirm", input),
    revise: (input) => ipcRenderer.invoke("mutations:revise", input)
  },
  chat: {
    authorize: (input) => ipcRenderer.invoke("chat:authorize-online", input),
    stageMutation: (input) => ipcRenderer.invoke("chat:stage-mutation", input),
    ask: (input) => ipcRenderer.invoke("chat:ask", input),
    confirm: (input) => ipcRenderer.invoke("chat:confirm-draft", input),
    revise: (input) => ipcRenderer.invoke("chat:revise-draft", input)
  },
  modelSettings: {
    status: () => ipcRenderer.invoke("model-settings:status"),
    saveKey: (input) => ipcRenderer.invoke("model-settings:save-key", input),
    clearKey: () => ipcRenderer.invoke("model-settings:clear-key")
  },
  dataManagement: {
    listAudit: () => ipcRenderer.invoke("data-management:audit-list", {}),
    undoOperationGroup: (input) => ipcRenderer.invoke("data-management:audit-undo", input),
    createBackup: () => ipcRenderer.invoke("data-management:backup-create", {}),
    listRestoreTargets: () => ipcRenderer.invoke("data-management:restore-targets", {}),
    selectRestoreFile: () => ipcRenderer.invoke("data-management:restore-select", {}),
    inspectBackup: (input) => ipcRenderer.invoke("data-management:restore-inspect", input),
    restoreBackup: (input) => ipcRenderer.invoke("data-management:restore-activate", input),
    exportWorkspace: () => ipcRenderer.invoke("data-management:export-create", {})
  }
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
