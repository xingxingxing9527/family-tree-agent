import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { OpenWorkspaceContext } from "../application/facts/facts-gateway.js";
import { openQueryDatabase } from "../database/open-query-database.js";
import { isAllowedMediaMime } from "./media-service.js";

const assetId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const missing = (): Response => new Response("Not found", { status: 404 });
const inside = (root: string, candidate: string): boolean => { const path = relative(root, candidate); return !path.startsWith("..") && !isAbsolute(path); };

export async function resolveMediaAssetRequest(url: string, context: OpenWorkspaceContext & { mediaPath?: string }): Promise<Response> {
  const request = new URL(url);
  const id = request.hostname === "asset" ? request.pathname.slice(1) : "";
  if (!assetId.test(id) || request.pathname.includes("/", 1)) return missing();
  const mediaRoot = resolve(context.mediaPath ?? join(resolve(context.databasePath, ".."), "media"));
  const database = openQueryDatabase(context.databasePath);
  try {
    const asset = database.prepare("SELECT relative_path, mime_type FROM media_asset WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL").get(id, context.workspaceId) as { relative_path: string; mime_type: string } | undefined;
    if (!asset || !isAllowedMediaMime(asset.mime_type)) return missing();
    const stored = asset.relative_path.replaceAll("/", "\\");
    if (isAbsolute(stored) || !stored.startsWith("media\\")) return missing();
    const filePath = resolve(join(resolve(mediaRoot, ".."), stored));
    if (!inside(mediaRoot, filePath)) return missing();
    const bytes = await readFile(filePath);
    return new Response(bytes, { status: 200, headers: { "content-type": asset.mime_type, "cache-control": "no-store" } });
  } catch { return missing(); }
  finally { database.close(); }
}
