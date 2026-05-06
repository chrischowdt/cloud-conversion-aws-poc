# User Story: Account Overview Tab — Entities and Classic Metric Keys

**Status**: Draft
**Category**: Discovery
**Migration Phase**: Prepare

## Story Statement

**As a** Dynatrace Administrator,
**I want** to see a summary of what classic entity types exist and how many distinct classic metric keys are actively ingested for a selected cloud account,
**so that** I understand the scope of the classic connection's footprint before I dive into the dependency analysis tabs.

## Context

Story 002 defines the four-tab frame on the account detail page (`Overview` | `Dashboards` | `Metric Events` | `SLOs`) but leaves the Overview tab empty and defaults to Dashboards (index 1). This story populates the Overview tab and changes `defaultIndex` to `0` so it becomes the default landing experience.

The Overview tab's purpose is **scope orientation, not dependency analysis**. It answers: "How much classic infrastructure does this account have?" — not "What will break?" That question belongs to the dependency tabs (Dashboard scan, Metric Events scan, SLOs scan) and the readiness scoring story. Surfacing raw counts here without a readiness overlay is intentional: they give the administrator context to mentally calibrate the effort before they view the scan results.

`[Source: .github/prompts/vision.prompt.md#Capabilities]` `[Source: .github/stories/002-scan-dashboards-for-classic-dependencies.md#UX Specification]`

## Inventory Page Improvements (implemented in commit b43c123)

The following features were implemented alongside this story as improvements to the Cloud Account Inventory page (`ui/app/pages/Inventory.tsx`). They are documented here to prevent accidental removal:

### Timeframe Selector

- A `Select` dropdown in the `DataTable.TableActions` bar lets users choose how far back to scan for active connections: **Last 12 hours** (default), **Last 24 hours**, **Last 7 days**, **Last 30 days**.
- The selected timeframe is passed to `useCloudAccountInventory(timeframe)` and controls the DQL `from:` window for all inventory queries.
- An informational subtitle below the `Heading` reads _"Showing connections active in the \<timeframe\>"_ with a tooltip explaining the window's effect on both connection discovery and the Metric Streams detection used by the migration-blocked indicator.
- `InventoryTimeframe` type lives in `ui/app/types/connection.ts`; the hook signature is `useCloudAccountInventory(timeframe: InventoryTimeframe = '12h')`.

### Migration Status Chips

- A **"Migration blocked"** chip (`Chip color="critical"`) is shown in the `Status` column for any AWS account where CloudWatch Metric Streams is detected as active. AWS Metric Streams is not yet supported by the new AWS connection, so these accounts cannot complete migration until that support lands.
- The chip has a `Tooltip` explaining the blocker and noting that classic polling services can still be migrated independently.
- The `isMigrationBlocked: boolean` field is computed in `useCloudAccountInventory` and exposed on `CloudAccount`.
- New connections that require no migration show an empty cell (no chip); this is intentional — the absence of a chip is the "no action needed" signal.
- The previous `Status` column header was renamed to **`Cloud Connection`** to disambiguate it from the new `Status` column that holds the chip.

## Acceptance Criteria

1. **Given** a user navigates to the account detail page, **when** the page loads, **then** the Overview tab is the default active tab.

2. **Given** a classic cloud account is selected, **when** the Overview tab is active and data has loaded, **then** the user sees a table of classic entity types for that account with the count of entities per type. Only types with a count greater than zero are shown. The table is sorted by count, highest first.

3. **Given** an entity type row in the table, **when** the user activates the drill-down for that row, **then** they are taken to the appropriate Clouds App view for that entity type and account, allowing them to inspect the entities in detail.

4. **Given** a classic cloud account is selected, **when** the Overview tab is active and data has loaded, **then** the user sees the total count of distinct classic metric keys actively ingested for this account in the last 2 hours.

5. **Given** the metric key count is shown, **when** the user wants to explore the full list, **then** they can navigate to the Dynatrace Notebooks app with a pre-populated DQL query that lists all classic metric keys for this account. The app does not create or modify any notebook; it only provides the navigation entry point.

6. **Given** all entity queries have completed and no entities are found, **when** the entity section renders, **then** an informational message is shown explaining that no classic entities were detected for this account.

7. **Given** the metric key count query has completed and no keys are found, **when** the metrics section renders, **then** an informational message indicates no classic metric keys were detected in recent data.

8. **Given** the user navigates from one account to another, **when** the account detail page loads for the new account, **then** any data from the previous account is discarded and fresh queries are triggered.

---
## ARCHITECTURAL ANALYSIS
*Generated by architect agent on 2026-04-08 — v1.3 spec (DataTable entities, SingleValue metric count)*

### Current Architecture Context

**Relevant existing files:**
- [ui/app/pages/AccountDetail.tsx](../../ui/app/pages/AccountDetail.tsx) — Tab frame host; `AccountDetailState` type at line ~21 holds `{ provider, status, connectionName }` only — **does not carry `entityId`**; has `defaultIndex={1}` on `<Tabs>` (~line 298) and the empty Overview placeholder this story replaces
- [ui/app/pages/Inventory.tsx](../../ui/app/pages/Inventory.tsx) — Navigation source; `<Link>` state passes `{ provider, status, connectionName }` only — `entityId` and `subscriptionEntityId` absent
- [ui/app/types/connection.ts](../../ui/app/types/connection.ts) — `CloudAccount.entityId` stores the classic connection entity ID; `ClassicAzureConnection` stores `accountId` (subscription UUID) but **not the subscription entity ID** (`AZURE_SUBSCRIPTION-*`)
- [ui/app/hooks/useConnectionInventory.ts](../../ui/app/hooks/useConnectionInventory.ts) — Azure classic DQL returns `sub_id` (the `AZURE_SUBSCRIPTION-*` entity ID) but it is **silently dropped** in the `azureClassicConnections` `useMemo` mapping
- [ui/app/utils/classicPatterns.ts](../../ui/app/utils/classicPatterns.ts) — Exports `CLASSIC_ENTITY_TYPES` and `CLASSIC_METRIC_PREFIXES` (not `CLASSIC_PATTERNS`). AWS list has 8 types; Azure has only 3; GCP is `custom_device` only

**Established patterns:**
- **Multi-query DQL hook**: Call multiple `useDql` unconditionally at hook top level (React rules). Build query strings with `useMemo` on their dependencies. See `useConnectionInventory.ts` — 6x unconditional `useDql` calls → `useMemo` merge.
- **Self-contained tab component**: Receives minimal props, calls its own hook, handles all states (loading/error/empty/data) independently. See `DashboardsTab` component in `AccountDetail.tsx` as the direct template.
- **DataTable usage**: `DataTable` with `columns` memoized as file-scope constants and `loading` prop consuming hook boolean. See `DASHBOARD_COLUMNS` + `<DataTable columns={DASHBOARD_COLUMNS} ... />` in `AccountDetail.tsx`.

### ⚠️ Critical Pre-Implementation Gaps

These must be resolved before `useAccountOverview` can be written. **Unchanged from prior analysis.**

#### Gap 1 — Azure subscription entity ID is not propagated (HIGH PRIORITY)

`useConnectionInventory.ts` AZURE_CLASSIC_QUERY fetches `sub_id` (the `AZURE_SUBSCRIPTION-*` entity ID) but `azureClassicConnections` `useMemo` maps only `entityId` and `accountId` — `sub_id` is dropped.

Azure entity count queries require `in("AZURE_SUBSCRIPTION-<id>", accessible_by[dt.entity.azure_subscription])` (dql-patterns.md §7.1), which needs the entity ID, not the UUID.

**Fix required in sequence:**
1. `ui/app/types/connection.ts` — Add `subscriptionEntityId: string | null` to `ClassicAzureConnection`
2. `ui/app/hooks/useConnectionInventory.ts` — Map `r['sub_id']` → `subscriptionEntityId` in `azureClassicConnections` useMemo (one field addition)
3. `ui/app/types/connection.ts` — Add `subscriptionEntityId: string | null` to `CloudAccount` (null for AWS/GCP)

#### Gap 2 — `entityId` absent from route state (HIGH PRIORITY)

`Inventory.tsx` `<Link>` state is `{ provider, status, connectionName }` — missing `entityId` and `subscriptionEntityId`. `AccountDetailState` type mirrors this gap.

**Fix:** Add `entityId: string | null` and `subscriptionEntityId: string | null` to `AccountDetailState` in `AccountDetail.tsx`; add both to the `<Link>` state object in `Inventory.tsx`.

#### Gap 3 — `CLASSIC_ENTITY_TYPES` is significantly incomplete (MEDIUM PRIORITY)

Current `classicPatterns.ts`:
- AWS: 8 types — missing `dynamo_db_table` (confirmed: `docs/aws-classic.md §4.1`)
- Azure: **only 3 types** (`azure_vm`, `azure_sql_server`, `azure_cosmos_db`) vs. the 12 types this story queries

**Fix:** Extend `classicPatterns.ts` as the first implementation task:
- AWS: add `dynamo_db_table`
- Azure: replace 3-type list with: `azure_vm`, `azure_vm_scale_set`, `azure_load_balancer`, `azure_event_hub_namespace`, `azure_event_hub`, `azure_redis_cache`, `azure_function_app`, `azure_storage_account`, `azure_cosmos_db`, `azure_web_app`, `azure_sql_server`, `azure_sql_database` (cross-referenced against `docs/azure-classic.md §4.1`)

### Files to Create

- **`ui/app/hooks/useAccountOverview.ts`** — New hook
  - Pattern: Follow `useConnectionInventory.ts` — `useMemo` query strings, 4x unconditional `useDql`, `useMemo` merge
  - Exports: `useAccountOverview`, `EntityTypeSummary` type, `UseAccountOverviewResult` type
  - **Return shape** (v1.3): `{ entities: EntityTypeSummary[], entityLoading: boolean, metricKeyCount: number, metricLoading: boolean }`
    - `metricKeyCount: number` — total distinct classic metric keys; no `string[]` prefix array
    - `entities: EntityTypeSummary[]` — one `{ entityType: string; count: number }` row per type; hook returns all including zeros so that callers can filter if needed (component filters before DataTable `data` prop)
  - **4 `useDql` calls** (all unconditional):
    1. `builtInQuery` — AWS/Azure `append` chain across provider's built-in `CLASSIC_ENTITY_TYPES`; empty string `''` for GCP (no built-in DT entity types)
    2. `fallbackQuery` — **AWS only**: unscoped `fetch dt.entity.ebs_volume | summarize count()` for types where `accessible_by` is absent; empty string for Azure/GCP
    3. `customDeviceQuery` — `CUSTOM_DEVICE` filtered by `cloud:<provider>` prefix + credential/subscription/project scoping
    4. `metricCountQuery` — `fetch metric.series, from:now()-2h | filter <CLASSIC_METRIC_PREFIXES[provider] conditions> | summarize count()` — returns a single integer row (v1.3 change from `summarize by:{metric.key}`)
  - Query strings built with `useMemo([credentialEntityId, subscriptionEntityId, accountId, provider])`

- **`ui/app/components/OverviewTab.tsx`** — New component
  - Pattern: `DashboardsTab` in `AccountDetail.tsx` — self-contained, props-driven, all states inline
  - Props: `{ provider: CloudProvider; credentialEntityId: string | null; subscriptionEntityId: string | null; accountId: string | null }`
    - `accountId` required for GCP `project_id` scoping (read from `useParams` in `AccountDetail`)
  - Sections: Classic Entities (`DataTable`) + Classic Metric Keys (`SingleValue` + `IntentButton`)

- **`ui/app/utils/entityTypeLabels.ts`** — New pure lookup utility
  - `Record<string, string>` + fallback function for human-friendly labels
  - Used in the Entity Type `DataTable` column cell renderer
  - Format: plural title-cased nouns — `'ec2_instance' → 'EC2 Instances'`, `'azure_vm' → 'Virtual Machines'`, `'cloud:gcp:gce_instance' → 'GCE Instances'`
  - Fallback strategy: strip `cloud:aws:/cloud:azure:/cloud:gcp:` prefix, replace `_` and `:` with spaces, title-case

### Files to Modify

- **`ui/app/utils/classicPatterns.ts`** — Extend entity type lists *(do first — unblocks hook implementation)*
  - See Gap 3 details above

- **`ui/app/types/connection.ts`** — Add subscription entity ID fields
  - `subscriptionEntityId: string | null` on `ClassicAzureConnection`
  - `subscriptionEntityId: string | null` on `CloudAccount` (with JSDoc: `/** Azure AZURE_SUBSCRIPTION-* entity ID — null for AWS and GCP */`)

- **`ui/app/hooks/useConnectionInventory.ts`** — Propagate `sub_id`
  - `azureClassicConnections` useMemo: add `subscriptionEntityId: asStringOrNull(r['sub_id'])`
  - `accounts` flat list builder: propagate `subscriptionEntityId` from Azure classic connections; `null` for all others

- **`ui/app/pages/Inventory.tsx`** — Add entity IDs to route state
  - `<Link>` state: add `entityId: rowData.entityId` and `subscriptionEntityId: rowData.subscriptionEntityId ?? null`

- **`ui/app/pages/AccountDetail.tsx`** — Wire OverviewTab + fix defaultIndex
  - `AccountDetailState` type: add `entityId: string | null` and `subscriptionEntityId: string | null`
  - Change `defaultIndex={1}` → `defaultIndex={0}`
  - Replace Overview `<Tab>` body (`<EmptyState>` placeholder): `<OverviewTab provider={provider} credentialEntityId={state?.entityId ?? null} subscriptionEntityId={state?.subscriptionEntityId ?? null} accountId={accountId ?? null} />`
  - Add import: `import { OverviewTab } from '../components/OverviewTab'`

### Files NOT to Touch

- `ui/app/App.tsx` — No new routes; AccountDetail route exists
- `ui/app/components/Header.tsx` — No new nav items
- `ui/app/hooks/useDashboardScan.ts` — Unrelated concern
- `ui/app/types/dashboard.ts` — Unrelated
- `app.config.json` — `storage:entities:read` + `storage:metrics:read` already present; no new scopes

### Component Specifications (v1.3)

#### Entities section — `DataTable`

```tsx
import { DataTable, type DataTableColumnDef } from '@dynatrace/strato-components/tables';
```

- `data`: `entities.filter(e => e.count > 0)` — filter zeros **before** the prop, not inside column rendering
- `columns`: memoized file-scope constant; column `'entityType'` renders `entityTypeLabel(row.entityType)` in cell
- `sortable`: `true`; `defaultSortBy`: `[{ id: 'count', desc: true }]`
- `loading`: `entityLoading` from hook — shows built-in skeleton rows
- `fullWidth`: `true`
- **Row action**: `DataTable.RowActions` slot — `Button variant="default"` labeled "View in Clouds App" per row. See OQ #3 resolution below.
- **Empty state**: `<DataTable.EmptyState>No classic entities detected for this account.</DataTable.EmptyState>`

#### Metric count section — `SingleValue` + `IntentButton`

```tsx
import { SingleValue } from '@dynatrace/strato-components/charts';
import { IntentButton } from '@dynatrace/strato-components/buttons';
import type { IntentPayload } from '@dynatrace-sdk/navigation';
```

- `<SingleValue data={metricKeyCount} label="Classic metric keys actively ingested (last 2 hours)" loading={metricLoading} />`
- Wrap in a fixed-width container (~200px); do not let it stretch to fill tab width
- Conditionally render `SingleValue` vs. inline `Text` empty-state based on `metricKeyCount === 0 && !metricLoading`
- **"Explore in Notebooks" button** — rendered when `metricKeyCount > 0 && !metricLoading`:

```tsx
// ✅ OQ #4 RESOLVED — confirmed via Strato IntentButton docs + @dynatrace-sdk/navigation
const notebooksQuery = buildMetricKeyListQuery(provider, credentialEntityId); // DQL returning distinct metric keys
const notebooksPayload: IntentPayload = { 'dt.query': notebooksQuery };

<IntentButton
  payload={notebooksPayload}
  options={{ recommendedAppId: 'dynatrace.notebooks', recommendedIntentId: 'view-query' }}
  variant="emphasized"
>
  Explore in Notebooks
</IntentButton>
```

The `dt.query` payload with `recommendedAppId: 'dynatrace.notebooks'` and `recommendedIntentId: 'view-query'` is the documented pattern for opening Notebooks with a pre-populated DQL query. `@dynatrace-sdk/navigation` is already installed (`node_modules/@dynatrace-sdk/navigation` v2.2.0).

The `buildMetricKeyListQuery` helper (inline or small utility) constructs:
```dql
fetch metric.series, from:now()-2h
| filter startsWith(metric.key, "<prefix1>") OR startsWith(metric.key, "<prefix2>") ...
| summarize by:{metric.key}
| sort metric.key asc
```
This lists the individual keys — different from the count query (which uses `summarize count()`). The helper accepts `provider` + `credentialEntityId` to scope the query; scoping to a specific credential in metric.series is not currently documented in `dql-patterns.md` and may not be filterable — the Notebooks query may list all keys of the provider prefix globally. **Flag this in code comments.**

### Open Questions — Investigation Results

#### OQ #3: Clouds App drill-down — entity type list view navigation

**Investigation performed** via `@dynatrace-sdk/navigation` TypeScript definitions and `node_modules/@dynatrace-sdk/navigation` package analysis.

**Findings:**
- **App ID confirmed**: `dynatrace.clouds` — found as a literal string in `AccountDetail.tsx` (line ~113, dashboard filter summary text). Already in the workspace.
- **Navigation SDK** (`@dynatrace-sdk/navigation` v2.2.0, installed): provides `sendIntent(payload, options)`, `IntentButton`, `openApp(appId)`, and `getAppLink(appId, pageToken)`.
- **Built-in `IntentPayload` keys**: The SDK formally defines only three built-in types: `dt.query`, `dt.timeframe`, and `dt.entity.host`. There are **no** built-in types for cloud entity categories (`dt.entity.ec2_instance`, `dt.entity.azure_vm`, etc.). `IntentPayload` itself is an open `[key: string]: any` dictionary.
- **`dt.entity` generic key**: As a free-form string, `{ 'dt.entity': '<entityId>' }` can be sent, but this navigates to a single entity's detail page — **not a list view filtered to an entity type + account**. This would require a specific entity ID, which the DataTable row only has `entityType` + `count`, not individual entity IDs.
- **Clouds App intent IDs**: The Clouds App's registered intent declarations (what payload shapes it accepts and what intent IDs it exposes for list views filtered by entity type) are **not documented in any local SDK, type definition, or workspace doc**. Requires live verification.
- **`getAppLink` page tokens**: The Clouds App may declare page tokens for entity list views (e.g. `ec2-instances`), but these are not available in the SDK or workspace docs.

**Viable implementation options (listed by preferred to fallback):**

| Option | Mechanism | Fidelity | Verifiable without live env? |
|---|---|---|---|
| A | `sendIntent({ 'dt.entity': entityId }, { recommendedAppId: 'dynatrace.clouds' })` | Single entity — wrong UX | No |
| B | `sendIntent({ 'dt.query': 'fetch dt.entity.<type> \| filter ...' }, { recommendedAppId: 'dynatrace.clouds' })` | List if Clouds App handles `dt.query` | No |
| C | `sendIntent({ 'dt.query': ... }, { recommendedAppId: 'dynatrace.notebooks' })` | List in Notebooks, not Clouds App | Yes ✅ |
| D | `openApp('dynatrace.clouds')` | Opens Clouds App home — no filter | Yes ✅ |

**Architectural recommendation**: Implement the row action as a regular `Button` with an `onClick` that calls `sendIntent` from `@dynatrace-sdk/navigation`. Start with **Option B**: pass a provider-scoped DQL query as `dt.query` with `recommendedAppId: 'dynatrace.clouds'`. If the Clouds App does not declare a `dt.query` intent handler, the platform will show an "Open with..." picker defaulting to Notebooks — which is an acceptable fallback UX. The implementer **must verify** Option B behavior in a live Dynatrace environment before shipping.

**Import pattern for the row action:**
```tsx
import { sendIntent } from '@dynatrace-sdk/navigation';

// In DataTable.RowActions onClick:
sendIntent(
  { 'dt.query': `fetch dt.entity.${row.entityType} | filter in("${credentialEntityId}", accessible_by[\`dt.entity.aws_credentials\`]) | fields entity.name, entity.type` },
  { recommendedAppId: 'dynatrace.clouds' }
);
```

**Status: PARTIALLY RESOLVED** — app ID confirmed, mechanism confirmed, specific Clouds App intent ID for entity-type list view requires live environment verification.

#### OQ #4: Notebooks deep-link mechanism

**Status: RESOLVED** ✅

`IntentButton` from `@dynatrace/strato-components/buttons` with:
- `payload: { 'dt.query': '<DQL string>' }` — the well-known `dt.query` intent payload property
- `options.recommendedAppId: 'dynatrace.notebooks'` — direct Notebooks app targeting
- `options.recommendedIntentId: 'view-query'` — the Notebooks app's declared intent for query viewing

This is the documented canonical pattern, confirmed by the official Strato `IntentButton` Basic and OpenWith example code. No URL construction, no document creation — pure intent-based navigation.

`@dynatrace-sdk/navigation` is already installed in this project (v2.2.0 in `node_modules`).

### Architectural Validation

✅ **Scopes**: `storage:entities:read` + `storage:metrics:read` already in `app.config.json`  
✅ **DQL entities**: `append` batches multiple `fetch dt.entity.<type>` blocks; `summarize count(), by:{entity.type}` collapses to one row per type  
✅ **DQL metric count**: `summarize count()` returns scalar integer — hook stores it as `metricKeyCount: number`; no client-side prefix extraction needed  
✅ **DataTable import**: `import { DataTable, type DataTableColumnDef } from '@dynatrace/strato-components/tables'` — stable package, confirmed by existing `AccountDetail.tsx` usage  
✅ **SingleValue import**: `import { SingleValue } from '@dynatrace/strato-components/charts'` — stable sub-package  
✅ **IntentButton import**: `import { IntentButton } from '@dynatrace/strato-components/buttons'` + `import type { IntentPayload } from '@dynatrace-sdk/navigation'`  
✅ **Hook pattern**: 4x `useDql` called unconditionally at hook top (React rules compliance)  
✅ **OQ #4**: `IntentButton` with `dynatrace.notebooks` / `view-query` is the correct Notebooks navigation API  
⚠️ **OQ #3**: Clouds App entity list view requires live environment verification — implement with Option B (`dt.query` via `sendIntent`) with "Open with" fallback as safety net  
⚠️ **`ebs_volume` fallback**: `accessible_by` absent on `ebs_volume`; run as separate unscoped `useDql`; document over-count risk  
⚠️ **GCP entity scoping**: GCP uses `project_id == accountId` (direct string field) — `accountId` prop must be passed from `AccountDetail` via `useParams`  
⚠️ **Azure null subscription**: `subscriptionEntityId: null` Azure credentials will get empty query strings for built-in/custom device queries → entities empty state; show inline warning  
⚠️ **Notebooks metric DQL scope**: `metric.series` may not support credential-scoped filtering — the Notebooks DQL may show ALL provider classic keys globally; add code comment  
💡 **`CLASSIC_PATTERNS` vs. actual exports**: Story Dev Notes reference `CLASSIC_PATTERNS[provider]` — this export does not exist. Use `CLASSIC_ENTITY_TYPES[provider]` and `CLASSIC_METRIC_PREFIXES[provider]` from `classicPatterns.ts`.  
💡 **Zero-count filtering**: Filter zeros **before** the DataTable `data` prop, not inside cell renderers. This is a v1.3 spec requirement and prevents empty rows flickering during DataTable re-renders.

### Implementation Order

1. **Extend entity lists** — `ui/app/utils/classicPatterns.ts`
   - Add `dynamo_db_table` to AWS; replace Azure list with 12 types
2. **Add subscription entity ID to types** — `ui/app/types/connection.ts`
   - `subscriptionEntityId: string | null` on `ClassicAzureConnection` and `CloudAccount`
3. **Propagate `sub_id`** — `ui/app/hooks/useConnectionInventory.ts`
   - Map `r['sub_id']` → `subscriptionEntityId`; propagate into `CloudAccount` objects
4. **Update route state** — `ui/app/pages/Inventory.tsx`
   - Add `entityId` and `subscriptionEntityId` to `<Link>` state
5. **Create entity type labels** — `ui/app/utils/entityTypeLabels.ts`
   - Pure `Record<string, string>` + `entityTypeLabel(key: string): string` fallback function
6. **Implement hook** — `ui/app/hooks/useAccountOverview.ts`
   - 4x `useDql`; returns `{ entities, entityLoading, metricKeyCount, metricLoading }`
7. **Implement component** — `ui/app/components/OverviewTab.tsx`
   - DataTable (entities) + SingleValue + IntentButton (metric count)
8. **Wire into AccountDetail** — `ui/app/pages/AccountDetail.tsx`
   - Update `AccountDetailState`; change `defaultIndex`; replace Overview placeholder

### Testing Strategy

- [ ] `useAccountOverview` — mock `useDql`; verify AWS `append` query includes all 9 built-in entity types; verify `ebs_volume` fired as separate unscoped query
- [ ] `useAccountOverview` — Azure path: verify `subscriptionEntityId` used in `accessible_by` filter; verify custom device query uses `cloud:azure` prefix
- [ ] `useAccountOverview` — GCP path: only custom device query fires; `project_id == accountId` used (not `accessible_by`)
- [ ] `useAccountOverview` — metric count query: `summarize count()` used (not `summarize by:{metric.key}`); hook exposes integer `metricKeyCount`
- [ ] `OverviewTab` — zero-count rows filtered before `DataTable` `data` prop (AC #2); non-zero rows appear sorted descending by count
- [ ] `OverviewTab` — `DataTable.EmptyState` shown when all entity counts are zero (AC #6)
- [ ] `OverviewTab` — inline `Text` replaces `SingleValue` when `metricKeyCount === 0 && !metricLoading` (AC #7)
- [ ] `OverviewTab` — `IntentButton` rendered with correct `dt.query` payload and `recommendedAppId: 'dynatrace.notebooks'` when `metricKeyCount > 0`
- [ ] Integration: Inventory → AccountDetail passes `entityId` in route state; Overview tab is default (index 0)

### Risks & Mitigations

- ⚠️ **Risk:** `accessible_by` absent on `ebs_volume` (and possibly `aws_lambda_function`) causes `FIELD_DOES_NOT_EXIST` if included in the `append` chain
  - **Mitigation:** Move `ebs_volume` to its own unscoped `useDql` call. For other uncertain types, test in live environment and move to fallback query if needed. Document in code comments.
- ⚠️ **Risk:** Clouds App does not handle `dt.query` intent — row action opens "Open with..." picker instead of Clouds App directly
  - **Mitigation:** Acceptable fallback for v1 — user still gets to a useful view. Verify in live environment and update `recommendedIntentId` once the correct ID is confirmed.
- ⚠️ **Risk:** Azure credentials with `sub_id: null` surface an unhelpful empty state with no explanation
  - **Mitigation:** `OverviewTab` checks `provider === 'Azure' && !subscriptionEntityId` and renders an inline `MessageContainer variant="warning"` before the table.
- ⚠️ **Risk:** `metricKeyCount` DQL (`summarize count()`) counts metric series rows, not distinct key names, if `metric.series` has one row per resolution bucket per key
  - **Mitigation:** Verify the DQL returns distinct key count in live environment. If not, change to `summarize by:{metric.key} | summarize count()` (two-stage) or `fields metric.key | dedup metric.key | summarize count()`.

---
## Tasks / Subtasks

- [ ] Task 1: Change `defaultIndex` in `AccountDetail.tsx` from `1` to `0` (AC: #1)
  - [ ] Update the `defaultIndex` prop on `<Tabs>` in `AccountDetail.tsx` — one-line change

- [ ] Task 2: Implement `useAccountOverview` hook (`ui/app/hooks/useAccountOverview.ts`) (AC: #2, #3, #5, #7, #8, #9, #10, #12)
  - [ ] Define return shape: `{ entities: EntityTypeSummary[], entityLoading: boolean, metricKeyCount: number, metricLoading: boolean }`
  - [ ] For AWS: run batched `append` DQL query across all known classic built-in entity types (`ec2_instance`, `ebs_volume`, `aws_lambda_function`, `auto_scaling_group`, `aws_application_load_balancer`, `aws_network_load_balancer`, `elastic_load_balancer`, `relational_database_service`, `dynamo_db_table`) filtered by `accessible_by[dt.entity.aws_credentials]` `[Source: docs/dql-patterns.md#6.2]`
  - [ ] For AWS non-built-in: separate DQL query for `CUSTOM_DEVICE` entities filtered by `cloud:aws` entity type prefix and `accessible_by[dt.entity.aws_credentials]` `[Source: docs/dql-patterns.md#6.3]`
  - [ ] For Azure: run batched `append` query across known classic entity types (`azure_vm`, `azure_vm_scale_set`, `azure_load_balancer`, `azure_event_hub_namespace`, `azure_event_hub`, `azure_redis_cache`, `azure_function_app`, `azure_storage_account`, `azure_cosmos_db`, `azure_web_app`, `azure_sql_server`, `azure_sql_database`) filtered by `accessible_by[dt.entity.azure_subscription]` `[Source: docs/dql-patterns.md#7.1]`
  - [ ] For Azure non-built-in: `CUSTOM_DEVICE` filtered by `cloud:azure` prefix and `accessible_by[dt.entity.azure_subscription]` `[Source: docs/dql-patterns.md#7.2]`
  - [ ] For GCP: `CUSTOM_DEVICE` filtered by `cloud:gcp` prefix and `project_id == accountId` `[Source: docs/dql-patterns.md#8.1]`
  - [ ] Implement metric key prefix query (see Task 3)
  - [ ] Re-trigger all queries when `accountId` or `provider` change (AC: #12)

- [ ] Task 3: Metric key count query (AC: #4, #7)
  - [ ] AWS: `fetch metric.series, from:now()-2h | filter startsWith(metric.key, "dt.cloud.aws.") OR startsWith(metric.key, "cloud.aws.") | summarize count()` — returns total count of distinct classic metric keys ingested in the last 2 hours `[Source: docs/dql-patterns.md#1.4]`
  - [ ] Azure: same approach with `dt.cloud.azure.` and `cloud.azure.microsoft_` patterns `[Source: docs/dql-patterns.md#2.3, docs/azure-classic.md#2.1]`
  - [ ] GCP: `cloud.gcp.` patterns `[Source: docs/gcp-classic.md#3.1]`
  - [ ] Consult `CLASSIC_METRIC_PREFIXES[provider]` from `utils/classicPatterns.ts` as the authoritative filter list — do not hardcode patterns in the hook
  - [ ] Note: no client-side prefix extraction needed — the hook returns a single integer count

- [ ] Task 4: Build `OverviewTab` component (`ui/app/components/OverviewTab.tsx`) (AC: #2–#7)
  - [ ] Props: `{ provider: CloudProvider; accountId: string; credentialEntityId: string | null; subscriptionEntityId: string | null }`
  - [ ] Sections: ENTITIES section (table) + CLASSIC METRIC KEYS section (count + Notebooks link)
  - [ ] Entities section: `DataTable` with columns: Entity Type (human-friendly label from `entityTypeLabels.ts`) and Count (sortable, descending by default). Zero-count rows hidden before render (AC: #2). Per-row drill-down action navigates to the appropriate Clouds App view for that entity type (AC: #3). `[Open Question #3: architect to determine Clouds App intent/URL per entity type]`
  - [ ] Empty state for entities (AC: #6): `EmptyState` when all queries return zero results
  - [ ] Metric keys section: display total count returned by hook as a prominent number (AC: #4); include a link/button that navigates to the Notebooks app with a pre-populated DQL query listing all classic metric keys for this account (AC: #5). `[Open Question #4: architect to determine Notebooks navigation API]`
  - [ ] Informational message when metric key count is 0 (AC: #7)

- [ ] Task 5: Register `OverviewTab` in `AccountDetail.tsx` (AC: #1, #2)
  - [ ] Import `OverviewTab` and replace the empty Overview `<Tab>` body introduced in Story 002
  - [ ] Change `defaultIndex` from `1` to `0`

- [ ] Task 6: Add `credentialEntityId` to route state (AC: #2, #3)  
  - [ ] Story 001 passes `accountId` (the cloud account string, e.g. `"444652832050"`) and `provider` via route state from the inventory row click. The entity queries need the Dynatrace **credential entity ID** (e.g. `AWS_CREDENTIALS-A4BE6E5B22DB0101`) for the `accessible_by` filter. Verify whether Story 001 already passes this; if not, add it to the `CloudAccount` type and route state. `[Source: ui/app/types/connection.ts]`

## Dev Notes

### Relevant Context
- Story 002 creates the tab frame with the Overview tab as an empty placeholder. `[Source: .github/stories/002-scan-dashboards-for-classic-dependencies.md#Architecture Notes §5]`
- Story 002 creates `ui/app/utils/classicPatterns.ts` with `CLASSIC_PATTERNS[provider].dqlMetricPrefixes` — use this as the source of truth for metric prefix filters, not hardcoded strings. `[Source: .github/stories/002-scan-dashboards-for-classic-dependencies.md#Architecture Notes §4]`
- DQL `append` is the only supported way to combine multiple entity type queries into one result set. `union` does not exist. `[Source: docs/dql-patterns.md#10.1]`
- The `accessible_by` approach for AWS is confirmed live on `ec2_instance` (240 results). It is **not available** on `ebs_volume`. For `aws_lambda_function`, the field exists in schema but was null in the test environment — treat as unconfirmed. `[Source: docs/dql-patterns.md#6 (preamble)]`
- The metric section shows the total count of distinct classic metric keys ingested in the last 2 hours. The hook returns `metricKeyCount: number`. No client-side prefix extraction is needed — the DQL query uses `summarize count()` after filtering to provider-classic key patterns.
- GCP classic entities use `project_id` as a direct string field — no relationship traversal needed. `[Source: docs/dql-patterns.md#8.1]`

### Platform Capabilities
- **`useDql` hook**: `@dynatrace-sdk/react-hooks` — use for all entity count and metric series queries. `[Source: AGENTS.md#DQL Data Fetching]`
- **`SingleValue`**: `@dynatrace/strato-components/charts` — props: `data` (number), `label` (string), `loading` (boolean). Native loading state handles skeleton rendering. `[Source: Strato component lookup — verified 2026-04-08]`
- **`ChipGroup`**, **`Chip`**: `@dynatrace/strato-components/content` — `ChipGroup` provides built-in expand/collapse of excess chips. `[Source: Strato component lookup]`
- **`SkeletonText`**: `@dynatrace/strato-components/content` — placeholder while metric prefix query loads. `[Source: Strato component lookup]`
- **`Flex`**: `@dynatrace/strato-components/layouts` — `flexWrap="wrap"` + `gap` for the entity tile grid. `[Source: Strato component lookup]`
- **`Heading`** (level 4): `@dynatrace/strato-components/typography` — section headers ("Entities", "Classic Metric Key Prefixes"). `[Source: Strato component lookup]`
- **`Surface`**: `@dynatrace/strato-components/layouts` — wraps the full tab content for visual separation. `[Source: Strato component lookup]`
- **`EmptyState`**: `@dynatrace/strato-components/content` — for the entities zero-result case. Size `'small'` (inside tab panel context). `[Source: Strato component lookup]`
- **`Tooltip`**, **`Button`**: `@dynatrace/strato-components/overlays` / `@dynatrace/strato-components/buttons` — for the disabled future catalog link.
- **No new scopes required**: all DQL queries use `storage:entities:read` and `storage:metrics:read`, both already in `app.config.json` from Story 001. `[Source: .github/stories/001-discover-cloud-account-inventory.md#Tasks Task 6]`

### DQL Query Patterns

**AWS entity count (built-in types, scoped to credential):**
```dql
fetch dt.entity.ec2_instance
| filter in("<AWS_CREDENTIALS-entityId>", accessible_by[`dt.entity.aws_credentials`])
| append [
    fetch dt.entity.ebs_volume
    | filter in("<AWS_CREDENTIALS-entityId>", accessible_by[`dt.entity.aws_credentials`])
  ]
| append [
    fetch dt.entity.aws_lambda_function
    | filter in("<AWS_CREDENTIALS-entityId>", accessible_by[`dt.entity.aws_credentials`])
  ]
-- ... (continue for each built-in type)
| summarize count(), by:{entity.type}
```
`[Source: docs/dql-patterns.md#6.2]`

**AWS non-built-in (custom devices), scoped to credential:**
```dql
fetch dt.entity.custom_device
| filter contains(toString(entity.type), "cloud:aws")
    AND in("<AWS_CREDENTIALS-entityId>", accessible_by[`dt.entity.aws_credentials`])
| summarize cnt=count(), by:{entity.type}
| sort cnt desc
```
`[Source: docs/dql-patterns.md#6.3]`

**GCP custom devices, scoped to project:**
```dql
fetch dt.entity.custom_device
| filter contains(toString(entity.type), "cloud:gcp")
    AND project_id == "<gcpProjectId>"
| summarize cnt=count(), by:{entity.type}
| sort cnt desc
```
`[Source: docs/dql-patterns.md#8.1]`

**Classic metric key count (AWS example):**
```dql
fetch metric.series, from:now()-2h
| filter startsWith(metric.key, "dt.cloud.aws.") OR startsWith(metric.key, "cloud.aws.")
| summarize count()
```
Returns the total count of distinct classic metric keys ingested in the last 2 hours for this provider. `[Source: docs/dql-patterns.md#1.4]`

### Data Considerations
- The entity count queries are independent of the dashboard scan — they run in parallel and do not block one another.
- For AWS built-in entities: the `accessible_by[dt.entity.aws_credentials]` field is confirmed on `ec2_instance` but **not on `ebs_volume`**. For `ebs_volume` and types where the relationship field is absent, fall back to an unscoped count: `fetch dt.entity.ebs_volume | summarize count()`. This slightly over-counts in multi-account environments but is acceptable for v1 scope indication. Document the fallback in code. `[Source: docs/dql-patterns.md#6 (preamble)]`
- The metric prefix query uses a 2-hour window (`from:now()-2h` is the default for `metric.series` — omit the explicit clause unless the default changes). Environments that have not ingested classic metrics recently will show the empty state — this is correct behaviour (if no data arrived in 2h, the connection may already be inactive).
- Entity count query result size: each built-in type query returns at most one summary row per `entity.type`. Non-built-in / custom device queries return one row per sub-type. Total rows per provider: AWS ~15–20, Azure ~20–25, GCP ~30–40. No pagination concern.
- Metric key prefix query: a single `metric.series` query may return thousands of distinct keys. The `summarize by:{metric.key}` collapses them to one row per key; client-side prefix extraction then collapses further to ~5–15 unique prefixes. Keep the DQL query lightweight — do not add `count()` unless needed.

### Technical Constraints
- No new OAuth scopes needed beyond what Story 001 added (`storage:entities:read`, `storage:metrics:read`). `[Source: app.config.json — verified]`
- `OverviewTab` props depend on `credentialEntityId` (the Dynatrace entity ID for the classic connection). Verify that Story 001's route state propagation includes this field. If not, Task 6 adds it. `[Source: ui/app/types/connection.ts]`
- `accessible_by` field availability varies by entity type. Missing field causes a DQL `FIELD_DOES_NOT_EXIST` error — the hook must handle this gracefully (ignore results for that type or fall back to unscoped count). `[Source: docs/dql-patterns.md#6 preamble]`

## Cloud Provider Considerations

This story implements the Overview tab for **all three providers simultaneously** (AWS, Azure, GCP) because the structure is identical — only the entity type lists and metric prefix patterns differ per provider. The `CLASSIC_PATTERNS` utility and the provider branching in the hook abstract these differences cleanly.

| Provider | Entity scoping mechanism | Entity types source |
|---|---|---|
| **AWS** | `accessible_by[dt.entity.aws_credentials]` + credential entity ID | Built-in: Section 4.1 of `docs/aws-classic.md`; Non-built-in: `cloud:aws:*` CUSTOM_DEVICE sub-types from Section 4.2 |
| **Azure** | `accessible_by[dt.entity.azure_subscription]` + subscription entity ID | Built-in: Section 4.1 of `docs/azure-classic.md`; Non-built-in: `cloud:azure:*` CUSTOM_DEVICE sub-types from Section 4.2 |
| **GCP** | `project_id == gcpProjectId` (direct field) | All `cloud:gcp:*` CUSTOM_DEVICE sub-types from `docs/gcp-classic.md#2.1` |

GCP is the most straightforward to scope — `project_id` is a direct property on all GCP custom device entities. No relationship traversal needed.

The "coming in future" catalog link is provider-agnostic — the placeholder is shown for all three.

## Dependencies

- **Story 001** — provides `CloudAccount` type with `credentialEntityId` (Dynatrace entity ID) and `provider` via route state. Task 6 verifies this and adds `credentialEntityId` if absent.
- **Story 002** — creates the tab frame (`AccountDetail.tsx` with four `<Tab>` elements); creates `utils/classicPatterns.ts` with `CLASSIC_PATTERNS`. This story overrides `defaultIndex` from `1` to `0`.

## Testing Guidance

> **Note**: Testing strategy is an open topic — details will be refined when the QA Testing agent is established.

- **Happy path (AWS)**: environment with EC2, Lambda, S3 classic entities → entity table rows shown sorted by count descending; metric key count displayed; Notebooks link navigates to pre-populated DQL
- **Edge case — Azure with null subscription UUID**: some legacy Azure credentials have `sub.azureSubscriptionUuid: null` — entity section shows graceful fallback or informational message
- **Edge case — provider with only non-built-in entities**: account where all entities are `CUSTOM_DEVICE` sub-types — table shows only those rows sortable by count
- **Edge case — GCP project with no recent metrics**: metric key count section shows zero/empty state; entity table still populates
- **Edge case — navigation between accounts**: switching from account A to account B clears Account A's data and triggers fresh queries; loading states appear for Account B
- **Edge case — Clouds App drill-down**: per-row action navigates to correct Clouds App context for both built-in entity types and `CUSTOM_DEVICE` sub-types

## Open Questions

1. **`accessible_by` on non-EC2 built-in AWS types**: Confirmed on `ec2_instance` (live). Unconfirmed on `ebs_volume`, `aws_lambda_function`, `auto_scaling_group`, etc. — must be verified in a live environment during implementation. If absent, the fallback is an unscoped count. `[Source: docs/dql-patterns.md#6 preamble]`
2. **Azure subscription entity ID vs UUID**: The route state from Story 001 includes `azureSubscriptionUuid` (the UUID). The `accessible_by` filter needs the Dynatrace entity ID (`AZURE_SUBSCRIPTION-*`). Verify whether Story 001 also passes the entity ID — if not, an extra DQL lookup is needed. `[Source: docs/dql-patterns.md#7.1]`
3. **Clouds App drill-down intent per entity type**: The Clouds App supports both classic and new connections. The specific intent or URL pattern needed to navigate to the correct Clouds App view per entity type (e.g. `EC2_INSTANCE` vs `cloud:aws:s3`) is unknown — architect to investigate available Clouds App intents or navigation APIs per classic entity type and `CUSTOM_DEVICE` subtype. `[Source: AC #3]`
4. **Notebooks deep-link mechanism**: Does the Dynatrace Notebooks app support URL-based or intent-based pre-population of a DQL query? Architect to verify the correct navigation API (e.g. `openDocument`, an intent, or a URL parameter) before implementing AC #5. `[Source: AC #5]`

## Out of Scope

- Readiness scoring, blocker/warning classification — Story 006
- Drill-down to individual entity details beyond what the Clouds App row link provides
- Per-account metric time series volume or DDU consumption
- New connection entities (Smartscape on Grail) — this overview covers only **classic** entities
- Entity health status, anomaly counts, or alerting context — out of scope for v1

## UX Specification

*Added by UX Reviewer — v1.2, written against revised acceptance criteria.*

### User Flow

1. **Entry**: User clicks a classic account row in the Inventory page → navigates to Account Detail page
2. **Default landing**: Overview tab (index 0) is the active tab
3. **Loading state**: Both sections load in parallel. The entity table shows the `DataTable` loading skeleton; the metric count shows a `SingleValue` loading skeleton
4. **Data loaded — entities**: Table rows appear, one per entity type with a non-zero count, sorted by count descending. Each row has a "View in Clouds App" action button
5. **Data loaded — metric count**: `SingleValue` displays the total integer count; an "Explore in Notebooks" button appears below it
6. **Drill-down**: User clicks "View in Clouds App" on an entity row → navigates to the appropriate Clouds App view for that entity type and account. Mechanism TBD by architect [Open Question #3]
7. **Notebooks**: User clicks "Explore in Notebooks" → navigates to the Notebooks app with a pre-populated DQL query. Mechanism TBD by architect [Open Question #4]
8. **Empty — entities**: `DataTable.EmptyState` renders inside the table when all counts are zero
9. **Empty — metric count**: Inline `Text` replaces the `SingleValue` if the count is zero
10. **Error**: Each section fails independently — inline error message + Retry button per section
11. **Account switch**: Both sections revert to loading state; previously loaded data is discarded

### Component Specifications

#### Section: Classic Entities

##### DataTable

- **Import**: `import { DataTable, type DataTableColumnDef } from '@dynatrace/strato-components/tables'`
- **Key Props**:
  - `data`: `EntityTypeSummary[]` — zero-count rows filtered out **before** passing to the table (not inside column rendering)
  - `columns`: memoized `DataTableColumnDef[]` (see below)
  - `sortable`: `true`
  - `defaultSortBy`: `[{ id: 'count', desc: true }]` — count descending on first render (AC #2)
  - `loading`: `boolean` — `entityLoading` from hook; shows built-in skeleton rows
  - `fullWidth`: `true`
- **Columns** (memoized):
  1. `id: 'entityType'`, `header: 'Entity Type'`, `accessor: 'entityType'` — cell renders the human-friendly label via `entityTypeLabel(row.entityType)` helper function (see below)
  2. `id: 'count'`, `header: 'Count'`, `accessor: 'count'`, `columnType: 'number'`, `sortDescFirst: true`
- **Row Actions**: `DataTable.RowActions` slot — one `Button` per row, `variant="default"`, labeled "View in Clouds App". Include a `Button.Prefix` with an external-link icon. The button's `onClick` or navigation target is left to the architect [Open Question #3]
- **Empty State**: `DataTable.EmptyState` child slot:
  ```tsx
  <DataTable.EmptyState>
    No classic entities detected for this account.
  </DataTable.EmptyState>
  ```
- **Error State**: Shown **instead of** the table (conditional render, not a table slot):
  ```tsx
  <Flex gap={8} flexDirection="column" alignItems="flex-start">
    <Text>Could not load entity data. Check your permissions or try again.</Text>
    <Button variant="default" onClick={refetchEntities}>Retry</Button>
  </Flex>
  ```

##### Entity Type Label Helper

- **Location**: `ui/app/utils/entityTypeLabels.ts` — pure `Record<string, string>` lookup with a fallback function
- **Format**: Plural nouns, title-cased — e.g. `'ec2_instance' → 'EC2 Instances'`, `'azure_vm' → 'Virtual Machines'`, `'cloud:gcp:gce_instance' → 'GCE Instances'`
- **Fallback**: Strip `cloud:aws:` / `cloud:azure:` / `cloud:gcp:` prefix, replace `_` and `:` with spaces, title-case — raw strings must never reach the rendered table

#### Section: Classic Metric Keys

##### SingleValue (metric count)

- **Import**: `import { SingleValue } from '@dynatrace/strato-components/charts'`
- **Key Props**:
  - `data`: `metricKeyCount` — the total integer returned by the hook
  - `label`: `"Classic metric keys actively ingested (last 2 hours)"`
  - `loading`: `boolean` — `metricLoading` from hook; shows built-in skeleton
- **Sizing**: Wrap in a fixed-width container (~200px); it should not stretch to fill the tab width — this is a single-number KPI, not a chart filling a panel
- **Visibility**: Always rendered while loading or when count > 0. Replaced by the empty state text when count === 0 and loading is false

##### "Explore in Notebooks" Button

- **Import**: `import { Button } from '@dynatrace/strato-components/buttons'`
- **Placement**: Directly below the `SingleValue`, vertically stacked in a `Flex` column
- **Label**: `"Explore in Notebooks"`
- **Props**: `variant="emphasized"` — this is the primary call-to-action in this section
- **Visibility**: Rendered only when `metricKeyCount > 0` and `metricLoading === false`. The architect will determine how the Notebooks navigation is triggered [Open Question #4]

##### Metric Count Empty State

- **Component**: `Text` from `@dynatrace/strato-components/typography` — inline, no `EmptyState` component needed
- **Content**: `"No classic metric keys detected in recent data (last 2 hours)."`
- **Shown when**: `metricKeyCount === 0` and `metricLoading === false`

##### Metric Count Error State

- Inline error + retry, replacing the `SingleValue` and button:
  ```tsx
  <Flex gap={8} flexDirection="column" alignItems="flex-start">
    <Text>Could not load metric key data. Try again.</Text>
    <Button variant="default" onClick={refetchMetrics}>Retry</Button>
  </Flex>
  ```

### Information Hierarchy

1. **Classic Entities table** — answers "how much classic infrastructure does this account have?" Most impactful types sort to the top automatically
2. **Classic Metric Keys count + Notebooks link** — confirms the connection is actively ingesting; provides a path to explore the full key list

### Empty States

| Scenario | Location | Component | Message |
|---|---|---|---|
| All entity counts are zero | Inside DataTable | `DataTable.EmptyState` | "No classic entities detected for this account." |
| Metric key count is zero | Below section heading | `Text` (inline) | "No classic metric keys detected in recent data (last 2 hours)." |
| Both sections simultaneously empty | Both | Independent per section | — |

### Error Handling

| Scenario | Message | Recovery |
|---|---|---|
| Entity DQL query fails | "Could not load entity data. Check your permissions or try again." | Retry button — `refetchEntities` |
| Metric key DQL query fails | "Could not load metric key data. Try again." | Retry button — `refetchMetrics` |
| Both fail | Each section shows its own error independently | Two Retry buttons — one per section |

### Migration Journey Context

- **Comes from**: Inventory page — user clicked a classic account row
- **Purpose**: Scope orientation before dependency analysis. The entity counts and metric key total let the admin mentally calibrate the migration effort before they open the Dashboards, Metric Events, or SLOs tabs
- **Leads to**: The other three dependency tabs — entity counts and metric footprint inform how large the blast radius scan results are likely to be

---

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-04-08 | 1.0 | Initial draft | Story Writer |
| 2026-04-08 | 1.1 | UX Specification added (component verification, error states, label formatting, show/hide placement, orientation intro, 3 component corrections) | UX Reviewer |
| 2026-04-08 | 1.2 | Acceptance criteria simplified: DataTable for entities, total metric key count, Clouds App drill-down per entity type, Notebooks deep-link for metric exploration; removed disabled catalog placeholder; UX spec superseded pending revision | Story Writer |
| 2026-04-08 | 1.3 | UX Specification rewritten against v1.2 AC: DataTable for entities (two columns, sortable, row action per row, built-in empty/loading states), SingleValue for metric key count, "Explore in Notebooks" button; removed tile grid, show/hide toggle, ChipGroup, disabled catalog link | UX Reviewer |
