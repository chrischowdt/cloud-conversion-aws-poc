# User Story: Dashboard Detail Pane — Per-Tile Migration Guidance

**Status**: Draft
**Category**: Assessment / Guidance
**Migration Phase**: Prepare

## Story Statement

**As a** Dynatrace Administrator,
**I want** to click on a dashboard in the scan results and see a detail panel that breaks down which individual tiles use classic cloud expressions and offers DQL migration suggestions for each,
**so that** I can understand the migration scope of a specific dashboard tile-by-tile and have a concrete starting point for updating it.

## Context

Story 002 introduced the Dashboards tab, which scans for dashboards containing classic cloud references and presents them as a table. Each row shows a footer-level summary: which classic prefix patterns were detected and how many. This is sufficient for triage but not for action — the administrator cannot tell from the table which tile within a dashboard is problematic, what expression it uses, or how to rewrite it.

This story adds the second layer: a side panel that opens when a dashboard row is clicked, exposing the per-tile breakdown and a suggested DQL replacement for each classic expression. It directly extends Capability #3 (Migration Readiness) from the vision document. `[Source: .github/prompts/vision.prompt.md#Capabilities]`

**Critical data model gap**: The current `DashboardScanResult` type stores only deduplicated prefix labels (e.g. `"dt.cloud.aws."`, `"cloud.aws."`) at the dashboard level — not per-tile data and not actual metric key tokens. This is sufficient for the table view but insufficient for a detail pane. This story **requires extending the scan to capture per-tile data** during the existing scan pass (no additional API calls). `[Source: ui/app/types/dashboard.ts]` `[Source: ui/app/hooks/useDashboardScan.ts]`

**Key asymmetry between formats**: Classic-format dashboards (Config API v1) use metric selectors in their tile structures — these are not DQL. New-format dashboards (Document Service) use DQL tile queries. The detail pane surfaces both, but DQL suggestions are always the target format for migration.

**Important constraint**: the app is read-only. The detail pane is purely informational. `[Source: .github/prompts/vision.prompt.md#Constraints]`

## Acceptance Criteria

1. **Given** the Dashboards tab has completed a scan with results, **when** a user clicks any row in the results table, **then** a side panel opens without navigating away, showing detailed information for the selected dashboard.

2. **Given** the detail panel is open, **when** the user views it, **then** it shows at minimum:
   - Dashboard name, format badge (Classic / New), ownership badge (Custom / Preset / Ready-made)
   - Owner (if available) and last modified / last opened timestamps (if available)
   - A **migration assessment** badge: `Migratable` (all detected classic metric keys across all tiles have a known new equivalent) or `Review Required` (one or more keys have no mapping)
   - A **tile-by-tile breakdown** (see AC #3–#7)

3. **Given** the detail panel is open, **when** the user views the tile breakdown, **then** each tile with a classic dependency is shown as a distinct section with:
   - The tile's visual title (if available) or a positional label (e.g. "Tile 3") when no title exists
   - The tile type label (e.g. "Data Explorer", "Custom Charting", "DQL Query", "SLO")
   - The raw classic expression(s): metric selector string(s) for classic-format tiles, DQL query string for new-format tiles
   - A per-tile `Migratable` / `Review Required` badge
   - A suggested DQL section (see AC #4)

4. **Given** a tile has at least one classic metric key with a known `dacMetricKey` in the mapping table, **when** the suggested DQL section is shown, **then** it displays a best-effort DQL query with classic keys replaced by their `dacMetricKey` equivalents. For new-format (DQL) tiles this means substituting keys in the existing query string. For classic-format tiles this means constructing a minimal `timeseries avg(<dacMetricKey>)` from the extracted keys. The section is labelled "Suggested DQL — review before use".

5. **Given** the suggested DQL section is shown for a tile, **when** the `CodeSnippet` copy button is clicked, **then** the DQL string is copied to the clipboard and a brief toast confirmation is shown.

6. **Given** a tile expression contains one or more classic keys with **no known mapping** in the provider's DAC mapping table, **when** shown in the suggested DQL section, **then** the unmapped keys are preserved in their original position in the suggestion and listed separately as "No mapping found for: `<key>`". The per-tile badge shows `Review Required`.

7. **Given** a classic-format SLO tile is detected, **when** shown in the tile breakdown, **then** the raw text that triggered the match is displayed (the full tile JSON is not shown — display only the matched metric expression extracted from the tile). The suggested DQL follows the same substitution approach as other tile types.

8. **Given** the dashboard has `format: 'new'`, **when** a tile's DQL query contains only entity-type patterns (e.g. `fetch dt.entity.ec2_instance`) without any metric keys, **then** the tile breakdown shows the raw DQL query, the per-tile badge shows `Review Required`, and the suggested DQL section shows a static note: "Entity-type migration requires manual mapping — see new connection entity documentation."

9. **Given** the detail panel is open, **when** the user presses Escape or clicks the Close button in the panel header, **then** the panel closes and the table row is deselected.

10. **Given** the scan results table has the detail panel open, **when** the user clicks a different row, **then** the panel updates to show the newly selected dashboard without closing.

11. **Given** the dashboard has `ownership: 'preset'` or `'ready-made'`, **when** the detail panel is open, **then** a banner is shown: "This is a Dynatrace-managed dashboard. Dynatrace will update it when the new connection matures — no action required from you." The tile breakdown is still shown for informational purposes.

12. **Given** the detail panel is open and the dashboard has tiles without classic dependencies, **when** the tile breakdown section is rendered, **then** a count note is displayed above the tile list: "Showing X of N tiles — only tiles with classic dependencies shown." When every tile has classic dependencies (X equals N), the count note is omitted.

13. **Given** the detail panel is open and the dashboard has more than 5 tiles with classic dependencies, **when** the tile breakdown is rendered, **then** a text filter input is displayed above the tile list. The filter matches against each tile's visible label (title or positional label). Tiles not matching the active filter string are hidden. When no tiles match, an inline message reads "No tiles match your filter." When 5 or fewer classic tiles are present, the filter input is not shown.

14. **Given** the detail panel opens and the tile breakdown is rendered, **when** the dashboard has 5 or fewer classic tiles, **then** all `Accordion.Section` entries are expanded by default. When the dashboard has 6 or more classic tiles, all sections are collapsed by default.

15. **Given** a tile section is rendered in the Accordion, **when** the tile's migration status is `Migratable`, **then** the `Accordion.Section` uses `color="success"`. When the status is `Review Required`, the section uses `color="warning"`. The colour is visible in the collapsed state, enabling at-a-glance status scanning without requiring expansion.

16. **Given** a `DashboardScanResult` has `classicTiles` as `undefined` or an empty array, **when** the detail panel opens, **then** the tile breakdown section shows an inline message: "Detailed tile breakdown is not available for this dashboard." Dashboard-level metadata (name, format, ownership, overall assessment badge) is still shown.

## Tasks / Subtasks

- [ ] Task 1: Add `ClassicTileDetail` type and extend `DashboardScanResult` (AC: #3, #7)
  - [ ] Define `ClassicTileDetail` in `ui/app/types/dashboard.ts`:
    ```
    tileId?: string
    tileTitle?: string
    tileType: string           // DATA_EXPLORER | CUSTOM_CHARTING | DQL_QUERY | SLO | other
    rawExpressions: string[]   // metric selector(s) or DQL query string
    classicKeys: string[]      // actual extracted key tokens (from extractClassicMetricKeys)
    ```
  - [ ] Add `classicTiles?: ClassicTileDetail[]` as an optional field on `DashboardScanResult` — optional to maintain backward compatibility with any existing consumers

- [ ] Task 2: Update scan functions to populate per-tile data (AC: #3, #4, #6, #7, #8)
  - [ ] Refactor `extractPatternsFromClassicTile` in `useDashboardScan.ts` to return `{ patterns: string[]; detail: ClassicTileDetail | null }` — same single pass, new return shape. Pass `tileIndex: number` as a second argument (used as fallback `tileId`). For SLO tiles: `rawExpressions = tile.metricExpression ? [tile.metricExpression as string] : []` and `tileTitle = tile.name as string | undefined`. For DATA_EXPLORER: `rawExpressions = queries.map(q => q.metric as string).filter(Boolean)`. For CUSTOM_CHARTING: `rawExpressions = series.map(s => s.metric as string).filter(Boolean)`. Run `extractClassicMetricKeys` on each expression to populate `classicKeys`. Return `null` detail when `patterns` is empty (tile has no classic content, nothing to surface in the detail pane).
  - [ ] Update `scanClassicDashboards` to iterate `tiles.entries()` (for index) and collect non-null `detail` objects, attaching the array to each `DashboardScanResult` as `classicTiles`. Classic tile `tileId` has no stable API field — use the tile's positional index as a string (e.g. `"tile-0"`). `tileTitle` comes from `tile.name`.
  - [ ] Update `scanNewDashboards` to switch from `Object.values(tiles)` to `Object.entries(tiles)` so the map key (tile ID) is captured. For each tile with classic patterns, produce a `ClassicTileDetail` with: `tileId = key`, `tileTitle = tile.name as string | undefined`, `rawExpressions = [query]` (the DQL string), `classicKeys` extracted via `extractClassicMetricKeys(query, provider)`, `tileType = 'DQL_QUERY'`.
  - [ ] Keep `classicPatterns` on `DashboardScanResult` as a **separate code path** — it is derived from `detectClassicMetricPatterns` + `detectClassicEntityPatterns` and stores prefix labels (e.g. `"dt.cloud.aws."`). It cannot be derived from flattening tile `classicKeys` because entity patterns (`dt.entity.ec2_instance`) are captured by `detectClassicEntityPatterns` but are NOT returned by `extractClassicMetricKeys`. Do not change the existing `classicPatterns` derivation logic.

- [ ] Task 3: Create `DashboardDetailPanel` component (AC: #1–#11)
  - [ ] Use `Sheet` from `@dynatrace/strato-components/overlays` (same pattern as `AlertDetailPanel`)
  - [ ] Show dashboard metadata: name, format, ownership badges, owner, last modified, last opened
  - [ ] Show preset/ready-made banner when applicable (AC: #11)
  - [ ] Show overall migration assessment badge computed across all tiles (AC: #2)
  - [ ] Render each `ClassicTileDetail` as a distinct collapsible or flat section
  - [ ] For each tile: show title/label, type, raw expression(s), per-tile assessment badge, suggested DQL
  - [ ] Use `metricKeyMapping.ts` (`lookupMetricKey`, `isMigratable`) for key substitution — already exists from Story 008 `[Source: ui/app/utils/metricKeyMapping.ts]`
  - [ ] Use `CodeSnippet` from `@dynatrace/strato-components/content` with `onCopy` → `showToast` for clipboard (AC: #5)
  - [ ] Handle Escape via `Sheet.onDismiss` and Close button via `actions` prop (AC: #9)

- [ ] Task 4: Wire row click in `DashboardsTab` (AC: #1, #10)
  - [ ] Add `selectedDashboard: DashboardScanResult | null` state
  - [ ] Add `interactiveRows={{ autoActivate: false }}`, `rowId`, `activeRow`, `onActiveRowChange` to `DataTable` (same pattern as `AlertsTab` — `autoActivate: false` required to prevent re-open on close focus-return) `[Source: ui/app/components/AlertsTab.tsx]`
  - [ ] Render `DashboardDetailPanel` conditionally when `selectedDashboard !== null`

## Dev Notes

### Relevant Context

- `DashboardScanResult.classicPatterns` stores **prefix labels** (e.g. `"dt.cloud.aws."`) returned by `detectClassicMetricPatterns` — NOT actual key tokens. The detail pane needs actual keys for lookup, which requires `extractClassicMetricKeys` to be called per-tile during the scan. `[Source: ui/app/utils/classicPatterns.ts]`
- `extractClassicMetricKeys` already handles the AWS/GCP new-vs-classic disambiguation. Do not replicate that logic — call the existing utility. `[Source: ui/app/utils/classicPatterns.ts#extractClassicMetricKeys]`
- `extractPatternsFromClassicTile` in `useDashboardScan.ts` currently returns only pattern strings. The refactor in Task 2 needs to also extract key tokens and tile metadata from the same tile object in a single pass. `[Source: ui/app/hooks/useDashboardScan.ts#extractPatternsFromClassicTile]`
- `metricKeyMapping.ts` (`lookupMetricKey`, `isMigratable`) was created in Story 008 and can be used as-is. No changes needed. `[Source: ui/app/utils/metricKeyMapping.ts]`
- `AlertDetailPanel` (`ui/app/components/AlertDetailPanel.tsx`) is the reference implementation for the Sheet + CodeSnippet + showToast pattern. Follow its structure. `[Source: ui/app/components/AlertDetailPanel.tsx]`
- `interactiveRows={{ autoActivate: false }}` is required (not optional). Without it, closing the Sheet returns focus to the highlighted row, immediately re-firing `onActiveRowChange` and re-opening the panel. This bug was observed and fixed in `AlertsTab`. `[Source: ui/app/components/AlertsTab.tsx]`

### Platform Capabilities

- **`Sheet`** from `@dynatrace/strato-components/overlays` — see Story 008 Dev Notes for confirmed props. Key: `show`, `title`, `actions`, `onDismiss` (Escape only). `[Source: .github/stories/008-alert-detail-pane-migration-guidance.md]`
- **`CodeSnippet`** from `@dynatrace/strato-components/content` — `onCopy: () => void`, `showLineNumbers`, `size`. Copy button is built-in. `[Source: .github/stories/008-alert-detail-pane-migration-guidance.md]`
- **`showToast`** from `@dynatrace/strato-components/notifications` — `<ToastContainer />` already present in `App.tsx` from Story 008. No additional setup needed. `[Source: ui/app/App.tsx]`
- **`DataTable` interactive rows** — `interactiveRows={{ autoActivate: false }}`, `rowId`, `activeRow`, `onActiveRowChange` — all confirmed working from Story 008 implementation. `[Source: ui/app/components/AlertsTab.tsx]`
- **`Accordion`** from `@dynatrace/strato-components/content` — use to render each classic tile as a collapsible section inside the Sheet. Key usage for this story:
  - Import: `import { Accordion } from '@dynatrace/strato-components/content';`
  - `multiple={true}` — allow multiple tile sections open simultaneously (user may want to compare tiles side by side)
  - `size="condensed"` — reduces per-section height; important inside a Sheet where vertical space is limited
  - `showDividers={true}` — default; keep enabled to visually separate tile sections
  - `defaultExpanded` — array of all section IDs when ≤5 classic tiles (all expanded); `false` when ≥6 classic tiles (all collapsed) — per AC #14
  - `Accordion.Section id` — use `tileId` if available, otherwise the tile's positional index as a string (e.g. `"tile-3"`)
  - `Accordion.Section color` — `"success"` for Migratable, `"warning"` for Review Required (AC #15); status colour renders in the collapsed header, enabling a full status scan without expanding every section
  - Subcomponents: `<Accordion.SectionLabel>` for tile title + type badge row; `<Accordion.SectionContent>` for raw expression(s), suggested DQL CodeSnippet, and per-tile assessment badge
  - Confirmed stable (graduated from preview). `[Source: Strato MCP — Accordion, strato_get_component]`

### Data Considerations

- **New dashboard tile structure**: tile IDs are the map keys in `parsed.tiles` (an object, not array). Tile title is `tile.name` — **confirmed** by the `dashboard-scanning.md` doc example and by the story's own analysis; there is no separate `tile.title` field. Tile `type` (e.g. `"data"`) is also present in the tile object but not currently used by the scan. The fix required is switching `Object.values(tiles)` → `Object.entries(tiles)` and reading `t.name`.
- **Classic dashboard tile structure**: tiles are an array. Each tile has a `name` string field (the visible title) and `tileType`. Classic tiles have no stable ID field from the API — use positional index as string (e.g. `"tile-0"`) for `tileId`.
- **Multiple expressions per tile**: classic DATA_EXPLORER tiles can have multiple queries (`tile.queries[]` array). Each query may have a distinct metric. The `ClassicTileDetail.rawExpressions` array accommodates this.
- **Entity-only tiles**: new-format tiles using `fetch dt.entity.*` without any metric key will have `classicKeys: []` but non-empty `classicPatterns` from entity detection. These must still be surfaced in the detail pane (AC #8) with a manual-review note.
- **DAC mapping coverage**: same as Story 008. `dt.cloud.aws.*` / `dt.cloud.azure.*` prefix keys are not indexed in the JSON tables and will return `found: false`. GCP always returns `found: false`. `[Source: ui/app/utils/metricKeyMapping.ts]`

### Files to Create / Modify

| Action | File | Reason |
|--------|------|--------|
| **MODIFY** | `ui/app/types/dashboard.ts` | Add `ClassicTileDetail` type; add optional `classicTiles?: ClassicTileDetail[]` to `DashboardScanResult` |
| **MODIFY** | `ui/app/hooks/useDashboardScan.ts` | Refactor `extractPatternsFromClassicTile` return type; update `scanClassicDashboards` and `scanNewDashboards` to collect per-tile `ClassicTileDetail` objects |
| **CREATE** | `ui/app/components/DashboardDetailPanel.tsx` | New Sheet-based detail panel — follow `AlertDetailPanel.tsx` as template |
| **MODIFY** | `ui/app/components/DashboardsTab.tsx` | Add `selectedDashboard` state; wire `interactiveRows`, `rowId`, `activeRow`, `onActiveRowChange`; render `DashboardDetailPanel` |

No other files require changes. `metricKeyMapping.ts`, `classicPatterns.ts`, `App.tsx` (ToastContainer), and all type files except `dashboard.ts` are untouched.

### Technical Constraints

- No new scopes required — per-tile data is extracted from content already fetched during the existing scan pass.
- `resolveJsonModule: true` is already set in `ui/tsconfig.json` from Story 008. `[Source: ui/tsconfig.json]`
- `DashboardScanResult.classicTiles` must be optional (`classicTiles?: ClassicTileDetail[]`) to avoid breaking the existing test suite which constructs `DashboardScanResult` objects without this field.

## Cloud Provider Considerations

- **AWS**: Full mapping support via `dac-aws-to-2ndgen-metrics.json`. Tile-level `Migratable` / `Review Required` assessment is reliable.
- **Azure**: Full mapping support via `dac-azure-to-2ndgen-metrics.json`. Same logic applies.
- **GCP**: No mapping table. All GCP tiles show `Review Required` with note "GCP metric mapping is not yet available." Raw expressions are still surfaced.
- The tile-type parsing logic is provider-agnostic — the same Classic tile types (`DATA_EXPLORER`, `CUSTOM_CHARTING`, etc.) are used across all providers.

## Dependencies

- **Story 002** (Scan Dashboards for Classic Dependencies) — this story extends `DashboardScanResult`, the scan functions in `useDashboardScan.ts`, and `DashboardsTab.tsx`. Must be fully implemented before this story begins.
- **Story 008** (Alert Detail Pane) — `metricKeyMapping.ts`, `AlertDetailPanel.tsx` (as reference), `autoActivate: false` fix, and `ToastContainer` in `App.tsx` are all already in place.

## Testing Guidance

> **Note**: Testing strategy is an open topic. Focus on identifying *what* to test, not *how*.

- `ClassicTileDetail` population: scan a classic DATA_EXPLORER tile with a known classic metric — confirm `rawExpressions` contains the metric selector, `classicKeys` contains the extracted token
- `ClassicTileDetail` for new-format DQL tile: confirm `rawExpressions[0]` is the full DQL query, `classicKeys` contains extracted tokens from that query
- Entity-only tile (no metric keys): confirm `classicKeys` is empty, tile still appears in the breakdown
- `isMigratable` at dashboard level: all tiles mappable → `Migratable`; any unmappable → `Review Required`
- Preset/ready-made banner: confirm it appears for `ownership: 'preset'` and `ownership: 'ready-made'`
- `autoActivate: false` behaviour: close panel, confirm it does not immediately reopen
- Per-tile with multiple `rawExpressions` (DATA_EXPLORER with multiple queries): confirm each expression shown separately

## Open Questions

1. ~~**Tile title availability for new dashboards**~~ **RESOLVED by Architect Review (2026-04-10)**: Tile ID = the map key in `parsed.tiles`; tile title = `tile.name` (string, may be absent). There is no `tile.title` field. The fix in `scanNewDashboards` is: switch `Object.values(tiles)` to `Object.entries(tiles)` and read `([key, t]) => { tileId = key; tileTitle = t.name as string | undefined; }`. Evidence: `dashboard-scanning.md` docs code example uses `Object.entries(parsed.tiles ?? {})` with destructured key; test tiles use map-key IDs (e.g. `"tile1"`).

2. **Dashboard-level `classicPatterns` preservation** — the top-level `classicPatterns` field on `DashboardScanResult` is used by the existing table column "Classic Patterns Detected". When the scan is refactored to capture per-tile data, ensure the dashboard-level `classicPatterns` continues to be populated (it can be derived by flattening all tile `classicKeys`, or kept as a separate code path).

3. ~~**Number of tiles per dashboard — show or hide non-classic tiles**~~ **RESOLVED by UX Review (2026-04-10)**: **Hide non-classic tiles entirely.** Non-classic tiles have no migration work required; including them even collapsed/greyed dilutes the signal in the panel. Large dashboards may have 50+ total tiles but only a handful of classic ones — surfacing only classic tiles keeps the panel focused on actionable items. A count note above the tile list ("Showing X of N tiles — only tiles with classic dependencies shown") gives the admin the scope context without the noise. ACs #12–#16 implement this decision and address large-dashboard handling, default expand behaviour, colour coding, and the `classicTiles` undefined fallback.

4. ~~**Classic SLO tile key extraction**~~ **RESOLVED by Architect Review (2026-04-10)**: Classic SLO tiles embed `metricExpression` directly in the tile object alongside `sloId`. Confirmed by `useDashboardScan.test.ts` which tests a tile `{ tileType: 'SLO', sloId: 'some-slo', metricExpression: 'builtin:cloud.aws.ec2.cpu:avg:partition("value"):value:auto' }` and expects `classicPatterns` to include `'builtin:cloud.aws.'`. The existing JSON-stringify approach works for pattern detection (because `metricExpression` is in the blob), but for the detail pane the extraction should be targeted: `rawExpressions = tile.metricExpression ? [tile.metricExpression as string] : []`. The `metricSelector` and `objectiveMetricSelector` field names mentioned in the question do NOT appear in classic dashboard tile data — `metricExpression` is the correct field. If `metricExpression` is absent (legacy SLO tile referencing only via `sloId`/`assignedEntities`), `rawExpressions` will be empty and the tile will be excluded from `classicTiles` (no classic patterns found).

## Out of Scope

- Modifying any dashboard configuration — the app is strictly read-only
- Producing complete, test-valid DQL queries — suggestions are best-effort and labelled as such
- GCP metric key substitution — deferred until GCP mapping table exists
- Batch operations (e.g. "Copy all DQL suggestions for this dashboard")
- Showing tiles that have no classic dependencies in the detail pane breakdown

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-04-10 | 1.0 | Initial draft | Story Writer |
| 2026-04-10 | 1.1 | Architect review: resolved Open Questions #1 and #4; corrected Task 2 subtasks; added Files to Create/Modify section | Architect |

---

## Validation Report

| Category | Status | Issues |
|---|---|---|
| 1. Goal & Context Clarity | ✅ Pass | Data model gap explicitly called out; asymmetry between classic and new tile formats explained |
| 2. Acceptance Criteria Quality | ✅ Pass | 16 ACs — 11 original plus 5 added by UX Review: tile count note (#12), large-dashboard filter (#13), default expand behaviour (#14), Accordion colour coding (#15), and classicTiles undefined fallback (#16) |
| 3. Developer Handoff Readiness | ✅ Pass | Source file references throughout; metricKeyMapping.ts reuse called out; autoActivate fix documented |
| 4. Self-Containment | ✅ Pass | Critical data model prerequisite (per-tile data not currently stored) surfaced in Context and Task 1 |
| 5. Scope Control | ✅ Pass | Read-only constraint re-stated; GCP deferred; no batch operations |

| 6. UX Review | ✅ Pass | Open Question #3 resolved (hide non-classic tiles, count note); Accordion component specified with import, props, and colour-coding pattern; ACs #12–#16 added |

**Final Assessment**: READY FOR IMPLEMENTATION — all open questions resolved. Architect review complete: Open Questions #1 and #4 resolved with confirmed field names; Task 2 subtasks corrected with exact code-level guidance; Files to Create/Modify section added. UX review complete: Open Question #3 resolved, Accordion component specified with full import/props, ACs #12–#16 added for large-dashboard handling and edge cases.
