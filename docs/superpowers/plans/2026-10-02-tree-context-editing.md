# Tree Context Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the visual family tree to person and relationship editing through a safe contextual drawer.

**Architecture:** Enrich the existing tree projection with explicit business identifiers, then expose typed node/edge selection callbacks from React Flow. Reuse the existing person editor and family-relations components inside a tree drawer, while adding staged marriage correction/removal mutations so data errors are not represented as divorces.

**Tech Stack:** React 19, TypeScript, React Flow, SQLite, Zod, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-10-02-tree-context-editing-design.md`

## Global Constraints

- Preserve the existing structured preview, conflict validation, administrator confirmation, audit, and undo workflow.
- Do not infer business identifiers by parsing tree node IDs.
- Reuse `PersonDetail`, `PersonEditor`, and `FamilyRelationsPanel`; do not create duplicate person/relationship forms.
- Preserve the user's current uncommitted changes in tree layout, relationship panels, and kinship rules.
- No new runtime dependency or database migration.

## Review Focus

- A co-parent or single-parent union has no marriage record and must never expose marriage correction/removal actions.
- A stale selected person or relation after refresh must close cleanly rather than showing another entity.
- Selecting a parent-to-union edge and selecting the union must resolve to the same marriage only when `marriageId` is present.
- Correcting a spouse must reject identical spouses, missing people, active-marriage conflicts, and stale row versions before commit.
- Removing a marriage must not delete parent-child facts or make undo impossible.

---

### Task 1: Explicit tree interaction metadata

**Files:**
- Modify: `app/src/main/domain/projection/tree-projection-service.ts`
- Modify: `app/src/shared/contracts.ts`
- Test: `app/tests/unit/domain/family-union-projector.test.ts`

**Interfaces:**
- Consumes: `FamilyUnion.parentIds`, `FamilyUnion.childIds`, and `FamilyUnion.marriageId`.
- Produces: union nodes with `parentIds`, `childIds`, `marriageId`; edges with `unionId`, `parentIds`, `childId`, and `marriageId` as applicable.

- [x] **Step 1: Write the failing projection contract tests**

  Assert literal metadata for marriage, co-parent, single-parent, `parentUnion`, and `unionChild` records. The break caught is a UI opening the wrong entity because the projection omitted or guessed identifiers.

- [x] **Step 2: Run the focused test and verify RED**

  Run: `npm test -- tests/unit/domain/family-union-projector.test.ts`

  Expected: metadata assertions fail because the fields are absent.

- [x] **Step 3: Add the typed metadata to the projection and shared DTOs**

  Copy identifiers from each `FamilyUnion` into nodes and edges without changing topology or IDs.

- [x] **Step 4: Run the focused test and verify GREEN**

  Run: `npm test -- tests/unit/domain/family-union-projector.test.ts`

  Expected: all projection tests pass.

### Task 2: Clickable and selectable tree canvas

**Files:**
- Modify: `app/src/renderer/src/features/tree/FamilyTreeCanvas.tsx`
- Modify: `app/src/renderer/src/features/tree/PersonNode.tsx`
- Modify: `app/src/renderer/src/features/tree/FamilyUnionNode.tsx`
- Modify: `app/src/renderer/src/features/tree/tree.css`
- Test: `app/tests/unit/renderer/FamilyTreeCanvas.test.tsx`

**Interfaces:**
- Consumes: Task 1 metadata.
- Produces: `TreeSelection` and `onSelectionChange(selection: TreeSelection | null)`; visible selected node/edge state and accessible activation.

- [x] **Step 1: Write failing interaction tests**

  Assert that clicking a real person node yields its `personId`, clicking a marriage union or `parentUnion` edge yields its `marriageId`, clicking a `unionChild` edge yields its `childId` plus parent IDs, and clicking the pane clears selection.

- [x] **Step 2: Run the focused test and verify RED**

  Run: `npm test -- tests/unit/renderer/FamilyTreeCanvas.test.tsx`

  Expected: callbacks and selection styling do not yet exist.

- [x] **Step 3: Implement typed selection handlers and visual state**

  Add React Flow `onNodeClick`, `onEdgeClick`, and `onPaneClick` handlers; set `selected` from the controlled selection; add focus-visible and selected styles without making nodes draggable or connectable.

- [x] **Step 4: Run the focused test and verify GREEN**

  Run: `npm test -- tests/unit/renderer/FamilyTreeCanvas.test.tsx`

  Expected: existing layout/rendering tests and new selection tests pass.

### Task 3: Reusable tree person drawer

**Files:**
- Create: `app/src/renderer/src/features/tree/TreeContextDrawer.tsx`
- Modify: `app/src/renderer/src/features/tree/FamilyTreePage.tsx`
- Modify: `app/src/renderer/src/app/AppShell.tsx`
- Modify: `app/src/renderer/src/features/tree/tree.css`
- Test: `app/tests/unit/renderer/FamilyTreePage.test.tsx`

**Interfaces:**
- Consumes: `FamilyAgentApi`, workspace summary, person list, mutation refresh callback, and Task 2 person selection.
- Produces: a controlled drawer that loads `api.people.get`, renders `PersonDetail`/`PersonEditor`, supports relative quick-create, closes with button or `Escape`, and notifies the page after confirmed writes.

- [ ] **Step 1: Write failing person-drawer tests**

  Assert loading and displaying the selected person's real detail, entering edit mode, opening relative quick-create, closing with `Escape`, and refreshing detail/tree after a confirmed change.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `npm test -- tests/unit/renderer/FamilyTreePage.test.tsx`

  Expected: the page has no drawer or full API access.

- [ ] **Step 3: Implement the reusable drawer and page integration**

  Lift the relevant orchestration pattern from `PeoplePage`, pass the full API from `AppShell`, and keep the canvas mounted while the drawer opens. Reuse the existing mutation refresh callback and quick-create flow.

- [ ] **Step 4: Run the focused test and verify GREEN**

  Run: `npm test -- tests/unit/renderer/FamilyTreePage.test.tsx`

  Expected: person-drawer behavior passes without regressing tree loading/error states.

### Task 4: Safe marriage correction and removal mutations

**Files:**
- Modify: `app/src/shared/mutations.ts`
- Modify: `app/src/shared/api-schemas.ts`
- Modify: `app/src/main/application/facts/fact-commands.ts`
- Modify: `app/src/main/application/facts/fact-command-service.ts`
- Modify: `app/src/main/application/mutations/staged-mutation-service.ts`
- Modify: the existing SQLite relationship repository that owns marriage update/delete persistence
- Test: `app/tests/integration/application/fact-command-service.test.ts`
- Test: `app/tests/integration/application/staged-mutation-service.test.ts`
- Test: `app/tests/integration/audit/undo.test.ts`
- Test: `app/tests/integration/ipc/ipc-contracts.test.ts`

**Interfaces:**
- Consumes: marriage ID, expected row version, corrected spouse IDs/date/status fields, and source description.
- Produces: `marriage.correct` and `marriage.remove` staged intents with conflict checks, preview summaries, audit changes, soft removal, and undo support.

- [ ] **Step 1: Write failing domain, staged-preview, schema, and undo tests**

  Cover valid correction/removal plus identical spouses, missing people, active-marriage collision, stale version, child-fact preservation, and restoration through undo.

- [ ] **Step 2: Run the focused integration tests and verify RED**

  Run: `npm test -- tests/integration/application/fact-command-service.test.ts tests/integration/application/staged-mutation-service.test.ts tests/integration/audit/undo.test.ts tests/integration/ipc/ipc-contracts.test.ts`

  Expected: the new intents are not accepted or executed.

- [ ] **Step 3: Implement minimal correction/removal support across the existing mutation pipeline**

  Add strict Zod contracts, command validation, repository persistence through the existing operation context, human-readable preview changes, expected-version tracking, and reversible audit snapshots. Removal changes only the marriage record; parent-child facts remain untouched.

- [ ] **Step 4: Run the focused integration tests and verify GREEN**

  Run the same command as Step 2.

  Expected: all selected contract, mutation, and undo tests pass.

### Task 5: Relationship drawer and end-to-end page behavior

**Files:**
- Create: `app/src/renderer/src/features/tree/TreeRelationshipEditor.tsx`
- Modify: `app/src/renderer/src/features/tree/TreeContextDrawer.tsx`
- Modify: `app/src/renderer/src/features/tree/FamilyTreePage.tsx`
- Modify: `app/src/renderer/src/features/tree/tree.css`
- Test: `app/tests/unit/renderer/FamilyTreePage.test.tsx`
- Test: `app/tests/e2e-web/web-family-tree.spec.ts`

**Interfaces:**
- Consumes: Task 2 relationship selection, Task 3 drawer shell, Task 4 intents, `PersonDetailReadModel`, and `useStagedMutation`.
- Produces: marriage and parent-child relationship views that identify all participants, expose valid edit actions, stage changes, refresh the tree/detail after confirmation, and preserve valid selection.

- [ ] **Step 1: Write failing relationship-drawer tests**

  Assert marriage node/horizontal edge equivalence, correct parent-child participants for a vertical edge, absence of marriage actions for non-marriage unions, preview-before-write behavior, post-confirm refresh, stale-selection cleanup, and close behavior.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `npm test -- tests/unit/renderer/FamilyTreePage.test.tsx`

  Expected: relationship selections have no editor.

- [ ] **Step 3: Implement the relationship editor in the shared drawer**

  Reuse existing date fields, mutation review dialog, staged mutation hook, and family relation controls. Keep all writes behind preview/confirm; after a receipt, trigger workspace refresh and reload the projection.

- [ ] **Step 4: Run focused unit tests and verify GREEN**

  Run: `npm test -- tests/unit/renderer/FamilyTreePage.test.tsx tests/unit/renderer/FamilyTreeCanvas.test.tsx`

  Expected: all person and relationship tree interactions pass.

- [ ] **Step 5: Add and run the browser regression**

  In a disposable web workspace, create spouses and a child, open all three selection types, verify the drawer headings/participants, perform one staged correction, confirm it, and verify the refreshed tree.

### Task 6: Integrated verification

**Files:**
- Verify only; no planned production files.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: evidence that the feature builds and the complete suite remains green.

- [ ] **Step 1: Run web type checking**

  Run: `npm run typecheck:web`

- [ ] **Step 2: Run the complete test suite**

  Run: `npm test`

- [ ] **Step 3: Run the web build and focused browser test**

  Run: `npm run build:web`

  Run: `npm run test:e2e:web:built -- app/tests/e2e-web/web-family-tree.spec.ts`

  Expected: all commands exit 0 with no unreported failures.
