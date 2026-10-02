# Tree View Scopes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overlapping tree filters with backend-defined Full Tree, Family Lineage, Core Relatives, and Descendants views whose UI states and boundaries match the approved product design.

**Architecture:** Add a pure `TreeScopeResolver` that selects people and fact IDs from confirmed workspace data, then feed only those facts into the existing family-union and tree-projection pipeline. Extend the query DTO with scope metadata, while the React page derives lineage choices from the existing workspace snapshot and keeps kinship viewpoint independent from the person around whom the tree is filtered.

**Tech Stack:** TypeScript 7, React 19, SQLite/better-sqlite3, Zod 4, React Flow, Vitest, Testing Library, Playwright

**Spec:** `docs/superpowers/specs/2026-10-02-tree-view-scopes-design.md`

## Global Constraints

- The tab order and copy are exactly `全谱｜本家支系｜核心亲属｜子孙后代`.
- `当前视角` controls kinship labels; `围绕谁查看` controls scope. Changing either one must not silently change the other.
- Use only confirmed active parent-child facts, marriages, lineages, and memberships already stored in the workspace; never infer lineage from a surname.
- Core relatives include the subject, parents, paternal and maternal grandparents, all full/half siblings, all children, current spouses, and divorced former spouses who share a child; do not expand the excluded relatives listed in the spec.
- Descendants include the subject, every descendant generation, and the necessary spouses for the subject/descendant chain; do not expand spouses' unrelated children or origin families.
- A divorced marriage is included outside Full Tree only when both people share a child through active confirmed parent-child facts.
- Keep the existing relationship labels, preview/confirm/undo workflow, ELK layout, and 100–1000-person operating range.
- No database migration, runtime dependency, adoption/step-parent type, advanced filter, or surname parser.
- Preserve unrelated uncommitted workspace changes; every task stages only its listed files.

## Review Focus

- A corrupt parent-child cycle must terminate and return each reachable person once; Task 1 pins this with a visited-set test.
- An unmarried co-parent or a spouse's child from another relationship must not leak into Core Relatives or Descendants; Task 1 tests both boundaries.
- A lineage ID from another workspace, an unknown subject, or a lineage not assigned to the subject must return a sanitized validation/not-found result; Task 2 tests the query boundary.
- Changing scope during an in-flight request must not render the stale response, and a drawer selection must close only when its entity leaves the new projection; Task 3 tests both races.
- A person with zero or multiple primary lineage memberships must see an actionable state instead of a guessed lineage or a failed request; Tasks 3 and 4 test the UI and browser behavior.

---

### Task 1: Pure family-tree scope resolver

**Files:**
- Create: `app/src/main/domain/projection/tree-scope-resolver.ts`
- Create: `app/tests/unit/domain/tree-scope-resolver.test.ts`

**Interfaces:**
- Consumes: `TreeScopeResolver.resolve(input: TreeScopeInput, request: TreeScopeRequest): TreeScopeResolution`.
- `TreeScopeInput` contains `people: Array<{ id: string }>`, `parentChildFacts: Array<{ id: string; parentId: string; childId: string }>`, `marriages: Array<{ id: string; spouseAId: string; spouseBId: string; status: "active" | "divorced" }>`, `lineageIds: string[]`, and `memberships: Array<{ lineageId: string; personId: string; lineageRole: "blood" | "married_in" | "associated"; isPrimary: boolean }>`.
- `TreeScopeRequest` contains `view: "full" | "lineage" | "core" | "descendants"`, `subjectId?: string`, and `lineageId?: string`.
- Produces: `TreeScopeResolution` with deterministic `key`, `personIds`, `parentChildRelationIds`, `marriageIds`, and metadata `{ view, subjectId, lineageId }`.
- Produces: `TreeScopeResolutionError` with code `NOT_FOUND` or `VALIDATION`; callers map it to `AppResult` without exposing database details.

- [ ] **Step 1: Write failing scope-boundary tests**

  Build one fixture containing two grandparents on each side, full and half siblings, a child and grandchild, current and divorced spouses, an unmarried co-parent, a spouse's unrelated child, two lineage memberships, and an isolated person. Pin the exact sets:

  ```ts
  expect(ids(resolve("core", "subject"))).toEqual([
    "subject", "father", "mother", "paternal-grandfather", "paternal-grandmother",
    "maternal-grandfather", "maternal-grandmother", "full-sibling",
    "paternal-half-sibling", "maternal-half-sibling", "child",
    "current-spouse", "former-spouse-with-child"
  ].sort());
  const excluded = [
    "great-grandparent", "grandchild", "sibling-spouse", "sibling-child",
    "unmarried-coparent", "former-spouse-without-child", "spouse-unrelated-child"
  ];
  expect(excluded.filter((id) => ids(resolve("core", "subject")).includes(id))).toEqual([]);
  expect(ids(resolve("descendants", "subject"))).toEqual([
    "subject", "child", "grandchild", "current-spouse", "former-spouse-with-child",
    "child-current-spouse"
  ].sort());
  ```

  Also assert that Full Tree returns all people/facts, Family Lineage returns all three membership roles plus only permitted blood-member spouses, and relation ID sets contain only facts whose endpoints are visible and only permitted marriages.

- [ ] **Step 2: Write failing validation and graph-safety tests**

  ```ts
  expectScopeError(() => resolve({ view: "core", subjectId: "missing" }), "NOT_FOUND");
  expectScopeError(
    () => resolve({ view: "lineage", subjectId: "subject", lineageId: "other-lineage" }),
    "VALIDATION"
  );
  expect(ids(resolveCyclicDescendants("subject"))).toEqual(["child", "subject"]);
  expect(relationIds(resolveCyclicDescendants("subject"))).toHaveLength(2);
  ```

- [ ] **Step 3: Run the focused test and verify RED**

  Run from `app`: `npm test -- tests/unit/domain/tree-scope-resolver.test.ts`

  Expected: FAIL because `TreeScopeResolver` does not exist.

- [ ] **Step 4: Implement the resolver**

  Build parent/child/spouse indexes once. Core scope uses two upward hops plus shared-parent sibling detection; Descendants uses a queue and visited set; Family Lineage starts from matching active memberships. Add spouses only under the approved rules, then include parent-child facts whose endpoints are both visible and marriages whose endpoints are both visible and are active or have a shared child. Full Tree is the only scope that preserves every marriage regardless of shared children.

- [ ] **Step 5: Run the focused test and verify GREEN**

  Run: `npm test -- tests/unit/domain/tree-scope-resolver.test.ts`

  Expected: all resolver tests pass, including cycles, duplicate facts, half siblings, unrelated co-parents, and former spouses.

- [ ] **Step 6: Commit**

  ```bash
  git add app/src/main/domain/projection/tree-scope-resolver.ts app/tests/unit/domain/tree-scope-resolver.test.ts
  git commit -m "feat: resolve family tree view scopes"
  ```

### Task 2: Query contract and scoped projection pipeline

**Files:**
- Modify: `app/src/shared/contracts.ts`
- Modify: `app/src/shared/api-schemas.ts`
- Modify: `app/src/main/ipc/query-ipc.ts`
- Modify: `app/src/main/application/query/workspace-projection.ts`
- Modify: `app/src/main/domain/projection/tree-projection-service.ts`
- Modify: `app/tests/unit/domain/family-union-projector.test.ts`
- Modify: `app/tests/integration/application/query-tools.test.ts`
- Modify: `app/tests/integration/application/workspace-projection.test.ts`

**Interfaces:**
- Consumes: Task 1's `TreeScopeResolver` and `TreeScopeResolution`.
- Produces: `TreeViewDto = "full" | "lineage" | "core" | "descendants"`.
- Produces: `QueryApi.projectTree(input: { view: TreeViewDto; subjectId?: string; viewpointId?: string; collapseDepth?: number; lineageId?: string })`.
- Produces: required `TreeProjectionDto.scope: { view: TreeViewDto; subjectId: string | null; lineageId: string | null; visiblePersonCount: number }`.
- Produces: `TreeProjectionService.full(collapseDepth: number)` and `TreeProjectionService.scoped(key: string)` as unlabelled topology builders; `withViewpoint(projection, viewpointId)` remains the only labelling operation.

- [ ] **Step 1: Write failing schema and gateway tests**

  Update the query IPC test so these exact cases are pinned:

  ```ts
  expect(parse({ view: "lineage", subjectId: "person" }).success).toBe(false);
  expect(parse({ view: "lineage", subjectId: "person", lineageId: "lineage" }).success).toBe(true);
  expect(parse({ view: "core", subjectId: "person", lineageId: "lineage" }).success).toBe(false);
  expect(parse({ view: "branch", subjectId: "person" }).success).toBe(false);
  expect(parse({ view: "ancestors", subjectId: "person" }).success).toBe(false);
  ```

  Add gateway cases for unknown subject/lineage, subject not assigned to the chosen lineage, and a lineage ID that exists only in another workspace. Expect sanitized `NOT_FOUND` or `VALIDATION`, never `INTERNAL` or leaked SQL/path text.

- [ ] **Step 2: Write failing projection integration tests**

  Materialize the Task 1 family shapes with `FactCommandService` and lineage repositories, then assert:

  ```ts
  expect(personIds(project({ view: "core", subjectId: "subject" }))).toEqual(expectedCoreIds);
  expect(project({ view: "lineage", subjectId: "subject", lineageId: "lineage-b" }).scope)
    .toEqual({ view: "lineage", subjectId: "subject", lineageId: "lineage-b", visiblePersonCount: expectedLineageIds.length });
  expect(selectedLineagePerson.display).toMatchObject({ lineageRole: "associated", generationMarker: "和" });
  expect(personIds(project({ view: "full" }))).toEqual(allWorkspacePersonIds);
  ```

  The Full Tree assertion must omit `collapseDepth` and still include people deeper than four generations. Keep one explicit `collapseDepth: 4` test to preserve the bounded performance-call behavior.

- [ ] **Step 3: Run the focused tests and verify RED**

  Run: `npm test -- tests/integration/application/query-tools.test.ts tests/integration/application/workspace-projection.test.ts tests/unit/domain/family-union-projector.test.ts`

  Expected: old view names are still accepted, `lineageId`/scope metadata are absent, and current projection leaks out-of-scope people.

- [ ] **Step 4: Update contracts and the strict Zod request schema**

  Require `subjectId` for every non-Full view and require `lineageId` only for Family Lineage. Reject `lineageId` for other views. Thread the same input type through `QueryApi`, `QueryGateway`, `WorkspaceQueryGateway`, preload/server adapters via their existing structural types, and RPC validation.

- [ ] **Step 5: Integrate scope resolution before union projection**

  Keep the relationship calculator on the complete confirmed graph so visible labels still resolve through valid family paths. Filter people, parent-child facts, and marriages using Task 1 before `FamilyUnionProjector`; generate topology only from filtered facts. For Family Lineage, calculate generation/marker/role display from the selected lineage rather than an unrelated primary membership. Compute `visiblePersonCount` from the final person nodes so an explicit collapse depth cannot make the displayed count stale.

- [ ] **Step 6: Simplify `TreeProjectionService` and remove legacy scope traversal**

  Delete `branch()` and `ancestors()` and move `descendants()` responsibility to `TreeScopeResolver`. Keep topology caching, union metadata, deterministic sorting, and `withViewpoint`; update its unit tests to call `full(collapseDepth)` or `scoped(key)` and then label explicitly.

- [ ] **Step 7: Run the focused tests and verify GREEN**

  Run the same command as Step 3.

  Expected: all selected unit/integration tests pass and the query results contain no person, union, or edge outside the resolved relation sets.

- [ ] **Step 8: Commit**

  ```bash
  git add app/src/shared/contracts.ts app/src/shared/api-schemas.ts app/src/main/ipc/query-ipc.ts app/src/main/application/query/workspace-projection.ts app/src/main/domain/projection/tree-projection-service.ts app/tests/unit/domain/family-union-projector.test.ts app/tests/integration/application/query-tools.test.ts app/tests/integration/application/workspace-projection.test.ts
  git commit -m "feat: project approved family tree scopes"
  ```

### Task 3: Four-view tree controls and actionable page states

**Files:**
- Modify: `app/src/renderer/src/features/tree/FamilyTreePage.tsx`
- Modify: `app/src/renderer/src/features/tree/tree.css`
- Modify: `app/src/renderer/src/app/AppShell.tsx`
- Modify: `app/tests/unit/renderer/FamilyTreePage.test.tsx`
- Modify: `app/tests/unit/renderer/FamilyTreeCanvas.test.tsx`
- Modify: `app/tests/unit/renderer/AppShell.test.tsx`

**Interfaces:**
- Consumes: Task 2's `TreeProjectionDto.scope` and `WorkspaceSnapshotDto.lineages`.
- Produces: `FamilyTreePage` props `lineages: WorkspaceLineageReadModel[]` and optional `onOpenLineageSettings(): void`, in addition to the existing API/people/edit callbacks.
- Produces: local lineage-choice derivation for the selected `subjectId`; no new lineage-read endpoint.
- Produces: exact selector label `围绕谁查看`, scope tabs, dynamic description/count, missing-primary action, multiple-primary warning/selector, and the existing context drawer behavior.

- [ ] **Step 1: Write failing control and description tests**

  Assert the tab names in DOM order, selector independence, and request payloads:

  ```ts
  expect(tabNames()).toEqual(["全谱", "本家支系", "核心亲属", "子孙后代"]);
  expect(screen.getByLabelText("围绕谁查看")).toHaveValue("subject");
  expect(lastProjectTreeCall()).toEqual({ view: "core", subjectId: "subject", viewpointId: "viewpoint" });
  expect(screen.getByText("正在显示闫明的父母、祖父母、兄弟姐妹、配偶和子女，共 12 人。结果基于当前已确认关系。")).toBeVisible();
  ```

  Also assert that Full Tree does not send `subjectId`, changing `围绕谁查看` does not change `当前视角`, and changing `当前视角` does not change the selected scope/subject.

- [ ] **Step 2: Write failing lineage-state and stale-response tests**

  Cover these exact states:

  - no people/subject: non-Full tabs show `请先选择“围绕谁查看”` and do not query;
  - no primary membership: show `尚未为 {姓名} 设置主要本家支系` and `前往设置本家支系`, without querying or guessing by surname;
  - one primary plus other memberships: default to the primary and allow switching through `选择本家支系`;
  - multiple primaries: show the correction warning, require an explicit choice, and do not query before selection;
  - the older of two pending responses is ignored after a rapid tab/subject switch;
  - a failed query exposes `重新加载`, and activating it repeats only the current valid request;
  - a selected drawer person/relationship is retained when present in the next projection and closed when absent;
  - confirmed person/relationship edits reload the currently selected scope and lineage without changing either selector.

- [ ] **Step 3: Run the focused renderer tests and verify RED**

  Run: `npm test -- tests/unit/renderer/FamilyTreePage.test.tsx tests/unit/renderer/FamilyTreeCanvas.test.tsx tests/unit/renderer/AppShell.test.tsx`

  Expected: old labels/tabs render, lineage state is unavailable, and scope metadata is not described.

- [ ] **Step 4: Implement page state derivation and request orchestration**

  Keep `viewpointId`, `subjectId`, `view`, and `lineageId` as distinct state. Reset lineage choice when the subject changes; auto-select only when exactly one primary membership exists. Preserve the existing request ID guard and selection normalization. Render loading, actionable empty state, query error/retry, true empty projection, and tree workspace as mutually exclusive states.

- [ ] **Step 5: Add accessible copy and responsive styling**

  Render scope description and visible count from returned metadata, always ending with `结果基于当前已确认关系。`. Add compact styles for the scope help, lineage warning, selector, and settings action without changing node geometry or ELK inputs.

- [ ] **Step 6: Wire workspace lineages and settings navigation**

  Pass `snapshot.lineages` from `AppShell`; implement `onOpenLineageSettings` by navigating to `/workspace/${workspace.id}/settings`. Do not duplicate lineage editing inside the tree page.

- [ ] **Step 7: Run the focused renderer tests and verify GREEN**

  Run the same command as Step 3.

  Expected: all new states, tab copy/order, independent selectors, counts, race handling, and drawer preservation tests pass.

- [ ] **Step 8: Commit**

  ```bash
  git add app/src/renderer/src/features/tree/FamilyTreePage.tsx app/src/renderer/src/features/tree/tree.css app/src/renderer/src/app/AppShell.tsx app/tests/unit/renderer/FamilyTreePage.test.tsx app/tests/unit/renderer/AppShell.test.tsx
  git add -p app/tests/unit/renderer/FamilyTreeCanvas.test.tsx
  git diff --cached --check
  git commit -m "feat: present four family tree views"
  ```

  Stage only the legacy tree-view test hunk from `FamilyTreeCanvas.test.tsx`; leave its pre-existing unrelated working-tree changes unstaged.

### Task 4: Browser workflow and legacy-view cleanup

**Files:**
- Modify: `app/tests/e2e-web/web-family-tree.spec.ts`
- Modify: `app/tests/e2e-web/web-parent-completion.spec.ts`
- Modify as found by the required scan: any remaining test fixture or call site containing the removed `branch` or `ancestors` tree views

**Interfaces:**
- Consumes: Tasks 2–3 public RPC and UI behavior.
- Produces: browser evidence that all four scopes, lineage setup states, labels, relationship editing, and the parent-completion tree regression work through the real Web server.

- [ ] **Step 1: Replace legacy branch/ancestor browser helpers and add failing acceptance coverage**

  Change the parent-completion helper from `视图中心`/`支系`/`view: "branch"` to `围绕谁查看`/`子孙后代`/`view: "descendants"`; it must still show the father, completed spouse, child, and marriage union.

  Add a family-tree browser scenario that creates a center person with parent/half-sibling/child/spouse facts and two lineage memberships, then asserts:

  ```ts
  await expect(page.getByRole("button").filter({ hasText: /全谱|本家支系|核心亲属|子孙后代/u }))
    .toHaveCount(4);
  await page.getByRole("button", { name: "核心亲属", exact: true }).click();
  await expect(page.getByText(/结果基于当前已确认关系/u)).toBeVisible();
  await expect(page.getByRole("group", { name: "人物：范围外人物", exact: true })).toHaveCount(0);
  ```

  Verify the no-primary action navigates to Settings, the selected primary lineage is requested by ID, switching kinship viewpoint relabels a visible node without changing scope, and each of the four tabs retains clickable person/relationship elements whenever that scope contains them.

- [ ] **Step 2: Run the focused browser tests and verify RED**

  Run from `app`: `npm run build:web`

  Then run: `npm run test:e2e:web:built -- tests/e2e-web/web-family-tree.spec.ts tests/e2e-web/web-parent-completion.spec.ts`

  Expected: new tab/copy/scope assertions fail against the old page behavior.

- [ ] **Step 3: Remove all legacy view identifiers**

  Run: `rg -n '"branch"|"ancestors"|视图中心' src tests scripts`

  Update only tree-view call sites and assertions; do not rename unrelated lineage-management or kinship-domain language. The final scan may retain ordinary prose about ancestors/lineages, but no `TreeViewDto`, request payload, tree tab, or selector may use the retired identifiers/copy.

- [ ] **Step 4: Rebuild and verify the focused browser workflows**

  Run the same command as Step 2.

  Expected: both browser files pass against the built Web application.

- [ ] **Step 5: Commit**

  ```bash
  git add app/tests/e2e-web/web-family-tree.spec.ts app/tests/e2e-web/web-parent-completion.spec.ts
  git commit -m "test: cover family tree view workflows"
  ```

### Task 5: 1000-person gate and complete verification

**Files:**
- Modify: `app/scripts/run-performance-gates.ts`
- Modify: `app/tests/performance/performance-gates.test.ts`
- Verify: all files changed by Tasks 1–4

**Interfaces:**
- Consumes: all prior tasks.
- Produces: `PERFORMANCE_GATES.scopedTreeProjectionP95Ms = 1_000`, measured over deterministic Core Relatives and Descendants requests in the existing 1000-person fixture, alongside the existing Full Tree/layout gate.
- Produces: exported `SCOPED_TREE_PROJECTION_WORKLOAD = { views: ["core", "descendants"], sampleCount: 20 }` so the benchmark contract is unit-testable without running the benchmark inside Vitest.
- Produces: final typecheck, unit/integration, Web build, browser, and performance evidence.

- [ ] **Step 1: Write the failing performance-contract test**

  ```ts
  expect(PERFORMANCE_GATES.scopedTreeProjectionP95Ms).toBe(1_000);
  expect(SCOPED_TREE_PROJECTION_WORKLOAD).toEqual({
    views: ["core", "descendants"],
    sampleCount: 20
  });
  ```

- [ ] **Step 2: Run the performance test and verify RED**

  Run: `npm test -- tests/performance/performance-gates.test.ts`

  Expected: the scoped projection gate/report fields are absent.

- [ ] **Step 3: Add the deterministic scoped projection measurement**

  Reuse the existing materialized 1000-person workspace. Choose fixed valid subjects from the first deterministic parent-child fact, alternate 20 Core/Descendants requests, record p95 under `scopedTreeProjectionP95`, and describe the workload with the exported constant. Enforce the 1,000 ms gate and leave the existing `full` with `collapseDepth: 4` layout benchmark unchanged.

- [ ] **Step 4: Run focused performance verification and commit**

  Run: `npm test -- tests/performance/performance-gates.test.ts`

  Run: `npm run performance`

  Expected: both exit 0 and the report records passing Full and scoped tree gates.

  ```bash
  git add app/scripts/run-performance-gates.ts app/tests/performance/performance-gates.test.ts
  git commit -m "test: gate scoped tree projection performance"
  ```

- [ ] **Step 5: Run static and complete automated verification**

  Run from `app`:

  ```bash
  npm run typecheck:web
  npm test
  npm run build:web
  npm run test:e2e:web:built -- tests/e2e-web/web-family-tree.spec.ts tests/e2e-web/web-parent-completion.spec.ts
  npm run performance
  ```

  Expected: every command exits 0; the full Vitest suite has no failed files/tests; both focused browser workflows pass; both tree performance gates are below their thresholds.

- [ ] **Step 6: Inspect the final diff and preserve unrelated work**

  Run: `git diff --check` and `git status --short`.

  Confirm that no database migration/runtime dependency was added, no unrelated pre-existing modification was staged, and the implementation matches every section of the approved spec.
