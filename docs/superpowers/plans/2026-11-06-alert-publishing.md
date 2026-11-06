# Alert publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish reviewer-approved Davis anomaly detectors in place, one review batch at a time, driven by the `alerts` sheet, with prepare/apply, snapshots, verify and rollback, like the dashboard pipeline.

**Architecture:** A pure core (`tools/src/lib/detector-publish.ts`) decides everything that can be decided without a tenant: selection, drift, the entity decision, the event-field mapping, value assembly and comparison. Three thin commands do the I/O: Settings API reads and writes, notebook reads, DQL runs, workbook writes, and the files under `migration/detector-promote/`. The sheet gains one tool column (`review_batch`) and one human column (`publish_override`).

**Tech Stack:** Node 22, TypeScript with `--experimental-strip-types`, `node:test`, exceljs, the existing `SettingsClient` / `DocumentClient` / `DqlClient`.

**Spec:** `docs/superpowers/specs/2026-10-29-alert-publishing-design.md`

## Global Constraints

- Every command defaults to prepare; nothing writes to the tenant or the workbook without `--apply`. A prepare run writes only files under `<tenant>/migration/detector-promote/`.
- `--apply` requires `--allow-env <env-id>` equal to `envIdFromBaseUrl(DT_BASE_URL)`, or the command throws before any read.
- **`migrate-promote-detectors` requires `--batches`.** There is no "publish everything Ready" mode.
- **Only two parts of a detector value may change:** the query input (`analyzer.input[]` with key `query` or `query.expression`) and `eventTemplate.properties`. Thresholds, every other analyzer input, `enabled`, `title`, `description` and `executionSettings` stay byte-identical to live.
- **The tool's writes to human sheet columns:** `decision` = `Published` after a publish, and `decision` = `Needs Review` after a rollback. It never writes `publish_override`, `reviewer`, `notes` or `assignee`.
- **Settings writes:** `putObject` with the `updateToken` from a `getObject` made in the same run, never retried automatically. Stop the run at the first HTTP 401/403.
- **Snapshots:** `migration/detector-promote/pre/<objectId>.json` holds the full live value, and the first one written wins. Published payloads go to `migration/detector-promote/published/<objectId>.json`.
- `publish_override` values (exact): `Publish per resource`, `Publish without entity`. It is honoured only when `decision` is Ready To Publish and `reviewer` is non-empty.
- Davis series cap: `DAVIS_SERIES_CAP` (10,000) from `lib/detector-binding.ts`.
- Built-in placeholders left alone: `threshold`, `severity`, `alert_condition`, `violating_samples`, `dealerting_samples`, `sliding_window`, `metricname`, `metric_value`, `baseline`, `dims`.
- Nothing customer-specific (environment ids, team codes, names) in `docs/` or code comments added by this plan.
- Never write regex literals through shell heredocs; edit files with the editor tools.

## Review Focus

1. **A re-run after a publish whose sheet write failed** (the workbook was open): the alert is still Ready on the sheet, and its live query now equals the approved one. Expect "already published, recorded only", not a drift skip and not a second PUT. Tests: Task 4 `driftOf` and Task 7.
2. **Two query tiles carrying the same alert's marker** (a reviewer duplicated the tile): expect a skip, "two query tiles for this alert", never a guess. Test: Task 6.
3. **The Settings API returning the value with keys reordered or defaults added:** the re-read check, verify and the rollback guard must compare only the parts we write (query input and event properties), key-order-insensitively. Test: Task 5 `publishedPartsEqual`.
4. **A classic dimension placeholder matching both a spaced column and its underscore alias** (`` `Broker ID` `` and `Broker_ID`): expect the column without spaces. Test: Task 5.
5. **A token without settings write in Prod:** the first `validateOnly` call returns 403, so the run stops with one clear message instead of 300 identical failures. Test: Task 6 `isAuthFailure`.

---

### Task 1: Sheet columns and the override dropdown

**Files:**
- Modify: `tools/src/lib/decision-states.ts`
- Modify: `tools/src/lib/tracker-xlsx.ts`
- Test: `tools/src/lib/tracker-xlsx.test.ts`, `tools/src/lib/decision-states.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `PUBLISH_OVERRIDES = ['Publish per resource', 'Publish without entity'] as const`
  - `type PublishOverride = 'per-resource' | 'without-entity'`
  - `parsePublishOverride(cell: string | undefined): PublishOverride | 'invalid' | undefined`
  - `TrackerRow.review_batch?: string`
  - `readRows(path, ALERTS_SHEET)` returns `review_batch` and `publish_override` like every other column.

- [ ] **Step 1: Write the failing tests**
  - `parsePublishOverride`:
    - `'Publish per resource'` → `'per-resource'`;
    - `'  publish WITHOUT entity. '` → `'without-entity'`;
    - `''` and `undefined` → `undefined`;
    - `'yes'` → `'invalid'`.
  - **`tracker-xlsx`, "alerts sheet gets review_batch and publish_override, migration sheet does not":** `upsertRows` one anomaly-detector row with `review_batch: 'batch-03'` into a temp workbook. Assert the `alerts` header contains `review_batch` and `publish_override`, and a `migration` sheet created in the same file has neither.
  - **"publish_override survives tool writes":** write a row, set the `publish_override` cell by hand via exceljs, upsert the row again with a new `status`, re-read, and assert the cell is unchanged.
  - **"publish_override cells carry the dropdown":** the cell's `dataValidation.formulae` equals `['"Publish per resource,Publish without entity"']`.
- [ ] **Step 2: Run them; expect FAIL** — `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/lib/tracker-xlsx.test.ts src/lib/decision-states.test.ts`
- [ ] **Step 3: Implement**
  - `decision-states.ts`: `PUBLISH_OVERRIDES`, `PublishOverride` and `parsePublishOverride`. Compare after trimming, lower-casing and stripping trailing `.,;`.
  - `tracker-xlsx.ts`: `ALERTS_TOOL_COLUMNS = [{ key: 'review_batch', header: 'review_batch', width: 12 }]` and `ALERTS_HUMAN_COLUMNS = [{ key: 'publish_override', header: 'publish_override', width: 22 }]`. A private `columnsFor(sheetName)` returns the base columns, plus these when `sheetName === ALERTS_SHEET`; use it in header init and schema evolution. Add `review_batch` to the writable tool keys. Add `applyOverrideDropdown(ws, header)`, mirroring `applyDecisionDropdown`, called from `upsertRows`. Extend the Instructions sheet text with one line on `publish_override`.
- [ ] **Step 4: Run them; expect PASS.** Then `npm test`: all pass.
- [ ] **Step 5: Commit**: `Add review_batch and publish_override columns to the alerts sheet`

### Task 2: Notebook read-back fixes

**Files:**
- Modify: `tools/src/lib/detector-notebook.ts`
- Test: `tools/src/lib/detector-notebook.test.ts`

**Interfaces:**
- Produces:
  - `parseOriginalBlock(value: string): string | undefined`: the classic query a tile was staged from, i.e. the lines after the `// [CCT-ORIGINAL]` line with the leading `// ` (or `//`) removed, trimmed; `undefined` when the marker line is missing.
  - `isEffectivelyEmpty(query: string): boolean`: true when nothing is left after removing `//` lines and `/* … */` blocks and trimming.
  - `parseReviewCard(markdown)` now returns the correct `objectId`.

- [ ] **Step 1: Write the failing tests**
  - **"parseReviewCard reads an id that contains the letter s":** id `vu9U3hXa3q0AAAABAB9idWlsdGluOmRhdmlzLmFub21hbHktZGV0ZWN0b3JzAAZ0ZW5hbnQABnRlbmFudAAkZGU4MzE3ZTgtOWYxYy0zNjM0LTkyZWQtYjZhNDI1ODQ4YWUzvu9U3hXa3q0`. Run `buildReviewCard({ objectId: id, title: 't' } as any)` through `parseReviewCard`; assert `.objectId === id`.
  - **"parseOriginalBlock is the inverse of buildReviewQuery":** for `original = 'timeseries a = avg(m)\n| filter x == "y"'`, `parseOriginalBlock(buildReviewQuery('id', 'new', original)) === original`. With no marker line → `undefined`.
  - **"isEffectivelyEmpty":**
    - a query whose every line starts with `//` → true;
    - `'/* x */\n  '` → true;
    - `'// c\ntimeseries a = avg(m)'` → false.
- [ ] **Step 2: Run them; expect FAIL** (the id test returns a truncated id).
- [ ] **Step 3: Implement.** Build the id pattern with a regex literal or `String.raw`, never `'\s'` inside a plain string. Add the two functions next to `parseReviewQuery`.
- [ ] **Step 4: Run them; expect PASS.** Then `npm test`.
- [ ] **Step 5: Commit**: `Fix the review card id parse and add read-back helpers for publishing`

### Task 3: Record each alert's review batch on the sheet

**Files:**
- Modify: `tools/src/commands/stage-detectors.ts` (the tracker rows built in the create path and the backfill)
- Modify: `tools/src/commands/refresh-alert-tracker.ts`
- Test: `tools/src/commands/refresh-alert-tracker.test.ts`

**Interfaces:**
- Consumes: `TrackerRow.review_batch` (Task 1).
- Produces: `batchOfDetectors(manifest: { batches?: Array<{ batch: string; notebookId?: string; detectors: Array<{ objectId: string }> }> }): Map<string, string>`, exported from `refresh-alert-tracker.ts`. It maps objectId → batch for published batches only (those with a `notebookId`).

- [ ] **Step 1: Write the failing tests**
  - **"batchOfDetectors maps published batches only":** two batches, one without `notebookId`; only the published one's ids are mapped.
  - **"nextStatus leaves publish statuses alone":** for each of `promoted`, `verified`, `rolled-back`, `nextStatus(s, 'blocked') === s` (already true today; this pins it).
- [ ] **Step 2: Run them; expect FAIL** (`batchOfDetectors` is undefined).
- [ ] **Step 3: Implement.**
  - `refresh-alert-tracker` reads `<base>/migration/detector-review/manifest.json` when present and sets `review_batch` on each row it writes.
  - `stage-detectors` sets `review_batch` on every row it records: create, backfill and `--record-only`.
- [ ] **Step 4: Run them; expect PASS.** Then `npm test`.
- [ ] **Step 5: Commit**: `Record each alert's review batch in its own sheet column`

### Task 4: Publish core, part 1: selection, drift, entity decision

**Files:**
- Create: `tools/src/lib/detector-publish.ts`
- Test: `tools/src/lib/detector-publish.test.ts`

**Interfaces:**
- Consumes:
  - `isReadyToPublish`, `isPublished`, `parsePublishOverride`, `PublishOverride` (`decision-states.ts`);
  - `BindingOutcome` (`detector-binding.ts`);
  - `envIdFromBaseUrl` (`paths.ts`).
- Produces:
  - `interface ManifestBatch { batch: string; notebookId?: string; detectors: Array<{ objectId: string; title: string }> }`
  - `interface PublishCandidate { objectId: string; title: string; batch: string; notebookId: string; reviewer: string; override?: PublishOverride; note?: string }`. `note` carries "publish_override ignored: …".
  - `selectForPublish(rows: Map<string, Record<string, string>>, batches: ManifestBatch[], opts: { batches: string[]; ids?: string[]; limit?: number }): { candidates: PublishCandidate[]; unknownBatches: string[] }`
  - `type Drift = 'none' | 'edited' | 'owner-migrated' | 'already-published' | 'unknown'`
  - `driftOf(a: { liveQuery: string; stagedQuery?: string; approvedQuery: string; liveIsMigrated: boolean }): Drift`
  - `type EntityDecision = { action: 'use-bound'; query: string } | { action: 'unbound' } | { action: 'skip'; reason: string }`
  - `decideEntity(outcome: BindingOutcome, override?: PublishOverride): EntityDecision`
  - `assertAllowedEnv(baseUrl: string, allowEnv: string | undefined, apply: boolean): void`

- [ ] **Step 1: Write the failing tests**
  - **"selects Ready rows in the named batches, in manifest order":** rows for three alerts in `batch-01` and one in `batch-02`; decisions Ready / Ready / Needs Review / Ready. `--batches batch-01` → the two Ready ids from `batch-01`, in manifest order.
  - **"skips rows already published":** a row with `decision` Published, and a row with `status` promoted, are not selected.
  - **"reports batch names the manifest doesn't have":** `batches: ['batch-99']` → `unknownBatches` is `['batch-99']`.
  - **"honours ids and limit":** `ids` narrows to listed ids; `limit: 1` keeps the first.
  - **"override needs a reviewer":** `publish_override` 'Publish per resource' with an empty reviewer → `override` undefined and `note` mentions the reviewer. With a reviewer → `override` is `'per-resource'`. An `'invalid'` value → undefined plus a note.
  - **"driftOf":**
    - live == staged (after trim) → `'none'`;
    - live == approved → `'already-published'`, checked first;
    - no staged query → `'unknown'`;
    - differs and `liveIsMigrated` → `'owner-migrated'`;
    - differs otherwise → `'edited'`.
  - **"decideEntity":**

    | outcome | no override | per-resource | without-entity |
    |---|---|---|---|
    | `bound` with query `q2` | use `q2` | use `q2` | unbound |
    | `unverified` | use its query | use its query | unbound |
    | `per-entity` | skip, reason contains "back for review" | use its query | unbound |
    | `too-many` | skip | skip | unbound |
    | `skipped` | skip | skip | unbound |
    | `error` | skip | skip | unbound |
  - **"assertAllowedEnv":**
    - throws when `apply` and `allowEnv` is missing;
    - throws when `allowEnv` names another environment;
    - passes when they match;
    - passes when not applying.
- [ ] **Step 2: Run; expect FAIL** (module missing).
- [ ] **Step 3: Implement** the signatures above. `selectForPublish` takes the batch from the manifest, not the sheet column (spec: publishing must not depend on the backfill).
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit**: `Add the publish core: selection, drift and the no-entity decision`

### Task 5: Publish core, part 2: event fields, value assembly, comparison

**Files:**
- Modify: `tools/src/lib/detector-publish.ts`
- Test: `tools/src/lib/detector-publish.test.ts`

**Interfaces:**
- Consumes: `EventTemplateChange` (`detector-rewrite.ts`); `SOURCE_ID_DIM` (`detector-binding.ts`).
- Produces:
  - `type EventProp = { key?: string; value?: unknown }`
  - `BUILTIN_PLACEHOLDERS: ReadonlySet<string>` (the Global Constraints list)
  - `mapEventFields(props: EventProp[], ctx: { columns: ReadonlySet<string>; entityColumn?: string; withoutEntity: boolean }): { props: EventProp[]; changes: EventTemplateChange[]; unresolved: string[]; nameColumn?: string }`
  - `withNodeNameColumn(query: string, entityColumn: string): string`. It appends `\n| fieldsAdd <entityColumn>.name = getNodeName(<entityColumn>)`.
  - `staticColumns(query: string): Set<string>`: names from the top-level `by:{}` of each `timeseries` (an alias takes its left-hand name), plus every `fieldsAdd x =` and `fields x =` / bare `fields a, b` name. Used only when no run returned rows.
  - `buildPublishValue(live: Record<string, unknown>, query: string, props: EventProp[]): Record<string, unknown>`
  - `publishedPartsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean`. It compares the query input value and `eventTemplate.properties` as key-sorted JSON.

- [ ] **Step 1: Write the failing tests**, each over a small props list:
  - **"drops the classic binding and sets the Smartscape one":**
    - props `[{key:'dt.source_entity', value:'{dims:dt.entity.custom_device}'}]`, `entityColumn: 'dt.smartscape.aws_sqs_queue'` → no `dt.source_entity`; a `dt.smartscape_source.id` prop with value `{dt.smartscape.aws_sqs_queue}`.
    - With `withoutEntity: true` and no entity column → neither key present.
  - **"maps a classic entity id and name":**
    - `event.name` `'High on {dims:dt.entity.custom_device.name} ({dims:dt.entity.custom_device})'` with entity `dt.smartscape.aws_sqs_queue` and columns `{dt.smartscape.aws_sqs_queue}` → `'High on {dims:dt.smartscape.aws_sqs_queue.name} ({dims:dt.smartscape.aws_sqs_queue})'`;
    - `nameColumn` is `'dt.smartscape.aws_sqs_queue.name'`.
  - **"keeps built-ins and emitted columns, bare or dims":** `'{threshold} {severity} {dims:ServiceName} {ServiceName}'` with column `ServiceName` → unchanged, no unresolved.
  - **"matches a respelled dimension":** `{dims:cluster_name}` with column `` Cluster Name `` → `` {dims:Cluster Name} ``.
  - **"prefers the column without spaces":** `{dims:broker_id}` with columns `Broker ID` and `Broker_ID` → `{dims:Broker_ID}`. This is Review Focus 4.
  - **"reports what it cannot map":** `{dims:Role}` with no matching column → `unresolved` is `['{dims:Role}']` and the text is unchanged.
  - **"without an entity, entity placeholders are removed":** `'Lag on {dims:dt.entity.custom_device.name}'`, `withoutEntity: true`, no entity → exactly `'Lag on'` (trailing whitespace trimmed), and one change is recorded.
  - **"withNodeNameColumn":** `withNodeNameColumn('timeseries x=avg(m), by:{dt.smartscape.aws_sqs_queue}', 'dt.smartscape.aws_sqs_queue')` ends with `\n| fieldsAdd dt.smartscape.aws_sqs_queue.name = getNodeName(dt.smartscape.aws_sqs_queue)`.
  - **"staticColumns":**
    - `'timeseries v = avg(m), by:{dt.smartscape_source.id = dt.smartscape.aws_x, QueueName}\n| fieldsAdd env = "a"'` → exactly `{v, timeframe, interval, dt.smartscape_source.id, QueueName, env}`.
  - **"buildPublishValue changes only the query and the event properties":**
    - A live value with `enabled: false`, `threshold` input `'5'`, `executionSettings.actor`, and a `query.expression` input. The result has the new query in `query.expression` and the new props.
    - Deep-equal to live after resetting those two parts.
    - It never mutates `live`.
  - **"publishedPartsEqual ignores key order and other fields":** two values with the same query and props but keys reordered, and one extra field on one side → true. A different query → false. This is Review Focus 3.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
  - `mapEventFields` processes every prop except `dt.source_entity` (dropped) and `dt.smartscape_source.id` (rebuilt from `entityColumn`).
  - **Placeholders** are `\{(dims:)?([^{}]+)\}`; keep the original form (`dims:` or bare).
  - **Classic entity id:** `^(dt\.entity\.[\w:]+|dt\.source_entity)$`. **Classic name:** the same with `\.name$`.
  - **Matching:** compare lowercased, with spaces, underscores and backticks removed. If several columns match, the one without spaces wins.
- [ ] **Step 4: Run; expect PASS.** Then `npm test`.
- [ ] **Step 5: Commit**: `Map alert event fields to the columns the approved query emits`

### Task 6: `migrate-promote-detectors`, prepare

**Files:**
- Create: `tools/src/commands/migrate-promote-detectors.ts`
- Modify: `tools/src/cli.ts` (case, flags, help text)
- Modify: `tools/src/lib/detector-publish.ts` (two small pure helpers below)
- Test: `tools/src/lib/detector-publish.test.ts`

**Interfaces:**
- Consumes: everything in Tasks 2, 4 and 5, plus:
  - `SettingsClient.getObject` / `putObject(…, { validateOnly: true })`;
  - `DocumentClient.getDocumentFull(id, true)`;
  - `DqlClient.query`;
  - `resolveBinding`, `emittedEntityColumn`, `DAVIS_SERIES_CAP`;
  - `lintQuery`;
  - `rewriteDql` + `loadRecipeIndex` (the same loader options as `stage-detectors`), used only to compute `liveIsMigrated` as `rewriteDql(live, index).rewritten === live`;
  - `readRows(trackerPath, ALERTS_SHEET)`.
- Produces:
  - `runPromoteDetectors(args: { outDir; baseUrl; token; trackerPath?; batches: string[]; ids?: string[]; limit?: number; apply?: boolean; force?: boolean; allowEnv?: string }): Promise<void>`
  - In `detector-publish.ts`:
    - `findApprovedTile(sections: Array<{ type?: string; state?: { input?: { value?: string } } }>, objectId: string): { value: string } | { error: string }`. It matches by `DETECTOR_MARKER_RE`; zero → error "query tile not found"; more than one → error "two query tiles for this alert" (Review Focus 2).
    - `isAuthFailure(e: unknown): boolean`: a `SettingsApiError` with status 401 or 403 (Review Focus 5).
  - Files:
    - `migration/detector-promote/prepare/<stamp>/plan.json`: `PublishPlanItem[]`.
    - `…/report.md`.
    - `…/payloads/<objectId>.json`.
  - `interface PublishPlanItem { objectId; title; batch; result: 'ready' | 'skipped' | 'recorded'; reasons: string[]; override?: PublishOverride; series?: number; entityColumn?: string; diff: { query?: { before: string; after: string }; fields: EventTemplateChange[] } }`

- [ ] **Step 1: Write the failing tests** for `findApprovedTile` (found / missing / duplicate) and `isAuthFailure` (401, 403 true; 400, a plain Error false).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement the command, prepare path.** Per candidate, concurrency 4, stopping all workers on `isAuthFailure`.

  Read:
  1. The approved query from the live notebook (cache one read per notebook).
  2. The live detector.
  3. The staged query: `parseOriginalBlock` of the `dql-<id>` section in `migration/detector-review/<batch>.json`, else of the live tile.

  Gates, in this order; the first failure decides the reason:
  1. Drift via `driftOf`. `already-published` → result `recorded`. `edited` / `owner-migrated` / `unknown` → skipped, unless `--force` with `--ids` naming it.
  2. `isEffectivelyEmpty`.
  3. Blocking lint.
  4. Run the approved query over the last 2 hours; an error → skipped with the message.
  5. Entity:
     - when `emittedEntityColumn` is undefined, run `resolveBinding(query, count7d)` and apply `decideEntity` with the candidate's override;
     - otherwise check that the 7-day series count is ≤ `DAVIS_SERIES_CAP`; over it → skipped.
  6. Columns: record keys plus `types[].mappings` of the 7-day run; if it errors, those of the 2-hour run; if both are empty, `staticColumns`.
  7. `mapEventFields`; any `unresolved` → skipped, naming the fields and saying "make the query emit the column".
  8. If `nameColumn` is set and not already a column → `withNodeNameColumn`.
  9. `buildPublishValue`, then `putObject(id, { value, updateToken, schemaVersion }, { validateOnly: true })`; failure → skipped.

  Then write:
  - `plan.json`;
  - `report.md`: a summary per batch and per reason, a list of every alert going out under a `publish_override` (with which one), then each alert's diff;
  - the payloads.

  **No workbook write, no tenant write.**

  CLI case `migrate-promote-detectors`: flags `--batches` (required), `--ids`, `--limit`, `--apply`, `--force`, `--allow-env`, `--tracker`. Help text: three lines in the style of `stage-detectors`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`: PASS.
- [ ] **Step 5: Verify against the lower environment (read-only).** From `tools/`, run `node --env-file=.env.local --experimental-strip-types --no-warnings=ExperimentalWarning src/cli.ts migrate-promote-detectors --batches <every batch-NN with Ready rows> --tracker "<team workbook>"`.

  Expected, against the spec's dry run, allowing for decisions made since:
  - the empty queries are skipped as empty;
  - roughly 21 skipped for drift;
  - 2 over the series cap;
  - per-resource no-entity alerts skipped "back for review";
  - the rest `ready`, each with a `validateOnly` pass.

  Open `report.md` and check three diffs by hand: one renamed dimension, one entity name, one per-resource skip.
- [ ] **Step 6: Commit**: `Add migrate-promote-detectors (prepare): gates, event fields, report`

### Task 7: `migrate-promote-detectors`, apply

**Files:**
- Modify: `tools/src/commands/migrate-promote-detectors.ts`

**Interfaces:**
- Consumes: Task 6's plan items; `upsertRows(trackerPath, rows, ALERTS_SHEET)`; `publishedPartsEqual`; `assertAllowedEnv`.
- Produces:
  - Sheet rows:
    - published: `{ status: 'promoted', decision: 'Published', promoted_at, review_batch, reasons }`;
    - skipped: `{ reasons }`;
    - recorded: same as published, with reasons "already published, recorded".
  - Files `pre/<id>.json` = `{ objectId, title, snapshotAt, value }` and `published/<id>.json` = `{ objectId, publishedAt, value }`.

- [ ] **Step 1: Implement the apply path.**
  1. `assertAllowedEnv` first.
  2. For each `ready` item, sequentially:
     1. Re-read the alert. If its query no longer equals the one planned, skip as drift.
     2. Write `pre/<id>.json` unless it already exists.
     3. `putObject` with the fresh `updateToken`.
     4. Re-read and check `publishedPartsEqual(reRead.value, payload)`. A mismatch is recorded in `reasons` and printed.
     5. Write `published/<id>.json`.
  3. Stop at the first `isAuthFailure`.
  4. One `upsertRows` at the end. If it throws, print "Published, but could not write the tracker" and the ids, as `migrate-promote` does.
- [ ] **Step 2: Run** `npm test` and `npm run typecheck`: PASS.
- [ ] **Step 3: Commit**: `Add migrate-promote-detectors apply: snapshot, locked write, re-read, sheet`

### Task 8: `migrate-verify-detectors` and `migrate-rollback-detectors`

**Files:**
- Create: `tools/src/commands/migrate-verify-detectors.ts`
- Create: `tools/src/commands/migrate-rollback-detectors.ts`
- Modify: `tools/src/cli.ts`
- Modify: `tools/src/lib/detector-publish.ts`
- Test: `tools/src/lib/detector-publish.test.ts`

**Interfaces:**
- Consumes: `published/<id>.json`, `pre/<id>.json`, `publishedPartsEqual`, `assertAllowedEnv`, the manifest, `readRows`, `upsertRows`.
- Produces:
  - `rollbackDecision(live: Record<string, unknown>, published: Record<string, unknown>, force: boolean): 'restore' | 'refuse-edited'`
  - `runVerifyDetectors(args: { outDir; baseUrl; token; trackerPath?; batches?: string[]; ids?: string[] })`
  - `runRollbackDetectors(args: { outDir; baseUrl; token; trackerPath?; batches?: string[]; ids?: string[]; apply?: boolean; force?: boolean; allowEnv?: string })`
  - Sheet rows:
    - verify: `{ status: 'verified', verified_at }` or `{ reasons }`;
    - rollback: `{ status: 'rolled-back', decision: 'Needs Review', reasons }`.

- [ ] **Step 1: Write the failing test** "rollbackDecision": live equal to published → `restore`; live edited → `refuse-edited`, or `restore` with `force`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement both commands.**
  - **Verify** selects rows with `status` promoted (filtered by `--batches` via the manifest, or by `--ids`), re-reads each alert and compares it with `published/<id>.json`. It never waits for events. There is no `--apply`: a verify writes only the sheet, and it is safe to run anytime.
  - **Rollback** requires `--ids` or `--batches`. It selects promoted or verified rows. With `--apply` and `assertAllowedEnv`, it re-reads each alert, applies `rollbackDecision`, and on `restore` PUTs `pre/<id>.json`'s `value` with the fresh `updateToken`, then re-reads.
  - CLI cases and help text for both.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`: PASS.
- [ ] **Step 5: Commit**: `Add migrate-verify-detectors and migrate-rollback-detectors`

### Task 9: Docs

**Files:**
- Modify: `docs/RUNBOOK.md` (alerts section)
- Modify: `docs/DECISIONS.md`
- Modify: `CLAUDE.md` (the alert pipeline bullets)

- [ ] **Step 1: RUNBOOK.**
  - The loop for one batch: prepare → read `report.md` → apply with `--allow-env` → verify. How to roll back one alert or a batch.
  - How to use `publish_override` and when.
  - **The manual soak check query**, copied from the spec's "Runbook additions", with its caveat about platform-wide timeouts.
- [ ] **Step 2: DECISIONS** under "How assets are published", generic wording:
  - **alerts publish in place, one review batch per run;**
  - only the query and event fields change; thresholds stay as the original alert has them;
  - an alert edited by its owner after review is skipped;
  - **an approved query with no entity goes back for review unless a reviewer sets `publish_override`;**
  - verify never waits for an alert to fire.
- [ ] **Step 3: CLAUDE.md.** Add the three commands to the notebook + anomaly-detector pipeline list (what each does, where its files go) and the two sheet columns.
- [ ] **Step 4: Commit**: `Document the alert publish loop`

### Task 10: First live run on the lower environment (needs the user's go-ahead)

No code. **Stop and ask the user before Step 2.**

- [ ] **Step 1:** Run Task 6 Step 5's prepare again for one batch. Pick 3 `ready` alerts from its report: one plain, one with a renamed event field, one disabled.
- [ ] **Step 2 (after the user's OK):** `migrate-promote-detectors --batches <that batch> --ids <the 3> --apply --allow-env <lower env id>`. Expect "published 3". The re-read check passes for all 3, and three sheet rows read promoted / Published.
- [ ] **Step 3:** `migrate-verify-detectors --ids <the 3>` → 3 verified.
- [ ] **Step 4 (after the user's OK):** `migrate-rollback-detectors --ids <one of them> --apply --allow-env <lower env id>`. The alert's value equals `pre/<id>.json` again: compare `publishedPartsEqual` against the snapshot, plus `enabled` and the threshold input. Its row reads rolled-back / Needs Review.
- [ ] **Step 5:** Report the results to the user, including anything the re-read check flagged about how the Settings API stores values.
