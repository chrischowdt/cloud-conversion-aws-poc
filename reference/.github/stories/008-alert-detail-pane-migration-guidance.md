# User Story: Alert Detail Pane — Migration Guidance per Alert

**Status**: In Progress
**Category**: Assessment / Guidance
**Migration Phase**: Prepare

## Story Statement

**As a** Dynatrace Administrator,
**I want** to click on an alert in the scan results and see a detail panel showing the exact classic dependency, whether the alert can be migrated, and a best-effort DQL suggestion using new connection metrics,
**so that** I can understand what each alert monitors, assess the migration effort, and have a concrete starting point for recreating it on the new connection.

## Context

Story 004 established the Alerts tab, which scans for alert configurations that reference classic cloud metrics and presents them as a flat table. That story deliberately deferred deeper per-alert intelligence to keep scope focused.

This story adds the next layer of value: clicking an alert row opens a side panel that shows *what* the alert monitors in full detail, *whether* a migration path exists, and *how* to express that monitoring on the new connection. This transforms the scan from a pure inventory tool into an actionable migration guide — directly serving Capability #3 (Migration Readiness) from the vision document. `[Source: .github/prompts/vision.prompt.md#Capabilities]`

The detail pane does not require any additional API calls for its core content. The raw metric expressions and alert conditions are available from the settings objects already retrieved during the scan; they are simply not being stored yet. The DAC mapping tables (`docs/dac-{aws,azure}-to-2ndgen-metrics.json`) already contain the classic → new metric key mappings needed to produce the suggested DQL. `[Source: docs/dac-aws-to-2ndgen-metrics.json]` `[Source: docs/dac-azure-to-2ndgen-metrics.json]`

**Important constraint**: the app is read-only. The detail pane is purely informational — it does not modify any alert configuration. `[Source: .github/prompts/vision.prompt.md#Constraints]`

## Acceptance Criteria

1. **Given** the Alerts tab has completed a scan with results, **when** a user clicks any row in the results table, **then** a side panel opens without navigating away, showing detailed information for the selected alert.

2. **Given** the detail panel is open, **when** the user views it, **then** it displays at minimum:
   - The alert name and type badge
   - The alert's enabled/disabled status
   - The **raw classic expression(s)** detected (full `metricKey`, `metricSelector`, or analyzer input field values — not just the extracted key tokens shown in the table)
   - A **migration assessment** badge: `Migratable` (all detected classic keys have a known new equivalent) or `Review Required` (one or more keys have no known mapping)
   - A **suggested new DQL** section (see AC #3)

3. **Given** the detail panel is open for a `metric-event` or `davis-ai` alert that has at least one mappable classic metric key, **when** the user views the suggested DQL section, **then** it shows a best-effort DQL `timeseries` query substituting each detected classic metric key with its `dacMetricKey` from the DAC mapping table. The section is clearly labelled "Suggested DQL — review before use" to communicate that it is a starting point, not a verified migration. If a key is not in the mapping table at all (`found=false`), the original key is preserved in the suggestion with a "Keys without mapping" warning. If a key is in the mapping table but has `dacMetricKey="not-matched"` (the metric has no recommended equivalent in the new connection), the DQL is **suppressed entirely** and replaced with a contextual message (see AC #12).

4. **Given** the detail panel shows a suggested DQL, **when** the user clicks the copy button on the CodeSnippet, **then** the full suggested DQL string is written to the clipboard and a brief confirmation toast is shown.

5. **Given** a `metric-event` alert uses a `metricKey` (not a `metricSelector`), **when** shown in the detail panel, **then** the raw expression section displays the metric key as-is (e.g., `builtin:cloud.aws.ec2.cpuUsage`). If the alert uses a `metricSelector`, the full selector expression is displayed verbatim.

6. **Given** a `davis-ai` alert is selected, **when** the panel opens, **then** the raw expression section displays all analyzer input field values that contained classic patterns. Each input field value is shown separately (the Davis AI analyzer can have multiple inputs). The suggested DQL attempts key substitution on each input value separately.

7. **Given** an `infrastructure-detection` alert is selected, **when** the panel opens, **then** the detail panel displays a static explanation: "This is a built-in infrastructure anomaly detection settings object. It does not use an explicit metric query — review manually whether the new connection's built-in anomaly detection covers the same service." The migration assessment badge shows `Review Required`. No suggested DQL is generated. **This is an interim behaviour** — see Open Questions for the planned follow-up.

8. **Given** the detail panel is open, **when** the user clicks outside the panel or presses Escape, **then** the panel closes and the table is fully visible again.

9. **Given** the alert has `enabled: false`, **when** the detail panel is open, **then** the disabled status is prominently visible (not just a chip — include a short note: "This alert is currently disabled. It will still fail to fire on new connection data if not migrated.").

10. **Given** the detail panel is open for an alert with multiple classic patterns (e.g., a metric selector combining several classic keys), **when** the migration assessment is computed, **then** `Migratable` is only shown if **all** detected classic keys have a known `dacMetricKey` (not `"not-matched"`) in the mapping table. If even one key has no mapping or is explicitly `"not-matched"`, the badge shows `Review Required`.

11. **Given** the scan results table has the detail panel open, **when** the user clicks a different row, **then** the panel updates to show the newly selected alert without closing.

12. **Given** the detail panel is open for an alert where a classic key is found in the mapping table but has `dacMetricKey="not-matched"` (the metric has no recommended equivalent in the new connection out-of-the-box), **when** the user views the Suggested DQL section, **then** the DQL is suppressed and **two dedicated banners** are shown:

    **Banner 1 — Namespace/service support status** (always shown for a `not-matched` key):
    - `variant="success"` (green) when the CloudWatch namespace (AWS) or ARM resource type (Azure) is supported by the new connection (i.e., has ≥1 other metric with a valid `dacMetricKey`). Text confirms the namespace is available and that additional metrics can be added as [custom CloudWatch metrics](https://docs.dynatrace.com/docs/shortlink/aws-cloudwatch-metrics#advanced-metric-ingest-use-cases).
    - `variant="warning"` (amber) when the namespace/service is not supported at all. Text explains the namespace is not currently supported and links to the custom metric ingest docs so the user knows an alternative path exists.

    **Banner 2 — Metric not in recommended set** (shown only when the namespace IS supported):
    - `variant="neutral"`. Displays the short metric name (prefix `ext:`/`builtin:` and `cloud.aws.`/`cloud.azure.` stripped) plus the namespace in parentheses. Links to the [recommended vs. custom metrics docs](https://docs.dynatrace.com/docs/shortlink/aws-cloudwatch-metrics#mcs) for AWS. Explains the user can add it as a custom metric in connection settings.
    - Omitted entirely when the namespace is not supported (the warning banner in step 1 already covers the remediation path).

    All `MessageContainer.Description` content is wrapped in a `<div style={{ wordBreak: 'break-word' }}>` to ensure responsive text flow at any panel width (avoids flexbox column layout on narrow viewports).

    For GCP, since no mapping table exists yet, the existing "GCP metric mapping not available — review manually" message in the Migration Assessment section covers this case; the DQL section is not shown for GCP alerts.

13. **Given** the duplicate-key extraction bug where `ext:cloud.aws.X` also generates a spurious `cloud.aws.X` entry in `classicPatterns` (causing false "Keys without mapping" warnings and false "Review Required" assessments), **when** the `extractClassicMetricKeys` utility is called, **then** sub-matches embedded inside longer prefixed keys (e.g., `cloud.aws.` inside `ext:cloud.aws.`) are skipped. Fixed by adding a guard in `extractClassicMetricKeys` that skips any match where the preceding character is `:`.

14. **Given** the Migration Assessment badge in the detail panel, **when** the alert has all keys directly mapped in the DAC mapping table, **then** the badge shows `Migratable` (success/green). This was previously broken by the duplicate-key bug and is now fixed.

15. **Given** the detail panel is open for a `metric-event` alert, **when** the user views the Classic Expression section, **then** an **"Open in Classic Settings"** `IntentButton` is rendered below the expression `CodeSnippet`. The button sends the `dynatrace.classic.settings / settings-open-settings-by-id` intent, passing `alert.id` (the Settings V2 `objectId`) as the `dt.settings.object_id` payload property. This deep-links directly to the specific settings object within the Classic Settings app.
    - Intent confirmed via `dtctl find intents --data "dt.settings.object_id=<id>"`: app ID `dynatrace.classic.settings`, intent ID `settings-open-settings-by-id`, required prop `dt.settings.object_id` (string).
    - Implementation: `IntentButton` from `@dynatrace/strato-components/buttons`; payload typed as `IntentPayload` from `@dynatrace-sdk/navigation`; `variant="default" color="neutral"`.
    - This link is only shown for `metric-event` alerts (the only alert type that uses this schema).

16. **Given** the detail panel shows a suggested DQL for a `migratable` `metric-event` or `davis-ai` alert, **when** the component renders, **then** a **metric ingestion check** banner appears below the `DqlSuggestionBlock`. The banner:
    - Issues a live DQL probe: `fetch metric.series, from:now()-24h | filter metric.key == "<dacMetricKey>" | limit 1` (single key) or the multi-key equivalent using `in(metric.key, array(...))`.
    - While the query is in flight: renders a `ProgressCircle` (size="small") with the label "Checking metric ingestion…".
    - On success with data: `MessageContainer variant="success"` — "Metric is being ingested — data found in the last 24 hours."
    - On success with no data: `MessageContainer variant="warning"` — instructs the user to verify their new cloud connection is configured to ingest this metric; notes that recently-enabled connections can take up to 24 hours to appear.
    - On error: `MessageContainer variant="neutral"` — non-fatal fallback explaining the check was unavailable.
    - The check is skipped (not rendered) when `migratable === false`, `mappedKeys` is empty, or the provider is GCP.
    - Scope used: `storage:metrics:read` (already present in `app.config.json`).

17. **Given** the detail panel shows a suggested DQL for a `migratable` `metric-event` or `davis-ai` alert with `dql !== null`, **when** the user views the panel, **then** a **"Create Anomaly Detector"** `IntentButton` renders below the `MetricIngestionCheck` banner. The button sends the `dynatrace.davis.anomalydetection / create_anomaly_detector_in_modal` intent with the following pre-populated payload:
    - `dt.query`: the suggested DQL (required)
    - `sourceApplication`: `"my.cloud.migration.helper"` (required)
    - `davis.anomalydetector.title`: the classic alert name
    - `davis.anomalydetector.executionSettings.queryOffset`: `12` (minutes, hardcoded default)
    - `davis.analyzer` (when available):
      - **`davis-ai` alerts**: the complete analyzer taken as-is from `rawAnalyzer`, with only the embedded `query` input value replaced by the suggested DQL
      - **`metric-event` STATIC_THRESHOLD alerts**: a reconstructed analyzer (`StaticThresholdAnomalyDetectionAnalyzer`) with `threshold`, `alertCondition`, `alertOnMissingData`, `violatingSamples`, `slidingWindow` (from `modelProperties.samples`), and `dealertingSamples` captured from the classic alert
      - **Other `metric-event` types** (baseline, relative): `davis.analyzer` omitted; user configures in modal
    - A neutral info banner precedes the button noting that the user should review and adjust settings before saving.

## Tasks / Subtasks

- [x] Task 1: Extend `AlertResult` type to carry raw expressions (AC: #2, #5, #6)
  - [x] Add `rawExpression?: string` to `AlertResult`
  - [x] Add `rawAnalyzerInputs?: string[]` to `AlertResult`
  - [x] Update `scanMetricEvents` in `useAlertScan.ts` to populate `rawExpression`
  - [x] Update `scanDavisDetectors` in `useAlertScan.ts` to populate `rawAnalyzerInputs`

- [x] Task 2: Implement metric key lookup utility (AC: #3, #10, #12, #13)
  - [x] `ui/app/utils/metricKeyMapping.ts` — module-level index maps, `lookupMetricKey`, `isMigratable`
  - [x] Schema updated from single `dacMetricKey` field to `dacRecommendedMetricKey` + `dacAutodiscoveredMetricKey` + `endOfLife` per entry
  - [x] `MetricKeyLookupResult` now includes `namespace`, `isRecommended`, and `endOfLife` fields
  - [x] Lookup prefers `dacRecommendedMetricKey`; falls back to `dacAutodiscoveredMetricKey`. Coverage: 100% of AWS and Azure entries now have a resolvable DAC key.
  - [x] `isServiceSupported(namespace, provider)` — returns true when the namespace/service has ≥1 metric with a valid DAC key (recommended or autodiscovered)
  - [x] `hasEndOfLifeMetrics(classicKeys, provider)` — returns true when any key resolves to an EOL-flagged metric
  - [x] `getEndOfLifeInfo(namespace, provider)` — returns EOL date and announcement URL from `end-of-life-services.json` (Azure only; AWS CW namespaces do not map to the file's CloudFormation-style keys)
  - [x] `EndOfLifeInfo` interface exported for use in UI components
  - [x] Module-level `AWS_SUPPORTED_NAMESPACES` and `AZURE_SUPPORTED_SERVICES` sets computed at load time
  - [x] EOL info map built at load time from `docs/end-of-life-services.json`

- [x] Task 3: Fix duplicate-key extraction bug in `classicPatterns.ts` (AC: #13, #14)
  - [x] Added sub-prefix guard in `extractClassicMetricKeys`: skip any match where `lowerText[idx-1] === ':'`
  - [x] Added regression tests in `classicPatterns.test.ts` for `extractClassicMetricKeys` covering: ext:, builtin:, standalone cloud.aws., and multi-key expressions

- [x] Task 4: Create `AlertDetailPanel` component (AC: #1–#11, #14)
  - [x] `DqlSuggestion` type: `{ dql: string | null, unmappedKeys: string[], notMatchedKeys: NotMatchedKey[] }`
  - [x] `buildSuggestedDql`: suppresses DQL (`dql=null`) when any key is `not-matched`; populates `notMatchedKeys` with namespace and `namespaceSupported` flag
  - [x] `shortMetricName` helper: strips `ext:`/`builtin:` prefix and `cloud.aws.`/`cloud.azure.` provider prefix so only the meaningful part (e.g. `storagegateway.cachePercentDirtyByRegionShareId`) is displayed in messages
  - [x] `NotMatchedMessage` component: renders two `MessageContainer` banners per `NotMatchedKey` — (1) namespace support status (`variant="success"` or `variant="warning"`), (2) metric-not-in-recommended-set detail (`variant="neutral"`, only when namespace is supported). Uses `ExternalLink` from `@dynatrace/strato-components/typography` for docs links. All `MessageContainer.Description` content wrapped in `<div style={{ wordBreak: 'break-word' }}>` for responsive layout.
  - [x] `DqlSuggestionBlock` sub-component: renders CodeSnippet (when `dql !== null`), `NotMatchedMessage` banners, and unmapped-key warning
  - [x] GCP alerts excluded from DQL section (`provider !== 'GCP'` guard on `hasDql`); GCP handled fully by Migration Assessment section
  - [x] Migration assessment `migratable` now correctly short-circuits for GCP (returns false, consistent with chip render)

- [x] Task 5: Wire row click in `AlertsTab` to open detail panel (AC: #1, #11) — implemented in Story 008 scope
  - [x] `selectedAlert` state, `interactiveRows`, `onActiveRowChange`, `activeRow`, `AlertDetailPanel` render

- [x] Task 6: Add Migration Assessment column to `AlertsTab` (AC: Story 004 AC #3)
  - [x] New column between Type and Status badges using `isMigratable` and `hasEndOfLifeMetrics` from `metricKeyMapping.ts`
  - [x] `Chip` three-state: `End of Life` (critical/red) when any key is EOL; `Migratable` (success) when all keys resolve and none are EOL; `Review Required` (warning) otherwise
  - [x] `infrastructure-detection` and GCP always show `Review Required`
  - [x] `useMemo` deps updated to include `provider`

- [x] Task 10: EOL awareness and autodiscovery hints in `AlertDetailPanel` (new in metric mapping schema update)
  - [x] `eolInfoItems` useMemo: collects EOL date + announcement URL per affected namespace (de-duplicated)
  - [x] Migration Assessment section: `End of Life` chip (critical) when EOL detected; EOL `MessageContainer` banners with date, service name, and announcement link
  - [x] `DqlSuggestion` extended with `autodiscoveredKeys: string[]`
  - [x] `buildSuggestedDql` tracks which keys were resolved via autodiscovery
  - [x] `DqlSuggestionBlock` shows neutral `MessageContainer` banner listing keys resolved via autodiscovery

- [x] Task 7: Add Classic Settings deep-link for metric-event alerts (AC: #15)
  - [x] `IntentButton` from `@dynatrace/strato-components/buttons` rendered below the raw expression `CodeSnippet` in the "Classic Expression" section
  - [x] Payload: `{ 'dt.settings.object_id': alert.id }` typed as `IntentPayload` from `@dynatrace-sdk/navigation`
  - [x] Options: `{ recommendedAppId: 'dynatrace.classic.settings', recommendedIntentId: 'settings-open-settings-by-id' }`
  - [x] Intent confirmed via `dtctl find intents`: app `dynatrace.classic.settings`, intent `settings-open-settings-by-id`, required prop `dt.settings.object_id`
  - [x] Deep-links directly to the specific settings object — no longer schema-level; objectId routing works via the intent system (not via URL path, which was correctly ruled out)

- [x] Task 8: Add metric ingestion check (`MetricIngestionCheck` component) (AC: #16)
  - [x] `DqlSuggestion` extended with `mappedKeys: string[]` — populated by `buildSuggestedDql` alongside the DQL string
  - [x] `MetricIngestionCheck` sub-component: receives `dacMetricKeys: string[]`; calls `useDql` unconditionally (separate component to satisfy Rules of Hooks); builds single-key or multi-key `fetch metric.series` probe for the last 24h
  - [x] Loading state: `ProgressCircle` (`@dynatrace/strato-components/content`) with inline label
  - [x] Rendered below each `DqlSuggestionBlock` only when `migratable === true && suggestion.mappedKeys.length > 0`
  - [x] Import: `ProgressCircle` added to `@dynatrace/strato-components/content` import; `useDql` added from `@dynatrace-sdk/react-hooks`

- [x] Task 9: Add "Create Anomaly Detector" action (`CreateDetectorAction` component) (AC: #17)
  - [x] `AlertResult` extended with `rawModelProperties?: {...}` (metric-event STATIC_THRESHOLD) and `rawAnalyzer?: { name, input[] }` (davis-ai)
  - [x] `scanMetricEvents`: captures `modelProperties` (threshold, alertCondition, violatingSamples, dealertingSamples, alertOnNoData, samples) into `rawModelProperties` when type is STATIC_THRESHOLD or queryType is METRIC_KEY
  - [x] `scanDavisDetectors`: captures full `val.analyzer` object into `rawAnalyzer`
  - [x] `buildDetectorPayload` module-level function: constructs the intent payload; for `davis-ai` alerts passes analyzer as-is with only the embedded `query` input substituted; for `metric-event` STATIC_THRESHOLD reconstructs the analyzer from `rawModelProperties`; always sets `queryOffset=12` and `title=alert.name`
  - [x] `CreateDetectorAction` sub-component: renders `MessageContainer variant="neutral"` disclaimer + `IntentButton` (`dynatrace.davis.anomalydetection/create_anomaly_detector_in_modal`)
  - [x] Rendered after each `MetricIngestionCheck` when `migratable === true && suggestion.dql !== null`
  - [x] Intent confirmed via `dtctl get intent`: app `dynatrace.davis.anomalydetection`, intent `create_anomaly_detector_in_modal`, required props `dt.query` + `sourceApplication`; optional `davis.analyzer` (object) + `davis.anomalydetector` (object)
  - [x] Analyzer name for reconstructed STATIC_THRESHOLD payloads: `dt.statistics.ui.anomaly_detection.StaticThresholdAnomalyDetectionAnalyzer` (confirmed from live `builtin:davis.anomaly-detectors` object)
  - [x] `modelProperties.samples` field confirmed from live `builtin:anomaly-detection.metric-events` object — maps directly to Davis AI `slidingWindow`

---
## ARCHITECTURAL ANALYSIS
*Generated by architect agent on 2026-04-10*

### Current Architecture Context

**Relevant existing files:**
- `ui/app/types/alert.ts` — `AlertResult` interface (5 fields, all mandatory). `rawExpression` and `rawAnalyzerInputs` are new optional additions.
- `ui/app/hooks/useAlertScan.ts` — All three sub-scan functions. `scanMetricEvents` already captures `metricText` (the full expression) but discards it. `scanDavisDetectors` accumulates matching `textsToScan` but doesn't store them.
- `ui/app/components/AlertsTab.tsx` — Renders `<DataTable columns={ALERT_COLUMNS} data={results} sortable resizable />`. No `interactiveRows`, no row-click handler, no `selectedAlert` state. This is the primary wiring site for Task 4.
- `ui/app/App.tsx` — Wraps routes in `<Page>` and `<TokenProvider>`. **No `<ToastContainer />` present.** Must be added once for `showToast` to work across the app.
- `ui/tsconfig.json` — **`resolveJsonModule` is NOT set.** This is a blocker for JSON module imports (see Finding #1 below).
- `docs/dac-aws-to-2ndgen-metrics.json` — 4,168 entries, 1.47 MB, fields: `cloudwatchNamespace`, `cloudwatchMetricName`, `cloudwatchDimensions`, `secondGenMetricKey`, `dacMetricKey`, `builtInMetricKey`.
- `docs/dac-azure-to-2ndgen-metrics.json` — 3,351 entries, 1.53 MB, fields: `armResourceType`, `armResourceKind`, `armSkuName`, `azureMonitorMetricName`, `azureMonitorDimensions`, `builtInMetricKey`, **`supportingServiceMetricKey`**, `dacMetricKey`. **No `secondGenMetricKey` field** (see Finding #2 below).

**Established patterns:**
- Hook scan pattern: `useAlertScan`, `useDashboardScan`, `useSloScan` — all follow the same `idle → scanning → done` phase + `Promise.allSettled` structure.
- Strato import pattern: sub-package imports confirmed across all existing component files (`/buttons`, `/content`, `/layouts`, `/tables`, `/typography`).
- `DataTable` interactive rows: not yet used in the codebase — this story is the first. Follow the Strato `interactiveRows` + `onActiveRowChange` pattern per Task 4 notes.

---

### Finding #1 — BLOCKER: `resolveJsonModule` not set in `ui/tsconfig.json`

`ui/tsconfig.json` has no `"resolveJsonModule": true` setting. Without it, TypeScript will reject any `import X from '*.json'` statement with: *"Consider using '--resolveJsonModule' to import module '*.json'"*.

**Fix required:** Add `"resolveJsonModule": true` to `ui/tsconfig.json` compilerOptions.

**rootDir constraint does NOT apply to JSON imports.** The `"rootDir": "."` setting in `ui/tsconfig.json` restricts where TypeScript source files (`.ts`/`.tsx`) must reside, but JSON imports are data — TypeScript does not emit JSON files and does not enforce `rootDir` on them.

**Bundler path is clear.** The `dt-app` toolkit sets Vite's `root` to `process.cwd()` (the workspace root, `cloud-migration-helper/`). Vite natively handles JSON imports via relative paths. A relative import from `ui/app/utils/metricKeyMapping.ts` to `docs/dac-aws-to-2ndgen-metrics.json` resolves as `'../../../docs/dac-aws-to-2ndgen-metrics.json'` — within Vite's reachable tree.

**Risk flag:** If a future dt-app version restricts the Vite source root to `ui/`, these imports will break silently at build time. Consider copying the two JSON files to `ui/app/data/` as a more stable location. This is optional for this story but worth noting.

---

### Finding #2 — RISK: Azure JSON has `supportingServiceMetricKey`, not `secondGenMetricKey`

The story's Task 2 description states:
> "The lookup must check all three fields (`builtInMetricKey`, `secondGenMetricKey`, `dacMetricKey`) against the input key for each provider's table"

This is incorrect in two ways:

1. **The Azure mapping table has no `secondGenMetricKey` field.** The equivalent field is named `supportingServiceMetricKey` (contains `ext:cloud.azure.*` keys). The lookup utility must use `secondGenMetricKey` for AWS and `supportingServiceMetricKey` for Azure — these are the "classic ext format" keys in each table.

2. **`dacMetricKey` must NOT be used as a lookup input field.** It is the new-connection metric key (e.g., `cloud.aws.sagemaker_endpoint.CPUUtilization.By.EndpointName.VariantName`). Users will never have this key in a classic alert configuration — it is the output of the lookup, not a search key.

**Corrected lookup logic for `metricKeyMapping.ts`:**
- For a given `classicKey` string and `provider`:
  - AWS: search for records where `builtInMetricKey === classicKey` OR `secondGenMetricKey === classicKey`
  - Azure: search for records where `builtInMetricKey === classicKey` OR `supportingServiceMetricKey === classicKey`
- Return the matched record's `dacMetricKey` (or `null` if not found)
- `isMigratable` returns `true` only when the returned `dacMetricKey` is non-null AND not `"not-matched"`

**Additional note on `dt.cloud.aws.*` / `dt.cloud.azure.*` prefix:** The `classicPatterns.ts` detects these prefixes as classic patterns, but neither mapping table indexes keys with the `dt.cloud.*` prefix. Alerts using this older format will always receive a `Review Required` assessment with no DQL suggestion. Document this limitation in the utility.

---

### Finding #3 — DATA: Scale and index-on-load assessment

| File | Entries | Size (uncompressed) | `dacMetricKey = "not-matched"` |
|------|---------|---------------------|-------------------------------|
| `dac-aws-to-2ndgen-metrics.json` | 4,168 | 1.47 MB | 3,076 (74%) |
| `dac-azure-to-2ndgen-metrics.json` | 3,351 | 1.53 MB | unknown |

**Bundle size:** ~3 MB combined uncompressed; ~0.5–0.6 MB gzip-compressed. Acceptable for a Dynatrace admin tool, but this is the largest static asset in the app by an order of magnitude.

**Index-on-load is sound.** Building two `Map<string, entry>` structures from ~7,500 entries on module load takes < 1 ms in V8. The module-level index approach (compute once, re-use) is correct. The index must map both the `builtInMetricKey` and the provider-specific ext-format field to the same record, so each entry creates two map insertions (skipping `"not-matched"` values).

---

### Files to Create

- **`ui/app/utils/metricKeyMapping.ts`** — Metric key lookup utility
  - Pattern: Follow the module-level constant style of `ui/app/utils/classicPatterns.ts`
  - Exports: `lookupMetricKey(classicKey: string, provider: CloudProvider): { dacMetricKey: string | null; found: boolean }`, `isMigratable(classicKeys: string[], provider: CloudProvider): boolean`
  - Build one `Map` per provider on module load; skip entries where the source key is `"not-matched"` or empty
  - Use `secondGenMetricKey` for AWS, `supportingServiceMetricKey` for Azure (not `secondGenMetricKey` for both)
  - For GCP or unknown provider: immediately return `{ dacMetricKey: null, found: false }`

- **`ui/app/components/AlertDetailPanel.tsx`** — Detail pane component
  - Pattern: Follow `ui/app/components/AlertsTab.tsx` for Strato import style
  - Props: `alert: AlertResult; provider: CloudProvider; onClose: () => void`
  - Uses `Sheet` from `@dynatrace/strato-components/overlays` (always rendered with `show={true}` — caller controls mounting)
  - Uses `CodeSnippet` from `@dynatrace/strato-components/content` for DQL display — use `onCopy` callback, not a separate Button + `navigator.clipboard.writeText`
  - Uses `showToast` from `@dynatrace/strato-components/notifications` in the `onCopy` callback
  - No internal state beyond what the Sheet needs; all data comes from props

### Files to Modify

- **`ui/tsconfig.json`** — Add `"resolveJsonModule": true` to `compilerOptions` *(REQUIRED — this is a build blocker)*

- **`ui/app/types/alert.ts`** — Extend `AlertResult` with two optional fields
  - Add `rawExpression?: string` after `classicPatterns` — for `metric-event` alerts, the full `metricKey` or `metricSelector` string
  - Add `rawAnalyzerInputs?: string[]` after `rawExpression` — for `davis-ai` alerts, the input field values that matched classic patterns (not all inputs — only those where `detectClassicMetricPatterns` returned results)

- **`ui/app/hooks/useAlertScan.ts`** — Populate the new fields
  - `scanMetricEvents`: `metricText` is already computed at line ~31 — add `rawExpression: metricText` to the pushed `AlertResult` object
  - `scanDavisDetectors`: change the inner loop to collect the `text` values that matched (where `detectClassicMetricPatterns(text, provider).length > 0`) into a separate `matchingInputs: string[]` array; add `rawAnalyzerInputs: matchingInputs` to the pushed `AlertResult` object

- **`ui/app/components/AlertsTab.tsx`** — Add interactivity
  - Add `selectedAlert: AlertResult | null` state (initialize `null`)
  - Change `<DataTable ... />` invocation: add `interactiveRows`, `onActiveRowChange={(id) => setSelectedAlert(results.find(r => r.id === id) ?? null)}`, and `activeRow={selectedAlert?.id ?? null}`
  - Add the `rowId` accessor — `AlertResult.id` is `obj.objectId` from the Settings V2 API, which is a stable UUID and safe as a row identifier
  - Render `<AlertDetailPanel alert={selectedAlert} provider={provider} onClose={() => setSelectedAlert(null)} />` conditionally when `selectedAlert !== null`
  - The `DataTable` and panel need to render side-by-side; wrap the results section in a `<Flex>` row when panel is open. Use a `<Flex flexDirection="row" gap={16}>` to contain both.

- **`ui/app/App.tsx`** — Add `<ToastContainer />`
  - Import: `import { ToastContainer } from '@dynatrace/strato-components/notifications';`
  - Place `<ToastContainer />` as a sibling inside `<TokenProvider>`, after `<Page>` — it renders a portal and does not affect layout

### Files NOT to Touch

- `ui/app/hooks/useAccountOverview.ts` — Account-level data hook; unrelated
- `ui/app/hooks/useConnectionInventory.ts` — Connection inventory; unrelated
- `ui/app/pages/AccountDetail.tsx` — Account detail page; separate concern
- `ui/app/utils/classicPatterns.ts` — Pattern detection utility is already correct; do not extend it for this story
- `docs/dac-aws-to-2ndgen-metrics.json` / `docs/dac-azure-to-2ndgen-metrics.json` — Read-only data assets; do not modify

### Similar Implementations Reference

- **`ui/app/hooks/useAlertScan.ts`** — Pattern for sub-scan data capture. The `metricText` variable in `scanMetricEvents` (around line 31) is the exact value to store as `rawExpression`.
- **`ui/app/utils/classicPatterns.ts`** — Pattern for a module-level constant Map / lookup structure. Follow this file's style for `metricKeyMapping.ts`.
- **`ui/app/components/AlertsTab.tsx`** — Template for Strato imports and DataTable usage in this codebase.

### Architectural Validation

✅ **No new scopes required** — JSON assets are bundled; detail pane uses data already in `AlertResult`  
✅ **Data model extension is correct** — Optional fields on `AlertResult` are the right approach; no separate type or on-demand fetch needed  
✅ **`Sheet` component confirmed** — `SidePanel` does not exist as a Strato component (story already notes this correctly)  
✅ **`CodeSnippet` + `onCopy` pattern is correct** — Eliminates the need for manual Clipboard API; consistent Strato UX  
⚠️ **`resolveJsonModule` must be added** — Without it the build fails at the first JSON import  
⚠️ **Azure JSON field name discrepancy** — Task 2 lookup spec references `secondGenMetricKey` for both providers; Azure uses `supportingServiceMetricKey` — must be corrected in implementation  
⚠️ **`dacMetricKey` is output, not a lookup input** — Remove it from the "fields to check against input key" spec in Task 2  
💡 **`dt.cloud.aws.*` / `dt.cloud.azure.*` keys cannot be resolved** — Neither JSON table indexes these prefixes; the lookup will return `found: false` for these patterns. Document in the utility and in the `Review Required` badge tooltip.

### Scope Changes

None — no new `app.config.json` scopes required.

### Implementation Order

1. **`ui/tsconfig.json`** — Add `resolveJsonModule: true`
   - Must be done first; blocks compilation of Task 2
2. **`ui/app/types/alert.ts`** — Add `rawExpression?` and `rawAnalyzerInputs?`
   - Data model foundation; needed before hook or component changes
3. **`ui/app/hooks/useAlertScan.ts`** — Populate new fields in `scanMetricEvents` and `scanDavisDetectors`
   - Mechanical change; populate from already-computed local variables
4. **`ui/app/utils/metricKeyMapping.ts`** — Create lookup utility
   - Use corrected field names per Finding #2; test thoroughly before continuing
5. **`ui/app/components/AlertDetailPanel.tsx`** — Create detail panel component
   - Depends on `AlertResult` extended type and `metricKeyMapping` utility
6. **`ui/app/components/AlertsTab.tsx`** — Add `selectedAlert` state, interactive rows, panel render
   - Wire together; depends on `AlertDetailPanel`
7. **`ui/app/App.tsx`** — Add `<ToastContainer />`
   - Single-line addition; without it `showToast` calls fail silently

### Testing Strategy

- [x] `lookupMetricKey`: AWS `builtin:cloud.aws.*` key → found, returns `dacMetricKey`, `isRecommended: true` — covered in `metricKeyMapping.test.ts`
- [x] `lookupMetricKey`: AWS `ext:cloud.aws.*` key → found, returns `dacMetricKey` — covered in `metricKeyMapping.test.ts`
- [x] `lookupMetricKey`: AWS autodiscovered-only key (recommended is "not-matched") → found, `dacMetricKey` non-null, `isRecommended: false` — covered in `metricKeyMapping.test.ts`
- [x] `lookupMetricKey`: Azure `builtin:cloud.azure.*` key → found via `builtInMetricKey` field — covered in `metricKeyMapping.test.ts`
- [x] `lookupMetricKey`: Azure `ext:cloud.azure.*` key → found via `supportingServiceMetricKey` (not `secondGenMetricKey`) — covered in `metricKeyMapping.test.ts`
- [x] `lookupMetricKey`: Azure EOL metric → `found: true`, `endOfLife: true` — covered in `metricKeyMapping.test.ts`
- [x] `lookupMetricKey`: key not present in any table entry → `found: false` — covered in `metricKeyMapping.test.ts`
- [x] `lookupMetricKey`: `dt.cloud.aws.*` prefix key → `found: false` (not indexed in JSON) — covered in `metricKeyMapping.test.ts`
- [x] `lookupMetricKey`: GCP provider → always `found: false` — covered in `metricKeyMapping.test.ts`
- [x] `isMigratable`: all keys mapped → `true`; any unmapped → `false`; GCP → `false`; autodiscovered keys → `true` — covered in `metricKeyMapping.test.ts`
- [x] `hasEndOfLifeMetrics`: Azure EOL key → `true`; non-EOL key → `false`; GCP → `false` — covered in `metricKeyMapping.test.ts`
- [x] `getEndOfLifeInfo`: Azure EOL service → returns date + URL; non-EOL service → null; GCP → null — covered in `metricKeyMapping.test.ts`
- [x] `isServiceSupported`: known AWS namespace → `true`; known Azure ARM type → `true`; unknown → `false` — covered in `metricKeyMapping.test.ts`
- [ ] `AlertResult` after scan: `rawExpression` populated for `metric-event`; `rawAnalyzerInputs` populated for `davis-ai`; both absent for `infrastructure-detection`

### Risks & Mitigations

- ⚠️ **Risk:** JSON imports from outside `ui/` may break if `dt-app` restricts Vite root to `ui/` in a future version
  - **Mitigation:** Copy `docs/dac-{aws,azure}-to-2ndgen-metrics.json` into `ui/app/data/` if build issues arise. The `docs/` copies remain the source of truth for documentation purposes.
- ⚠️ **Risk:** ~3 MB of JSON (~0.6 MB gzip) added to app bundle
  - **Mitigation:** Acceptable for an internal admin tool; no lazy-loading needed at this scale. Document in release notes when deploying.
- ⚠️ **Risk:** `AlertResult.id` fallback `''` (empty string) if `objectId` is null
  - **Mitigation:** `objectId` is always populated by the Settings V2 API for returned objects. The `?? ''` fallback is a safety net; a `DataTable` receiving an empty-string `activeRow` will simply not highlight any row.
- ⚠️ **Risk:** Complex `metricSelector` expressions may not produce valid DQL after naive key substitution
  - **Mitigation:** The "Suggested DQL — review before use" label is mandatory and sufficient. Do not attempt to parse or validate the selector — perform regexp key-token substitution only. Open Question #4 in the story covers this; no additional action for this story.

---

## Dev Notes

### Relevant Context

- `AlertResult` type is defined in `ui/app/types/alert.ts`. The `classicPatterns` field currently holds extracted key tokens only — the raw expression fields added in Task 1 are new optional fields. `[Source: ui/app/types/alert.ts]`
- `scanMetricEvents` reads `queryDefinition.metricKey` and `queryDefinition.metricSelector` but currently discards them after calling `extractClassicMetricKeys`. These values need to be captured before discard. `[Source: ui/app/hooks/useAlertScan.ts]`
- `scanDavisDetectors` iterates `analyzer.input[]` entries but discards the string values after pattern detection. The full values for matching entries need to be stored. `[Source: ui/app/hooks/useAlertScan.ts]`

### Platform Capabilities

- **DAC metric mapping tables**: `docs/dac-aws-to-2ndgen-metrics.json` and `docs/dac-azure-to-2ndgen-metrics.json`. The **AWS table** has `builtInMetricKey`, `secondGenMetricKey`, and `dacMetricKey`; the **Azure table** has `builtInMetricKey`, `supportingServiceMetricKey` (no `secondGenMetricKey`), and `dacMetricKey`. Look up classic keys against `builtInMetricKey` and the provider-specific ext-format field; `dacMetricKey` is the new connection equivalent. A value of `"not-matched"` means no equivalent exists. `[Source: docs/dac-aws-to-2ndgen-metrics.json]` `[Source: docs/dac-azure-to-2ndgen-metrics.json]`
- **Strato side panel component**: Use `Sheet` from `@dynatrace/strato-components/overlays` (confirmed via MCP tool — `SidePanel` does not exist as a Strato component). Key props:
  - `show: boolean` — controls visibility; developer owns this state
  - `title: string` — displayed in the sheet header (use alert name)
  - `actions: ReactNode` — rendered top-right, next to the title; place a "Close" `Button` here as the primary dismiss control
  - `onDismiss: () => void` — **called only when the Escape key is pressed**, NOT on outside-click. Outside-click is not natively supported by `Sheet`; see Open Question #5 for the recommended approach.
  - `aria-label` — provide when `title` is empty for accessibility
  - Import: `import { Sheet } from '@dynatrace/strato-components/overlays';`
  - Use case reference: `Basic` example in Strato docs `[Source: AGENTS.md#MCP Tools]`
- **Strato DQL code display**: Use `CodeSnippet` from `@dynatrace/strato-components/content` to render the suggested DQL. It includes a built-in copy button (`showCopyAction` defaults to `true`) and an `onCopy: () => void` callback. Wire `onCopy` to `showToast` from `@dynatrace/strato-components/notifications` for the clipboard confirmation (AC #4). This eliminates the need for a separate "Copy DQL" `Button` + manual Clipboard API call. Import: `import { CodeSnippet } from '@dynatrace/strato-components/content';`
- **Toast for copy confirmation**: Use `showToast` (imperative API) from `@dynatrace/strato-components/notifications`. Requires `<ToastContainer />` to be present in `App.tsx` (add once if not already there). Import: `import { showToast, ToastContainer } from '@dynatrace/strato-components/notifications';`
- **Clipboard API**: Use `navigator.clipboard.writeText()`. Dynatrace AppEngine runs in a secure context; the Clipboard API is available. No additional permission or scope is required.
- **DQL suggestion format**: The minimal viable DQL for a substituted metric key is `timeseries avg(<dacMetricKey>)`. If the original `metricSelector` is an expression with filters or splits, key substitution should be attempted on the expression text (replace each classic key token with its new equivalent) rather than constructing a query from scratch.

### Data Considerations

- The DAC JSON mapping files are static assets bundled with the app. There is no runtime fetch needed — import them as modules. The AWS file contains ~hundreds of entries; the Azure file similarly. This is within acceptable bundle size for a Dynatrace App.
- Classic metric key → `dacMetricKey` lookup: the mapping JSONs are not indexed; the lookup utility must construct an index on first use (or on module load) to avoid O(n) per key.
- GCP: no `dac-gcp-to-2ndgen-metrics.json` exists yet. For GCP alerts, the migration assessment should always return `Review Required` with a note explaining the mapping table is not yet available. `[Source: docs/gcp-classic.md]`

### Technical Constraints

- No new scopes are required — the detail pane uses data already fetched during the scan and static JSON assets. `[Source: app.config.json]`
- **`ui/tsconfig.json` requires `"resolveJsonModule": true`** — not currently set. Without this, the TypeScript compiler will reject `import X from '*.json'` statements. Add this to `compilerOptions` before implementing Task 2. The `rootDir: "."` setting does NOT prevent JSON imports from `docs/`; it applies only to TypeScript source files.
- **JSON import path from `ui/app/utils/`**: `'../../../docs/dac-aws-to-2ndgen-metrics.json'` — three levels up from `ui/app/utils/` reaches the workspace root, then into `docs/`. Vite resolves this correctly because `dt-app` sets Vite root to `process.cwd()` (workspace root).
- **Azure JSON schema**: the Azure mapping file (`dac-azure-to-2ndgen-metrics.json`) has `supportingServiceMetricKey` where the AWS file has `secondGenMetricKey`. The lookup utility must use the correct field name per provider.
- GCP metric mapping data does not exist yet — see Open Questions.

## Cloud Provider Considerations

- **AWS**: Full mapping support via `dac-aws-to-2ndgen-metrics.json`. The detail pane can show `Migratable` / `Review Required` with confidence.
- **Azure**: Full mapping support via `dac-azure-to-2ndgen-metrics.json`. Same logic applies.
- **GCP**: No DAC metric mapping table exists currently. For GCP alerts, the migration assessment badge should always be `Review Required` with a note: "GCP metric mapping is not yet available — review manually." The raw expression and suggested DQL sections are still shown, but no key substitution is attempted. The architecture must make this provider check a runtime condition, not a compile-time branch — so GCP support can be added by introducing `dac-gcp-to-2ndgen-metrics.json` without touching the detail panel component.

## Dependencies

- **Story 004** (Scan Alerts for Classic Dependencies) — this story extends the `AlertResult` type, `useAlertScan` hook, and `AlertsTab` component established there. Story 004 must be fully implemented before this story begins.
- DAC mapping JSON files (`docs/dac-aws-to-2ndgen-metrics.json`, `docs/dac-azure-to-2ndgen-metrics.json`) — must be importable as TypeScript modules. The `tsconfig.json` `resolveJsonModule` setting may need to be verified.

## Testing Guidance

> **Note**: Testing strategy is an open topic — details will be refined when the QA Testing agent is established. For now, focus on identifying *what* to test, not *how*.

- `isMigratable` utility: test with keys where all have mappings (→ `true`), mix of mapped and unmapped (→ `false`), all unmapped (→ `false`), GCP provider (→ `false`)
- Metric key lookup: test `builtin:cloud.aws.*` lookup, `ext:cloud.aws.*` lookup, `cloud.azure.*` lookup, key with `"not-matched"` `dacMetricKey`, key not present in table at all
- Detail panel content for `infrastructure-detection` type: confirm static explanation is shown, no DQL section, no "Copy DQL" button
- Detail panel content for disabled alert: confirm note is shown alongside disabled chip
- "Copy DQL" flow: confirm clipboard content matches the generated suggestion string
- Row-click interaction: click row → panel opens; click different row → panel updates; Escape → panel closes; click outside → panel closes
- Multi-key `metricSelector` alert: confirm all keys are substituted in the suggestion, unmapped keys are annotated

## Open Questions

1. **Infrastructure Detection detail content** — The current AC (#7) shows a static explanation. A follow-up story should define the proper migration path for `builtin:anomaly-detection.infrastructure-aws`: does the new AWS connection have an equivalent built-in anomaly detection schema? If so, the detail pane could link to it or show its configuration. This is deferred pending platform research.

2. **GCP metric mapping** — `docs/gcp-new.md` exists but no `dac-gcp-to-2ndgen-metrics.json` has been created. The story's GCP fallback behaviour (`Review Required` with a note) is intentionally minimal. A separate story should produce the GCP mapping table before GCP alert detail is considered complete.

3. **Davis AI analyzer input format** — The Davis AI detector schema has multiple input field types. It is possible that some input values are not metric-selector strings but entity selector expressions or DQL fragments. The story assumes key substitution on the raw string is sufficient; the architect should validate whether the Davis AI schema requires a more structured approach.

4. **metricSelector complexity** — Complex `metricSelector` expressions (e.g., `builtin:cloud.aws.ec2.cpuUsage:avg:names:filter(and(prefix("dt.entity.aws_credentials","AWS_CREDENTIALS-"),eq(...))):splitBy("dt.entity.aws_credentials")`) may not produce valid DQL after naive key substitution. The "review before use" label partially mitigates this, but the architect should determine whether to attempt substitution on complex selectors at all or show the raw expression with keys highlighted instead.

5. **Sheet outside-click dismissal** — The Strato `Sheet` component's `onDismiss` callback fires **only on the Escape key**, not on outside-click. AC #8 specifies "clicks outside the panel" as a dismiss trigger. Options: (a) Remove outside-click dismiss and rely solely on Escape + the Close button in `actions` — this is the simplest approach and maintains accessibility without custom event handling; (b) Wrap the page content area in a transparent click target that sets `show` to `false`. Recommendation: **(a) is preferred** — the Sheet component is designed to be dismissed via Escape or an explicit action button; outside-click dismissal on a detail pane used frequently during migration review would be frustrating (accidental dismissal). The story AC #8 should be updated accordingly.

6. **CodeSnippet built-in copy vs. separate Copy DQL button** — `CodeSnippet` from `@dynatrace/strato-components/content` renders a built-in copy-to-clipboard button by default (`showCopyAction` defaults to `true`) and exposes an `onCopy` callback. This makes a separate "Copy DQL" `Button` + manual `navigator.clipboard.writeText()` call redundant. The architect should confirm whether to use `CodeSnippet` natively (preferred — consistent Strato UX, handles copy feedback) or keep a custom button (only if additional actions like "Copy + Open in Notebooks" are planned for this story).

7. **Classic Settings objectId deep-link** (RESOLVED — 2026-04-13) — Investigated whether `/ui/apps/dynatrace.classic.settings/ui/settings/builtin:anomaly-detection.metric-events/<objectId>` navigates to a specific settings object. URL path routing is not supported for list-type schemas. However, the `dynatrace.classic.settings` app exposes a **`settings-open-settings-by-id`** intent that accepts `dt.settings.object_id` (required), enabling exact objectId navigation via the AppEngine intent system. Implemented as `IntentButton` (`AC #15`).

8. **Create Anomaly Detector via intent** (RESOLVED — 2026-04-14) — Intent confirmed as `dynatrace.davis.anomalydetection/create_anomaly_detector_in_modal` (validated via `dtctl get intent`). Required props: `dt.query` (DQL) and `sourceApplication`. Optional: `davis.analyzer` (full analyzer object) and `davis.anomalydetector` (title, executionSettings). Model field names confirmed from live data: `builtin:davis.anomaly-detectors` stores `analyzer.input[{key,value}]`; `builtin:anomaly-detection.metric-events` stores `modelProperties.samples` as the evaluation window (maps to `slidingWindow`). Implemented as `CreateDetectorAction` component (`AC #17`).

## Out of Scope

- Modifying any alert configuration — the app is strictly read-only
- Producing a complete, test-valid DQL query — the suggestion is explicitly best-effort and labelled as such
- Handling the migration of `infrastructure-detection` alerts end-to-end — deferred to a follow-up story (Open Question #1)
- GCP metric key substitution — deferred until the GCP mapping table exists (Open Question #2)
- Batch operations (e.g., "Copy DQL for all alerts") — single-alert detail only
- Pre-populating threshold/window settings for non-STATIC_THRESHOLD metric events (baseline, relative threshold) — analyzer name mapping is unknown for these types; user configures manually

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-04-10 | 1.0 | Initial draft | Story Writer |
| 2026-04-13 | 1.1 | Added AC #15 (Classic Settings IntentButton deep-link via `settings-open-settings-by-id` intent), AC #16 (metric ingestion check), Tasks 7–8, OQs 7–8 | Copilot |
| 2026-04-14 | 1.2 | Added AC #17 (Create Anomaly Detector via `create_anomaly_detector_in_modal` intent), Task 9; extended `AlertResult` with `rawModelProperties`/`rawAnalyzer`; updated OQ #8 to resolved | Copilot |
