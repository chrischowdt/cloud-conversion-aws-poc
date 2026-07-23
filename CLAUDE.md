# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Tooling to migrate Dynatrace customer assets (dashboards, alerts, SLOs) from the **classic AWS cloud integration** to the **new Smartscape-on-Grail integration**. The repo is split into two halves that work together:

- **`tools/`** — Node 22 + TypeScript CLI (`cct`) that downloads dashboards, scans them for classic references, rewrites the DQL + structured config to the new form, and validates the rewrite against a live tenant. This is the active codebase.
- **`product-ai-knowledgebase/dt-migration-cloud/`** — Dynatrace R&D's authoritative AWS/Azure/GCP cloud-migration skill (markdown references + JSON). **Relocated here 2026-06-16** (was `dt-migration/` at repo root; `tools/src/lib/paths.ts` `SKILL_*` point at `dt-migration-cloud/references/`). Consult its `SKILL.md` for the migration framework and `references/*.md` for the entity/metric/relationship rules our rewriter implements. **These files are SOURCE OF TRUTH** — when they conflict with our hardcoded tables, prefer the skill, *except where empirical tenant probing has proven the skill wrong* (see "Known skill drift" below). Note: doc paths elsewhere in this file written as `dt-migration/references/X` now live at `product-ai-knowledgebase/dt-migration-cloud/references/X`. Two sibling skills were also added: `product-ai-knowledgebase/dt-migration/` (general classic→Grail entities/DQL/tags) and `product-ai-knowledgebase/dt-dql-essentials/` (full DQL + Smartscape topology — `smartscape-topology-navigation.md`, `dql-function-migration.md`).

`INTEGRATION.md` explains why the two halves must compose; `RESEARCH.md` and `GAP_ANALYSIS.md` are dated background, not living docs.

## Common commands

All commands run from the `tools/` directory.

```bash
npm install                       # one-time
cp .env.example .env.local        # then edit DT_BASE_URL + DT_TOKEN
npm run typecheck                 # tsc --noEmit
npm test                          # Node's built-in test runner over src/**/*.test.ts
node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/lib/dql-rewriter.test.ts  # single test file
```

### Invoking CLI subcommands

Two patterns — they differ because npm eats `--flags` it doesn't recognize:

```bash
# 1. npm scripts work for commands whose flags don't collide with npm:
npm run discover
npm run typecheck

# 2. For everything with a --flag arg, invoke node directly:
node --env-file-if-exists=.env.local --experimental-strip-types --no-warnings=ExperimentalWarning \
  tools/src/cli.ts rewrite-dashboard --in tools/out/<env-id>/dashboards/new/<id>__<name>.json
```

If you use `npm run cli -- subcommand --flag value`, npm will warn about unknown CLI config and strip `--flag`. **Always invoke `node ... src/cli.ts <subcommand>` directly when passing args.** `cct --help` lists subcommands.

### Tenant connection

- `DT_BASE_URL` must be `https://<env-id>.apps.dynatrace.com` — the Grail Storage Query API (`/platform/storage/query/v1/...`) is NOT served from `live.dynatrace.com`.
- `DT_TOKEN` is a Platform Token; minimum scopes per command are documented in each command's source.
- **Outputs are namespaced by tenant.** Every tenant-touching command writes under `tools/out/<env-id>/`, where `<env-id>` is derived from `DT_BASE_URL` (`https://nic55601.apps…` → `tools/out/nic55601/`). Tenant-independent artifacts (`build-mapping`) go to `tools/out/shared/`. Override the namespace with `--env <label>` or the whole path with `--out-dir <path>`. This is what lets a second tenant be analyzed without clobbering the first. `envIdFromBaseUrl` / `tenantOutDir` in `tools/src/lib/paths.ts` own the derivation; offline commands that consume tenant data (`scan-dashboards`) resolve the env from `--env`/`--base-url`/`DT_BASE_URL`.

## Architecture

### The DQL rewriter (`tools/src/lib/dql-rewriter.ts`)

Multi-pass regex pipeline that translates a classic DQL string into its Smartscape equivalent. Passes run in this exact order (changing the order breaks correctness):

| # | Pass | Source |
|---|---|---|
| 0.5 | **Credential-lookup-chain** (runs FIRST, before the bailout): rewrite the canonical `lookup [fetch dt.entity.custom_device … accessible_by[dt.entity.aws_credentials]] … lookup [fetch dt.entity.aws_credentials … account name]` idiom to `smartscapeNodes <TYPE>` + AWS_ACCOUNT lookups. The metric's service disambiguates the otherwise-ambiguous `custom_device` to a concrete node type. No-op (and the bailout fires) if the idiom or service isn't resolvable. | `rewriteCredentialLookupChain` (inline) |
| 0.6 | **Credential fieldsAdd**: the `entityAttr(custom_device,"accessible_by")[dt.entity.aws_credentials] → entityName(…)` account-NAME field-read → resource→AWS_ACCOUNT name join (no resource→AWS_ACCOUNT edge exists). | `rewriteCredentialFieldsAdd` (inline) |
| 0.7 | **Credential→account-id lookup**: the `fieldsAdd <cred>=accessible_by[dt.entity.aws_credentials][0]` + `lookup [fetch dt.entity.aws_credentials … awsAccountId]` join → the resource node's denormalized `aws.account.id` field. Result-guarded: reverts to no-op unless the collapse is clean+complete (no half-rewrite). | `rewriteCredentialAccountLookup` (inline) |
| 0 | **Pre-pass bailout**: if the query *still* contains a `lookup [fetch dt.entity.<not-planned>]` chain (e.g. `custom_device`), return the query verbatim with one warning — partial translation produces invalid DQL (`device.references[…]` doesn't exist). | inline (`findNotPlannedLookupSource`) |
| 1 | Metric-key swap + recipe application (`agg(classic) → agg(new)`) | `recipe-lookup.ts` |
| 1.4 | Realign backtick-quoted column refs to the swapped key (`` `agg(classic)` `` → `` `agg(new)` ``) so the renderer doesn't raise `FIELD_DOES_NOT_EXIST`; warn on refs that can't be matched | inline |
| 1.5 | `in(<dim>, classicEntitySelector("..."))` → translated filter | `classic-selector-parser.ts` + `classic-selector-translator.ts` |
| 1.55 | Disambiguate `dt.entity.custom_device` → real node type via the query's **metric service** (`cloud.aws.<svc>.…`) or an `entity.type == "cloud:aws:X"` filter: `fetch` → `smartscapeNodes <TYPE>`, bare refs (e.g. `by:{dt.entity.custom_device}`) → `dt.smartscape.<type>`. Warns only on multi-node grain (rds/docdb/neptune) or a leftover credential traversal. | `aws-service-node-types.ts` (baked from `discover-entity-types`) |
| 1.6 | `fetch dt.entity.X` → `smartscapeNodes <TYPE>` | `entity-mappings.ts` |
| 1.7 | `<edge>[dt.entity.X]` → `references[<edge>.<x>]`, with edge validation | `smartscape-edges.ts` |
| 2 | `dt.entity.X` → `dt.smartscape.X` (in any context) | `entity-mappings.ts` |
| 2.5 | `entityName(x)` → `getNodeName(x)`, `entityAttr(x, "f")` → `getNodeField(x, "f")` | inline |
| 2.6 | `entity.name` → `name` (only when fetch was restructured) | inline |
| 2.65 | Classic source-entity signal fields → Smartscape: `dt.source_entity.type` → `dt.smartscape_source.type`, bare `dt.source_entity` → `dt.smartscape_source.id` | inline |
| 2.7 | Classic field rename within Smartscape context (`awsAccountId` → `aws.account.id`) | `entity-field-mappings.ts` |
| 2.8 | Warn when `by:{dt.smartscape.X}` references a non-carrier dim | `metric-dim-carriers.ts` |
| 3 | Flag `classicEntitySelector`, classic entity ID literals | inline |

Each pass writes to `transforms[]` (what changed) and `warnings[]` (what the user needs to verify). Outputs are surfaced in the rewrite report.

### Lookup chain (`tools/src/lib/recipe-lookup.ts`)

`lookupClassicKey(index, key)` consults sources in order, returning the first hit. Three tiers, each broader and less precise than the last:

1. **Recipe index** — our enriched `mappings/aws_mapping.with_recipes.json`. Carries `detectedRecipe` (verified aggregation + scale) and `compositeFormula`. The only tier that applies a *verified* aggregation/scale.
2. **Extra-mappings** (`extra-mappings.ts`) — two dt-migration files loaded together:
   - `manual-metric-mappings.json` (~117) — hand-curated abbreviations that don't algorithmically derive from CloudWatch (`cloud.aws.alb.bytes`, `cloud.aws.aurora.*_by_role`, `cloud.aws.eccustom.*`, `cloud.aws.rds.free`). The DAC will never resolve these.
   - `per-key-mappings.json` (~5,709) — the skill team's own pre-resolved normalization output. `lookupInExtra` tries exact-match then a lowercased fallback (per-key keys are fully lowercased; dashboards often preserve CamelCase from the v2 API). Manual wins when both have a key.
3. **DAC index** (`dac-lookup.ts`) — the authoritative `dt-migration/references/dac-aws-to-2ndgen-metrics.json` (~4,168 entries). Last resort, broadest coverage.

Tiers 2 and 3 return synthetic `mapped-no-recipe` entries — metric-key swap only, user's aggregation preserved, `availability: recommended | autodiscovered`, with a note saying which file resolved it.

**Dim-variant validation (`live-metrics.ts`)** — optional post-step on the synthetic tiers only. The DAC resolves a classic key to ONE new key with a specific `.By.<Dim>` suffix, but that variant may have no series on a given tenant while a sibling (same metric, different dims) does. Verified on nic55601: `cloud.aws.rds.DatabaseConnections.By.DBClusterIdentifier` (the DAC's pick for aurora) = **0 series**, `…By.DBInstanceIdentifier` = **109**. When a tenant's `live-metrics.json` (from `discover-metrics`) is loaded, `applyDimOverride` swaps an empty key to the most-populated sibling and surfaces a `dim-variant-override` warning. **Conservative by design:** scoped to `mapped-no-recipe` only (never verified recipe-tier keys, whose agg/scale is calibrated for a specific dim); only swaps on positive evidence; requires the target to clear `minOverrideSeries` (default 2 — a 1-series target is too thin to trust on an incompletely-collected tenant). The inventory only sees *currently-collected* metrics, so an absent key may be valid-but-not-collected rather than wrong — hence the always-on warning. Opt-in: nothing changes unless you've run `discover-metrics` for that tenant. Tune with `--min-override-series`.

The DAC index is built with **four indexes** keyed by every classic-key shape a dashboard might use: `builtin:cloud.aws.*`, `ext:cloud.aws.*`, the derived `dt.cloud.aws.*` form, and the camelCase→snake_case-derived bare `cloud.aws.<svc>.<snake>` form. New-form keys (with `.By.<PascalCase>` suffix) are rejected here.

**Known gap (next iteration):** many tail unknown-metric keys (`kafka.*`, `containerinsights.*`, `ecs.*_by_service_name`) exist in `per-key-mappings.json` under a heavier-normalized shape (prepend `ext:`, lowercase, strip underscores + aggregation infixes) that the current exact+lowercase lookup misses. The skill's `dt-migration/scripts/migration-lookup.ts` implements the full multi-attempt normalization chain — porting it is the highest-leverage way to convert more metric keys.

### Lookup tables (the data the rewriter depends on)

| File | What it indexes | Source of truth |
|---|---|---|
| `entity-mappings.ts` | classic entity type → Smartscape node type + dim. **AWS-only scope**: `entityScope()` gates every entity pass so only `AWS_*`-node entities convert; non-AWS (APM `service`/`host`/`process_group[_instance]`, RUM `application`, K8s `cloud_application*`/`kubernetes_*`, `azure_*`, …) are left **untouched** with a non-blocking `non-aws-entity` note (they belong to the general migration and converting them over-reached — a `process_group_instance → dt.smartscape.process` conversion passed the rewriter but failed at runtime with `ENRICHMENT_FUNCTION_TABLE_SIZE`). | `dt-migration/references/entity-type-mapping.md` |
| `aws-service-node-types.ts` | AWS metric-service (`cloud.aws.<svc>`) → Smartscape node type, for custom_device disambiguation | empirical: `discover-entity-types` reads `dt.smartscape_source.type` (the entities JSON's `dacResourceType` has wrong granularity) |
| `entity-field-mappings.ts` | per-node-type field renames (`awsAccountId`, `rdsEngine`, …) | empirical tenant probing |
| `metric-dim-carriers.ts` | which Smartscape types carry their dim on metric series | empirical tenant probing |
| `smartscape-edges.ts` | valid `<edge>` names per (source, target) Smartscape pair | `dt-migration/references/relationship-mappings.md` |
| `eol-lookup.ts` | classic metric key → EOL announcement | `dt-migration/references/end-of-life-services.json` |

### CLI surface (`tools/src/commands/`)

Two pipelines that share the rewriter:

**Mapping pipeline** (offline, builds the recipe table):
- `build-mapping` → unifies DAC reference JSON
- `discover` → enumerates `cloud.aws.*` keys on a tenant via DQL
- `equivalence` → checks classic↔new metric pairs produce same data
- `detect` / `detect-all` / `detect-per-resource` → fits aggregation + scale recipes per pair (top-K resource sampling is the most reliable mode)
- `merge-recipes` → folds detected recipes back into `mappings/aws_mapping.json`
- `reconcile-metrics` → offline join of a tenant's classic keys (`discover`) → mapped new key (lookup chain) → live inventory (`discover-metrics`). Emits `metric-reconciliation.csv` + `.md` bucketing every classic-with-data key as **collected** / **add-to-new** (mapped to a real new key not flowing here) / **unmapped-add-metric** (service onboarded, this metric absent) / **custom-or-metric-streams** (service not collected at all → arbitrary custom key). The unmapped tail is placed via a classic→new *service bridge* built from the pairs that did map, plus a conservative metric-name match (heuristic `unmapped-likely-collected` rows are labelled "verify"). Answers "which metric keys must we add to the new integration?". Logic in `lib/metric-reconcile.ts` (pure, tested).

**Dashboard pipeline** (the user-facing migration loop):
- `download-dashboards` → dumps every dashboard (new platform + classic) as JSON
- `scan-dashboards` → runs the rewriter against all downloaded dashboards, filters to AWS, emits coverage report
- `rewrite-dashboard` → produces three artifacts per input: `.rewritten.json` (wrapper for re-use through our tools), `.rewrite-report.md` (per-tile transforms + warnings), `.upload.json` (inner content, name suffixed `(rewritten)`, ready to drop in via Dynatrace import UI)
- `compare-dashboard` → runs original AND rewritten queries against the tenant in parallel, classifies parity (`match` / `mismatch` / `one-side-empty` / `both-empty` / `both-error`), emits markdown side-by-side
- `discover-fields` → probes tenant for actual smartscape field schemas (used to seed `entity-field-mappings.ts`)
- `discover-tags` → finds which AWS tags the new connection enriches onto metrics (writes `enriched-tags.json`); enriched tags become cheap `aws.tags.<key>` dim filters, others need a `smartscapeNodes` lookup
- `discover-metrics` → inventories live new-connection metric keys + series counts (writes `live-metrics.json`); feeds the dim-variant validation in the lookup chain
- `rewrite-dql` → single-query interactive form

**Notebook + anomaly-detector pipeline** (same rewriter, other asset types):
- `download-notebooks` → dumps every notebook (Document Service, `type == 'notebook'`) as `<tenant>/notebooks/<id>__<slug>.json` (same `{ metadata, content }` wrapper as dashboards). Notebook DQL lives in `content.sections[].state.input.value`.
- `download-anomaly-detectors` → dumps Davis anomaly detectors (Settings 2.0 `builtin:davis.anomaly-detectors`, via `dynatrace/settings.ts`) to `<tenant>/anomaly-detectors/objects.json`. DQL lives in `value.analyzer.input[]` under `key == "query"`. (Classic `builtin:anomaly-detection.metric-events` use metric *selectors*, not DQL — a separate transform, not yet built.)
- `scan-notebooks` / `scan-anomaly-detectors` → run the rewriter over the extracted DQL, filtered to AWS-referencing assets, emitting a coverage report (`<subdir>/summary.json|results.jsonl|summary.md`). Both are thin wrappers over the shared scan core.
- Shared core: `lib/asset-scan.ts` (AWS markers incl. the **bare `cloud.aws.`** form these assets use, `looksLikeDql`, `classifyRewrite` into clean/soft/blocked/no-op, `ScanAccumulator`) — kept fetch/fs-free for App reuse; `lib/asset-scan-run.ts` (Node runner + report writer); `lib/asset-extractors.ts` (`extractNotebookQueries`, `extractDetectorQueries`, pure + tested). The bucketing matches `scan-dashboards` so reports are comparable.

### Dashboard JSON has dual representation

This is the biggest non-obvious thing in the codebase. A new-platform dashboard tile carries BOTH:

1. A **DQL `query` string** that the engine executes.
2. A **structured `queryConfig.subQueries[]` mirror** + **`visualizationSettings` column refs** (in `fieldMapping.leftAxisValues`, `hiddenLegendFields`, `table.columnTypeOverrides[].fields`) that the dashboard editor and renderer read.

Rewriting only the DQL leaves the renderer pointing at column names that no longer exist → "Invalid data mapping". `rewrite-dashboard.ts` applies a SECOND pass (`rewriteStructuredString`) to the shadow representations. When adding new dashboard-rewrite logic, **don't forget the shadow pass**.

### Known skill drift

The dt-migration skill files have a small number of typos / stale entries the rewriter compensates for. If something in our hardcoded tables disagrees with the skill, check this list first:

| Skill says | Reality | Our handling |
|---|---|---|
| `dt.smartscape.aws.lambda_function` (dotted) | `dt.smartscape.aws_lambda_function` (underscore) — every AWS Smartscape dim follows `dt.smartscape.<lowercase_node_type>` | `entity-mappings.ts` corrected; `entity-mappings.test.ts` enforces the convention |
| `dt.entity.aws_credentials` field `awsAccountId` migrates 1:1 | New side renames it to `aws.account.id` | `entity-field-mappings.ts` |
| All smartscape types carry their dim on metric series | As of the 2026-06-17 re-probe, nearly all DO (incl. ECS/EFS/NAT GW/API GW — the May "non-carrier" list was stale; enrichment matured). Only `AWS_APIGATEWAYV2_API` is unverified (no data). | `metric-dim-carriers.ts` (re-probe method in its header); non-carrier caveat is the **non-blocking** `dim-not-carried` kind |

When proposing a new mapping, **probe the tenant first** (`cct dql --query "smartscapeNodes <TYPE> | limit 1"`) rather than trusting type-mappings.md verbatim. The carrier table in particular **drifts** as the connection evolves — re-probe per tenant before trusting it.

### Conventions enforced by tests

- `entity-mappings.test.ts` fails the build if any `smartscapeDimension` drifts from `dt.smartscape.${nodeType.toLowerCase()}`.
- `dql-rewriter.test.ts` covers each pass independently — when adding a pass, add a colocated test in the right `describe` block. Tests use `buildIndex([entries])` to construct a fake `RecipeIndex`.

## Reusing modules in the Dynatrace App

`tools/src/dynatrace/{dql,document,classic-dashboards}.ts`, `lib/dql-parser.ts`, `lib/stats.ts`, and `lib/types.ts` are zero-dep and rely only on Web `fetch`. They're intended to lift directly into the `cloud-migration-helper` App. The rewriter itself (`dql-rewriter.ts` and its lookup tables) is also pure-TS with no Node-specific APIs except for `node:fs/promises` in the loaders — separable if needed.
