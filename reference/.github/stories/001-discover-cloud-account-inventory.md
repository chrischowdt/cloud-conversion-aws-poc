# User Story: Discover Cloud Account Inventory

**Status**: Done
**Last Updated**: 2026-04-09
**Category**: Discovery
**Migration Phase**: Prepare

## Story Statement

**As a** Dynatrace Administrator,
**I want** to see all cloud accounts monitored in my environment — across AWS, Azure, and GCP — with a clear indicator of whether each account is using the classic connection, the new connection, or both in parallel, with transparent query scoping and an early warning when a migration path is currently blocked,
**so that** I can identify which accounts are candidates for migration, understand the data recency of what I'm seeing, and know which accounts need to wait for platform support before proceeding.

## Context

Before a migration assessment can begin, the user needs to know what cloud connections exist in the environment and their current state. The app's Inventory capability answers the question "What cloud connections do I have?" and is the entry point for all subsequent discovery and assessment work. Every other story in this app depends on a user first selecting an account from this view.

The classic and new connection systems use entirely different entity models — classic connections create `aws_credentials`/`azure_credentials`/`cloud:gcp:project` entities in Cassandra, while new connections create **Smartscape on Grail** entities (queryable via `smartscapeNodes`). Both must be queried independently and merged by account ID to produce the status badge. `[Source: .github/prompts/vision.prompt.md#Capabilities]`

The Smartscape-based approach is preferred over metric-series detection because Smartscape pollers run **independently of metric polling** — new connection entities exist even when metric ingest is disabled or no metrics have arrived yet in the query window. `[Source: docs/aws-new.md#8.6]`

## Acceptance Criteria

1. **Given** the user opens the app, **when** the inventory page loads, **then** they see a list of all cloud accounts across AWS, Azure, and GCP — each row showing: cloud provider, connection name, account/subscription/project ID, and a status badge.

2. **Given** a Dynatrace environment with active classic connections, **when** the inventory loads, **then** all AWS accounts (`aws_credentials` entities), Azure credentials (with resolved subscription UUID), and active GCP projects appear with a **Classic** status badge.

3. **Given** a Dynatrace environment with new cloud connections (DA consumer enabled), **when** the inventory loads, **then** those accounts appear with a **New** status badge — detected via Smartscape entities: `AWS_ACCOUNT` for AWS, `AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS` for Azure, and `GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT` for GCP.

4. **Given** an account that has both classic entities AND active new connection metric traffic, **when** it appears in the list, **then** its status badge reads **Parallel** (running simultaneously — a transitional state).

5. **Given** an environment with no cloud connections at all, **when** the inventory loads, **then** an empty state is shown explaining that no cloud connections were detected, with a link to the Dynatrace Clouds app.

6. **Given** the inventory is loaded, **when** the user clicks an account row, **then** they are navigated to the dependency analysis view for that account (placeholder route is acceptable; full content is Story 002+).

7. **Given** the inventory is loaded, **when** the user views the page heading, **then** a line below the heading reads "Showing connections active in the last [N]" (where N is the currently selected time window), with an info icon that opens a tooltip explaining the staleness-filter semantics.

8. **Given** the inventory is loaded, **when** the user selects a different time window from the toolbar selector (12h / 24h / 7d / 30d), **then** all seven DQL queries re-execute with the new window and the heading label updates to reflect the new period. The default is **12h**.

9. **Given** a classic AWS account in the inventory has active AWS CloudWatch Metric Streams traffic within the selected time window, **when** its row is displayed, **then** a `WarningIcon` appears next to the status badge with a tooltip reading: *"Migration currently blocked: AWS CloudWatch Metric Streams is not yet supported by the new AWS connection. Classic polling services on this account (built-in, cloud services) can still be migrated independently."*

10. **Given** no Metric Streams traffic is found for an account within the selected time window (e.g. Firehose paused, infrequent traffic, or no Metric Streams configured), **when** its row is displayed, **then** no `WarningIcon` appears — the flag is shown only when positive evidence is found within the window.

## Tasks / Subtasks

- [x] Task 1: Enumerate classic connections via DQL for all three providers (AC: #2)
  - [x] AWS: `fetch dt.entity.aws_credentials` — extract `awsAccountId`, `entity.name`, `id` `[Source: docs/dql-patterns.md#11.1]`
  - [x] Azure: `fetch dt.entity.azure_credentials` with inline subscription UUID lookup `[Source: docs/dql-patterns.md#11.2]`
  - [x] GCP: `fetch dt.entity.cloud:gcp:project` with `lifetime` filter to exclude stale projects `[Source: docs/dql-patterns.md#11.3]` — Grail applies the `from:` timeframe against the entity lifetime field automatically; no explicit pipeline filter needed

- [x] Task 2: Detect new connections via Smartscape entity queries (AC: #3)
  - [x] AWS: `smartscapeNodes AWS_ACCOUNT | fields id, name, aws.account.id` — join on `aws.account.id` ↔ `awsAccountId` `[Source: docs/dql-patterns.md#12.1]`
  - [x] Azure: `smartscapeNodes AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS | fields id, name, azure.subscription` — join on `azure.subscription` ↔ `sub.azureSubscriptionUuid` `[Source: docs/dql-patterns.md#12.2]`
  - [x] GCP: `smartscapeNodes GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT | fields id, name, gcp.project.id` — join on `gcp.project.id` ↔ `entity.name` from classic; **use `gcp.project.id` not `name`** (`name` is display name) `[Source: docs/dql-patterns.md#12.3]`

- [x] Task 3: Merge classic + new results by account ID and compute status badge (AC: #1, #4)
  - [x] Classic-only → **Classic**
  - [x] New-only → **New**
  - [x] Both → **Parallel**

- [x] Task 4: Implement the inventory page UI (AC: #1, #5, #6)
  - [x] Table with columns: Provider, Name, Account ID, Status
  - [x] Loading state while DQL queries run
  - [x] Empty state message + Clouds app link
  - [x] Row click navigates to per-account dependency view (placeholder route)

- [x] Task 5: Add route and nav entry (AC: #1)
  - [x] Add `/inventory` route in `ui/app/App.tsx`
  - [x] Add nav link in `ui/app/components/Header.tsx`

- [x] Task 6: Verify scopes in `app.config.json` (AC: #2, #3)
  - [x] `storage:entities:read` — covers `fetch dt.entity.*` classic connection queries ✅ already present
  - [x] `storage:smartscape:read` — required for `smartscapeNodes` new connection queries ✅ added in this commit
  - [x] `storage:metrics:read` — required for the Metric Streams detection query (`fetch metric.series`) ✅ already present

- [x] Task 7: Add user-configurable timeframe selector (AC: #7, #8)
  - [x] Add `InventoryTimeframe` type to `ui/app/types/connection.ts` (`'12h' | '24h' | '7d' | '30d'`)
  - [x] Refactor `useCloudAccountInventory` to accept `timeframe: InventoryTimeframe = '12h'` parameter
  - [x] Move all 6 query strings from module-level `const` to `useMemo` inside the hook (stable reference; re-executes when timeframe changes)
  - [x] Add timeframe `Select` to `DataTable.TableActions` toolbar in `Inventory.tsx`
  - [x] Add timeframe label + `InformationIcon` tooltip below the page heading in `Inventory.tsx`

- [x] Task 8: Detect AWS Metric Streams and flag migration-blocked rows (AC: #9, #10)
  - [x] Add 7th `useDql` call in hook: `fetch metric.series, from:now()-${timeframe} | filter dt.source == "AWS Metric Streams" | summarize cnt=count(), by:\`aws.account.id\`` — verified `aws.account.id` is a valid dimension on `metric.series` via `dtctl` (2026-04-09)
  - [x] Add `isMigrationBlocked: boolean` to `CloudAccount` type
  - [x] In hook, build `metricStreamsAccountIds: Set<string>` from 7th query results
  - [x] Set `isMigrationBlocked: true` on AWS Classic/Parallel rows whose `accountId` appears in the set; all other rows receive `false`
  - [x] In `Inventory.tsx` Status cell: render `WarningIcon` + `Tooltip` next to `StatusBadge` when `rowData.isMigrationBlocked === true`
  - [x] The 7th query failure is treated as empty set (safe default: blocked indicator omitted if no positive evidence)

## Dev Notes

### Relevant Context
- This page is the **app entry point** — the `Home.tsx` welcome page currently serves this role but should be replaced or redirected to this inventory view. `[Source: ui/app/App.tsx]`
- Classic connection enumeration patterns (all three providers) verified against `gmg` environment. `[Source: docs/dql-patterns.md#11]`
- New connection Smartscape enumeration patterns verified live against `gdq-dev` environment (2026-04-07). `[Source: docs/dql-patterns.md#12]`

### Platform Capabilities
- DQL entity queries via `useDql` hook from `@dynatrace-sdk/react-hooks` `[Source: AGENTS.md#DQL Data Fetching]`
- Classic AWS: one query returns all accounts — `awsAccountId` is a direct string field on the entity `[Source: docs/dql-patterns.md#11.1]`
- Classic Azure: requires an inline `lookup` join to resolve subscription UUID from the credential entity's `belongs_to` map. Some legacy credentials may have `sub.azureSubscriptionUuid: null` — these are valid and must not be filtered out `[Source: docs/dql-patterns.md#11.2]`
- Classic GCP: entity type must be backtick-quoted in `fetch` (`dt.entity.cloud:gcp:project`). `entity.name` IS the GCP project ID. Apply the `lifetime` filter to exclude stale stopped projects `[Source: docs/dql-patterns.md#11.3]`
- New connections — detected via **Smartscape entity queries** (`smartscapeNodes`). Smartscape pollers run independently of metric polling; entities exist even when metric ingest is disabled. Scope: `storage:smartscape:read`. `[Source: docs/dql-patterns.md#12]`
- AWS Metric Streams detection — `dt.source == "AWS Metric Streams"` on `metric.series` records is the discriminator. `aws.account.id` is a confirmed dimension on these records (dtctl-verified 2026-04-09 against `gmg`). Scope: `storage:metrics:read`. `[Source: docs/dql-patterns.md#1.3]`
- AWS: `smartscapeNodes AWS_ACCOUNT | fields id, name, aws.account.id` — `aws.account.id` is the numeric account string; `name` is the AWS account alias. ✅🟢 `[Source: docs/dql-patterns.md#12.1]`
- Azure: `smartscapeNodes AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS | fields id, name, azure.subscription` — `azure.subscription` is the UUID; `name` is the subscription display name. ✅🟢 `[Source: docs/dql-patterns.md#12.2]`
- GCP: `smartscapeNodes GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT | fields id, name, gcp.project.id` — `gcp.project.id` is the slug (join key); `name` is the **display name, not the slug** — do not use `name` as a join key. ✅🟢 `[Source: docs/dql-patterns.md#12.3]`

### Data Considerations
- Classic and new connections represent **separate entity systems** with no shared entity IDs — account-level IDs (AWS account number, Azure subscription UUID, GCP project ID) are the only join keys. `[Source: .github/prompts/vision.prompt.md#Domain Knowledge]`
- Multiple classic credentials can share the same AWS account ID (edge case — flag in UI rather than de-duplicate silently)
- Smartscape entities have a **35-day default retention period** in Grail storage. `from:` is valid and controls the last-modified window (entities not updated within the window are excluded). Without `from:`, DQL applies the global default timeframe of 2 hours. The default 12-hour window is intentional to capture recently-modified accounts; users can widen it via the timeframe selector.
- AWS Metric Streams: Metric Streams is not yet supported by the new AWS connection. The migration path for accounts using Metric Streams is partially blocked at the platform level. The `isMigrationBlocked` flag is based on evidence within the selected time window — a paused or infrequent Firehose may produce a false negative.

### Technical Constraints
- The app is **read-only** — no writes to any Dynatrace API `[Source: .github/prompts/vision.prompt.md#Constraints]`
- Azure classic connections use the legacy Config API (`/api/config/v1/azure/credentials`) for configuration, but `dt.entity.azure_credentials` DQL entities are the reliable enumeration path — no Config API call needed for this story `[Source: docs/azure-classic.md#1.1]`
- GCP classic has no settings schema at all — DQL entity enumeration is the only detection method `[Source: docs/gcp-classic.md#1.1]`

## UX Specification (Added by UX Reviewer)

### User Flow

1. User opens the app (or navigates to `/inventory`)
2. The inventory page renders immediately with the `DataTable` shell showing column headers and a loading skeleton (`loading={true}`)
3. All seven DQL queries fire in parallel — three classic entity queries, three Smartscape new-connection queries, and the AWS Metric Streams detection query
4. As the merge completes, the `loading` prop is set to `false` and the table populates
5. If the merged result is empty (zero rows), a full-page `EmptyState` replaces the table
6. User scans the table — sorts by Status or Provider as needed; accounts with a `WarningIcon` next to their status badge are currently migration-blocked
7. User optionally changes the time window via the toolbar `Select` (12h / 24h / 7d / 30d) — all 7 queries re-execute and the heading label updates
8. User clicks the **Name** cell link for an account of interest → navigates to the dependency analysis view (`/inventory/:accountId`) carrying the `provider`, `accountId`, and `connectionName` as route state

### Component Specifications

#### Inventory Table

- **Strato Component**: `DataTable` from `@dynatrace/strato-components/tables`
- **Purpose**: Primary view of all cloud accounts — sortable, filterable, shows loading skeleton while queries run
- **Key Props**:
  - `data`: `CloudAccount[]` — memoized merged result array
  - `columns`: `DataTableColumnDef<CloudAccount>[]` — memoized column definitions (see below)
  - `loading`: `boolean` — `true` while any DQL query is still in-flight
  - `sortable`: `true` — lets users sort by Provider, Name, or Status
  - `resizable`: `true` — large environments benefit from adjustable column widths
  - `interactiveRows`: `true` — row highlighting on hover/focus (visual affordance only — NOT used for navigation; see Row Navigation below)
  - `fullWidth`: `true`
- **States**:
  - Loading: `loading={true}` — DataTable renders column headers with a skeleton overlay automatically; no separate spinner needed
  - Populated: normal table with rows
  - Empty (post-load, no data): `<DataTable.EmptyState>` child is shown (see Empty State section)
- **Use Case Reference**: `LoadingStateInitial`, `InteractiveRowsUncontrolled`, `EmptyState`

##### Column Definitions

| Column | `id` | `header` | Cell render | Notes |
|--------|------|----------|-------------|---------|
| Provider | `provider` | `Provider` | Plain text: `AWS` / `Azure` / `GCP` | Sort enabled; consider a fixed width (~90px) — values are short |
| Name | `name` | `Connection Name` | `<Link to={/inventory/${row.accountId}}>{value}</Link>` | Navigation cell — see Row Navigation |
| Account ID | `accountId` | `Account / Subscription / Project ID` | `<DataTable.DefaultCell fontStyle="code">{value}</DataTable.DefaultCell>` | Monospace, IDs are hex/numeric |
| Status | `status` | `Status` | `<StatusBadge status={value} />` + optional `WarningIcon` (see Blocked Indicator below) | Sort enabled — users want to group Classic vs. New |

> **Duplicate AWS account ID flag**: When two rows share the same `accountId`, render the Account ID cell with a `Tooltip` containing the text: *"Multiple credentials share this account ID. Review your AWS connection configuration."* Use a warning icon suffix inside the cell next to the ID text.

##### Toolbar

The toolbar contains two controls:

```tsx
<DataTable ...>
  <DataTable.TableActions>
    {/* Provider filter: Select with multi-select — AWS / Azure / GCP */}
    {/* Time window: Select single — Last 12 hours / Last 24 hours / Last 7 days / Last 30 days */}
  </DataTable.TableActions>
</DataTable>
```

No `DataTable.Toolbar` (LineWrap / ColumnOrderSettings / DownloadData) — this is a structured navigation list, not a data-analysis table.

##### Timeframe Display (above table)

A single line below the page heading communicates the active time window:

```tsx
<Flex flexDirection="row" alignItems="baseline" gap={8}>
  <Heading>Cloud Account Inventory</Heading>
  <Tooltip text={TIMEFRAME_TOOLTIP}>
    <Flex flexDirection="row" alignItems="center" gap={4} as="span">
      <Text color="neutral">Showing connections active in the {TIMEFRAME_LABELS[timeframe]}</Text>
      <InformationIcon />
    </Flex>
  </Tooltip>
</Flex>
```

**Tooltip text** (stored as `TIMEFRAME_TOOLTIP` constant):
> "Controls how far back the query scans for active connections. Active connections update their entity records continuously and always appear regardless of age. A shorter window may exclude connections that have been inactive for longer than the chosen period. The same window applies to AWS Metric Streams detection — if a Firehose was paused for longer than this period, the blocked indicator will not appear for that account even if Metric Streams was previously active."

---

#### Migration Blocked Indicator

- **When shown**: Row has `isMigrationBlocked === true` (AWS Classic/Parallel only)
- **Pattern**: `WarningIcon` with `Tooltip` placed next to `StatusBadge` inside the Status cell
- **Tooltip text**: *"Migration currently blocked: AWS CloudWatch Metric Streams is not yet supported by the new AWS connection. Classic polling services on this account (built-in, cloud services) can still be migrated independently."*
- **When NOT shown**: `isMigrationBlocked === false` (no evidence in window, Azure/GCP rows, New-only rows)

```tsx
cell: ({ value, rowData }) => (
  <DataTable.DefaultCell>
    <Flex flexDirection="row" alignItems="center" gap={4}>
      <StatusBadge status={value as ConnectionStatus} />
      {rowData.isMigrationBlocked && (
        <Tooltip text="Migration currently blocked: AWS CloudWatch Metric Streams is not yet supported by the new AWS connection. Classic polling services on this account (built-in, cloud services) can still be migrated independently.">
          <WarningIcon />
        </Tooltip>
      )}
    </Flex>
  </DataTable.DefaultCell>
),
```

---

#### Status Badge

- **Strato Component**: `Chip` from `@dynatrace/strato-components/content`
- **Purpose**: Compact, color-coded label communicating the connection lifecycle state at a glance
- **Import**: `import { Chip } from '@dynatrace/strato-components/content';`
- **Key Props**:
  - `color`: mapped from status (see table below)
  - `variant`: `'emphasized'` (default) — filled chip; high visual contrast for status scanning
  - `size`: `'condensed'` — table rows are dense; condensed keeps row height comfortable

| Status value | `color` prop | Semantic meaning |
|---|---|---|
| `Classic` | `'warning'` | Legacy connection — migration action required |
| `New` | `'success'` | New-stack connection — no classic dependency |
| `Parallel` | `'primary'` | Both connections active — transitional migration state |

**Render pattern** (custom `StatusBadge` component):
```tsx
import { Chip } from '@dynatrace/strato-components/content';

type ConnectionStatus = 'Classic' | 'New' | 'Parallel';

const statusColorMap: Record<ConnectionStatus, 'warning' | 'success' | 'primary'> = {
  Classic: 'warning',
  New: 'success',
  Parallel: 'primary',
};

export const StatusBadge = ({ status }: { status: ConnectionStatus }) => (
  <Chip color={statusColorMap[status]} size="condensed">
    {status}
  </Chip>
);
```

---

#### Row Navigation

- **Pattern**: `Link` in the **Name cell** — NOT `interactiveRows.link`
- **Why**: The experience standard explicitly prohibits row-click navigation to different pages via `interactiveRows`. Context-switching navigation (loading a new route) must use `Link` or `ExternalLink` in a table cell.
- **`interactiveRows={true}`** is still set on the table for row highlighting (hover/focus affordance), but `onActiveRowChange` is NOT used for navigation.
- **Link target**: `/inventory/:accountId` — pass `{ provider, connectionName, status }` as router state so the dependency view page doesn't need to re-fetch account metadata
- **Keyboard**: Native `Link` component handles Tab + Enter navigation without additional wiring

```tsx
// In the Name column definition:
cell: ({ value, rowData }) => (
  <DataTable.DefaultCell>
    <Link to={`/inventory/${rowData.accountId}`} state={{ provider: rowData.provider, status: rowData.status }}>
      {value}
    </Link>
  </DataTable.DefaultCell>
),
```

---

#### Empty State — No Cloud Connections Detected

- **Strato Component**: `EmptyState` from `@dynatrace/strato-components/content`
- **When shown**: After all six DQL queries have completed and the merged result is empty (zero rows)
- **Important**: Do NOT show `DataTable.EmptyState` here — render a full-page `EmptyState` above/instead of the table, since there is no table to show

**Structure**:
```tsx
<EmptyState>
  <EmptyState.VisualPreset context="table" />
  <EmptyState.Title>No cloud connections found</EmptyState.Title>
  <EmptyState.Details>
    No AWS, Azure, or GCP connections were detected in this environment.
    Classic and new connections are both checked automatically.
  </EmptyState.Details>
  <EmptyState.Actions>
    <ExternalLink href="https://www.dynatrace.com/hub/detail/clouds/">
      Set up a connection in the Clouds app
    </ExternalLink>
  </EmptyState.Actions>
</EmptyState>
```

> `ExternalLink` opens in a new tab — appropriate since the Clouds app is a separate Dynatrace app.

---

#### DQL Error State

- **Strato Component**: `DataTable.EmptyState` as fallback inside the table, OR an inline `MessageContainer` (from `@dynatrace/strato-components-preview/content`) above the table
- **When shown**: If one or more DQL queries return an error
- **Behavior**: Show partial results for any queries that **did** succeed; display a warning banner above the table for the failed provider(s)
- **Banner text example**: *"Could not load Azure connections. Results may be incomplete."* — `MessageContainer` with `variant="warning"`
- **Do NOT**: Block the entire inventory for a single-provider DQL failure

---

### Information Hierarchy

The user's primary scan task is: "Which accounts are Classic and need migration work?"

1. **Status column** — sort descending by status (`Classic` → `Parallel` → `New`) as the default sort so migration targets appear first
2. **Provider column** — filter controls let users scope to one provider
3. **Name column** — the navigation target; link text should be the human-readable credential name
4. **Account ID column** — secondary identifier, code-formatted; useful for cross-referencing cloud console

**Recommended default sort**: `status` ascending in this order: `Classic`, `Parallel`, `New` — puts accounts needing the most attention at the top.

---

### Empty States Summary

| Scenario | Component | Title | Action |
|---|---|---|---|
| No connections in environment | `EmptyState` (full page, replaces table) | "No cloud connections found" | Link to Dynatrace Clouds app |
| No results after provider filter | `DataTable.EmptyState` (inside table) | "No connections match the selected filter" | Clear filter button |
| DQL query error (partial) | `MessageContainer` warning banner above table | "Could not load [Provider] connections" | Retry button (re-triggers the failed query) |

---

### Migration Journey Context

This page is the **entry point** to the entire migration journey. It answers *"What do I have?"* before any dependency or readiness analysis begins. Every subsequent story (dependency analysis, readiness scoring) requires a user to first select an account here.

- **Comes before**: Nothing — this IS the starting point (Phase: Prepare)
- **Leads to**: Story 002+ — per-account dependency analysis (`/inventory/:accountId`)
- **Next step affordance**: The Name cell `Link` is the primary call to action; no additional CTA button is needed at this stage since the app is read-only

---

## Cloud Provider Considerations

All three providers are in scope. Provider-specific detection patterns differ but the status badge logic (Classic / New / Parallel) is identical across providers.

| Provider | Classic Detection | New Connection Detection | Account ID Field |
|---|---|---|---|
| **AWS** | `dt.entity.aws_credentials` → `awsAccountId` | `smartscapeNodes AWS_ACCOUNT` → `aws.account.id` | AWS account number (numeric string) |
| **Azure** | `dt.entity.azure_credentials` → inline `lookup` → `sub.azureSubscriptionUuid` | `smartscapeNodes AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS` → `azure.subscription` | Azure subscription UUID |
| **GCP** | `dt.entity.cloud:gcp:project` → `entity.name` | `smartscapeNodes GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT` → `gcp.project.id` ✅🟢 | GCP project ID (string slug) |

The Smartscape approach removes the metric time-window dependency present in the previous metric-series approach. New connection entities exist as long as the DA consumer is configured — even if metric polling is disabled. All three `smartscapeNodes` patterns are verified live against `gdq-dev` (2026-04-07). `[Source: docs/dql-patterns.md#12]`

The implementation must be structured so that adding a new provider requires only adding a new detection module — no changes to the merge or display logic.

## Dependencies

- None — this is the entry-point story for the entire app.

## Testing Guidance

- Happy path: environment with all three providers, mix of classic-only, new-only, and parallel accounts
- Edge case: Azure credential with no linked subscription (`sub.azureSubscriptionUuid: null`) — should appear with a `—` in the account ID column, not throw an error
- Edge case: multiple classic AWS credentials for the same account ID — both should appear
- Edge case: GCP project with an expired `lifetime` — should NOT appear in the list
- Metric Streams blocked flag: AWS account with Metric Streams traffic in window → `isMigrationBlocked: true`, `WarningIcon` visible in Status cell
- Metric Streams blocked flag: AWS account with no Metric Streams traffic → `isMigrationBlocked: false`, no `WarningIcon`
- Metric Streams blocked flag: 7th query failure → treated as empty set, no accounts flagged
- Timeframe selector: default of `12h` shown in heading label and applied to all 7 queries
- Timeframe selector: changing to `7d` re-executes all 7 queries with `from:now()-7d`
- Timeframe "omit if no evidence" edge case: Firehose paused for 16h, window = 12h → no blocked flag (acceptable; user can switch to 24h window)

---

## Architecture Notes
*Added by architect agent — 2026-04-07*

### 1. Files to Create or Modify

#### Files to CREATE (all four directories are currently empty)

| File | Purpose | Template |
|------|---------|----------|
| `ui/app/types/connection.ts` | `CloudAccount`, `CloudProvider`, `ConnectionStatus`, `InventoryTimeframe`, plus `AwsInventory`, `AzureInventory`, `GcpInventory`, `MigrationStatus`, `EnvironmentLifecyclePhase` | No existing template — define from Home.tsx import surface |
| `ui/app/utils/migrationStatus.ts` | `deriveMigrationStatus()`, `getMostAdvancedStatus()` | No existing template |
| `ui/app/hooks/useConnectionInventory.ts` | `useCloudAccountInventory(timeframe)` hook — 7× `useDql`, merge, `isMigrationBlocked` annotation, return per-provider + flat list | Follow `useDql` pattern from `ui/app/pages/Data.tsx` |
| `ui/app/pages/Inventory.tsx` | DataTable inventory view with timeframe selector and blocked row indicator | Follow structure of `ui/app/pages/Data.tsx` |
| `ui/app/components/StatusBadge.tsx` | `Chip`-based status badge (Classic/New/Parallel) | Pattern given verbatim in UX Specification above |

> **Blocker**: `ui/app/pages/Home.tsx` already imports from `../hooks/useConnectionInventory`, `../types/connection`, and `../utils/migrationStatus`. These files must be created before the project will compile. Creating them is prerequisite to any other work in this story.

#### Files to MODIFY

| File | Change |
|------|--------|
| `ui/app/App.tsx` | Add `<Route path="/inventory" element={<Inventory />} />` and `<Route path="/inventory/:accountId" element={<div />} />` (placeholder) |
| `ui/app/components/Header.tsx` | Add `Cloud Accounts` nav item linking to `/inventory` |

#### Files NOT to touch

| File | Reason |
|------|--------|
| `app.config.json` | Both required scopes (`storage:entities:read`, `storage:metrics:read`) are already present — verified below |
| `ui/app/pages/Home.tsx` | Already fully written; it is a consumer of the hook, not a file for this story |
| `ui/app/pages/Data.tsx` | Unrelated; kept as DQL usage reference only |

---

### 2. `useCloudAccountInventory` Return Shape

`Home.tsx` is already written and expects the **per-provider** shape:

```ts
const { aws, azure, gcp, refetch } = useCloudAccountInventory();
// aws.data: AwsInventory | null
// aws.isLoading: boolean
// aws.error: Error | null
```

The Inventory page needs a **flat merged list** (`CloudAccount[]`).

The hook must satisfy both callers. Its return type should be:

```ts
type CloudAccountInventory = {
  // Per-provider — consumed by Home.tsx
  aws:   { data: AwsInventory | null;   isLoading: boolean; error: Error | null };
  azure: { data: AzureInventory | null; isLoading: boolean; error: Error | null };
  gcp:   { data: GcpInventory | null;   isLoading: boolean; error: Error | null };
  // Flat merged list — consumed by Inventory.tsx
  accounts: CloudAccount[];
  // Aggregate loading/error states — consumed by both
  isLoading: boolean;   // true if ANY of the 7 queries is in-flight
  refetch: () => void;
};
```

`CloudAccount` (the table row type) must include `hasDuplicateAccountId` and `isMigrationBlocked`:

```ts
type CloudAccount = {
  provider: 'AWS' | 'Azure' | 'GCP';
  name: string;                         // credential / connection name
  accountId: string | null;             // null for legacy Azure with no subscription linked
  status: 'Classic' | 'New' | 'Parallel';
  entityId: string | null;              // null for New-only accounts
  hasDuplicateAccountId: boolean;       // true when ≥2 classic AWS rows share same awsAccountId
  isMigrationBlocked: boolean;          // true when AWS Metric Streams traffic detected in window
};
```

---

### 3. Hook Structure: One Hook, Seven `useDql` Calls

`useDql` is a React hook and cannot be called conditionally or in a loop. The correct approach is one `useCloudAccountInventory` hook that accepts a `timeframe: InventoryTimeframe = '12h'` parameter and unconditionally calls `useDql` exactly **seven** times at the top level.

**All query strings are built as `useMemo` values inside the hook** (keyed on `timeframe`), NOT module-level constants. This allows queries to re-execute when the user changes the time window while still providing stable references across renders when the timeframe hasn't changed.

```ts
// All seven fire in parallel on mount — no sequencing needed
const awsClassicDql        = useDql({ query: awsClassicQuery });
const azureClassicDql      = useDql({ query: azureClassicQuery });
const gcpClassicDql        = useDql({ query: gcpClassicQuery });
const awsNewDql            = useDql({ query: awsNewQuery });
const azureNewDql          = useDql({ query: azureNewQuery });
const gcpNewDql            = useDql({ query: gcpNewQuery });
const awsMetricStreamsDql  = useDql({ query: awsMetricStreamsQuery }); // 7th
```

**The seven queries:**

| `useMemo` variable | Source pattern | Groups by |
|----------|---------------|----------|
| `awsClassicQuery` | `docs/dql-patterns.md §11.1` | One row per AWS credential entity |
| `azureClassicQuery` | `docs/dql-patterns.md §11.2` | One row per Azure credential, subscription UUID joined inline |
| `gcpClassicQuery` | `docs/dql-patterns.md §11.3` | One row per active GCP project entity |
| `awsNewQuery` | `smartscapeNodes AWS_ACCOUNT \| fields id, name, aws.account.id` — `[Source: docs/dql-patterns.md#12.1]` ✅🟢 | One row per new AWS account |
| `azureNewQuery` | `smartscapeNodes AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS \| fields id, name, azure.subscription` — `[Source: docs/dql-patterns.md#12.2]` ✅🟢 | One row per monitored Azure subscription |
| `gcpNewQuery` | `smartscapeNodes GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT \| fields id, name, gcp.project.id` — `[Source: docs/dql-patterns.md#12.3]` ✅🟢 | One row per new GCP project |
| `awsMetricStreamsQuery` | `fetch metric.series \| filter dt.source == "AWS Metric Streams" \| summarize by:\`aws.account.id\`` — `[Source: docs/dql-patterns.md#1.3]` ✅🟢 (dtctl-verified 2026-04-09) | Set of AWS account IDs with active Metric Streams traffic |

**7th query failure handling**: if `awsMetricStreamsDql` errors, the result is treated as an empty set — no `isMigrationBlocked` flags are set. This is consistent with the "omit if no evidence" rule.

---

### 4. Merge Logic — Cross-Provider Account ID Matching

The merge is performed **per provider** in isolation. AWS, Azure, and GCP sets are merged independently and concatenated into the final `accounts` array. There is no risk of cross-provider ID collision.

**Join keys per provider:**

| Provider | Classic key | New key | Notes |
|----------|------------|---------|-------|
| AWS | `awsAccountId` from `aws_credentials` entity | `aws.account.id` from `AWS_ACCOUNT` Smartscape entity | String equality; both are numeric strings |
| Azure | `sub.azureSubscriptionUuid` from inline lookup | `azure.subscription` from `AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS` entity | UUID string equality |
| GCP | `entity.name` from `cloud:gcp:project` entity | `gcp.project.id` from `GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT` entity | Project ID slug equality. `name` on the Smartscape entity is the display name — NOT the slug. Use `gcp.project.id` as join key. |

**Four concrete concerns with the merge:**

1. **Azure null subscription UUIDs** — Legacy Azure credentials with no linked subscription yield `sub.azureSubscriptionUuid: null`. These can never match a Smartscape entity row (which always has a non-null subscription value). Treat them as `Classic`, set `accountId: null`, and skip the join attempt. Do NOT filter them out — they must appear in the table (per AC #2).

2. **Duplicate AWS account IDs** — Multiple `aws_credentials` entities can share the same `awsAccountId` (a real edge case confirmed in Dev Notes). Do NOT deduplicate. Keep all rows; after the merge is complete, scan the AWS result for repeated `accountId` values and set `hasDuplicateAccountId: true` on every row in a duplicate group. This drives the tooltip warning in the Account ID cell.

3. **New-only accounts** — An account ID that appears only in the Smartscape entity result (no matching classic entity) represents a fully-migrated or natively-new connection. These rows must be created fresh with `entityId: null` and `status: 'New'`. They are NOT missed entities; they are intentional.

   > **`name` field for NEW-only accounts**: The `name` field from the Smartscape entity is the cloud-side display name (AWS account alias, Azure subscription display name, GCP project display name) — NOT the Dynatrace connection config name. For the inventory table's `Connection Name` column, this is acceptable and sufficient. ✅🟢 `[Source: docs/dql-patterns.md#12]`

4. **Result ordering** — The UX spec calls for a default sort of `Classic → Parallel → New`. Since `DataTable` handles sorting client-side, the hook does not need to sort results. The page component sets the default sort on the table definition.

---

### 5. Scope Validation

All required scopes are **already present** in `app.config.json`:

```json
{ "name": "storage:entities:read",  "comment": "DQL dt.entity.* queries for classic connection detection" },
{ "name": "storage:metrics:read",   "comment": "fetch metric.series for AWS Metric Streams detection (7th query); also required by later stories" }
```

No `app.config.json` changes are needed for this story. ✅

---

### 6. Additional Architectural Concerns

**`Chip` color values (UX Spec validation)**
The UX spec maps `Classic → 'warning'`, `New → 'success'`, `Parallel → 'primary'`. These are valid `Chip` color prop values in `@dynatrace/strato-components/content`. ✅

**`DataTable` import path**
Per `AGENTS.md`: `DataTable` has graduated from preview to stable. Import from `@dynatrace/strato-components/tables`, not `@dynatrace/strato-components-preview/tables`.

**`Link` component source in table cells**
The UX spec uses `Link` for row navigation. In a Dynatrace App with React Router, use `import { Link } from 'react-router-dom'` for internal routes — not `@dynatrace/strato-components` `Link`, which is for external URLs.

**`useDql` result typing**
`useDql` returns `data` typed as `DqlResultV1 | undefined`. Each call site must extract `data.records` with null-safe access and cast to a known row type. Define per-query row types (e.g., `AwsCredentialEntityRow`, `AzureCredentialEntityRow`, `GcpProjectEntityRow`, `DaSourceRow`) as internal types in `hooks/useConnectionInventory.ts` — they do not need to be exported.

**Placeholder route for `/inventory/:accountId`**
The row navigation links to `/inventory/:accountId`. Story 002+ will implement this page. For this story, register the route in `App.tsx` with an empty `<div />` or a "Coming soon" placeholder so the link does not 404.

**Timeframe selector and `useMemo` query stability**
The timeframe `Select` in the toolbar drives re-execution of all 7 queries by changing the `timeframe` state. All query strings are wrapped in `useMemo([timeframe])` so they produce new string values only when the timeframe actually changes, not on every render. This is equivalent to the previous module-level constant approach but supports dynamic values.

**`isMigrationBlocked` on New-only and non-AWS rows**
Always `false`. New-only accounts have no classic Metric Streams to migrate from. Azure and GCP have no equivalent Metric Streams concept — no detection query is needed for them.

---

### 7. Implementation Order

1. **`ui/app/types/connection.ts`** — Define all types first (`InventoryTimeframe`, `isMigrationBlocked` on `CloudAccount`). All other files depend on this.
2. **`ui/app/utils/migrationStatus.ts`** — Pure functions; no dependencies beyond types.
3. **Author and verify connection enumeration and Metric Streams DQL queries** — Run via `dtctl` to confirm dimension names. ✅ All 7 verified.
4. **`ui/app/hooks/useConnectionInventory.ts`** — Implement `useCloudAccountInventory(timeframe)` with 7× `useDql` (all query strings in `useMemo`), merge logic, `metricStreamsAccountIds` set, and `isMigrationBlocked` annotation.
5. **`ui/app/components/StatusBadge.tsx`** — Simple component; implement after types are settled.
6. **`ui/app/pages/Inventory.tsx`** — Build the DataTable page with timeframe state, selector, heading label+tooltip, and blocked row indicator.
7. **`ui/app/App.tsx`** — Add `/inventory` and `/inventory/:accountId` (placeholder) routes.
8. **`ui/app/components/Header.tsx`** — Add "Cloud Accounts" nav item.
9. **Tests** — `useConnectionInventory.test.ts` (7th query routing, `isMigrationBlocked`, timeframe parameter); `Inventory.test.tsx` (blocked indicator render, timeframe label display).
- Empty state: environment with zero cloud connections
- Loading state: verify loading indicator shows while all DQL queries are in-flight

## Open Questions

*All open questions resolved via `dtctl` live verification.*

~~1. `AWS_ACCOUNT` field names~~ — **Resolved**: `aws.account.id` and `name` are direct attributes. `[Source: docs/dql-patterns.md#12.1]`

~~2. `AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS` field names~~ — **Resolved**: `azure.subscription` (UUID) and `name` (display name) are direct attributes. `[Source: docs/dql-patterns.md#12.2]`

~~3. GCP `gcp.project.id` vs `name`~~ — **Resolved**: `gcp.project.id` is the slug (join key); `name` is the display name and must NOT be used as join key. `[Source: docs/dql-patterns.md#12.3]`

~~4. `smartscapeNodes` scope requirement~~ — **Resolved**: `storage:entities:read` covers `smartscapeNodes`. `storage:metrics:read` is required for the 7th query (Metric Streams detection).

~~5. `aws.account.id` availability on `metric.series` records~~ — **Resolved (2026-04-09)**: `aws.account.id` is a confirmed dimension on `metric.series` for AWS metric keys. Per-account Metric Streams detection is feasible. `[dtctl verified against gmg]`

~~6. Timeframe false-negative risk for Metric Streams~~ — **Resolved**: "Omit if no evidence" rule adopted. The blocked indicator is only shown when positive Metric Streams traffic is found within the selected window. No `Unknown` state is needed.

## Out of Scope

- Entity counts per account (content for the dependency analysis stories, 002+)
- Metric activity breakdown (classic flavour detection — built-in vs. non-built-in vs. metric streams)
- Migration state tracking or marking accounts as "in progress"
- Deep-linking to the Clouds app per-account (future enhancement)
- Log ingest migration (deferred per vision: log ingest is per-connection, later phase) `[Source: AGENTS.md#Migration Notes]`
- Notebooks, workflows, management zones (Future Scope) `[Source: .github/prompts/vision.prompt.md#Future Scope]`

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-04-07 | 1.0 | Initial draft | Story Writer |
| 2026-04-09 | 1.1 | Added user-configurable timeframe selector (AC #7, #8), AWS Metric Streams migration-blocked indicator (AC #9, #10), `InventoryTimeframe` type, `isMigrationBlocked` field on `CloudAccount`, 7th `useDql` hook call, updated UX Specification and Architecture Notes | Copilot |
