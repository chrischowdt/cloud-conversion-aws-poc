# Project status — AWS classic→Smartscape dashboard conversion

_Snapshot for transferring context between sessions. Updated 2026-06-11._

This is a **living status doc**, not background. `RESEARCH.md` / `GAP_ANALYSIS.md`
are dated and frozen; `INTEGRATION.md` explains the two-halves composition;
`CLAUDE.md` is the architecture reference. This file is "where we are right now."

## Scope

**AWS only** right now. Azure/GCP mappings exist in `dt-migration/references/`
but are out of scope until AWS auto-conversion is much higher.

## Two hard constraints (don't forget these)

1. **Classic-passthrough is not a real conversion.** The rewriter's "leave the
   query verbatim with a warning" fallbacks (the not-planned-lookup bailout, and
   anything left in `cloud.aws.*` classic form) run on the new platform *today*
   but break the moment the classic metrics hit EOL. The metric that matters is
   **auto-translated-to-Smartscape rate**, not "didn't error." Prefer real
   translation over bailout, even when it's more work.
2. **The nic55601 tenant has no live data after 2026-05-22.** Any `compare-dashboard`
   / `equivalence` / `detect` run must use an explicit pre-May-22 timeframe
   (`--from 2026-05-15T00:00Z --to 2026-05-20T00:00Z`). The default `-2h` window
   returns `both-empty` for everything. Offline commands (`scan-dashboards`) are
   unaffected.

## Current auto-conversion rate (tenant nic55601)

Source: full offline scan of 518 AWS dashboards / 11,561 panels
(`tools/out/nic55601/dashboard-scan/summary.json`), joined with 90-day audit
access data (the `fetch dt.system.events … event.type=="GET"` query, saved at
`tools/out/nic55601/dashboard-usage.dql`).

| Slice | Clean (real Smartscape conversion) | Notes |
|---|---|---|
| All 518 AWS dashboards | **20.7%** of panels (2,392 / 11,561) | — |
| Dashboards accessed ≤90d (184 of 517) | **19.3%** of panels | 333 dashboards are dormant (zero opens in 90d) |
| Accessed ≤7d (most active 40) | **23.7%** of panels | active dashboards skew slightly easier |
| **View-weighted (by access count)** | **29.0%** of panel-views | most user-experience-honest number |

Beyond the clean rate: ~53% of panels translate *with warnings* (partial,
needs human review), ~10% bail out / unknown-metric (classic passthrough —
the danger zone at EOL), ~18% are no-ops (already new-form or non-DQL).

**Headline:** ~1 in 5 AWS panels (≈29% by views) auto-converts cleanly today.
**Biggest single insight from access data:** ~64% of scanned AWS dashboards
have zero user opens in 90 days — likely droppable from the migration target list.

## Since last update (2026-06-11, not yet committed)

Several rewriter + tooling additions landed after the commit series below; tests
now **169 passing**, typecheck clean.

- **Credential-lookup-chain pass (Pass 0.5)** — recognizes the canonical
  `lookup [fetch dt.entity.custom_device … aws_credentials …]` idiom and rewrites
  it to `smartscapeNodes <TYPE>` + AWS_ACCOUNT lookups, *before* the not-planned
  bailout. Cut bailouts 223 → 126 on the translated corpus.
- **Source-entity migration** — `dt.source_entity[.type]` → `dt.smartscape_source[.id/.type]`.
- **`discover-tags`** → `enriched-tags.json`. The new connection enriches a
  per-tenant-configurable set of AWS tags onto metrics (nic55601: `applicationci`,
  `env`). Enriched tags → cheap `aws.tags.<key>` dim filters; non-enriched tags
  need a `smartscapeNodes` lookup. Two tag surfaces with DIFFERENT casing:
  enriched dim `aws.tags.applicationci` (lowercased) vs node tag
  `getNodeField(n,"tags:aws")[ApplicationCI]` (original AWS case).
- **`discover-metrics` + dim-variant validation** (this session). The DAC can map
  a classic key to a `.By.<Dim>` variant that has **zero series** on a tenant
  while a sibling dim is populated (verified: aurora `DatabaseConnections` →
  `.By.DBClusterIdentifier` = 0 vs `.By.DBInstanceIdentifier` = 109). `discover-metrics`
  inventories the tenant's 716 live metric keys → `live-metrics.json`; the lookup
  chain swaps empty→populated siblings (`mapped-no-recipe` tier only, `min 2`
  target series by default, always warns — the inventory only sees *currently-
  collected* metrics). Corpus impact at default threshold: **13 keys / 55 tile
  warnings** (the ≥2 guard correctly dropped 6 single-series swaps incl. the
  183-ref Step Functions family). See CLAUDE.md "Dim-variant validation."
- **Lever #1: custom_device disambiguation** (this session). `discover-entity-types`
  derives the AWS-service → Smartscape node-type bridge from each metric's
  `dt.smartscape_source.type` (`entity-source-types.json`, 40 services), baked into
  `aws-service-node-types.ts`. Pass 1.55 now disambiguates `dt.entity.custom_device`
  to the real node type via the query's **metric key** (or `entity.type` filter):
  `fetch` → `smartscapeNodes <TYPE>`, `by:{dt.entity.custom_device}` →
  `by:{dt.smartscape.<type>}`. **Result: the entity wall fell 51.2% → 22.0% of
  panels (−3,377), but clean only moved 20.8% → 21.0%** — those panels are
  multiply-blocked (also `mapped-no-recipe` and/or a credential/account traversal).
  Lever #1 is structural groundwork that **unblocks Lever #2**: 961 panels are now
  blocked *solely* by `mapped-no-recipe` (verifying recipes → ~29.3%), and the
  combined soft-ceiling is ~51.3%. The remaining ~2,543 wall panels are
  non-bridge exotics (athena, appsync, …) or have no metric key.

**Newly-surfaced third lever:** ~2,457 disambiguated panels use the classic
credential/account traversal `entityAttr(custom_device, "accessible_by")[aws_credentials]`
(the fieldsAdd form, distinct from the Pass 0.5 lookup-chain). That account-name
resolution is flagged (`custom-device-disambiguated`) but not yet auto-converted —
it's the gating co-blocker alongside Lever #2 for the heavily-replicated dashboards.

**Open follow-up surfaced this session:** the DAC's `.By.<Dim>` pick isn't
data-validated in general — dim-validation repairs it per-tenant at lookup time,
but the underlying mapping table (`aws_mapping.*` / DAC) still ships the
canonical-but-sometimes-empty dim. Consider a manual override for aurora/docdb
`DatabaseConnections` → instance-level so it's correct even without a live
inventory.

## What's been done (recent commit series)

```
7a97a22 Namespace outputs by tenant so multiple environments don't collide
8ec06f2 Add extra-mappings tier (manual + per-key) to the lookup chain
e2e5555 Dashboard pipeline commands and detect-per-resource --accounts flag
f49923e Rewriter passes for the dashboard pipeline, plus not-planned-lookup bailout
ddb3ad1 Expand the lookup chain: DAC fallback, entity coverage, supporting tables
071743f Refresh dt-migration skill and add CLAUDE.md project guide
```

Highlights:
- **3-tier lookup chain** (recipe → extra-mappings → DAC). The extra-mappings
  tier just landed: dropped unknown-metric warnings 1,356 → 1,135 (−16% in that
  bucket). See CLAUDE.md "Lookup chain."
- **Not-planned-lookup bailout** — queries with `lookup [fetch dt.entity.<not-planned>]`
  chains (custom_device etc.) are left verbatim instead of producing invalid
  `device.references[…]`. This is correct but is *passthrough, not conversion*
  (see constraint 1) — it's the #1 target for the hand-translation work below.
- **Env-aware outputs** — everything writes under `tools/out/<env-id>/`, derived
  from the tenant URL. A second tenant can't clobber nic55601's analysis. Use
  `--env <label>` or `--out-dir` to override. (`tools/src/lib/paths.ts`.)
- Tests: **141 passing**, typecheck clean.

## What's pending / next steps (highest leverage first)

1. **Hand-translated examples from the user** (in progress). The user is
   translating representative tiles so we can extract auto-translation patterns
   for the buckets we currently bail on. Identified candidate dashboards in
   `tools/out/nic55601/dashboards/new/`:
   - Not-planned-lookup chains: `AAP_JET_Dynamo_DB_Metrics` (warmup, pattern
     already studied), `BIP_Navigator_DynamoDB`, `Copy_of_ECS_overview_-_Region`.
   - Complex `classicEntitySelector`: `Copy_of_EA_Application_Dashboard`.
   - Composite formula (DynamoDB capacity util): any `*_AWS_DynamoDB` dashboard.
   Each unlocked pattern turns a whole bucket of bailouts into real conversions.
   The not-planned-lookup pattern alone covers ~7,300 of the ~9,800 remaining
   flagged panels in the 90-day-active subset.

2. **Port `dt-migration/scripts/migration-lookup.ts` normalization chain** into
   `extra-mappings.ts` / `dac-lookup.ts`. The remaining ~1,135 unknown-metric
   keys (`kafka.*`, `containerinsights.*`, `ecs.*_by_service_name`) DO exist in
   `per-key-mappings.json` under a heavier-normalized shape our exact+lowercase
   lookup misses (prepend `ext:`, lowercase, strip underscores + aggregation
   infixes; rules differ per service). Pure lookup addition, no regression risk.
   Estimated another ~500–800 panels (~5–8% absolute lift).

3. **Expand `CUSTOM_DEVICE_AWS_TYPE_MAP`** (in `dql-rewriter.ts`) from the ~70
   `cloud:aws:*` sub-types in `dt-migration/references/aws-classic.md` (we have
   ~12). Each one unlocks Pass 1.55 for that service family.

4. **Drop dormant dashboards from the target list** — confirm with stakeholders
   that the 333 zero-access dashboards are out of scope. Huge backlog reduction.

## How to reproduce the numbers

```bash
# from tools/, with .env.local pointing at the tenant
node --env-file-if-exists=.env.local --experimental-strip-types \
  --no-warnings=ExperimentalWarning src/cli.ts scan-dashboards   # offline, full corpus
# → tools/out/<env-id>/dashboard-scan/summary.json

# usage/access join is the DQL in tools/out/<env-id>/dashboard-usage.dql,
# run via `cct dql --file …`, then joined against the scan results.jsonl by id.
```
