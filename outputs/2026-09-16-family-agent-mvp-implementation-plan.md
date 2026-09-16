# LLM-Wiki 家谱智能体 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 构建一个 Windows 优先、本地保存家谱事实、支持多方式录入、可视化浏览、确定性称谓推理和受控 LLM 对话的可交付桌面 Beta。

**Architecture:** 应用采用 Electron 三进程边界：渲染进程只负责 React UI，预加载层只暴露白名单 IPC，主进程持有 SQLite、文件系统、在线模型和备份权限。每个谱册使用独立目录和 SQLite 文件；结构化事实由领域服务和确定性规则引擎管理，LLM 只能生成草稿或调用只读工具。

**Tech Stack:** Electron、electron-vite、React、TypeScript、SQLite、better-sqlite3、Zod、React Flow、ELK、Vitest、Testing Library、Playwright、electron-builder。

**Spec:** outputs/llm-wiki-family-agent-product-design.md（v1.5，2026-09-16，已确认）

## Global Constraints

- 首版为单管理员、单机桌面应用，可管理多个彼此隔离的谱册，每个谱册 100–1000 人。
- 首版只支持亲生父母/子女、婚姻、离婚和再婚；不实现收养、继亲、方言称谓和按历史日期重算。
- 日期填写后必须包含农历/公历、年和月；日可选；农历支持闰月；历史值只进入 AuditLog。
- 事实由 SQLite 保存，关系由确定性引擎计算，LLM 只理解和表达；任何 AI 写入先生成草稿、校验并由用户确认。
- 已结束婚姻只允许婚姻两端识别前夫/前妻，不可作为中间边继续推导前姻亲。
- Electron 强制 contextIsolation、sandbox、nodeIntegration=false、严格 CSP、白名单 IPC 和主进程路径校验。
- 模型密钥使用 Electron safeStorage 的异步 API 加密，仅主进程可读，不进入数据库、日志、崩溃报告或备份。
- 普通 Windows 11、4 核 CPU、8 GB 内存、1000 人数据集：默认树首次呈现不超过 2 秒，视角切换不超过 500 毫秒，纯关系计算 P95 不超过 300 毫秒，1000 行导入预检不超过 30 秒。
- 正常目标为 24–40 个智能体工作小时、3–5 个日历日；风险缓冲上限为 60 小时、7 个日历日，缓冲不增加首版范围。
- 使用 npm 和 package-lock.json 固定依赖；所有领域写入必须经过单个 SQLite 事务；ID 使用 crypto.randomUUID()，时间戳使用 UTC ISO 8601。
- 每个测试文件都执行同一个 TDD 内循环：先增加一个失败断言，运行目标测试并确认失败原因与预期一致，再写最小实现，最后重跑目标测试及受影响测试；不得先写实现再补测试。

## Implementation Decisions

- 代码放在 app/，设计与计划保留在 outputs/。
- 使用 electron-vite 分别构建 main、preload、renderer，electron-builder 生成 Windows NSIS 安装包。
- 使用 better-sqlite3，启动时设置 foreign_keys=ON、journal_mode=WAL、busy_timeout=5000。
- 使用 Zod 同时定义渲染层表单、IPC 输入和 LLM 结构化输出；IPC 统一返回 AppResult<T>。
- 使用 @xyflow/react 渲染图，使用 elkjs 生成分层布局；FamilyUnion 是运行时投影，不写入事实表。
- 使用 ExcelJS 读取/生成 XLSX，csv-parse 读取 CSV；关系只通过 person_external_id 连接。
- 使用 OpenAI 官方 JavaScript SDK实现首个在线模型适配器，调用 Responses API 的结构化输出；领域层只依赖 ModelAdapter 接口。
- 使用 archiver 创建 ZIP 备份，extract-zip 解包到临时目录；恢复前先做清单、哈希、版本和路径穿越校验。
- 依赖安装后立即提交 package-lock.json；better-sqlite3 由 electron-builder install-app-deps 针对 Electron 重建，并配置 ASAR unpack。

## File and Module Map

| 路径 | 单一职责 |
|---|---|
| app/src/shared/domain.ts | 跨进程领域类型、ID、日期、人物、关系、支系和错误类型 |
| app/src/shared/contracts.ts | IPC 请求/响应 Zod schema、DesktopApi 和 AppResult |
| app/src/main/index.ts | Electron 生命周期、协议注册、窗口创建和 IPC 装配 |
| app/src/main/security/ | 安全窗口选项、导航策略、CSP、路径边界和凭据存储 |
| app/src/main/workspaces/ | 谱册索引、目录布局、创建、打开、切换和关闭 |
| app/src/main/database/ | SQLite 打开、迁移、UnitOfWork 和各实体 repository |
| app/src/main/domain/ | 日期校验、事实约束、支系世代、FamilyUnion 和称谓引擎 |
| app/src/main/application/ | 人物/关系用例、导入、合并、备份、查询和 AI 草稿编排 |
| app/src/main/media/ | 媒体哈希、复制、读取和路径校验 |
| app/src/main/llm/ | ModelAdapter、OpenAI 适配器、提示词和最小上下文构造 |
| app/src/preload/index.ts | 仅暴露 DesktopApi 的 contextBridge |
| app/src/renderer/src/app/ | 路由、工作区上下文、错误边界和全局布局 |
| app/src/renderer/src/features/ | 按人物、关系、树、导入、Wiki、对话、设置划分的界面 |
| app/src/renderer/src/styles/ | 颜色、排版、卡片和可访问性样式令牌 |
| app/resources/kinship-rules/ | 版本化普通话称谓规则 JSON |
| app/tests/unit/ | 纯函数、schema、投影、称谓和组件单元测试 |
| app/tests/integration/ | 临时 SQLite、事务、导入、合并、备份和 IPC 集成测试 |
| app/tests/e2e/ | Playwright Electron 用户流程与安全边界测试 |
| app/tests/fixtures/ | 导入文件、样例家谱、称谓黄金案例和损坏备份 |
| app/scripts/ | 1000 人基准数据生成、性能门禁和安装包冒烟脚本 |

---

### Task 1: Secure Electron Skeleton and Test Harness

**Files:**
- Create: app/package.json
- Create: app/electron.vite.config.ts
- Create: app/electron-builder.yml
- Create: app/tsconfig.node.json
- Create: app/tsconfig.web.json
- Create: app/vitest.config.ts
- Create: app/playwright.config.ts
- Create: app/src/main/index.ts
- Create: app/src/main/security/window-options.ts
- Create: app/src/main/security/navigation-policy.ts
- Create: app/src/preload/index.ts
- Create: app/src/renderer/index.html
- Create: app/src/renderer/src/main.tsx
- Create: app/src/renderer/src/App.tsx
- Create: app/src/renderer/src/styles/tokens.css
- Test: app/tests/unit/main/window-options.test.ts
- Test: app/tests/e2e/app-launch.spec.ts

**Interfaces:**
- Consumes: none.
- Produces: createSecureWebPreferences(preloadPath: string): WebPreferences; installNavigationPolicy(window: BrowserWindow): void; a running Electron shell with window.desktopApi defined only by preload.

- [ ] **Step 1: Initialize the local repository and install the shell dependencies**

Run from the workspace root:

    git init
    New-Item -ItemType Directory -Path app
    Set-Location app
    npm init -y
    npm install react react-dom react-router-dom zod
    npm install --save-dev electron electron-vite electron-builder typescript vite @vitejs/plugin-react vitest @vitest/coverage-v8 @testing-library/react @testing-library/jest-dom jsdom playwright @playwright/test tsx @types/node @types/react @types/react-dom

Set package.json private=true, main="./out/main/index.js", and make the scripts exactly:

    {
      "scripts": {
        "dev": "electron-vite dev",
        "build": "npm run typecheck && electron-vite build",
        "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
        "test": "vitest run",
        "test:coverage": "vitest run --coverage",
        "test:e2e": "npm run build && playwright test",
        "package:win": "npm run build && electron-builder --win nsis",
        "postinstall": "electron-builder install-app-deps"
      }
    }

- [ ] **Step 2: Write the failing security configuration test**

    import { describe, expect, it } from "vitest";
    import { createSecureWebPreferences } from "../../../src/main/security/window-options";

    describe("createSecureWebPreferences", () => {
      it("isolates and sandboxes every renderer", () => {
        expect(createSecureWebPreferences("C:/app/preload.js")).toMatchObject({
          preload: "C:/app/preload.js",
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true
        });
      });
    });

- [ ] **Step 3: Run the test and verify the intended failure**

Run:

    npm test -- tests/unit/main/window-options.test.ts

Expected: FAIL because src/main/security/window-options.ts does not exist.

- [ ] **Step 4: Implement the secure main/preload/renderer boundary**

Use this electron.vite.config.ts shape:

    import { resolve } from "node:path";
    import react from "@vitejs/plugin-react";
    import { defineConfig } from "electron-vite";

    export default defineConfig({
      main: {
        build: { rollupOptions: { external: ["better-sqlite3"] } }
      },
      preload: {},
      renderer: {
        root: resolve("src/renderer"),
        plugins: [react()]
      }
    });

Use this initial electron-builder.yml shape:

    appId: cn.llmwiki.family
    productName: 家谱智能体
    directories:
      output: release
    files:
      - out/**
      - package.json
    asarUnpack:
      - node_modules/better-sqlite3/**
    win:
      target:
        - nsis
      artifactName: family-agent-${version}-${arch}.${ext}

Create the window options with no conditional production downgrade:

    import type { WebPreferences } from "electron";

    export function createSecureWebPreferences(preloadPath: string): WebPreferences {
      return {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false
      };
    }

In src/main/index.ts call app.enableSandbox() before app.whenReady(), register the local app protocol, create one BrowserWindow with the returned preferences, deny all permission requests, and install navigation handlers that reject navigation outside the packaged application. In src/preload/index.ts expose only desktopApi.app.getVersion(), implemented by one fixed IPC channel, rather than ipcRenderer itself. Add this production CSP to renderer/index.html:

    default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: app:; media-src 'self' app:; connect-src 'self'

Use tokens.css with #f8fafc page background, #ffffff surfaces, #0f172a primary text, #475569 secondary text, #2563eb focus/accent, 1px #cbd5e1 borders, and a visible 3px focus ring. Do not use black cards with dark text.

- [ ] **Step 5: Add the launch smoke test**

The Playwright test launches out/main/index.js, waits for the first window, checks the title “家谱智能体”, verifies body text is readable, and evaluates:

    expect(await window.evaluate(() => typeof window.desktopApi.app.getVersion)).toBe("function");
    expect(await window.evaluate(() => typeof window.require)).toBe("undefined");
    expect(await window.evaluate(() => typeof window.process)).toBe("undefined");

- [ ] **Step 6: Run shell verification**

Run:

    npm run typecheck
    npm test
    npm run test:e2e

Expected: all commands exit 0; the Electron window launches without a security warning.

- [ ] **Step 7: Commit**

    Set-Location ..
    git add app outputs
    git commit -m "chore: scaffold secure Electron application"

---

### Task 2: Workspace Isolation and Shared Contracts

**Files:**
- Create: app/src/shared/domain.ts
- Create: app/src/shared/contracts.ts
- Create: app/src/main/workspaces/workspace-paths.ts
- Create: app/src/main/workspaces/workspace-index.ts
- Create: app/src/main/workspaces/workspace-manager.ts
- Create: app/src/main/ipc/register-ipc.ts
- Modify: app/src/preload/index.ts
- Test: app/tests/unit/shared/partial-date.test.ts
- Test: app/tests/integration/workspaces/workspace-manager.test.ts
- Test: app/tests/integration/ipc/ipc-contracts.test.ts

**Interfaces:**
- Consumes: secure IPC boundary from Task 1.
- Produces: PartialDate, WorkspaceSummary, WorkspacePaths, AppResult<T>, WorkspaceManager.list/create/open/close, and typed desktopApi.workspaces methods.

- [ ] **Step 1: Define and test the date contract**

Use this public type:

    export type CalendarType = "solar" | "lunar";
    export type DatePrecision = "month" | "day";

    export interface PartialDate {
      calendar: CalendarType;
      year: number;
      month: number;
      day: number | null;
      leapMonth: boolean;
      precision: DatePrecision;
    }

Tests must accept lunar 2024 leap month 2 with no day, reject a date with year but no month, reject leapMonth=true for solar dates, reject solar 2024-02-30, and derive precision=month when day is null.

- [ ] **Step 2: Define IPC result and workspace schemas**

    export type AppErrorCode =
      | "VALIDATION"
      | "NOT_FOUND"
      | "CONFLICT"
      | "PATH_DENIED"
      | "MODEL_UNAVAILABLE"
      | "INTERNAL";

    export type AppResult<T> =
      | { ok: true; value: T }
      | { ok: false; error: { code: AppErrorCode; message: string; details?: unknown } };

    export interface WorkspaceSummary {
      id: string;
      name: string;
      directory: string;
      originPersonId: string | null;
      lastOpenedAt: string | null;
      schemaVersion: number;
    }

The preload API exposes only:

    workspaces.list(): Promise<AppResult<WorkspaceSummary[]>>
    workspaces.create(input: { name: string }): Promise<AppResult<WorkspaceSummary>>
    workspaces.open(input: { id: string }): Promise<AppResult<WorkspaceSummary>>
    workspaces.close(): Promise<AppResult<null>>

Each IPC handler validates input with Zod and validates event.sender.id against the main application window.
AppResult.error.details may contain field names and stable entity IDs, but never stack traces, model keys, SQL, absolute paths or unrestricted exception objects.

- [ ] **Step 3: Write the failing workspace isolation tests**

Create two workspaces under a temporary app-data directory. Assert that each has its own workspace.json, genealogy.sqlite path, media directory and backups directory. Attempt to open a workspace index entry whose resolved directory escapes the configured root and expect PATH_DENIED.

- [ ] **Step 4: Implement atomic workspace index writes**

WorkspacePaths is:

    export interface WorkspacePaths {
      root: string;
      manifest: string;
      database: string;
      media: string;
      backups: string;
    }

workspace-index.ts writes index.json.tmp, fsyncs and renames it to index.json. workspace-manager.ts resolves every directory with path.resolve(), verifies path.relative(root, candidate) neither starts with ".." nor is absolute, and owns at most one open workspace. Create uses a UUID directory name, never the user-entered title.

- [ ] **Step 5: Register typed IPC and expose exact methods**

register-ipc.ts maps fixed channel constants to WorkspaceManager methods. preload/index.ts wraps individual ipcRenderer.invoke calls; it never exposes send, invoke, on, removeListener, channel names, filesystem paths, or Electron objects.

- [ ] **Step 6: Run tests**

    npm test -- tests/unit/shared tests/integration/workspaces tests/integration/ipc
    npm run typecheck

Expected: invalid dates, path escapes, malformed IPC payloads and untrusted senders are rejected; two valid workspaces remain isolated.

- [ ] **Step 7: Commit**

    git add app
    git commit -m "feat: add isolated genealogy workspaces"

---

### Task 3: SQLite Schema, Migrations, Repositories, and Audit Transactions

**Files:**
- Create: app/src/main/database/open-database.ts
- Create: app/src/main/database/migrations/001-initial-schema.ts
- Create: app/src/main/database/migrations/index.ts
- Create: app/src/main/database/unit-of-work.ts
- Create: app/src/main/database/repositories/person-repository.ts
- Create: app/src/main/database/repositories/relation-repository.ts
- Create: app/src/main/database/repositories/lineage-repository.ts
- Create: app/src/main/database/repositories/source-repository.ts
- Create: app/src/main/database/repositories/audit-repository.ts
- Modify: app/src/main/workspaces/workspace-manager.ts
- Test: app/tests/integration/database/migrations.test.ts
- Test: app/tests/integration/database/transactions.test.ts

**Interfaces:**
- Consumes: WorkspacePaths and shared domain IDs from Task 2.
- Produces: WorkspaceDatabase, UnitOfWork.run<T>(), core repositories, operation groups and append-only audit records.

- [ ] **Step 1: Install SQLite dependencies and write the failing migration test**

    Set-Location app
    npm install better-sqlite3
    npm install --save-dev @types/better-sqlite3

The test opens an empty temporary database, runs migrations twice, and asserts both runs end at schema version 1 with exactly one row in schema_migrations. It also asserts foreign_keys=1 and journal_mode=wal.

- [ ] **Step 2: Implement the versioned schema**

Migration 001 creates these tables with TEXT UUID primary keys, workspace_id on all workspace-owned rows, UTC timestamps, row_version default 1, and soft-delete deleted_at where applicable:

- workspace_meta
- source
- operation_group
- person
- person_alias
- lineage
- lineage_membership
- parent_child
- marriage
- import_identity
- merge_record
- id_redirect
- media_asset
- media_person
- wiki_entry
- wiki_person
- audit_log

Apply the following database constraints:

    CHECK (gender IN ('male','female','unknown'))
    CHECK (parent_role IN ('father','mother'))
    CHECK (relationship_type = 'biological')
    CHECK (lineage_role IN ('blood','married_in','associated'))
    CHECK (marriage_status IN ('active','divorced'))
    CHECK (parent_id <> child_id)
    CHECK (spouse_a_id <> spouse_b_id)
    UNIQUE (workspace_id, source_key, external_person_id)

Create partial unique indexes for one active biological father and one active biological mother per child, one primary lineage membership per person, active aliases per person, and canonical active marriage pairs. Store spouse_a_id and spouse_b_id in lexical UUID order.

Date columns use the same six-column group wherever required:

    calendar TEXT
    year INTEGER
    month INTEGER
    day INTEGER NULL
    leap_month INTEGER NOT NULL DEFAULT 0
    precision TEXT CHECK (precision IN ('month','day'))

All nullable date groups are either entirely null or contain calendar, year, month and precision. Use migration CHECK constraints plus Zod validation rather than silently filling partial values.

- [ ] **Step 3: Implement database opening and migration failure behavior**

openDatabase(file) configures pragmas before returning:

    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");

Migration application runs inside an immediate transaction. If a migration fails, the schema version remains unchanged and WorkspaceManager refuses to mark the workspace open.

- [ ] **Step 4: Write the failing atomicity test**

Use UnitOfWork.run("person.create", callback). Insert a person and audit row, throw after the audit insert, and assert neither row nor operation_group persists. Then run without the throw and assert one person, one operation group and one audit row persist.

- [ ] **Step 5: Implement repository and audit contracts**

    export interface UnitOfWork {
      run<T>(kind: string, work: (ctx: TransactionContext) => T): T;
    }

    export interface TransactionContext {
      operationGroupId: string;
      people: PersonRepository;
      relations: RelationRepository;
      lineages: LineageRepository;
      sources: SourceRepository;
      audit: AuditRepository;
    }

Every repository mutation receives TransactionContext, increments row_version, and calls audit.append() with entity type, ID, action, before JSON and after JSON. Reads exclude deleted_at by default and can opt into archived records only for audit/restore screens.

- [ ] **Step 6: Run schema and transaction tests**

    npm test -- tests/integration/database
    npm run typecheck

Expected: migration idempotency, foreign keys, unique constraints, rollback and audit creation all pass.

- [ ] **Step 7: Commit**

    git add app
    git commit -m "feat: add versioned genealogy database"

---

### Task 4: Domain Validation and Atomic Fact Commands

**Files:**
- Create: app/src/main/domain/validation/partial-date-validator.ts
- Create: app/src/main/domain/validation/fact-validator.ts
- Create: app/src/main/domain/validation/graph-cycle-detector.ts
- Create: app/src/main/application/facts/fact-command-service.ts
- Create: app/src/main/application/facts/fact-commands.ts
- Create: app/src/main/application/facts/fact-queries.ts
- Test: app/tests/unit/domain/fact-validator.test.ts
- Test: app/tests/integration/application/fact-command-service.test.ts

**Interfaces:**
- Consumes: repositories and UnitOfWork from Task 3.
- Produces: FactCommandService.execute(command): MutationResult and read models for people, parent/child and marriages.

- [ ] **Step 1: Define exact commands and validation results**

    export type FactCommand =
      | { type: "person.create"; draft: PersonDraft; source: SourceDraft }
      | { type: "person.update"; personId: string; patch: PersonPatch; expectedVersion: number; source: SourceDraft }
      | { type: "parentChild.add"; draft: ParentChildDraft; source: SourceDraft }
      | { type: "marriage.add"; draft: MarriageDraft; source: SourceDraft }
      | { type: "marriage.divorce"; marriageId: string; endDate: PartialDate | null; expectedVersion: number; source: SourceDraft }
      | { type: "fact.softDelete"; entityType: string; entityId: string; expectedVersion: number };

    export interface MutationResult {
      operationGroupId: string;
      changedEntityIds: string[];
      warnings: DomainWarning[];
    }

Validation errors block the transaction. Warnings are returned before commit and require confirmWarnings=true on a second call.

- [ ] **Step 2: Write failing invariant tests**

Cover all of these exact cases:

- person cannot parent or marry self;
- adding A→B, B→C, C→A parent links is rejected as PARENT_CYCLE;
- a second active biological father or mother is rejected;
- a new active marriage is rejected while either spouse has another active marriage;
- a divorced marriage may be followed by a new active marriage;
- entities whose workspaceId differs from the open workspace are rejected;
- lunar month/day outside 1–12/1–30 and invalid solar dates are rejected;
- parent age below 12 or above 80 emits a warning;
- a child born before a known parent birth year is rejected as IMPOSSIBLE_DATE.

- [ ] **Step 3: Implement graph and date validation as pure functions**

    export interface ValidationResult {
      errors: DomainIssue[];
      warnings: DomainIssue[];
    }

    export function validatePartialDate(value: PartialDate): ValidationResult;
    export function wouldCreateParentCycle(
      proposedParentId: string,
      childId: string,
      existingEdges: ReadonlyArray<{ parentId: string; childId: string }>
    ): boolean;

Use Gregorian month lengths for solar dates. Lunar dates validate only storage shape and 1–30 day bounds; do not invent a public-calendar conversion.

- [ ] **Step 4: Implement FactCommandService**

The service resolves ID redirects, loads all facts needed for validation, returns warnings without writing when confirmWarnings is false, and executes source creation, fact mutation and audit append inside one UnitOfWork transaction. Optimistic updates compare expectedVersion and return CONFLICT when stale.

- [ ] **Step 5: Run tests**

    npm test -- tests/unit/domain tests/integration/application/fact-command-service.test.ts
    npm run typecheck

Expected: all hard constraints reject without partial rows; warnings require a confirmed second invocation; successful writes have source and audit records.

- [ ] **Step 6: Commit**

    git add app
    git commit -m "feat: enforce genealogy fact invariants"

---

### Task 5: Person and Relationship Editing UI

**Files:**
- Create: app/src/main/ipc/facts-ipc.ts
- Modify: app/src/main/ipc/register-ipc.ts
- Modify: app/src/preload/index.ts
- Create: app/src/renderer/src/features/people/PeoplePage.tsx
- Create: app/src/renderer/src/features/people/PersonEditor.tsx
- Create: app/src/renderer/src/features/people/PartialDateField.tsx
- Create: app/src/renderer/src/features/people/PersonDetail.tsx
- Create: app/src/renderer/src/features/relations/RelationshipEditor.tsx
- Create: app/src/renderer/src/features/relations/MarriageHistory.tsx
- Create: app/src/renderer/src/features/people/people.css
- Test: app/tests/unit/renderer/PersonEditor.test.tsx
- Test: app/tests/e2e/five-person-entry.spec.ts

**Interfaces:**
- Consumes: FactCommandService and fact read models from Task 4.
- Produces: typed people.list/get/save and relations.add/divorce IPC, accessible form UI, and a persisted five-person household flow.

- [ ] **Step 1: Write component tests for date and conflict behavior**

Render PersonEditor and verify:

- choosing a calendar makes year and month required;
- day remains optional;
- leap-month control appears only for lunar dates;
- a stale expectedVersion displays a conflict banner and keeps unsaved values;
- warnings show explicit “返回修改” and “确认保存” actions;
- primary and secondary text meet the token colors from Task 1.

- [ ] **Step 2: Implement typed IPC methods**

Expose these exact methods:

    people.list(input: { query?: string; limit: number; offset: number })
    people.get(input: { personId: string })
    people.save(input: { draft: PersonDraft; confirmWarnings: boolean })
    people.update(input: { personId: string; patch: PersonPatch; expectedVersion: number; confirmWarnings: boolean })
    relations.addParentChild(input: { draft: ParentChildDraft; confirmWarnings: boolean })
    relations.addMarriage(input: { draft: MarriageDraft; confirmWarnings: boolean })
    relations.divorce(input: { marriageId: string; endDate: PartialDate | null; expectedVersion: number })

Zod parses every payload in main. Renderer receives AppResult and never imports database or Node modules.

- [ ] **Step 3: Implement the editor and detail screen**

PersonEditor fields are name, aliases, gender, birth date, death date, notes and source description. RelationshipEditor searches by name/alias but stores selected IDs. MarriageHistory displays active/divorced status and raw user-entered dates. Successful save refreshes the detail read model instead of mutating cached facts optimistically.

- [ ] **Step 4: Add and run the five-person E2E flow**

The test creates “示例谱册”, adds two parents and three children, verifies persistence after window reload, corrects one birth month, divorces the parents, and confirms the marriage history shows the ended relationship.

Run:

    npm test -- tests/unit/renderer/PersonEditor.test.tsx
    npm run test:e2e -- tests/e2e/five-person-entry.spec.ts

Expected: form behavior, persistence, correction and divorce flow pass.

- [ ] **Step 5: Commit**

    git add app
    git commit -m "feat: add person and relationship editing"

---

### Task 6: Lineage, Generation, FamilyUnion, and Tree Projection

**Files:**
- Create: app/src/main/domain/lineage/generation-service.ts
- Create: app/src/main/domain/projection/family-union-projector.ts
- Create: app/src/main/domain/projection/tree-projection-service.ts
- Create: app/src/main/application/lineages/lineage-service.ts
- Create: app/src/renderer/src/features/tree/FamilyTreePage.tsx
- Create: app/src/renderer/src/features/tree/FamilyTreeCanvas.tsx
- Create: app/src/renderer/src/features/tree/PersonNode.tsx
- Create: app/src/renderer/src/features/tree/FamilyUnionNode.tsx
- Create: app/src/renderer/src/features/tree/layout-with-elk.ts
- Create: app/src/renderer/src/features/tree/tree.css
- Test: app/tests/unit/domain/generation-service.test.ts
- Test: app/tests/unit/domain/family-union-projector.test.ts
- Test: app/tests/unit/renderer/FamilyTreeCanvas.test.tsx

**Interfaces:**
- Consumes: active people, marriages, parent-child facts and lineage repositories.
- Produces: GenerationDisplay, FamilyUnion[], TreeProjection and the full/branch/ancestor/descendant tree UI.

- [ ] **Step 1: Install graph dependencies and define projection types**

    npm install @xyflow/react elkjs

Use:

    export interface FamilyUnion {
      id: string;
      kind: "marriage" | "coParents" | "singleParent" | "unassigned";
      parentIds: string[];
      marriageId: string | null;
      marriageStatus: "active" | "divorced" | null;
      childIds: string[];
      warnings: string[];
    }

    export interface GenerationDisplay {
      declared: number | null;
      computed: number | null;
      displayed: number | null;
      source: "declared" | "computed" | "none";
      conflict: boolean;
    }

- [ ] **Step 2: Write failing generation and union tests**

Tests cover:

- founder is computed generation 1; each biological descendant increments by one;
- married-in and associated memberships have no computed blood generation;
- declared value wins display and conflict=true when it differs from computed;
- remarried person appears once across two marriage unions;
- two confirmed parents without marriage form a coParents union;
- one known parent forms a singleParent union;
- ended marriages remain visible but styled ended;
- multiple marriages between the same pair with no date evidence place ambiguous children in one unassigned union with a warning rather than guessing.

- [ ] **Step 3: Implement deterministic stable projection IDs**

Use these formats:

    marriage:<marriageId>
    parents:<lexicallySortedParentIdA>:<lexicallySortedParentIdB>
    single:<parentId>
    unassigned:<lexicallySortedParentIdA>:<lexicallySortedParentIdB>

If exactly one marriage exists for a confirmed parent pair, attach their shared children to it. If multiple marriages exist, use a child birth date only when it falls unambiguously within one known interval; otherwise use the unassigned union.

- [ ] **Step 4: Implement tree scopes and ELK layout**

TreeProjectionService returns only IDs and display data for:

    full(viewpointId, collapseDepth)
    branch(rootPersonId)
    ancestors(personId)
    descendants(personId)

React Flow receives precomputed nodes and edges. ELK runs only when fact topology or view scope changes; changing viewpoint updates kinship labels without recomputing topology. Cards use white surfaces, #0f172a text, a minimum 15px name size, and no low-contrast text on black backgrounds.

- [ ] **Step 5: Run tests**

    npm test -- tests/unit/domain/generation-service.test.ts tests/unit/domain/family-union-projector.test.ts tests/unit/renderer/FamilyTreeCanvas.test.tsx
    npm run typecheck

Expected: all union kinds, multi-lineage generation behavior and visible card text pass.

- [ ] **Step 6: Commit**

    git add app
    git commit -m "feat: project lineage-aware family tree"

---

### Task 7: Deterministic Kinship Engine

**Files:**
- Create: app/src/main/domain/kinship/types.ts
- Create: app/src/main/domain/kinship/relation-graph.ts
- Create: app/src/main/domain/kinship/path-search.ts
- Create: app/src/main/domain/kinship/signature-builder.ts
- Create: app/src/main/domain/kinship/rule-loader.ts
- Create: app/src/main/domain/kinship/relationship-calculator.ts
- Create: app/resources/kinship-rules/mandarin-v1.json
- Create: app/tests/fixtures/kinship-core-cases.v1.json
- Test: app/tests/unit/domain/kinship/path-search.test.ts
- Test: app/tests/unit/domain/kinship/relationship-calculator.test.ts

**Interfaces:**
- Consumes: current active fact graph and person gender/date attributes.
- Produces: calculateRelationship(viewpointId, targetId): RelationshipResult with forward/reverse terms, signatures, paths, alternatives and uncertainty.

- [ ] **Step 1: Define the public result and signature**

    export type KinshipStep =
      | "father" | "mother" | "parent"
      | "son" | "daughter" | "child"
      | "olderBrother" | "youngerBrother" | "brother"
      | "olderSister" | "youngerSister" | "sister"
      | "husband" | "wife" | "spouse"
      | "formerHusband" | "formerWife" | "formerSpouse";

    export interface KinshipSignature {
      steps: KinshipStep[];
      generationDelta: number;
      lineageSide: "paternal" | "maternal" | "self" | "affinity" | "unknown";
      bloodAffinity: "blood" | "currentAffinity" | "directFormerSpouse";
      viewpointGender: "male" | "female" | "unknown";
      targetGender: "male" | "female" | "unknown";
      relativeAgeOrder: "older" | "younger" | "same" | "unknown";
      pathPersonIds: string[];
      pathRelationIds: string[];
    }

    export interface RelationshipResult {
      primaryTerm: string | null;
      reverseTerm: string | null;
      description: string;
      ruleVersion: string;
      signature: KinshipSignature;
      alternatives: RelationshipAlternative[];
      uncertainty: string[];
    }

- [ ] **Step 2: Write failing path policy tests**

Tests assert:

- shortest paths are preferred;
- ties retain all equal-rank paths;
- direct facts rank before derived paths, blood paths before affinity, current marriage before any lower rank;
- an active spouse edge may be traversed;
- a divorced edge returns former spouse only when source and target are its endpoints;
- path search never traverses a divorced edge to reach another person;
- missing age produces brother/sister or parallel term output, never an invented older/younger result;
- a data conflict returns no term and links the conflict IDs.

- [ ] **Step 3: Implement graph search and signature normalization**

Use BFS with per-path visited person IDs. Continue only through the depth of the first result so all equal-length candidates are retained. Rank candidates by:

    direct fact = 0
    pure blood = 1
    current affinity = 2

Build forward and reverse signatures from the same actual path. Age order compares reliable normalized date ranges only; overlapping or lunar-unconverted ranges produce unknown.

- [ ] **Step 4: Create the versioned rule catalog**

mandarin-v1.json has:

    {
      "version": "mandarin-v1",
      "rules": [
        {
          "id": "direct-father",
          "pattern": { "steps": ["father"] },
          "forward": "父亲",
          "reverseByViewpointGender": {
            "male": "儿子",
            "female": "女儿",
            "unknown": "子女"
          }
        }
      ]
    }

Add explicit rules for parents, children, spouse, former spouse, grandparents, grandchildren, siblings with known/unknown age, paternal uncles/aunts, maternal uncles/aunts, nephews/nieces, first cousins, and direct current in-laws. Unmatched signatures return an exact path description and “称谓规则尚未覆盖”.

- [ ] **Step 5: Add at least 60 core cases and run them**

kinship-core-cases.v1.json contains explicit graph facts, viewpoint, target, expected forward term, expected reverse term and expected path IDs. Include direct, ancestor, sibling, paternal, maternal, cousin, affinity, divorce, unknown age, unknown gender and two-path examples.

Run:

    npm test -- tests/unit/domain/kinship

Expected: all core cases pass; every result contains the rule version and actual path IDs.

- [ ] **Step 6: Commit**

    git add app
    git commit -m "feat: add deterministic kinship engine"

---

### Task 8: Perspective Switching and Deterministic Query Tools

**Files:**
- Create: app/src/main/application/query/query-tool-registry.ts
- Create: app/src/main/application/query/search-people.ts
- Create: app/src/main/application/query/get-person.ts
- Create: app/src/main/application/query/list-relatives.ts
- Create: app/src/main/application/query/summarize-lineage.ts
- Create: app/src/main/application/query/search-wiki.ts
- Create: app/src/main/ipc/query-ipc.ts
- Create: app/src/renderer/src/app/ViewpointContext.tsx
- Create: app/src/renderer/src/features/chat/ChatPanel.tsx
- Modify: app/src/renderer/src/features/tree/PersonNode.tsx
- Test: app/tests/integration/application/query-tools.test.ts
- Test: app/tests/unit/renderer/ViewpointContext.test.tsx

**Interfaces:**
- Consumes: FactQueries, generation service and relationship calculator.
- Produces: six read-only tools and renderer perspective state independent of stored facts.

- [ ] **Step 1: Define the read-only tool signatures**

    search_people({ query, limit }): PersonCandidate[]
    get_person({ personId }): PersonReadModel
    list_relatives({ personId, kinds }): RelativeReadModel[]
    calculate_relationship({ viewpointId, targetId }): RelationshipResult
    summarize_lineage({ lineageId, generation? }): LineageSummary
    search_wiki({ query, limit }): WikiSearchHit[]

Register tools in a closed map keyed by these six names. No tool accepts SQL, file paths, table names or arbitrary filters. Before Task 11 adds FTS5, search_wiki uses a parameterized, escaped LIKE query over active wiki_entry title/body with limit capped at 20; Task 11 replaces only its repository implementation with FTS5 while preserving this interface and tests.

- [ ] **Step 2: Write query tool tests**

Create two people with the same name and assert search_people returns both with birth and parent hints. Verify get_person includes sources, list_relatives counts children correctly, calculate_relationship is bidirectional, and summarize_lineage excludes married-in members from blood-generation counts.

- [ ] **Step 3: Implement query tools and viewpoint state**

ViewpointContext stores viewpointId in renderer state and persists the latest selection per workspace in an allowed app setting. Changing it calls calculate_relationship for visible tree nodes and does not mutate any database fact. ChatPanel initially supports structured quick actions for the four required question classes and renders conclusion, matched people, sources and relationship path.

- [ ] **Step 4: Run tests**

    npm test -- tests/integration/application/query-tools.test.ts tests/unit/renderer/ViewpointContext.test.tsx
    npm run typecheck

Expected: duplicate names remain disambiguated, perspective switching changes labels only, and read tools have no mutation capability.

- [ ] **Step 5: Commit**

    git add app
    git commit -m "feat: add perspective-aware genealogy queries"

---

### Task 9: Spreadsheet Import, Preview, and Idempotent Re-import

**Files:**
- Create: app/src/main/application/import/import-types.ts
- Create: app/src/main/application/import/workbook-parser.ts
- Create: app/src/main/application/import/import-validator.ts
- Create: app/src/main/application/import/import-planner.ts
- Create: app/src/main/application/import/import-committer.ts
- Create: app/src/main/ipc/import-ipc.ts
- Create: app/src/renderer/src/features/import/ImportPage.tsx
- Create: app/src/renderer/src/features/import/FieldMappingStep.tsx
- Create: app/src/renderer/src/features/import/ImportPreview.tsx
- Create: app/tests/fixtures/import/valid-family.xlsx
- Create: app/tests/fixtures/import/missing-reference.csv
- Test: app/tests/integration/import/import-planner.test.ts
- Test: app/tests/integration/import/idempotent-reimport.test.ts

**Interfaces:**
- Consumes: UnitOfWork, FactCommandService and ImportIdentity repository.
- Produces: parseImport(file, sourceKey), ImportPlan, commitImport(planId, selectedActionIds), and template export.

- [ ] **Step 1: Install parser dependencies and define the fixed template**

    npm install exceljs csv-parse

The XLSX template has sheets and required identifiers:

- People: person_external_id, name, gender, birth_calendar, birth_year, birth_month, birth_day, birth_leap_month, notes
- ParentChild: parent_external_id, child_external_id, parent_role
- Marriages: spouse_a_external_id, spouse_b_external_id, status, start_calendar, start_year, start_month, start_day, end_calendar, end_year, end_month, end_day

CSV import accepts one entity type per file and requires the user to choose People, ParentChild or Marriages.

- [ ] **Step 2: Define preview types and write failing tests**

    export interface ImportPlan {
      id: string;
      sourceKey: string;
      actions: ImportAction[];
      issues: ImportIssue[];
      summary: { creates: number; updates: number; unchanged: number; blocked: number };
    }

    export type ImportIssueSeverity = "error" | "warning";

Tests cover missing external references, duplicate external IDs, same-name suggestions without auto-merge, parent cycles, invalid dates, and sourceKey reuse.

- [ ] **Step 3: Implement parser, planner, and diff behavior**

The planner resolves workspace + sourceKey + external ID through import_identity. Existing mappings generate field-by-field updates; unchanged rows remain unchanged. A same-name person without a mapping produces a suggestion issue and a separate create action, never an automatic merge.

- [ ] **Step 4: Implement atomic selected commit**

commitImport revalidates the plan against current row versions, then creates one operation group and one SQLite transaction. Any selected action failure rolls back the entire selected set. The report records each source row, created/updated entity ID and issue disposition.

- [ ] **Step 5: Add UI and run import verification**

The UI provides file selection, source key, field mapping, issue filtering, row exclusion, change diff, confirmation and final report. Re-import valid-family.xlsx twice with the same source key.

Run:

    npm test -- tests/integration/import

Expected: second import creates zero people, shows unchanged or update actions, and missing references never create partial relationships.

- [ ] **Step 6: Commit**

    git add app
    git commit -m "feat: add idempotent spreadsheet import"

---

### Task 10: Person Merge, ID Redirect, and Safe Unmerge

**Files:**
- Create: app/src/main/application/merge/merge-preview-service.ts
- Create: app/src/main/application/merge/person-merge-service.ts
- Create: app/src/main/application/merge/unmerge-service.ts
- Create: app/src/main/application/merge/duplicate-candidate-service.ts
- Create: app/src/main/database/repositories/merge-repository.ts
- Create: app/src/main/ipc/merge-ipc.ts
- Create: app/src/renderer/src/features/people/MergePreview.tsx
- Create: app/src/renderer/src/features/people/MergeHistory.tsx
- Test: app/tests/integration/merge/person-merge.test.ts
- Test: app/tests/integration/merge/unmerge.test.ts

**Interfaces:**
- Consumes: repositories, row_version and UnitOfWork.
- Produces: findDuplicateCandidates(personId), previewMerge(primaryId, secondaryId), mergePeople(decisions), resolveRedirect(id), canUnmerge(mergeId), unmerge(mergeId).

- [ ] **Step 1: Write failing merge tests**

The fixture gives the secondary person aliases, one parent, one child, one marriage, two lineage memberships, media and a source. Assert merge preview lists each category and every conflicting scalar field. After merge, all references use the primary ID, the secondary row is soft merged, and id_redirect resolves old ID to primary.

DuplicateCandidateService assigns explainable scores only from normalized name/alias overlap, compatible birth date, shared parents, spouse and children. It returns reasons and never merges automatically. Tests verify two same-name unrelated people remain separate and a strongly matching pair appears as a candidate.

- [ ] **Step 2: Implement snapshot-based merge**

    export interface MergeDecision {
      primaryPersonId: string;
      secondaryPersonId: string;
      scalarChoices: Record<string, "primary" | "secondary">;
      expectedVersions: Record<string, number>;
    }

Store snapshot_json with complete pre-merge rows and post_versions_json with the version of every changed row immediately after merge. Canonicalize self-duplicates created by migration, but reject a merge that would create self-parenting, self-marriage, a parent cycle or a second father/mother.

- [ ] **Step 3: Write and implement safe-unmerge tests**

Unmerge is allowed only when every affected row still has its recorded post-merge version. If any affected row changed, canUnmerge returns allowed=false with exact entity IDs and no restoration occurs. A safe unmerge restores the snapshot in one transaction, removes the redirect, changes merge status to reversed and appends audit rows.

- [ ] **Step 4: Implement preview and history UI**

The people page exposes “疑似重复” results with score reasons. The preview shows scalar choices plus parents, spouses, children, lineages, media and sources. MergeHistory lists reversible and blocked merges with reasons. It never labels an operation reversible before the main process performs canUnmerge.

- [ ] **Step 5: Run tests**

    npm test -- tests/integration/merge
    npm run typecheck

Expected: reference migration, redirects, invariant protection, complete safe unmerge and conservative blocking all pass.

- [ ] **Step 6: Commit**

    git add app
    git commit -m "feat: add reversible person merge"

---

### Task 11: Managed Media and Wiki Full-Text Search

**Files:**
- Create: app/src/main/media/media-service.ts
- Create: app/src/main/media/media-protocol.ts
- Create: app/src/main/database/migrations/002-wiki-fts.ts
- Create: app/src/main/application/wiki/wiki-service.ts
- Create: app/src/main/ipc/media-ipc.ts
- Create: app/src/main/ipc/wiki-ipc.ts
- Create: app/src/renderer/src/features/wiki/WikiPage.tsx
- Create: app/src/renderer/src/features/wiki/WikiEditor.tsx
- Create: app/src/renderer/src/features/people/MediaGallery.tsx
- Test: app/tests/integration/media/media-service.test.ts
- Test: app/tests/integration/wiki/wiki-search.test.ts

**Interfaces:**
- Consumes: WorkspacePaths, path boundary guard, repositories and source/audit transactions.
- Produces: importMedia, attachMedia, read media through app-media protocol, wiki CRUD, and search_wiki results with source IDs.

- [ ] **Step 1: Write path and deduplication tests**

Import the same image twice and assert one physical SHA-256 object plus two allowed links. Try a path outside the user-selected source file and media root after import and expect PATH_DENIED. Try an unsupported executable MIME/extension and expect VALIDATION.

- [ ] **Step 2: Implement managed media storage**

Use:

    media/<first-two-hash-characters>/<sha256>.<normalized-extension>

Allow image/jpeg, image/png, image/webp, audio/mpeg, audio/wav, audio/mp4 and audio/ogg. Stream the source through SHA-256, copy to a temporary file in the destination directory, fsync and rename. Store only the relative path. app-media protocol resolves only registered MediaAsset IDs and sets the stored MIME type.

- [ ] **Step 3: Add FTS5 migration and tests**

Migration 002 creates wiki_fts using FTS5 with title and body, plus insert/update/delete triggers tied to active wiki_entry rows. Tests create two entries, search Chinese terms, update one entry and soft-delete the other, then verify source-linked results are current.

- [ ] **Step 4: Implement Wiki and media UI**

WikiEditor supports title, body, linked people and source. MediaGallery supports add, caption, play audio and view image. Free text never creates Person or relation facts. search_wiki returns title, bounded excerpt, wikiEntryId and source IDs.

- [ ] **Step 5: Run tests**

    npm test -- tests/integration/media tests/integration/wiki
    npm run typecheck

Expected: managed storage, deduplication, path denial, FTS updates and source-bearing search all pass.

- [ ] **Step 6: Commit**

    git add app
    git commit -m "feat: add managed media and family wiki"

---

### Task 12: Controlled Online LLM, Draft Confirmation, and Conversational Answers

**Files:**
- Create: app/src/main/security/credential-vault.ts
- Create: app/src/main/llm/model-adapter.ts
- Create: app/src/main/llm/openai-responses-adapter.ts
- Create: app/src/main/llm/prompts/extract-facts.ts
- Create: app/src/main/llm/prompts/answer-question.ts
- Create: app/src/main/application/chat/context-minimizer.ts
- Create: app/src/main/application/chat/conversation-service.ts
- Create: app/src/main/application/chat/draft-service.ts
- Create: app/src/main/ipc/chat-ipc.ts
- Create: app/src/renderer/src/features/chat/OnlineModelDisclosure.tsx
- Create: app/src/renderer/src/features/chat/MutationDraftPreview.tsx
- Create: app/src/renderer/src/features/settings/ModelSettings.tsx
- Modify: app/src/renderer/src/features/chat/ChatPanel.tsx
- Test: app/tests/unit/llm/context-minimizer.test.ts
- Test: app/tests/integration/chat/draft-confirmation.test.ts
- Test: app/tests/e2e/conversation-entry.spec.ts

**Interfaces:**
- Consumes: six read-only query tools, FactCommandService, safeStorage and shared Zod schemas.
- Produces: ModelAdapter.extractDraft(), ModelAdapter.continueWithTools(), ConversationService.ask(), DraftService.confirm(), and encrypted key settings.

- [ ] **Step 1: Install the model SDK and define the provider-neutral interface**

    npm install openai

    export interface ModelAdapter {
      extractDraft(input: {
        text: string;
        candidatePeople: PersonCandidate[];
      }): Promise<ConversationMutationDraft>;
      continueWithTools(input: {
        question: string;
        viewpointId: string;
        selectedPersonId: string | null;
        toolResults: ToolResult[];
      }): Promise<ModelTurn>;
    }

ConversationMutationDraft contains candidate people, aliases, dates, parent-child facts, marriages, sources, confidence per field and unresolved references. It contains no SQL or repository operation.

- [ ] **Step 2: Write failing disclosure, minimization and no-write tests**

Assert:

- a model call cannot start until the renderer confirms the OnlineModelDisclosure payload;
- context-minimizer includes only current question, selected/viewpoint IDs, needed candidate summaries and relevant tool results;
- it excludes unrelated people, media bytes, local paths, model key and audit history;
- a fake model returning a valid draft changes zero database rows before DraftService.confirm;
- unresolved duplicate names prevent confirm;
- provider failure returns MODEL_UNAVAILABLE while deterministic query tools still work.

验收语义必须保持明确：模型不可用时，表单、表格、家谱浏览和确定性称谓查询仍可使用。

- [ ] **Step 3: Implement CredentialVault with async safeStorage**

CredentialVault stores the encrypted buffer at the app user-data secrets directory, never the workspace. saveKey calls safeStorage.encryptStringAsync; readKey calls decryptStringAsync and re-encrypts when shouldReEncrypt is true. If encryption is unavailable, saving fails with a clear error and never writes plaintext.

- [ ] **Step 4: Implement the OpenAI Responses adapter**

The adapter uses the official SDK in the main process, passes the configured model and strict JSON schema, and parses response.output_text with the same Zod schema used by IPC. Read-only tool calls are matched against QueryToolRegistry; unknown tool names and malformed arguments are rejected. The API key is provided at construction and never interpolated into prompts or logs.

- [ ] **Step 5: Implement write draft validation and confirmation**

DraftService resolves candidates, runs the same domain validators as manual entry, and returns a diff with creates, updates, warnings, conflicts and unresolved references. confirm(draftId, selectedChangeIds, expectedVersions) revalidates and commits all selected changes in one UnitOfWork. Editing the draft creates a new immutable draft version.

- [ ] **Step 6: Implement conversational query loop**

ConversationService uses LLM only to select among the six read tools and phrase the result. It returns:

    {
      answer: string;
      matchedPersonIds: string[];
      sourceIds: string[];
      relationship: RelationshipResult | null;
      toolTrace: { name: string; arguments: unknown }[];
    }

The UI shows the online-call disclosure before each send, lets the user cancel, renders source/path evidence, and exposes “确认写入” only for fully resolved mutation drafts.

- [ ] **Step 7: Run tests**

    npm test -- tests/unit/llm tests/integration/chat
    npm run test:e2e -- tests/e2e/conversation-entry.spec.ts

Expected: the sentence “张国强有两个孩子……” becomes a preview, remains uncommitted until confirmation, and then writes atomically; model outage does not break local features.

- [ ] **Step 8: Commit**

    git add app
    git commit -m "feat: add controlled conversational agent"

---

### Task 13: Undo, Backup, Integrity Verification, and Restore

**Files:**
- Create: app/src/main/application/audit/undo-service.ts
- Create: app/src/main/application/backup/backup-manifest.ts
- Create: app/src/main/application/backup/backup-service.ts
- Create: app/src/main/application/backup/restore-service.ts
- Create: app/src/main/application/export/export-service.ts
- Create: app/src/main/ipc/data-management-ipc.ts
- Create: app/src/renderer/src/features/settings/DataManagementPage.tsx
- Create: app/src/renderer/src/features/settings/AuditHistory.tsx
- Create: app/src/renderer/src/features/settings/PrivacyWarning.tsx
- Test: app/tests/integration/audit/undo.test.ts
- Test: app/tests/integration/backup/backup-restore.test.ts
- Test: app/tests/integration/backup/tampered-backup.test.ts
- Test: app/tests/integration/export/export-workspace.test.ts

**Interfaces:**
- Consumes: operation groups, audit snapshots, WorkspaceManager and managed media.
- Produces: undoOperationGroup, createBackup, inspectBackup, restoreBackup, exportWorkspace and privacy-warning UI.

- [ ] **Step 1: Install archive dependencies and define the manifest**

    npm install archiver extract-zip
    npm install --save-dev @types/archiver

    export interface BackupManifest {
      formatVersion: 1;
      workspaceId: string;
      workspaceName: string;
      schemaVersion: number;
      createdAt: string;
      files: Array<{ path: string; size: number; sha256: string }>;
      counts: {
        people: number;
        parentChild: number;
        marriages: number;
        wikiEntries: number;
        auditRows: number;
        mediaAssets: number;
      };
    }

- [ ] **Step 2: Write failing undo and restore tests**

Undo tests cover a manual edit, confirmed conversation draft and spreadsheet import. A current row-version mismatch blocks the whole undo. Backup tests create facts, Wiki and media, then restore to a fresh workspace and compare every manifest count and hash. A modified archive entry must fail before any active workspace file is replaced.

Export tests verify exportWorkspace creates a directory containing people.csv, parent-child.csv, marriages.csv, lineages.csv, wiki.json, media-manifest.json and copied media; IDs and original date/calendar fields remain intact, and no model key or absolute local path appears.

- [ ] **Step 3: Implement conservative operation-group undo**

Undo reads audit rows in reverse order, verifies current versions match the expected after state, and applies before_json inside one transaction. It marks operation_group.undone_at only after success. Merge reversal continues to use UnmergeService rather than generic undo.

- [ ] **Step 4: Implement backup and restore staging**

Before backup, checkpoint WAL. Write database, media files, workspace manifest and backup manifest into a temporary ZIP, hash each payload, then atomically rename. Restore extracts to a new temporary directory, rejects absolute paths, drive letters and parent traversal, validates all sizes/hashes and runs migrations on a copy. Before replacing an existing workspace, create an automatic snapshot; replacement uses directory rename so partial restore cannot become active.

- [ ] **Step 5: Implement data-management UI**

Backup and export actions always show: “该文件未加密，包含家族隐私资料。” ExportService writes UTF-8 CSV with headers, Wiki JSON and a relative media manifest to a user-selected empty directory using a staging directory and atomic rename. The screen lists backup time, schema version, counts and verification state. Restore requires the user to select target workspace and confirm replacement after validation.

- [ ] **Step 6: Run tests**

    npm test -- tests/integration/audit tests/integration/backup tests/integration/export
    npm run typecheck

Expected: atomic undo, exact restore, tamper rejection, traversal rejection and privacy warning tests pass.

- [ ] **Step 7: Commit**

    git add app
    git commit -m "feat: add verified backup restore and undo"

---

### Task 14: Complete Information Architecture and End-to-End Core Loop

**Files:**
- Create: app/src/renderer/src/app/AppRouter.tsx
- Create: app/src/renderer/src/app/AppShell.tsx
- Create: app/src/renderer/src/app/WorkspaceContext.tsx
- Create: app/src/renderer/src/features/home/HomePage.tsx
- Create: app/src/renderer/src/features/lineages/LineageSettings.tsx
- Create: app/src/renderer/src/features/settings/SettingsPage.tsx
- Create: app/src/renderer/src/features/import/EntryCenterPage.tsx
- Create: app/src/renderer/src/app/ErrorBoundary.tsx
- Modify: app/src/renderer/src/App.tsx
- Test: app/tests/e2e/core-loop.spec.ts
- Test: app/tests/e2e/workspace-isolation.spec.ts
- Test: app/tests/e2e/model-outage.spec.ts

**Interfaces:**
- Consumes: all application-facing IPC from Tasks 2–13.
- Produces: the six final first-level areas and a complete record → browse → infer → ask → correct → backup workflow.

- [ ] **Step 1: Build the six-area application shell**

Routes are:

    /                         首页
    /workspace/:id/tree       家谱树
    /workspace/:id/people     人物库
    /workspace/:id/entry      录入中心
    /workspace/:id/wiki       家族 Wiki
    /workspace/:id/settings   设置与数据

AppShell shows current workspace, current viewpoint, global person search and the six navigation entries. Deep links validate that route workspaceId equals the open workspace.

- [ ] **Step 2: Add global error and loading behavior**

ErrorBoundary renders a recoverable message and diagnostic ID without facts, model keys or paths. Every async screen distinguishes initial load, empty state, validation problem, conflict and internal failure. Destructive operations show exact affected entities and require confirmation.

- [ ] **Step 3: Write the integrated core-loop E2E test**

The test:

1. creates a workspace;
2. imports or manually enters five people;
3. adds parent and marriage facts;
4. opens the family tree;
5. switches viewpoint;
6. verifies a deterministic kinship label and path;
7. asks how many children a person has;
8. edits a wrong birth month and checks audit history;
9. creates a backup;
10. reloads the app and verifies persistence.

- [ ] **Step 4: Write isolation and outage E2E tests**

Create two workspaces with different people and media; assert search, tree, Wiki and backup never cross. Configure the fake model to fail and verify forms, spreadsheet import, tree browsing and deterministic calculate_relationship remain usable.

- [ ] **Step 5: Run the full functional suite**

    npm run typecheck
    npm test
    npm run test:e2e

Expected: all unit, integration and E2E tests exit 0 with no skipped core-loop test.

- [ ] **Step 6: Commit**

    git add app
    git commit -m "feat: complete genealogy MVP workflow"

---

### Task 15: Beta Quality Gates, 300 Golden Cases, Performance, Security, and Packaging

**Files:**
- Create: app/tests/fixtures/kinship-golden-cases.v1.json
- Create: app/tests/unit/domain/kinship/golden-matrix.test.ts
- Create: app/scripts/generate-benchmark-workspace.ts
- Create: app/scripts/run-performance-gates.ts
- Create: app/tests/performance/performance-gates.test.ts
- Create: app/tests/e2e/security-boundary.spec.ts
- Create: app/scripts/smoke-packaged-app.ts
- Create: app/docs/user-acceptance-checklist.md
- Modify: app/electron-builder.yml
- Modify: app/package.json

**Interfaces:**
- Consumes: completed application.
- Produces: auditable correctness matrix, reproducible 1000-person benchmark, security evidence, NSIS installer and final acceptance record.

- [ ] **Step 1: Expand the kinship oracle to exactly 300 explicit cases**

Use this reviewed distribution:

| 分类 | 案例数 |
|---|---:|
| 直接父母/子女/配偶 | 30 |
| 祖先与后代 | 30 |
| 兄弟姐妹 | 24 |
| 父系旁系 | 36 |
| 母系旁系 | 36 |
| 堂表亲 | 42 |
| 当前姻亲 | 36 |
| 离婚与再婚 | 18 |
| 长幼未知 | 18 |
| 性别未知 | 15 |
| 多路径关系 | 15 |
| 合计 | 300 |

Each case explicitly stores facts, viewpoint, target, expected forward term, expected reverse term, expected uncertainty and expected traversed relation IDs. Every category includes forward, reverse and missing-information cases. golden-matrix.test.ts asserts total=300, every listed category count, both directions, rule version and no unreviewed snapshot update.

- [ ] **Step 2: Generate a deterministic 1000-person benchmark**

The generator uses seed 20260916 and creates:

- 1000 people;
- at least 8 generations;
- multiple lineages;
- at least 80 divorces and 80 remarriages;
- single-parent and unmarried co-parent groups;
- aliases, Wiki entries and media metadata without large binary payloads.

Write the generated workspace to a temporary directory on each performance run; do not commit a database binary.

- [ ] **Step 3: Implement performance gates**

Measure after one warm-up:

    default tree projection and ELK layout <= 2000 ms
    viewpoint relabel <= 500 ms
    calculate_relationship P95 over 200 fixed pairs <= 300 ms
    1000-row import preview <= 30000 ms

The script prints median, P95, maximum, machine CPU count and memory. It exits nonzero when a threshold fails.

- [ ] **Step 4: Add Electron security tests**

Verify:

- renderer window.require, window.process and direct Electron imports are unavailable;
- sandbox and context isolation are enabled;
- CSP blocks inline script and unapproved remote origins;
- window.open and navigation to an unapproved URL are denied;
- unknown IPC channels are unreachable from DesktopApi;
- malformed IDs and path traversal are rejected in main;
- model key plaintext is absent from workspace DB, logs, backup ZIP and crash-report staging.

- [ ] **Step 5: Configure and smoke-test the Windows package**

electron-builder.yml must:

- target NSIS x64;
- include out/ and production dependencies;
- unpack node_modules/better-sqlite3/** from ASAR;
- run native dependency rebuild through postinstall;
- exclude tests, fixtures, source maps, local workspaces and secrets.

Run:

    npm run test:coverage
    npm run test:e2e
    npm run build
    npm run package:win
    npx tsx scripts/run-performance-gates.ts
    npx tsx scripts/smoke-packaged-app.ts

Expected: all tests and gates exit 0; installer launches, creates a workspace, reopens it, and uninstalls without deleting user workspaces.

- [ ] **Step 6: Run the usability acceptance**

Give app/docs/user-acceptance-checklist.md to a non-technical tester. The timed script asks them to create a five-person family, correct one field, switch viewpoint and query a relationship without reading documentation. Record elapsed time and blockers; Beta passes only when completion is within 10 minutes.

- [ ] **Step 7: Final scope and artifact audit**

Confirm the build does not contain account systems, cloud sync, adoption/step-parent facts, dialect packs, historical as-of queries, local model bundles, application passwords or encrypted-backup claims. Confirm the output includes the NSIS installer, its SHA-256, test report, performance report and acceptance checklist.

- [ ] **Step 8: Commit**

    git add app
    git commit -m "release: validate family agent beta"

---

## Spec Coverage Matrix

| Spec area | Implemented by |
|---|---|
| Multiple isolated local workspaces | Tasks 2, 3, 13, 14 |
| Manual person/relationship entry and dates | Tasks 3, 4, 5 |
| Excel/CSV preview and idempotent re-import | Task 9 |
| Conversational entry with confirmation | Task 12 |
| Lineages, declared/computed generations | Task 6 |
| Divorce, remarriage and FamilyUnion | Tasks 4, 6 |
| Full/branch/ancestor/descendant visualization | Task 6 |
| Current perspective and deterministic naming | Tasks 7, 8 |
| Attribute, count, relationship and lineage Q&A | Tasks 8, 12 |
| Media, Wiki and source-bearing narrative search | Task 11 |
| Duplicate detection, merge and unmerge | Tasks 9, 10 |
| Audit, undo, backup and restore | Tasks 3, 13 |
| LLM boundaries, minimization and model outage | Tasks 8, 12, 14 |
| Electron local security | Tasks 1, 2, 11, 12, 15 |
| 300 cases, 1000-person performance and packaging | Task 15 |

## Execution Order and Checkpoints

- Checkpoint A after Task 5: a persisted five-person family can be created and edited.
- Checkpoint B after Task 8: the tree, viewpoint switch, deterministic kinship and structured local queries work without an online model.
- Checkpoint C after Task 12: spreadsheet and conversational input both produce previewed, confirmed facts.
- Checkpoint D after Task 14: all product loops work together and backups restore correctly.
- Beta gate after Task 15: correctness, performance, security, usability and installer checks all pass.

Do not begin the next checkpoint while the current checkpoint has failing tests. Do not consume the risk buffer to add features; use it only for the four documented engineering risks: native dependency/packaging compatibility, kinship regression correction, 1000-person performance optimization and necessary UI rework from acceptance feedback.

## Primary Technical References

- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Electron context isolation: https://www.electronjs.org/docs/latest/tutorial/context-isolation
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- electron-vite guide: https://electron-vite.org/guide/
- Playwright Electron API: https://playwright.dev/docs/api/class-electron
- React Flow layout guidance: https://reactflow.dev/learn/layouting/layouting
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- electron-builder native modules: https://www.electron.build/docs/troubleshooting/
- OpenAI structured outputs: https://developers.openai.com/api/docs/guides/structured-outputs
