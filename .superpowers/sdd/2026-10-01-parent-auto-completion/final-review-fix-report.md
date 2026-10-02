# Parent auto-completion final-review fix report

Date: 2026-10-02

Base reviewed commit: `4d16ee04fd4414c0b4a0264e318c845d06ad92aa`

Branch: `codex/parent-auto-completion`

## Result

All five final-review findings are implemented on production paths. The public error remains `CONFLICT`; parent-completion freshness failures carry `details.code = "PARENT_COMPLETION_STALE"`. No test-only endpoint was added. The protected user-owned files `FamilyUnionNode.tsx`, `layout-with-elk.ts`, and `FamilyTreeCanvas.test.tsx` were not modified.

## Finding 1: correction is indivisible

Implementation:

- Added a strict public `parentChild.correct` intent containing the relation/version to remove and a nested `parentFamily.add`-equivalent replacement.
- The compiler expands that intent into removal followed by explicit replacement and assigns a server-generated `selectionGroupId` to the actionable pair. The client cannot submit its own group id because the Zod input is strict.
- Confirmation validates each correction group as all-or-none. Removal-only and replacement-only selections both fail before a transaction can commit.
- Preview validation propagates a blocked member across the complete correction group with `CORRECTION_REPLACEMENT_BLOCKED`; dependent auto-completion rows are then blocked as well. A replacement rejected by real genealogy validation therefore makes the removal non-actionable.
- `MutationReviewDialog` toggles all actionable members of a correction group together and independently verifies group completeness before enabling confirmation.
- `FamilyRelationsPanel` now stages one dedicated correction intent instead of an unrelated remove intent followed by an add intent.
- The undo test now confirms and reverses a real dedicated correction operation group.

Production-path evidence:

- `staged-mutation-service.test.ts` stages a real correction, rejects both one-sided selections, verifies no `mutation.confirm` group or data change, and then confirms the complete group.
- Its blocked-replacement case creates a real ancestor cycle, observes both preview rows blocked, and verifies the original relation remains active.
- `MutationReviewDialog.test.tsx` uses an in-memory migrated database plus the real `FactCommandService` and `StagedMutationService`; deselecting either row clears the pair, selecting either restores the pair, and the dialog calls real confirmation.
- `FamilyRelationsPanel.test.tsx` verifies that the UI emits the dedicated intent.

## Finding 2: missing evidence normalizes to stale

Implementation:

- Confirm-time re-planning now catches `ParentCompletionServiceError` caused by missing/archived/redirected people and converts it to `MutationValidationError("CONFLICT", ..., { code: "PARENT_COMPLETION_STALE" })`.
- Fingerprint/plan drift continues to use the same public stale detail code.
- `useStagedMutation` recognizes only that machine-readable detail code, discards the unusable preview, and shows: `父母补全依据已发生变化，请刷新人物资料后重新生成预览`.

Evidence:

- Application integration tests stage through the real service, then archive the child or merge it through `PersonMergeService`, and verify stale details, zero confirmation groups, and zero partial parent writes.
- The renderer hook test verifies actionable refresh guidance and preview invalidation.

## Finding 3: provenance is fact-specific

Implementation:

- Added migration 8, `fact source links`, with durable `fact_source_link` rows keyed by workspace/entity type/entity id/source id. The source foreign key uses `ON DELETE CASCADE`; the bounded lookup index is `(workspace_id, entity_type, entity_id)`.
- Added `FactSourceLinkRepository` to the unit of work. `FactCommandService` records each newly created source against the exact principal fact in the same transaction.
- `get_person` and relationship-source lookup prefer direct fact links and union legacy operation-group provenance only for the specific fact operation that has no direct link. Thus a migrated fact can retain old provenance and gain new directly-linked provenance without widening the new operation.
- Relationship lookup is restricted to `parent_child` and `marriage` fact types.
- Shared import sources created with `recordSource: false` retain their truthful legacy batch behavior.

Evidence:

- A two-row parent-completion repair is confirmed in one operation group; querying one repaired relation returns exactly its own source key.
- A legacy fallback test deletes direct links and verifies old person and relationship sources still resolve.
- A mixed-history test simulates a pre-migration person source followed by a directly-linked update and verifies both sources remain visible without widening the new operation.
- Undo verifies a direct link exists before undo and is removed by source cascade afterward.
- Migration tests verify version 8, the table, source cascade, lookup index, repeatability, and safe migration of older parent-completion audit data.
- Backup/restore and workspace schema-version expectations were advanced to version 8; the full backup suite passes.

## Finding 4: removal preview origin

Implementation:

- `parentChild.remove` now copies the persisted relation's `originKind` into the public preview change, with `explicit` used only when the relation cannot be loaded.

Evidence:

- A real inferred relation is created through `FactCommandService`, staged for removal through `StagedMutationService`, and asserted to render as `spouse_default` with its before/after relation fields.

## Finding 5: readable history provenance

Implementation:

- The audit history read model now has backward-compatible optional `originKind` and `inferredFromMarriage` fields.
- `UndoService.listOperationGroups()` inspects parent-child audit snapshots. For inferred rows it resolves the source marriage and both spouses, including archived rows, and returns names, marriage status, and start/end dates.
- Missing marriage/person detail returns `inferredFromMarriage: null`; it never substitutes an internal id.
- `AuditHistory` renders a concise Chinese source description and the safe fallback `系统自动补全亲子关系（来源婚姻详情暂不可用）` in both history and the undo dialog.

Evidence:

- The application test covers divorced marriage names and month/day precision plus a legacy inferred row without a marriage id.
- The renderer test verifies the exact readable text, the exact fallback, and absence of private relation ids.

## TDD evidence

Baseline before new tests:

```text
Test Files  9 passed (9)
Tests       113 passed (113)
```

Primary RED run after adding the final-review tests and before production changes:

```text
Test Files  9 failed (9)
Tests       21 failed | 101 passed (122)
```

Failures directly identified the missing table, two generic stale errors, two-source batch leakage, missing correction schema/compiler, inferred removal reported as explicit, absent history fields/UI text, absent UI group behavior, and absent stale refresh guidance.

Primary focused GREEN run:

```text
Test Files  9 passed (9)
Tests       122 passed (122)
```

Migration-compatibility RED added during self-review:

```text
Test Files  1 failed (1)
Tests       1 failed | 12 passed (13)
Expected: ["child-a", "child-a-update"]
Received: ["child-a-update"]
```

Compatibility GREEN after making fallback operation-specific:

```text
Test Files  3 passed (3)
Tests       47 passed (47)
```

An initial full-suite run also exposed one over-broad completeness link (`1 failed | 1110 passed`). Mapping that source to the audited `person_completeness` fact, rather than the person fact, restored the existing answer-evidence contract. The focused regression then passed `4 files / 55 tests`.

## Final verification matrix

All commands ran from `app` after the final production changes.

### `npm run typecheck`

Exit code: 0

```text
> tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json
```

### `npm test`

Exit code: 0

```text
Test Files  90 passed (90)
Tests       1112 passed (1112)
Duration    15.05s
```

### `npm run build:web`

Exit code: 0

```text
✓ 257 modules transformed.
../../out/web/index.html                     0.64 kB │ gzip:   0.40 kB
../../out/web/assets/index-BJHQeeKG.css     39.00 kB │ gzip:   7.62 kB
../../out/web/assets/index-CrO5GfRy.js   2,042.08 kB │ gzip: 626.96 kB
✓ built in 6.20s
```

Vite emitted its existing non-fatal warning that a minified chunk exceeds 500 kB.

### `npm run test:e2e:web:built`

Exit code: 0

```text
Running 14 tests using 1 worker
14 passed (30.5s)
```

This included `自动关系可移除、更正并通过操作历史整体撤销` and the parent-completion batch/tree scenarios against the built Web application.

### `npm run performance`

Exit code: 0; report field `passed: true`.

```text
defaultTreeAndLayout p95 591.894ms < 2000ms
viewpointRelabel p95 21.976ms < 500ms
personSearchP95 29.577ms < 500ms
personDetailP95 0.188ms < 500ms
relationshipP95 11.831ms < 1000ms
treeProjectionP95 19.047ms < 1000ms
parentCompletionScanP95 15.431ms < 1000ms; zeroWrites=true
importPreview p95 5496.889ms < 10000ms
```

## Changed files

Production and contracts:

- `app/src/main/application/audit/undo-service.ts`
- `app/src/main/application/facts/fact-command-service.ts`
- `app/src/main/application/mutations/staged-mutation-service.ts`
- `app/src/main/application/query/get-person.ts`
- `app/src/main/application/query/query-tool-registry.ts`
- `app/src/main/database/migrations/008-fact-source-links.ts` (new)
- `app/src/main/database/migrations/index.ts`
- `app/src/main/database/repositories/fact-source-link-repository.ts` (new)
- `app/src/main/database/unit-of-work.ts`
- `app/src/renderer/src/features/mutations/MutationReviewDialog.tsx`
- `app/src/renderer/src/features/mutations/useStagedMutation.ts`
- `app/src/renderer/src/features/relations/FamilyRelationsPanel.tsx`
- `app/src/renderer/src/features/settings/AuditHistory.tsx`
- `app/src/shared/api-schemas.ts`
- `app/src/shared/contracts.ts`
- `app/src/shared/mutations.ts`

Tests and fixtures:

- `app/tests/integration/application/query-tools.test.ts`
- `app/tests/integration/application/staged-mutation-service.test.ts`
- `app/tests/integration/audit/undo.test.ts`
- `app/tests/integration/backup/backup-fixture.ts`
- `app/tests/integration/backup/backup-restore.test.ts`
- `app/tests/integration/database/migrations.test.ts`
- `app/tests/integration/database/parent-completion-migration.test.ts`
- `app/tests/integration/database/person-code-migration.test.ts`
- `app/tests/integration/ipc/data-management-gateway.test.ts`
- `app/tests/integration/wiki/wiki-search.test.ts`
- `app/tests/integration/workspaces/workspace-manager.test.ts`
- `app/tests/unit/renderer/DataManagement.test.tsx`
- `app/tests/unit/renderer/FamilyRelationsPanel.test.tsx`
- `app/tests/unit/renderer/MutationReviewDialog.test.tsx`
- `app/tests/unit/renderer/useStagedMutation.test.tsx`

Report:

- `.superpowers/sdd/2026-10-01-parent-auto-completion/final-review-fix-report.md`

## Migration and compatibility notes

- Migration 8 is additive and leaves existing audit/source rows untouched.
- Old databases continue to resolve provenance through the legacy operation-group join. New direct links suppress that join only for the exact fact and operation group they cover, so old-only and old-plus-new histories both remain readable.
- `AuditOperationGroupDto` additions are optional; old producers/records remain valid.
- Source deletion cascades only the new metadata links. Undo still owns deletion/restoration of audited facts and sources, and backup/restore still copies the whole SQLite database.
- `AppErrorCode` was not expanded; stale remains public `CONFLICT` with a stable detail code.

## Self-review

- Confirmed the correction is atomic at three layers: preview blocking, server selection validation, and the existing single `BEGIN IMMEDIATE` confirmation transaction.
- Confirmed both one-sided selection directions are rejected and blocked replacement cannot archive the old relation.
- Confirmed the public schema rejects a client-controlled group id and extra replacement fields.
- Confirmed new batch provenance is bounded to one source per repaired fact and mixed migrated histories retain legacy sources.
- Confirmed source-link cascade under undo and all backup/migration suites.
- Confirmed inferred history never renders its relation/marriage internal id when marriage detail is unavailable.
- Confirmed `git diff --check` is clean and all three protected files have no diff.

## Concerns

- The Web build still reports the pre-existing non-fatal >500 kB chunk-size warning; all build, E2E, and performance gates pass.
- No remaining correctness or migration blocker was found.

## Residual correction fix

### Finding and implementation

The residual review found that a crafted `parentChild.correct` whose replacement repeated the existing parent, child, and role could compile an actionable grouped removal plus an ungrouped `unchanged` replacement. Because confirmation validates only actionable group members, that malformed draft could reduce to a removal-only group.

`StagedMutationService` now rejects this exact no-op at the application boundary, immediately after validating that a correction preserves the child and role and before it allocates a selection group or constructs the removal change. It raises `MutationValidationError("VALIDATION", "更正后的亲子关系与现有关系相同，无需更正")`. Consequently, no preview draft exists for a client to confirm with crafted selected IDs.

The real staged-service regression seeds an active parent-child fact, submits the crafted correction, verifies the domain validation error, and verifies that the original row remains active at version 1 with no new `mutation.confirm` operation group. The existing production-path tests for one-sided deselection and a blocked replacement remain unchanged and passing.

### RED evidence

Command, run before the production guard:

```text
npm test -- tests/integration/application/staged-mutation-service.test.ts -t "rejects a same-parent correction"
```

Exit code: 1.

```text
Test Files  1 failed (1)
Tests       1 failed | 30 skipped (31)
AssertionError: expected function to throw an error, but it didn't
```

### GREEN and verification evidence

Focused new regression:

```text
npm test -- tests/integration/application/staged-mutation-service.test.ts -t "rejects a same-parent correction"
Test Files  1 passed (1)
Tests       1 passed | 30 skipped (31)
```

All correction scenarios, including ordinary all-or-none selection and blocked replacement:

```text
npm test -- tests/integration/application/staged-mutation-service.test.ts -t correction
Test Files  1 passed (1)
Tests       4 passed | 27 skipped (31)
```

Complete staged mutation service suite:

```text
npm test -- tests/integration/application/staged-mutation-service.test.ts
Test Files  1 passed (1)
Tests       31 passed (31)
```

Required repository verification:

```text
npm run typecheck
Exit code: 0
tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json

npm test
Exit code: 0
Test Files  90 passed (90)
Tests       1113 passed (1113)
Duration    16.01s
```

### Changed files and compatibility

- `app/src/main/application/mutations/staged-mutation-service.ts`
- `app/tests/integration/application/staged-mutation-service.test.ts`
- `.superpowers/sdd/2026-10-01-parent-auto-completion/final-review-fix-report.md`

No schema, persistence, migration, or public error-code change was required. The guard only rejects a correction that would make no domain change; legitimate replacement corrections retain the existing atomic selection-group behavior.

### Self-review

- The guard executes before removal construction, so the invalid correction cannot create an actionable removal or a confirmable draft.
- Confirmation remains fail-closed for client-crafted IDs: no stored draft is created for this no-op, while existing server-side group validation still rejects either one-sided selection for legitimate corrections.
- The regression checks persisted fact state and confirmation history rather than relying on a hand-built preview.
- No protected tree file or unrelated production area was changed.
- No new compatibility or migration concern was identified.
