# User Story: Scan Dynatrace Workflows for Classic Cloud Dependencies

**Status**: Draft
**Category**: Discovery
**Migration Phase**: Prepare

## Story Statement

**As a** Dynatrace Administrator,
**I want** to see all Dynatrace Workflows that reference classic cloud metrics or classic entity types for a selected cloud provider,
**so that** I know which automations will silently break — or produce incorrect results — when the classic connection is removed.

## Context

Dynatrace Workflows are the platform's automation capability. Unlike dashboards, alerts, or SLOs, there are **no "classic" workflows** — Dynatrace Workflows are exclusively a new-platform feature using modern action types, one of which is a DQL query action. However, a workflow can still have classic cloud *dependencies*: specifically, tasks that embed DQL queries referencing classic metric keys or classic entity types will query data that disappears once the classic connection is removed.

Because workflow DQL tasks can monitor cloud resource health, alert on anomalies, or trigger remediation flows, a workflow silently querying empty results post-migration may execute with wrong data, suppress expected notifications, or fail to route issues to the correct teams — all degraded silently.

This story implements the **Workflows** tab on the Migration Assessment page (`/readiness`) introduced by Story 006. A placeholder tab is already rendered in `Readiness.tsx`. `[Source: ui/app/pages/Readiness.tsx]` This story replaces that placeholder with a functional scan. `[Source: .github/prompts/vision.prompt.md#Capabilities]`

All detection uses the existing `detectClassicMetricPatterns` and `detectClassicEntityPatterns` utilities from `classicPatterns.ts`, ensuring patterns stay consistent across all scan types. `[Source: ui/app/utils/classicPatterns.ts]`

The scan is **environment-wide** (like all other scans on `/readiness`) and results are scoped by the selected cloud provider from the page-level `ToggleButtonGroup` selector. `[Source: .github/stories/006-environment-readiness-scan-page.md#AC #1, #2]`

## Acceptance Criteria

### Scan Trigger

1. **Given** a user navigates to the Migration Assessment page (`/readiness`) and selects a cloud provider, **when** they click the "Workflows" tab, **then** the tab renders in an idle state with a single "Scan Workflows" button — consistent with the scan-on-demand pattern from Stories 002, 004, and 005.

2. **Given** the Workflows tab is in idle state, **when** the user clicks "Scan Workflows", **then** a loading indicator replaces the button and the scan fetches all workflows from the Dynatrace Automation API. When the scan completes, results are shown (or an empty state if none are found).

3. **Given** a provider is selected and a previous scan has run, **when** the user changes the provider selector, **then** the Workflows tab resets to idle state and previous results are discarded — no automatic re-scan occurs.

### Data Fetch

4. **Given** the scan is triggered, **when** fetching workflows, **then** all pages are retrieved (pagination handled in full) before results are presented — no partial first-page display.

5. **Given** a workflow cannot be read (permission denied, malformed structure), **when** encountered during the scan, **then** it is skipped silently without blocking the rest of the scan.

6. **Given** the environment has no workflows at all, **when** the scan completes, **then** a neutral empty state is shown: "No workflows found in this environment."

### Detection — DQL Tasks (Primary)

7. **Given** a workflow task has a DQL query action type (action identifier TBD — see Open Question #1), **when** scanned, **then** the DQL query string from the task's `input` field is analysed using `detectClassicMetricPatterns(queryString, provider)` and `detectClassicEntityPatterns(queryString, provider)` from `classicPatterns.ts`. If either returns matches, that task is included as an affected task.

8. **Given** a workflow task contains a DQL query with classic references for the selected provider, **when** results are shown, **then** the workflow appears in the results table and the affected task name, action type label, and list of detected classic patterns are shown.

### Detection — JavaScript Tasks (Secondary)

9. **Given** a workflow task has a JavaScript action type (`dynatrace.automations:run-javascript`), **when** scanned, **then** the task's `input.script` string is analysed using `detectClassicMetricPatterns(script, provider)` and `detectClassicEntityPatterns(script, provider)`. If either returns matches, that task is included as an affected task with action type label `JavaScript`.

10. **Given** a JavaScript task's `input.script` field is absent, empty, or exceeds a reasonable size threshold (see Open Question #2), **when** encountered, **then** it is skipped silently.

### Aggregation

11. **Given** a single workflow has multiple tasks with classic references, **when** displayed in the results table, **then** the workflow appears as a single row with an `affectedTasks` count. The user can expand the row to see the per-task breakdown (task name, action type, patterns) as a sub-table or sub-list.

12. **Given** a workflow appears in the results, **when** its row is rendered, **then** the following top-level columns are shown: **Name** (workflow title), **Affected Tasks** (count), **Classic Patterns** (deduplicated union of all patterns across all affected tasks), **Owner** (owning user/token), and a **Private** indicator.

### Empty & Error States

13. **Given** the scan completes and no workflows have classic dependencies, **when** results are shown, **then** the empty state reads: "No classic workflow dependencies detected for this provider."

14. **Given** the scan fails (network error, permission error, missing scope), **when** presenting results, **then** a full error state is shown with `MessageContainer variant="critical"` and a Retry button. The error message includes guidance that `automation:workflows:read` scope is required.

15. **Given** the scan runs and at least one workflow is successfully evaluated, **when** the scan completes with some failures (e.g., a subset of workflows could not be read), **then** results from successfully evaluated workflows are shown and a `MessageContainer variant="warning"` above the table notes how many workflows were skipped.

## Tasks / Subtasks

- [ ] Task 1: Define `WorkflowResult` and `WorkflowTaskResult` types (`ui/app/types/workflow.ts`) (AC: #8, #11, #12)
  - [ ] `WorkflowTaskResult`: `{ taskName: string; actionType: string; actionTypeLabel: string; classicPatterns: string[] }`
  - [ ] `WorkflowResult`: `{ id: string; title: string; owner: string; isPrivate: boolean; affectedTasks: WorkflowTaskResult[]; classicPatterns: string[] }` — `classicPatterns` is the de-duplicated union across all affected tasks
  - [ ] `WorkflowScanPhase`: `'idle' | 'scanning' | 'done' | 'error'`
  - [ ] `WorkflowScanState`: `{ results: WorkflowResult[]; status: WorkflowScanPhase; error?: string; run: () => void }`

- [ ] Task 2: Add `@dynatrace-sdk/client-automation` dependency (AC: #4)
  - [ ] Verify the correct package name and version against the installed `@dynatrace-sdk/*` package versions in `package.json`. The package may be `@dynatrace-sdk/client-platform-automation` — confirm before installing. (See Open Question #3)
  - [ ] Add to `package.json` `dependencies` at a version consistent with other `@dynatrace-sdk/*` packages
  - [ ] Add `automation:workflows:read` scope to `app.config.json` `[Source: app.config.json]`

- [ ] Task 3: Implement `useWorkflowScan` hook (`ui/app/hooks/useWorkflowScan.ts`) (AC: #2–#6, #13–#15)
  - [ ] Return shape: `WorkflowScanState`
  - [ ] Implement explicit `run()` — scan must NOT auto-start; hook begins in `idle` state
  - [ ] Reset to `idle` when `provider` changes (use `useEffect` with `[provider]` dependency)
  - [ ] Fetch all workflows via Automation SDK client (paginate until exhausted — see Open Question #4 for pagination style)
  - [ ] For each workflow, call `scanWorkflowTasks(workflow, provider)` (see Task 4)
  - [ ] Include only workflows where `scanWorkflowTasks` returns ≥1 affected task in `results`
  - [ ] Collect silently skipped workflow count in a `skipCount` ref; if `skipCount > 0` set a `partialWarning` field on state
  - [ ] Set `status: 'error'` with `error` message if the initial list API call fails

- [ ] Task 4: Implement `scanWorkflowTasks` pure function (AC: #7–#10)
  - [ ] Accepts `(workflow: WorkflowApiResponse, provider: CloudProvider): WorkflowTaskResult[]`
  - [ ] Iterate over `workflow.tasks` (object map — iterate `Object.entries`)
  - [ ] For each task, route by action type:
    - **DQL action** (identifier TBD — see Open Question #1): extract `task.input.<queryField>` (field name TBD — see Open Question #1), run pattern detection
    - **JavaScript** (`dynatrace.automations:run-javascript`): extract `task.input.script`, skip if absent/empty, run pattern detection
    - **All other action types**: skip — no classic dependency vector
  - [ ] Build `actionTypeLabel` from action identifier: DQL → `"DQL Query"`, JavaScript → `"JavaScript"`, unknown → use raw action string
  - [ ] Return array of `WorkflowTaskResult` for tasks with ≥1 detected pattern

- [ ] Task 5: Build `WorkflowsTab` component (`ui/app/components/WorkflowsTab.tsx`) (AC: #1–#3, #11–#15)
  - [ ] Props: `{ provider: CloudProvider }`
  - [ ] Idle state: `Button` labelled `"Scan Workflows"` that calls `run()`
  - [ ] Scanning state: `ProgressCircle` + "Scanning workflows…" text
  - [ ] Results state:
    - Top-level `DataTable` with columns: **Name**, **Affected Tasks** (number), **Classic Patterns** (comma-separated), **Owner**, **Private** (chip: `Private` / `Shared`)
    - Row expansion: clicking a row (or expand affordance) reveals a sub-list/sub-table of `affectedTasks` with columns: **Task Name**, **Action Type** (chip), **Patterns**
    - `DataTable` props: `sortable resizable`
    - Re-scan button above table (condensed, neutral)
    - Partial warning banner (`MessageContainer variant="warning"`) if `partialWarning` is set, stating how many workflows were skipped
  - [ ] Empty state — no workflows found: `EmptyState` with title `"No workflows found in this environment"`
  - [ ] Empty state — no classic dependencies: `EmptyState` with title `"No classic workflow dependencies detected"` and details naming the selected provider
  - [ ] Full error state: `MessageContainer variant="critical"` + Retry button with guidance text about `automation:workflows:read` scope

- [ ] Task 6: Register `WorkflowsTab` in `Readiness.tsx` (AC: #1–#3)
  - [ ] Import `WorkflowsTab` and replace the placeholder `EmptyState` in the "Workflows" `<Tab>` with `<WorkflowsTab key={provider} provider={provider} />`
  - [ ] The `key={provider}` forces remount on provider change, resetting all internal hook state (same pattern as `DashboardsTab`) `[Source: ui/app/pages/Readiness.tsx#key={provider}]`

---

## ARCHITECTURAL ANALYSIS
*Generated by architect agent on 2025-04-09*

### Resolved Open Questions (confirmed via live environment + SDK inspection)

#### OQ #1 — DQL task action identifier and input field path ✅ RESOLVED

Confirmed from live Dynatrace environment (`dtctl describe workflow 529c1a61...`):

- **Action identifier**: `dynatrace.automations:execute-dql-query`
  — **NOT** `dynatrace.automations:run-dql-query` (both spellings circulating in docs; live env is definitive)
- **DQL input field**: `task.input.query` — confirmed via `Object.keys(input)` on a live `execute-dql-query` task
- **JavaScript action**: `dynatrace.automations:run-javascript` with `task.input.script` — confirmed same environment

**Impact on Task 4**: The extraction logic for DQL tasks must use `task.input.query` (not `.dql`, not `.expression`). Update `scanWorkflowTasks` accordingly.

#### OQ #3 — Automation SDK package name and version ✅ RESOLVED

- **Package**: `@dynatrace-sdk/client-automation` ✅ correct (not `client-platform-automation`)
- **Version to install**: `^5.22.0`
  - `5.22.0` is the latest available 5.x version
  - `6.0.0` exists but is a **major version bump** — do NOT use; other `@dynatrace-sdk/client-*` packages in this project are pinned to `^5.x.x` (`client-classic-environment-v2: ^5.2.2`)
  - Mixing a v6 client with v5 peers risks runtime incompatibilities inside the AppEngine sandbox
- **Import**: `import { workflowsClient } from '@dynatrace-sdk/client-automation'` — singleton export (same pattern as `settingsObjectsClient`, `documentsClient`)
- **List method**: `workflowsClient.getWorkflows({ limit, offset })` (not `listWorkflows`)

#### OQ #4 — Pagination model ✅ RESOLVED

- **`PaginatedWorkflowList`** shape: `{ count: number; results: Workflow[] }` — **offset-based**, NOT cursor-based
- There is **no `nextPageKey`** field — this hook is the only one in the project using offset/limit pagination
- **Full task details are included in the list response** — `Workflow.tasks?: Tasks` is present in each list item
- No per-workflow `getWorkflow()` calls are needed
- **Pagination loop**: increment `offset` by `limit` on each iteration; stop when `results.length < limit` OR `offset + results.length >= count`
- **Recommended page size**: `limit: 50` — balances payload size vs. request count for typical environments

**Impact on UX spec AC gap #1**: Because task data is in the list response (not a separate GET per workflow), the multi-page scenario is "N pages of 50 workflows" not "N individual workflow GETs". With `count` available on the first response, the scanning label can show `"Scanning workflows… (N / total)"` using page count, not workflow count.

#### OQ #5 — Workflow visibility / private workflow scope ⚠️ PARTIAL

- `automation:workflows:read` scope returns: all public/shared workflows + private workflows **owned by the app's executing user**
- `adminAccess: true` on `getWorkflows()` would expose ALL workflows including other users' private ones — but requires the additional scope `automation:workflows:admin`, which is **not in scope for this story**
- **Recommendation**: Do NOT add `adminAccess: true`. Instead, surface an informational note in the idle state and in the "no workflows found" empty state — *"Private workflows owned by other users are not visible to this scan unless the `automation:workflows:admin` scope is granted."* This matches the story's edge case table entry.

---

### Files to Create

| File | Purpose | Template |
|------|---------|---------|
| `ui/app/types/workflow.ts` | `WorkflowResult`, `WorkflowTaskResult`, `WorkflowScanPhase`, `WorkflowScanState` types | Follow `ui/app/types/alert.ts` exactly — see convention violations below |
| `ui/app/hooks/useWorkflowScan.ts` | Scan hook — idle/scanning/done state machine, offset pagination, `scanWorkflowTasks` pure function | Follow `ui/app/hooks/useSloScan.ts`; note offset pagination difference |
| `ui/app/components/WorkflowsTab.tsx` | UI component — idle/scanning/results/empty/error states | Follow `ui/app/components/AlertsTab.tsx` |

### Files to Modify

| File | Change | Scope |
|------|--------|-------|
| `package.json` | Add `"@dynatrace-sdk/client-automation": "^5.22.0"` to `dependencies` | 1 line |
| `app.config.json` | Add `{ "name": "automation:workflows:read", "comment": "Automation API — list all workflows for classic dependency scanning (Story 007)" }` to `scopes` array | 1 entry |
| `ui/app/pages/Readiness.tsx` | Replace the placeholder `<EmptyState key={provider}>` in the `<Tab title="Workflows">` block (lines 126–137) with `<WorkflowsTab key={provider} provider={provider} />` | 1 import + 1 JSX swap |

### Files NOT to Touch

| File | Why |
|------|-----|
| `ui/app/utils/classicPatterns.ts` | `detectClassicEntityPatterns` already exists and is used by `useDashboardScan` and `useSloScan`. **No changes needed.** |
| `ui/app/components/Header.tsx` | No new top-level nav route — Workflows is a tab on `/readiness`, not a new page |
| `ui/app/App.tsx` | No new route needed |

---

### Convention Violations in Task 1 (type definitions)

The story's proposed `WorkflowScanState` deviates from every other scan hook in the codebase. Correct before implementation:

| Issue | Story proposes | Required (matches `AlertScanState`, `SloScanState`, `DashboardScanState`) |
|-------|---------------|------|
| State field name | `status: WorkflowScanPhase` | `phase: WorkflowScanPhase` |
| Phase union | `'idle' \| 'scanning' \| 'done' \| 'error'` | `'idle' \| 'scanning' \| 'done'` — error is a separate field, not a phase |
| Error field type | `error?: string` (optional) | `error: string \| null` (nullable, always present) |
| Missing field | `partialWarning` is mentioned in Task 3 but absent from Task 1's `WorkflowScanState` definition | Add `partialWarning: number \| null` (skip count; null when no skips occurred) |

Corrected `ui/app/types/workflow.ts` shape:

```ts
export type WorkflowScanPhase = 'idle' | 'scanning' | 'done';

export interface WorkflowTaskResult {
  taskName: string;
  actionType: string;
  actionTypeLabel: string;
  classicPatterns: string[];
}

export interface WorkflowResult {
  id: string;
  title: string;
  owner: string;
  isPrivate: boolean;
  affectedTasks: WorkflowTaskResult[];
  classicPatterns: string[];  // de-duplicated union across all affectedTasks
}

export interface WorkflowScanState {
  results: WorkflowResult[];
  phase: WorkflowScanPhase;
  error: string | null;
  partialWarning: number | null;  // skip count; null when nothing was skipped
  run: () => void;
}
```

---

### Hook Architecture (`useWorkflowScan`)

**Key divergence from other hooks — offset-based pagination:**

All existing hooks (`useAlertScan`, `useDashboardScan`, `useSloScan`) use cursor-based pagination via `nextPageKey`. `useWorkflowScan` is the **only hook using offset-based pagination**. Comment this explicitly.

```ts
// NOTE: The Automation API uses offset-based pagination (count + results),
// unlike other scans which use cursor-based nextPageKey pagination.
let offset = 0;
const LIMIT = 50;
do {
  const page = await workflowsClient.getWorkflows({ limit: LIMIT, offset });
  // ...process page.results...
  offset += LIMIT;
} while (offset < page.count);
```

**Reset strategy (Tasks 3 & 6 are compatible):**

- Task 3 says: internal `useEffect` with `[provider]` dependency → resets state fields
- Task 6 says: `key={provider}` remount in `Readiness.tsx`

Both are correct and complementary. Use both (same as `useAlertScan` which has an internal reset AND is mounted with `key={provider}` in `Readiness.tsx`). The internal `useEffect` makes the hook self-sufficient regardless of how it's consumed; `key={provider}` is defense-in-depth at the page level.

**`scanWorkflowTasks` placement:** Module-level pure function inside `useWorkflowScan.ts` — consistent with `scanMetricEvents`, `scanInfrastructureDetection`, `scanDavisDetectors` in `useAlertScan.ts` and `extractPatternsFromClassicTile` in `useDashboardScan.ts`. No convention violation.

**SDK type for `workflow` parameter:** Use `Workflow` from `@dynatrace-sdk/client-automation`, not a custom `WorkflowApiResponse`. The `Tasks` type is `{ [propName: string]: Task }` (confirmed from SDK `.d.ts`). `Task` has `action: string` and `input?: TaskInput | null` where `TaskInput` is `{ [propName: string]: any }`.

```ts
import type { Workflow } from '@dynatrace-sdk/client-automation';
// Use Workflow directly — do not define a local WorkflowApiResponse alias
function scanWorkflowTasks(workflow: Workflow, provider: CloudProvider): WorkflowTaskResult[]
```

---

### Architectural Validation

✅ **Strato imports**: All existing tab components use sub-package imports — `WorkflowsTab` must follow (`/buttons`, `/content`, `/layouts`, `/tables`, `/typography`)

✅ **`DataTable` graduation**: `@dynatrace/strato-components/tables` (stable) — correct, matching `AlertsTab.tsx` which already uses it

✅ **`detectClassicEntityPatterns` available**: Used by `useDashboardScan` and `useSloScan` — import as-is, no additions needed

✅ **`scanWorkflowTasks` placement**: Module-level pure function in hook file — matches project-wide pattern

✅ **`key={provider}` + internal `useEffect`**: Both used by `useAlertScan` — acceptable, not redundant by project standards

⚠️ **Offset pagination uniqueness**: Explicitly comment the pagination difference in the hook; devs familiar with other hooks will expect `nextPageKey`

⚠️ **`automation:workflows:admin` not in scope**: Without it, other users' private workflows are invisible. Surface in UI as a persistent informational note in idle state.

⚠️ **SDK version gate**: After `npm install`, verify the installed version is `5.x.x` (not `6.x.x`) with `npm list @dynatrace-sdk/client-automation`

---

### Implementation Order

1. **`ui/app/types/workflow.ts`** — Define types first (corrected shape above). All subsequent files depend on it.
2. **`package.json`** + `npm install` — Install `@dynatrace-sdk/client-automation@^5.22.0` before writing the hook (TypeScript type checks won't compile otherwise).
3. **`ui/app/hooks/useWorkflowScan.ts`** — Implement hook + `scanWorkflowTasks`. Template: `useSloScan.ts`.
4. **`ui/app/components/WorkflowsTab.tsx`** — Implement UI. Template: `AlertsTab.tsx`. Reference UX spec for DataTable columns, Chip colors, empty state text.
5. **`app.config.json`** — Add scope.
6. **`ui/app/pages/Readiness.tsx`** — Replace placeholder (one JSX swap).

---

### Testing Strategy

- **`scanWorkflowTasks`** (pure function): Test in a dedicated `.test.ts`; no mocks needed
  - `execute-dql-query` task with AWS classic `input.query` → included, patterns extracted
  - `execute-dql-query` task with Azure patterns but provider=AWS → excluded (0 patterns)
  - `run-javascript` task with classic metric in `input.script` → included as `JavaScript` type
  - `run-javascript` task with missing `input.script` → graceful skip, no throw
  - Task with `input: null` → graceful skip, no throw
  - HTTP / notification task → excluded
  - Workflow with mixed affected + unaffected tasks → only affected in returned array
- **`useWorkflowScan`**: Mock `workflowsClient.getWorkflows`; verify pagination loop terminates, provider-change reset, skip count
- **`WorkflowsTab`**: Render tests with mocked hook; assert idle button text, loading spinner, table columns, both empty state variants

### Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `6.0.0` accidentally installed instead of `5.22.0` | High | Verify with `npm list @dynatrace-sdk/client-automation` after install; lock to `^5.22.0` in `package.json` |
| Offset pagination loop doesn't terminate if `count` changes between pages | Low | Guard: `while (offset < page.count && page.results.length === LIMIT)` — stop if a short page is received |
| Large `input.script` in JavaScript tasks slows pattern matching | Low | Add `if (typeof script === 'string' && script.length > 65536) { skipCount++; continue; }` guard per OQ #2 guidance |
| Private workflows excluded silently → false-confidence "clean" result | Medium | Add informational `MessageContainer variant="primary"` note in idle state per OQ #5 resolution |

---

## Dev Notes

### Relevant Context
- The Workflows tab placeholder **already exists** in `Readiness.tsx` — Task 6 is a one-import, one-component swap. `[Source: ui/app/pages/Readiness.tsx Lines 108–115]`
- Pattern detection utilities (`detectClassicMetricPatterns`, `detectClassicEntityPatterns`) are already implemented in `classicPatterns.ts`. Do **not** duplicate logic — call them directly. `[Source: ui/app/utils/classicPatterns.ts]`
- The scan-on-demand pattern (`idle → scanning → done`) is established in `useAlertScan` and `useDashboardScan`. Follow that same state machine; do not introduce new lifecycle states. `[Source: ui/app/hooks/useAlertScan.ts]`
- The `key={provider}` remount strategy for resetting hooks without internal `useEffect` reset is used by `DashboardsTab`; `WorkflowsTab` should use the same approach. `[Source: ui/app/pages/Readiness.tsx]`

### Platform Capabilities

#### Dynatrace Automation API (Workflows)
- REST endpoint: `GET /platform/automation/v1/workflows` — list all workflows (paginated)
- REST endpoint: `GET /platform/automation/v1/workflows/{id}` — get single workflow with full task definitions
- SDK client: `@dynatrace-sdk/client-automation` — package name and exact client export name must be verified before Task 2 (see Open Question #3). The API may expose `automationClient.listWorkflows(...)` or similar.
- **Required scope**: `automation:workflows:read` — must be added to `app.config.json`
- **Task structure**: Each workflow has a `tasks` field — an object map keyed by task name. Each task entry has at minimum: `name`, `action` (the action identifier string), and `input` (action-specific payload object). Full schema must be verified (see Open Question #1).
- `[Source: https://docs.dynatrace.com/docs/deliver/dynatrace-platform-automation/api-architecture]`

#### Workflow Action Types
- The user confirmed that DQL is one of the workflow action types. The exact action identifier for DQL tasks must be verified (see Open Question #1). Candidates based on Dynatrace naming conventions: `dynatrace.automations:run-dql-query`.
- JavaScript tasks use action identifier: `dynatrace.automations:run-javascript` with `input.script` containing the script body. `[Source: https://docs.dynatrace.com/docs/deliver/dynatrace-platform-automation/workflows/javascript-actions]`
- Other action types (HTTP function, notifications, Davis AI, etc.) have no direct classic-cloud-metric dependency vector and should be skipped.

#### Pattern Detection (Existing Utilities)
- `detectClassicMetricPatterns(text: string, provider: CloudProvider): string[]` — returns matched classic metric key prefixes. `[Source: ui/app/utils/classicPatterns.ts]`
- `detectClassicEntityPatterns(text: string, provider: CloudProvider): string[]` — returns matched classic entity type strings from DQL expressions. `[Source: ui/app/utils/classicPatterns.ts]`
- Both functions are safe to call with arbitrary text (no throws) — run them against DQL query strings and JavaScript script bodies unchanged.

### Data Considerations
- Workflows are **not scoped by cloud account or provider** in the API — the list API returns all workflows in the environment. Provider scoping happens client-side during task scanning: only tasks whose text matches the selected provider's patterns are flagged.
- Workflow count: environments can have tens to hundreds of workflows. A single API list page with full task detail may be large. Prefer fetching the full task definition in the list response if available; fall back to per-workflow GET calls only if the list response omits task details (see Open Question #4).
- JavaScript script bodies can be large (hundreds of lines). The scan need not parse them semantically — a substring pattern match via `detectClassicMetricPatterns` (which uses `String.includes` / `startsWith` internally) is sufficient. If script size becomes a concern, add a character length guard (e.g., skip scripts > 64 KB) and surface a warning.
- De-duplicate `classicPatterns` at the `WorkflowResult` level using `[...new Set([...task1.patterns, ...task2.patterns])]`.

### Technical Constraints
- **Read-only**: no write calls at any point. `[Source: .github/prompts/vision.prompt.md#Constraints]`
- `@dynatrace-sdk/client-automation` is **not currently installed** — Task 2 must add it. Verify the package name against an up-to-date Dynatrace SDK registry or `node_modules` of another app before choosing a version. `[Source: package.json — automation client absent]`
- `automation:workflows:read` scope is **not currently in `app.config.json`** — Task 2 must add it. `[Source: app.config.json]`

## Cloud Provider Considerations

Workflow content is cloud-provider-agnostic from the API's perspective — the same workflow object exists regardless of whether it targets AWS, Azure, or GCP resources. Provider scoping is applied **after fetch**, client-side:

- The hook passes `provider` to `scanWorkflowTasks`, which in turn passes it to `detectClassicMetricPatterns` / `detectClassicEntityPatterns`
- Selecting "AWS" surfaces only tasks with AWS classic patterns; selecting "Azure" surfaces only Azure classic patterns; etc.
- This means the same workflow may appear in results for multiple providers if it has tasks that mix classic metric keys from different providers — correct and expected behavior
- No provider-specific API calls or schema variations — the Automation API is uniform across providers
- GCP support: DQL-based detection works for GCP classic patterns as soon as `classicPatterns.ts` includes GCP DQL entity patterns (already planned in earlier stories for `detectClassicEntityPatterns`)

## Dependencies

- **Story 002** (Scan Dashboards) — `classicPatterns.ts` with `detectClassicMetricPatterns` was created here. Required before implementing Task 4.
- **Story 006** (Environment Readiness Scan Page) — `/readiness` page and the Workflows tab placeholder exist here. Required before Task 6.
- **Story 005** (Scan SLOs) — `detectClassicEntityPatterns` was introduced here. Required before Task 4 if entity detection is in-scope for this story. If Story 005 is not yet merged, `detectClassicEntityPatterns` may need to be added to `classicPatterns.ts` as part of this story — check the current state of `classicPatterns.ts` before beginning.

## Testing Guidance

> **Note**: Testing strategy is an open topic — details will be refined when the QA Testing agent is established. For now, focus on identifying *what* to test, not *how*.

- **`useWorkflowScan`**: unit-test with mocked Automation SDK client; verify idle → scanning → done transitions, provider-change reset, and correct filtering to only include workflows with ≥1 affected task
- **`scanWorkflowTasks`**: pure function — pure unit tests with representative task payloads:
  - Workflow with a DQL task containing classic AWS metric prefix → included, patterns extracted
  - Workflow with a DQL task for a different provider (e.g., Azure when scanning AWS) → excluded
  - Workflow with a JavaScript task containing embedded DQL classic patterns → included as JavaScript type
  - Workflow with only HTTP / notification tasks → excluded (no affected tasks)
  - Workflow with mixed affected and unaffected tasks → only affected tasks in `affectedTasks`
  - Workflow task with missing/empty `input` — graceful skip, no throw
- **`WorkflowsTab`**: render test with mocked hook; assert idle state button, loading indicator, results table structure, and empty states

## Open Questions

1. **DQL task action identifier and input field path**: What is the exact `action` string for a DQL query task in Dynatrace Workflows? What field within `task.input` holds the DQL query string? Run `dtctl describe workflow-actions` (or equivalent) or inspect a live workflow with a DQL task. Candidates: action = `dynatrace.automations:run-dql-query`, query field = `input.query` or `input.dql`. The answer determines Task 4's extraction logic.

2. **JavaScript task scan size threshold**: Is there a practical maximum size for `input.script` fields in production environments? If scripts can be arbitrarily large, a character-length cap (e.g., 64 KB) should be introduced with a per-task warning flag rather than crashing or hanging the browser tab.

3. **Automation SDK package name**: Confirm the correct npm package name for the Dynatrace Automation API client. Known candidates: `@dynatrace-sdk/client-automation`, `@dynatrace-sdk/client-platform-automation`. Check against the deployed `dt-app` version and the Dynatrace SDK changelog.

4. **Pagination model**: Does `GET /platform/automation/v1/workflows` return full task definitions in the list response, or only workflow metadata (requiring a follow-up GET per workflow)? If metadata-only, large environments with hundreds of workflows will require many sequential requests — consider adding a progress indicator per-batch or a rate-limiter.

5. **Workflow visibility / ownership**: Does `automation:workflows:read` scope give access to private workflows owned by other users, or only the app's own workflows and public ones? If private workflows belonging to other users are inaccessible, surfacing a note in the UI ("Private workflows owned by other users are excluded from this scan") avoids false confidence.

---

## UX Specification (Added by UX Reviewer)

### User Flow

1. User arrives on `/readiness`, selects a cloud provider (AWS / Azure / GCP) via the `ToggleButtonGroup`.
2. User clicks the **Workflows** tab — sees idle state: single `"Scan Workflows"` button (`variant="emphasized" color="primary"`).
3. User clicks **Scan Workflows** — button is replaced by indeterminate `ProgressCircle` + scanning text.
   - If the API requires multi-page fetching, the scanning text updates with page progress (see AC gap #1 below).
4. Scan completes:
   - **No workflows in environment** → top-level `EmptyState`: "No workflows found in this environment."
   - **Workflows found, none have classic deps for this provider** → top-level `EmptyState`: "No classic workflow dependencies detected for [Provider]."
   - **Workflows found with classic deps** → results `DataTable` is shown.
   - **Scan failed entirely** → `MessageContainer variant="critical"` + Retry button.
   - **Scan partially succeeded** → results table (affected workflows only) + `MessageContainer variant="warning"` banner above table noting skip count.
5. In the results table, user expands a row to view per-task breakdown.
6. User can re-scan by clicking the condensed **Re-scan** button above the table.
7. If the user changes the provider selector, the tab remounts via `key={provider}` → returns to idle.

---

### Component Specifications

#### 1. Idle state — Scan trigger button

- **Strato Component**: `Button` from `@dynatrace/strato-components/buttons`
- **Required props**: `variant="emphasized"`, `color="primary"`, `onClick={() => void run()}`
- **Label**: `"Scan Workflows"` (sentence case, consistent with "Scan Dashboards" / "Scan for alerts" in sibling tabs)
- **States**: Default only — button disappears entirely when `run()` is called
- **Notes**: The story's Task 5 says ambiguously "a Button" — must match the established `variant="emphasized" color="primary"` used in `AlertsTab` and `DashboardsTab` idle states. Do NOT default to `variant="default"`.

---

#### 2. Scanning state — Progress indicator

- **Strato Component**: `ProgressCircle` from `@dynatrace/strato-components/content`
- **Required props**: `value="indeterminate"`, `aria-label="Scanning workflows"`
- **Companion text**: `Paragraph` from `@dynatrace/strato-components/typography`
  - Static text: `"Scanning workflows…"` (default)
  - If multi-page fetch is needed (see Open Question #4): update to `"Fetching workflows… (page N)"` using a `useState` counter updated per page
- **Layout**: `Flex flexDirection="column" alignItems="center" padding={32} gap={12}` — matches `AlertsTab` scanning state exactly
- **States**:
  - Indeterminate (single list API call): static label
  - Multi-page (if Open Question #4 resolves to metadata-only list): dynamic label with page counter

> **AC gap #1 — Scanning progress text for multi-page fetch**: The story specifies only a static "Scanning workflows…" text. If the API is metadata-only (requires one GET per workflow), an environment with 200 workflows means 200+ sequential requests with no visible progress. The hook should track a `fetchedCount` / `totalCount` and the component should render `"Scanning workflows… (N / M)"` as a `Paragraph` beneath the `ProgressCircle`. This gap must be resolved once Open Question #4 is answered.

---

#### 3. Results table — Outer `DataTable` (workflow-level rows)

- **Strato Component**: `DataTable` from `@dynatrace/strato-components/tables`
- **Required props**:
  - `data={results}` — memoized `WorkflowResult[]`
  - `columns={WORKFLOW_COLUMNS}` — memoized `DataTableColumnDef<WorkflowResult>[]`
  - `sortable`
  - `resizable`
  - `fullWidth`
  - `rowId={(row) => row.id}` — **REQUIRED** (see critical note below)
- **Column definitions** (`id`, `header`, `accessor`):

| Column ID | Header | Accessor | Cell rendering |
|---|---|---|---|
| `title` | Name | `title` | `DataTable.DefaultCell` plain text |
| `affectedTasks` | Affected Tasks | computed count | `DataTable.DefaultCell` right-aligned number: `affectedTasks.length` |
| `classicPatterns` | Classic Patterns | `classicPatterns` | `DataTable.DefaultCell` with `fontFamily: 'monospace', fontSize: '0.85em', wordBreak: 'break-all'` (matches `DashboardsTab` pattern column style) |
| `owner` | Owner | `owner` | `DataTable.DefaultCell`, fallback `'—'` for empty |
| `isPrivate` | Visibility | `isPrivate` | `Chip size="condensed"`: `isPrivate ? color="warning" label="Private" : color="neutral" label="Shared"` |

- **Pagination**: Add `<DataTable.Pagination defaultPageSize={25} />` as a child — environments with many affected workflows need pagination. The story omits this entirely (see AC gap #2 below).
- **Expandable rows**: Use `DataTable.ExpandableRow` (see Section 4 below — NOT native `subRows`)

> **AC gap #2 — Pagination**: The story specifies `sortable resizable` but omits pagination. `DataTable.Pagination` (`defaultPageSize={25}`) must be added to the `DataTable` child slot alongside `DataTable.ExpandableRow`.

> **CRITICAL: `rowId` is mandatory with `sortable`**: Without `rowId={(row) => row.id}`, `DataTable` identifies rows by their array index. When the user sorts the table, indices change — any open expanded details panel will visually jump to the wrong row. Workflow UUIDs from the Automation API are stable identifiers and must be used here.

---

#### 4. Row expansion — Per-task breakdown

> **CRITICAL: Use `DataTable.ExpandableRow`, NOT `subRows`**
>
> The story mentions "sub-list/sub-table" and "row expansion" but does not specify the Strato mechanism. There are two distinct DataTable expansion patterns:
>
> - **`subRows` prop**: Sub-rows share the **same TypeScript data type and the same column definitions** as parent rows. Expanding a row injects more rows of identical structure with indentation. Correct for tree-structured homogeneous data.
> - **`DataTable.ExpandableRow`**: Renders **arbitrary React content** in a full-width panel beneath the expanded row. Correct for heterogeneous detail content (different columns/schema than the parent).
>
> In this story, parent rows are `WorkflowResult` (Name, Affected Tasks, Classic Patterns, Owner, Visibility) and expanded content is `WorkflowTaskResult[]` (Task Name, Action Type, Patterns) — **completely different schemas**. Using `subRows` here would require forcing both levels into the same type, resulting in empty/meaningless cells in sub-rows. **`DataTable.ExpandableRow` is the only architecturally correct choice.**

- **Strato Component**: `DataTable.ExpandableRow` (subcomponent of `DataTable`)
- **Key props**:
  - `disableExpand`: not needed — every row in results has `affectedTasks.length >= 1` by the hook's filter guarantee
  - `defaultExpandedRows`: not set — all rows collapsed by default

**Expanded content structure** (rendered inside `DataTable.ExpandableRowWrapper`):

A nested `DataTable` with columns for per-task data:

| Column ID | Header | Accessor | Cell rendering |
|---|---|---|---|
| `taskName` | Task Name | `taskName` | `DataTable.DefaultCell` plain text |
| `actionTypeLabel` | Action Type | `actionTypeLabel` | `Chip size="condensed"` with color (see color map below) |
| `classicPatterns` | Patterns | `classicPatterns` | `DataTable.DefaultCell` with `fontFamily: 'monospace', fontSize: '0.85em', wordBreak: 'break-all'` |

- The nested `DataTable` should be `variant={{ contained: false }}` to visually nest within the parent row panel (no outer border)
- `sortable` is **not** needed on the task sub-table — task counts are small (1–5 typically)
- Import: `DataTable` from `@dynatrace/strato-components/tables` (same import, same component)

**Action type Chip color map** (task sub-table, `actionTypeLabel` column):

| `actionTypeLabel` | `Chip` color | Rationale |
|---|---|---|
| `"DQL Query"` | `color="primary"` | Primary detection vector — intentional DQL embedding |
| `"JavaScript"` | `color="warning"` | Indirect detection — script scanning is heuristic |
| Any other / raw | `color="neutral"` | Unknown action type, low confidence |

> **AC gap #3 — Chip color map not specified**: The story says "Action Type (chip)" for the task sub-table with no color guidance. The color map above must be reflected in the component spec or a `TASK_ACTION_TYPE_COLORS` constant in the implementation.

---

#### 5. Empty states

Both variants use `EmptyState` from `@dynatrace/strato-components/content`.

| Scenario | `EmptyState.Title` | `EmptyState.Details` | Suggested Action |
|---|---|---|---|
| No workflows exist in environment | `"No workflows found in this environment"` | `"This environment has no Dynatrace Workflows configured."` | None — informational |
| Workflows exist, none have classic deps | `"No classic workflow dependencies detected"` | `"No workflows reference classic [Provider] metrics or entity types."` — provider name interpolated | None — migration-ready signal |

- **Notes**: The "no classic deps" state is a **positive outcome** — wording should be neutral-to-positive, not "sorry, nothing found". The `EmptyState.Details` should name the provider so the user knows the result is scoped (e.g., "for AWS").

---

#### 6. Partial warning banner

- **Strato Component**: `MessageContainer` from `@dynatrace/strato-components/content`
- **Variant**: `"warning"`
- **Position**: Above the results `DataTable`, below the Re-scan button
- **Title**: `"Some workflows could not be scanned"`
- **Description**: `"N workflow(s) were skipped due to read errors and are not included in these results."` — N from `partialWarning` count
- **States**: Only rendered when `partialWarning` is set and > 0

---

#### 7. Full error state

- **Strato Component**: `MessageContainer` from `@dynatrace/strato-components/content`
- **Variant**: `"critical"`
- **Title**: `"Workflow scan failed"`
- **Description**: Dynamic error message from hook `error` field + guidance: `"Ensure the app has the automation:workflows:read scope in app.config.json."`
- **Action**: `Button variant="default" color="neutral" size="condensed"` labelled `"Retry"`, calls `void run()`
- **Layout**: `Flex flexDirection="column" gap={12} padding={16}` — matches `AlertsTab` error state

---

#### 8. Re-scan button (post-results)

- **Strato Component**: `Button` from `@dynatrace/strato-components/buttons`
- **Required props**: `variant="default"`, `color="neutral"`, `size="condensed"`, `onClick={() => void run()}`
- **Label**: `"Re-scan"`
- **Position**: Above the table (and above the partial warning banner), consistent with `DashboardsTab` re-scan placement

---

### Information Hierarchy

When results are available, the user sees top-to-bottom:

1. **Re-scan button** (condensed, top-left) — always accessible without scrolling
2. **Partial warning banner** (if applicable) — must be seen before the data to correctly interpret completeness
3. **Outer `DataTable`** — workflow-level rows, sortable by Affected Tasks count (descending default useful)
4. **Expanded row panel** — task-level `DataTable` inside `DataTable.ExpandableRowWrapper`, shown on demand
5. **`DataTable.Pagination`** — at the table bottom

---

### Edge Cases Not Covered by Current AC

| Scenario | Impact | Suggested Resolution |
|---|---|---|
| Workflow with exactly 1 affected task | Expand affordance still renders — user needs to see task name, action type, and patterns | No change needed; always expandable (all results have ≥1 task) |
| Classic Patterns column with 10+ pattern strings | Cell becomes very wide / overflows | Use `wordBreak: 'break-all'` inline style (matches `DashboardsTab`); add `defaultLineWrap={true}` on the column if needed |
| Private workflow visibility scope unknown (Open Question #5) | Scan may silently miss private workflows owned by other users, producing false "clean" result | Add a persistent `MessageContainer variant="primary"` info note below the idle button: *"Private workflows owned by other users may not be visible to this scan."* — shown only if the answer to Open Question #5 is "limited access" |
| Provider changed mid-scan | `key={provider}` forces remount, which unmounts the scanning state immediately | Already handled by `key={provider}` remount strategy; no change needed |
| Zero workflows returned but scan did not fail | Could be a permission issue, not truly "no workflows" | See Open Question #5; the "No workflows found" empty state should include a note about scope requirements if this state seems surprising |

---

### Suggested Acceptance Criteria Additions / Modifications

**Modify AC #11** — Replace the vague "sub-list/sub-table" wording:

> **Given** a workflow appears in the results table, **when** the user expands its row, **then** a task-level breakdown is shown using `DataTable.ExpandableRow` + `DataTable.ExpandableRowWrapper`, rendering a nested `DataTable` with columns: **Task Name**, **Action Type** (`Chip` with color: `primary` for DQL Query, `warning` for JavaScript, `neutral` for unknown), and **Patterns** (monospace, break-all). The expanded panel is available for all result rows (every result has ≥1 affected task by definition).

**Add AC #16 — Pagination**:

> **Given** the scan produces results, **when** the results table renders, **then** a `DataTable.Pagination` control is shown with a default page size of 25, allowing the user to page through results in large environments.

**Add AC #17 — Stable row identification**:

> **Given** the results table renders, **when** the user sorts by any column, **then** any open expanded task panel remains attached to the correct workflow row. This is achieved by specifying `rowId={(row) => row.id}` on the `DataTable` to use stable workflow IDs rather than array indices.

**Add AC #18 — Multi-page fetch progress** *(conditional on Open Question #4 answer)*:

> **Given** the scan requires fetching multiple pages of workflows, **when** the scanning state is displayed, **then** the scanning text updates to show the current page being fetched (e.g., `"Fetching workflows… (page N)"`) so the user knows the scan is progressing and not stalled.

---

### Migration Journey Context

The Workflows tab is the final scan type on the Migration Assessment page, covering the automation layer of the blast radius. Its expected use sequence:

1. Admin reviews Dashboards tab → understands visual layer impact
2. Admin reviews Alerts tab → understands notification/anomaly detection impact
3. Admin reviews SLOs tab → understands objective tracking impact
4. Admin reviews **Workflows tab** → understands automation / remediation layer impact

A "clean" Workflows result (no classic deps) is confidence that the migration won't silently break automated responses. A "dirty" result means the admin must update workflow DQL before cutting over. The "next step" after finding affected workflows is to open each in the Workflows app and update the embedded DQL — no direct link is in scope for this story, but a future enhancement could add an `ExternalLink` in the `title` column pointing to the Dynatrace Workflows app filtered to that workflow ID.

---

*UX review completed. Ready for architect handoff — outstanding decisions: Open Question #1 (DQL action identifier), Open Question #3 (SDK package name), Open Question #4 (pagination model), Open Question #5 (private workflow scope). The row expansion mechanism (`DataTable.ExpandableRow`), `rowId` requirement, and pagination gap should be resolved before implementation begins.*

## Out of Scope

- Scanning workflow **execution history** or run logs for classic data references — this story scans workflow definitions only
- Scanning workflow **triggers** (e.g., scheduled triggers referencing classic entities) — trigger analysis deferred to a future story
- Providing migration guidance or remediation steps for affected workflows — this is assessment only, consistent with all other scan stories
- Displaying workflow trigger type or schedule in the results table
- Scanning **notebooks** for classic dependencies — a separate future story
- Detecting classic dependencies in HTTP tasks (e.g., calls to `/api/v1/metrics` classic endpoints) — out of scope for v1
- Detecting classic references in Davis AI action inputs — out of scope for v1

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-04-09 | 1.0 | Initial draft | Story Writer |
