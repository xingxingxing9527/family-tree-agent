import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebServer, type WebServer } from "../../../src/server/create-web-server.js";
import { openDatabase } from "../../../src/main/database/open-database.js";
import { DeterministicE2EAdapter } from "../../../src/main/llm/deterministic-e2e-adapter.js";
import { DownloadStore } from "../../../src/server/http/download-store.js";
import { UploadStore } from "../../../src/server/http/upload-store.js";
import { createFamilyAgentService, type FamilyAgentService } from "../../../src/server/runtime/family-agent-service.js";
import { createFamilyRuntime, type FamilyRuntime } from "../../../src/server/runtime/family-runtime.js";

describe("browser file routes", () => {
  let dataRoot: string;
  let now: number;
  let runtime: FamilyRuntime;
  let uploads: UploadStore;
  let downloads: DownloadStore;
  let service: FamilyAgentService;
  let server: WebServer;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "family-agent-files-"));
    now = Date.parse("2026-10-01T00:00:00.000Z");
    runtime = await createFamilyRuntime({ dataRoot });
    const created = await runtime.createFamily("王氏家谱");
    if (!created.ok) throw new Error(created.error.message);
    uploads = new UploadStore({ root: join(dataRoot, "uploads"), now: () => now });
    downloads = new DownloadStore({ now: () => now });
    service = createFamilyAgentService({ runtime, uploads, downloads, initialModelKey: "test-only", modelFactory: () => new DeterministicE2EAdapter() });
    server = createWebServer({ runtime, service, fileTransfers: { uploads, downloads } });
  });

  afterEach(async () => {
    await server.close();
    await uploads.dispose();
    downloads.dispose();
    await runtime.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("rejects a jpeg extension with executable bytes", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/files/media",
      headers: { "content-type": "application/octet-stream", "x-file-name": "portrait.jpg" },
      payload: Buffer.from("MZ executable")
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("rejects traversal, expired downloads and token purpose confusion", async () => {
    const traversal = await server.inject({ method: "GET", url: "/api/media/%2e%2e%2f%2e%2e%2ffamily.sqlite" });
    expect(traversal.statusCode).toBe(404);

    const descriptor = downloads.createDownload({ fileName: "family.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: Buffer.from("test") });
    now += 15 * 60_000 + 1;
    const expired = await server.inject({ method: "GET", url: descriptor.downloadUrl });
    expect(expired.statusCode).toBe(410);

    const uploaded = await uploads.uploadFile("import", { fileName: "people.csv", bytes: Buffer.from("name\n王强\n") });
    const misuse = await uploads.claim(uploaded.fileToken, "media");
    expect(misuse).toMatchObject({ ok: false, reason: "purpose" });
  });

  it("serves a download once without revealing a server path", async () => {
    const descriptor = downloads.createDownload({ fileName: "王氏家谱.csv", mimeType: "text/csv; charset=utf-8", bytes: Buffer.from("姓名\n王强\n") });
    expect(JSON.stringify(descriptor)).not.toMatch(/[A-Z]:\\|\/tmp\/|path/u);

    const first = await server.inject({ method: "GET", url: descriptor.downloadUrl });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-disposition"]).toContain("attachment");
    const second = await server.inject({ method: "GET", url: descriptor.downloadUrl });
    expect(second.statusCode).toBe(404);
  });

  it("passes an uploaded CSV into the existing import preview pipeline", async () => {
    const columns = "person_external_id,name,gender,birth_calendar,birth_year,birth_month,birth_day,birth_leap_month,notes";
    const upload = await server.inject({
      method: "POST",
      url: "/api/files/import",
      headers: { "content-type": "application/octet-stream", "x-file-name": "people.csv" },
      payload: Buffer.from(`${columns}\nP1,王强,unknown,,,,,,\n`, "utf8")
    });
    expect(upload.statusCode).toBe(200);
    const fileToken = upload.json().value.fileToken as string;

    const preview = await server.inject({
      method: "POST",
      url: "/api/rpc/imports/parse",
      payload: { input: { fileToken, sourceKey: "web-upload", csvEntityType: "People" } }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ ok: true, value: { fileName: "people.csv", summary: { creates: 1 } } });
  });

  it("creates a verified backup as an opaque one-time download", async () => {
    const origin = await server.inject({
      method: "POST",
      url: "/api/rpc/people/save",
      payload: {
        input: {
          draft: {
            displayName: "王强",
            aliases: [],
            gender: "unknown",
            birth: null,
            death: null,
            notes: null,
            sourceDescription: "网页端备份测试"
          },
          confirmWarnings: true
        }
      }
    });
    expect(origin.json()).toMatchObject({ ok: true });

    const created = await server.inject({ method: "POST", url: "/api/rpc/dataManagement/createBackup", payload: { input: null } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ ok: true, value: { saved: true, verified: true, download: { fileName: expect.stringMatching(/\.zip$/u) } } });
    const url = created.json().value.download.downloadUrl as string;
    expect(url).toMatch(/^\/api\/downloads\/[0-9a-f-]{36}$/u);
    const downloaded = await server.inject({ method: "GET", url });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload.subarray(0, 2).toString("ascii")).toBe("PK");
  });

  it("downloads distinct current-family and blank Chinese workbooks", async () => {
    const saved = await server.inject({
      method: "POST",
      url: "/api/rpc/people/save",
      payload: { input: { draft: { displayName: "王强", aliases: [], gender: "unknown", birth: null, death: null, notes: null, sourceDescription: "工作簿导出测试" }, confirmWarnings: true } }
    });
    expect(saved.json()).toMatchObject({ ok: true });

    const current = await server.inject({ method: "POST", url: "/api/rpc/imports/exportCurrentWorkbook", payload: { input: null } });
    const blank = await server.inject({ method: "POST", url: "/api/rpc/imports/exportBlankWorkbook", payload: { input: null } });
    expect(current.json()).toMatchObject({ ok: true, value: { saved: true, download: { fileName: expect.stringContaining("当前家谱") } } });
    expect(blank.json()).toMatchObject({ ok: true, value: { saved: true, download: { fileName: expect.stringContaining("空白") } } });

    const currentBytes = await server.inject({ method: "GET", url: current.json().value.download.downloadUrl as string });
    const blankBytes = await server.inject({ method: "GET", url: blank.json().value.download.downloadUrl as string });
    const currentWorkbook = new ExcelJS.Workbook();
    const blankWorkbook = new ExcelJS.Workbook();
    await currentWorkbook.xlsx.load(currentBytes.rawPayload);
    await blankWorkbook.xlsx.load(blankBytes.rawPayload);
    expect(currentWorkbook.getWorksheet("人物信息")?.getCell("B2").value).toBe("王强");
    expect(blankWorkbook.getWorksheet("人物信息")?.getCell("A2").value).toBe("N001");
    expect(blankWorkbook.getWorksheet("人物信息")?.getCell("B2").value).toBe("");
  });

  it("uploads, verifies and restores a backup through the browser API", async () => {
    const saved = await server.inject({
      method: "POST",
      url: "/api/rpc/people/save",
      payload: {
        input: {
          draft: {
            displayName: "王强",
            aliases: [],
            gender: "unknown",
            birth: null,
            death: null,
            notes: null,
            sourceDescription: "网页端恢复测试"
          },
          confirmWarnings: true
        }
      }
    });
    const personId = saved.json().value.entityId as string;
    const targetWorkspaceId = runtime.workspaceManager.getOpenWorkspaceContext()!.workspaceId;

    const question = { question: "有几个孩子", viewpointId: personId, selectedPersonId: null };
    const authorized = await server.inject({
      method: "POST",
      url: "/api/rpc/chat/authorize",
      payload: { input: { sessionId: "restore-chat-session", operation: "ask", payload: question } }
    });
    const asked = await server.inject({
      method: "POST",
      url: "/api/rpc/chat/ask",
      payload: { input: { sessionId: "restore-chat-session", authorizationToken: authorized.json().value.authorizationToken, payload: question } }
    });
    expect(asked.json()).toMatchObject({ ok: true });

    const created = await server.inject({ method: "POST", url: "/api/rpc/dataManagement/createBackup", payload: { input: null } });
    const backup = await server.inject({ method: "GET", url: created.json().value.download.downloadUrl as string });

    const staged = await server.inject({
      method: "POST",
      url: "/api/rpc/mutations/stage",
      payload: { input: { intents: [{ type: "person.create", draft: {
        displayName: "备份后人物", aliases: [], gender: "unknown", birth: null, death: null,
        notes: null, sourceDescription: "网页端恢复测试"
      } }] } }
    });
    const preview = staged.json().value;
    const confirmed = await server.inject({
      method: "POST",
      url: "/api/rpc/mutations/confirm",
      payload: { input: {
        draftId: preview.id,
        draftVersion: preview.version,
        selectedChangeIds: preview.changes.map((change: { id: string }) => change.id),
        acknowledgedWarningCodes: []
      } }
    });
    expect(confirmed.json()).toMatchObject({ ok: true });

    const database = openDatabase(runtime.workspaceManager.getOpenWorkspaceContext()!.databasePath);
    database.prepare("UPDATE person SET display_name='已修改', row_version=row_version+1 WHERE id=?").run(personId);
    database.close();

    const uploaded = await server.inject({
      method: "POST",
      url: "/api/files/backup",
      headers: { "content-type": "application/octet-stream", "x-file-name": "family-backup.zip" },
      payload: backup.rawPayload
    });
    const inspection = await server.inject({
      method: "POST",
      url: "/api/rpc/dataManagement/inspectBackup",
      payload: { input: { fileToken: uploaded.json().value.fileToken, targetWorkspaceId } }
    });
    expect(inspection.json()).toMatchObject({ ok: true, value: { verified: true, targetWorkspaceId } });

    const restored = await server.inject({
      method: "POST",
      url: "/api/rpc/dataManagement/restoreBackup",
      payload: { input: { restoreToken: inspection.json().value.restoreToken, targetWorkspaceId, confirmReplace: true } }
    });
    expect(restored.json()).toMatchObject({ ok: true, value: { restored: true, automaticSnapshotVerified: true } });

    const person = await server.inject({ method: "POST", url: "/api/rpc/people/get", payload: { input: { personId } } });
    expect(person.json()).toMatchObject({ ok: true, value: { person: { displayName: "王强" } } });
  });
});
