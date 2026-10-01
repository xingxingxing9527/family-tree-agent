# 家谱智能体 Web MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 Electron 家谱应用改造成可在浏览器中运行的单家族 Web MVP，同时交付中文 Excel、统一确认流程、正确的婚姻家谱树和可核对问答。

**Architecture:** 保留现有 React、SQLite、领域规则与应用服务，在渲染层加入运行时无关的 API 注入，在服务端以 Node.js HTTP 适配器替换 Electron IPC。结构化事实、Wiki 叙事、媒体文件和 LLM 调用仍由服务端控制，浏览器只通过类型化 API 和上传下载端点交互。

**Tech Stack:** TypeScript、React 19、React Router、Fastify 5、Vite、SQLite/better-sqlite3、ExcelJS、ELK/React Flow、Zod、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-01-family-agent-web-mvp-design.md`

## Global Constraints

- MVP 仅支持单一家族、单管理员和 100–1000 名有效人物。
- Web 运行时不得依赖 Electron；不实现离线/PWA，也不删除仍可用于回归的 Electron 代码。
- 亲属事实只持久化生父、生母、子女和婚姻事件；复杂关系首版只增加离婚与再婚。
- 出生日期整体可空；一旦填写必须有历法、年和月，日可选，农历允许闰月且不自动换算公历。
- 所有家谱事实写入必须经过结构化草稿、服务端校验、预览、管理员确认、事务提交、审计和条件式撤销。
- LLM 只负责意图理解与表达；人物匹配、统计、称谓和关系路径必须来自确定性查询。
- 本地服务默认只监听 `127.0.0.1`；没有管理员认证、HTTPS 和备份监控时不得对公网开放。
- 模型密钥、SQLite 路径和服务器文件路径不得发送到浏览器。
- 1000 人预热基准：人物搜索/详情 API p95 < 500 ms，关系计算/树投影 API p95 < 1 s，默认分支树布局 < 2 s，合规工作簿预览 < 10 s。

## Review Focus

- 过期草稿或旧 `rowVersion` 遇到后续写入时必须返回 `CONFLICT`，且不得部分提交；由 Task 6 的 `staged-mutation-service.test.ts` 固定。
- 篡改的工作簿批次、未知 `Pxxxxxx`、跨家族编号、公式注入和压缩炸弹必须阻断；由 Task 7 的工作簿安全测试固定。
- 同名人物、未确认完整的空子女列表和已确认无子女必须分别回答“请选择人物”“信息不足”“0 个”；由 Task 11 的问答测试固定。
- 多段婚姻无法根据日期唯一归属子女时必须进入“未归属家庭单元”并显示警告，不得猜测；由 Task 9 的投影测试固定。
- MIME 伪装、路径穿越、过期下载令牌和模型不可用不得泄露数据或破坏结构化功能；由 Task 4 和 Task 11 的安全/降级测试固定。

---

## File Structure

新增目录与职责：

- `app/src/server/`：Web 进程入口、Fastify 组装、单家族运行时和 HTTP 路由。
- `app/src/server/http/`：JSON RPC、文件上传、受控下载、错误映射和 Zod 校验。
- `app/src/renderer/src/api/`：浏览器 HTTP 客户端与上传下载客户端。
- `app/src/renderer/src/app/ApiContext.tsx`：向现有 React 页面注入运行时无关 API。
- `app/src/shared/mutations.ts`：表单、关系向导和对话共同使用的草稿/确认契约。
- `app/src/shared/relative-templates.ts`：常用亲属称谓到基础关系路径的声明式模板。
- `app/src/main/application/mutations/`：统一草稿预览、确认和过期控制。
- `app/src/main/application/import/chinese-workbook-*.ts`：中文工作簿生成、解析和元数据校验。
- `app/tests/integration/server/`：HTTP、上传下载和 Web 安全边界测试。
- `app/tests/e2e-web/`：浏览器核心闭环与响应式验收。

现有 `app/src/main/domain/`、`app/src/main/application/`、`app/src/main/database/` 和大部分 `renderer` 组件继续复用；IPC 文件保留为 Electron 兼容适配器，不作为 Web 服务依赖。

范围检查：这些任务共同依赖同一套 `FamilyAgentApi`、SQLite 迁移、统一写入事务和家谱投影契约，拆成多个独立计划会重复定义并增加接口漂移风险。因此保留为一个实施计划，但每个 Task 都形成可单独测试和提交的审查单元。

### Task 1: 建立运行时无关的前端 API 接缝

**Files:**
- Create: `app/src/renderer/src/app/ApiContext.tsx`
- Create: `app/tests/unit/renderer/ApiContext.test.tsx`
- Modify: `app/src/shared/contracts.ts`
- Modify: `app/src/renderer/src/main.tsx`
- Modify: `app/src/renderer/src/app/WorkspaceContext.tsx`
- Modify: `app/src/renderer/src/app/AppShell.tsx`
- Modify: renderer components importing `DesktopApi`
- Modify: affected renderer unit tests

**Interfaces:**
- Produces: `FamilyAgentApi`; `ApiProvider({ api, children })`; `useApi(): FamilyAgentApi`.
- Compatibility: `type DesktopApi = FamilyAgentApi` remains temporarily for Electron preload and legacy tests.

- [ ] **Step 1: Write the failing API-injection tests**

```ts
it("uses the provider API without window.desktopApi", async () => {
  delete (window as Partial<Window>).desktopApi;
  render(<ApiProvider api={fakeApi}><WorkspaceProvider><Probe /></WorkspaceProvider></ApiProvider>);
  expect(fakeApi.workspaces.list).toHaveBeenCalledOnce();
});

it("throws a clear error outside ApiProvider", () => {
  expect(() => render(<UsesApi />)).toThrow("FamilyAgent API is unavailable");
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `cd app; npm test -- tests/unit/renderer/ApiContext.test.tsx tests/unit/renderer/WorkspaceContext.test.tsx`

Expected: FAIL because `ApiProvider` and `FamilyAgentApi` do not exist.

- [ ] **Step 3: Implement the API context and replace direct renderer globals**

Define `FamilyAgentApi` with the current `DesktopApi` surface, export the compatibility alias, and make `WorkspaceContext`/`AppShell` call `useApi()`. Only `main.tsx` may reference the optional Electron preload while wrapping `<App />` in `ApiProvider`.

- [ ] **Step 4: Run renderer tests and type checking**

Run: `cd app; npm test -- tests/unit/renderer`

Run: `cd app; npm run typecheck`

Expected: PASS; `rg "window\.desktopApi" app/src/renderer/src` returns only `main.tsx`.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/contracts.ts app/src/renderer/src app/tests/unit/renderer
git commit -m "refactor: inject runtime-neutral family api"
```

### Task 2: 启动单家族 Web 服务与浏览器构建

**Files:**
- Create: `app/src/server/index.ts`
- Create: `app/src/server/create-web-server.ts`
- Create: `app/src/server/runtime/family-runtime.ts`
- Create: `app/src/renderer/src/api/http-client.ts`
- Create: `app/vite.web.config.ts`
- Create: `app/tsconfig.server.json`
- Create: `app/tests/integration/server/server-lifecycle.test.ts`
- Modify: `app/package.json`
- Modify: `app/package-lock.json`
- Modify: `app/src/renderer/src/main.tsx`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `FamilyAgentApi` from Task 1.
- Produces: `createFamilyRuntime(options): Promise<FamilyRuntime>`; `createWebServer(options): FastifyInstance`; `createHttpApiClient(baseUrl): FamilyAgentApi`.
- `FamilyRuntime` owns one `WorkspaceManager`, one `WorkspaceMutationGate`, gateway instances, and `dispose(): Promise<void>`.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it("serves health and creates at most one family", async () => {
  expect((await server.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ ok: true });
  expect((await createFamily("王氏家谱")).statusCode).toBe(200);
  expect((await createFamily("第二个家谱")).json().error.code).toBe("CONFLICT");
});

it("defaults to loopback", () => expect(resolveListenOptions({})).toEqual({ host: "127.0.0.1", port: 8787 }));
```

- [ ] **Step 2: Run the lifecycle test and verify it fails**

Run: `cd app; npm test -- tests/integration/server/server-lifecycle.test.ts`

Expected: FAIL because the server runtime is absent.

- [ ] **Step 3: Implement Fastify assembly, one-family enforcement and web scripts**

Add `dev:web`, `build:web`, `start:web`, `typecheck:web` and `test:e2e:web`. Use Vite proxy `/api -> http://127.0.0.1:8787`; production serves `out/web`. Store dev data under ignored `app/.family-agent-data/` unless `FAMILY_AGENT_DATA_DIR` is set.

- [ ] **Step 4: Verify server tests and independent Web build**

Run: `cd app; npm test -- tests/integration/server/server-lifecycle.test.ts`

Run: `cd app; npm run build:web`

Expected: PASS; `out/web` and `out/server` are produced without launching Electron.

- [ ] **Step 5: Commit**

```bash
git add .gitignore app/package.json app/package-lock.json app/vite.web.config.ts app/tsconfig.server.json app/src/server app/src/renderer/src/api app/src/renderer/src/main.tsx app/tests/integration/server
git commit -m "feat: add single-family web runtime"
```

### Task 3: 暴露结构化能力的类型化 HTTP API

**Files:**
- Create: `app/src/shared/api-schemas.ts`
- Create: `app/src/server/http/rpc-router.ts`
- Create: `app/src/server/http/error-mapper.ts`
- Create: `app/src/server/runtime/family-agent-service.ts`
- Create: `app/tests/integration/server/rpc-api.test.ts`
- Modify: `app/src/renderer/src/api/http-client.ts`
- Modify: existing IPC schema files to reuse shared schemas

**Interfaces:**
- Consumes: `FamilyRuntime`, `FamilyAgentApi`.
- Produces: `FamilyAgentService implements FamilyAgentApi`; `registerRpcRoutes(server, service)`; `rpcRequestSchema`.
- Route: `POST /api/rpc/:group/:method` with `{ input }`; only an explicit allowlist can resolve methods.

- [ ] **Step 1: Write failing RPC contract tests**

```ts
it.each(["people", "relations", "lineages", "merges", "wiki", "query", "chat", "dataManagement"])(
  "round-trips the %s capability", async (group) => expect(await invokeKnownFixture(group)).toMatchObject({ ok: true })
);
it("rejects unknown methods and unknown fields", async () => expect(await badRpc()).toMatchObject({ statusCode: 400 }));
it("does not return filesystem paths", async () => expect(JSON.stringify(await snapshot())).not.toMatch(/[A-Z]:\\|databasePath|mediaPath/u));
```

- [ ] **Step 2: Run the RPC test and verify it fails**

Run: `cd app; npm test -- tests/integration/server/rpc-api.test.ts`

Expected: FAIL because no RPC router or service facade exists.

- [ ] **Step 3: Implement the allowlisted facade and browser client**

Move request schemas shared by IPC and HTTP into `api-schemas.ts`. Map application errors to `AppResult`; never dynamically index arbitrary object paths. Keep file selection/export methods disabled until Task 4.

- [ ] **Step 4: Verify API, IPC regressions and types**

Run: `cd app; npm test -- tests/integration/server/rpc-api.test.ts tests/integration/ipc`

Run: `cd app; npm run typecheck:web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared app/src/server app/src/renderer/src/api app/src/main/ipc app/tests/integration/server app/tests/integration/ipc
git commit -m "feat: expose typed family http api"
```

### Task 4: 实现受控上传、下载、媒体与备份边界

**Files:**
- Create: `app/src/server/http/upload-store.ts`
- Create: `app/src/server/http/download-store.ts`
- Create: `app/src/server/http/file-routes.ts`
- Create: `app/src/renderer/src/api/file-client.ts`
- Create: `app/tests/integration/server/file-routes.test.ts`
- Modify: `app/src/shared/contracts.ts`
- Modify: `app/src/main/media/media-service.ts`
- Modify: `app/src/server/create-web-server.ts`
- Modify: import/media/data-management renderer components

**Interfaces:**
- Produces: `uploadFile(kind, file): Promise<UploadedFileToken>`; `createDownload(payload): DownloadDescriptor`.
- Server routes: `POST /api/files/:kind`, `GET /api/downloads/:token`, `GET /api/media/:assetId`.
- Tokens are random, one-purpose, expire after 15 minutes, and reveal no path.

- [ ] **Step 1: Write failing transfer and security tests**

```ts
it("rejects a jpeg extension with executable bytes", async () => expect(await upload(fakeExeJpeg)).toMatchObject({ statusCode: 415 }));
it("rejects path traversal and expired tokens", async () => {
  expect((await get("/api/media/../../family.sqlite")).statusCode).toBe(404);
  expect((await getExpiredDownload()).statusCode).toBe(410);
});
it("keeps backup, import and media tokens purpose-bound", async () => expect(await misuseToken()).toMatchObject({ statusCode: 400 }));
```

- [ ] **Step 2: Run the file-route test and verify it fails**

Run: `cd app; npm test -- tests/integration/server/file-routes.test.ts`

Expected: FAIL because upload/download routes are absent.

- [ ] **Step 3: Implement bounded streams and adapt file-oriented UI**

Stream uploads into a server staging directory with size, MIME signature, ZIP-entry and expanded-size limits before issuing tokens. Adapt Excel import, media attachment, backup restore and exports to browser file inputs/download links. Read the model key from `FAMILY_AGENT_OPENAI_API_KEY`; Web UI may show configured/unconfigured but may not read or persist the key.

- [ ] **Step 4: Run transfer, media, backup and security tests**

Run: `cd app; npm test -- tests/integration/server/file-routes.test.ts tests/integration/media tests/integration/backup tests/integration/import/workbook-security.test.ts`

Expected: PASS; no response body contains an absolute path or secret.

- [ ] **Step 5: Commit**

```bash
git add app/src/server app/src/renderer/src/api app/src/renderer/src/features app/src/shared/contracts.ts app/src/main/media app/tests/integration/server app/tests/integration/media app/tests/integration/backup app/tests/integration/import
git commit -m "feat: add secure browser file transfers"
```

### Task 5: 增加稳定人物编号与关系完整性事实

**Files:**
- Create: `app/src/main/database/migrations/006-person-code-and-completeness.ts`
- Create: `app/src/main/database/person-code-allocator.ts`
- Create: `app/src/main/database/repositories/completeness-repository.ts`
- Create: `app/tests/integration/database/person-code-migration.test.ts`
- Create: `app/tests/integration/application/completeness-facts.test.ts`
- Modify: `app/src/main/database/migrations/index.ts`
- Modify: `app/src/main/database/repositories/person-repository.ts`
- Modify: `app/src/main/application/facts/fact-commands.ts`
- Modify: `app/src/main/application/facts/fact-command-service.ts`
- Modify: `app/src/shared/contracts.ts`
- Modify: `app/src/shared/api-schemas.ts`
- Modify: `app/src/server/runtime/family-agent-service.ts`
- Modify: `app/src/renderer/src/api/http-client.ts`

**Interfaces:**
- Produces: `allocatePersonCode(database, workspaceId): string` returning `P` plus six digits.
- Produces: `setChildrenCompleteness({ personId, complete, sourceDescription, expectedVersion })` and `getChildrenCountStatus(personId): { count: number; completeness: "partial" | "complete" }`.
- `PersonReadModel.personCode` is read-only; callers never submit permanent codes for new persons.

- [ ] **Step 1: Write failing migration and completeness tests**

```ts
it("backfills stable ordered codes and never reuses archived codes", () => expect(allCodes()).toEqual(["P000001", "P000002", "P000003"]));
it("allocates atomically", () => expect(new Set(parallelAllocations).size).toBe(parallelAllocations.length));
it("distinguishes partial zero from confirmed zero", () => {
  expect(countStatus(unconfirmed)).toEqual({ count: 0, completeness: "partial" });
  expect(countStatus(confirmed)).toEqual({ count: 0, completeness: "complete" });
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `cd app; npm test -- tests/integration/database/person-code-migration.test.ts tests/integration/application/completeness-facts.test.ts`

Expected: FAIL because schema version 6 and the repository do not exist.

- [ ] **Step 3: Implement schema migration, allocation and audited completeness commands**

Backfill existing persons by `(created_at, id)`. Enforce `UNIQUE(workspace_id, person_code)` without filtering deleted rows. Store child completeness as an audited, versioned fact; adding a child does not silently claim completeness.

- [ ] **Step 4: Run database, fact and migration tests**

Run: `cd app; npm test -- tests/integration/database tests/integration/application/fact-command-service.test.ts tests/integration/application/completeness-facts.test.ts`

Expected: PASS; opening an existing v5 workspace migrates to v6 and preserves IDs.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/database app/src/main/application/facts app/src/shared/contracts.ts app/tests/integration/database app/tests/integration/application
git commit -m "feat: add stable person codes and completeness facts"
```

### Task 6: 统一家谱事实的草稿、预览、确认与撤销入口

**Files:**
- Create: `app/src/shared/mutations.ts`
- Create: `app/src/main/application/mutations/staged-mutation-service.ts`
- Create: `app/src/renderer/src/features/mutations/MutationReviewDialog.tsx`
- Create: `app/src/renderer/src/features/mutations/useStagedMutation.ts`
- Create: `app/tests/integration/application/staged-mutation-service.test.ts`
- Create: `app/tests/unit/renderer/MutationReviewDialog.test.tsx`
- Modify: `app/src/main/application/facts/fact-command-service.ts`
- Modify: `app/src/main/application/chat/draft-service.ts`
- Modify: `app/src/shared/contracts.ts`
- Modify: person, relationship, marriage and lineage editors

**Interfaces:**
- Produces: `MutationIntent` discriminated union; `MutationPreview`; `MutationApi.stage`, `MutationApi.confirm`, `MutationApi.revise`.
- Produces: `FactCommandService.preview(command): { errors; warnings; changes; expectedVersions }`.
- Drafts are in-memory, scoped to one workspace, versioned and expire after 30 minutes.

- [ ] **Step 1: Write failing service and dialog tests**

```ts
it("commits selected changes in one operation group", () => expect(receipt.operationGroupId).toBeTruthy());
it("rolls back every change when one expected version is stale", () => {
  expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(databaseSnapshot()).toEqual(before);
});
it("shows create/update/unchanged, warnings and blockers before confirm", () => expect(screen.getByRole("dialog")).toHaveTextContent("阻断问题"));
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `cd app; npm test -- tests/integration/application/staged-mutation-service.test.ts tests/unit/renderer/MutationReviewDialog.test.tsx`

Expected: FAIL because the shared mutation contract is absent.

- [ ] **Step 3: Implement the staged service and refactor fact forms**

Make person, parent-child, marriage, divorce, lineage and completeness edits call `stage` first. `confirm` must rerun validation and version checks inside one `UnitOfWork`. Reuse the same commit primitive from the conversational `DraftService`; keep Excel's plan format but present the same four dispositions.

- [ ] **Step 4: Run mutation, audit, undo and renderer tests**

Run: `cd app; npm test -- tests/integration/application/staged-mutation-service.test.ts tests/integration/audit tests/integration/chat/draft-confirmation.test.ts tests/unit/renderer`

Expected: PASS; every genealogy form opens the review dialog before a write.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared app/src/main/application/mutations app/src/main/application/facts app/src/main/application/chat app/src/renderer/src/features app/tests
git commit -m "feat: unify mutation preview and confirmation"
```

### Task 7: 交付中文 Excel 导出、空白模板与幂等导入

**Files:**
- Create: `app/src/main/application/import/chinese-workbook-schema.ts`
- Create: `app/src/main/application/import/chinese-workbook-exporter.ts`
- Create: `app/src/main/application/import/workbook-metadata.ts`
- Create: `app/tests/integration/import/chinese-workbook-export.test.ts`
- Create: `app/tests/integration/import/chinese-workbook-roundtrip.test.ts`
- Create: `app/tests/integration/import/chinese-workbook-security.test.ts`
- Modify: `app/src/main/application/import/workbook-parser.ts`
- Modify: `app/src/main/application/import/import-planner.ts`
- Modify: `app/src/main/application/import/import-committer.ts`
- Modify: `app/src/shared/contracts.ts`
- Modify: `app/src/renderer/src/features/import/ImportPage.tsx`
- Modify: `app/src/renderer/src/features/import/EntryCenterPage.tsx`
- Modify: `app/src/server/runtime/family-agent-service.ts`
- Modify: `app/src/server/http/file-routes.ts`

**Interfaces:**
- Produces: `exportCurrentFamilyWorkbook(context): Promise<Buffer>`; `exportBlankWorkbook(context): Promise<Buffer>`.
- Visible sheets: `填写说明`, `人物信息`, `亲子关系`, `婚姻关系`; very-hidden sheet: `_系统元数据`.
- Person references are `人物编号｜姓名`; metadata keys are `workbookId`, `batchId`, `workspaceId`, `kind`, `schemaVersion`.

- [ ] **Step 1: Write failing workbook contract and round-trip tests**

```ts
it("exports the four Chinese sheets and locked permanent codes", async () => expect(sheetNames).toEqual(["填写说明", "人物信息", "亲子关系", "婚姻关系", "_系统元数据"]));
it("accepts lunar month and leap-month day formats", () => expect(parsedDates).toEqual(["1985-03", "1985-闰04-16"]));
it("re-imports the same batch as unchanged", async () => expect(second.summary).toEqual({ creates: 0, updates: 0, unchanged: first.rows.length, blocked: 0 }));
```

- [ ] **Step 2: Run workbook tests and verify they fail**

Run: `cd app; npm test -- tests/integration/import/chinese-workbook-export.test.ts tests/integration/import/chinese-workbook-roundtrip.test.ts tests/integration/import/chinese-workbook-security.test.ts`

Expected: FAIL because the Chinese schema/exporter is absent.

- [ ] **Step 3: Implement exporter, metadata verification and parser mappings**

Use ExcelJS validation lists and locked permanent-code cells. Map `N001` through `(batchId, temporaryId)` and convert it to an allocated permanent code on commit. Treat deleted spreadsheet rows as no-ops. Neutralize formula-leading text, reject unknown/cross-workspace permanent codes and enforce existing ZIP bounds.

- [ ] **Step 4: Run all import tests and Web API download tests**

Run: `cd app; npm test -- tests/integration/import tests/integration/server/file-routes.test.ts tests/unit/renderer/ImportPreview.test.tsx`

Expected: PASS; both download actions produce valid `.xlsx` files.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/application/import app/src/shared/contracts.ts app/src/renderer/src/features/import app/tests/integration/import app/tests/unit/renderer/ImportPreview.test.tsx
git commit -m "feat: add Chinese family workbook workflow"
```

### Task 8: 增加“更多亲属”路径向导

**Files:**
- Create: `app/src/shared/relative-templates.ts`
- Create: `app/src/main/application/facts/relative-path-planner.ts`
- Create: `app/src/renderer/src/features/relations/RelativeWizard.tsx`
- Create: `app/tests/unit/domain/relative-templates.test.ts`
- Create: `app/tests/integration/application/relative-path-planner.test.ts`
- Create: `app/tests/unit/renderer/RelativeWizard.test.tsx`
- Modify: `app/src/renderer/src/features/relations/RelationshipEditor.tsx`

**Interfaces:**
- Produces: `RelativeTemplate` entries for兄弟姐妹、祖父母、叔伯、姑姨、侄甥和堂表亲.
- Produces: `planRelativePath({ anchorId, targetId, templateId, selectedIntermediaryIds }): RelativePathPlan` with `requiredSelections`, `intents`, `resultingPath`.
- Consumes: `MutationApi.stage` from Task 6.

- [ ] **Step 1: Write failing path and UI tests**

```ts
it("plans an uncle only through parent and grandparent edges", () => expect(plan.intents.every(isBaseFactIntent)).toBe(true));
it("blocks when an intermediary is missing", () => expect(plan.requiredSelections).toContainEqual(expect.objectContaining({ role: "grandparent" })));
it("never emits a stored kinship-label edge", () => expect(JSON.stringify(plan.intents)).not.toContain("叔叔"));
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `cd app; npm test -- tests/unit/domain/relative-templates.test.ts tests/integration/application/relative-path-planner.test.ts tests/unit/renderer/RelativeWizard.test.tsx`

Expected: FAIL because templates and planner are absent.

- [ ] **Step 3: Implement the declarative catalog, planner and guided selections**

Prefill uniquely determined intermediaries from the existing graph; require explicit selection when several candidates exist; never auto-create unnamed people. Show the proposed base path and reciprocal称谓 before opening `MutationReviewDialog`.

- [ ] **Step 4: Run relation, kinship and UI tests**

Run: `cd app; npm test -- tests/unit/domain/relative-templates.test.ts tests/integration/application/relative-path-planner.test.ts tests/unit/domain/kinship tests/unit/renderer/RelationshipEditor.test.tsx tests/unit/renderer/RelativeWizard.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/relative-templates.ts app/src/main/application/facts/relative-path-planner.ts app/src/renderer/src/features/relations app/tests
git commit -m "feat: add guided relative path entry"
```

### Task 9: 修正家庭单元投影与家谱树视觉层级

**Files:**
- Modify: `app/src/shared/contracts.ts`
- Modify: `app/src/main/application/query/workspace-projection.ts`
- Modify: `app/src/main/domain/projection/family-union-projector.ts`
- Modify: `app/src/renderer/src/features/tree/layout-with-elk.ts`
- Modify: `app/src/renderer/src/features/tree/FamilyTreeCanvas.tsx`
- Modify: `app/src/renderer/src/features/tree/FamilyUnionNode.tsx`
- Modify: `app/src/renderer/src/features/tree/PersonNode.tsx`
- Modify: `app/src/renderer/src/features/tree/tree.css`
- Modify: `app/tests/unit/domain/family-union-projector.test.ts`
- Modify: `app/tests/unit/renderer/FamilyTreeCanvas.test.tsx`
- Create: `app/tests/e2e-web/family-tree-lineage.spec.ts`

**Interfaces:**
- `TreePersonNodeDto.display.lineageRole: "blood" | "married_in" | "associated" | null`.
- `TreeFlowEdgeData.visualRole: "marriage" | "descent"`.
- Consumes existing `FamilyUnionProjector`; ambiguous remarriage assignment remains `kind: "unassigned"` with warnings.

- [ ] **Step 1: Write failing lineage and remarriage tests**

```ts
it("connects the ancestor union only to Wang Jianguo and Wang Qiang", () => expect(childrenOf(gen1Union)).toEqual([wangJianguo, wangQiang]));
it("connects Zhao Xiulan horizontally as Wang Jianguo's spouse", () => expect(edgeTo(zhaoXiulan).visualRole).toBe("marriage"));
it("keeps an ambiguous child in an unassigned union", () => expect(union).toMatchObject({ kind: "unassigned", warnings: [expect.any(String)] }));
```

- [ ] **Step 2: Run projection and canvas tests and verify the new assertions fail**

Run: `cd app; npm test -- tests/unit/domain/family-union-projector.test.ts tests/unit/renderer/FamilyTreeCanvas.test.tsx`

Expected: FAIL on lineage role/edge visual role.

- [ ] **Step 3: Implement lineage role projection, ELK ordering and distinct edge/card styling**

Use lineage membership rather than viewpoint-dependent“直系”判断. Render branch-member descent vertically and marriage horizontally, label cards“本层子女”或“配偶”, and give divorced unions a distinct line style plus text.

- [ ] **Step 4: Run domain, renderer and Web tree E2E tests**

Run: `cd app; npm test -- tests/unit/domain/family-union-projector.test.ts tests/unit/renderer/FamilyTreeCanvas.test.tsx`

Run: `cd app; npm run test:e2e:web -- --grep "lineage|remarriage"`

Expected: PASS at desktop and 360 px viewport with no horizontal page overflow.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/contracts.ts app/src/main/application/query app/src/main/domain/projection app/src/renderer/src/features/tree app/tests/unit app/tests/e2e-web
git commit -m "fix: distinguish lineage members from spouses"
```

### Task 10: 落实四入口 Web 信息架构与人物交互

**Files:**
- Create: `app/src/renderer/src/features/chat/ChatPage.tsx`
- Create: `app/tests/unit/renderer/ChatPage.test.tsx`
- Modify: `app/src/renderer/src/app/AppShell.tsx`
- Modify: `app/src/renderer/src/app/AppRouter.tsx`
- Modify: `app/src/renderer/src/app/app-shell.css`
- Modify: `app/src/renderer/src/features/people/PeoplePage.tsx`
- Modify: `app/src/renderer/src/features/people/PersonDetail.tsx`
- Modify: `app/src/renderer/src/features/import/EntryCenterPage.tsx`
- Modify: `app/tests/unit/renderer/AppShell.test.tsx`
- Create: `app/tests/e2e-web/navigation-responsive.spec.ts`

**Interfaces:**
- Primary routes: `/tree`, `/people`, `/entry`, `/chat` under the sole workspace.
- Secondary routes: `/wiki`, `/settings`; no“切换谱册” action after one family exists.
- Viewpoint stays in `ViewpointContext` and is shared by tree, people and chat.

- [ ] **Step 1: Write failing navigation and responsive tests**

```ts
it("shows exactly four primary destinations", () => expect(primaryNavNames()).toEqual(["家谱树", "人物", "录入", "问答"]));
it("keeps viewpoint when moving from tree to chat", async () => expect(screen.getByLabelText("回答视角")).toHaveValue(wangMing));
it("has no horizontal overflow at 736 and 360", async () => expect(await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth)).toBe(true));
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `cd app; npm test -- tests/unit/renderer/AppShell.test.tsx tests/unit/renderer/ChatPage.test.tsx`

Expected: FAIL because chat is not a primary page and five current areas are primary.

- [ ] **Step 3: Implement the approved shell, detail panel and quick actions**

Move Wiki/settings to secondary navigation, replace persistent chat aside with `ChatPage`, preserve viewpoint and selected-person context, and keep person quick-add/edit routed through Task 6. Use theme-aware opaque surfaces and WCAG-readable text contrast.

- [ ] **Step 4: Run renderer and responsive Web tests**

Run: `cd app; npm test -- tests/unit/renderer/AppShell.test.tsx tests/unit/renderer/ChatPage.test.tsx tests/unit/renderer/PersonEditor.test.tsx`

Run: `cd app; npm run test:e2e:web -- --grep "navigation|responsive"`

Expected: PASS at 736 px and 360 px; no clipped controls or unreadable card text.

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/src/app app/src/renderer/src/features app/tests/unit/renderer app/tests/e2e-web
git commit -m "feat: add four-area web navigation"
```

### Task 11: 实现可核对、可消歧且不虚构的家谱问答

**Files:**
- Modify: `app/src/shared/chat.ts`
- Create: `app/src/main/application/chat/answer-coordinator.ts`
- Create: `app/tests/integration/chat/answer-coordinator.test.ts`
- Modify: `app/src/main/application/chat/conversation-service.ts`
- Modify: `app/src/main/application/query/query-tool-registry.ts`
- Modify: `app/src/renderer/src/features/chat/ChatPanel.tsx`
- Modify: `app/src/renderer/src/features/chat/ChatPage.tsx`
- Modify: `app/tests/unit/renderer/ChatPanel.test.tsx`
- Create: `app/tests/e2e-web/chat-evidence.spec.ts`

**Interfaces:**
- `ConversationAnswer.status: "answered" | "needs_disambiguation" | "insufficient"`.
- `ConversationAnswer` adds `viewpoint`, named `relationshipPath`, titled `evidence`, `candidates`, and `missingFacts`.
- Produces: `AnswerCoordinator.ask(input): Promise<ConversationAnswer>`; coordinator enforces deterministic status before accepting model prose.

- [ ] **Step 1: Write failing trust-state tests**

```ts
it("returns candidates for two exact-name matches", async () => expect(answer).toMatchObject({ status: "needs_disambiguation", candidates: [{}, {}] }));
it("returns insufficient for an unconfirmed empty child list", async () => expect(answer.conclusion).toContain("信息不足"));
it("returns zero only after completeness confirmation", async () => expect(answer).toMatchObject({ status: "answered", conclusion: expect.stringContaining("0 个") }));
it("keeps deterministic browsing available when the model is down", async () => expect(await directQuery()).toMatchObject({ ok: true }));
```

- [ ] **Step 2: Run chat tests and verify they fail**

Run: `cd app; npm test -- tests/integration/chat/answer-coordinator.test.ts tests/unit/renderer/ChatPanel.test.tsx`

Expected: FAIL because `ConversationAnswer.status` and coordinator are absent.

- [ ] **Step 3: Implement deterministic preflight, evidence naming and approved answer UI**

Resolve explicit candidate selection before LLM calls. Convert person IDs, source IDs and relationship signatures into display names/titles. Render conclusion first, then viewpoint, relationship path and evidence; show candidate cards for同名 and a补录 action for missing facts. Wiki text may support narrative answers but cannot overwrite graph facts.

- [ ] **Step 4: Run chat, query and browser evidence tests**

Run: `cd app; npm test -- tests/integration/chat tests/integration/application/query-tools.test.ts tests/unit/renderer/ChatPanel.test.tsx`

Run: `cd app; npm run test:e2e:web -- --grep "chat evidence"`

Expected: PASS for明确回答、同名确认、信息不足 and model outage.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/chat.ts app/src/main/application/chat app/src/main/application/query app/src/renderer/src/features/chat app/tests/integration/chat app/tests/unit/renderer app/tests/e2e-web
git commit -m "feat: add evidence-backed family answers"
```

### Task 12: 完成 Web 核心闭环、性能门槛与运行文档

**Files:**
- Create: `app/playwright.web.config.ts`
- Create: `app/tests/e2e-web/web-core-loop.spec.ts`
- Create: `app/tests/e2e-web/web-import-roundtrip.spec.ts`
- Create: `app/tests/e2e-web/web-undo.spec.ts`
- Create: `app/tests/integration/server/web-security-boundary.test.ts`
- Create: `app/docs/web-mvp-runbook.md`
- Modify: `app/scripts/run-performance-gates.ts`
- Modify: `app/package.json`
- Modify: `app/docs/user-acceptance-checklist.md`

**Interfaces:**
- Produces commands: `npm run dev:web`, `npm run build:web`, `npm run start:web`, `npm run test:e2e:web`, `npm run verify:web`.
- `verify:web` runs type checks, unit/integration tests, Web build, Web E2E and performance gates in that order.

- [ ] **Step 1: Write failing closed-loop and security tests**

```ts
test("creates a five-person family with divorce, remarriage, export/import and undo", async ({ page }) => {
  await expect(page.getByText("已离婚")).toBeVisible();
  await expect(page.getByText("婚姻中")).toBeVisible();
  await expect(page.getByText("王小雨是你的女儿。")).toBeVisible();
  await expect(page.getByText("已撤销")).toBeVisible();
});
it("binds loopback and omits secrets, paths and stack traces", async () => {
  expect(listenOptions.host).toBe("127.0.0.1");
  expect(JSON.stringify(publicSurface)).not.toMatch(/OPENAI|databasePath|mediaPath|[A-Z]:\\/u);
});
it("meets the 1000-person budgets", async () => {
  expect(metrics.searchP95Ms).toBeLessThan(500);
  expect(metrics.relationshipP95Ms).toBeLessThan(1_000);
  expect(metrics.treeLayoutMs).toBeLessThan(2_000);
  expect(metrics.workbookPreviewMs).toBeLessThan(10_000);
});
```

- [ ] **Step 2: Run Web verification and record the expected failures**

Run: `cd app; npm run verify:web`

Expected: FAIL on the newly added closed-loop or performance assertions until final integration is complete.

- [ ] **Step 3: Fix only integration gaps and write the runbook**

Document local data location, environment variables, loopback binding, backup/restore, model-outage behavior and the explicit prohibition on public exposure without authentication/HTTPS/monitoring. Ensure `build:web` imports no Electron module in the server or browser bundles.

- [ ] **Step 4: Run complete verification**

Run: `cd app; npm run verify:web`

Expected: all type checks, tests, Web E2E, build and performance gates PASS.

Run: `cd app; npm test`

Expected: existing Electron-era unit/integration tests still PASS unless deliberately superseded by documented Web contracts.

- [ ] **Step 5: Commit**

```bash
git add app/package.json app/package-lock.json app/playwright.web.config.ts app/tests/e2e-web app/tests/integration/server app/scripts app/docs
git commit -m "test: verify family agent web mvp"
```

## Final Review Gate

After Task 12:

- Run `git status --short` and verify only intentional files are present.
- Run `cd app; npm run verify:web` once from a clean process state.
- Review the complete branch against every section of the design spec.
- Confirm the server listens only on `127.0.0.1` by default and no secret/path is serialized.
- Confirm the browser can complete create → input → preview → confirm → tree → question → export → undo without Electron.
