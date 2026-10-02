# Quick Create Feedback and Marriage Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make relation quick-create visibly respond and keep unrelated people out of spouse-to-marriage connection corridors.

**Architecture:** Keep relationship persistence unchanged. Improve PeoplePage's existing quick-create presentation with post-render scrolling/focus, and extend the existing ELK post-processing pass so marriage-connected nodes are packed as contiguous row groups before final overlap separation.

**Tech Stack:** React 19, TypeScript, ELK.js, React Flow, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-10-02-quick-create-and-marriage-layout-design.md`

## Global Constraints

- Preserve existing person and relationship data; this change is presentation-only.
- Preserve the current uncommitted changes in the tree layout, union label, and tree tests.
- Existing-person selection continues to use “添加……并预览”; quick-create creates a new person.
- No new dependency or data migration.

## Review Focus

- Reopening quick-create for a different relationship must focus the current form rather than a stale input.
- Browsers or tests without `scrollIntoView` must not crash.
- Adjacent marriage groups must remain non-overlapping after grouping.
- A person involved in more than one marriage must not be duplicated or dropped by row packing.
- Single-parent/descent edges must not be treated as marriage groups.

---

### Task 1: Quick-create feedback

**Files:**
- Modify: `app/src/renderer/src/features/relations/FamilyRelationsPanel.tsx`
- Modify: `app/src/renderer/src/features/people/PeoplePage.tsx`
- Test: `app/tests/unit/renderer/FamilyRelationsPanel.test.tsx`

**Interfaces:**
- Consumes: `RelativeQuickCreateRequest` and PeoplePage's existing `relativeCreation` state.
- Produces: explicit “新建人物并设为…” actions and a quick-create section that scrolls into view and focuses the `姓名` input after render.

- [x] **Step 1: Write the failing behavior test**

  Render `PeoplePage`, click “新建人物并设为母亲”, and assert that the real quick-create heading is visible, its section receives `scrollIntoView`, and the real `姓名` input is `document.activeElement`. Update existing quick-create tests to use the clarified child button label.

- [x] **Step 2: Run the focused test and verify RED**

  Run: `npm test -- tests/unit/renderer/FamilyRelationsPanel.test.tsx`

  Expected: the new mother test fails because the old button label is missing and no scroll/focus behavior exists.

- [x] **Step 3: Implement the minimal interaction change**

  Rename the four relation buttons in `FamilyRelationsPanel.tsx` to “新建人物并设为父亲/母亲/配偶/子女”. In `PeoplePage.tsx`, attach a ref to `.relative-person-creation`; when `relativeCreation` changes to a request, call optional `scrollIntoView({ block: "start", behavior: "smooth" })` and focus the section's `input[aria-label="姓名"]`.

- [x] **Step 4: Run the focused test and verify GREEN**

  Run: `npm test -- tests/unit/renderer/FamilyRelationsPanel.test.tsx`

  Expected: all FamilyRelationsPanel and PeoplePage quick-create tests pass.

### Task 2: Protected marriage-row layout

**Files:**
- Modify: `app/src/renderer/src/features/tree/layout-with-elk.ts`
- Test: `app/tests/unit/renderer/FamilyTreeCanvas.test.tsx`

**Interfaces:**
- Consumes: `TreeProjectionTopologyDto`, the position map produced by ELK, and marriage-role `parentUnion` edges.
- Produces: post-processed positions where each marriage-connected row component is contiguous and horizontally separated from unrelated nodes.

- [x] **Step 1: Write the failing layout regression**

  Add a topology matching the reported shape: two cousin branches on the same generation, one cousin's marriage, and children below it. Assert literal geometry invariants: no unrelated person center/rectangle lies between either spouse and the marriage node, spouses and union share the same center line, and no node rectangles overlap.

- [x] **Step 2: Run the focused test and verify RED**

  Run: `npm test -- tests/unit/renderer/FamilyTreeCanvas.test.tsx`

  Expected: the reported-layout assertion fails because the unrelated cousin is between the marriage node and spouse.

- [x] **Step 3: Implement contiguous marriage groups**

  Extend the row post-processing in `layout-with-elk.ts` to build marriage-connected components from union nodes and their marriage-role parent edges. Order each component by its existing horizontal positions, place its nodes contiguously with the existing minimum gap, treat the component as one row-packing block, and write the packed coordinates back to the shared position map. Leave single-parent and descent-only nodes as independent blocks.

- [x] **Step 4: Run the focused tree test and verify GREEN**

  Run: `npm test -- tests/unit/renderer/FamilyTreeCanvas.test.tsx`

  Expected: the reported regression, existing adjacent-family overlap case, and current tree rendering tests pass.

### Task 3: Integrated verification

**Files:**
- Verify only; no planned production files.

**Interfaces:**
- Consumes: Task 1 and Task 2 outputs.
- Produces: evidence that the two fixes do not regress the web build or related UI behavior.

- [x] **Step 1: Run related unit tests together**

  Run: `npm test -- tests/unit/renderer/FamilyRelationsPanel.test.tsx tests/unit/renderer/FamilyTreeCanvas.test.tsx`

  Expected: all selected tests pass.

- [x] **Step 2: Run web type checking**

  Run: `npm run typecheck:web`

  Expected: exit code 0 with no TypeScript diagnostics.

- [x] **Step 3: Verify both flows in the running web app**

  On the People page, open mother quick-create and verify visible scrolling/focus. On the Tree page, reload the user's existing workspace and verify 李格非 is outside 李腾飞与可可's marriage group with no card overlap.
