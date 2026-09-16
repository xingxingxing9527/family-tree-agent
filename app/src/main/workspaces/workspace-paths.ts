import { isAbsolute, join, relative, resolve } from "node:path";
import type { WorkspacePaths } from "../../shared/contracts.js";

export function resolveWorkspacePaths(root: string, directory: string): WorkspacePaths | null {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, directory);
  const relativePath = relative(resolvedRoot, candidate);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  return {
    root: candidate,
    manifest: join(candidate, "workspace.json"),
    database: join(candidate, "genealogy.sqlite"),
    media: join(candidate, "media"),
    backups: join(candidate, "backups")
  };
}
