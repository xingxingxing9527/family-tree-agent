import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
import { ManagedMediaService, openSelectedMediaFile } from "../../../src/main/media/media-service";
import { resolveMediaAssetRequest } from "../../../src/main/media/media-protocol";

const roots: string[] = [];
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const box = (type: string, payload: Buffer): Buffer => { const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4); return Buffer.concat([header, payload]); };
const wav = (): Buffer => { const fmt = Buffer.alloc(16); fmt.writeUInt16LE(1); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(8000, 4); fmt.writeUInt32LE(8000, 8); fmt.writeUInt16LE(1, 12); fmt.writeUInt16LE(8, 14); const riffChunk = (type: string, payload: Buffer): Buffer => { const header = Buffer.alloc(8); header.write(type); header.writeUInt32LE(payload.length, 4); return Buffer.concat([header, payload]); }; const chunks = Buffer.concat([riffChunk("fmt ", fmt), riffChunk("data", Buffer.from([1]))]); const head = Buffer.alloc(12); head.write("RIFF"); head.writeUInt32LE(chunks.length + 4, 4); head.write("WAVE", 8); return Buffer.concat([head, chunks]); };
const ogg = (): Buffer => { const packet = Buffer.from("OpusHead\0\0"); const head = Buffer.alloc(27); head.write("OggS"); head[4] = 0; head[5] = 2; head[26] = 1; return Buffer.concat([head, Buffer.from([packet.length]), packet]); };
const mp4 = (video = false): Buffer => { const hdlr = Buffer.concat([Buffer.alloc(8), Buffer.from(video ? "vide" : "soun")]); return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("moov", box("trak", box("mdia", box("hdlr", hdlr))))]); };
const mp4Mixed = (): Buffer => Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("moov", Buffer.concat([box("trak", box("mdia", box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from("soun")])))), box("trak", box("mdia", box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from("vide")]))))]))]);
const mp4MoovAtEnd = (): Buffer => Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("free", Buffer.alloc(100, 1)), mp4().subarray(20)]);
const oggPacket = (packet: Buffer): Buffer => { const head = Buffer.alloc(27); head.write("OggS"); head[4] = 0; head[5] = 2; head[26] = 1; return Buffer.concat([head, Buffer.from([packet.length]), packet]); };

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
  it("imports from the selected open handle after the selected pathname is replaced", async () => {
    const { root, database, service } = await setup();
    const selected = join(root, "selected.jpg");
    await writeFile(selected, jpeg);
    const capability = await openSelectedMediaFile(selected, "workspace-1");
    await writeFile(selected, Buffer.from("MZ replacement"));
    const imported = await service.importMedia({ selection: capability });
    expect(imported).toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    await expect(service.importMedia({ selection: capability })).resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    database.close();
  });
  it("deduplicates image bytes while retaining separate allowed person links", async () => {
    const { root, mediaRoot, database, service } = await setup();
    const image = join(root, "portrait.jpg");
    await writeFile(image, jpeg);
    const now = new Date().toISOString();
    database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, 'workspace-1', ?, 'unknown', ?, ?)").run("p1", "甲", now, now);
    database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, 'workspace-1', ?, 'unknown', ?, ?)").run("p2", "乙", now, now);

    const first = await service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") });
    const second = await service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") });
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

  it("serializes concurrent imports of the same selected bytes", async () => {
    const { root, database, service } = await setup();
    const image = join(root, "concurrent.jpg"); await writeFile(image, jpeg);
    const [left, right] = await Promise.all([
      service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") }),
      service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") })
    ]);
    expect(left.ok && right.ok).toBe(true);
    expect(database.prepare("SELECT COUNT(*) FROM media_asset WHERE deleted_at IS NULL").pluck().get()).toBe(1);
    database.close();
  });

  it("persists every byte when the output adapter performs partial writes", async () => {
    const { root, mediaRoot, database } = await setup();
    const image = join(root, "partial.jpg"); const bytes = Buffer.concat([jpeg, Buffer.alloc(100_000, 7)]); await writeFile(image, bytes);
    const service = new ManagedMediaService(database, "workspace-1", mediaRoot, { writeChunk: async (handle, chunk) => (await handle.write(chunk.subarray(0, Math.min(3, chunk.length)))).bytesWritten });
    const imported = await service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") });
    expect(imported.ok).toBe(true); if (!imported.ok) throw new Error("fixture failed");
    expect(await readFile(join(mediaRoot, imported.value.sha256.slice(0, 2), `${imported.value.sha256}.jpg`))).toEqual(bytes);
    database.close();
  });

  it("does not publish a target or row when the selected file mutates during the final copy", async () => {
    const { root, mediaRoot, database } = await setup(); const image = join(root, "mutated.jpg"); await writeFile(image, Buffer.concat([jpeg, Buffer.alloc(100_000, 1)])); let mutated = false;
    const service = new ManagedMediaService(database, "workspace-1", mediaRoot, { afterCopyChunk: async () => { if (!mutated) { mutated = true; await writeFile(image, Buffer.from("MZ changed")); } } });
    await expect(service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") })).resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    expect(database.prepare("SELECT COUNT(*) FROM media_asset").pluck().get()).toBe(0);
    const directories = await readdir(mediaRoot).catch(() => []); expect(await Promise.all(directories.map((directory) => readdir(join(mediaRoot, directory))))).toEqual(directories.map(() => []));
    database.close();
  });

  it("removes only its newly published object when persistence fails", async () => {
    const { root, mediaRoot, database } = await setup(); const image = join(root, "failed.jpg"); await writeFile(image, jpeg);
    const service = new ManagedMediaService(database, "workspace-1", mediaRoot, { beforePersist: () => { throw new Error("injected"); } });
    await expect(service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") })).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(database.prepare("SELECT COUNT(*) FROM media_asset").pluck().get()).toBe(0);
    const directories = await readdir(mediaRoot).catch(() => []); expect(await Promise.all(directories.map((directory) => readdir(join(mediaRoot, directory))))).toEqual(directories.map(() => []));
    database.close();
  });

  it("coordinates two independent database connections for one physical object and audit", async () => {
    const { root, mediaRoot, database, service } = await setup(); const image = join(root, "two-process.jpg"); await writeFile(image, jpeg);
    const other = openDatabase(join(root, "genealogy.sqlite")); const second = new ManagedMediaService(other, "workspace-1", mediaRoot);
    const [first, next] = await Promise.all([service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") }), second.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") })]);
    expect(first.ok && next.ok).toBe(true); if (!first.ok || !next.ok) throw new Error("fixtures failed"); expect(first.value.id).toBe(next.value.id);
    expect(database.prepare("SELECT COUNT(*) FROM media_asset WHERE deleted_at IS NULL").pluck().get()).toBe(1); expect(database.prepare("SELECT COUNT(*) FROM audit_log WHERE entity_type='media_asset' AND action='create'").pluck().get()).toBe(1);
    const entries = await readdir(join(mediaRoot, first.value.sha256.slice(0, 2))); expect(entries).toEqual([`${first.value.sha256}.jpg`]); other.close(); database.close();
  });

  it("registers a verified pre-existing object without overwriting it", async () => {
    const { root, mediaRoot, database, service } = await setup(); const image = join(root, "preexisting.jpg"); await writeFile(image, jpeg); const digest = (await import("node:crypto")).createHash("sha256").update(jpeg).digest("hex"); const dir = join(mediaRoot, digest.slice(0, 2)); await mkdir(dir, { recursive: true }); const target = join(dir, `${digest}.jpg`); await writeFile(target, jpeg);
    const imported = await service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") }); expect(imported.ok).toBe(true); expect(await readFile(target)).toEqual(jpeg); expect(database.prepare("SELECT COUNT(*) FROM media_asset").pluck().get()).toBe(1); database.close();
  });

  it("rejects a corrupt pre-existing object without overwriting or registering it", async () => {
    const { root, mediaRoot, database, service } = await setup(); const image = join(root, "corrupt.jpg"); await writeFile(image, jpeg); const digest = (await import("node:crypto")).createHash("sha256").update(jpeg).digest("hex"); const dir = join(mediaRoot, digest.slice(0, 2)); await mkdir(dir, { recursive: true }); const target = join(dir, `${digest}.jpg`); const corrupt = Buffer.from("corrupt"); await writeFile(target, corrupt);
    await expect(service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") })).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } }); expect(await readFile(target)).toEqual(corrupt); expect(database.prepare("SELECT COUNT(*) FROM media_asset").pluck().get()).toBe(0); expect(database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()).toBe(0); database.close();
  });

  it("keeps an existing owner and target when another import has a failing persistence hook", async () => {
    const { root, mediaRoot, database, service } = await setup(); const image = join(root, "owned.jpg"); await writeFile(image, jpeg); const owner = await service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") }); if (!owner.ok) throw new Error("owner failed"); const guarded = new ManagedMediaService(database, "workspace-1", mediaRoot, { beforePersist: () => { throw new Error("must not persist duplicate"); } }); const retry = await guarded.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") }); expect(retry).toMatchObject({ ok: true, value: { id: owner.value.id } }); expect(database.prepare("SELECT COUNT(*) FROM audit_log WHERE entity_type='media_asset' AND action='create'").pluck().get()).toBe(1); expect(await readFile(join(mediaRoot, owner.value.sha256.slice(0, 2), `${owner.value.sha256}.jpg`))).toEqual(jpeg); database.close();
  });

  it("rejects an unselected path and executable bytes renamed as an image", async () => {
    const { root, database, service } = await setup();
    const renamedExecutable = join(root, "danger.jpg");
    await writeFile(renamedExecutable, Buffer.from("MZ executable payload"));

    await expect(service.importMedia({ selection: await openSelectedMediaFile(renamedExecutable, "workspace-1") })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    database.close();
  });

  it.each([
    ["photo.jpg", jpeg, "image/jpeg", "jpg"], ["photo.jpeg", jpeg, "image/jpeg", "jpg"], ["photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", "png"], ["photo.webp", Buffer.from("RIFFxxxxWEBP"), "image/webp", "webp"], ["sound.mp3", Buffer.from([0xff, 0xfb, 0x90, 0x64]), "audio/mpeg", "mp3"], ["sound.wav", wav(), "audio/wav", "wav"], ["opus.ogg", ogg(), "audio/ogg", "ogg"], ["vorbis.ogg", oggPacket(Buffer.from("\x01vorbis\0")), "audio/ogg", "ogg"], ["sound.m4a", mp4(), "audio/mp4", "m4a"], ["sound.mp4", mp4(), "audio/mp4", "m4a"], ["moov-end.mp4", mp4MoovAtEnd(), "audio/mp4", "m4a"]
  ])("imports validated %s", async (name, content, mimeType, storedExtension) => {
    const { root, database, service } = await setup(); const source = join(root, name); await writeFile(source, content); const result = await service.importMedia({ selection: await openSelectedMediaFile(source, "workspace-1") }); expect(result).toMatchObject({ ok: true, value: { mimeType } }); if (result.ok) expect(result.value.url).toContain(result.value.id); expect(database.prepare("SELECT relative_path FROM media_asset").pluck().get()).toMatch(new RegExp(`\\.${storedExtension}$`)); database.close();
  });

  it("rejects video/mixed/malformed media containers without publishing", async () => {
    const { root, database, service } = await setup(); const fixtures: Array<[string, Buffer]> = [["video.mp4", mp4(true)], ["mixed.mp4", mp4Mixed()], ["bad-box.mp4", Buffer.from("\0\0\0\x01moov")], ["id3.mp3", Buffer.from("ID3\x04\0\0\0\0\0\0")], ["sync.mp3", Buffer.from([0xff, 0xe0, 0, 0])], ["fake.wav", Buffer.from("RIFFxxxxWAVEfmt data")], ["theora.ogg", oggPacket(Buffer.from("\x80theora"))], ["unknown.ogg", oggPacket(Buffer.from("unknown"))], ["truncated.ogg", Buffer.from("OggS\0\x02" + "\0".repeat(20) + "\x01\xff")], ["danger.jpg", Buffer.from("MZ executable")]];
    for (const [name, content] of fixtures) { const source = join(root, name); await writeFile(source, content); await expect(service.importMedia({ selection: await openSelectedMediaFile(source, "workspace-1") })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } }); } database.close();
  });

  it("serves only registered active assets through the app-media resolver", async () => {
    const { root, mediaRoot, database, service } = await setup();
    const image = join(root, "portrait.jpg");
    await writeFile(image, jpeg);
    const imported = await service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") });
    if (!imported.ok) throw new Error("media import fixture failed");

    const response = await resolveMediaAssetRequest(`app-media://asset/${imported.value.id}`, { workspaceId: "workspace-1", databasePath: join(root, "genealogy.sqlite"), mediaPath: mediaRoot });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg);
    expect((await resolveMediaAssetRequest("app-media://asset/../../genealogy.sqlite", { workspaceId: "workspace-1", databasePath: join(root, "genealogy.sqlite"), mediaPath: mediaRoot })).status).toBe(404);
    database.close();
  });
});
