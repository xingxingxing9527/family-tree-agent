import { z } from "zod";
import type { WorkspaceSummary } from "../../shared/contracts.js";

export const workspaceIdSchema = z.string().uuid();
export const workspaceNameSchema = z.string().min(1).max(200).refine((value) => value.trim() === value && !/[\0\r\n]/u.test(value), "Workspace name is invalid");
export const workspaceDirectorySchema = z.string().uuid();

export const workspaceSummarySchema: z.ZodType<WorkspaceSummary> = z.object({
  id: workspaceIdSchema,
  name: workspaceNameSchema,
  directory: workspaceDirectorySchema,
  originPersonId: z.string().uuid().nullable(),
  lastOpenedAt: z.string().datetime().nullable(),
  schemaVersion: z.number().int().min(1).max(1_000_000)
}).strict();

export const workspaceIndexSchema = z.object({
  workspaces: z.array(workspaceSummarySchema).max(10_000)
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const directories = new Set<string>();
  value.workspaces.forEach((workspace, index) => {
    const directory = workspace.directory.toLocaleLowerCase("en-US");
    if (ids.has(workspace.id)) context.addIssue({ code: "custom", path: ["workspaces", index, "id"], message: "Workspace ids must be unique" });
    if (directories.has(directory)) context.addIssue({ code: "custom", path: ["workspaces", index, "directory"], message: "Workspace directories must be unique" });
    ids.add(workspace.id);
    directories.add(directory);
  });
});

export type StrictWorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
