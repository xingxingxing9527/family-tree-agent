import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
import { ManagedMediaService } from "../../../src/main/media/media-service";
import { resolveMediaAssetRequest } from "../../../src/main/media/media-protocol";

const roots: string[] = [];
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(): Promise<{ root: string; mediaRoot: string; database: ReturnType<typeof openDatabase>; service: ManagedMediaService }> {
  const root = await mkdtemp(join(tmpdir(), "family-agent-media-"));
  roots.push(root);
  const mediaRoot = join(root, "media");
  const database = openDatabase(join(root, "genealogy.sqlite"));
  applyMigrations(database);
  return { root, mediaRoot, database, service: new ManagedMediaService(database, "workspace-1", mediaRoot) };
}

describe("managed media", () => {
  it("deduplicates image bytes while retaining separate allowed person links", async () => {
    const { root, mediaRoot, database, service } = await setup();
    const image = join(root, "portrait.jpg");
    await writeFile(image, jpeg);
    const now = new Date().toISOString();
    database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, 'workspace-1', ?, 'unknown', ?, ?)").run("p1", "甲", now, now);
    database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, 'workspace-1', ?, 'unknown', ?, ?)").run("p2", "乙", now, now);

    const first = await service.importMedia({ sourcePath: image, selectedSourcePath: image });
    const second = await service.importMedia({ sourcePath: image, selectedSourcePath: image });
    expect(first).toMatchObject({ ok: true, value: { mimeType: "image/jpeg", fileName: "portrait.jpg" } });
    expect(second).toMatchObject({ ok: true, value: { id: first.ok ? first.value.id : "" } });
    if (!first.ok) throw new Error("media import fixture failed");

    expect(await service.attachMedia({ mediaAssetId: first.value.id, personId: "p1", caption: "幼年照" })).toMatchObject({ ok: true });
    expect(await service.attachMedia({ mediaAssetId: first.value.id, personId: "p2", caption: "同一张照片" })).toMatchObject({ ok: true });
    expect(database.prepare("SELECT COUNT(*) FROM media_asset WHERE deleted_at IS NULL").pluck().get()).toBe(1);
    expect(database.prepare("SELECT COUNT(*) FROM media_person WHERE deleted_at IS NULL").pluck().get()).toBe(2);
    const stored = database.prepare("SELECT relative_path FROM media_asset").pluck().get() as string;
    expect(stored).toMatch(/^media[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}\.jpg$/);
    expect(stored).not.toContain(root);
    expect(await readFile(join(root, stored))).toEqual(jpeg);
    expect(basename(stored)).toContain(first.value.sha256);
    expect(mediaRoot).toContain("media");
    database.close();
  });

  it("rejects an unselected path and executable bytes renamed as an image", async () => {
    const { root, database, service } = await setup();
    const selected = join(root, "selected.jpg");
    const outside = join(root, "outside.jpg");
    const renamedExecutable = join(root, "danger.jpg");
    await writeFile(selected, jpeg);
    await writeFile(outside, jpeg);
    await writeFile(renamedExecutable, Buffer.from("MZ executable payload"));

    await expect(service.importMedia({ sourcePath: outside, selectedSourcePath: selected })).resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    await expect(service.importMedia({ sourcePath: renamedExecutable, selectedSourcePath: renamedExecutable })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    database.close();
  });

  it("serves only registered active assets through the app-media resolver", async () => {
    const { root, mediaRoot, database, service } = await setup();
    const image = join(root, "portrait.jpg");
    await writeFile(image, jpeg);
    const imported = await service.importMedia({ sourcePath: image, selectedSourcePath: image });
    if (!imported.ok) throw new Error("media import fixture failed");

    const response = await resolveMediaAssetRequest(`app-media://asset/${imported.value.id}`, { workspaceId: "workspace-1", databasePath: join(root, "genealogy.sqlite"), mediaPath: mediaRoot });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg);
    expect((await resolveMediaAssetRequest("app-media://asset/../../genealogy.sqlite", { workspaceId: "workspace-1", databasePath: join(root, "genealogy.sqlite"), mediaPath: mediaRoot })).status).toBe(404);
    database.close();
  });
});
