export interface RuntimeSeams {
  rendererUrl: string | null;
  importPath: string | null;
  mediaPath: string | null;
  backupPath: string | null;
  deterministicChat: boolean;
}

const value = (environment: Readonly<Record<string, string | undefined>>, name: string): string | null =>
  environment[name]?.trim() || null;

export function resolveRuntimeSeams(
  isPackaged: boolean,
  environment: Readonly<Record<string, string | undefined>>
): RuntimeSeams {
  if (isPackaged) {
    return {
      rendererUrl: null,
      importPath: null,
      mediaPath: null,
      backupPath: null,
      deterministicChat: false
    };
  }
  return {
    rendererUrl: value(environment, "ELECTRON_RENDERER_URL"),
    importPath: value(environment, "FAMILY_AGENT_E2E_IMPORT_PATH"),
    mediaPath: value(environment, "FAMILY_AGENT_E2E_MEDIA_PATH"),
    backupPath: value(environment, "FAMILY_AGENT_E2E_BACKUP_PATH"),
    deterministicChat: value(environment, "FAMILY_AGENT_E2E_CHAT") === "1"
  };
}
