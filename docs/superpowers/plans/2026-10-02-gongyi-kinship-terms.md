# Gongyi Kinship Terms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有关系路径引擎上增加正式称谓与河南郑州巩义地区称谓分层，并让家谱树、人物抽屉和关系问答一致显示地区主称谓、正式称谓及可读关系说明。

**Architecture:** 保留 `mandarin-v1.json` 作为正式规则目录，新增一个以正式规则 ID 为键的稀疏巩义覆盖目录；关系计算器统一产出结构化标签，树投影和问答只消费该结果，不在 UI 中做字符串映射。`primaryTerm` 保持正式称谓兼容语义，新字段 `displayTerm` 才是页面主称谓。

**Tech Stack:** TypeScript 7, React 19, Zod 4, SQLite/better-sqlite3, React Flow/ELK, Vitest, Testing Library, Playwright

**Spec:** `docs/superpowers/specs/2026-10-02-gongyi-kinship-terms-design.md`

## Global Constraints

- 首版地区固定为 `zh-CN-henan-gongyi`，地区目录版本固定为 `zh-CN-henan-gongyi-v1`，正式目录版本继续为 `mandarin-v1`。
- `primaryTerm === formalTerm`；现有调用不能因兼容字段改成地区称谓而静默改变语义。
- `displayTerm === regionalTerm ?? formalTerm`；地区词与正式词相同的时候 `regionalTerm` 规范化为 `null`。
- 地区目录只能引用存在的正式规则 ID；不能在 React 组件或问答提示词里硬编码“正式词 → 地区词”的转换表。
- 首版明确覆盖 `姨奶奶 / 姨祖母`、`舅爷 / 舅祖父`、`表姑 / 父亲的表姐妹`、`表姑父 / 父亲的表姐妹之夫` 四组已确认案例及其长幼未知变体。
- 地区未命中时降级到正式精确或正式组合称谓；冲突或无路径时不生成称谓。
- 不增加数据库迁移、运行时依赖、地区设置页面、词表编辑器或新的亲属事实类型。
- 家谱树继续使用批量路径查询；不能改成每张人物卡独立请求。
- 保留现有离婚、再婚、同父异母/同母异父、树范围、快捷编辑和撤销行为。
- 当前工作区已有未提交修改；每个任务只暂存自己列出的文件，不得覆盖、清理或还原其他改动。

## Review Focus

- 地区文件引用不存在或重复的正式规则 ID 时，应用应在加载阶段给出明确错误；Task 1 添加解析器测试。
- 出生资料不足导致兄弟姐妹长幼未知时，地区匹配必须使用中性规则，不得借人物编号或录入顺序猜测；Task 2 添加领域测试。
- 正式规则命中但地区规则未命中时，树投影和单人查询必须得到相同的正式降级标签；Task 3 添加集成测试。
- 切换视角或快速连续切换人物时，旧请求结果不能覆盖新标签，树卡与抽屉必须一致；Task 4 添加竞态测试。
- 关系问题同时触发人物搜索和关系计算时，问答只能使用工具输出的称谓，不能让模型改写成另一个称呼；Task 5 添加协调器测试。

---

### Task 1: 巩义地区目录解析与加载边界

**Files:**
- Create: `app/src/main/domain/kinship/locale-loader.ts`
- Create: `app/tests/unit/domain/kinship/locale-loader.test.ts`

**Interfaces:**
- Consumes: `KinshipRuleCatalog` from `app/src/main/domain/kinship/rule-loader.ts`.
- Produces: `KinshipLocaleTerm { ruleId: string; term: string }`.
- Produces: `KinshipLocaleCatalog { locale: string; version: string; formalCatalogVersion: string; terms: KinshipLocaleTerm[] }`.
- Produces: `parseKinshipLocaleCatalog(value: unknown, formalCatalog: KinshipRuleCatalog): KinshipLocaleCatalog`.
- Produces: `loadKinshipLocaleCatalog(formalCatalog: KinshipRuleCatalog, filePath?: string): KinshipLocaleCatalog`.
- Produces: `matchKinshipLocaleTerm(catalog: KinshipLocaleCatalog, ruleId: string): string | null`.

- [ ] **Step 1: Write failing parser validation tests**

  Add cases that accept one valid override and reject an empty locale/version, mismatched `formalCatalogVersion`, duplicate `ruleId`, blank `term`, and a `ruleId` absent from the supplied formal catalog.

  ```ts
  expect(parseKinshipLocaleCatalog(valid, formal)).toMatchObject({
    locale: "zh-CN-henan-gongyi",
    version: "zh-CN-henan-gongyi-v1"
  });
  expect(() => parseKinshipLocaleCatalog(unknownRule, formal)).toThrow(/unknown formal rule/i);
  expect(() => parseKinshipLocaleCatalog(duplicateRule, formal)).toThrow(/duplicate/i);
  ```

- [ ] **Step 2: Write the failing file-loader and matcher tests**

  Use a temporary JSON file and assert that `loadKinshipLocaleCatalog(formal, path)` parses UTF-8 Chinese text and that `matchKinshipLocaleTerm` returns the exact term or `null`.

- [ ] **Step 3: Run the focused test and verify RED**

  Run from `app`: `npm test -- tests/unit/domain/kinship/locale-loader.test.ts`

  Expected: FAIL because `locale-loader.ts` does not exist.

- [ ] **Step 4: Implement the parser, indexed matcher, and resource-path loader**

  Use the same packaged-resource / working-directory / source-relative fallback pattern as `rule-loader.ts`. Validation happens once at load time; matching must not read the file repeatedly.

- [ ] **Step 5: Run the focused test and verify GREEN**

  Run: `npm test -- tests/unit/domain/kinship/locale-loader.test.ts`

  Expected: all locale parser and loader tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add app/src/main/domain/kinship/locale-loader.ts app/tests/unit/domain/kinship/locale-loader.test.ts
  git commit -m "feat: add regional kinship catalog loader"
  ```

### Task 2: 正式规则补齐与结构化称谓计算

**Files:**
- Create: `app/resources/kinship-locales/zh-CN-henan-gongyi-v1.json`
- Create: `app/tests/fixtures/gongyi-kinship-cases.v1.json`
- Create: `app/tests/unit/domain/kinship/gongyi-kinship-terms.test.ts`
- Modify: `app/resources/kinship-rules/mandarin-v1.json`
- Modify: `app/src/main/domain/kinship/types.ts`
- Modify: `app/src/main/domain/kinship/relationship-calculator.ts`
- Modify: `app/electron-builder.yml`
- Modify: `app/tests/unit/domain/kinship/relationship-calculator.test.ts`

**Interfaces:**
- Consumes: Task 1's `KinshipLocaleCatalog`, `loadKinshipLocaleCatalog`, and `matchKinshipLocaleTerm`.
- Produces: `KinshipDisplayLabel` with `formalTerm`, `regionalTerm`, `displayTerm`, `pathDescription`, `formalRuleId`, `locale`, and `regionalRuleVersion`.
- Extends: `RelationshipAlternative` with every `KinshipDisplayLabel` field while keeping `primaryTerm`, `reverseTerm`, `description`, and `signature`.
- Produces: `RelationshipCalculator.calculatePrimaryLabels(viewpointId: string, targetIds: readonly string[]): ReadonlyMap<string, KinshipDisplayLabel | null>`.
- Preserves: `RelationshipCalculator.calculatePrimaryTerms(...)` returning formal `primaryTerm` strings.
- Constructor: `new RelationshipCalculator(facts, formalCatalog = loadKinshipRuleCatalog(), localeCatalog = loadKinshipLocaleCatalog(formalCatalog))`.
- Function: `calculateRelationship(facts, viewpointId, targetId, formalCatalog = loadKinshipRuleCatalog(), localeCatalog = loadKinshipLocaleCatalog(formalCatalog)): RelationshipResult`.

- [ ] **Step 1: Add failing catalog and approved-case tests**

  Add fixture graphs for these exact results, including generic sibling steps when birth order is unavailable:

  ```ts
  expect(label("grandmothers-older-sister")).toMatchObject({
    formalTerm: "姨祖母", regionalTerm: "姨奶奶", displayTerm: "姨奶奶",
    pathDescription: "祖母的姐姐", locale: "zh-CN-henan-gongyi"
  });
  expect(label("grandmothers-younger-brother")).toMatchObject({
    formalTerm: "舅祖父", regionalTerm: "舅爷", displayTerm: "舅爷",
    pathDescription: "祖母的弟弟"
  });
  expect(label("grandmothers-brothers-daughter")).toMatchObject({
    formalTerm: "父亲的表姐妹", regionalTerm: "表姑", displayTerm: "表姑",
    pathDescription: "祖母的侄女"
  });
  expect(label("grandmothers-sisters-daughters-husband")).toMatchObject({
    formalTerm: "父亲的表姐妹之夫", regionalTerm: "表姑父", displayTerm: "表姑父",
    pathDescription: "祖母的外甥女的丈夫"
  });
  ```

  Also assert the older/younger variants produce `祖母的姐姐/妹妹` and `祖母的哥哥/弟弟`, while identical or missing birth ranges do not invent order.

- [ ] **Step 2: Add failing fallback, conflict, and compatibility tests**

  Pin these invariants:

  ```ts
  expect(uncovered).toMatchObject({ regionalTerm: null, displayTerm: uncovered.formalTerm });
  expect(conflicted).toMatchObject({ primaryTerm: null, formalTerm: null, regionalTerm: null, displayTerm: null });
  expect(result.primaryTerm).toBe(result.formalTerm);
  expect(calculator.calculatePrimaryTerms("source", ["target"]).get("target")).toBe(result.formalTerm);
  expect(calculator.calculatePrimaryLabels("source", ["target"]).get("target")).toMatchObject({ displayTerm: result.displayTerm });
  ```

- [ ] **Step 3: Run the focused domain tests and verify RED**

  Run: `npm test -- tests/unit/domain/kinship/locale-loader.test.ts tests/unit/domain/kinship/gongyi-kinship-terms.test.ts tests/unit/domain/kinship/relationship-calculator.test.ts`

  Expected: the regional resource, fields, approved formal rules, and batch label API are missing.

- [ ] **Step 4: Add the exact formal rule families and the sparse regional overlay**

  Add these exact rule IDs and paths:

  - `paternal-grandmothers-sister`, `paternal-grandmothers-older-sister`, `paternal-grandmothers-younger-sister` for `father,mother,(sister variant)` → `姨祖母` → regional `姨奶奶`;
  - `paternal-grandmothers-brother`, `paternal-grandmothers-older-brother`, `paternal-grandmothers-younger-brother` for `father,mother,(brother variant)` → `舅祖父` → regional `舅爷`;
  - `paternal-grandmothers-brothers-daughter`, `paternal-grandmothers-older-brothers-daughter`, `paternal-grandmothers-younger-brothers-daughter` for `father,mother,(brother variant),daughter` → `父亲的表姐妹` → regional `表姑`;
  - `paternal-grandmothers-sisters-daughters-husband`, `paternal-grandmothers-older-sisters-daughters-husband`, `paternal-grandmothers-younger-sisters-daughters-husband` for `father,mother,(sister variant),daughter,husband` → `父亲的表姐妹之夫` → regional `表姑父`.

  Use `甥孙/甥孙女/甥孙辈` as the first two families' formal reverse terms, `表侄/表侄女/表侄辈` for the daughter family, and neutral `配偶的表侄辈` for the spouse family. Do not add unconfirmed regional synonyms for other rules.

- [ ] **Step 5: Implement readable path composition and structured labels**

  For a leading parent chain, resolve the longest direct-ancestor prefix as the anchor and compose the remaining relative path from that ancestor; for a leading spouse edge, preserve the spouse anchor. `pathDescription` must never contain person IDs or relation IDs. Apply a regional term only after an exact formal rule match; composed formal terms always have `regionalTerm: null`.

- [ ] **Step 6: Package the regional resource without widening resource globs**

  Add one explicit `extraResources` entry for `resources/kinship-locales/zh-CN-henan-gongyi-v1.json` and extend the packaged-resource test to assert both exact files are listed.

- [ ] **Step 7: Run focused tests and verify GREEN**

  Run: `npm test -- tests/unit/domain/kinship/locale-loader.test.ts tests/unit/domain/kinship/gongyi-kinship-terms.test.ts tests/unit/domain/kinship/relationship-calculator.test.ts tests/unit/domain/kinship/golden-matrix.test.ts`

  Expected: approved cases, conservative age behavior, the existing golden matrix, and packaging checks all pass.

- [ ] **Step 8: Commit**

  ```bash
  git add app/resources/kinship-locales/zh-CN-henan-gongyi-v1.json app/resources/kinship-rules/mandarin-v1.json app/src/main/domain/kinship/types.ts app/src/main/domain/kinship/relationship-calculator.ts app/electron-builder.yml app/tests/fixtures/gongyi-kinship-cases.v1.json app/tests/unit/domain/kinship/gongyi-kinship-terms.test.ts app/tests/unit/domain/kinship/relationship-calculator.test.ts
  git commit -m "feat: resolve formal and Gongyi kinship terms"
  ```

### Task 3: 查询契约与家谱批量标签

**Files:**
- Modify: `app/src/shared/contracts.ts`
- Modify: `app/src/main/domain/projection/tree-projection-service.ts`
- Modify: `app/src/main/application/query/workspace-projection.ts`
- Modify: `app/tests/unit/domain/family-union-projector.test.ts`
- Modify: `app/tests/integration/application/query-tools.test.ts`
- Modify: `app/tests/integration/application/workspace-projection.test.ts`

**Interfaces:**
- Consumes: Task 2's `KinshipDisplayLabel` and `calculatePrimaryLabels`.
- Produces: shared `KinshipDisplayLabelDto` with the same seven fields and string versions for locale/version.
- Extends: `RelationshipAlternativeDto` with `KinshipDisplayLabelDto`.
- Changes: `TreeProjectionDto.labels` to `Readonly<Record<string, KinshipDisplayLabelDto | null>>`.
- Changes: `TreeLabelResolver` to return `KinshipDisplayLabel | null`.

- [ ] **Step 1: Write failing DTO/query assertions**

  Extend the relationship query integration test to assert the exact new fields and verify `primaryTerm === formalTerm`. Add a conflict case where all three display terms are `null`.

- [ ] **Step 2: Write failing tree-projection consistency tests**

  Assert that `projectWorkspaceTree(...).labels[target]` equals the display fields returned by `calculate_relationship` for the same viewpoint and target. Add one target with a regional override and one formal-only target.

- [ ] **Step 3: Run the focused tests and verify RED**

  Run: `npm test -- tests/unit/domain/family-union-projector.test.ts tests/integration/application/query-tools.test.ts tests/integration/application/workspace-projection.test.ts`

  Expected: string labels do not satisfy the structured DTO assertions.

- [ ] **Step 4: Update shared contracts and the projection service**

  Mirror the domain label fields in the transport DTO. Keep query method inputs unchanged. Make topology caching independent from labels exactly as it is now.

- [ ] **Step 5: Replace batch primary terms with batch primary labels**

  In `workspace-projection.ts`, calculate labels once against the complete confirmed graph, then pass only visible targets to `TreeProjectionService`. Do not call `calculateRelationship` once per visible tree node in the normal path.

- [ ] **Step 6: Run the focused tests and verify GREEN**

  Run: `npm test -- tests/unit/domain/family-union-projector.test.ts tests/integration/application/query-tools.test.ts tests/integration/application/workspace-projection.test.ts`

  Expected: DTO shape, batch/single consistency, formal fallback, conflicts, and topology cache tests pass.

- [ ] **Step 7: Commit**

  ```bash
  git add app/src/shared/contracts.ts app/src/main/domain/projection/tree-projection-service.ts app/src/main/application/query/workspace-projection.ts app/tests/unit/domain/family-union-projector.test.ts app/tests/integration/application/query-tools.test.ts app/tests/integration/application/workspace-projection.test.ts
  git commit -m "feat: project structured kinship labels"
  ```

### Task 4: 家谱人物卡与右侧关系说明

**Files:**
- Modify: `app/src/renderer/src/app/ViewpointContext.tsx`
- Modify: `app/src/renderer/src/features/tree/layout-with-elk.ts`
- Modify: `app/src/renderer/src/features/tree/FamilyTreeCanvas.tsx`
- Modify: `app/src/renderer/src/features/tree/FamilyTreePage.tsx`
- Modify: `app/src/renderer/src/features/tree/PersonNode.tsx`
- Modify: `app/src/renderer/src/features/tree/TreeContextDrawer.tsx`
- Modify: `app/src/renderer/src/features/tree/tree.css`
- Modify: `app/tests/unit/renderer/ViewpointContext.test.tsx`
- Modify: `app/tests/unit/renderer/FamilyTreeCanvas.test.tsx`
- Modify: `app/tests/unit/renderer/FamilyTreePage.test.tsx`

**Interfaces:**
- Consumes: Task 3's `KinshipDisplayLabelDto` in tree projections and relationship queries.
- Changes: `ViewpointState.relationshipLabels` to `Readonly<Record<string, KinshipDisplayLabelDto | null>>`.
- Adds: `TreeContextDrawerProps.relationshipLabel?: KinshipDisplayLabelDto | null`.
- Preserves: current selection, editing, quick-create, stale-request protection, and viewpoint persistence behavior.

- [ ] **Step 1: Write failing viewpoint race and structured-label tests**

  Update the context harness to read `displayTerm`. Assert that a late response for the old viewpoint cannot replace the new viewpoint's structured label and that failed targets remain `null` without blocking valid targets.

- [ ] **Step 2: Write failing person-card tests**

  Pin both rendering branches:

  ```tsx
  expect(card).toHaveTextContent("姨奶奶");
  expect(card).toHaveTextContent("正式关系：姨祖母");
  expect(card).not.toHaveTextContent("祖母的姐姐");
  ```

  For a formal-only label, assert the term appears once and no “正式关系” secondary line is rendered.

- [ ] **Step 3: Write failing drawer tests**

  Click a person card and assert the drawer shows `你对该人物的称呼：姨奶奶`、`正式称谓：姨祖母`、`关系说明：祖母的姐姐`、`地区规则：河南郑州巩义`. With no viewpoint or a `null` label, the relationship section must be absent.

- [ ] **Step 4: Run the focused UI tests and verify RED**

  Run: `npm test -- tests/unit/renderer/ViewpointContext.test.tsx tests/unit/renderer/FamilyTreeCanvas.test.tsx tests/unit/renderer/FamilyTreePage.test.tsx`

  Expected: existing components expect plain strings and the drawer lacks relationship details.

- [ ] **Step 5: Render structured labels and pass the selected label to the drawer**

  The tree card renders `displayTerm` and conditionally renders `正式关系：{formalTerm}` only when `regionalTerm` is non-null. `FamilyTreePage` obtains the selected person's label from the projection and passes it directly to the drawer, avoiding an extra request.

- [ ] **Step 6: Increase measured node height and preserve spacing**

  Update both `.tree-person-node` minimum height and `NODE_SIZE.person.height` to the same value that fits two relationship lines. Keep width `196` and rerun overlap/layout tests so ELK and CSS remain synchronized.

- [ ] **Step 7: Run focused tests and verify GREEN**

  Run: `npm test -- tests/unit/renderer/ViewpointContext.test.tsx tests/unit/renderer/FamilyTreeCanvas.test.tsx tests/unit/renderer/FamilyTreePage.test.tsx`

  Expected: structured labels, fallback display, drawer details, stale requests, and layout spacing pass.

- [ ] **Step 8: Commit**

  ```bash
  git add app/src/renderer/src/app/ViewpointContext.tsx app/src/renderer/src/features/tree/layout-with-elk.ts app/src/renderer/src/features/tree/FamilyTreeCanvas.tsx app/src/renderer/src/features/tree/FamilyTreePage.tsx app/src/renderer/src/features/tree/PersonNode.tsx app/src/renderer/src/features/tree/TreeContextDrawer.tsx app/src/renderer/src/features/tree/tree.css app/tests/unit/renderer/ViewpointContext.test.tsx app/tests/unit/renderer/FamilyTreeCanvas.test.tsx app/tests/unit/renderer/FamilyTreePage.test.tsx
  git commit -m "feat: show local and formal terms in family tree"
  ```

### Task 5: 关系问答的确定性地方称谓

**Files:**
- Modify: `app/src/main/application/chat/answer-coordinator.ts`
- Modify: `app/src/renderer/src/features/chat/ChatPanel.tsx`
- Modify: `app/src/renderer/src/app/app-shell.css`
- Modify: `app/tests/integration/chat/answer-coordinator.test.ts`
- Modify: `app/tests/unit/renderer/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: enriched `RelationshipResultDto` from Task 3.
- Produces: `formatDirectRelationshipConclusion(targetName: string, relationship: RelationshipResultDto): string` inside `answer-coordinator.ts`.
- Preserves: `ConversationAnswer.relationship` as the structured source for the UI and existing `relationshipPath` person-name evidence.

- [ ] **Step 1: Write failing deterministic-conclusion tests**

  For a direct relationship question whose tool result contains the approved 姨奶奶 label, assert:

  ```ts
  expect(answer.conclusion).toBe(
    "按巩义的常用叫法，李小梅是你的“姨奶奶”。正式称谓是“姨祖母”，她是你祖母的姐姐。"
  );
  ```

  Add formal-only output that omits the regional preface, a conflict result that stays `insufficient`, and a multi-intent question that preserves the model's broader answer while retaining the structured relationship object.

- [ ] **Step 2: Write failing ChatPanel relationship-summary tests**

  Assert that the answer panel displays the region label, formal term, and `pathDescription`, and avoids a duplicate formal row when `regionalTerm` is `null`.

- [ ] **Step 3: Run focused chat tests and verify RED**

  Run: `npm test -- tests/integration/chat/answer-coordinator.test.ts tests/unit/renderer/ChatPanel.test.tsx`

  Expected: the model answer is returned unchanged and no structured relationship summary is rendered.

- [ ] **Step 4: Implement direct-question formatting without broad model overrides**

  Apply deterministic wording only when the question is a direct relationship/call-form query and the completed tool trace contains a relationship result. Use the final path person as the target name. Other questions keep the model answer, but the structured result remains attached.

- [ ] **Step 5: Render the structured relationship summary**

  Add a compact answer block using `displayTerm`, conditional `formalTerm`, `pathDescription`, and the fixed label “河南郑州巩义”. Keep existing source evidence and person-name path sections.

- [ ] **Step 6: Run focused tests and verify GREEN**

  Run: `npm test -- tests/integration/chat/answer-coordinator.test.ts tests/unit/renderer/ChatPanel.test.tsx`

  Expected: local-first direct answers, formal fallback, conflicts, multi-intent preservation, and structured UI all pass.

- [ ] **Step 7: Commit**

  ```bash
  git add app/src/main/application/chat/answer-coordinator.ts app/src/renderer/src/features/chat/ChatPanel.tsx app/src/renderer/src/app/app-shell.css app/tests/integration/chat/answer-coordinator.test.ts app/tests/unit/renderer/ChatPanel.test.tsx
  git commit -m "feat: answer with Gongyi kinship terms"
  ```

### Task 6: Web 端纵向验收与完整回归

**Files:**
- Modify: `app/tests/e2e-web/web-family-tree.spec.ts`

**Interfaces:**
- Consumes: the public mutation RPC, `query.projectTree`, the family-tree UI, and the person drawer.
- Produces: one browser acceptance scenario covering the approved four-generation examples and viewpoint switching.

- [ ] **Step 1: Add the failing Web acceptance fixture**

  Through existing `stageAndConfirm` helpers create a viewpoint child, father, paternal grandmother, shared ancestors, the grandmother's sister and brother, each required daughter, and the sister's daughter's husband. Give the grandmother and her siblings non-overlapping solar birth years so “姐姐/弟弟” is deterministic. Build only confirmed parent-child and active marriage facts.

- [ ] **Step 2: Add failing browser assertions**

  Assert that the four target cards contain `姨奶奶`、`舅爷`、`表姑`、`表姑父`; click the 姨奶奶 card and assert the drawer shows `正式称谓：姨祖母` and `关系说明：祖母的姐姐`. Switch the viewpoint to the father and assert the stale grandchild-view labels disappear before the new labels render.

- [ ] **Step 3: Build and run the focused browser test**

  Run: `npm run build:web`

  Run: `npm run test:e2e:web:built -- tests/e2e-web/web-family-tree.spec.ts`

  Expected: all Web family-tree tests pass without card overlap or stale labels.

- [ ] **Step 4: Run the complete verification suite**

  Run: `npm run typecheck:web`

  Run: `npm test`

  Run: `npm run verify:web`

  Expected: type checking, all unit/integration tests, production Web build, all Web Playwright tests, and performance gates pass.

- [ ] **Step 5: Inspect the final diff for scope and generated artifacts**

  Run: `git status --short`

  Run: `git diff --check`

  Confirm that no pre-existing unrelated edits, `.codex-temp` files, build output, database, upload, or test-report artifacts are staged.

- [ ] **Step 6: Commit**

  ```bash
  git add app/tests/e2e-web/web-family-tree.spec.ts
  git commit -m "test: verify Gongyi kinship terms on web"
  ```
