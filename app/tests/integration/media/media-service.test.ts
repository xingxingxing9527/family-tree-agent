import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
import { ManagedMediaService, openSelectedMediaFile } from "../../../src/main/media/media-service";
import { acquireHashLease } from "../../../src/main/media/media-lease.mjs";
import { resolveMediaAssetRequest } from "../../../src/main/media/media-protocol";

const roots: string[] = [];
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const box = (type: string, payload: Buffer): Buffer => { const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4); return Buffer.concat([header, payload]); };
const box64 = (type: string, payload: Buffer): Buffer => { const header = Buffer.alloc(16); header.writeUInt32BE(1); header.write(type, 4); header.writeBigUInt64BE(BigInt(payload.length + 16), 8); return Buffer.concat([header, payload]); };
const boxToEof = (type: string, payload: Buffer): Buffer => { const header = Buffer.alloc(8); header.writeUInt32BE(0); header.write(type, 4); return Buffer.concat([header, payload]); };
const wav = (): Buffer => { const fmt = Buffer.alloc(16); fmt.writeUInt16LE(1); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(8000, 4); fmt.writeUInt32LE(8000, 8); fmt.writeUInt16LE(1, 12); fmt.writeUInt16LE(8, 14); const riffChunk = (type: string, payload: Buffer): Buffer => { const header = Buffer.alloc(8); header.write(type); header.writeUInt32LE(payload.length, 4); return Buffer.concat([header, payload, payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]); }; const chunks = Buffer.concat([riffChunk("fmt ", fmt), riffChunk("data", Buffer.from([1]))]); const head = Buffer.alloc(12); head.write("RIFF"); head.writeUInt32LE(chunks.length + 4, 4); head.write("WAVE", 8); return Buffer.concat([head, chunks]); };
const mp3Frame = (header = Buffer.from([0xff, 0xfb, 0x90, 0x64])): Buffer => Buffer.concat([header, Buffer.alloc(417 - header.length, 0x55)]);
const mp3 = (withId3 = false): Buffer => { const frames = Buffer.concat([mp3Frame(), mp3Frame()]); if (!withId3) return frames; const tag = Buffer.from("abcde"); const header = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, tag.length]); return Buffer.concat([header, tag, frames]); };
const oggPage = (input: { headerType: number; serial?: number; sequence: number; segments: number[]; body: Buffer }): Buffer => { const head = Buffer.alloc(27); head.write("OggS"); head[4] = 0; head[5] = input.headerType; head.writeUInt32LE(input.serial ?? 1, 14); head.writeUInt32LE(input.sequence, 18); head[26] = input.segments.length; return Buffer.concat([head, Buffer.from(input.segments), input.body]); };
const oggPacket = (packet: Buffer, serial = 1): Buffer => oggPage({ headerType: 2, serial, sequence: 0, segments: [packet.length], body: packet });
const ogg = (): Buffer => oggPacket(Buffer.from("OpusHead\0\0"));
const continuedOgg = (codec: "opus" | "vorbis"): Buffer => { const prefix = codec === "opus" ? Buffer.from("OpusHead") : Buffer.from("\x01vorbis"); const packet = Buffer.concat([prefix, Buffer.alloc(260 - prefix.length, 7)]); return Buffer.concat([oggPage({ headerType: 2, sequence: 0, segments: [255], body: packet.subarray(0, 255) }), oggPage({ headerType: 1, sequence: 1, segments: [5], body: packet.subarray(255) }), oggPage({ headerType: 0, sequence: 2, segments: [3], body: Buffer.from("abc") })]); };
const hdlr = (kind: "soun" | "vide"): Buffer => box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from(kind)]));
const track = (kind: "soun" | "vide"): Buffer => box("trak", box("mdia", hdlr(kind)));
const mp4 = (video = false): Buffer => Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("moov", track(video ? "vide" : "soun"))]);
const mp4Mixed = (): Buffer => Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("moov", Buffer.concat([track("soun"), track("vide")]))]);
const mp4MoovAtEnd = (): Buffer => Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("free", Buffer.alloc(100, 1)), mp4().subarray(20)]);
const mp4With64BitBoxes = (): Buffer => Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box64("moov", box64("trak", box64("mdia", hdlr("soun"))))]);
const mp4WithEofMoov = (): Buffer => Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), boxToEof("moov", track("soun"))]);
const invalidMediaFixtures = (): Array<[string, Buffer]> => {
  const pendingOpus = Buffer.concat([Buffer.from("OpusHead"), Buffer.alloc(247)]);
  const malformedHandler = Buffer.concat([box("hdlr", Buffer.alloc(8)), Buffer.from("soun")]);
  const noHandlerMoov = box("moov", box("trak", box("mdia", box("free", Buffer.alloc(4)))));
  const mixedOgg = Buffer.concat([ogg(), oggPacket(Buffer.from("\x80theora"), 2)]);
  const tooManyOggStreams = Buffer.concat(Array.from({ length: 17 }, (_, serial) => oggPacket(Buffer.from("OpusHead\0\0"), serial + 1)));
  const oversizedBox = Buffer.alloc(16); oversizedBox.writeUInt32BE(1); oversizedBox.write("moov", 4); oversizedBox.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
  const unpaddedWav = Buffer.from(wav().subarray(0, -1)); unpaddedWav.writeUInt32LE(unpaddedWav.length - 8, 4);
  return [
    ["video.mp4", mp4(true)],
    ["mixed.mp4", mp4Mixed()],
    ["top-level-handler.mp4", Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), hdlr("soun"), noHandlerMoov])],
    ["wrong-handler-ancestry.mp4", Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("moov", box("trak", hdlr("soun")))])],
    ["out-of-box-handler.mp4", Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), hdlr("soun"), box("moov", box("trak", box("mdia", malformedHandler)))])],
    ["trailing-garbage.mp4", Buffer.concat([mp4(), Buffer.from([1, 2, 3, 4])])],
    ["oversized-box.mp4", Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), oversizedBox])],
    ["bad-box.mp4", Buffer.from("\0\0\0\x01moov")],
    ["id3.mp3", Buffer.from("ID3\x04\0\0\0\0\0\0")],
    ["invalid-id3-size.mp3", Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0x80, 0, 0, 0])],
    ["truncated-frame.mp3", mp3Frame().subarray(0, 200)],
    ["one-frame.mp3", mp3Frame()],
    ["incompatible-second-frame.mp3", Buffer.concat([mp3Frame(), mp3Frame(Buffer.from([0xff, 0xf3, 0x80, 0x64]))])],
    ["sync.mp3", Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(900, 3)])],
    ["fake.wav", Buffer.from("RIFFxxxxWAVEfmt data")],
    ["unpadded.wav", unpaddedWav],
    ["theora.ogg", oggPacket(Buffer.from("\x80theora"))],
    ["mixed-video.ogg", mixedOgg],
    ["unknown.ogg", oggPacket(Buffer.from("unknown"))],
    ["too-many-streams.ogg", tooManyOggStreams],
    ["broken-continuation.ogg", Buffer.concat([oggPage({ headerType: 2, sequence: 0, segments: [255], body: pendingOpus }), oggPage({ headerType: 0, sequence: 1, segments: [1], body: Buffer.from([0]) })])],
    ["broken-sequence.ogg", Buffer.concat([ogg(), oggPage({ headerType: 0, sequence: 2, segments: [1], body: Buffer.from([0]) })])],
    ["broken-serial.ogg", Buffer.concat([ogg(), oggPage({ headerType: 0, serial: 2, sequence: 1, segments: [1], body: Buffer.from([0]) })])],
    ["truncated.ogg", Buffer.from("OggS\0\x02" + "\0".repeat(20) + "\x01\xff")],
    ["danger.jpg", Buffer.from("MZ executable")]
  ];
};

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

  it("parses audio when the selected FileHandle performs partial positional reads", async () => {
    const { root, database, service } = await setup();
    const source = join(root, "partial-read.mp3");
    await writeFile(source, mp3());
    const selection = await openSelectedMediaFile(source, "workspace-1");
    const handle = selection.handle;
    selection.handle = {
      read: (buffer: Buffer, offset: number, length: number, position: number) => handle.read(buffer, offset, Math.min(length, 3), position),
      stat: () => handle.stat(),
      close: () => handle.close()
    } as FileHandle;
    try {
      await expect(service.importMedia({ selection })).resolves.toMatchObject({ ok: true, value: { mimeType: "audio/mpeg" } });
    } finally { database.close(); }
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

  it("aborts without publishing or registering when its hash lease ownership is lost", async () => {
    const { root, mediaRoot, database } = await setup();
    const bytes = Buffer.concat([jpeg, Buffer.alloc(100_000, 9)]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const image = join(root, "lost-lease.jpg");
    await writeFile(image, bytes);
    let copyStarted!: () => void;
    let resumeCopy!: () => void;
    const started = new Promise<void>((resolve) => { copyStarted = resolve; });
    const resume = new Promise<void>((resolve) => { resumeCopy = resolve; });
    let paused = false;
    const service = new ManagedMediaService(database, "workspace-1", mediaRoot, {
      leaseOptions: { maxWaitMs: 1_000, staleMs: 80, heartbeatMs: 10_000, retryMinMs: 5, retryMaxMs: 20 },
      afterCopyChunk: async () => {
        if (paused) return;
        paused = true;
        copyStarted();
        await resume;
      }
    });
    const importing = service.importMedia({ selection: await openSelectedMediaFile(image, "workspace-1") });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const replacement = await acquireHashLease(join(mediaRoot, digest.slice(0, 2)), digest, { maxWaitMs: 1_000, staleMs: 80, heartbeatMs: 20, retryMinMs: 5, retryMaxMs: 20 });
    resumeCopy();

    try {
      await expect(importing).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL" } });
      expect(database.prepare("SELECT COUNT(*) FROM media_asset").pluck().get()).toBe(0);
      expect(database.prepare("SELECT COUNT(*) FROM audit_log WHERE entity_type='media_asset'").pluck().get()).toBe(0);
      await expect(readFile(join(mediaRoot, digest.slice(0, 2), `${digest}.jpg`))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      expect(await replacement.release()).toBe(true);
      database.close();
    }
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
    ["photo.jpg", jpeg, "image/jpeg", "jpg"], ["photo.jpeg", jpeg, "image/jpeg", "jpg"], ["photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", "png"], ["photo.webp", Buffer.from("RIFFxxxxWEBP"), "image/webp", "webp"], ["sound.mp3", mp3(), "audio/mpeg", "mp3"], ["tagged.mp3", mp3(true), "audio/mpeg", "mp3"], ["sound.wav", wav(), "audio/wav", "wav"], ["opus.ogg", ogg(), "audio/ogg", "ogg"], ["vorbis.ogg", oggPacket(Buffer.from("\x01vorbis\0")), "audio/ogg", "ogg"], ["continued-opus.ogg", continuedOgg("opus"), "audio/ogg", "ogg"], ["continued-vorbis.ogg", continuedOgg("vorbis"), "audio/ogg", "ogg"], ["sound.m4a", mp4(), "audio/mp4", "m4a"], ["sound.mp4", mp4(), "audio/mp4", "m4a"], ["moov-end.mp4", mp4MoovAtEnd(), "audio/mp4", "m4a"], ["large-box.mp4", mp4With64BitBoxes(), "audio/mp4", "m4a"], ["eof-moov.mp4", mp4WithEofMoov(), "audio/mp4", "m4a"]
  ])("imports validated %s", async (name, content, mimeType, storedExtension) => {
    const { root, database, service } = await setup();
    try { const source = join(root, name); await writeFile(source, content); const result = await service.importMedia({ selection: await openSelectedMediaFile(source, "workspace-1") }); expect(result).toMatchObject({ ok: true, value: { mimeType } }); if (result.ok) expect(result.value.url).toContain(result.value.id); expect(database.prepare("SELECT relative_path FROM media_asset").pluck().get()).toMatch(new RegExp(`\\.${storedExtension}$`)); }
    finally { database.close(); }
  });

  it.each(invalidMediaFixtures())("rejects malformed %s without an asset, audit, or final object", async (name, content) => {
    const { root, mediaRoot, database, service } = await setup();
    const storedExtension = (name: string): string => name.endsWith(".mp4") || name.endsWith(".m4a") ? "m4a" : name.slice(name.lastIndexOf(".") + 1);
    try {
      const source = join(root, name);
      await writeFile(source, content);
      const result = await service.importMedia({ selection: await openSelectedMediaFile(source, "workspace-1") });
      expect(result, name).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      expect(database.prepare("SELECT COUNT(*) FROM media_asset").pluck().get()).toBe(0);
      expect(database.prepare("SELECT COUNT(*) FROM audit_log WHERE entity_type='media_asset'").pluck().get()).toBe(0);
      const digest = createHash("sha256").update(content).digest("hex");
      await expect(readFile(join(mediaRoot, digest.slice(0, 2), `${digest}.${storedExtension(name)}`))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { database.close(); }
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
