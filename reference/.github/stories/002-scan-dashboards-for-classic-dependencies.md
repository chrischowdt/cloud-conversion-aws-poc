# User Story: Scan Dashboards for Classic Cloud Dependencies

**Status**: Draft
**Category**: Discovery
**Migration Phase**: Prepare

## Story Statement

**As a** Dynatrace Administrator,
**I want** to trigger an on-demand scan of all dashboards and see which ones reference classic cloud metrics or entity types for a selected cloud account's provider,
**so that** I know which dashboards will break or degrade when the classic connection is removed.

## Context

Before migrating a classic cloud connection, the administrator needs a complete picture of what depends on it. Dashboards are the most visible consumer of cloud metrics — classic-based dashboards will show empty tiles or errors the moment a classic connection is decommissioned.

This story implements the first slice of Capability #2 (Dependency Analysis) from the vision document, scoped to dashboards. It covers both dashboard formats present in Dynatrace environments: new dashboards (Document Service, DQL tiles) and classic dashboards (Config API v1, metric selector tiles). `[Source: .github/prompts/vision.prompt.md#Capabilities]`

The scan also distinguishes **custom dashboards** (user-created) from **preset/ready-made dashboards** (shipped by Dynatrace or apps). Custom-built dashboards are the primary migration concern — they require manual updates by the customer. Preset and ready-made dashboards are maintained by Dynatrace and will be updated when the new connection matures; they are surfaced in the results but clearly labelled to help the administrator understand where action is required.

Scoping is **provider-level** rather than per-account: classic metric keys (e.g. `dt.cloud.aws.ec2.*`) do not embed account IDs, so the app surfaces all dashboards using classic metrics for the same provider as the selected account. This is intentional and sufficient for v1 — account-level precision is deferred to the readiness scoring story. `[Source: docs/dashboard-scanning.md#Summary]`

## Acceptance Criteria

1. **Given** a user navigates to a classic account's detail page (from Story 001), **when** the Dashboards tab loads, **then** the tab renders in an idle state: a "Scan Dashboards" button and a filter toggle ("Include preset / ready-made dashboards", default: off) are shown — no scan starts automatically.

2. **Given** the Dashboards tab is in idle state, **when** the user clicks "Scan Dashboards", **then** a loading state is shown while the scan runs. When the scan completes, a list of all dashboards (classic and new format) that contain at least one classic metric key matching the selected account's cloud provider is displayed. If no dashboards with classic references are found, an empty state is shown confirming no dependent dashboards were detected.

3. **Given** a matched dashboard in the result list, **when** the user views its row, **then** they see: the dashboard name (as a deep-link to the dashboard in Dynatrace), the dashboard format (Classic or New), a **Custom / Preset / Ready-made** ownership badge, and the list of classic metric key prefixes or patterns detected in that dashboard.

4. **Given** a classic dashboard (Config API v1), **when** scanned, **then** metric keys using `builtin:cloud.aws.*`, `ext:cloud.aws.*` (AWS), `builtin:cloud.azure.*`, `ext:cloud.azure.*` (Azure), and `cloud.gcp.*` (GCP) in tile configurations are detected and surfaced.

5. **Given** a new dashboard (Document Service), **when** scanned, **then** DQL tile query strings containing `dt.cloud.aws.*`, `cloud.aws.*` (AWS), `dt.cloud.azure.*`, `cloud.azure.microsoft_*` (Azure), and `cloud.gcp.*` (GCP), plus classic entity type references (`fetch dt.entity.ec2_instance`, `fetch dt.entity.azure_vm`, etc.) are detected and surfaced.

6. **Given** the scan encounters a dashboard it cannot read (permission error or malformed content), **when** that dashboard is processed, **then** it is skipped silently and does not block the rest of the scan.

7. **Given** a new account is selected from Story 001 navigation, **when** the detail page loads, **then** any previous scan results are cleared and the Dashboards tab returns to idle state (the "Scan Dashboards" button is re-shown with the filter toggle reset to its default) — a new scan is NOT started automatically.

8. **Given** the Dashboards tab is in idle state (or showing prior results), **when** the user views the filter toggle, **then** "Include preset / ready-made dashboards" is off by default. Toggling it on/off does not trigger a scan; the toggle state is consumed when the user clicks "Scan Dashboards" to start a new scan. The filter is reset to off each time the user navigates to a new account.

9. **Given** the dashboard scan has completed and results are shown, **when** the user changes the filter toggle and clicks "Scan Dashboards" (or a dedicated "Re-scan" affordance), **then** the full scan runs again using the current filter setting, and the results table updates accordingly.

## Tasks / Subtasks

- [ ] Task 1: Define the classic metric key detection patterns per provider (AC: #4, #5)
  - [ ] AWS classic patterns: `dt.cloud.aws.`, `builtin:cloud.aws.`, `cloud.aws.`, `ext:cloud.aws.` `[Source: docs/aws-classic.md#2.1, docs/dac-aws-to-2ndgen-metrics.json]`
  - [ ] Azure classic patterns: `dt.cloud.azure.`, `builtin:cloud.azure.`, `cloud.azure.microsoft_`, `ext:cloud.azure.` `[Source: docs/azure-classic.md#1.1, docs/dac-azure-to-2ndgen-metrics.json]`
  - [ ] GCP classic patterns: `cloud.gcp.` (classic GCP has no `dt.cloud.gcp.*` prefix — all classic GCP metrics use `cloud.gcp.*`) `[Source: docs/gcp-classic.md#1.1]`
  - [ ] Classic entity type patterns per provider (for DQL tile detection — `fetch dt.entity.<type>` where type matches classic cloud types) `[Source: docs/aws-classic.md#4.1, docs/azure-classic.md]`
  - [ ] Document patterns in `utils/classicPatterns.ts` for reuse across Stories 004 and 005 (metric events, SLOs)

- [ ] Task 2: Fetch and scan new dashboards via Document Service API (AC: #1, #5)
  - [ ] List all dashboards using `documentsClient.listDocuments({ filter: "type = 'dashboard'" })` with pagination (loop until no `pageKey`) `[Source: docs/dashboard-scanning.md#New Dashboards]`
  - [ ] For each dashboard, call `documentsClient.getDocument({ id })` and parse JSON content
  - [ ] Walk all tiles, extract DQL `query` strings, run pattern matching against provider-appropriate patterns
  - [ ] Also extract classic entity type references from DQL strings (`fetch dt.entity.<classic_type>`)

- [ ] Task 3: Fetch and scan classic dashboards via Config API v1 (AC: #1, #4)
  - [ ] List all classic dashboards via `GET /api/config/v1/dashboards` `[Source: docs/dashboard-scanning.md#Classic Dashboards]`
  - [ ] For each dashboard, fetch the full tile definition and extract metric selector fields
  - [ ] Walk tile types: `DATA_EXPLORER`, `CUSTOM_CHARTING`, `SLO`, `HOSTS`, `SERVICES`, `APPLICATIONS` — extract metric keys and entity selectors `[Source: docs/dashboard-scanning.md#Classic Dashboards]`

- [ ] Task 4: Merge and deduplicate results; build the per-dashboard result model (AC: #1, #3)
  - [ ] One result row per dashboard: `{ id, name, url, format: 'classic' | 'new', ownership: 'custom' | 'preset' | 'ready-made', classicPatterns: string[] }`
  - [ ] For classic dashboards: `ownership` = `'preset'` if `dashboardMetadata.preset === true`, else `'custom'` `[Source: https://docs.dynatrace.com/docs/dynatrace-api/configuration-api/dashboards-api/get-dashboard]`
  - [ ] For new dashboards: `ownership` = `'ready-made'` if `originAppId` is non-null, else `'custom'` `[Source: node_modules/@dynatrace-sdk/client-document/.../document-meta-data.d.ts — originAppId field]`
  - [ ] `classicPatterns` = deduplicated list of detected prefix patterns (e.g. `["dt.cloud.aws.ec2.*", "cloud.aws.lambda.*"]`)
  - [ ] Sort: custom dashboards first (most action required), then preset/ready-made; within each group sort by pattern count descending

- [ ] Task 5: Implement the dashboard dependency UI on the account detail page (AC: #1, #2, #3, #8, #9)
  - [ ] Build the per-account detail page (`/inventory/:accountId`) introduced as a placeholder in Story 001
  - [ ] **Idle state**: render "Scan Dashboards" button + "Include preset / ready-made dashboards" toggle (default: off). No scan on mount.
  - [ ] **Running state**: replace idle UI with progress indicator (ProgressCircle + status text) while scan runs
  - [ ] **Results state**: render `DataTable` of matched dashboards + "Re-scan" button + read-only summary of the current filter state (e.g. "Custom dashboards only" or "Including preset / ready-made")
  - [ ] Dashboard name cell = deep-link (external link) to the dashboard in Dynatrace UI
  - [ ] Format badge: `Classic` / `New` using `Chip` component
  - [ ] Classic patterns cell: comma-separated detected prefixes
  - [ ] Loading and empty states per AC #2
  - [ ] Reset filter state (`includePreset`, `includeReadyMade`) to `false` on `accountId` change (AC #7, #8)

- [ ] Task 6: Implement API token input for Config API v1 access (AC: #4)
  - [ ] Create `ui/app/context/TokenContext.tsx` — exports `TokenContext`, `TokenProvider`, and `useToken()` hook. The provider holds the token in `useState<string | null>(null)`. Wrap the router tree in `<TokenProvider>` in `App.tsx` so all downstream components can call `useToken()` without prop-drilling.
  - [ ] In `AccountDetail.tsx`, render a `MessageContainer variant="info"` **above the `<Tabs>`** when `token === null`. Include a `TextInput` (label: `"Dynatrace API Token"`) and a `"Save"` button that calls the context setter.
  - [ ] Once the token is saved, replace the `MessageContainer` with a one-line acknowledgement: `"API token set"` + a `"Change"` text link that resets `token` to `null` and re-renders the prompt. This is the v1 recovery path.
  - [ ] If no token is set when `DashboardsTab` renders, skip the Config API v1 phase and show a `MessageContainer variant="warning"` inside the tab: `"Classic dashboard scan requires a Dynatrace API token. Enter it above to enable this scan."` New dashboard scanning proceeds regardless.
  - [ ] Use the token as `Authorization: Api-Token <value>` in all `httpClient.send()` calls against `/api/config/v1/`. `[Source: user clarification — Config API v1 requires an API token with ReadConfig scope, not OAuth]`
  - [ ] Future: replace this inline entry point with a dedicated Settings page (Option C). The `TokenContext` contract is unchanged — no other component modifications required.

- [ ] Task 7: Add required OAuth scopes to `app.config.json`
  - [ ] `document:documents:read` — list and read new dashboards
  - [ ] `document:documents:admin` — scan dashboards owned by other users ✅ confirmed available without special approval

## Dev Notes

### Relevant Context
- Dashboard scanning **cannot use DQL** — there is no `fetch documents` command. The Document Service SDK client (`@dynatrace-sdk/client-document`) is required for new dashboards. `[Source: docs/dashboard-scanning.md#Key Finding]`
- This story builds on Story 001's placeholder `/inventory/:accountId` route. The account detail page is created in this story. `[Source: .github/stories/001-discover-cloud-account-inventory.md#Tasks]`
- The `classicPatterns.ts` utility created in Task 1 will be shared by Stories 004 (metric events) and 005 (SLOs) — keep it provider-agnostic and additive.

### Platform Capabilities
- **Document Service SDK**: `@dynatrace-sdk/client-document` — use `documentsClient.listDocuments` + `documentsClient.getDocument`. Paginate with `nextPageKey`. `[Source: docs/dashboard-scanning.md#New Dashboards]`
- **Config API v1 dashboards**: `GET /api/config/v1/dashboards` and `GET /api/config/v1/dashboards/{id}` — **requires `ReadConfig` API token, not OAuth**. Construct requests via `httpClient` with `Authorization: Api-Token <user-supplied-token>` header. `[Source: https://docs.dynatrace.com/docs/dynatrace-api/configuration-api/dashboards-api/get-all]`
- **New dashboard deep-links**: `getDocumentLink(documentId)` from `@dynatrace-sdk/navigation` — returns the correct environment URL for a document. Also `openDocument(documentId)` to navigate programmatically. No manual URL construction needed. ✅ package installed. `[Source: node_modules/@dynatrace-sdk/navigation — get-document-link.d.ts]`
- **Classic dashboard deep-links**: URL format is unknown — see Open Question #4. Use `getEnvironmentUrl()` + a URL pattern to be determined.
- **Preset/ready-made detection**:
  - Classic: `dashboardMetadata.preset: boolean` from Config API v1 response `[Source: https://docs.dynatrace.com/docs/dynatrace-api/configuration-api/dashboards-api/get-dashboard]`
  - New: `originAppId?: string` on `DocumentMetaData` — non-null means ready-made (shipped by an app). Available on `listDocuments` response without needing to download content. `[Source: node_modules/@dynatrace-sdk/client-document — document-meta-data.d.ts]`

### Classic Metric Key Patterns Per Provider

| Provider | Definitive Classic | Ambiguous (classic OR new) | Classic Dashboard tile format |
|---|---|---|---|
| **AWS** | `dt.cloud.aws.` | `cloud.aws.` (non-built-in or new) | `builtin:cloud.aws.`, `ext:cloud.aws.` |
| **Azure** | `dt.cloud.azure.` | `cloud.azure.microsoft_` (non-built-in or new) | `builtin:cloud.azure.`, `ext:cloud.azure.` |
| **GCP** | *(none — no dedicated prefix)* | `cloud.gcp.` | *(not documented — see Open Questions)* |

> The "ambiguous" patterns (`cloud.aws.*`, `cloud.azure.microsoft_*`) are shared between classic non-built-in polling and new connections. At this stage (dependency discovery), flag them as potential classic dependencies. Story 006 (readiness scoring) will apply the mapping tables to classify blockers vs. warnings.

### Classic Entity Type References (for DQL tile detection)

In new dashboards, DQL tile strings like `fetch dt.entity.ec2_instance` are definitive classic references — the classic entity type can only come from a classic connection. New connections use `smartscapeNodes AWS_EC2_INSTANCE` (different syntax).

| Provider | Classic entity types to detect in `fetch dt.entity.*` |
|---|---|
| **AWS** | `ec2_instance`, `ebs_volume`, `aws_lambda_function`, `auto_scaling_group`, `aws_application_load_balancer`, `aws_network_load_balancer`, `elastic_load_balancer`, `relational_database_service` `[Source: docs/aws-classic.md#4.1]` |
| **Azure** | `azure_vm`, `azure_sql_server`, `azure_cosmos_db`, and other `azure_*` types `[Source: docs/azure-classic.md]` |
| **GCP** | `custom_device` with `cloud:gcp:*` subtype references — harder to detect statically; flag all `fetch dt.entity.custom_device` expressions as potential GCP classic refs when provider is GCP |

### Data Considerations
- Dashboard content is opaque to the server — all pattern matching happens **client-side** after download. This means the app downloads every dashboard's full JSON, which can be large in environments with many dashboards.
- Cache scan results in component state (not global App State) — results are specific to the current account + session. On account navigation, reset to idle state (AC #7) — do not auto-restart the scan.
- The `classicPatterns` array per dashboard is the detected metric key *prefixes or patterns*, not the full metric key strings. Full key extraction adds complexity without clear v1 value.
- Pagination: `listDocuments` returns max 1000 per page. For environments with >1000 dashboards, loop over `nextPageKey` before beginning content downloads.

### Scan Trigger and Filter State

- The `useDashboardScan` hook must expose an explicit `run()` method. The scan must NOT auto-start in a `useEffect` on mount. The hook starts in an idle state and only begins scanning when `run()` is called. `[Source: Enhancement 1 — manual scan trigger]`
- Filter state (`includePreset: boolean`, `includeReadyMade: boolean`) is local to the `DashboardsTab` component. Both are initialized to `false` and reset to `false` on every `accountId` change. This is not stored in `TokenContext` or any global state.
- **Preferred approach — post-scan client-side filtering**: fetch all dashboards (including preset and ready-made) on every scan, then filter the displayed rows based on the current toggle state. This makes toggling instant without triggering a new API call. The `DashboardScanState.results` always contains the full unfiltered set; `DashboardsTab` applies `includePreset`/`includeReadyMade` filters before passing rows to `DataTable`.
- Sort order: custom dashboards first (most action required), then preset, then ready-made; within each group sort by `classicPatterns.length` descending. When `includePreset`/`includeReadyMade` are toggled off, those rows are hidden from the table but remain in the underlying results array — no re-scan is needed for a filter change alone.

### Technical Constraints
- The app is **read-only** — no writes to any API. `[Source: .github/prompts/vision.prompt.md#Capabilities]`
- `document:documents:admin` OAuth scope confirmed available without special approval — add to `app.config.json`.
- **Config API v1 requires an API token** (`ReadConfig` scope), not OAuth. Token is collected via an inline `MessageContainer` above the `<Tabs>` in `AccountDetail.tsx` (Option A — v1) and stored in `TokenContext` at the App level. Stories 004 and 005 consume the same context — the user is not re-prompted. Future improvement: replace the inline entry point with a Settings page (Option C); `TokenContext` is unchanged. `[Source: user decision — 2026-04-08]`
- `originAppId` is present in the `listDocuments` response metadata — no extra API call is needed to determine whether a new dashboard is ready-made.
- `dashboardMetadata.preset` is present on the individual dashboard fetch response (Config API v1 `/dashboards/{id}`), not on the listing — the scan must already download each dashboard to extract tile data, so this is available at no extra cost.

## Cloud Provider Considerations

Provider-level scoping is consistent across all three providers — the scan always covers all dashboards and filters by provider-appropriate patterns. The pattern sets differ per provider (see table above). 

GCP is the weakest case: there is no dedicated `dt.cloud.gcp.*` classic prefix, and the `cloud.gcp.*` pattern is used by both classic and (to a lesser extent) the GCP Metrics API. The scan for GCP should flag all `cloud.gcp.*` occurrences as potential classic dependencies.

Azure is in Preview for new connections — `cloud.azure.microsoft_*` ambiguity is less prevalent than for AWS as the new Azure connection is less widely deployed.

## Dependencies

- **Story 001** — account selection and navigation. The `/inventory/:accountId` route must exist (placeholder created in Story 001). Provider and account ID are passed as route state. Required before this story can be implemented.

## Testing Guidance

> **Note**: Testing strategy is an open topic — details will be refined when the QA Testing agent is established.

- Happy path: environment with a mix of classic-referencing and non-classic dashboards → only matching ones appear
- Edge case: dashboard with 0 tiles → no match, no error
- Edge case: dashboard with malformed JSON tile content → skipped silently (AC #6)
- Edge case: `listDocuments` returns multiple pages → all pages processed correctly
- Edge case: environment with zero dashboards → empty state shown
- Edge case: GCP provider selected → `cloud.gcp.*` patterns detected correctly

## Open Questions

~~1. Config API v1 OAuth scope~~ — **Resolved**: Config API v1 requires a `ReadConfig` API token, not OAuth. The user supplies the token at runtime; the app stores it in session state and passes it as `Authorization: Api-Token <value>`. `[Source: https://docs.dynatrace.com/docs/dynatrace-api/configuration-api/dashboards-api/get-all]`

~~2. `document:documents:admin` availability~~ — **Resolved**: Available as a self-service scope; add to `app.config.json`. No special approval needed.

~~3. GCP classic dashboard tile format~~ — **Resolved**: Same tile format as classic AWS and Azure dashboards (`builtin:cloud.gcp.*` and `cloud.gcp.*` patterns in metric selector fields).

1. **Classic dashboard deep-link URL**: What is the URL pattern to open a classic (Config API v1) dashboard in the Dynatrace UI? For new dashboards, `getDocumentLink(documentId)` from `@dynatrace-sdk/navigation` is confirmed available and correct. The classic URL format is unknown — needs verification in a live environment before hardcoding. Candidate: `` `${getEnvironmentUrl()}ui/dashboarding/dashboard/${id}` ``.

~~2. **API token storage UX**~~ — **Resolved (v1.3)**: Option A — inline prompt. A `MessageContainer variant="info"` above the `<Tabs>` in `AccountDetail.tsx` collects the token on first use. Token is stored in `TokenContext` (`ui/app/context/TokenContext.tsx`) at the App level so Stories 004 and 005 consume it without re-prompting. A `"Change"` link lets the user update the token at any time. Future improvement: replace the inline entry point with a dedicated Settings page (Option C) — `TokenContext` contract is unchanged, no other component modifications needed.

## Out of Scope

- Account overview tab — entities and metric key counts (Story 003)
- Metric events/alerts scanning (Story 004)
- SLO scanning (Story 005)
- Notebooks, workflows, management zones scanning (Future Scope per vision) `[Source: .github/prompts/vision.prompt.md#Future Scope]`
- Readiness scoring / Blocker vs. Warning classification (Story 006)
- Entity-level account scoping (deferred — provider-level is sufficient for v1)
- Performance optimization / batched downloads (future improvement if scan is too slow)

## UX Specification (Added by UX Reviewer — 2026-04-08)

This section covers the scan trigger and filter toggle enhancements (v1.5 onwards). It is scoped to the `DashboardsTab` component, which has three distinct states: **Idle**, **Scanning**, and **Results**. The API token banner above `<Tabs>` is already specified in Task 6 and is not redesigned here — it is referenced where relevant.

---

### User Flow

1. User navigates to a classic account's detail page (from Story 001 Inventory table).
2. The API token banner renders above `<Tabs>` (see Task 6). The Dashboards tab loads in **Idle state**.
3. In Idle state the user sees the filter toggle (default: off) and the "Scan Dashboards" button. No scan starts automatically.
4. The user optionally toggles "Include preset & ready-made dashboards" on or off, then clicks "Scan Dashboards".
5. The tab transitions to **Scanning state**: a `ProgressCircle` with status text replaces the idle controls. *(No scan auto-starts on account navigation — this is the same idle screen each time.)*
6. When the scan completes, the tab transitions to **Results state**: a `DataTable` is shown with a filter-state summary line and a "Re-scan" button above it.
7. In Results state the user can change the toggle and immediately see the table update (client-side, no re-scan). To re-run the API scan, the user clicks "Re-scan".
8. On navigating to a different account, the tab resets to **Idle state** and the toggle resets to off.

---

### Component Specifications

#### Filter Toggle

- **Strato Component**: `Switch` from `@dynatrace/strato-components/forms`
- **Verified in**: `node_modules/@dynatrace/strato-components/forms/switch/Switch.d.ts`
- **Purpose**: Controls whether preset and ready-made dashboards are included in the displayed results. Default is off (excluded). Filtering is applied client-side; changing the toggle never triggers a re-scan.
- **Key Props**:
  - `value`: `boolean` — controlled value; drives `includePresetAndReadyMade` state in `DashboardsTab`
  - `onChange`: `(checked: boolean) => void` — updates component state
  - `children`: `ReactNode` — rendered as the label text: `"Include preset & ready-made dashboards"`
- **States**:
  - Default (Idle, fresh account): off (`value={false}`)
  - Toggled on: on (`value={true}`) — Results table updates immediately to include preset/ready-made rows
  - Toggled off (during Results): Results table immediately hides preset/ready-made rows
  - Reset on account navigation: back to `false`
- **Notes**: `Switch` accepts children as its label — no separate `<Label>` is needed. The label text should be concise: `"Include preset & ready-made dashboards"`.

---

#### Scan Dashboards Button

- **Strato Component**: `Button` from `@dynatrace/strato-components/buttons`
- **Purpose**: Triggers the dashboard scan. Only active in Idle state and Results state ("Re-scan" variant) — disabled while scanning.
- **Key Props**:
  - `variant`: `"emphasized"` — primary action in Idle state
  - `onClick`: calls `useDashboardScan.run()`
  - `disabled`: `true` while `isScanning === true`
  - `color`: `"primary"`
- **States**:
  - Idle: enabled, label `"Scan Dashboards"`, `variant="emphasized"`
  - Scanning: not shown (replaced by `ProgressCircle`)
  - Results: shown as "Re-scan" with `variant="default"` (secondary action, table already showing)

---

#### Progress Indicator (Scanning state)

- **Strato Component**: `ProgressCircle` from `@dynatrace/strato-components/content` — **already present in `AccountDetail.tsx` line 6/100**
- **Purpose**: Communicates that a long-running scan is active.
- **Key Props**:
  - `value`: `"indeterminate"` — scan duration is unknown
  - `aria-label`: `"Scanning dashboards"`
- **Cancel button**: Do NOT show a cancel button in v1. The scan is a read-only fetch sequence; partial results create confusion (a half-scan showing "0 results" would be misleading). Cancel support can be added if scan latency becomes a complaint after real-environment testing.
- **Supplementary text**: `<Paragraph>` below the circle: `"Scanning dashboards for classic {provider} references…"` (already present in current implementation — preserve it).

---

#### Re-scan Button (Results state)

- **Strato Component**: `Button` from `@dynatrace/strato-components/buttons`
- **Purpose**: Allows the user to re-trigger the full scan (e.g., after toggling the filter and wanting fresh API results, or after fixing a missing token).
- **Key Props**:
  - `variant`: `"default"`
  - `color`: `"neutral"`
  - `onClick`: calls `useDashboardScan.run()`
  - `size`: `"condensed"` — keeps toolbar area compact above the table

---

#### Filter State Summary (Results state)

- **Strato Component**: `Paragraph` from `@dynatrace/strato-components/typography`
- **Purpose**: One-line read-only confirmation of the currently applied filter. Updates reactively when the toggle changes.
- **Content**:
  - Toggle off: `"Showing custom dashboards only — preset & ready-made excluded"`
  - Toggle on: `"Showing all dashboards including preset & ready-made"`
- **Placement**: Same row as the Re-scan button (right of the button, or below it in narrow viewports).

---

### Information Hierarchy

The visual priority order in each state:

**Idle state (top → bottom):**
1. API token banner (above `<Tabs>`, already exists — not modified here)
2. Filter toggle (`Switch`) — on its own line, full width or left-aligned
3. "Scan Dashboards" button — directly below the toggle, left-aligned

**Scanning state:**
1. API token banner (static, above tabs)
2. Centered `ProgressCircle` + status `<Paragraph>` — replaces the idle controls entirely

**Results state (top → bottom):**
1. API token banner (static, above tabs)
2. Toolbar row: filter toggle | filter summary text | "Re-scan" button (right-aligned)
3. `DataTable` — occupies the remaining space

**Layout for state 1 (Idle):**
```
[ Switch: Include preset & ready-made dashboards  ○ ]
[ Button: Scan Dashboards                           ]
```
The toggle appears above the button to make it clear the toggle setting is an input to the scan, not a post-scan filter. This ordering guides the user: *configure → act*.

**Layout for state 3 (Results):**
```
[ Switch: Include preset & ready-made dashboards  ○ ]  [ Summary text ]  [ Re-scan ]
[ ─────────────────── DataTable ─────────────────── ]
```
The toggle remains at the top of the tab in Results state so the user can change filtering without scrolling. The filter summary is visually adjacent to confirm the current mode.

---

### Empty State Variants

| Scenario | Trigger condition | Heading | Detail | Suggested User Action |
|---|---|---|---|---|
| **Filter OFF, no custom dashboards** | Scan complete; all results are preset/ready-made (or zero matches) | `"No custom dashboard dependencies found"` | `"Preset and ready-made dashboards were excluded from results. Enable 'Include preset & ready-made dashboards' to see all matching dashboards."` | Toggle the switch — no re-scan needed |
| **Filter ON, no dashboards at all** | Scan complete; zero dashboards reference classic provider metrics | `"No dependent dashboards found"` | `"No dashboards referencing classic {provider} metrics or entity types were detected."` | No action — environment is clean for this provider |

**Strato Component**: `EmptyState` from `@dynatrace/strato-components/content` — already used in `AccountDetail.tsx`. Use `EmptyState.Title` and `EmptyState.Details`.

For the Filter OFF variant, also render the `Switch` toggle above the `EmptyState` (same position as in Idle/Results) so the user can enable preset inclusion without scrolling or guessing how to proceed.

---

### Error Handling

| Error Scenario | Message | Recovery Action |
|---|---|---|
| Scan network/API error | `MessageContainer variant="critical"` — already implemented. Title: `"Scan error"`, description: error message string. | User can fix the issue (e.g., set token) and click "Re-scan" — re-show the idle controls or a "Re-scan" button after error. |
| No token, classic scan skipped | `MessageContainer variant="warning"` inside the tab — already implemented. | Enter token in banner above tabs, then re-scan. |

The existing error UX in `AccountDetail.tsx` is sufficient. No changes beyond preserving the ability to re-trigger the scan after an error (show a "Re-scan" / "Try again" button below the `MessageContainer`).

---

### Filter Toggle Behavior Summary

| When | Toggle Change Effect |
|---|---|
| **Idle state** | Updates toggle state locally; no scan starts. Current state is consumed when user clicks "Scan Dashboards". |
| **Scanning state** | Toggle is still visible but has no immediate effect; the current toggle value will be the active filter once results arrive. *(Consider disabling the toggle during scanning to prevent confusion — see note below.)* |
| **Results state** | `DataTable` rows re-filter immediately — no API call. `useDashboardScan.results` always holds the full unfiltered set; `DashboardsTab` applies the toggle filter before passing rows to `DataTable`. |
| **Account navigation** | Toggle resets to `false` (off) alongside the full idle state reset (AC #7, #8). |

> **Note on scanning state toggle**: Disable the `Switch` (`disabled={true}`) while `isScanning === true`. This prevents the user from changing filter intent mid-scan, which would be ambiguous — the result set is fetched in full regardless, so the filter will apply cleanly once scanning is complete.

---

### Migration Journey Context

This feature sits at the **Prepare** phase of the migration journey. The user has identified a classic account they want to migrate (Story 001) and is now assessing what will break. The scan result is the key input to their migration planning decision:

- **Next step after Results state**: Review custom dashboard rows — these require manual dashboard updates. Preset/ready-made rows can be noted but do not require customer action.
- **Future handoff**: Readiness scoring (Story 006) will consume this scan output to produce a per-account migration readiness score. The `DashboardScanResult[]` data model is the bridge.

---

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-04-07 | 1.0 | Initial draft | Story Writer |
| 2026-04-07 | 1.1 | UX Specification added | UX Reviewer |
| 2026-04-08 | 1.2 | Resolved OQ#1–3; added preset/ready-made distinction; API token approach; deep-link SDK discovery | Story Writer |
| 2026-04-08 | 1.6 | UX Specification for scan trigger and filter toggle added | UX Reviewer |
| 2026-04-08 | 1.3 | Resolved OQ#2 (token UX): Option A — inline MessageContainer + TokenContext; arch notes updated (TokenContext file, App.tsx to Modify, impl order, hook signature) | Story Writer |
| 2026-04-08 | 1.4 | UX spec: full 4-tab frame (Overview/Dashboards/Metric Events/SLOs) defined in Story 002; Overview empty + defaultIndex=1 until Story 003; Metric Events→Story 004, SLOs→Story 005 | UX Reviewer |
| 2026-04-08 | 1.5 | Enhancement: manual scan trigger + preset/ready-made filter option | Story Writer |

---

## UX Specification (Added by UX Reviewer)

### User Flow

1. User clicks a classic account row in the inventory table (`/inventory` — Story 001)
2. Browser navigates to `/inventory/:accountId` — the account detail page loads
3. Any previous scan results for a different account are purged and the Dashboards tab resets to idle state (AC #7) — no scan starts automatically. The "Scan Dashboards" button is re-shown with the filter toggle reset to default. *(Updated v1.5)*
4. If no API token is set: a `MessageContainer variant="info"` is shown above the Tabs with a token `TextInput` and `"Save"` button. Classic dashboard scanning is deferred until the token is provided. New dashboard scanning proceeds without a token.
5. Dashboards tab is in idle state: "Scan Dashboards" button and filter toggle are shown. The user must explicitly click the button to start the scan. Once clicked, the loading state (ProgressCircle + status text) replaces the idle UI while the scan runs. *(Updated v1.5)*
6. Scan completes:
   - If `skippedCount > 0` → a dismissible warning banner appears above the table
   - If `matchCount > 0` → results table is shown; tab title updates to `Dashboards (N)`
   - If `matchCount === 0` and `totalScanned > 0` → positive empty state ("no dependencies") is shown
   - If `totalScanned === 0` → neutral empty state ("no dashboards found") is shown
7. User can click any dashboard name → opens the dashboard in Dynatrace UI in a new browser tab
8. User can sort, resize, and reorder table columns; a download option is available in the toolbar

### Page Shell — Account Detail Page (`/inventory/:accountId`)

The detail page uses **`Tabs`** as its top-level dependency section navigator. **All four tabs are defined in Story 002**; subsequent stories fill in content. Story 003 populates the Overview tab. Stories 004 (Metric Events) and 005 (SLOs) enable their respective tabs.

```
┌───────────────────────────────────────────────────────────────┐
│  ← Back to inventory                                          │
│  [Account / Connection Name]    [AWS]  ← Chip (provider)      │
├───────────────────────────────────────────────────────────────┤
│  [Token prompt — MessageContainer (info) — shown when no API  │
│   token is set; collapses to one-line once token is saved]    │
├───────────────────────────────────────────────────────────────┤
│  [ Overview ]  [ Dashboards (23) ]  [ Metric Events ]  [ SLOs ]│
│   Story 003     ← default (002)      disabled (002)    disabled │
├───────────────────────────────────────────────────────────────┤
│  [Warning banner — conditional]                               │
│  [DataTable of results]  OR  [Loading state]  OR  [EmptyState]│
└───────────────────────────────────────────────────────────────┘
```

> **Story 002 tab frame**: All four tabs are rendered in Story 002. `Overview` (index 0) is present but empty — Story 003 populates it. `Dashboards` (index 1) is the active default (`defaultIndex={1}`). `Metric Events` and `SLOs` are `disabled` until Stories 004 and 005 ship. **Story 003 changes `defaultIndex` to `0`** once Overview has content.

#### Tab Title Convention

- While scanning: `title="Dashboards"`
- After scan, with matches: `title={\`Dashboards (${results.length})\`}`
- After scan, zero matches: `title="Dashboards (0)"` — confirms the scan ran and found nothing

---

### Component Specifications

#### 1. Page Shell — Tabs Navigation

- **Strato Component**: `Tabs`, `Tab` from `@dynatrace/strato-components/navigation`
- **Purpose**: Organises the account overview and the three dependency scan sections into a single tab frame that grows incrementally across stories. The full four-tab structure is defined in Story 002 so the page shell never needs restructuring.
- **Key Props**:
  - `selectedIndex`: `number` — controlled tab selection
  - `onChange`: `(index: number) => void` — update selected tab on click
  - `defaultIndex`: `1` — Dashboards is the active tab in Story 002 (Overview is empty); Story 003 changes this to `0`
- **Tab Structure (all 4 tabs defined in Story 002)**:
  | Index | Title | Story 002 state | Activated by |
  |---|---|---|---|
  | 0 | `Overview` | Rendered, empty | Story 003 |
  | 1 | `Dashboards` | Rendered, populated, **default** | This story |
  | 2 | `Metric Events` | `disabled` | Story 004 |
  | 3 | `SLOs` | `disabled` | Story 005 |
- **States**:
  - Story 002: Dashboards active (index 1); Overview visible but empty; Metric Events + SLOs disabled
  - Story 003: Overview active (index 0), Overview content populated; `defaultIndex` changes to `0`
  - Stories 004/005: respective tabs enabled with content
- **Use Case Reference**: `Controlled` / `Disabled` use cases in Strato Tabs docs
- **Notes**: `Tab` title is a plain string so count suffix (`Dashboards (0)`) is achieved via template literal. Disabled tabs signal future functionality without dead navigation — they MUST be rendered from day one, not added later.

---

#### 2. Provider Badge in Page Header

- **Strato Component**: `Chip` from `@dynatrace/strato-components/content`
- **Purpose**: Visually labels the cloud provider (AWS / Azure / GCP) in the page header next to the account/connection name.
- **Key Props**:
  - `color`: `'neutral'` for all three providers (consistent; Story 006 may introduce provider-specific coloring)
  - `variant`: `'emphasized'` (default)
- **States**:
  - Single static label — no interactive states needed
- **Notes**: Non-interactive display-only Chip. No `onClick`.

---

#### 3. Scanning Loading State

- **Strato Component**: `ProgressCircle` from `@dynatrace/strato-components/content`, composed with `Flex` (layouts) and `Text` (typography)
- **Purpose**: Communicates that the multi-step, client-side dashboard scan is in progress. Because the total dashboard count is not known until pagination is complete, an indeterminate circle is used rather than a progress bar.
- **Key Props on `ProgressCircle`**:
  - `value`: `'indeterminate'` (default — no need to pass)
  - `size`: `'large'`
  - `aria-label`: `"Scanning dashboards"`
- **Layout**: `Flex flexDirection="column" alignItems="center" gap={8}` containing the `ProgressCircle` above a `Text` paragraph
- **Status text**: `"Scanning {provider} dashboards for classic dependencies…"` (e.g. "Scanning AWS dashboards for classic dependencies…")
- **States**:
  - Rendered only while `isLoading === true`; replaced by results / empty state when `isLoading === false`
- **Use Case Reference**: `Basic` use case in ProgressCircle docs
- **Notes**: DataTable has a native `loading={true}` prop, but since no rows exist yet during the initial scan, a standalone ProgressCircle is more appropriate here. `loading={true}` on DataTable is reserved for reload/refetch scenarios where the table structure is already visible.

---

#### 4. Dashboard Results Table

- **Strato Component**: `DataTable` from `@dynatrace/strato-components/tables`
  - Sub-components: `DataTable.Toolbar`, `DataTable.LineWrap`, `DataTable.ColumnOrderSettings`, `DataTable.DownloadData`, `DataTable.ColumnActions`, `TableActionsMenu`
- **Purpose**: Displays all dashboards containing classic dependency patterns, sorted by impact (most patterns first), with external links to open each dashboard in Dynatrace.
- **Classification**: Data-heavy table (environments can have hundreds of affected dashboards). The full DataTable compliance checklist requirements apply.
- **Key Props**:
  - `sortable`: `true`
  - `resizable`: `true`
  - `columnOrdering`: `true`
  - `fullWidth`: `true`
  - `defaultSortBy`: `[{ id: 'classicPatterns', desc: true }]` — most-impacted dashboards first
- **Required Sub-components** (Experience Standard — Data-Heavy):
  ```
  <DataTable.Toolbar>
    <DataTable.LineWrap />
    <DataTable.ColumnOrderSettings />
    <DataTable.DownloadData />
  </DataTable.Toolbar>
  <DataTable.ColumnActions>
    <TableActionsMenu>
      <TableActionsMenu.ColumnOrder />
      <TableActionsMenu.LineWrap />
      <TableActionsMenu.HideColumn />
    </TableActionsMenu>
  </DataTable.ColumnActions>
  ```
- **Column Definitions**:

  | Column | Header | Accessor / Sort | Cell Renderer | Notes |
  |---|---|---|---|---|
  | `name` | Dashboard Name | `row.name` (string) | `<ExternalLink href={row.url}>{row.name}</ExternalLink>` | Opens in new tab; `ExternalLink` is correct since the link exits this app into DT UI |
  | `format` | Format | `row.format` (string) | `<Chip color={row.format === 'classic' ? 'warning' : 'neutral'} size="condensed">{row.format === 'classic' ? 'Classic' : 'New'}</Chip>` | Warning colour for Classic signals risk |
  | `classicPatterns` | Detected Classic Patterns | `accessorFn: (row) => row.classicPatterns.length` (used for sort) | `<ChipGroup>{row.classicPatterns.map(p => <Chip color="critical" size="condensed">{p}</Chip>)}</ChipGroup>` | `accessorFn` returns count for sorting; `cell` renders chips for display |

- **States**:
  - Default: table with sortable columns, sorted most-impacted first
  - Reload/refetch (after AC #7 navigation): `loading={true}` on existing table while new scan is in progress — only applicable if table mount is preserved; typically a fresh mount with ProgressCircle is simpler
  - Empty: handled by `EmptyState` (see below) — DataTable is not rendered when `matchCount === 0`
- **Use Case Reference**: Data-Heavy Complete Example in `DataTable-Compliance-Checklist.md`
- **Notes**: Per the compliance checklist — context-switching navigation (to DT UI dashboard) uses `ExternalLink` in a cell renderer, NOT `interactiveRows`. Do not add `interactiveRows` to this table; there is no in-context detail panel for Story 002.

---

#### 5. Format Badge — Classic vs. New

- **Strato Component**: `Chip` from `@dynatrace/strato-components/content`
- **Purpose**: Distinguishes Classic dashboards (Config API v1) from New dashboards (Document Service / DQL tiles) at a glance and signals the risk level of classic ones.
- **Key Props**:
  - Classic format: `color="warning"`, `size="condensed"`, `variant="emphasized"` — label: `"Classic"`
  - New format: `color="neutral"`, `size="condensed"`, `variant="emphasized"` — label: `"New"`
- **Notes**: Warning colour for Classic dashboards reinforces the migration urgency. Using `size="condensed"` keeps the badge compact within a table cell.

---

#### 6. Detected Classic Patterns Cell

- **Strato Component**: `ChipGroup` from `@dynatrace/strato-components/content`, containing `Chip` instances
- **Purpose**: Displays the list of detected classic metric key patterns for each dashboard in a compact, expandable form that handles 1–10+ patterns gracefully.
- **Key Props on `ChipGroup`**:
  - Expandable by default — shows a "+N more" affordance when patterns exceed the visible count
- **Key Props on each `Chip`**:
  - `color`: `'critical'` — patterns are potential migration blockers
  - `size`: `'condensed'`
  - `variant`: `'emphasized'`
- **States**:
  - 1–3 patterns: all chips visible inline
  - 4+ patterns: ChipGroup collapses extras with "+N more" toggle
- **Notes**: Chip contents are pattern strings such as `dt.cloud.aws.ec2.*`, `builtin:cloud.aws.*`. Do not truncate pattern strings — they are meaningful to the DT Administrator audience.

---

#### 7. Empty State — Zero Matches (Positive)

- **Strato Component**: `EmptyState` from `@dynatrace/strato-components/content`
- **Purpose**: Provides reassuring feedback when the scan completed but found no classic dependencies in any dashboard.
- **Key Props**:
  - `size`: `'small'` — inside a tab panel, not a full-page empty state
- **Sub-components**:
  - `EmptyState.Visual` → `EmptyState.VisualPreset context="table" type="no-result"`
  - `EmptyState.Title` → `"No classic dependencies found"`
  - `EmptyState.Details` → `"Scanned {N} dashboards — none reference classic {provider} metrics or entity types. This area looks ready to migrate."`
- **States**:
  - Rendered when scan completed, `matchCount === 0`, and `totalScanned > 0`
- **Notes**: This is intentionally positive framing ("looks ready to migrate") — the user has done a scan and got good news. No actions are needed (read-only app).

---

#### 8. Empty State — No Dashboards (Neutral)

- **Strato Component**: `EmptyState` from `@dynatrace/strato-components/content`
- **Purpose**: Informs the user when the scan found no dashboards to scan at all (empty environment).
- **Key Props**:
  - `size`: `'small'`
- **Sub-components**:
  - `EmptyState.Visual` → `EmptyState.VisualPreset context="table" type="something-missing"`
  - `EmptyState.Title` → `"No dashboards found"`
  - `EmptyState.Details` → `"This environment contains no dashboards. There is nothing to scan for classic dependencies."`
- **States**:
  - Rendered when scan completed and `totalScanned === 0`

---

#### 9. Partial Scan Warning Banner (Skipped Dashboards)

- **Strato Component**: `MessageContainer` from `@dynatrace/strato-components/content`
- **Purpose**: Transparently informs the user that some dashboards were excluded from the scan due to permission or parse errors (AC #6), so they know the results are potentially incomplete.
- **Key Props**:
  - `variant`: `'warning'`
  - `onDismiss`: `() => void` — user can dismiss after reading
- **Sub-components**:
  - `MessageContainer.Title` → `"Some dashboards could not be scanned"`
  - `MessageContainer.Description` → `"{N} dashboard(s) were skipped due to permission errors or unreadable content. The results shown may be incomplete."`
- **Placement**: Rendered directly above the results table (or above the empty state) when `skippedCount > 0`
- **States**:
  - Hidden when `skippedCount === 0`
  - Visible and dismissible when `skippedCount > 0`
- **Notes**: "Skipped silently" (AC #6) means the scan does not abort — but the UX must still surface the skipped count so users can judge the completeness of results. A warning (not critical) is appropriate because the scan ran; it's a partial data quality signal, not a scan failure.

---

### Information Hierarchy

What the user needs to process, in order of visual priority:

1. **Where am I?** — Account/connection name + provider Chip badge (page header)
2. **What category am I viewing?** — Active tab ("Dashboards") with match count
3. **Are results complete?** — Warning banner if any dashboards were skipped (rendered before the table)
4. **What needs attention?** — DataTable rows sorted most-impacted first; Classic format chips in Warning colour draw the eye
5. **What's in each row?** — Dashboard name (ExternalLink), format badge, pattern chips

---

### Empty State Summary

| Scenario | EmptyState.Title | EmptyState.Details | Visual Preset |
|---|---|---|---|
| Scan complete, 0 matches, N dashboards scanned | "No classic dependencies found" | "Scanned {N} dashboards — none reference classic {provider} metrics or entity types. This area looks ready to migrate." | `context="table" type="no-result"` |
| Scan complete, 0 dashboards exist | "No dashboards found" | "This environment contains no dashboards. There is nothing to scan for classic dependencies." | `context="table" type="something-missing"` |

---

### Error / Partial Failure Handling

| Scenario | Component | Variant | Message | User Action |
|---|---|---|---|---|
| N dashboards skipped (permission / parse error) — AC #6 | `MessageContainer` | `warning` | "{N} dashboard(s) were skipped due to permission errors or unreadable content. Results may be incomplete." | Dismiss; or investigate permissions (informational only — no action available in this read-only app) |
| Scan fails entirely (API unavailable) | `MessageContainer` | `critical` | "Dashboard scan failed. Could not connect to the Document Service or Config API. Check your permissions and try again." | No retry button in v1; user can navigate away and back, then click "Scan Dashboards" to retry *(Updated v1.5)* |

> **Note for architect**: The critical-failure case (entire scan fails) is outside Story 002's acceptance criteria but should be handled gracefully at the component level. The suggested UX is a `MessageContainer` with `variant="critical"` in place of the table/empty state.

---

### Migration Journey Context

The account detail page sits between:
- **Before (Story 001)**: Account inventory table — user selected a classic account to inspect
- **This story (002)**: Dashboard dependency scan — first slice of blast-radius analysis
- **Next (Story 003)**: Overview tab populated with entity counts and classic metric key prefixes
- **Then (Stories 004, 005)**: Metric Events and SLOs tabs enabled on the same page shell
- **Later (Story 006)**: Readiness scoring overlay aggregates findings from all three tabs

The "next step" action at this stage is implicit: the user reviews the list and manually notes which dashboards need updating. The app does not guide remediation in v1. There is no primary action button on this page.

---

## ARCHITECTURE NOTES
*Generated by architect agent on 2026-04-07*

---

### 1. Story 001 Prerequisites — What Must Exist Before Story 002 Starts

Story 002 cannot begin until Story 001 delivers the following. The directories `ui/app/hooks/`, `ui/app/types/`, and `ui/app/utils/` are currently empty scaffolding — none of these files exist yet (verified against current codebase state).

**Files Story 001 must create:**

| File | Required by Story 002 because… |
|---|---|
| `ui/app/types/connection.ts` | Exports `CloudProvider`, `CloudAccount`, `MigrationStatus` — Story 002 must know what `provider` value it receives from route state |
| `ui/app/hooks/useConnectionInventory.ts` | Already imported by `Home.tsx`; must exist for the app to compile |
| `ui/app/utils/migrationStatus.ts` | Already imported by `Home.tsx`; must exist for the app to compile |
| `ui/app/pages/Inventory.tsx` | The inventory page — Story 002 relies on users navigating here first |
| `ui/app/pages/AccountDetail.tsx` *(stub)* | Story 001 Task 5 adds a `/inventory/:accountId` route; the element it points to must compile. A one-line stub (`<div>Coming soon</div>`) is sufficient for Story 001. Story 002 replaces the stub content entirely. |

**App.tsx state after Story 001 (prerequisite for Story 002):**
```tsx
<Route path="/inventory" element={<Inventory />} />
<Route path="/inventory/:accountId" element={<AccountDetail />} />   {/* stub → Story 002 fills this */}
```

Story 002 does **not** need to touch `App.tsx` — the route already exists pointing to `AccountDetail.tsx`. Story 002 replaces the stub body of that page.

---

### 2. SDK Client for Config API v1 — Correction Required

The story's Dev Notes reference `@dynatrace-sdk/client-classic-environment-v1` as a possible approach for Config API v1 calls. **This package is not installed and is not present in `package.json`.**

**Only `client-classic-environment-v2` is installed** (for Entity API, Metrics API v2, etc.).

**Correct approach for Config API v1 calls:**

```ts
import { httpClient } from '@dynatrace-sdk/http-client';           // ✅ installed singleton
import { getEnvironmentUrl } from '@dynatrace-sdk/app-environment'; // ✅ installed

const envUrl = getEnvironmentUrl(); // e.g. "https://gmg80500.dev.apps.dynatracelabs.com/"

// List all classic dashboards
const response = await httpClient.send({
  url: `${envUrl}api/config/v1/dashboards`,
  method: 'GET',
});
const json = (await response.body.json()) as { dashboards: Array<{ id: string; name: string }> };

// Fetch individual classic dashboard
const detail = await httpClient.send({
  url: `${envUrl}api/config/v1/dashboards/${id}`,
  method: 'GET',
});
```

The `httpClient` singleton from `@dynatrace-sdk/http-client` handles AppEngine authentication automatically (same as all other SDK clients). No custom auth headers are required.

**`documentsClient` is a pre-instantiated singleton** exported directly from `@dynatrace-sdk/client-document`:
```ts
import { documentsClient } from '@dynatrace-sdk/client-document';  // ✅ singleton, no constructor needed
```

**Verified installed SDK packages relevant to this story:**

| Package | Status | Used for |
|---|---|---|
| `@dynatrace-sdk/client-document` | ✅ installed | New dashboard listing and download via `documentsClient` singleton |
| `@dynatrace-sdk/http-client` | ✅ installed | Config API v1 calls via `httpClient` singleton with user-supplied `Api-Token` header |
| `@dynatrace-sdk/app-environment` | ✅ installed | `getEnvironmentUrl()` for constructing Config API v1 base URL |
| `@dynatrace-sdk/navigation` | ✅ installed | `getDocumentLink(documentId)` for new dashboard deep-links — no manual URL construction needed |
| `@dynatrace-sdk/client-classic-environment-v1` | ❌ NOT installed | **Do not use** — not in package.json, not available |

---

### 3. Scan Structure — Hook + Pure Async Function

The scan must not block the UI while iterating through potentially hundreds of dashboards. Two-layer structure recommended:

**Layer 1: `useDashboardScan` hook** (`ui/app/hooks/useDashboardScan.ts`)
- Manages scan state: `{ isLoading, results, error, scannedCount, totalCount, skippedCount }`
- Calls the scan function on mount; re-triggers when `accountId` or `provider` changes (AC #7)
- Holds an `AbortController` ref for cleanup on unmount/provider change
- Does **not** call `useDql` — this is pure SDK client + HTTP, not a DQL query

```ts
export interface DashboardScanState {
  isLoading: boolean;
  results: DashboardScanResult[];
  error: Error | null;
  scannedCount: number;
  totalCount: number;   // known after pagination phase; -1 until then
  skippedCount: number;
  /** Call to start (or re-start) the scan. The scan does NOT start on mount. */
  run: () => void;
}

/**
 * @param provider  The cloud provider to scan for (determines which patterns are applied)
 * @param token     API token for Config API v1 access. When null, the classic dashboard
 *                  scan phase is skipped — only new dashboards are scanned.
 */
export function useDashboardScan(provider: CloudProvider, token: string | null): DashboardScanState;
```

**Layer 2: Pure async scan function** (defined in same file or a separate `utils/scanDashboards.ts`)
- Not a React hook — no React imports
- Accepts `provider`, `signal` (AbortSignal), and a `onProgress` callback
- Phase A: paginate `listDocuments({ filter: "type = 'dashboard'", adminAccess: true })` using `nextPageKey` loop to collect all document metadata
- Phase B: call `httpClient.send({ url: .../api/config/v1/dashboards })` to get classic dashboard list
- Phase C: process both lists in **batches of 20** using `Promise.allSettled` to avoid blocking the main thread
- Yields to browser between batches: `await new Promise(resolve => setTimeout(resolve, 0))`
- Calls `onProgress({ scanned, total, skipped })` after each batch so the hook can update state and React can re-render

**AbortController / cleanup pattern:**
```ts
// Inside useDashboardScan
const controllerRef = useRef<AbortController>(new AbortController());

useEffect(() => {
  const controller = new AbortController();
  controllerRef.current = controller;
  runScan(provider, controller.signal, handleProgress)
    .then(setResults)
    .catch(handleError);
  return () => controller.abort();
}, [provider, accountId]);
```

**Why not `useReducer`:** simple `useState` for each field is sufficient given the scan is a single sequential async operation with incremental updates. `useReducer` adds complexity without benefit here.

---

### 4. `classicPatterns.ts` — Shape for Stories 002, 003, and 004

`ui/app/utils/classicPatterns.ts` is the shared utility. It must be a pure TypeScript module — no React, no SDK imports.

**Recommended shape:**

```ts
export type CloudProvider = 'aws' | 'azure' | 'gcp';

export interface ClassicPatternSet {
  /**
   * Metric key prefixes that appear in DQL metric queries (new dashboard tiles).
   * Used by: Story 002 (new dashboards), Story 004 (metric events), Story 005 (SLOs).
   */
  dqlMetricPrefixes: string[];

  /**
   * Metric selector prefixes that appear in classic tile configs (Config API v1 JSON).
   * Used by: Story 002 (classic dashboards).
   */
  classicTileMetricPrefixes: string[];

  /**
   * Entity type suffixes for `fetch dt.entity.<type>` detection in DQL strings.
   * Used by: Story 002 (new dashboard DQL tiles).
   */
  classicEntityTypes: string[];
}

export const CLASSIC_PATTERNS: Record<CloudProvider, ClassicPatternSet> = {
  aws: {
    dqlMetricPrefixes: ['dt.cloud.aws.', 'cloud.aws.'],
    classicTileMetricPrefixes: ['builtin:cloud.aws.', 'ext:cloud.aws.', 'cloud.aws.'],
    classicEntityTypes: [
      'ec2_instance', 'ebs_volume', 'aws_lambda_function', 'auto_scaling_group',
      'aws_application_load_balancer', 'aws_network_load_balancer',
      'elastic_load_balancer', 'relational_database_service',
    ],
  },
  azure: {
    dqlMetricPrefixes: ['dt.cloud.azure.', 'cloud.azure.microsoft_'],
    classicTileMetricPrefixes: ['builtin:cloud.azure.', 'ext:cloud.azure.', 'cloud.azure.microsoft_'],
    classicEntityTypes: ['azure_vm', 'azure_sql_server', 'azure_cosmos_db'],  // extend per docs/azure-classic.md
  },
  gcp: {
    dqlMetricPrefixes: ['cloud.gcp.'],
    classicTileMetricPrefixes: ['cloud.gcp.'],  // Confirmed same tile format as AWS/Azure — resolved
    classicEntityTypes: ['custom_device'],       // Flag ALL custom_device when provider is GCP (per Dev Notes)
  },
};

/**
 * Tests a text string against all classic patterns for a given provider.
 * Returns the deduplicated list of matching pattern strings.
 * Pure function — no side effects.
 */
export function detectClassicPatterns(text: string, provider: CloudProvider): string[];
```

**Why this shape is additive for Stories 004 and 005:**
- Story 004 (metric events): uses `dqlMetricPrefixes` to match metric event alert condition expressions — no changes to the struct, just reads the existing field
- Story 005 (SLOs): uses `dqlMetricPrefixes` to match SLO indicator queries — same pattern
- Adding a new provider or new pattern set = add one entry to `CLASSIC_PATTERNS`, zero changes to consumers

---

### 5. Account Detail Page — Tab Shell Architecture

`AccountDetail.tsx` owns the `Tabs` shell. All four `<Tab>` elements are rendered in Story 002. **No page restructure is needed in Stories 003–005** — each story imports its own tab content component and replaces the empty/disabled tab body.

**Imports confirmed in stable `@dynatrace/strato-components`:**
- `Tabs`, `Tab` — `@dynatrace/strato-components/navigation` ✅ stable
- `Chip`, `ChipGroup`, `MessageContainer`, `EmptyState` — `@dynatrace/strato-components/content` ✅ stable
- `ExternalLink` — `@dynatrace/strato-components/typography` ✅ stable
- `DataTable` — `@dynatrace/strato-components/tables` ✅ stable (graduated from preview)
- `ProgressCircle` — `@dynatrace/strato-components/content` ✅ stable

**Recommended file split:**

| File | Purpose | Created by |
|---|---|---|
| `ui/app/pages/AccountDetail.tsx` | Tab shell: reads route params/state, renders page header + `<Tabs>` | Story 001 (stub) → Story 002 (full) |
| `ui/app/components/DashboardsTab.tsx` | Dashboard scan content: `useDashboardScan` hook, loading state, DataTable, empty states, warning banner | Story 002 |
| `ui/app/hooks/useDashboardScan.ts` | Manages scan lifecycle state; calls async scan function | Story 002 |
| `ui/app/utils/classicPatterns.ts` | Provider-agnostic pattern definitions + `detectClassicPatterns()` | Story 002 |
| `ui/app/types/dashboard.ts` | `DashboardScanResult` type; `DashboardFormat` union | Story 002 |

**Tab count callback pattern** (so each tab can update its own count suffix without `AccountDetail` knowing scan internals):

```tsx
// AccountDetail.tsx
const [dashCount, setDashCount] = useState<number | null>(null);

<Tabs selectedIndex={selectedTab} onChange={setSelectedTab} defaultIndex={1}>
  <Tab title="Overview">
    {/* Story 003 populates this — empty in Story 002 */}
  </Tab>
  <Tab title={dashCount !== null ? `Dashboards (${dashCount})` : 'Dashboards'}>
    <DashboardsTab
      provider={provider}
      accountId={accountId}
      onCountChange={setDashCount}   // tab reports its match count upward
    />
  </Tab>
  <Tab title="Metric Events" disabled>
    {/* Story 004 */}
  </Tab>
  <Tab title="SLOs" disabled>
    {/* Story 005 */}
  </Tab>
</Tabs>
```

**Extension pattern for subsequent stories** (zero restructuring):
```tsx
// Story 003 — fills Overview tab and changes defaultIndex:
import { OverviewTab } from '../components/OverviewTab';
// defaultIndex changes from 1 to 0
<Tab title="Overview">
  <OverviewTab provider={provider} accountId={accountId} />
</Tab>

// Story 004 — enables Metric Events tab (removes `disabled`, adds content + count):
import { MetricEventsTab } from '../components/MetricEventsTab';
const [meCount, setMeCount] = useState<number | null>(null);
// ...
<Tab title={meCount !== null ? `Metric Events (${meCount})` : 'Metric Events'}>
  <MetricEventsTab provider={provider} accountId={accountId} onCountChange={setMeCount} />
</Tab>
```

---

### 6. `DashboardScanResult` Type

Defined in `ui/app/types/dashboard.ts`. Shared between the hook, the service function, and the table column definitions.

```ts
export type DashboardFormat = 'classic' | 'new';
export type DashboardOwnership = 'custom' | 'preset' | 'ready-made';

export interface DashboardScanResult {
  id: string;
  name: string;
  /** Direct deep-link URL to open this dashboard in the Dynatrace UI */
  url: string;
  format: DashboardFormat;
  /**
   * 'preset'      — classic dashboard where dashboardMetadata.preset === true
   * 'ready-made'  — new dashboard where originAppId is non-null (shipped by a Dynatrace app)
   * 'custom'      — user-created dashboard; primary migration concern
   */
  ownership: DashboardOwnership;
  /** Deduplicated list of matched classic metric key prefixes / patterns */
  classicPatterns: string[];
}
```

**Deep-link URL construction:**
- **New dashboards**: `getDocumentLink(documentId)` from `@dynatrace-sdk/navigation` ✅ installed — returns the correct environment URL without manual construction. `[Source: node_modules/@dynatrace-sdk/navigation — get-document-link.d.ts]`
- **Classic dashboards**: URL format is unknown — see Open Question #1 in the Open Questions section. Isolate in a `buildClassicDashboardUrl(id: string): string` helper so the pattern can be patched without touching scan logic. Candidate: `` `${getEnvironmentUrl()}ui/dashboarding/dashboard/${id}` ``.

---

### 7. Scope Changes Required in `app.config.json`

Current scopes (verified in `app.config.json`):
- `storage:entities:read`, `storage:metrics:read`, `settings:objects:read`, `storage:logs:read`, `storage:buckets:read`

**Story 002 must add:**
```json
{ "name": "document:documents:read", "comment": "List and fetch new dashboards (Document Service)" },
{ "name": "document:documents:admin", "comment": "Scan dashboards owned by other users — confirmed available without special approval" }
```

**Config API v1** requires a `ReadConfig` API token, **not** an OAuth scope. No `app.config.json` entry is needed for this — the user supplies the token at runtime. The token must be stored in a shared React context so Stories 004 and 005 can reuse it without re-prompting.

---

### 8. Files to Create (Story 002 Only)

| File | Status | Notes |
|---|---|---|
| `ui/app/context/TokenContext.tsx` | Create new | `TokenContext`, `TokenProvider`, `useToken()` — holds `string | null` in `useState`; shared by Stories 002/004/005 (dependency scan tabs) |
| `ui/app/pages/AccountDetail.tsx` | Replace stub from Story 001 | Tab shell, page header, route state reading, inline token prompt |
| `ui/app/components/DashboardsTab.tsx` | Create new | Scan UI: loading, table, empty states, warning banner |
| `ui/app/hooks/useDashboardScan.ts` | Create new | Scan lifecycle state; drives `DashboardsTab` |
| `ui/app/utils/classicPatterns.ts` | Create new | Shared with Stories 003 and 004 |
| `ui/app/types/dashboard.ts` | Create new | `DashboardScanResult`, `DashboardFormat`, `DashboardOwnership` |

### Files to Modify (Story 002 Only)

| File | Change |
|---|---|
| `ui/app/App.tsx` | Wrap router tree with `<TokenProvider>` so all downstream components can `useToken()` without prop-drilling |
| `app.config.json` | Add `document:documents:read` and `document:documents:admin`. No entry needed for Config API v1 — it uses a user-supplied API token, not OAuth. |

### Files NOT to Touch

| File | Why |
|---|---|
| `ui/app/components/Header.tsx` | No new nav link needed — account detail is reached via row click, not top-level nav |
| `ui/app/components/Header.tsx` | No new nav link needed — account detail is reached via row click, not top-level nav |
| `ui/app/types/connection.ts` | Owned by Story 001 — do not modify; only read `CloudProvider` from it |
| `ui/app/pages/Inventory.tsx` | Owned by Story 001 |

---

### 9. Implementation Order

1. **`ui/app/context/TokenContext.tsx`** — Define `TokenContext`, `TokenProvider`, `useToken()`. Pure React context, no SDK deps. Wrap router tree in `App.tsx` with `<TokenProvider>` immediately.
2. **`ui/app/types/dashboard.ts`** — Define `DashboardFormat`, `DashboardOwnership`, `DashboardScanResult`. No dependencies.
3. **`ui/app/utils/classicPatterns.ts`** — Define `CLASSIC_PATTERNS` and `detectClassicPatterns()`. Pure functions, no deps. Write unit tests immediately — this is testable in isolation.
4. **`ui/app/hooks/useDashboardScan.ts`** — Implement scan hook + async scan function. Accepts `token: string | null`; skips Config API v1 phase when `token` is null. Depends on types + classicPatterns.
5. **`ui/app/components/DashboardsTab.tsx`** — Build UI that consumes the hook. Reads `token` from `useToken()` and passes it to the hook. Depends on hook + types.
6. **`ui/app/pages/AccountDetail.tsx`** — Wire tab shell + inline token prompt; import DashboardsTab. Depends on DashboardsTab.
7. **`app.config.json`** — Add `document:documents:read` and `document:documents:admin`. No Config API v1 scope entry needed.

---

### 10. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Classic dashboard deep-link URL format unknown (Open Question #1) | Isolate in `buildClassicDashboardUrl()` helper; `getDocumentLink()` from `@dynatrace-sdk/navigation` solves the new dashboard case cleanly. |
| `document:documents:admin` availability | Confirmed available — add to `app.config.json`. No risk. |
| User doesn't supply API token for Config API v1 | Show a clear prompt; classic dashboard scan is skipped (or deferred) until token is provided. New dashboard scan runs independently. |
| Large environments (500+ dashboards) cause perceived hang | Batch processing + `onCountChange` progress updates ensure incremental UI updates. |
| GCP classic tile metric pattern (previously unconfirmed) | Confirmed same format as AWS/Azure — no additional risk. |
