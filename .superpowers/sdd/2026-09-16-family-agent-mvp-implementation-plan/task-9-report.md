# Task 9 report: Spreadsheet Import, Preview, and Idempotent Re-import

## Inherited state

This task resumed from base `9092ff7` with uncommitted import implementation already present: parser and validator, planner, committer, identity repository integration, IPC/preload contracts, renderer preview/mapping UI, fixtures, and focused import/IPС/UI tests. The inherited implementation supplied the fixed XLSX/CSV schema, source-key identity resolution, field-level person diffs, same-name warnings without merging, validation for missing references/duplicates/cycles/dates, selected atomic commits through `FactCommandService`, and import reports.

## RED / GREEN

The initial focused run (with Vitest's runner config, required in this worktree) found one failing regression:

- `exports the exact fixed template without overwriting an existing file` expected a second export to reject, but it overwrote the first XLSX.

The parser now reserves the destination using exclusive file creation before writing the workbook and reports an existing destination as an error. The focused planner test then passed.

## Verification

- `npm test -- --configLoader runner tests/integration/import tests/integration/ipc/import-ipc.test.ts tests/unit/renderer/ImportPreview.test.tsx` — 22 passed.
- `npm test -- --configLoader runner tests/integration/import/import-planner.test.ts` — 7 passed after the template guard.
- `npm test -- --configLoader runner` — 23 files, 216 tests passed.
- `npm run typecheck` — passed.

The first focused test attempt without `--configLoader runner` was host-blocked: Vite/esbuild was denied access to a parent directory and could not resolve `vitest.config.ts`. The runner-configured commands above are the working verification path. Known host-blocked E2E was not run.

## Files

- Updated `app/src/main/application/import/workbook-parser.ts` to reject a pre-existing template target.
- Preserved the inherited import files, fixtures, contracts, IPC, renderer views, dependency lockfile, and tests.
- Removed the untracked `app/.npm-cache/` as requested.

## Self-review

- The template exports exactly the People, ParentChild, and Marriages fixed header sets.
- Spreadsheet parsing remains in the main process and is bounded by file, row, and cell limits; CSV requires an explicit entity selection.
- Identity keys remain scoped to workspace + source key + external person ID; raw source cells are retained on identities.
- Selected creates/updates execute in one `BEGIN IMMEDIATE` unit of work and operation group, with person identity/version revalidation before writes; failures roll back the transaction.
- IPC validates fixed payload shapes, checks the sender, and sanitizes thrown exceptions; the UI offers CSV field mapping, issue filters, exclusions, confirmation, diffs, and final report.

## Concerns

- The user-visible CSV flow accepts a local filesystem path rather than a native file-picker dialog. This is within the existing typed IPC design but can be improved separately for usability.
- Full test runs require Vitest's `--configLoader runner` in this restricted host; the default loader hits the documented parent-directory permission denial.

## Fix round 1

### Files changed

- Updated import IPC, shared contracts, preload bridge, and ImportPage so the renderer requests native main-process open/save dialogs and passes only opaque import-file tokens.
- Added a workspace-bound, single-use, five-minute capability store; selected files are canonicalized before token issuance.
- Added XLSX central-directory preflight and exact worksheet/header validation before ExcelJS reads workbook contents.
- Added explicit action dependency IDs, commit-time prerequisite rejection, disabled dependent rows in preview, and detailed final-row report rendering.
- Added hostile ZIP/template, capability/dialog, planner/committer dependency, IPC, and renderer report coverage.

### RED / GREEN

Initial red tests showed missing relationship dependencies, prerequisite validation, disabled UI state, detailed report rows, strict workbook enforcement, archive preflight, and the new `imports:select-file` IPC channel. The implementation was then added and the amended focused suite passed.

### Commands and results

- `npm test -- --configLoader runner tests/integration/import tests/integration/ipc/import-ipc.test.ts tests/integration/ipc/import-capabilities.test.ts tests/unit/renderer/ImportPreview.test.tsx` — 33 passed.
- `npm test -- --configLoader runner` — 25 files, 227 tests passed.
- `npm run typecheck` — passed.

### Self-review

- Renderer import/template requests contain no filesystem paths; no generic read endpoint was introduced.
- XLSX preflight rejects traversal, forbidden OOXML parts, ZIP64 metadata, excessive entries/sizes/ratios, and malformed central-directory layouts before ExcelJS expansion.
- The workbook must contain exactly the three ordered fixed sheets and exact ordered headers.
- Relationship actions name planned-person prerequisites; UI and commit validation reject invalid selected sets before writes, preserving the existing one-transaction commit behavior.
- Final UI report includes sheet, row, disposition, entity ID, issue codes, and operation-group value for every source row.
