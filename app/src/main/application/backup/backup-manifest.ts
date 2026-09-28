import { z } from "zod";
import { workspaceIdSchema, workspaceNameSchema } from "../../workspaces/workspace-schema.js";

const count = z.number().int().min(0).max(1_000_000_000);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);

export function canonicalArchivePath(value: string): string | null {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.includes("\0")) return null;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

export const backupFileSchema = z.object({
  path: z.string().min(1).max(1_024).refine((value) => canonicalArchivePath(value) === value, "Backup path must be canonical POSIX relative path"),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256
}).strict();

export const backupManifestSchema = z.object({
  formatVersion: z.literal(1),
  workspaceId: workspaceIdSchema,
  workspaceName: workspaceNameSchema,
  schemaVersion: z.number().int().min(1).max(1_000_000),
  createdAt: z.string().datetime(),
  files: z.array(backupFileSchema).min(2).max(100_000),
  counts: z.object({
    people: count,
    parentChild: count,
    marriages: count,
    wikiEntries: count,
    auditRows: count,
    mediaAssets: count
  }).strict()
}).strict().superRefine((manifest, context) => {
  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const [index, file] of manifest.files.entries()) {
    if (file.path === "backup-manifest.json") context.addIssue({ code: "custom", path: ["files", index, "path"], message: "Manifest cannot hash itself" });
    const lower = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (exact.has(file.path) || folded.has(lower)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "Backup file paths must be unique" });
    exact.add(file.path);
    folded.add(lower);
  }
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type BackupFile = z.infer<typeof backupFileSchema>;
