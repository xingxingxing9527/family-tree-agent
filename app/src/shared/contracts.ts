export type AppErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PATH_DENIED"
  | "MODEL_UNAVAILABLE"
  | "INTERNAL";

export type AppResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: AppErrorCode; message: string; details?: unknown } };

export interface WorkspaceSummary {
  id: string;
  name: string;
  directory: string;
  originPersonId: string | null;
  lastOpenedAt: string | null;
  schemaVersion: number;
}

export interface WorkspacePaths {
  root: string;
  manifest: string;
  database: string;
  media: string;
  backups: string;
}

export interface DesktopApi {
  app: { getVersion(): Promise<string> };
  workspaces: {
    list(): Promise<AppResult<WorkspaceSummary[]>>;
    create(input: { name: string }): Promise<AppResult<WorkspaceSummary>>;
    open(input: { id: string }): Promise<AppResult<WorkspaceSummary>>;
    close(): Promise<AppResult<null>>;
  };
}
