# 父母关系自动补全与关系维护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员以人物为中心只录入一侧生物学父母，系统依据已确认婚姻生成可解释、可取消的另一侧父母建议，并支持历史数据批量修复、关系更正、软删除和撤销。

**Architecture:** 在现有 SQLite 事实层增加亲子关系来源元数据；抽取可复用的部分日期区间判断并建立纯领域 `ParentCompletionPlanner`；由应用服务把数据库事实转换为确定性规划结果；统一暂存服务将 `parentFamily.add` 展开为明确关系和可选自动关系，并在确认时重算规划指纹；React 人物详情以当前人物为中心维护父母、配偶和多个子女，历史修复也复用相同规划、预览、事务和审计路径。

**Tech Stack:** TypeScript、React 19、Fastify 5、SQLite/better-sqlite3、Zod、Vitest、Testing Library、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-01-parent-auto-completion-design.md`

## Global Constraints

- 首版只持久化生父、生母和生物学子女；不新增继父母、养父母、收养或监护类型。
- 自动补全只依据已确认婚姻，不根据性别、姓名、称谓或同住信息创建人物或婚姻。
- 人工明确关系优先；自动项不得覆盖已有父亲或母亲，也不得阻止合法明确关系单独保存。
- 无配偶、日期不足、历法不同或多配偶无法唯一判断时不得猜测；允许仅保存明确关系。
- 自动建议在确认前默认勾选、可取消、可解释；确认后是普通有效事实，但保留 `origin_kind` 和可选婚姻来源。
- 预览后相关人物出生日期、婚姻或亲子关系发生变化时，确认必须整体返回 `CONFLICT`，不得部分提交。
- 关系更正由“软删除旧关系 + 新增明确关系”组成，同一事务、同一操作组，能够整体撤销。
- 历史扫描严格只读；只有管理员选择建议并完成统一预览确认后才允许写库。
- 保留现有低层 `parentChild.add` 作为明确事实入口；普通表单和对话入口改用高层规则，Excel 中明确列出的亲子行仍按明确事实导入。
- 必须保留 Electron 兼容适配器可编译，但本功能以 Web 页面验收为准。
- 1000 人谱册的一次全量未完整父母扫描目标为 1 秒内完成，且不得产生重复建议或隐式写入。

## Review Focus

- 同一对配偶存在多段婚姻且无法定位具体婚姻事件时，仍应唯一识别配偶人物，并将 `inferred_from_marriage_id` 留空；由 Task 2 的领域测试固定。
- 孩子的互补父母角色已被另一人物占用时，自动项必须阻断但合法明确关系仍可提交；由 Task 4 的暂存服务测试固定。
- 预览后婚姻、孩子出生日期或相关亲子边变化时必须返回 `PARENT_COMPLETION_STALE/CONFLICT` 且零部分写入；由 Task 4 的并发测试固定。
- 移除自动补全亲子关系不得删除婚姻，撤销只能恢复该操作组中的关系；由 Task 5 的删除、更正和撤销测试固定。
- 1000 人扫描必须去重、扫描阶段零写入，任一并发冲突必须阻止整批确认；由 Task 7 和 Task 9 的集成、性能测试固定。

---

## File Structure

新增或调整的核心职责：

- `app/src/main/database/migrations/007-parent-completion-metadata.ts`：亲子来源字段及索引。
- `app/src/main/domain/relations/partial-date-interval.ts`：公历/农历内部一致的保守部分日期区间判断。
- `app/src/main/domain/relations/parent-completion-planner.ts`：纯函数式父母补全规划，不读写数据库。
- `app/src/main/application/relations/parent-completion-service.ts`：从仓储装配单条规划、规划指纹和历史扫描。
- `app/src/main/application/mutations/staged-mutation-service.ts`：展开高层意图、可选项依赖、确认时重规划和原子提交。
- `app/src/renderer/src/features/relations/FamilyRelationsPanel.tsx`：人物中心的父母、配偶、子女维护。
- `app/src/renderer/src/features/relations/ParentCompletionRepairPanel.tsx`：历史数据扫描、选择和统一预览入口。

现有 `FactCommandService`、`UnitOfWork`、`UndoService`、`MutationReviewDialog`、树投影和称谓计算继续复用已确认的亲子事实，不新建第二套关系存储。

### Task 1: 为亲子事实增加来源元数据

**Files:**
- Create: `app/src/main/database/migrations/007-parent-completion-metadata.ts`
- Modify: `app/src/main/database/migrations/index.ts`
- Modify: `app/src/main/database/repositories/relation-repository.ts`
- Modify: `app/src/main/application/facts/fact-commands.ts`
- Modify: `app/src/main/application/facts/fact-command-service.ts`
- Modify: `app/src/main/application/audit/undo-service.ts`
- Modify: `app/tests/integration/database/migrations.test.ts`
- Create: `app/tests/integration/database/parent-completion-migration.test.ts`
- Modify: `app/tests/integration/audit/undo.test.ts`

**Interfaces:**
- `ParentChildOriginKind = "explicit" | "spouse_default"`.
- `ParentChildRecord` adds `originKind` and `inferredFromMarriageId`.
- Internal `ParentChildDraft` accepts `originKind?: ParentChildOriginKind` and `inferredFromMarriageId?: string | null`; omitted values mean an explicit fact.
- Migration 7 adds `origin_kind TEXT NOT NULL DEFAULT 'explicit' CHECK (...)`, nullable `inferred_from_marriage_id REFERENCES marriage(id)`, and an index on the nullable marriage reference.

- [ ] **Step 1: Write failing migration and repository tests**

```ts
it("backfills old parent-child rows as explicit", () => {
  const database = versionSixDatabaseWithParent();
  expect(applyMigrations(database)).toBe(7);
  expect(database.prepare("SELECT origin_kind, inferred_from_marriage_id FROM parent_child").get())
    .toEqual({ origin_kind: "explicit", inferred_from_marriage_id: null });
});

it("round-trips spouse-default provenance", () => {
  const relation = relations.createParentChild(ctx, {
    parentId: "mother", childId: "child", parentRole: "mother",
    originKind: "spouse_default", inferredFromMarriageId: "marriage-1"
  });
  expect(relation).toMatchObject({ originKind: "spouse_default", inferredFromMarriageId: "marriage-1" });
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `cd app; npm test -- tests/integration/database/migrations.test.ts tests/integration/database/parent-completion-migration.test.ts tests/integration/audit/undo.test.ts`

Expected: FAIL because schema version 7 and provenance fields do not exist.

- [ ] **Step 3: Implement migration, repository mapping and explicit defaults**

Keep low-level callers source-compatible by defaulting missing provenance to `explicit` and `null`. Validate that `spouse_default` may reference only a non-deleted active or divorced marriage from the same workspace; `explicit` must store a null inferred marriage ID.

- [ ] **Step 4: Extend audit snapshots and undo restore SQL**

Add the two fields to `parentChildSchema`, read mapping and restore statement. Verify an archived inferred relation restores with exactly the same provenance and does not mutate the marriage row.

- [ ] **Step 5: Run focused tests and type checking**

Run: `cd app; npm test -- tests/integration/database tests/integration/audit/undo.test.ts`

Run: `cd app; npm run typecheck:web`

Expected: PASS; genuine version-6 databases migrate once to version 7 and repeated `applyMigrations` is idempotent.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/database app/src/main/application/facts app/src/main/application/audit app/tests/integration/database app/tests/integration/audit/undo.test.ts
git commit -m "feat: store parent completion provenance"
```

### Task 2: 建立纯领域父母补全规划器

**Files:**
- Create: `app/src/main/domain/relations/partial-date-interval.ts`
- Create: `app/src/main/domain/relations/parent-completion-planner.ts`
- Create: `app/tests/unit/domain/parent-completion-planner.test.ts`
- Modify: `app/src/main/domain/projection/family-union-projector.ts`
- Modify: `app/tests/unit/domain/family-union-projector.test.ts`

**Interfaces:**
- `relationToPartialDateInterval(subject, start, end): "inside" | "outside" | "unknown"`.
- `ParentCompletionPlan` returns `status`, `explicit`, optional `suggested`, `basis`, deduplicated candidates, issue codes and deterministic evidence IDs.
- `basis` is `unique_spouse | birth_interval | administrator_selected | null`.
- `status` is `suggested | no_candidate | ambiguous | unchanged | conflict`.

- [ ] **Step 1: Write the failing decision-table tests**

Cover: no spouse; one spouse; the same spouse across multiple marriage episodes; multiple spouse people with one unique birth interval; missing birth; overlapping intervals; different calendars; existing same complementary parent; existing different complementary parent; administrator-selected valid/invalid spouse; gender mismatch warning.

```ts
it("deduplicates repeated marriages to the same spouse without inventing an episode", () => {
  const plan = planner.plan(inputWithTwoEpisodesForSameSpouse());
  expect(plan).toMatchObject({
    status: "suggested",
    basis: "unique_spouse",
    suggested: { parentId: "spouse", inferredFromMarriageId: null }
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd app; npm test -- tests/unit/domain/parent-completion-planner.test.ts tests/unit/domain/family-union-projector.test.ts`

Expected: FAIL because the shared interval module and planner do not exist.

- [ ] **Step 3: Extract the existing conservative interval logic**

Move the private calendar range comparison from `FamilyUnionProjector` into `partial-date-interval.ts`. Preserve existing solar month length, lunar leap-month order, month precision and cross-calendar `unknown` behavior before adding new planner logic.

- [ ] **Step 4: Implement the deterministic planner**

Group marriages by spouse person before choosing. Only `inside` plus every alternative `outside` permits birth-based auto-selection. A manually selected spouse must be among the recorded spouse candidates. Compute the complementary role from the explicit role; gender only creates a warning.

- [ ] **Step 5: Run the domain suite**

Run: `cd app; npm test -- tests/unit/domain/parent-completion-planner.test.ts tests/unit/domain/family-union-projector.test.ts`

Expected: PASS with no changed family-union behavior.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/domain/relations app/src/main/domain/projection/family-union-projector.ts app/tests/unit/domain
git commit -m "feat: plan spouse-based parent completion"
```

### Task 3: 暴露单条规划和只读历史扫描

**Files:**
- Create: `app/src/main/application/relations/parent-completion-service.ts`
- Create: `app/tests/integration/application/parent-completion-service.test.ts`
- Modify: `app/src/shared/contracts.ts`
- Modify: `app/src/shared/api-schemas.ts`
- Modify: `app/src/main/application/facts/facts-gateway.ts`
- Modify: `app/src/main/ipc/facts-ipc.ts`
- Modify: `app/src/preload/index.ts`
- Modify: `app/src/server/runtime/family-agent-service.ts`
- Modify: `app/src/server/http/rpc-router.ts`
- Modify: `app/tests/integration/ipc/facts-ipc.test.ts`
- Modify: `app/tests/integration/server/rpc-api.test.ts`

**Interfaces:**
- `relations.planParentCompletion({ knownParentId, childId, parentRole, selectedSpouseId? })` returns `ParentCompletionPlanDto`.
- `relations.scanParentCompletions()` returns counts plus one deduplicated item per child with exactly one active biological parent.
- Candidate DTOs contain person ID/name, marriage episode IDs/status/date ranges and human-readable Chinese reasoning; they never expose database paths.
- The application service returns a private deterministic `planningFingerprint` for staged confirmation but public DTOs expose only evidence records.

- [ ] **Step 1: Write failing service tests**

Assert that planning is read-only, scans only one-parent children, skips two-parent children, deduplicates duplicate marriage episodes, classifies safe/ambiguous/no-candidate/conflict, and produces stable ordering by child name then ID.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `cd app; npm test -- tests/integration/application/parent-completion-service.test.ts tests/integration/ipc/facts-ipc.test.ts tests/integration/server/rpc-api.test.ts`

- [ ] **Step 3: Implement the application service in one repository pass**

Load people, active parent-child edges and marriages once, index them in memory, and reuse one planner instance. Build the fingerprint from relevant person IDs/row versions/birth values, active parent relation IDs/versions and spouse marriage IDs/versions so additions, removals and updates all change it.

- [ ] **Step 4: Add shared schemas and Web/Electron adapters**

Validate all IDs and optional selection on both IPC and HTTP boundaries. Route both methods through `WorkspaceMutationGate` as read operations so they cannot race a database replacement.

- [ ] **Step 5: Verify contracts and read-only behavior**

Run: `cd app; npm test -- tests/integration/application/parent-completion-service.test.ts tests/integration/ipc tests/integration/server/rpc-api.test.ts`

Run: `cd app; npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add app/src/shared app/src/main/application/relations app/src/main/application/facts/facts-gateway.ts app/src/main/ipc app/src/preload app/src/server app/tests/integration/application app/tests/integration/ipc app/tests/integration/server/rpc-api.test.ts
git commit -m "feat: expose parent completion planning"
```

### Task 4: 将高层亲子意图接入统一暂存与原子确认

**Files:**
- Modify: `app/src/shared/mutations.ts`
- Modify: `app/src/shared/api-schemas.ts`
- Modify: `app/src/main/application/mutations/staged-mutation-service.ts`
- Modify: `app/src/renderer/src/features/mutations/MutationReviewDialog.tsx`
- Modify: `app/tests/integration/application/staged-mutation-service.test.ts`
- Modify: `app/tests/unit/renderer/MutationReviewDialog.test.tsx`
- Modify: `app/tests/integration/ipc/ipc-contracts.test.ts`

**Interfaces:**
- Add `parentFamily.add` with `knownParentId`, `childId`, `parentRole`, `completionPolicy: "spouse-default"`, optional `selectedSpouseId`, optional `skipCompletion`, and `sourceDescription`.
- `MutationChange` adds `originKind`, `selectedByDefault`, and `dependsOnChangeIds`; existing actionable changes default to selected.
- `MutationIssue.severity` adds `info`; info messages do not require acknowledgement.
- Export one bounded limit for at most 1000 intents and at most 2000 expanded changes.

- [ ] **Step 1: Write failing expansion and selection tests**

Test one high-level intent expanding into explicit + inferred changes; both default selected; cancelling inferred saves only explicit; inferred cannot be selected without a new explicit dependency; an already-existing explicit relation may leave only the inferred item actionable.

- [ ] **Step 2: Write failing conflict and stale tests**

```ts
it("keeps an explicit relation committable when the inferred role conflicts", () => {
  const preview = service.stage({ intents: [parentFamilyIntent] });
  expect(preview.changes).toMatchObject([
    { originKind: "explicit", disposition: "create" },
    { originKind: "spouse_default", disposition: "blocked" }
  ]);
  expect(preview.canConfirm).toBe(true);
});

it.each(["marriage", "child-birth", "parent-edge"])("rejects stale %s evidence atomically", (kind) => {
  const preview = stageFamily();
  mutateEvidence(kind);
  expect(() => confirmAll(preview)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  expect(activeParentRows()).toEqual([]);
});
```

- [ ] **Step 3: Run focused tests and verify they fail**

Run: `cd app; npm test -- tests/integration/application/staged-mutation-service.test.ts tests/unit/renderer/MutationReviewDialog.test.tsx tests/integration/ipc/ipc-contracts.test.ts`

- [ ] **Step 4: Refactor compilation to emit one or more internal changes**

Change `compile()` to return an array and flatten all intent results. For `parentFamily.add`, call `ParentCompletionService`, create a low-level explicit command, then an optional `spouse_default` command or a non-actionable informational/blocked change. Preserve source descriptions separately and put both selected writes in the existing `mutation.confirm` unit of work.

- [ ] **Step 5: Enforce selection dependencies and confirmation-time re-planning**

Store the planner input and fingerprint in the server-side draft. Before any write, recompute every high-level plan and compare fingerprints/results. Do not trust client-supplied candidate or origin metadata. Validate the selected change dependency graph before opening writes.

- [ ] **Step 6: Update the generic review dialog**

Render `人工录入` and `系统自动补全` badges, Chinese basis text, non-acknowledged info notices, default selections and dependency-safe checkboxes. Blocked automatic items remain visible but unselectable; their errors must name the child, existing parent and suggested parent.

- [ ] **Step 7: Run focused and mutation regression tests**

Run: `cd app; npm test -- tests/integration/application/staged-mutation-service.test.ts tests/integration/ipc/ipc-contracts.test.ts tests/unit/renderer/MutationReviewDialog.test.tsx`

Run: `cd app; npm run typecheck:web`

- [ ] **Step 8: Commit**

```bash
git add app/src/shared app/src/main/application/mutations app/src/renderer/src/features/mutations app/tests/integration/application/staged-mutation-service.test.ts app/tests/integration/ipc/ipc-contracts.test.ts app/tests/unit/renderer/MutationReviewDialog.test.tsx
git commit -m "feat: stage atomic parent family completion"
```

### Task 5: 支持亲子关系来源查询、移除与原子更正

**Files:**
- Modify: `app/src/shared/contracts.ts`
- Modify: `app/src/shared/mutations.ts`
- Modify: `app/src/shared/api-schemas.ts`
- Modify: `app/src/main/application/facts/facts-gateway.ts`
- Modify: `app/src/main/application/query/list-relatives.ts`
- Modify: `app/src/main/application/mutations/staged-mutation-service.ts`
- Modify: `app/tests/integration/application/facts-gateway.test.ts`
- Modify: `app/tests/integration/application/query-tools.test.ts`
- Modify: `app/tests/integration/application/staged-mutation-service.test.ts`
- Modify: `app/tests/integration/audit/undo.test.ts`

**Interfaces:**
- `RelatedPersonReadModel` and parent/child `RelativeReadModel` add `rowVersion`, `originKind`, and `inferredFromMarriageId`.
- Add `parentChild.remove { relationId, expectedVersion }` to `MutationIntent` and Zod schemas.
- Correction stages `[parentChild.remove, parentChild.add]` or `[parentChild.remove, parentFamily.add]` in one draft.

- [ ] **Step 1: Write failing read-model and removal tests**

Verify provenance reaches `people.get` and `query.listRelatives`; a stale relation version blocks removal; removing an inferred relation leaves marriage/person rows untouched.

- [ ] **Step 2: Write the failing atomic correction/undo test**

Stage removal of an incorrect father plus addition of the correct father. Confirm one operation group, assert only the corrected edge is active, undo once, and assert the original edge is restored while the new edge is gone.

- [ ] **Step 3: Run tests and verify they fail**

Run: `cd app; npm test -- tests/integration/application/facts-gateway.test.ts tests/integration/application/staged-mutation-service.test.ts tests/integration/audit/undo.test.ts`

- [ ] **Step 4: Implement contracts, compile path and read mapping**

Compile removal to the existing `fact.softDelete` command with `entityType: "parent_child"`. Treat it as an update in preview, include before/after relation fields, and require its exact row version. Do not add any cascade to marriage.

- [ ] **Step 5: Verify removal, correction and undo**

Run: `cd app; npm test -- tests/integration/application tests/integration/audit/undo.test.ts`

Run: `cd app; npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add app/src/shared app/src/main/application app/tests/integration/application app/tests/integration/audit/undo.test.ts
git commit -m "feat: correct and remove parent relations"
```

### Task 6: 将关系录入改为人物中心并支持多个子女

**Files:**
- Create: `app/src/renderer/src/features/relations/FamilyRelationsPanel.tsx`
- Create: `app/tests/unit/renderer/FamilyRelationsPanel.test.tsx`
- Modify: `app/src/shared/contracts.ts`
- Modify: `app/src/shared/mutations.ts`
- Modify: `app/src/shared/api-schemas.ts`
- Modify: `app/src/main/application/facts/facts-gateway.ts`
- Modify: `app/src/main/application/mutations/staged-mutation-service.ts`
- Modify: `app/src/renderer/src/features/people/PersonDetail.tsx`
- Modify: `app/src/renderer/src/features/people/PeoplePage.tsx`
- Modify: `app/src/renderer/src/features/people/people.css`
- Modify: `app/src/renderer/src/features/relations/RelationshipEditor.tsx`
- Modify: `app/tests/unit/renderer/RelationshipEditor.test.tsx`
- Modify: `app/tests/unit/renderer/MutationReviewDialog.test.tsx`

**UI contract:**
- Current detail person is fixed and never re-selected.
- Four sections: father, mother, spouses, children. The spouse section supports selecting multiple marriage events with per-event status/dates; the children section supports search plus bulk multi-select.
- Every parent/child row shows source badge and offers `更正` / `移除`.
- The old pairwise editor remains inside a collapsed `高级关系录入` section for exceptional correction work.
- Adding children always requires an explicit `当前人物作为父亲/母亲` choice; gender may be shown as a hint but cannot silently choose or rewrite the role.
- Extend public `MarriageDraft` with optional `status` and `end`, require a valid end for a divorced event, and allow at most one new active marriage involving the same person.

- [ ] **Step 1: Write failing current-person and multi-select tests**

Assert the selected person is absent from relative candidate options; choosing two children stages two `parentFamily.add` intents; adding spouses stages one `marriage.add` per completed event; father and mother slots cannot stage a second active relation without correction.

- [ ] **Step 2: Write failing ambiguity and removal tests**

Mock `planParentCompletion` for unique, no-candidate and ambiguous results. Verify ambiguous candidates show names and marriage ranges, administrator may choose one or skip, and `移除` stages `parentChild.remove` rather than mutating immediately.

- [ ] **Step 3: Run renderer tests and verify they fail**

Run: `cd app; npm test -- tests/unit/renderer/FamilyRelationsPanel.test.tsx tests/unit/renderer/RelationshipEditor.test.tsx tests/unit/renderer/MutationReviewDialog.test.tsx`

- [ ] **Step 4: Implement the panel and existing-person flows**

Use `people.list` search, `relations.planParentCompletion`, and `mutations.stage`. For multiple children, stage one high-level intent per child in one draft. For multiple spouse events, collect status/start/end per row and reject multiple new active marriages before staging. A no-candidate plan shows `另一位父母尚未确认` but leaves the explicit relation saveable.

- [ ] **Step 5: Connect quick-create and correction flows**

Let `PeoplePage` open the existing `PersonEditor` in a relative-creation mode, then return the newly created ID to the pending relation panel; the person creation keeps its own structured preview. Correction stages removal and replacement together only after the replacement person is known.

- [ ] **Step 6: Integrate detail display and advanced editor**

Replace the static parent/child summary with `FamilyRelationsPanel`, keep `MarriageHistory`, and move `RelationshipEditor` under a collapsed advanced section. Display `人工录入` / `系统自动补全` and the inferred marriage when present.

- [ ] **Step 7: Run renderer regression and accessibility checks**

Run: `cd app; npm test -- tests/unit/renderer`

Run: `cd app; npm run typecheck:web`

Expected: PASS; all controls have stable Chinese accessible names and keyboard-operable multi-select behavior.

- [ ] **Step 8: Commit**

```bash
git add app/src/shared app/src/main/application/facts/facts-gateway.ts app/src/main/application/mutations/staged-mutation-service.ts app/src/renderer/src/features/relations app/src/renderer/src/features/people app/tests/unit/renderer
git commit -m "feat: add person-centered family relation editing"
```

### Task 7: 增加历史未完整父母关系的批量修复

**Files:**
- Create: `app/src/renderer/src/features/relations/ParentCompletionRepairPanel.tsx`
- Create: `app/tests/unit/renderer/ParentCompletionRepairPanel.test.tsx`
- Modify: `app/src/renderer/src/features/people/PeoplePage.tsx`
- Modify: `app/src/renderer/src/features/people/people.css`
- Modify: `app/tests/integration/application/parent-completion-service.test.ts`
- Modify: `app/tests/integration/application/staged-mutation-service.test.ts`

**Behavior:**
- Button label: `检查未完整父母关系`.
- Safe suggestions are checked by default; no-candidate, ambiguous and conflict rows are visible but not selected.
- Selected rows become ordinary `parentFamily.add` intents with the existing parent as the explicit unchanged fact and the inferred relation as the actionable change.

- [ ] **Step 1: Write failing scan-panel tests**

Verify summary counts, stable row ordering, default selection only for safe suggestions, select-all over safe rows only, empty state, and zero mutation calls until the administrator clicks `生成修复预览`.

- [ ] **Step 2: Write failing 1000-person integration tests**

Materialize a 1000-person workspace with repeated marriage episodes and mixed statuses. Assert no duplicate child suggestion, database row counts unchanged after scanning, and selected repair intents fit the bounded mutation limits.

- [ ] **Step 3: Run tests and verify they fail**

Run: `cd app; npm test -- tests/unit/renderer/ParentCompletionRepairPanel.test.tsx tests/integration/application/parent-completion-service.test.ts tests/integration/application/staged-mutation-service.test.ts`

- [ ] **Step 4: Implement the repair panel**

Fetch only when opened or refreshed. Render candidate reason and current known parent. Generate one staged draft for all selected safe items; do not loop through per-row confirmations.

- [ ] **Step 5: Verify atomic batch behavior**

After staging, mutate one relevant marriage or parent edge, confirm, and assert the entire operation fails with no new active parent rows. Re-scan after success and verify repaired children disappear from the incomplete list.

- [ ] **Step 6: Run focused and renderer suites**

Run: `cd app; npm test -- tests/unit/renderer/ParentCompletionRepairPanel.test.tsx tests/integration/application/parent-completion-service.test.ts tests/integration/application/staged-mutation-service.test.ts`

Run: `cd app; npm run typecheck:web`

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer/src/features/relations/ParentCompletionRepairPanel.tsx app/src/renderer/src/features/people app/tests/unit/renderer/ParentCompletionRepairPanel.test.tsx app/tests/integration/application
git commit -m "feat: repair incomplete parent records in batches"
```

### Task 8: 让对话式关系录入复用同一补全规则

**Files:**
- Modify: `app/src/main/application/chat/draft-service.ts`
- Modify: `app/src/shared/chat.ts`
- Modify: `app/src/renderer/src/features/chat/ChatPanel.tsx`
- Modify: `app/tests/integration/chat/draft-confirmation.test.ts`
- Modify: `app/tests/integration/chat/controlled-conversation.test.ts`
- Modify: `app/tests/unit/renderer/ChatPanel.test.tsx`

**Interfaces:**
- Conversation preview changes add the same `originKind`, selection dependency and parent-completion explanation fields used by form previews.
- The chat draft planner receives a prospective in-memory graph containing persisted facts plus selected new people/marriages from the same draft before invoking `ParentCompletionPlanner`.

- [ ] **Step 1: Write failing conversational completion tests**

Cover an existing married couple plus a newly stated child; a marriage and child created in the same conversation draft; no spouse; ambiguous remarriage; and deselecting the automatic parent while keeping the explicit relation.

- [ ] **Step 2: Run chat tests and verify they fail**

Run: `cd app; npm test -- tests/integration/chat/draft-confirmation.test.ts tests/integration/chat/controlled-conversation.test.ts tests/unit/renderer/ChatPanel.test.tsx`

- [ ] **Step 3: Build a prospective graph and reuse the planner**

After stable IDs are allocated for draft people/marriages, project the selected prospective facts into the same planner input. Add inferred parent changes with dependencies on required person, marriage and explicit-parent changes. Do not auto-complete relations that the administrator excluded from the same draft.

- [ ] **Step 4: Render and confirm optional inferred changes**

Show the source badge and reason in the existing chat confirmation UI. Preserve current unresolved-reference and confidence acknowledgement rules; parent-completion info is not a model assertion and must not be represented as LLM confidence.

- [ ] **Step 5: Run chat and LLM boundary regressions**

Run: `cd app; npm test -- tests/integration/chat tests/unit/renderer/ChatPanel.test.tsx tests/unit/llm`

Run: `cd app; npm run typecheck:web`

- [ ] **Step 6: Commit**

```bash
git add app/src/main/application/chat app/src/shared/chat.ts app/src/renderer/src/features/chat app/tests/integration/chat app/tests/unit/renderer/ChatPanel.test.tsx app/tests/unit/llm
git commit -m "feat: complete parent relations in conversation drafts"
```

### Task 9: 完成 Web 验收、性能门禁和操作说明

**Files:**
- Create: `app/tests/e2e-web/web-parent-completion.spec.ts`
- Modify: `app/tests/e2e-web/web-core-loop.spec.ts`
- Modify: `app/scripts/run-performance-gates.ts`
- Modify: `app/scripts/generate-benchmark-workspace.ts`
- Modify: `app/tests/performance/performance-gates.test.ts`
- Create: `docs/testing/parent-completion-user-guide.md`
- Modify: `docs/superpowers/specs/2026-10-01-parent-auto-completion-design.md`

- [ ] **Step 1: Write failing Web acceptance scenarios**

Test normal spouses with one child entry producing two preview rows; cancelling auto completion; no spouse; divorce/remarriage with unique birth interval; ambiguous missing date requiring choose/skip; occupied complementary role; multiple children in one preview; remove/correct/undo; historical batch repair; tree no longer showing single-parent after repair.

- [ ] **Step 2: Add the 1000-person scan performance gate**

Extend the fixed benchmark with one-parent records and repeated marriage episodes. Warm once, measure at least five scans, assert p95 below 1000 ms, stable suggestion digest, no database mutation, and include the new source files in performance evidence hashing.

- [ ] **Step 3: Run the new E2E and performance tests**

Run: `cd app; npm run build:web`

Run: `cd app; npm run test:e2e:web:built -- web-parent-completion.spec.ts`

Run: `cd app; npm run performance`

Expected: all new scenarios and the scan gate PASS.

- [ ] **Step 4: Update administrator instructions and spec status**

Document the person-centered workflow, meaning of source badges, ambiguity handling, removal/correction, batch repair and undo. Mark the design implemented only after the acceptance commands pass; do not claim complex parent types are supported.

- [ ] **Step 5: Run the complete verification matrix**

Run: `cd app; npm run typecheck`

Run: `cd app; npm test`

Run: `cd app; npm run build:web`

Run: `cd app; npm run test:e2e:web:built`

Run: `cd app; npm run performance`

Expected: all commands PASS. Record exact pass counts and performance figures in the final handoff; do not overwrite unrelated tree-layout changes already present in the working tree.

- [ ] **Step 6: Commit**

```bash
git add app/tests/e2e-web app/scripts app/tests/performance docs/testing/parent-completion-user-guide.md docs/superpowers/specs/2026-10-01-parent-auto-completion-design.md
git commit -m "test: verify parent completion workflow"
```

---

## Final Review Checklist

- [ ] Every acceptance criterion in the design is owned by a task and an executable test.
- [ ] `parentChild.add` remains explicit and backward compatible; only high-level entry paths invoke spouse-default completion.
- [ ] Planner types are shared consistently between domain, application, RPC and UI layers without `as never` workarounds.
- [ ] Optional automatic items never suppress or overwrite valid explicit facts.
- [ ] All stale-evidence and batch conflicts fail before the first persistent write.
- [ ] Parent relation removal/correction uses existing audit and undo machinery without cascading to marriage.
- [ ] Existing import, family tree, relationship calculator, query and export tests still pass against confirmed facts.
- [ ] The five Review Focus cases are named in tests and visible in code review.
- [ ] Plan commits exclude `.codex-temp/` and the user’s unrelated modified tree files.
