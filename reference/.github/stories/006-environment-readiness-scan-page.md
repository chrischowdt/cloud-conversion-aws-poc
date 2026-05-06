# User Story: Environment Migration Assessment Page

**Status**: Draft
**Category**: Discovery
**Migration Phase**: Prepare

## Story Statement

**As a** Dynatrace Administrator,
**I want** to access the Dashboard, Alert, and SLO scans from a dedicated environment-level "Migration Assessment" section — not from within a selected cloud account's detail page —
**so that** I can assess the full migration blast radius across all cloud accounts in my environment at once.

## Context

Stories 002 (Dashboards), 004 (Alerts), and 005 (SLOs) placed their scan functionality as tabs on the `AccountDetail` page (`/inventory/:accountId`). This made sense as an initial structure, but post-implementation review revealed a fundamental mismatch: all three scans operate at **provider level**, not at **account level**.

- The dashboard scan (`useDashboardScan`) detects classic metric key prefixes for a given cloud provider across all dashboards in the environment — it has no `accountId` parameter and cannot be scoped to a single account. `[Source: ui/app/hooks/useDashboardScan.ts]`
- The alert scan (`useAlertScan`) nominally accepts `accountId`, but inspection shows that parameter is used **only as a reset key** (a `useEffect` dependency) — none of the three sub-scans (`scanMetricEvents`, `scanInfrastructureDetection`, `scanDavisDetectors`) filter by account ID. `[Source: ui/app/hooks/useAlertScan.ts]`
- The SLO scan (Story 005, not yet implemented) will follow the same pattern: classic metric key detection is provider-scoped, not account-scoped.

Surfacing environment-wide results in an account-scoped context misleads the user into thinking the results are specific to their selected account when they are not.

This story relocates all three scan surfaces to a new top-level `/readiness` page with an explicit provider selector. The underlying scan hooks and detection utilities are **unchanged** — this is a structural/UX-only refactoring. `[Source: .github/prompts/vision.prompt.md#Capabilities]`

**Supersedes**: The placement decisions for scan tabs made in Stories 002, 004, and 005. The scan logic itself (hooks, `classicPatterns.ts`, types) is unaffected.

## Acceptance Criteria

### Migration Assessment Page

1. **Given** the user is anywhere in the app, **when** they click "Migration Assessment" in the top navigation, **then** they are taken to `/readiness` and see a provider selector and three scan tabs: Dashboards, Alerts, SLOs.

2. **Given** the user is on the Migration Assessment page, **when** they select a cloud provider (AWS, Azure, GCP) from the provider selector, **then** all three scan tabs reset to their idle state — any previously cached scan results are cleared.

3. **Given** the user has not yet selected a provider, **when** the page first loads, **then** a neutral prompt is shown (e.g., "Select a cloud provider to begin scanning") — no scan tabs are rendered.

### Dashboards Tab (lifted from Story 002)

4. **Given** a provider is selected and the user is on the Dashboards tab, **then** the tab renders in idle state: a "Scan Dashboards" button and the "Include preset & ready-made dashboards" toggle (default: off). Behaviour is identical to the implementation from Story 002 except the `provider` now comes from the page-level provider selector instead of the selected account.

5. **Given** the Dashboards tab has previously run a scan for provider X, **when** the user changes the provider selector to provider Y, **then** the Dashboards tab resets to idle — previous results are discarded.

6. **Given** the Dashboards tab requires a classic Config API v1 token, **when** no token is entered, **then** a warning banner is shown explaining that classic dashboards will be skipped, identical to the original implementation. The token input field is located at the top of the Migration Assessment page (above the tabs) so it is accessible for any tab that needs it — it is NOT per-tab.

### Alerts Tab (lifted from Story 004)

7. **Given** a provider is selected and the user is on the Alerts tab, **then** the tab renders in idle state with a "Scan for alerts" button. Behaviour is identical to Story 004 except `provider` comes from the page-level selector.

8. **Given** the Alerts tab has previously run a scan for provider X, **when** the user changes the provider selector, **then** the tab resets to idle.

### SLOs Tab (redirected from Story 005)

9. **Given** a provider is selected and the user is on the SLOs tab, **then** the tab renders in idle state with a "Scan SLOs" button — consistent with the scan-on-demand pattern from Stories 002 and 004. Behaviour follows Story 005 acceptance criteria except `provider` comes from the page-level selector.

10. **Given** the SLOs tab has previously run a scan for provider X, **when** the user changes the provider selector, **then** the tab resets to idle.

### Account Detail Page Cleanup

11. **Given** this story is implemented, **when** a user navigates to `/inventory/:accountId`, **then** the page shows **only the Overview tab** (OverviewTab component from Story 003) — the Dashboards, Alerts, and (planned) SLOs tabs are removed entirely. No link or badge pointing to the Migration Assessment page is shown (deferred to a future story).

12. **Given** the AccountDetail page now has a single tab, **when** it renders, **then** the `Tabs` / `Tab` navigation component is removed and `OverviewTab` is rendered directly — there is no single-item tab bar.

---
## ARCHITECTURAL ANALYSIS
*Generated by architect agent on 2026-04-09*

### Current Architecture Context

**Relevant existing files:**
- [ui/app/pages/AccountDetail.tsx](../../ui/app/pages/AccountDetail.tsx) — Contains the inline `DashboardsTab` (~170 lines), inline `TokenBanner`, `DASHBOARD_COLUMNS` constant, and the `Tabs`/`Tab` shell for Overview/Dashboards/Alerts/SLOs/Workflows/Notebooks. This file bears the most structural change.
- [ui/app/components/AlertsTab.tsx](../../ui/app/components/AlertsTab.tsx) — Standalone component, `props: { provider: CloudProvider; accountId: string }`. Calls `useAlertScan({ provider, accountId })`. Moves cleanly.
- [ui/app/hooks/useAlertScan.ts](../../ui/app/hooks/useAlertScan.ts) — `UseAlertScanOptions = { provider: CloudProvider; accountId: string }`. The `accountId` field is **only** a `useEffect` dependency for reset; it is not passed to any sub-scan. Effect dep array: `[accountId, provider]`.
- [ui/app/hooks/useDashboardScan.ts](../../ui/app/hooks/useDashboardScan.ts) — `UseDashboardScanOptions = { provider: CloudProvider; token: string | null }`. No `accountId` field. **No internal reset effect** — results persist until `run()` is called or component unmounts. This is the key difference from `useAlertScan`.
- [ui/app/context/TokenContext.tsx](../../ui/app/context/TokenContext.tsx) — Exports `TokenProvider`, `useToken`. `TokenProvider` already wraps the entire app in `App.tsx`. No prop threading needed anywhere.
- [ui/app/App.tsx](../../ui/app/App.tsx) — Routes: `/inventory` → `Inventory`, `/inventory/:accountId` → `AccountDetail`. Add `/readiness` here.
- [ui/app/components/Header.tsx](../../ui/app/components/Header.tsx) — Minimal; one nav item ("Cloud Accounts"). Add "Migration Assessment" pointing to `/readiness`.

**Established patterns:**
- **Scan-on-demand tab**: `idle → scanning → done` phase pattern, with a "Scan X" button in idle state. Reference: both `DashboardsTab` (inline in AccountDetail) and `AlertsTab`.
- **Hook-driven data fetching**: Scan hooks own all state; components are thin consumers. Reference: `useDashboardScan`, `useAlertScan`.
- **Strato Tabs shell**: `<Tabs defaultIndex={0}>/<Tab title="">` from `@dynatrace/strato-components/navigation`. Reference: `AccountDetail.tsx`.
- **Preview layout entrypoint**: `Page`/`Page.Header`/`Page.Main` from `@dynatrace/strato-components-preview/layouts` — already in `App.tsx`; no page-level layout changes needed.

---

### Architectural Decision: DashboardsTab Extraction

**Decision**: Extract `DashboardsTab` to **`ui/app/components/DashboardsTab.tsx`** (not inline in `Readiness.tsx`).

**Rationale**:
- Consistent with `AlertsTab` which is already a standalone component in `ui/app/components/`.
- Keeps `Readiness.tsx` as a thin orchestrator, not a monolithic file.
- Enables future independent testability.
- `AccountDetail.tsx` cleanup is simpler (delete the inline definition entirely; no cut-paste into sibling file).

**DashboardsTab props after extraction**: `{ provider: CloudProvider; token: string | null }` — `accountId` removed.

---

### Architectural Decision: Provider-Change Reset for DashboardsTab

**Problem**: `useDashboardScan` has **no internal reset `useEffect`** (unlike `useAlertScan`). If provider changes within the same mounted `Readiness.tsx`, the hook's phase/results would remain stale.

**Decision**: Use React's `key` prop pattern — pass `key={provider}` to `<DashboardsTab>` (and to the SLOs tab placeholder) in `Readiness.tsx`. When `provider` changes, React unmounts and remounts the component, and the hook initialises fresh in `idle` state.

**Why NOT add a reset `useEffect` to `useDashboardScan`**: The story says hook internals are unchanged outside Task 3 (`useAlertScan` only). Minimal change set.

**For `AlertsTab`**: After removing `accountId` from `UseAlertScanOptions`, the existing `useEffect` reset changes `deps = [provider]`. Component remount via `key` is NOT needed — the hook self-resets.

**For SLOs tab**: Apply `key={provider}` on the placeholder component for forward-compatibility with Story 005.

---

### Architectural Decision: ToggleButtonGroup Null-Safe Initial State

**Confirmed**: `ToggleButtonGroup` from `@dynatrace/strato-components/forms` uses a generic `TValue` for its `value` prop. Passing `value={undefined}` renders with no item selected — safe and correct.

**State type in `Readiness.tsx`**: `const [provider, setProvider] = useState<CloudProvider | null>(null)`.
**Component binding**: `value={provider ?? undefined}` — maps `null` → `undefined` at the JSX boundary.
**onChange**: `(val) => setProvider(val as CloudProvider)` (all item values are `CloudProvider` strings; the component does not call onChange to deselect, so no null case from onChange).

> ⚠️ **Note**: `ToggleButtonGroup` does not support deselection (once a provider is selected, the user cannot revert to "no selection"). Provider reset is handled by page navigation or app reload. This is acceptable for v1.

---

### Files to Create

- **`ui/app/components/DashboardsTab.tsx`** — Extracted & updated dashboard scan tab
  - Pattern: Follow structure of existing `AlertsTab.tsx` (standalone export, named)
  - Source: Lifted verbatim from the inline `DashboardsTab` in `AccountDetail.tsx`, with two changes:
    1. Remove `accountId` prop and its `useEffect`
    2. Update `includePresetAndReadyMade` reset `useEffect` deps from `[accountId]` → `[provider]`
  - Exports: `DashboardsTab`
  - Imports needed: `Button`, `Chip`, `EmptyState`, `MessageContainer`, `ProgressCircle` from strato-components; `Switch`, `FormField`, `Label`, `TextInput` are NOT needed (token input stays in Readiness page); `Flex` from layouts; `DataTable` from tables; `ExternalLink`, `Paragraph` from typography; `useDashboardScan`; `DASHBOARD_COLUMNS` (move constant here too); types from `../types/`

- **`ui/app/pages/Readiness.tsx`** — New top-level environment migration assessment page
  - Pattern: Thin orchestrator; follows `AccountDetail.tsx` for Tabs structure and `TokenBanner` inline component
  - Contains: `ToggleButtonGroup` provider selector, `TokenBanner` (copied from AccountDetail — this is the only remaining usage), three scan tabs
  - Key import: `ToggleButtonGroup` from `@dynatrace/strato-components/forms`
  - Key import: `Tab`, `Tabs` from `@dynatrace/strato-components/navigation`
  - Key import: `EmptyState` from `@dynatrace/strato-components/content` (no-provider idle state, SLOs placeholder)
  - Key import: `DashboardsTab` from `../components/DashboardsTab`; `AlertsTab` from `../components/AlertsTab`; `useToken` from `../context/TokenContext`

---

### Files to Modify

- **`ui/app/hooks/useAlertScan.ts`** — Remove `accountId`
  - Change 1: `UseAlertScanOptions` type — remove `accountId: string` field
  - Change 2: Hook function signature — remove `accountId` from destructuring
  - Change 3: `useEffect` deps array — change `[accountId, provider]` → `[provider]`
  - Location: Lines ~171–190 (the type definition and hook function signature block)
  - Pattern: Exactly mirrors the existing reset pattern; remove the unused field

- **`ui/app/components/AlertsTab.tsx`** — Remove `accountId` prop
  - Change 1: Component props type — remove `accountId: string` field
  - Change 2: `useAlertScan({ provider, accountId })` call — remove `accountId`
  - Location: The props type literal (~line 32) and the hook call (~line 35)

- **`ui/app/pages/AccountDetail.tsx`** — Strip to Overview-only (largest change)
  - Remove: Entire inline `DashboardsTab` component definition (~130 lines, from `const DashboardsTab =` to closing `};`)
  - Remove: `DASHBOARD_COLUMNS` constant (~60 lines)
  - Remove: Inline `TokenBanner` component (~50 lines, moves to `Readiness.tsx`)
  - Remove: Import of `AlertsTab`
  - Remove: Import of `useDashboardScan`
  - Remove: Import of `useToken` (token no longer used in this file)
  - Remove: `Tabs`, `Tab` imports from `navigation` (no longer tabs)
  - Keep: `DataTable`, `DataTableColumnDef` imports — **verify** if still needed by retained code; remove if not
  - Keep: `Switch`, `FormField`, `Label`, `TextInput` imports — **verify** if still needed; remove if not
  - Replace: The `<Tabs>…</Tabs>` block with a direct `<OverviewTab …/>` render
  - Remove: Imports `Button`, `Chip`, `EmptyState`, `MessageContainer`, `ProgressCircle`, `ExternalLink` — verify each against what `OverviewTab` needs itself
  - Result: ~400 lines → ~80 lines
  - Template: Very close to the existing Overview `<Tab>` block content

- **`ui/app/App.tsx`** — Add route
  - Add: `import { Readiness } from './pages/Readiness';`
  - Add: `<Route path="/readiness" element={<Readiness />} />` inside `<Routes>`, after the existing routes

- **`ui/app/components/Header.tsx`** — Add nav link
  - Add: `<AppHeader.NavItem as={Link} to="/readiness">Migration Assessment</AppHeader.NavItem>` after the existing "Cloud Accounts" item

---

### Files NOT to Touch

- `ui/app/hooks/useDashboardScan.ts` — No changes needed. Reset handled via `key={provider}` on the component. Internal logic is provider-scope-correct already.
- `ui/app/utils/classicPatterns.ts` — Pure utility; not affected.
- `ui/app/components/OverviewTab.tsx` — Story 003 output; explicitly preserved unchanged.
- `ui/app/components/StatusBadge.tsx` — Used only in `AccountDetail.tsx` header; retained.
- `ui/app/types/` — All types remain unchanged. `CloudProvider` already covers `'AWS' | 'Azure' | 'GCP'`.
- `app.config.json` — No scope changes. All required scopes (document, settings, state) established in Stories 002 and 004.

---

### Similar Implementations Reference

- **`ui/app/components/AlertsTab.tsx`** — Best structural template for `DashboardsTab.tsx`
  - Standalone export, named component
  - Props: `{ provider: CloudProvider }` (after Story 006)
  - Uses hook in top function body; phases render inline

- **`ui/app/pages/AccountDetail.tsx`** (lines 1–19) — Import pattern for all Strato components used
  - All imports from sub-packages ✅
  - `ToggleButtonGroup` not yet imported here; `AccountDetail` uses `Tabs` from `navigation`

---

### Architectural Validation

✅ **Strato imports**: All existing imports are from sub-packages. New `ToggleButtonGroup` must be `import { ToggleButtonGroup } from '@dynatrace/strato-components/forms'`.
✅ **Stable vs Preview**: `ToggleButtonGroup`, `Tabs`/`Tab`, `EmptyState`, `Button`, `Flex`, etc. are all stable. Only `Page`/`AppHeader`/`DataTable` are preview — all already in use.
✅ **Token access**: `useToken()` available anywhere in the tree (TokenProvider wraps app root). No prop threading.
✅ **No external fetch in UI**: All data access through Dynatrace SDK hooks. No new fetch calls introduced.
✅ **No scope changes**: `settings:objects:read`, `document:documents:read` already present from Stories 002/004.
⚠️ **AccountDetail import cleanup — verify retained imports**: After removing `DashboardsTab`, `AlertsTab`, and `TokenBanner`, several Strato imports may become unused (`Switch`, `FormField`, `Label`, `TextInput`, `DataTable`, `Button`, `ProgressCircle`, etc.). The implementer must audit imports against what `OverviewTab` and `StatusBadge` actually need at the `AccountDetail` level (likely: only `Flex`, `Heading`, `Text`, `Chip`, `Link` and the router imports).
⚠️ **`key={provider}` on SLOs tab**: Must remember to apply even though it's a placeholder — Story 005 will receive a component with no internal reset effect.
💡 **`TokenBanner` duplication**: The inline `TokenBanner` currently lives in `AccountDetail.tsx`. After this story it lives in `Readiness.tsx`. It's the only consumer. Do NOT extract to a shared component — it would be premature abstraction.
💡 **Tab ordering**: Provider selector → Token banner (below or inline with selector) → Tabs. Token banner is only relevant for the Dashboards tab, but is placed at page level (above tabs) as specified in AC #6.

---

### Scope Changes
None. All required scopes already present in `app.config.json`.

---

### Implementation Order

1. **Extract `DashboardsTab`** → `ui/app/components/DashboardsTab.tsx`
   - Source: Inline `DashboardsTab` from `AccountDetail.tsx` + `DASHBOARD_COLUMNS` constant
   - Changes: Remove `accountId` prop; change `useEffect([accountId])` → `useEffect([provider])`
   - Risk: None — exact copy with two targeted changes

2. **Update `useAlertScan.ts`** — Remove `accountId`
   - `UseAlertScanOptions`: drop field; hook destructuring: drop field; `useEffect` deps: `[provider]` only
   - Risk: One call site (AccountDetail) is already being refactored in Step 4

3. **Update `AlertsTab.tsx`** — Remove `accountId` prop
   - Props type: remove field; `useAlertScan(...)` call: remove field
   - Risk: None — AccountDetail is the only call site

4. **Create `Readiness.tsx`** — New page
   - `useState<CloudProvider | null>(null)` for provider selector
   - `ToggleButtonGroup` with `value={provider ?? undefined}`
   - Conditional render: `EmptyState` when `!provider`; `<Tabs>` when `provider` is set
   - `<DashboardsTab key={provider} …>`, `<AlertsTab key={provider} …>`, SLOs `EmptyState` placeholder with `key={provider}`
   - TokenBanner inline (copied from AccountDetail; no changes to logic)

5. **Clean up `AccountDetail.tsx`** — Strip to Overview-only
   - Remove: inline `DashboardsTab`, `TokenBanner`, `DASHBOARD_COLUMNS`
   - Remove: `AlertsTab`, `useDashboardScan`, `useToken` imports
   - Remove: `Tabs`/`Tab` shell; render `<OverviewTab …/>` directly
   - Audit and remove all now-unused Strato imports
   - Result: ~80 lines

6. **Wire routing & navigation**
   - `App.tsx`: new import + `/readiness` route
   - `Header.tsx`: new "Migration Assessment" nav item

---

### Testing Strategy
- [ ] `Readiness.tsx` — provider selector renders `ToggleButtonGroup` with AWS/Azure/GCP items; no tabs shown until selection
- [ ] `Readiness.tsx` — selecting a provider renders all three tab titles
- [ ] `Readiness.tsx` — switching provider resets `DashboardsTab` to idle (verify via `key` remount)
- [ ] `AlertsTab.tsx` — renders idle state without `accountId` prop; `useAlertScan` no longer takes `accountId`
- [ ] `AccountDetail.tsx` — renders `OverviewTab` directly with no `Tabs` shell present; no scan-related elements in DOM

---

### Risks & Mitigations

- ⚠️ **Risk**: `useDashboardScan` has no internal reset on provider change; results persist without `key` prop.
  - **Mitigation**: `key={provider}` on `<DashboardsTab>` in `Readiness.tsx` forces unmount-remount on every provider switch. Document this in a code comment.

- ⚠️ **Risk**: `AccountDetail.tsx` import audit — removing the inline components leaves many Strato imports dangling. TypeScript will error at build time if unused imports are present with strict linting.
  - **Mitigation**: After stripping, run `npm run lint` and fix all unused-import warnings before committing.

- ⚠️ **Risk**: Story 005 SLO implementation target must be redirected. If Story 005 was already started targeting `AccountDetail.tsx`, the SLO component will need to move to `Readiness.tsx`.
  - **Mitigation**: Update Story 005 before work begins; include a note that the host page is `Readiness.tsx`, not `AccountDetail.tsx`.

---

## Tasks / Subtasks

- [ ] Task 1: Create `ui/app/pages/Readiness.tsx` (AC: #1, #2, #3, #6)
  - [ ] Provider selector (SegmentedControl or Select — architect to decide) with state: `AWS | Azure | GCP | null`
  - [ ] Token input field (promote from AccountDetail — reuse TokenContext which is already global)
  - [ ] Three tabs: Dashboards, Alerts, SLOs — rendered only when a provider is selected
  - [ ] On provider change, reset all three scan tab states to idle

- [ ] Task 2: Lift `DashboardsTab` into `Readiness.tsx` (AC: #4, #5)
  - [ ] Move `DashboardsTab` component from `ui/app/pages/AccountDetail.tsx` to `Readiness.tsx`
  - [ ] Replace `provider` prop source: was `state.provider` from route, now comes from the page-level provider selector
  - [ ] Remove `accountId` prop (no longer needed — it was only used to reset state on account change; the provider selector change now serves this role)
  - [ ] Confirm reset-on-provider-change behaviour (AC #5)

- [ ] Task 3: Lift `AlertsTab` into `Readiness.tsx` (AC: #7, #8)
  - [ ] Move `<AlertsTab>` usage from `AccountDetail.tsx` to `Readiness.tsx`
  - [ ] Replace `provider` source as above
  - [ ] Drop `accountId` prop from `AlertsTab` component interface
  - [ ] Update `useAlertScan` hook: remove `accountId` parameter entirely — it served no scan-logic purpose `[Source: ui/app/hooks/useAlertScan.ts#L171]`
  - [ ] Update `useEffect` reset trigger in `useAlertScan`: was `[accountId, provider]`, change to `[provider]` only

- [ ] Task 4: Redirect SLO tab implementation target (AC: #9, #10)
  - [ ] Story 005 SLO scan implementation should target `Readiness.tsx` as the host page — NOT a new tab on `AccountDetail.tsx`
  - [ ] The SLOs tab component from Story 005 passes `provider` from the page-level selector, not route state
  - [ ] Note: Story 005 internals (sub-scan logic, `detectClassicEntitySelectorPatterns`, result types) are unchanged

- [ ] Task 5: Strip `AccountDetail.tsx` back to Overview-only (AC: #11, #12)
  - [ ] Remove `DashboardsTab` component definition (inline ~170 lines) from `AccountDetail.tsx`
  - [ ] Remove `AlertsTab` import and tab entry
  - [ ] Remove `useDashboardScan` import and call
  - [ ] Remove `DASHBOARD_COLUMNS` constant
  - [ ] Remove `Tabs` / `Tab` imports and component shell — render `<OverviewTab>` directly
  - [ ] Remove `token` / token-input UI from `AccountDetail.tsx` (token entry moves to `Readiness.tsx`)
  - [ ] Retain `OverviewTab` and all dependency-analysis content from Story 003 — untouched

- [ ] Task 6: Wire up routing and navigation (AC: #1)
  - [ ] Add `<Route path="/readiness" element={<Readiness />} />` in `ui/app/App.tsx`
  - [ ] Add "Migration Assessment" nav link in `ui/app/components/Header.tsx`

## Dev Notes

### Relevant Context
- `DashboardsTab` is currently defined inline in `ui/app/pages/AccountDetail.tsx` (not a separate file). It will need to either be extracted to `ui/app/components/DashboardsTab.tsx` or moved inline into `Readiness.tsx`. Architect to decide — both approaches work. `[Source: ui/app/pages/AccountDetail.tsx]`
- `AlertsTab` is already a standalone component at `ui/app/components/AlertsTab.tsx` — it moves cleanly. `[Source: ui/app/components/AlertsTab.tsx]`
- `TokenContext` (`useToken`) is already app-global (`TokenProvider` wraps the entire app in `App.tsx`). No prop threading is needed — the token is available via `useToken()` anywhere in the tree. `[Source: ui/app/context/TokenContext.tsx]`
- The token input UI is currently rendered inside `AccountDetail.tsx`. It should be promoted to a sticky/prominent position at the top of the `Readiness.tsx` page since it affects classic dashboard scanning.

### Platform Capabilities
- `Tabs` / `Tab` from `@dynatrace/strato-components/navigation` — reuse existing `AccountDetail.tsx` import pattern for the Readiness page tab structure `[Source: AGENTS.md#Strato Component Imports]`
- Provider selector component choice (SegmentedControl vs. Select) left to architect — either is suitable for 3 values. `SegmentedControl` is visually compact; `Select` scales better if providers expand.
- Both are available in `@dynatrace/strato-components/forms` — always consult `dynatrace-apps` MCP tool before implementing. `[Source: AGENTS.md#MCP Tools]`

### Data Considerations
- No new API calls are introduced by this story — all data fetching is delegated to the existing scan hooks unchanged.
- Scan results are local hook state — they do not persist across navigation. If a user runs a scan, navigates away from `/readiness`, and returns, the page will be in idle state. This is acceptable for v1.
- The `provider` selector state is local to the `Readiness` page component — it does not need to be in a context or URL param for v1.

### Technical Constraints
- The app is **read-only** — no writes to any API `[Source: .github/prompts/vision.prompt.md#Constraints]`
- `useAlertScan` currently accepts `{ provider, accountId }`. After Task 3, the signature becomes `{ provider }`. Any call site that currently passes `accountId` must be updated. There is only one call site: `AccountDetail.tsx`, which is being refactored anyway. `[Source: ui/app/hooks/useAlertScan.ts]`
- No scope changes are needed in `app.config.json` — all required scopes were established in Stories 002 and 004.

## Cloud Provider Considerations

All three providers (AWS, Azure, GCP) are in scope for the Migration Assessment page. The provider selector must offer all three options. Provider-specific scan differences are unchanged from Stories 002, 004, and 005:

- AWS: all three scan types apply (dashboards, metric events, infrastructure detection, Davis AI detectors, classic SLOs, new SLOs)
- Azure: dashboards + metric events + Davis AI only (no `builtin:anomaly-detection.infrastructure-aws` equivalent) `[Source: ui/app/hooks/useAlertScan.ts#scanInfrastructureDetection]`
- GCP: dashboards + metric events + Davis AI only (same as Azure — infrastructure detection is AWS-only)

The page-level provider selector drives these provider-specific rendering differences — the scan components themselves already handle this internally (they receive `provider` and branch accordingly).

## Dependencies

- Story 001 (Inventory) — no functional dependency, but this story adds a new top-level nav item alongside Inventory
- Story 002 (Dashboard scan) — **must be Done** before this story removes the tab from AccountDetail
- Story 003 (Account Overview tab) — **must be Done** before this story strips AccountDetail to Overview-only
- Story 004 (Alert scan) — **must be Done** before this story removes the tab from AccountDetail
- Story 005 (SLO scan) — this story **redirects** Story 005's implementation target; Story 005 must be updated to note that the SLO tab hosts in `Readiness.tsx`, not `AccountDetail.tsx`. Story 005's internal scan logic is unaffected.

## Testing Guidance

> **Note**: Testing strategy is an open topic — details will be refined when the QA Testing agent is established.

- Provider selector resets all tabs: run a scan for AWS, switch to Azure, verify all three tabs return to idle state
- Token absent warning: navigate to Readiness with no token in TokenContext — verify warning banner appears on Dashboards tab
- AccountDetail page: navigate to any account detail — verify no Dashboards or Alerts tab is present; OverviewTab renders directly without a tab shell
- Navigation: "Migration Assessment" appears in header; `/readiness` route resolves; `/inventory/:accountId` no longer shows scan tabs

---

## UX Specification (Added by UX Reviewer)

### User Flow

1. User clicks **"Migration Assessment"** in the top navigation header
2. Arrives at `/readiness` — sees the page heading, a brief description, and the provider selector (no tabs yet)
3. User clicks a provider in the `ToggleButtonGroup` (AWS / Azure / GCP)
4. The tab panel appears with three tabs: **Dashboards**, **Alerts**, **SLOs** — all in idle state
5. User navigates to a tab and triggers a scan (provider selector stays visible for switching)
6. On provider switch: the active tab stays selected, but its content resets to idle — previous scan results are discarded
7. User can switch providers and re-scan without navigating away

### Component Specifications

#### Provider Selector

- **Strato Component**: `ToggleButtonGroup` from `@dynatrace/strato-components/forms`
  > ⚠️ Story refers to "SegmentedControl" — that component does not exist in Strato. `ToggleButtonGroup` is the correct equivalent.
- **Purpose**: Selects the cloud provider that scopes all three scan tabs. This is the primary interaction on the page; it must be visually prominent.
- **Key Props**:
  - `value`: `CloudProvider | null` — controlled; `null` on initial load (no provider selected)
  - `onChange`: `(value: string) => void` — updates provider state; triggers reset of all scan tab states
  - `name`: `"cloud-provider"` — accessibility identifier
- **Items**:
  ```tsx
  <ToggleButtonGroup.Item value="AWS">AWS</ToggleButtonGroup.Item>
  <ToggleButtonGroup.Item value="Azure">Azure</ToggleButtonGroup.Item>
  <ToggleButtonGroup.Item value="GCP">GCP</ToggleButtonGroup.Item>
  ```
- **States**:
  - Default (no selection): No item highlighted; the EmptyState prompt is shown below
  - Item selected: Selected item is visually active; tabs appear below
- **Use Case Reference**: `Controlled` — manage `value` and `onChange` explicitly
- **Notes**: Initial `value` should be `null` or `undefined`; the component renders with no item selected, which matches the "no provider chosen yet" UX intent. The architect should verify that `ToggleButtonGroup` accepts `null` as `value` without errors.

---

#### No-Provider Idle State

- **Strato Component**: `EmptyState` from `@dynatrace/strato-components/content`
- **Purpose**: Keeps the page from feeling broken when no provider is selected. Guides the user toward the single required first action.
- **Render condition**: Shown only when `provider === null`; the `<Tabs>` component is NOT rendered in this state
- **Content**:
  - `EmptyState.Title`: `"Select a cloud provider to begin"`
  - `EmptyState.Details`: `"Choose AWS, Azure, or GCP above to load the migration assessment tabs."`
  - No `EmptyState.Actions` — the `ToggleButtonGroup` above is the call to action
- **States**:
  - Only one state: shown when no provider is selected

---

#### Scan Tab Container

- **Strato Component**: `Tabs` + `Tab` from `@dynatrace/strato-components/navigation`
- **Purpose**: Houses the three scan surfaces — Dashboards, Alerts, SLOs — as a single controlled tab panel
- **Render condition**: Shown only when a provider is selected (`provider !== null`)
- **Key Props** (`Tabs`):
  - `selectedIndex`: `number` — controlled tab state; initialized to `0`
  - `onChange`: `(index: number) => void` — updates selected tab index
- **Tab order**: `0` = Dashboards, `1` = Alerts, `2` = SLOs
- **States**:
  - On provider change: `selectedIndex` does NOT reset — the active tab stays selected. Only the tab's internal scan state resets to idle.
  - On route mount: `selectedIndex` defaults to `0` (Dashboards)
- **Notes**: Use the `Controlled` use case pattern. `defaultIndex` alone is not sufficient because the architect needs to conditionally manage tab state on provider change.

---

#### Dashboards Tab — Token Banner (Relocated)

- **Strato Component**: `MessageContainer` from `@dynatrace/strato-components/content` (existing `TokenBanner` component)
- **Purpose**: Allows the user to enter a Dynatrace API token required for classic dashboard scanning.
- **Placement**: At the **top of the Dashboards tab content** — above the scan toggle and button.
  > ⚠️ **UX reversal of story Task 1 note**: The story originally specified the token input at the page level above all tabs. UX review determined it belongs inside the Dashboards tab only. Reasoning: only the Dashboards scan uses this token; placing it at the page level adds visual noise before the user has engaged with any tab. The existing `TokenBanner` component moves intact — no API or logic changes.
- **States**:
  - Token not set: `MessageContainer variant="primary"` — show full token entry form (existing `TokenBanner` "no token" state)
  - Token set: `MessageContainer variant="success"` — show "API token set. [Change]" (existing `TokenBanner` "token present" state)
- **Notes**: The `useToken()` hook provides global token access anywhere in the component tree — no prop threading required.

---

#### SLOs Tab — Placeholder State

- **Strato Component**: `EmptyState` from `@dynatrace/strato-components/content`
- **Purpose**: Signals that SLO scanning is a planned feature without hiding the tab or disabling it.
- **Important**: The SLOs tab must be an **enabled, selectable tab** — do NOT use `<Tab disabled>`. A disabled tab is invisible to users who haven't discovered it yet.
- **Content**:
  - `EmptyState.Title`: `"SLO scan coming soon"`
  - `EmptyState.Details`: `"Scanning for classic SLO dependencies will be available in a future release."`
  - No `EmptyState.Actions` or `EmptyState.Footer`
- **Removed when**: Story 005 is implemented and the SLOs tab receives real content

---

#### Header Navigation — "Migration Assessment" Link

- **Strato Component**: `AppHeader.NavItem` from `@dynatrace/strato-components-preview/layouts` (already imported in `Header.tsx`)
- **Purpose**: Provides top-level navigation access to the new page
- **Placement**: After the existing "Cloud Accounts" nav item
- **Implementation**:
  ```tsx
  <AppHeader.NavItem as={Link} to="/readiness">
    Migration Assessment
  </AppHeader.NavItem>
  ```
- **Notes**: No import changes needed in `Header.tsx` — `AppHeader` is already imported

---

### Information Hierarchy

The user's mental model on this page is: **choose context first, then act**.

1. **Page heading** — "Migration Assessment" (orients the user)
2. **Provider selector** — `ToggleButtonGroup` front and center; the mandatory first action
3. **Tabs** — only visible after context is set; prevents cognitive overload on entry
4. **Tab content** — scan controls and results scoped to the selected provider

### Empty States

| Scenario | Component | Title | Details | Action |
|---|---|---|---|---|
| No provider selected (page load) | `EmptyState` | "Select a cloud provider to begin" | "Choose AWS, Azure, or GCP above to load the migration assessment tabs." | None (ToggleButtonGroup above is the CTA) |
| Dashboards tab — no results after scan | `EmptyState` (existing) | "No dependent dashboards found" | Existing copy from Story 002 | None |
| Alerts tab — no results after scan | `EmptyState` (existing from Story 004) | Existing copy | Existing copy | None |
| SLOs tab — feature not yet released | `EmptyState` | "SLO scan coming soon" | "Scanning for classic SLO dependencies will be available in a future release." | None |

### Error Handling

| Error Scenario | Component | Message | Recovery |
|---|---|---|---|
| Dashboard scan error | `MessageContainer variant="critical"` (existing) | "Scan error: [message]" | "Retry" button |
| Alerts scan error | `MessageContainer variant="critical"` (existing from Story 004) | Existing copy | Existing "Retry" |
| No token — Dashboards tab | `MessageContainer variant="primary"` (TokenBanner, moved) | "Dynatrace API Token required for classic dashboard scan" | Inline token entry form |

### Migration Journey Context

This page lives at the **Prepare** phase boundary. It is the environment-wide readiness "checkpoint" before any migration action is taken. The user typically:
1. Visits Inventory (Story 001) first to understand what cloud accounts exist
2. Then comes to Migration Assessment to understand what will break across the full environment
3. Uses findings here to plan and prioritize migration work

There is no "next step" CTA on this page in v1 — the app is read-only and does not manage migration state. The information hierarchy makes findings self-evident enough that users can act on them in their own change management process.
- No provider selected: verify the `/readiness` page shows the prompt and no scan tabs (no errors)

## Out of Scope

- Cross-linking from AccountDetail to Migration Assessment (e.g., "4 dashboards reference classic AWS metrics — view in Migration Assessment") — deferred to a future story
- Persisting scan results across navigation sessions
- Per-account filtering of scan results (this is precisely the capability the scans cannot provide — deferred indefinitely)
- Changes to scan detection logic, `classicPatterns.ts`, result types, or API client usage

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-04-09 | 1.0 | Initial draft | Story Writer |
