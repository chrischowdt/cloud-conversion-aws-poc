# User Story: Scan SLOs for Classic Cloud Dependencies

**Status**: Draft
**Category**: Discovery
**Migration Phase**: Prepare

## Story Statement

**As a** Dynatrace Administrator,
**I want** to see all Service Level Objectives — both Classic SLOs and new DQL-based SLOs — that reference classic cloud metrics or classic entity types for a selected cloud provider,
**so that** I know which SLOs will report incorrect values or stop evaluating when a classic connection is removed.

## Context

SLOs are among the highest-stakes dependencies of a classic cloud connection. Unlike a broken dashboard tile (visible immediately), a misconfigured SLO silently produces incorrect values — it continues to report, but the numbers are wrong. Specifically: when a classic metric expression references a metric key that stops receiving data after migration, the SLO evaluator may compute 0% attainment (treating no data as total failure) or produce indeterminate results. Customers may not notice until an incident review or compliance audit.

Dynatrace now provides two distinct SLO systems:

| Type | Format | API Surface | Classic Risk |
|---|---|---|---|
| **Service Level Objectives Classic** (`SLOs Classic`) | Metric selector + entity selector expressions | `GET /api/v2/slo` — `SloSecondGenClient` | Metric selector uses classic metric key prefixes. Entity selector uses classic entity type names (e.g., `type(EC2_INSTANCE)`) |
| **Service Level Objectives** (`SLOs` / new) | Single DQL query | Settings 2.0 API — `builtin:monitoring.slos` schema (open question) or SLO Service Public API | DQL query may contain `fetch dt.entity.<classicType>`, classic metric key prefixes, or direct classic entity ID references |

This story implements the third and final slice of Capability #2 (Dependency Analysis) from the vision document, as a **SLOs** tab on the **Readiness Scan page** (`/readiness`) introduced by Story 006. Story 006 established that all environment-wide scans (dashboards, alerts, SLOs) are hosted on the Readiness Scan page, not on the per-account `AccountDetail` page — because scan results are provider-scoped, not account-scoped. The SLOs tab placeholder that was originally noted for `AccountDetail.tsx` is removed by Story 006; this story targets `Readiness.tsx` directly.
`[Source: .github/prompts/vision.prompt.md#Capabilities]` `[Source: .github/stories/006-environment-readiness-scan-page.md#AC #9, #10]`

This story also retroactively raises a gap from Story 004: the entity selector fields in Classic SLOs are the first place in the app where a **classic entity selector** (not a DQL expression) must be scanned. A new detection utility `detectClassicEntitySelectorPatterns` is required. Story 004 (Alerts) did not need entity selector scanning — metric event alert schemas use metric selectors only — so the alert hook does not need to be touched. However, the new utility should be added to `classicPatterns.ts` for future reuse.

## Acceptance Criteria

### Data Fetch

1. **Given** a user navigates to the Readiness Scan page (`/readiness`) and selects a cloud provider, **when** they switch to the SLOs tab, **then** the tab renders in an idle state with a single "Scan SLOs" button — consistent with the scan-on-demand pattern from Stories 002 and 004.

2. **Given** the scan is triggered, **when** the scan runs, **then** both sub-scans execute in parallel: Sub-scan A (Classic SLOs via `GET /api/v2/slo`) and Sub-scan B (new DQL-based SLOs via the new SLO API surface). Each sub-scan paginates independently until all pages are exhausted.

3. **Given** the Classic SLO list API returns paginated results, **when** scanning, **then** all pages are fetched using the appropriate pagination parameter before the sub-scan completes.

4. **Given** an environment has zero SLOs of either type, **when** the scan completes, **then** the tab shows a neutral empty state: "No SLOs found in this environment."

5. **Given** the scan completes with SLOs present but none with classic dependencies, **when** results are displayed, **then** a separate empty state is shown: "No classic SLO dependencies detected for this provider."

### Classic SLO Detection (Sub-scan A)

6. **Given** a Classic SLO's `metricExpression` field is non-empty, **when** scanned, **then** it is analysed using `detectClassicMetricPatterns(metricExpression, provider)` from `classicPatterns.ts`. If one or more classic patterns are detected, the SLO is included in results.

7. **Given** a Classic SLO's `filter` (entity selector) field is non-empty, **when** scanned, **then** it is analysed using the new `detectClassicEntitySelectorPatterns(filter, provider)` utility. If one or more classic entity type references are detected (e.g., `type(EC2_INSTANCE)`, `type(AWS_LAMBDA_FUNCTION)`), the SLO is included in results. This detection is independent of metric expression detection — an SLO with only a classic entity selector and no classic metric key still appears in results.

8. **Given** a Classic SLO matches on either `metricExpression` or `filter`, **when** displayed in the results table, **then** the detected classic references from both fields are combined and de-duplicated into a single `classicPatterns` list.

9. **Given** the Classic SLO API requires an API token with `slo.read` scope, **when** the user has not provided a token, **then** Sub-scan A is skipped and a `partialFailures` entry "Classic SLOs (token required)" is surfaced. Sub-scan B continues unaffected.

### New SLO Detection (Sub-scan B)

10. **Given** a new DQL-based SLO's query string is non-empty, **when** scanned, **then** it is analysed using both `detectClassicMetricPatterns(query, provider)` and `detectClassicEntityPatterns(query, provider)` from `classicPatterns.ts` (the DQL entity pattern detector already exists from Story 002). If either function returns matches, the SLO is included in results.

11. **Given** the new SLO API surface requires confirming the correct SDK client and scope (see Open Questions #1 and #2), **when** implemented, **then** pagination is handled identically to Sub-scan A — all pages fetched before reporting results.

### Display

12. **Given** an SLO appears in the results, **when** rendered in the table, **then** the following columns are shown:
    - **Name** — the SLO's display name
    - **Type** — chip: `Classic` or `New`
    - **Status** — the current evaluation status (`SUCCESS` / `WARNING` / `FAILURE` / `DEGRADED` / `DISABLED`) as a colour-coded chip (success=green, warning=yellow, failure=red, degraded=orange, disabled=neutral)
    - **Enabled** — chip: `Enabled` / `Disabled`
    - **Evaluation Type** — chip: `Aggregate` / `Window` / `Cumulative` (Classic only — omit or show `DQL` for new SLOs)
    - **Target %** — the numeric target threshold (e.g., `99.5%`)
    - **Classic Dependencies** — monospace list of detected classic pattern strings from `classicPatterns`

13. **Given** a Classic SLO has `enabled: false`, **when** it appears in results, **then** it is still shown (disabled SLOs may be re-enabled) and the Enabled column clearly indicates `Disabled`.

14. **Given** the Status column is shown, **when** a Classic SLO has `FAILURE` or `DEGRADED` status at scan time, **then** the row is visually prioritised (the Status chip uses the `critical` or `warning` colour token) so the user can identify already-broken SLOs first.

### Error Handling

15. **Given** both sub-scans fail (network error, permission error), **when** presenting results, **then** a full error state is shown with a `MessageContainer variant="critical"` and a Retry button. The scan phase returns to `done` with an `error` string.

16. **Given** exactly one sub-scan fails and one succeeds, **when** presenting results, **then** the successful sub-scan's results are shown in the table, and a `MessageContainer variant="warning"` above the table lists the failed sub-scan by name (e.g., "Classic SLO scan failed — results may be incomplete").

17. **Given** an individual SLO record cannot be parsed (malformed value, missing expected field), **when** encountered, **then** it is skipped silently without blocking the rest of the scan.

### State Management

18. **Given** the user changes the cloud provider selector on the Readiness Scan page, **when** the provider changes, **then** any previously loaded SLO scan results are cleared and the SLOs tab returns to its idle (pre-scan) state. (This reset is driven by the page-level provider selector established in Story 006 AC #10 — not by account navigation.)

19. **Given** a re-scan is triggered after results are already shown, **when** the scan runs, **then** previous results are cleared and the loading state is shown (no stale data visible during re-scan).

### Token Dependency

20. **Given** the API token input is rendered at the top of the Readiness Scan page (established in Story 006), **when** the user views the SLOs tab without a token, **then** a contextual note inside the SLOs tab explains that classic SLOs require a token with `slo.read` scope — mirroring the warning pattern used in the Dashboards tab.

---
## ARCHITECTURAL ANALYSIS
*Generated by architect agent on 2026-04-09*

### Open Question Resolutions

**Open Question #3 RESOLVED — Classic SLO SDK client exists.**
`serviceLevelObjectivesClient` is a typed named export from `@dynatrace-sdk/client-classic-environment-v2` (same package that exports `settingsObjectsClient`). Do NOT use `httpClient` for Sub-scan A.

```ts
import { serviceLevelObjectivesClient } from '@dynatrace-sdk/client-classic-environment-v2';
const page = await serviceLevelObjectivesClient.getSlo({ enabledSlos: 'all', pageSize: 1000 });
```

Pagination uses `nextPageKey`: pass `{ nextPageKey }` for subsequent pages (when `nextPageKey` is set, other params must be omitted — confirmed in SDK types).

**Open Question #4 RESOLVED — SCREAMING_SNAKE_CASE transformation is correct.**
`CLASSIC_ENTITY_TYPES` stores lowercase DQL form (`ec2_instance`). Entity selectors use `EC2_INSTANCE`. `detectClassicEntitySelectorPatterns` must call `.toUpperCase()` on each type before building the regex:
```ts
// type(EC2_INSTANCE) pattern matching
new RegExp(`type\\(${entityType.toUpperCase()}\\)`, 'i')
```

**Open Question #5 RESOLVED — GCP `CUSTOM_DEVICE` flag-all approach is correct.**
Follow the DQL precedent in `detectClassicEntityPatterns`: flag all `type(CUSTOM_DEVICE)` when `provider === 'GCP'`. The user understands the GCP context from the provider filter already applied.

**Open Questions #1, #2 remain open (new SLO API surface and scope).**
No dedicated new SLO SDK package is installed (`ls node_modules/@dynatrace-sdk/` confirms this). Sub-scan B must stay as a TODO stub that returns `[]` until dtctl investigation confirms the schema/scope. Task 4 is blocked. All other tasks are unblocked.

---

### API Field Discrepancies (SDK vs. Story)

**`evaluationType`**: The SDK declares `SLO.evaluationType: 'AGGREGATE'` (string literal). The story specifies `AGGREGATE | WINDOW | CUMULATIVE`. The SDK type is incomplete — cast to `string` when extracting, then map to `SloEvaluationType` with a fallback to `'AGGREGATE'`.

**`status`**: SDK declares `SLO.status: 'FAILURE' | 'SUCCESS' | 'WARNING'`. The story adds `DEGRADED | DISABLED | UNKNOWN`. `DISABLED` should be derived from `enabled === false` (not from the `status` field — disabled SLOs may still report a status). `DEGRADED` and `UNKNOWN` are fallback values for the `SloResult` type (used when Sub-scan B returns data with different status strings). When mapping Classic SLO API responses, treat any non-`FAILURE|SUCCESS|WARNING` value as `'UNKNOWN'`.

**`slo.read` scope**: The SDK doc comment says `environment-api:slo:read`. The Dynatrace platform scope name used in `app.config.json` is `slo.read`. These refer to the same permission — use `slo.read` in `app.config.json` (consistent with existing scope naming in the file).

---

### Current Architecture Context

**Relevant existing files:**
- [ui/app/hooks/useAlertScan.ts](ui/app/hooks/useAlertScan.ts) — **Primary reference implementation**. Two-sub-scan `Promise.allSettled` with `partialFailures`, reset-on-provider-change `useEffect`, `run()` via `useCallback`. `useSloScan` should mirror this structure exactly (note: `accountId` is dropped from the reset trigger per Story 006 redirect).
- [ui/app/components/AlertsTab.tsx](ui/app/components/AlertsTab.tsx) — **Primary UI reference**. Idle / scanning / error / results states. Partial failure banner. Re-scan toolbar. `DataTable` with memoized columns. `SlosTab` should follow this layout.
- [ui/app/utils/classicPatterns.ts](ui/app/utils/classicPatterns.ts) — Contains `detectClassicMetricPatterns`, `detectClassicEntityPatterns`, `CLASSIC_ENTITY_TYPES`, `CLASSIC_METRIC_PREFIXES`. New `detectClassicEntitySelectorPatterns` goes here.
- [ui/app/utils/classicPatterns.test.ts](ui/app/utils/classicPatterns.test.ts) — Unit tests for classicPatterns utilities. New tests for `detectClassicEntitySelectorPatterns` go here.
- [ui/app/types/alert.ts](ui/app/types/alert.ts) — **Type template**. `SloResult` and `SloScanState` follow the same shape as `AlertResult` and `AlertScanState`.
- [ui/app/pages/AccountDetail.tsx](ui/app/pages/AccountDetail.tsx) — Contains the SLOs tab placeholder `EmptyState` (line ~390) and `TokenBanner`. Two changes needed here.
- [ui/app/hooks/useDashboardScan.ts](ui/app/hooks/useDashboardScan.ts) — Reference for `httpClient` token-based call pattern and `getEnvironmentUrl()`. Also shows how partial failure is raised when token is absent.

**Established patterns from codebase:**
- **Parallel sub-scans**: `Promise.allSettled([scanA(), scanB()])` — `useAlertScan.ts`
- **Account reset**: `useEffect` watching `[accountId, provider]` → resets all state — `useAlertScan.ts`
- **Token-conditional sub-scan**: check `token !== null` inside scan function, return early with named partial failure if absent — `useDashboardScan.ts`
- **Strato imports**: sub-package imports only — `AccountDetail.tsx` and `AlertsTab.tsx`
- **Column memoization**: `useMemo<DataTableColumnDef<T>[]>()` — `AlertsTab.tsx`
- **Monospace classicPatterns cell**: `<span style={{ fontFamily: 'monospace', fontSize: '0.85em', wordBreak: 'break-all' }}>` — `AlertsTab.tsx` and `AccountDetail.tsx` (Dashboard columns)

---

### Files to Create

- **`ui/app/types/slo.ts`** — SLO type definitions
  - Pattern: Follow structure of [ui/app/types/alert.ts](ui/app/types/alert.ts) exactly
  - Exports: `SloType`, `SloStatus`, `SloEvaluationType`, `SloResult`, `SloScanState`
  - Why needed: Separates types from implementation per codebase convention (`types/alert.ts`, `types/dashboard.ts`)

- **`ui/app/hooks/useSloScan.ts`** — SLO scan hook
  - Pattern: Mirror [ui/app/hooks/useAlertScan.ts](ui/app/hooks/useAlertScan.ts) — same `useState`/`useEffect`/`useCallback` structure
  - Props: `{ provider: CloudProvider; token: string | null }` — no `accountId`; reset is driven by provider change
  - Exports: `useSloScan`, `UseSloScanOptions`
  - Sub-scan A: `serviceLevelObjectivesClient.getSlo()` from `@dynatrace-sdk/client-classic-environment-v2`
  - Sub-scan B: stub returning `[]` until Open Questions #1/#2 resolved
  - Why needed: Hooks are always file-isolated by feature (`useAlertScan`, `useDashboardScan`)

- **`ui/app/components/SlosTab.tsx`** — SLOs tab component
  - Pattern: Mirror [ui/app/components/AlertsTab.tsx](ui/app/components/AlertsTab.tsx) with additions from UX spec
  - Additions vs AlertsTab: `defaultSortBy` with `STATUS_SEVERITY` comparator on Status column; `resizable` prop; token warning in idle state; 7-column table vs 4-column
  - Props: `{ provider: CloudProvider; accountId: string }`
  - Why needed: Tab-level components are always isolated per the existing `AlertsTab`/`OverviewTab` pattern

---

### Files to Modify

- **`ui/app/utils/classicPatterns.ts`** — Add `detectClassicEntitySelectorPatterns`
  - Location: After the existing `detectClassicEntityPatterns` function at the bottom of the file
  - Change: Add new exported function with signature `(selector: string, provider: CloudProvider): string[]`
  - Detection logic: For each entity type in `CLASSIC_ENTITY_TYPES[provider]`, build regex `type\(<TYPE_UPPERCASE>\)` (case-insensitive). For GCP, flag all `type(CUSTOM_DEVICE)`. Return de-duplicated array of matched SCREAMING_SNAKE_CASE strings (e.g., `["EC2_INSTANCE"]`).
  - Why: New utility required by Sub-scan A; reusable for future stories

- **`ui/app/utils/classicPatterns.test.ts`** — Add tests for new utility
  - Location: After existing `detectClassicEntityPatterns` test block
  - Tests: AWS happy path (`type(EC2_INSTANCE)` detected), Azure entity selector match, GCP `type(CUSTOM_DEVICE)` match, empty string no crash, case-insensitive match (`type(ec2_instance)` still detected)

- **`ui/app/pages/Readiness.tsx`** — Add SLOs tab (this file is created by Story 006)
  - Import `SlosTab` and add as the third tab alongside Dashboards and Alerts
  - Pass `provider` from the page-level provider selector state
  - Note: Story 006 must be implemented first (or in the same sprint) before this task can be completed

- **`app.config.json`** — Add `slo.read` scope
  - Location: After the `document:documents:admin` scope entry
  - Change: `{ "name": "slo.read", "comment": "Classic SLO list via GET /api/v2/slo — required for Sub-scan A in Story 005" }`
  - Why: `serviceLevelObjectivesClient.getSlo()` requires this scope; currently absent

---

### Files NOT to Touch

- `ui/app/hooks/useAlertScan.ts` — Story explicitly excludes retroactive changes; alert schemas don't use entity selectors
- `ui/app/components/AlertsTab.tsx` — No changes needed; SLOs tab is a separate component
- `ui/app/hooks/useDashboardScan.ts` — No shared logic changes needed; pattern is referenced but not modified
- `ui/app/pages/AccountDetail.tsx` — The SLOs placeholder removal is handled by Story 006; this story does not touch AccountDetail
- `ui/app/App.tsx` — No new route needed; the `/readiness` route is added by Story 006
- `ui/app/components/Header.tsx` — No nav item needed; "Readiness Scan" nav entry is added by Story 006

---

### Similar Implementations Reference

- **File:** [ui/app/hooks/useAlertScan.ts](ui/app/hooks/useAlertScan.ts)
  - **Pattern:** `Promise.allSettled` with 3 sub-scans, `partialFailures` array, reset on `[accountId, provider]` change
  - **Key learning:** reset `useEffect` clears ALL state fields; `run()` also clears at start for re-scan (AC #19)

- **File:** [ui/app/components/AlertsTab.tsx](ui/app/components/AlertsTab.tsx)
  - **Pattern:** State machine (idle → scanning → done), partial failure banner before table, `useMemo` columns
  - **Key learning:** `partialWarningMessage` is built inline as a string — not a JSX list

- **File:** [ui/app/hooks/useDashboardScan.ts](ui/app/hooks/useDashboardScan.ts)
  - **Pattern:** `token !== null` guard that surfaces a named `partialFailures` entry instead of throwing
  - **Key learning:** The partial failure name must exactly match what the component uses in its message map (e.g., `"Classic SLOs (token required)"`)

---

### Architectural Validation

✅ **Typed SDK client available**: `serviceLevelObjectivesClient` from `@dynatrace-sdk/client-classic-environment-v2` — no `httpClient` needed for Sub-scan A
✅ **Strato imports**: All verified against pattern in `AlertsTab.tsx` and `AccountDetail.tsx`. Components needed: `Button`, `Chip`, `EmptyState`, `MessageContainer`, `ProgressCircle` from `content`; `DataTable` from `tables`; `Flex` from `layouts`; `Paragraph` from `typography`
✅ **`useMemo` columns**: Required by `DataTable` — `AlertsTab` pattern must be followed
✅ **`Promise.allSettled`**: Established pattern — must not use `Promise.all`
⚠️ **Sub-scan B is a stub**: Tasks 3 and 4 are partially blocked by Open Questions #1/#2. Implement Sub-scan B as `async function scanNewDqlSlos(...): Promise<SloResult[]> { return []; }` with a `// TODO: resolve Open Questions #1/#2` comment. This keeps the hook architecture correct without blocking delivery of Sub-scan A.
⚠️ **SDK type narrowness**: `SLO.evaluationType` is typed as `'AGGREGATE'` only. Cast raw value as `string` and map to `SloEvaluationType` with: `(['AGGREGATE','WINDOW','CUMULATIVE'].includes(rawType) ? rawType : 'AGGREGATE') as SloEvaluationType`. Similarly for `status`.
💡 **`defaultSortBy` requires custom `sortType`**: The UX spec specifies `defaultSortBy: [{ id: 'status', desc: true }]` with a `STATUS_SEVERITY` map. Without a custom `sortType` on the status column, DataTable falls back to alphabetical sort. Define `STATUS_SEVERITY` as a `const` above the column definitions.

---

### Scope Changes

- Add `{ "name": "slo.read", "comment": "Classic SLO list via GET /api/v2/slo — required for Sub-scan A in Story 005" }` to `app.config.json`
- `settings:objects:read` already present — may be sufficient for Sub-scan B (pending Open Question #2)

---

### Implementation Order

1. **`app.config.json`** — Add `slo.read` scope first (environment re-deploy may be needed before testing)
2. **`ui/app/utils/classicPatterns.ts`** — Add `detectClassicEntitySelectorPatterns`; run existing tests to confirm no regressions
3. **`ui/app/utils/classicPatterns.test.ts`** — Add tests for new utility; run jest to confirm green
4. **`ui/app/types/slo.ts`** — Define all types; no tests needed (pure types)
5. **`ui/app/hooks/useSloScan.ts`** — Implement hook; Sub-scan A fully implemented, Sub-scan B stubbed as `[]`
6. **`ui/app/components/SlosTab.tsx`** — Implement UI; reference `AlertsTab.tsx` for state machine
7. **`ui/app/pages/AccountDetail.tsx`** — Wire `SlosTab` into tab panel; update `TokenBanner` description
8. **Resolve Open Questions #1/#2** via `dtctl describe settings-schema builtin:monitoring.slos -o json` and a live test — then implement Sub-scan B in `useSloScan.ts`

---

### Testing Strategy

- [ ] `detectClassicEntitySelectorPatterns`: AWS `type(EC2_INSTANCE)` → `["EC2_INSTANCE"]`
- [ ] `detectClassicEntitySelectorPatterns`: AWS `type(ec2_instance)` (lowercase) → `["EC2_INSTANCE"]` (case-insensitive)
- [ ] `detectClassicEntitySelectorPatterns`: AWS `type(AWS_LAMBDA_FUNCTION),tag("prod")` → `["AWS_LAMBDA_FUNCTION"]`
- [ ] `detectClassicEntitySelectorPatterns`: Azure `type(AZURE_VM)` → `["AZURE_VM"]`
- [ ] `detectClassicEntitySelectorPatterns`: GCP `type(CUSTOM_DEVICE)` → `["CUSTOM_DEVICE"]`
- [ ] `detectClassicEntitySelectorPatterns`: empty string → `[]` (no crash)
- [ ] `detectClassicEntitySelectorPatterns`: `type(SERVICE),type(APPLICATION)` with AWS provider → `[]` (no false positives)
- [ ] `useSloScan`: Sub-scan A skipped when `token === null`, partial failure `"Classic SLOs (token required)"` surfaced
- [ ] `useSloScan`: state resets when `provider` changes
- [ ] `useSloScan`: `run()` clears previous results before re-scanning

### Risks & Mitigations

- ⚠️ **Risk**: Sub-scan B unresolved Open Questions delay full story completion
  - **Mitigation**: Stub Sub-scan B as `return []` — story is shippable without it; new SLO DQL scanning can be added in a follow-up once dtctl confirms schema/scope
- ⚠️ **Risk**: `SLO.evaluationType` SDK type is `'AGGREGATE'` only — may throw TypeScript errors if cast carelessly
  - **Mitigation**: Declare `const rawEval = (slo as Record<string, unknown>).evaluationType ?? 'AGGREGATE'` to bypass the SDK's narrow type; map through the `SloEvaluationType` union
- ⚠️ **Risk**: `slo.read` scope requires re-deploy before manual testing is possible
  - **Mitigation**: Complete all implementation tasks first, then deploy; run unit tests (which don't need the scope) throughout development
- ⚠️ **Risk**: Classic SLO `filter` field is `string` (may be empty string `""`) — regex on empty string is safe but no detection
  - **Mitigation**: Gate with `if (slo.filter)` before calling `detectClassicEntitySelectorPatterns`; empty string produces no matches anyway

---

## Tasks / Subtasks

- [ ] Task 1: Add `detectClassicEntitySelectorPatterns` utility to `classicPatterns.ts` (AC: #7)
  - [ ] Define the function signature: `detectClassicEntitySelectorPatterns(selector: string, provider: CloudProvider): string[]`
  - [ ] The entity selector format uses Dynatrace entity selector syntax: `type(ENTITY_TYPE)`, `entityId(ENTITY_ID-*)`. Parse for classic entity type names from `CLASSIC_ENTITY_TYPES[provider]` — e.g., `type(EC2_INSTANCE)`, `type(AWS_LAMBDA_FUNCTION)`.
  - [ ] Return de-duplicated list of matched entity type strings (e.g., `["EC2_INSTANCE", "AWS_LAMBDA_FUNCTION"]`)
  - [ ] Add unit tests in `classicPatterns.test.ts` alongside existing tests

- [ ] Task 2: Define `SloResult` type and `SloScanState` interface in `ui/app/types/slo.ts` (AC: #12)
  - [ ] `SloType`: `'classic' | 'new'`
  - [ ] `SloStatus`: `'SUCCESS' | 'WARNING' | 'FAILURE' | 'DEGRADED' | 'DISABLED' | 'UNKNOWN'`
  - [ ] `SloEvaluationType`: `'AGGREGATE' | 'WINDOW' | 'CUMULATIVE' | 'DQL'`
  - [ ] `SloResult`: `{ id: string; name: string; sloType: SloType; status: SloStatus; enabled: boolean; evaluationType: SloEvaluationType; target: number | null; classicPatterns: string[] }`
  - [ ] `SloScanState`: `{ results: SloResult[]; phase: 'idle' | 'scanning' | 'done'; error: string | null; partialFailures: string[]; run: () => void }`

- [ ] Task 3: Implement sub-scan A — Classic SLOs (AC: #3, #6, #7, #8, #9)
  - [ ] Verify the correct SDK client for `GET /api/v2/slo` — check `@dynatrace-sdk/client-classic-environment-v2` for `slosClient` or equivalent. If not present, use `httpClient` with path `/api/v2/slo?enabledSlos=ALL&pageSize=1000` (see Open Question #3)
  - [ ] Paginate using `nextPageKey` until exhausted
  - [ ] For each SLO: extract `metricExpression`, `filter` (entity selector), `name`, `id`, `enabled`, `status`, `target`, `evaluationType`
  - [ ] Run `detectClassicMetricPatterns(metricExpression, provider)` on the metric expression string
  - [ ] Run `detectClassicEntitySelectorPatterns(filter, provider)` on the filter string
  - [ ] Combine and de-duplicate both pattern lists
  - [ ] Include SLO in results only if combined `classicPatterns.length > 0`
  - [ ] Map `evaluationType` API value to `SloEvaluationType`
  - [ ] If no API token is available, skip and return a named partial failure "Classic SLOs (token required)" rather than throwing (AC: #9)

- [ ] Task 4: Implement sub-scan B — New DQL-based SLOs (AC: #10, #11)
  - [ ] Verify the correct API surface for new SLOs — check `builtin:monitoring.slos` schema via `settingsObjectsClient`, or use the SLO Service Public API (see Open Question #1 and #2)
  - [ ] Paginate until all pages fetched
  - [ ] For each SLO: extract the DQL query string, `name`, `id`, `enabled`, `status`, `target`
  - [ ] Run `detectClassicMetricPatterns(query, provider)` on the DQL string
  - [ ] Run `detectClassicEntityPatterns(query, provider)` on the DQL string (DQL entity detection from Story 002 already handles `fetch dt.entity.<type>`)
  - [ ] Include SLO in results only if combined `classicPatterns.length > 0`
  - [ ] Set `sloType: 'new'`, `evaluationType: 'DQL'`

- [ ] Task 5: Wire sub-scans into `useSloScan` hook at `ui/app/hooks/useSloScan.ts` (AC: #2, #15, #16, #18, #19)
  - [ ] Props: `{ provider: CloudProvider; token: string | null }` — no `accountId`; the provider selector on the Readiness page drives resets
  - [ ] `run()` triggers both sub-scans with `Promise.allSettled` — same pattern as `useAlertScan`
  - [ ] Accumulate results from both sub-scans; collect `partialFailures` names for any rejected outcomes
  - [ ] Set `error` only if both sub-scans fail
  - [ ] Reset state (`results`, `phase`, `error`, `partialFailures`) when `provider` changes (AC: #18) — `useEffect` dependency is `[provider]` only
  - [ ] Clear previous results immediately at the start of a new `run()` call (AC: #19)

- [ ] Task 6: Build `SlosTab` component at `ui/app/components/SlosTab.tsx` (AC: #1, #4, #5, #12–#20)
  - [ ] Props: `{ provider: CloudProvider }` — no `accountId`; provider comes from the Readiness page's provider selector
  - [ ] Host page: `ui/app/pages/Readiness.tsx` (introduced by Story 006)
  - [ ] Consume `useToken()` from `TokenContext` — pass token to hook (needed for Sub-scan A)
  - [ ] **Idle state**: render "Scan SLOs" button + contextual note about `slo.read` token requirement if no token provided (AC: #20)
  - [ ] **Scanning state**: `ProgressCircle` with label "Scanning SLOs for classic {provider} references…"
  - [ ] **Zero SLOs state** (scan complete, `results.length === 0`, no partial failures): `EmptyState` with title "No SLOs found in this environment."
  - [ ] **No classic dependencies state** (`results.length === 0` after filtering, but SLOs exist — alternatively, hook only returns matched SLOs so empty = no matches): `EmptyState` title "No classic SLO dependencies detected for this provider."
  - [ ] **Partial failure banner**: `MessageContainer variant="warning"` above table listing `partialFailures` (AC: #16)
  - [ ] **Full error state**: `MessageContainer variant="critical"` + Retry button (AC: #15)
  - [ ] **Results table**: `DataTable` — columns: Name, Type (chip), Status (chip), Enabled (chip), Evaluation Type (chip), Target %, Classic Dependencies (monospace)
  - [ ] Status chip colours: `SUCCESS` → `success`, `WARNING` → `warning`, `FAILURE` / `DEGRADED` → `critical`, `DISABLED` → `neutral`, `UNKNOWN` → `neutral`
  - [ ] **Re-scan button**: shown in toolbar above table (AC: #19)
  - [ ] `DataTable` props: `sortable resizable`

- [ ] Task 7: Register `SlosTab` in `Readiness.tsx` (AC: #1)
  - [ ] Import `SlosTab` and add it as the third tab in `ui/app/pages/Readiness.tsx` (after Dashboards and Alerts tabs)
  - [ ] Pass `provider` from the Readiness page's provider selector state
  - [ ] The SLOs tab placeholder (`EmptyState` "SLO scan coming soon") that previously existed in `AccountDetail.tsx` is removed by Story 006 — no change needed in `AccountDetail.tsx` for this task

## Dev Notes

### Relevant Context
- The SLOs tab placeholder already exists in `AccountDetail.tsx` with an `EmptyState` labelled "SLO scan coming soon". Task 7 replaces this placeholder. `[Source: ui/app/pages/AccountDetail.tsx#SLOs tab]`
- `detectClassicMetricPatterns` and `detectClassicEntityPatterns` from `ui/app/utils/classicPatterns.ts` are the authoritative detection utilities for new SLO DQL scanning. Do not duplicate logic. `[Source: ui/app/utils/classicPatterns.ts]`
- `useAlertScan` in `ui/app/hooks/useAlertScan.ts` is the closest reference implementation: two-sub-scan parallel execution with `Promise.allSettled`, `partialFailures` accumulation, and reset-on-provider-change. `useSloScan` should follow the same pattern. `[Source: ui/app/hooks/useAlertScan.ts]`
- The `AlertsTab` component (`ui/app/components/AlertsTab.tsx`) is the closest reference for the tab component structure: idle/scanning/error/results states, partial failure banner, re-scan button, `DataTable` columns. `[Source: ui/app/components/AlertsTab.tsx]`
- `TokenContext` and `useToken()` are established in `ui/app/context/TokenContext.tsx`. The `useDashboardScan` hook in Story 002 shows how to conditionally skip a sub-scan and surface a partial failure when the token is absent. `[Source: ui/app/hooks/useDashboardScan.ts]`

### Platform Capabilities

#### Classic SLO API (`GET /api/v2/slo`)
- This is the Environment API v2 SLO endpoint. It lists Classic SLOs — those defined using metric selectors and entity selectors.
- **Required scope**: `slo.read` — this scope is **not currently in `app.config.json`**. It must be added as part of this story.
- Key response fields per SLO object (verify exact field names against SDK `.d.ts` or live API):
  - `id` — SLO identifier
  - `name` — display name
  - `enabled` — boolean
  - `status` — `SUCCESS | WARNING | FAILURE | DEGRADED` (may be absent if never evaluated)
  - `target` — numeric threshold (e.g., `99.5`)
  - `evaluationType` — `AGGREGATE | WINDOW | CUMULATIVE`
  - `metricExpression` — the metric selector expression string (e.g., `(100)*(builtin:cloud.aws.ec2.cpu:filter(...))`). This is the primary field to scan.
  - `filter` — entity selector string (e.g., `type(EC2_INSTANCE),tag("production")`). This is the secondary field to scan for classic entity type references.
- Pagination: use `nextPageKey` query parameter. Pass `enabledSlos=ALL` to include both enabled and disabled SLOs.
- `[Source: https://docs.dynatrace.com/docs/dynatrace-api/environment-api/service-level-objectives]`
- The correct SDK client is expected to be in `@dynatrace-sdk/client-classic-environment-v2` — check for `slosClient` or `getSlos`. If absent, use `httpClient` with the path directly (same pattern as classic dashboards in Story 002). `[Source: ui/app/hooks/useDashboardScan.ts — httpClient usage]`

#### New DQL SLO API
- New SLOs are defined with a single DQL query as the SLI. The API surface differs from the classic `/api/v2/slo` endpoint.
- **Open Question #1**: Confirm whether new SLOs are accessible via `settingsObjectsClient.getSettingsObjects({ schemaIds: 'builtin:monitoring.slos' })` or via a separate SLO Service Public API endpoint (`GET /slos`). Run `dtctl describe settings-schema builtin:monitoring.slos -o json` to verify.
- **Open Question #2**: Confirm the required OAuth scope for new SLOs. Expected: `slo.read` (same as classic) or `settings:objects:read` (already present). Verify before implementing.
- Key fields expected per new SLO:
  - DQL query string (field name TBD — verify in schema or API response)
  - `name`, `id`, `enabled`, `status`, `target`
- `[Source: https://docs.dynatrace.com/docs/deliver/service-level-objectives-classic/service-level-objective-upgrade-classic]`

#### Entity Selector Detection (new utility)
- Classic entity selectors use the syntax: `type(ENTITY_TYPE)`, `entityId(ENTITY_TYPE-HEXID)`, `tag("tag")`, etc.
- Detection target: the `type(...)` function containing a classic entity type name. For AWS: `type(EC2_INSTANCE)`, `type(AWS_LAMBDA_FUNCTION)`, etc. For Azure: `type(AZURE_VM)`, etc. These names come from `CLASSIC_ENTITY_TYPES[provider]` in `classicPatterns.ts`.
- Note: entity selector type names use `SCREAMING_SNAKE_CASE` (e.g., `EC2_INSTANCE`) while the DQL entity type pattern uses dot-notation (e.g., `dt.entity.ec2_instance`). The detection logic must match the entity-selector form, not the DQL form.
- `[Source: https://docs.dynatrace.com/docs/deliver/service-level-objectives-classic/service-level-objective-upgrade-classic#Upgrade-Classic-SLOs-to-SLOs]`

### Data Considerations
- **`metricExpression` vs `filter`**: Both fields must be scanned. A Classic SLO might use a new-style metric key but still target classic entities via `filter`, or vice versa. Either is a migration concern.
- **Evaluation failure mode**: When a classic metric key stops receiving data post-migration, the SLO evaluator computes the SLI as 0% or indeterminate — it does NOT stop reporting. This means SLOs can silently misreport compliance after migration. `[Source: domain knowledge; see also https://docs.dynatrace.com/docs/deliver/service-level-objectives-classic/service-level-objective-upgrade-classic]`
- **Token requirement for Classic SLOs**: The `GET /api/v2/slo` endpoint requires a user-supplied API token with `slo.read` scope. This scope cannot be obtained via OAuth. Sub-scan A must be conditional on token presence, with a user-facing partial failure message when absent.
- **New SLOs scope**: New SLOs do not use metric selectors or entity selectors — they use DQL. The existing `detectClassicEntityPatterns` function (DQL-aware, matching `fetch dt.entity.<type>`) applies directly. No new detection utility is needed for new SLOs.
- **Volume**: environments with many SLOs (hundreds) should be handled by pagination. No special batching is required beyond standard `nextPageKey` loops.

### Technical Constraints
- **Read-only**: no write calls. `[Source: .github/prompts/vision.prompt.md#Constraints]`
- `slo.read` scope must be added to `app.config.json` — it is absent today. `[Source: app.config.json]`
- `settings:objects:read` is already present and may cover the new SLO API (pending Open Question #2). `[Source: app.config.json]`
- The `httpClient` import path is `@dynatrace-sdk/http-client` — used in `useDashboardScan.ts` as a precedent for direct HTTP calls when no typed SDK client exists. `[Source: ui/app/hooks/useDashboardScan.ts]`
- The `TokenContext` pattern is already established — `useToken()` provides `{ token: string | null, setToken }`. The hook receives `token` as a prop. `[Source: ui/app/context/TokenContext.tsx]`
- `Promise.allSettled` for parallel sub-scans is the established pattern. Do not use `Promise.all` (aborts on first failure). `[Source: ui/app/hooks/useAlertScan.ts]`

## Cloud Provider Considerations

### AWS
- Sub-scan A (`metricExpression`): scan for `dt.cloud.aws.`, `cloud.aws.`, `ext:cloud.aws.`, `builtin:cloud.aws.` prefixes via `detectClassicMetricPatterns`
- Sub-scan A (`filter` / entity selector): scan for `type(EC2_INSTANCE)`, `type(AWS_LAMBDA_FUNCTION)`, `type(AUTO_SCALING_GROUP)`, `type(EBS_VOLUME)`, `type(ELASTIC_LOAD_BALANCER)`, etc. via `detectClassicEntitySelectorPatterns`. Note: `CLASSIC_ENTITY_TYPES.AWS` uses lowercase snake_case for DQL; the entity selector form uses SCREAMING_SNAKE_CASE — the utility must handle the case transformation.
- Sub-scan B (new DQL SLOs): scan for same AWS metric key patterns + `fetch dt.entity.ec2_instance`, `fetch dt.entity.aws_lambda_function`, etc.

### Azure
- Sub-scan A: scan for `dt.cloud.azure.`, `cloud.azure.microsoft_`, `ext:cloud.azure.`, `builtin:cloud.azure.` prefixes in metric expression; scan for `type(AZURE_VM)`, `type(AZURE_FUNCTION_APP)`, etc. in entity selector
- Sub-scan B: scan for Azure metric key patterns + DQL entity references

### GCP
- Sub-scan A: scan for `cloud.gcp.`, `builtin:cloud.gcp.` prefixes in metric expression; entity selector scanning for GCP classic entities uses `type(CUSTOM_DEVICE)` (GCP classic entities are modelled as custom devices). Confirm whether `CUSTOM_DEVICE` in an entity selector is sufficient signal given it is not GCP-exclusive — may require heuristic.
- Sub-scan B: scan for GCP metric patterns + `fetch dt.entity.custom_device` in DQL

### Cross-Provider
Sub-scan A detection is provider-specific (metric prefixes + entity types). Sub-scan B detection reuses existing provider-aware utilities with no new cross-provider logic.

## Dependencies

- **Story 002** — `classicPatterns.ts` (including `detectClassicEntityPatterns`), `TokenContext`
- **Story 006** — `Readiness.tsx` host page, provider selector, token input UI, and `/readiness` route must exist before this story's `SlosTab` can be wired up. Stories 005 and 006 may be implemented in the same sprint, but Story 006's `Readiness.tsx` scaffold must be created first.
- No dependency on Story 001, Story 003, or Story 004

## Testing Guidance

> **Note**: Testing strategy is an open topic — details will be refined when the QA Testing agent is established.

- Happy path (Classic SLO, metric expression match): SLO with `metricExpression` containing `dt.cloud.aws.ec2.cpu_usage` → appears under AWS provider scan
- Happy path (Classic SLO, entity selector match only): SLO with `metricExpression` using a new metric key but `filter: type(EC2_INSTANCE)` → still appears in results
- Happy path (new DQL SLO): SLO with DQL containing `fetch dt.entity.ec2_instance` → appears under AWS provider scan
- Edge case: no token provided → Sub-scan A skipped, partial failure banner shows "Classic SLOs (token required)", Sub-scan B results shown normally
- Edge case: SLO with `FAILURE` status → row appears, Status chip renders in `critical` colour
- Edge case: SLO with `enabled: false` → row appears, Enabled chip shows `Disabled`
- Edge case: both sub-scans fail → full error state, no partial results shown
- Edge case: malformed SLO record → silently skipped, rest of results unaffected
- Edge case: `filter` field absent or empty string → entity selector scan skipped gracefully, no crash

## Open Questions

1. **New SLO API surface**: Is the canonical SDK client for new DQL-based SLOs `settingsObjectsClient` with `builtin:monitoring.slos`, or is it the SLO Service Public API (`GET /slos`)? Run `dtctl describe settings-schema builtin:monitoring.slos -o json` to confirm. If the schema does not exist, the SLO Service Public API is the correct surface. **This must be resolved before Task 4 can be implemented.**

2. **New SLO OAuth scope**: Does the new SLO API (Sub-scan B) require `slo.read` (same as classic) or `settings:objects:read` (already present)? Verify against the API docs or by running a test query with `dtctl`. **Do not implement Sub-scan B until scope is confirmed and added to `app.config.json` if needed.**

3. **Classic SLO SDK client**: Does `@dynatrace-sdk/client-classic-environment-v2` export a typed `slosClient` for `GET /api/v2/slo`? If yes, use it for type safety. If no, use `httpClient` with path `/api/v2/slo?enabledSlos=ALL&sloSelector=all&pageSize=1000` and the `Authorization: Api-Token ${token}` header (same pattern as classic dashboards in `useDashboardScan.ts`).

4. **SCREAMING_SNAKE_CASE entity selector mapping**: `CLASSIC_ENTITY_TYPES.AWS` in `classicPatterns.ts` stores entity type names in lowercase DQL form (e.g., `ec2_instance`). The entity selector format uses `EC2_INSTANCE`. The `detectClassicEntitySelectorPatterns` utility must uppercase-transform when building its regex patterns. Confirm this is the correct approach before implementing Task 1.

5. **GCP entity selector disambiguation**: GCP classic entities are `CUSTOM_DEVICE`. `type(CUSTOM_DEVICE)` in a Classic SLO entity selector is not specific to GCP — it could reference any custom device. Should the utility flag all `CUSTOM_DEVICE` mentions when `provider === 'GCP'` (same approach as `detectClassicEntityPatterns` for DQL), or is this too noisy? Recommended: match the existing DQL precedent and flag it, as the user understands the GCP context.

6. **Token banner scope text update**: The existing `TokenBanner` in `AccountDetail.tsx` currently says "ReadConfig scope". It should be updated to also mention `slo.read`. Is there a risk of confusing users who only have ReadConfig but not slo.read? Should the banner be context-aware (showing relevant scopes per active tab), or just list all required scopes upfront?

## Out of Scope

- Modifying or deleting any SLO — app is read-only `[Source: .github/prompts/vision.prompt.md#Constraints]`
- Suggesting SLO replacements or migration paths — that is Capability #3 (Migration Readiness), a future story
- Retroactively patching Story 004 (Alerts) to add entity selector scanning — alert schemas do not use entity selectors; this story introduces entity selector scanning for the first time via `detectClassicEntitySelectorPatterns`
- Filtering SLOs by cloud account — SLO scan is environment-wide, not per-account. Account context determines which provider's patterns are used for detection only.
- Scanning SLO dashboard tiles for classic references — dashboards are covered by Story 002
- Scanning SLO burn rate alert rules for classic references — out of v1 scope `[Source: .github/prompts/vision.prompt.md#Future Scope]`

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-04-08 | 1.0 | Initial draft | Story Writer |

---

## Validation Report

| Category                        | Status | Issues |
| ------------------------------- | ------ | ------ |
| 1. Goal & Context Clarity       | ✅ Ready | None |
| 2. Acceptance Criteria Quality  | ✅ Ready | None |
| 3. Developer Handoff Readiness  | ⚠️ Partial | Open Questions #1–#3 must be resolved before Tasks 3 and 4 can be fully implemented. All other tasks are unblocked. |
| 4. Self-Containment             | ✅ Ready | None |
| 5. Scope Control                | ✅ Ready | None |

**Final Assessment**: READY (with open questions flagged — story is implementable in order; Tasks 1, 2, 5, 6, 7, 8 can proceed immediately; Tasks 3 and 4 require Open Questions #1–#3 resolved first)

---

## UX Specification (Added by UX Reviewer, 9 April 2026)

### Clarifications Applied

The following decisions were made during UX review and supersede or refine specific acceptance criteria:

- **Empty states (AC #4 vs. AC #5 superseded)**: Collapsed into a **single empty state**. The hook returns only matched SLOs; `results.length === 0` after a completed scan always shows "No classic SLO dependencies detected." No `totalScanned` counter is required in the hook. Task 6 bullet points for "Zero SLOs state" and "No classic dependencies state" should be merged into one: `EmptyState` with title `"No classic SLO dependencies detected"`.
- **Status-based row prioritization (AC #14 refined)**: Visual prioritization is implemented via **`defaultSortBy` on the DataTable** (not chip coloring alone). Default sort: Status severity descending — FAILURE at top. Chip coloring is secondary reinforcement.
- **Classic Dependencies column**: Matches `AlertsTab` pattern — inline comma-separated monospace with `wordBreak: 'break-all'`. No truncation.
- **Scan button label**: `"Scan SLOs"` confirmed (consistent with `"Scan Dashboards"` verb-noun pattern).

---

### User Flow

1. User navigates to the account detail page from the Inventory (Story 001)
2. User clicks the **SLOs** tab in the tab bar
3. **Idle state**: "Scan SLOs" button is shown. If no API token is present, a `MessageContainer variant="warning"` above the button explains Classic SLOs require `slo.read` scope — same pattern as `DashboardsTab` idle state in `AccountDetail.tsx`
4. User clicks **Scan SLOs**
5. **Scanning state**: `ProgressCircle` (indeterminate) + descriptive `Paragraph` appear while both sub-scans run in parallel
6. Scan completes — three outcomes:
   - **Results found**: Table renders, default-sorted by Status severity descending. Partial failure banner (if any) appears above the table.
   - **No results**: Single `EmptyState` — "No classic SLO dependencies detected"
   - **Both sub-scans failed**: Full error state with "Scan failed" + Retry button
7. From results state, user clicks **Re-scan** (right-aligned condensed button above the table) to trigger a fresh scan — previous results are cleared immediately

---

### Component Specifications

#### Token Warning (Idle State — no API token)

- **Strato Component**: `MessageContainer` from `@dynatrace/strato-components/content`
- **Key Props**:
  - `variant`: `"warning"`
- **Content**:
  - `MessageContainer.Title`: `Classic SLOs require an API token`
  - `MessageContainer.Description`: `Classic SLOs will be skipped. Enter the API token above to include them. Required scope: slo.read`
- **States**:
  - Rendered when `token === null` in the idle phase
  - Hidden when `token !== null`
- **Notes**: Direct pattern match to the `DashboardsTab` idle-state token warning in `AccountDetail.tsx`. No new component required.

---

#### "Scan SLOs" Button (Idle State)

- **Strato Component**: `Button` from `@dynatrace/strato-components/buttons`
- **Key Props**:
  - `variant`: `"emphasized"`
  - `color`: `"primary"`
  - `onClick`: `() => void run()`
- **Label**: `Scan SLOs`
- **Layout**: Wrapped in a `<div>` beneath the optional token warning, inside `Flex flexDirection="column" gap={16} padding={16}` — matches `AlertsTab` and `DashboardsTab` idle layout

---

#### Scanning State — Progress Indicator

- **Strato Component**: `ProgressCircle` from `@dynatrace/strato-components/content`
- **Key Props**:
  - `value`: `"indeterminate"`
  - `aria-label`: `"Scanning SLOs"`
- **Accompanying text**: `Paragraph` from `@dynatrace/strato-components/typography` — `"Scanning SLOs for classic {provider} references…"`
- **Layout**: `Flex flexDirection="column" alignItems="center" padding={32} gap={12}` — identical to `AlertsTab` scanning state

---

#### Empty State (No Results)

- **Strato Component**: `EmptyState` from `@dynatrace/strato-components/content`
- **Content**:
  - `EmptyState.Title`: `No classic SLO dependencies detected`
  - `EmptyState.Details`: `No SLOs referencing classic {provider} metrics or entity types were detected.`
- **Trigger**: `phase === 'done' && results.length === 0` (no error)
- **Notes**: Single empty state for all no-result cases — covers both "no SLOs exist" and "SLOs exist but none match." Re-scan button in the toolbar above (always rendered in results/done phase) remains visible.

---

#### Full Error State

- **Strato Component**: `MessageContainer` from `@dynatrace/strato-components/content`
- **Key Props**: `variant`: `"critical"`
- **Trigger**: `phase === 'done' && error !== null`
- **Content**:
  - `MessageContainer.Title`: `Scan failed`
  - `MessageContainer.Description`: `{error}`
- **Retry button**: `Button variant="default" color="neutral" size="condensed"`, label `Retry`, `onClick` → `() => void run()`
- **Notes**: Matches `AlertsTab` full error state exactly.

---

#### Partial Failure Banner

- **Strato Component**: `MessageContainer` from `@dynatrace/strato-components/content`
- **Key Props**: `variant`: `"warning"`
- **Trigger**: `partialFailures.length > 0` (in the results/done phase without a full error)
- **Placement**: Above the re-scan toolbar and table
- **Content**:
  - `MessageContainer.Title`: `Some SLO sources could not be scanned`
  - `MessageContainer.Description`: Concatenated human-readable messages per failure name:
    - `"Classic SLOs (token required)"` → `"Classic SLOs could not be scanned — a token with slo.read scope is required. Results show new DQL-based SLOs only."`
    - Any other name → `"{source} could not be scanned. Results may be incomplete."`
- **Notes**: Single `MessageContainer` regardless of partial failure count; join messages with a space. Matches `AlertsTab` pattern.

---

#### Re-scan Toolbar

- **Layout**: `Flex flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}` with `style={{ marginBottom: 8 }}`
- **Re-scan button**: `Button variant="default" color="neutral" size="condensed"`, label `Re-scan`, `onClick` → `() => void run()`
- **Visibility**: Rendered whenever `phase === 'done'` (both when table has rows and when empty state is shown)
- **Notes**: Identical to `AlertsTab` re-scan toolbar layout.

---

#### Results Table

- **Strato Component**: `DataTable` from `@dynatrace/strato-components/tables`
- **Key Props**:
  - `data`: `results` (must be memoized)
  - `columns`: memoized `DataTableColumnDef<SloResult>[]`
  - `sortable`: `true`
  - `resizable`: `true`
  - `defaultSortBy`: `[{ id: 'status', desc: true }]`
- **Important**: The Status column definition **must include a custom `sortType` comparator** to enforce severity ordering. Without it, `defaultSortBy` with `desc: true` sorts alphabetically, not by risk. Severity map for the comparator (higher number = higher severity = sorts to top with `desc: true`):

  ```ts
  const STATUS_SEVERITY: Record<SloStatus, number> = {
    FAILURE:  5,
    DEGRADED: 4,
    WARNING:  3,
    UNKNOWN:  2,
    SUCCESS:  1,
    DISABLED: 0,
  };
  ```

---

### Column Specifications

| # | ID | Header | Width | Notes |
|---|-----|--------|-------|-------|
| 1 | `name` | Name | flex (no fixed width) | Plain `DataTable.DefaultCell` |
| 2 | `sloType` | Type | `100` | `Chip size="condensed"`: `'classic'` → `color="neutral"` label `Classic`; `'new'` → `color="primary"` label `New` |
| 3 | `status` | Status | `120` | `Chip size="condensed"` with severity color (see table below). Requires custom `sortType` comparator using `STATUS_SEVERITY` map above. |
| 4 | `enabled` | Enabled | `110` | `Chip size="condensed"`: `true` → `color="success"` label `Enabled`; `false` → `color="neutral"` label `Disabled` |
| 5 | `evaluationType` | Eval Type | `130` | `Chip size="condensed" color="neutral"`: `AGGREGATE` → `Aggregate`, `WINDOW` → `Window`, `CUMULATIVE` → `Cumulative`, `DQL` → `DQL` |
| 6 | `target` | Target % | `100` | Render `target !== null ? \`${target}%\` : '—'`. Use `columnType: 'number'` for correct right-alignment. |
| 7 | `classicPatterns` | Classic Dependencies | flex | `<span style={{ fontFamily: 'monospace', fontSize: '0.85em', wordBreak: 'break-all' }}>`. Comma-joined list. Matches `AlertsTab` and `DashboardsTab` patterns exactly. |

**Status chip color mapping** (verified against `Chip` props — valid values: `neutral | primary | success | warning | critical`):

| SloStatus | Chip color | Label |
|-----------|-----------|-------|
| `SUCCESS` | `success` | SUCCESS |
| `WARNING` | `warning` | WARNING |
| `FAILURE` | `critical` | FAILURE |
| `DEGRADED` | `critical` | DEGRADED |
| `DISABLED` | `neutral` | DISABLED |
| `UNKNOWN` | `neutral` | UNKNOWN |

> **Note**: `Chip` has no `orange` color token. `DEGRADED` intentionally maps to `critical` (same red as `FAILURE`) because both represent active SLO failures. The label text still distinguishes them.

---

### Information Hierarchy

1. **Partial failure banner** (if present) — user sees incomplete-data warning _before_ interpreting any numbers
2. **Re-scan toolbar** — action affordance always accessible
3. **Status column** (default sort: FAILURE → DEGRADED at top) — broken SLOs are immediately visible without scrolling
4. **Name column** (leftmost, widest) — identifies which specific SLO is at risk
5. **Classic Dependencies column** — shows exactly which metric keys or entity types trigger the match

---

### Empty State Table

| Scenario | Title | Details | User Action |
|----------|-------|---------|-------------|
| `phase === 'done' && results.length === 0` (any cause) | No classic SLO dependencies detected | No SLOs referencing classic `{provider}` metrics or entity types were detected. | Re-scan button still visible |

---

### Error Handling Table

| Error Scenario | Visual Treatment | Recovery |
|---------------|-----------------|---------|
| Both sub-scans fail | `MessageContainer variant="critical"` — "Scan failed" + `{error}` | Retry button → `run()` |
| Classic SLOs skipped (no token) | `MessageContainer variant="warning"` above table — token-specific message | None; new SLO results shown |
| Classic SLOs fail (other error) | `MessageContainer variant="warning"` above table — generic message | None; new SLO results shown |
| New SLOs fail | `MessageContainer variant="warning"` above table — generic message | None; classic SLO results shown |
| Individual SLO record malformed | Silent skip | — |

---

### Migration Journey Context

The SLOs tab is the **final Dependency Analysis scanner** (Dashboards → Alerts → SLOs). After this tab completes, the user has the full blast-radius picture. The natural next step is **Capability #3 — Migration Readiness** (not yet implemented). Until it is, no explicit next-step navigation is provided from this tab.

SLOs are the highest-stakes dependency type because breakage is silent. The default-sort-by-severity design decision directly serves this risk: a user scanning a large environment with hundreds of SLOs should land immediately on the FAILURE rows — the ones that are _already_ broken at scan time and will stay broken post-migration without intervention.
