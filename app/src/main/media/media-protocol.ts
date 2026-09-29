import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { OpenWorkspaceContext } from "../application/facts/facts-gateway.js";
import type { WorkspaceMutationGate } from "../workspaces/workspace-mutation-gate.js";
import { openQueryDatabase } from "../database/open-query-database.js";
import { isAllowedMediaMime, type ManagedMediaMime } from "./media-service.js";

const assetId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const suffix: Record<ManagedMediaMime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg" };
const missing = (): Response => new Response("Not found", { status: 404 });
const under = (root: string, candidate: string): boolean => { const value = relative(root, candidate); return !value.startsWith("..") && !isAbsolute(value); };

export function resolveWorkspaceMediaRequest(
  url: string,
  workspaces: { getOpenWorkspaceContext(): OpenWorkspaceContext | null },
  operations: WorkspaceMutationGate,
  resolver: typeof resolveMediaAssetRequest = resolveMediaAssetRequest
): Promise<Response> {
  return operations.runOperation(async () => {
    const context = workspaces.getOpenWorkspaceContext();
    return context ? resolver(url, context) : missing();
  });
}

export async function resolveMediaAssetRequest(url: string, context: OpenWorkspaceContext & { mediaPath?: string }): Promise<Response> {
  const request = new URL(url); const id = request.hostname === "asset" ? request.pathname.slice(1) : "";
  if (!assetId.test(id) || request.pathname.includes("/", 1)) return missing();
  const database = openQueryDatabase(context.databasePath);
  try {
    const asset = database.prepare("SELECT sha256, mime_type, byte_size, relative_path FROM media_asset WHERE id=? AND workspace_id=? AND deleted_at IS NULL").get(id, context.workspaceId) as { sha256: string; mime_type: string; byte_size: number; relative_path: string } | undefined;
    if (!asset || !isAllowedMediaMime(asset.mime_type) || !/^[0-9a-f]{64}$/i.test(asset.sha256)) return missing();
    const mediaRoot = await realpath(resolve(context.mediaPath ?? join(resolve(context.databasePath, ".."), "media")));
    const expectedRelative = join("media", asset.sha256.slice(0, 2), `${asset.sha256}.${suffix[asset.mime_type]}`);
    if (asset.relative_path.replaceAll("/", "\\") !== expectedRelative) return missing();
    const target = join(mediaRoot, asset.sha256.slice(0, 2), `${asset.sha256}.${suffix[asset.mime_type]}`); const actual = await realpath(target); if (!under(mediaRoot, actual)) return missing();
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const data = await handle.readFile(); if (data.length !== asset.byte_size || createHash("sha256").update(data).digest("hex") !== asset.sha256) return missing(); return new Response(data, { status: 200, headers: { "content-type": asset.mime_type, "cache-control": "no-store" } }); } finally { await handle.close(); }
  } catch { return missing(); } finally { database.close(); }
}
