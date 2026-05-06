# User Story: Scan Alerts for Classic Cloud Dependencies

**Status**: Draft
**Category**: Discovery
**Migration Phase**: Prepare

## Story Statement

**As a** Dynatrace Administrator,
**I want** to see all alert configurations that reference classic cloud metrics or classic entity types for a selected cloud account's provider,
**so that** I know which alerts will go silent or behave incorrectly when the classic connection is removed.

## Context

Alerts are among the highest-impact dependencies of a classic cloud connection. An alerting rule based on a classic metric key that disappears will stop firing without warning — producing silent monitoring gaps that are hard to detect until an incident is missed. Unlike a broken dashboard tile (which a user sees immediately), a broken alert is invisible until it matters most.

This story implements the second slice of Capability #2 (Dependency Analysis) from the vision document, scoped to alerts. It populates the **Alerts** tab on the account detail page (the tab frame was established in Story 002, which left this tab empty). `[Source: .github/prompts/vision.prompt.md#Capabilities]`

Three distinct alert systems must be scanned because customers may use any combination of them:

| Alert System | Settings Schema | Scope |
|---|---|---|
| **Custom Metric Events** | `builtin:anomaly-detection.metric-events` | Custom threshold alerts defined on any metric selector |
| **Classic Infrastructure Anomaly Detection** | `builtin:anomaly-detection.infrastructure-aws` (AWS only — no Azure or GCP equivalent exists) | Built-in anomaly detection rules scoped to classic AWS entity types |
| **Davis AI Custom Detectors** | `builtin:davis.anomaly-detectors` | DQL-expression-based anomaly detectors created via the Davis AI app |

All three schemas are accessed through the Settings Objects API (`settingsObjectsClient.getSettingsObjects`) using the OAuth `settings:objects:read` scope already present in `app.config.json`. No additional API token is required for this tab. `[Source: AGENTS.md#Configuration]`

## Acceptance Criteria

1. **Given** a user navigates to a classic account's detail page (from Story 001), **when** they click the "Alerts" tab, **then** the tab renders with a manual scan trigger button ("Scan for alerts"), consistent with the scan-on-demand pattern from Story 002.

2. **Given** the scan is triggered, **when** it completes, **then** the user sees a unified list of all alert configurations — across all three alert system types — that reference at least one classic metric key pattern or classic entity type matching the selected account's cloud provider.

3. **Given** an alert appears in the results list, **when** the user views its row, **then** they see: the alert name, an **alert type badge** (`Metric Event` / `Infrastructure Detection` / `Davis AI`), a **Migration Assessment badge** (`Migratable` or `Review Required`), an enabled/disabled status indicator, and the list of detected classic metric key patterns or an indication of the implicit entity-type binding (for infrastructure detection settings).

4. **Given** a Custom Metric Event is matched, **when** detected, **then** it is because its `metricSelector` field contains at least one classic key pattern from `CLASSIC_PATTERNS[provider]` (defined in Story 002). The detected patterns extracted from the `metricSelector` string are shown in the row.

5. **Given** a Classic Infrastructure Anomaly Detection setting (`builtin:anomaly-detection.infrastructure-aws`) exists with a customized (non-default) value on an AWS account, **when** detected, **then** it appears in the results with the alert type badge `Infrastructure Detection` and a pattern label `"Classic AWS entity types"` (rather than individual metric key strings, since this schema does not reference metric keys explicitly). This sub-scan is skipped entirely for Azure and GCP accounts — no equivalent schema exists.

6. **Given** a Davis AI Custom Detector is matched, **when** detected, **then** it is because its DQL expression or metric selector field contains at least one classic key pattern for the selected provider. The detected patterns are shown in the row.

7. **Given** the scan is running, **when** results have not yet loaded, **then** a loading state is shown inline. If no alerts with classic references are found after a complete scan, a neutral empty state confirms: "No classic alert dependencies found for this provider."

8. **Given** an alert configuration cannot be read (permission error, malformed value), **when** it is encountered during the scan, **then** it is skipped silently without blocking the rest of the scan.

9. **Given** a new account is selected from the inventory, **when** the detail page remounts, **then** any previously loaded Alerts scan results are cleared and the tab returns to its idle (pre-scan) state.

10. **Given** an alert has `enabled: false`, **when** it appears in the results list, **then** it is still shown (disabled alerts still represent a migration concern — they may be re-enabled) but its status indicator clearly marks it as disabled.

## Tasks / Subtasks

- [ ] Task 1: Rename "Metric Events" tab to "Alerts" in the tab frame (AC: #1)
  - [ ] Update the tab label string in `AccountDetail.tsx` — one-line change. The tab index remains the same as previously defined in Story 002.

- [ ] Task 2: Define `useAlertScan` hook (`ui/app/hooks/useAlertScan.ts`) (AC: #2, #7, #9)
  - [ ] Define the return shape: `{ results: AlertResult[], status: 'idle' | 'scanning' | 'done' | 'error', run: () => void }`
  - [ ] Implement an explicit `run()` method — the scan must NOT auto-start. The hook starts in `idle` state.
  - [ ] Orchestrate the three sub-scans in parallel (`Promise.allSettled`) — failure of one sub-scan must not block the others
  - [ ] Reset state to `idle` when `accountId` or `provider` change (AC: #9)
  - [ ] Use `settingsObjectsClient` from `@dynatrace-sdk/client-classic-environment-v2` for all three scans

- [ ] Task 3: Sub-scan A — Custom Metric Events (AC: #4)
  - [ ] Call `settingsObjectsClient.getSettingsObjects({ schemaIds: 'builtin:anomaly-detection.metric-events' })` — paginate with `nextPageKey` until exhausted
  - [ ] For each object, extract `value.metricSelector` and run `detectClassicMetricPatterns(value.metricSelector, provider)` from `ui/app/utils/classicPatterns.ts` (created in Story 002)
  - [ ] Collect matched metric key prefix strings from the `metricSelector` expression (extract the service-level prefix, e.g., `dt.cloud.aws.ec2.*`, not the full selector)
  - [ ] Build `AlertResult`: `{ id: objectId, name: value.name, enabled: value.enabled, alertType: 'metric-event', classicPatterns: string[] }`

- [ ] Task 4: Sub-scan B — Classic Infrastructure Anomaly Detection (AC: #5)
  - [ ] AWS provider only — call `settingsObjectsClient.getSettingsObjects({ schemaIds: 'builtin:anomaly-detection.infrastructure-aws', scopes: 'environment' })` (scope is `environment` — one object for the whole tenant; do **not** filter by credential entity ID)
  - [ ] If any objects are returned (customized thresholds exist), produce one `AlertResult`: `{ id: objectId, name: 'AWS Infrastructure Anomaly Detection', enabled: true, alertType: 'infrastructure-detection', classicPatterns: ['Classic AWS entity types'] }`
  - [ ] Azure and GCP providers: **skip this sub-scan** — no equivalent schema exists.
  - [ ] Empty response means all-default settings — not an error, no result.

- [ ] Task 5: Sub-scan C — Davis AI Custom Detectors (AC: #6)
  - [ ] Call `settingsObjectsClient.getSettingsObjects({ schemaIds: 'builtin:davis.anomaly-detectors' })` — paginate with `nextPageKey` until exhausted
  - [ ] For each object, extract the DQL/metric expression field (field name requires verification — see Open Question #1)
  - [ ] Run `detectClassicMetricPatterns(expressionText, provider)` and build `AlertResult` with `alertType: 'davis-ai'`
  - [ ] If the schema ID does not exist in the environment (older Dynatrace version without the app), treat gracefully as no results

- [ ] Task 6: Build `AlertsTab` component (`ui/app/components/AlertsTab.tsx`) (AC: #1–#10)
  - [ ] Props: `{ provider: CloudProvider; accountId: string }`
  - [ ] Scan trigger: a `Button` labelled "Scan for alerts" that calls `run()` — replaces the button with a loading indicator (`ProgressCircle`) during scan
  - [ ] Results: `DataTable` with columns: Name, Type (badge), **Migration Assessment (badge)**, Enabled (status chip), Classic Patterns
  - [ ] Migration Assessment column: `Chip` with three states:
    - `End of Life` (critical/red) — when any detected classic key resolves to a metric flagged `endOfLife: true` in the mapping table. Checked via `hasEndOfLifeMetrics()` from `metricKeyMapping.ts`.
    - `Migratable` (success/green) — when all detected classic keys resolve to a valid DAC metric key via `isMigratable()` and none are EOL.
    - `Review Required` (warning/yellow) — all other cases. `infrastructure-detection` and GCP alerts always show `Review Required`.
  - [ ] Type badge: use `Chip` — `Metric Event` / `Infrastructure Detection` / `Davis AI`
  - [ ] Enabled column: `StatusBadge` or `Chip` — `Enabled` / `Disabled` (AC: #10)
  - [ ] Classic Patterns cell: comma-separated pattern strings from `AlertResult.classicPatterns`
  - [ ] Empty state for no results (AC #7): `EmptyState` with title `"No classic alert dependencies found"` and a details line
  - [ ] Partial warning banner: `MessageContainer variant="warning"` above the table/empty state when ≥1 sub-scan failed but ≥1 succeeded
  - [ ] Re-scan button: `Button variant="default" color="neutral" size="condensed"` in the results toolbar above the table
  - [ ] Full error state: `MessageContainer variant="critical"` + Retry button when all sub-scans fail
  - [ ] `DataTable` props: `sortable resizable`

- [ ] Task 7: Register `AlertsTab` in `AccountDetail.tsx` (AC: #1)
  - [ ] Import `AlertsTab` and render it inside the "Alerts" tab panel
  - [ ] Pass `provider` and `accountId` from route state/params

## Dev Notes

### Relevant Context
- This story builds on the tab frame defined in Story 002. The "Alerts" tab was previously labelled "Metric Events" in Story 002's task list — this story renames it and populates it. `[Source: .github/stories/002-scan-dashboards-for-classic-dependencies.md#Out of Scope]`
- `CLASSIC_PATTERNS` from `ui/app/utils/classicPatterns.ts` (created in Story 002, Task 1) is the authoritative source for provider-specific classic metric key patterns. Do not hardcode patterns in this hook. `[Source: .github/stories/002-scan-dashboards-for-classic-dependencies.md#Tasks]`
- The `TokenContext` established in Story 002 is **not** needed for this story — all three alert schemas are accessed via the Settings Objects API using OAuth. No API token banner or conditional rendering is required in `AlertsTab`. `[Source: .github/stories/002-scan-dashboards-for-classic-dependencies.md#Dev Notes]`

### Platform Capabilities

#### Settings Objects API
- `settingsObjectsClient.getSettingsObjects({ schemaIds: '...', nextPageKey: '...' })` from `@dynatrace-sdk/client-classic-environment-v2` — paginate using `nextPageKey` until exhausted. Max page size is 500.
- **Required scope**: `settings:objects:read` — already present in `app.config.json`. `[Source: app.config.json]`
- The `value` field of each returned object contains the schema-specific payload. The shape of `value` differs per schema — examine the `.d.ts` models or live schema description for field names.
- Empty response (no objects returned) means the schema is at default configuration — not an error.
- If a schema ID does not exist in the environment (e.g., Davis AI app not installed), the API returns a 404 or empty result — handle gracefully.

#### Schema Details

**`builtin:anomaly-detection.metric-events`**
- One object per custom metric event rule. `value.metricSelector` is the metric selector string (e.g., `ext:cloud.aws.ec2.cpu_usage:avg:auto`). `value.name` is the human-readable name. `value.enabled` is a boolean.
- The `metricSelector` string uses classic metric key prefixes directly — scan with `detectClassicMetricPatterns(value.metricSelector, provider)` from `classicPatterns.ts`.
- `[Source: node_modules/@dynatrace-sdk/client-classic-environment-v2 — settings-objects-api.d.ts]`

**`builtin:anomaly-detection.infrastructure-aws`**
- A schema-level configuration that controls anomaly detection thresholds for classic AWS entity types (EC2 CPU/memory, RDS connections, etc.). It is entity-type-bound, not metric-key-based.
- Only customized (non-default) objects are returned by `getSettingsObjects`. If the environment has only default settings, no objects are returned — treat as no migration concern.
- There is no metric key string to extract; the migration concern is existence: "custom thresholds have been set for classic entity types that will cease to exist."
- `[Source: docs/aws-classic.md#6 Settings Schemas]`

**`builtin:anomaly-detection.infrastructure-aws` is AWS-only**
- No equivalent schema exists for Azure or GCP classic connections. The infrastructure anomaly detection sub-scan only runs when the selected provider is AWS.

**Davis AI Custom Anomaly Detectors**
- Schema ID: `builtin:davis.anomaly-detectors` (verified). Stores DQL-based anomaly detectors created via the Davis AI app.
- The exact field names in `value` (DQL/metric expression, display name) require verification — run `dtctl describe settings-schema builtin:davis.anomaly-detectors -o json` before implementing Task 5. Use `value.displayName ?? value.name ?? objectId` as a name fallback (see Open Question #1).
- Pattern matching: use `detectClassicMetricPatterns(text, provider)` from `classicPatterns.ts`, same as metric events.

### Data Considerations
- Settings objects are returned with a `value` field as a generic JSON object — the exact shape depends on the schema. Inspect the schema definition or live data to determine field names before implementing pattern extraction.
- Classic metric key pattern matching on `metricSelector` strings works identically to the dashboard scan in Story 002. Use `detectClassicMetricPatterns(text, provider)` from `classicPatterns.ts`.
- Pagination: use `nextPageKey` loop. For environments with many custom metric events, a single request may not return all objects (max 500 per page).
- The `builtin:anomaly-detection.infrastructure-aws` schema is expected to have very few objects (typically one per scope). No pagination concern.
- Scan results are scoped to `provider` — an AWS account selection shows only AWS-related alert matches.

### Technical Constraints
- **Read-only**: no write calls. `[Source: .github/prompts/vision.prompt.md#Constraints]`
- `settings:objects:read` scope is already in `app.config.json` — no scope changes expected for this story. `[Source: app.config.json#scopes]`
- `settingsObjectsClient` from `@dynatrace-sdk/client-classic-environment-v2` is already a declared dependency. `[Source: package.json]`
- All three sub-scans run in parallel (`Promise.allSettled`) to minimise wall-clock scan time. Failure of one sub-scan produces a partial result set with a non-blocking warning, not a full scan failure (AC: #8).

## Cloud Provider Considerations

### AWS
- Scan Metric Events for: `dt.cloud.aws.`, `cloud.aws.`, `cloud.aws.<svc>.<MetricName>.By.<Dim>` (metric streams pattern) — pulled from `CLASSIC_PATTERNS.aws`
- Additionally scan: `builtin:anomaly-detection.infrastructure-aws` for existence of customized thresholds
- Davis AI detectors: scan for the same AWS metric key patterns in DQL/metric expression fields

### Azure
- Scan Metric Events for: `dt.cloud.azure.`, `cloud.azure.microsoft_` — pulled from `CLASSIC_PATTERNS.azure`
- Infrastructure schema equivalent: **none** — `builtin:anomaly-detection.infrastructure-aws` is AWS-only; skip the infrastructure detection sub-scan for Azure accounts
- Davis AI detectors: scan for Azure metric key patterns

### GCP
- Scan Metric Events for: `cloud.gcp.` — pulled from `CLASSIC_PATTERNS.gcp`
- Infrastructure schema equivalent: **none** — skip the infrastructure detection sub-scan for GCP accounts
- Davis AI detectors: scan for GCP metric patterns

### Cross-Provider
The Metric Events and Davis AI scanning logic is provider-agnostic: the same `detectClassicMetricPatterns(text, provider)` call handles all three providers. Provider-specific handling is limited to the infrastructure anomaly detection sub-scan (Task 4).

## Dependencies

- **Story 001** — account detail page route and navigation must exist. Provider and account ID passed as route state.
- **Story 002** — tab frame on `AccountDetail.tsx` and `CLASSIC_PATTERNS` utility in `ui/app/utils/classicPatterns.ts`. The "Alerts" tab label set in Story 002 (previously "Metric Events") is renamed in this story's Task 1.

## Testing Guidance

> **Note**: Testing strategy is an open topic — details will be refined when the QA Testing agent is established.

- Happy path: environment with a custom metric event using `dt.cloud.aws.ec2.*` → row appears under the AWS account scan
- Happy path: environment with customized `builtin:anomaly-detection.infrastructure-aws` settings → row appears with `Infrastructure Detection` badge
- Edge case: all metric events use only new-connection metrics → empty state shown
- Edge case: Davis AI app not installed → schema not found → sub-scan returns no results, no error shown
- Edge case: metric event is disabled (`enabled: false`) → still appears in results with disabled chip (AC: #10)
- Edge case: metric event with malformed `metricSelector` → skipped silently (AC: #8)
- Edge case: `builtin:anomaly-detection.infrastructure-aws` returns no objects (all default) → correctly treated as no migration concern
- Edge case: Azure or GCP account selected → infrastructure detection sub-scan is skipped entirely
- Multi-page pagination: environment with >500 metric events → all pages fetched correctly before results are rendered

## Open Questions

1. **Davis AI detector field names**: Schema ID is confirmed as `builtin:davis.anomaly-detectors`. Remaining unknowns: (a) which `value` field holds the DQL/metric expression to scan, and (b) which field is the display name. Run `dtctl describe settings-schema builtin:davis.anomaly-detectors -o json` on a live environment with detectors present before implementing Task 5.

---
## Architecture Decisions
*Based on architect review, 2026-04-08*

### Hook Return Shape

Define `AlertScanState` in `ui/app/types/alert.ts`. Add a `partialFailures` field (not present in `DashboardScanState`) so `AlertsTab` can render targeted warning text per failed sub-scan:

```typescript
export type AlertScanPhase = 'idle' | 'scanning' | 'done';

export interface AlertScanState {
  results: AlertResult[];
  phase: AlertScanPhase;
  error: string | null;        // non-null only when ALL sub-scans fail
  partialFailures: string[];   // names of failed sub-scans, e.g. ["Davis AI"]
  run: () => void;
}
```

Do not import `ScanPhase` from `dashboard.ts` — define `AlertScanPhase` locally to avoid coupling.

### `settingsObjectsClient` — First Use in Codebase

Import inside `useCallback` (not module scope), same pattern as `documentsClient` in `useDashboardScan.ts`:
```typescript
import { settingsObjectsClient } from '@dynatrace-sdk/client-classic-environment-v2';
```

### Files to Create / Modify

| Action | File | Notes |
|---|---|---|
| Create | `ui/app/types/alert.ts` | `AlertResult`, `AlertType`, `AlertScanPhase`, `AlertScanState` — mirror `dashboard.ts` |
| Create | `ui/app/hooks/useAlertScan.ts` | `Promise.allSettled` over 3 sub-scans; follow `useDashboardScan.ts` pattern |
| Create | `ui/app/components/AlertsTab.tsx` | Phase-based render; no `TokenContext` dependency; `ALERT_COLUMNS` with `useMemo` |
| Modify | `ui/app/pages/AccountDetail.tsx` | Rename tab label → "Alerts"; replace `EmptyState` placeholder with `<AlertsTab>` |



---

## UX Specification (Added by UX Reviewer)

### Review Summary

Five gaps were identified and documented below: (1) the empty state component choice is inconsistent with DashboardsTab; (2) the partial-results scenario (one sub-scan fails, others succeed) has no defined UX; (3) alert type badge color semantics are unspecified; (4) the enabled/disabled chip colors are unspecified; and (5) a Re-scan button is missing from the results state. All are resolved in the specifications below. A corrections table at the end of this section summarises the required changes to Task 6.

---

### User Flow: Alerts Tab (Idle → Scanning → Results)

1. User is on the account detail page and clicks the **"Alerts"** tab (renamed from "Metric Events" by Task 1 of this story).
2. Tab renders in **idle state** — only the "Scan for alerts" button is visible. No auto-scan, no filter toggle (unlike DashboardsTab, no preset filter is needed here).
3. User clicks **"Scan for alerts"**.
4. Tab transitions to **scanning state** — the entire tab content area is replaced by a centered `ProgressCircle` + status paragraph. The button is not shown.
5. Three sub-scans execute in parallel in the background (Custom Metric Events, Infrastructure Detection, Davis AI).
6. On completion, tab transitions to **results state**:
   - All three sub-scans fail → **full error state** (`MessageContainer critical` + Retry button, no table)
   - 1–2 sub-scans fail → **partial warning banner** above the results table (or above `EmptyState` if no matches)
   - All sub-scans succeed, zero matches → **empty state** (`EmptyState` component)
   - All sub-scans succeed, ≥1 match → **results table** with Re-scan button
7. When the user navigates to a different account, the tab resets to idle state and any previous results are cleared (AC #9).

---

### Component Specifications

#### 1. Scan Trigger Button (Idle State)

- **Strato Component**: `Button` from `@dynatrace/strato-components/buttons`
- **Props**: `variant="emphasized"` `color="primary"` `onClick={() => run()}`
- **Label**: `"Scan for alerts"`
- **Container**: `<div>` wrapper inside a `<Flex flexDirection="column" gap={16} padding={16}>`, matching the DashboardsTab idle layout exactly.
- **States**:
  - Default: clickable, full emphasis
  - While scanning: not rendered (replaced by scanning layout — do not keep the button visible in a disabled state)
- **Consistency**: Mirrors `Button variant="emphasized" color="primary"` used for "Scan Dashboards" in `DashboardsTab`. Do **not** substitute `RunQueryButton` here — DashboardsTab uses explicit phase-based state management via the hook, and `AlertsTab` must follow the same pattern.

---

#### 2. Scanning State Layout

- **Strato Components**: `ProgressCircle` + `Paragraph` from `@dynatrace/strato-components/content`
- **Container**: `<Flex flexDirection="column" alignItems="center" padding={32} gap={12}>`
- **ProgressCircle props**: `value="indeterminate"` `aria-label="Scanning alert configurations"`
- **Paragraph text**: `"Scanning alert configurations for classic {provider} references…"` (sentence structure mirrors DashboardsTab: `"Scanning dashboards for classic {provider} references…"`)
- **Replaces**: the entire tab content area while `status === 'scanning'`

---

#### 3. Unified Alert Results Table

- **Strato Component**: `DataTable` from `@dynatrace/strato-components/tables`
  - Import: `import { DataTable, type DataTableColumnDef } from '@dynatrace/strato-components/tables';`
- **Required props**: `data={results}` `columns={ALERT_COLUMNS}` `sortable` `resizable`
  - `sortable`: required per DataTable compliance standard (structured list)
  - `resizable`: required per DataTable compliance standard — **missing from Task 6 description, add it**
- **Column memoization**: `ALERT_COLUMNS` must be defined with `useMemo` (DataTable compliance requirement for performant update cycles)
- **Default sort**: by `name`, ascending
- **DataTable pattern**: structured list (not data-heavy) — no `Toolbar` with `LineWrap`/`ColumnOrderSettings`/`DownloadData` required at this scale

Column definitions in left-to-right order:

| Column id | Header | Width | Render |
|---|---|---|---|
| `name` | `"Alert Name"` | auto (flex) | `DataTable.DefaultCell` with plain text |
| `alertType` | `"Type"` | `180px` | `Chip` badge — see §4 |
| `enabled` | `"Status"` | `110px` | `Chip` — see §5 |
| `classicPatterns` | `"Classic Dependencies"` | auto (flex) | monospace comma-separated string — see §6 |

---

#### 4. Alert Type Badge

- **Strato Component**: `Chip` from `@dynatrace/strato-components/content`
- **All instances**: `size="condensed"`

| `alertType` value | Chip label | `color` | Rationale |
|---|---|---|---|
| `"metric-event"` | `"Metric Event"` | `"primary"` | User-defined threshold alert — most common type, blue implies user-owned |
| `"infrastructure-detection"` | `"Infrastructure Detection"` | `"neutral"` | System-level entity-type binding, no individual metric key; grey avoids implying pre-assessed severity |
| `"davis-ai"` | `"Davis AI"` | `"success"` | DQL-based AI detector; green differentiates it visually from the other two types |

**Color semantics rationale**: These colors differentiate alert *type* only — not migration severity or urgency. All three types are equally concerning at this stage. Using `"warning"` or `"critical"` on any badge would incorrectly imply pre-assessed risk before the readiness scoring story (Story 006) has run.

---

#### 5. Enabled/Disabled Status Chip

- **Strato Component**: `Chip` from `@dynatrace/strato-components/content`
- **All instances**: `size="condensed"`

| `enabled` value | Chip label | `color` |
|---|---|---|
| `true` | `"Enabled"` | `"success"` |
| `false` | `"Disabled"` | `"neutral"` |

**Critical UX rule (AC #10)**: Disabled alerts MUST NOT be visually de-emphasised at the row level. No row dimming, no reduced opacity, no row strikethrough. The `Chip` alone communicates current state. A disabled alert is still a migration concern — it may be re-enabled at any time — and deserves identical row treatment to an enabled one.

---

#### 6. Classic Dependencies Cell

- **Render**: comma-separated string of all patterns in `AlertResult.classicPatterns`
- **Style**: `fontFamily: 'monospace'`, `fontSize: '0.85em'`, `wordBreak: 'break-all'` — identical to the Classic Patterns cell in DashboardsTab
- **Infrastructure Detection rows**: `classicPatterns` will always contain a single descriptive string (e.g., `"Classic AWS entity types"`). No special rendering needed — the same cell renderer handles it correctly.
- **Empty patterns array**: should not occur in spec (an alert only appears if matched), but defensively render `"—"` if the array is empty to avoid a blank cell.

---

#### 7. Results Toolbar (Re-scan)

- **⚠️ Missing from Task 6 — add this**
- **Strato Components**: `Flex` + `Button`
- **Layout**: `<Flex flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8} style={{ marginBottom: 8 }}>`
- **Re-scan button**: `Button variant="default" color="neutral" size="condensed"` labeled `"Re-scan"`
- **When shown**: only in results state (once first scan has completed), above the table or `EmptyState`
- **On click**: calls `run()` again, transitioning back to scanning state
- **Consistency**: matches the `"Re-scan"` `Button variant="default" color="neutral" size="condensed"` in `DashboardsTab`'s results toolbar

---

#### 8. Empty State (No Matches)

- **Strato Component**: `EmptyState` from `@dynatrace/strato-components/content`
  - Import: `import { EmptyState } from '@dynatrace/strato-components/content';`
- **`EmptyState.Title`**: `"No classic alert dependencies found"`
- **`EmptyState.Details`**: `"No alert configurations referencing classic {provider} metrics or entity types were detected."`
- **When shown**: `status === 'done'` and `results.length === 0` (applies whether all sub-scans succeeded or only some — partial warning banner is shown above if applicable)
- **⚠️ Task 6 correction**: Task 6 states *"inline neutral message — no EmptyState component needed"*. This must be corrected. `EmptyState` is the correct component: DashboardsTab uses it for no-results, and an inline `Paragraph` provides insufficient visual prominence for a "clean bill of health" outcome which is meaningful to the user. See Corrections Table below.

---

#### 9. Partial Results Warning Banner

- **Strato Component**: `MessageContainer` from `@dynatrace/strato-components/content`
  - Import: `import { MessageContainer } from '@dynatrace/strato-components/content';`
- **When shown**: `status === 'done'` AND at least one sub-scan failed AND at least one sub-scan produced results (partial). Shown above the results table or above the `EmptyState`.
- **Variant**: `"warning"`
- **`MessageContainer.Title`**: `"Some alert sources could not be scanned"`
- **`MessageContainer.Description`** — per failed source:
  - Metric Events: `"Custom metric events could not be loaded. Results may be incomplete."`
  - Infrastructure Detection: `"Infrastructure anomaly detection settings could not be loaded. Results may be incomplete."`
  - Davis AI: `"Davis AI detectors could not be scanned — the app may not be installed in this environment."`
  - Multiple failures: combine into one description listing all failed sources (do NOT render multiple `MessageContainer` banners — one combined banner per compliance standard)
- **No Retry button** in this state — partial results are still useful. The user can click the Re-scan toolbar button to attempt a full scan again.
- **Architect note**: The `useAlertScan` hook's current return shape `{ results, status, run }` does not expose which sub-scans failed. The hook will need to surface this information (e.g., a `failedSources` field) for `AlertsTab` to render targeted warning text. The exact hook API change is left to the architect.

---

#### 10. Full Error State (All Sub-scans Failed)

- **Strato Components**: `MessageContainer` + `Button`
- **When shown**: `status === 'error'` (all three sub-scans failed, zero results available)
- **Layout**: `<Flex flexDirection="column" gap={12} padding={16}>` — identical to DashboardsTab error state
- **`MessageContainer.variant`**: `"critical"`
- **`MessageContainer.Title`**: `"Scan failed"`
- **`MessageContainer.Description`**: `"Alert configurations could not be loaded. Verify that the settings:objects:read scope is granted, then retry."`
- **Retry button**: `Button variant="default" color="neutral" size="condensed"` labeled `"Retry"` — calls `run()` again, consistent with DashboardsTab retry button

---

### Information Hierarchy (Results State)

Visual priority order, top to bottom:

1. **Partial warning banner** (if any sub-scan failed) — must appear before the table so the user understands the data is incomplete
2. **Re-scan toolbar button** — positioned above the table, right-aligned
3. **DataTable** — primary content area
   - Column left-to-right: Alert Name → Type → Status → Classic Dependencies
   - Name is widest (auto) — primary identifier
   - Type badge (180px) — identifies the alert system
   - Status chip (110px, narrow) — enabled vs. disabled at a glance
   - Dependencies (auto) — the specific classic keys; de-prioritised to the right but accessible

---

### Empty States

| Scenario | Component | Title | Details |
|---|---|---|---|
| No alert configurations matched | `EmptyState` | "No classic alert dependencies found" | "No alert configurations referencing classic {provider} metrics or entity types were detected." |
| Davis AI app not installed (sub-scan skipped gracefully) | No warning — treat as no results for that source (AC #8). Only show warning if the API returned an error, not if the schema was simply absent. | — | — |
| All returned alerts have `enabled: false` | Same `DataTable` — disabled rows still show. No special state. | — | — |

---

### Error Handling

| Scenario | UI Treatment | User-visible message |
|---|---|---|
| All three sub-scans fail | `MessageContainer variant="critical"` + Retry button | "Alert configurations could not be loaded. Verify that the settings:objects:read scope is granted, then retry." |
| 1–2 sub-scans fail (partial) | `MessageContainer variant="warning"` above table/empty state | "Some alert sources could not be scanned. Results below may be incomplete." |
| Single settings object unreadable / malformed | Skipped silently, scan continues (AC #8) | No UI message |
| Schema ID not found (GCP infra, Davis AI not installed) | Treated as no results for that sub-scan — no warning, no error shown | No UI message |
| `settings:objects:read` scope missing (403 on all calls) | Full error state | MessageContainer critical per §10 |



---

## Out of Scope

- SLO scanning (Story 005)
- Readiness scoring / Blocker vs. Warning classification (Story 006)
- Alerting integrations / notification channels (these are not metric dependencies; removing a classic connection does not break notification routing)
- Problem detection rules outside the three scanned schemas (e.g., custom Davis events from Workflows)
- Dynatrace-managed / predefined anomaly detection rules that a customer has not customized (these will be updated by Dynatrace when the new connection matures)
- Dashboard scanning (Story 002)
- Account overview tab (Story 003)

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-04-08 | 1.0 | Initial draft | Story Writer |
| 2026-04-08 | 1.1 | Resolve OQ#4 (infra schema scope = environment); fix Davis AI schema ID; remove resolved OQs; simplify architecture section | Story Writer |
