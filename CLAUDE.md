# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Tooling to migrate Dynatrace customer assets (dashboards, alerts, SLOs) from the **classic AWS cloud integration** to the **new Smartscape-on-Grail integration**. The repo is split into two halves that work together:

- **`tools/`** — Node 22 + TypeScript CLI (`cct`) that downloads dashboards, scans them for classic references, rewrites the DQL + structured config to the new form, and validates the rewrite against a live tenant. This is the active codebase.
- **`dt-migration/`** — Dynatrace R&D's authoritative skill (markdown references + Python scripts). Consult `dt-migration/SKILL.md` for the canonical migration framework (Phase 1 discovery → Phase 4 cutover) and `dt-migration/references/*.md` for the entity/metric/relationship rules our rewriter implements. **The skill files in this directory are SOURCE OF TRUTH** — when they conflict with our hardcoded tables, prefer the skill, *except where empirical tenant probing has proven the skill wrong* (see "Known skill drift" below).

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
| 0 | **Pre-pass bailout**: if the query contains a `lookup [fetch dt.entity.<not-planned>]` chain (e.g. `custom_device`), return the query verbatim with one warning — partial translation produces invalid DQL (`device.references[…]` doesn't exist). | inline (`findNotPlannedLookupSource`) |
| 1 | Metric-key swap + recipe application (`agg(classic) → agg(new)`) | `recipe-lookup.ts` |
| 1.4 | Warn on orphan backtick column refs (`\`agg(classic)\``) | inline |
| 1.5 | `in(<dim>, classicEntitySelector("..."))` → translated filter | `classic-selector-parser.ts` + `classic-selector-translator.ts` |
| 1.55 | `fetch dt.entity.custom_device \| filter entity.type == "cloud:aws:X"` → `smartscapeNodes <TYPE>` | inline (CUSTOM_DEVICE_AWS_TYPE_MAP) |
| 1.6 | `fetch dt.entity.X` → `smartscapeNodes <TYPE>` | `entity-mappings.ts` |
| 1.7 | `<edge>[dt.entity.X]` → `references[<edge>.<x>]`, with edge validation | `smartscape-edges.ts` |
| 2 | `dt.entity.X` → `dt.smartscape.X` (in any context) | `entity-mappings.ts` |
| 2.5 | `entityName(x)` → `getNodeName(x)`, `entityAttr(x, "f")` → `getNodeField(x, "f")` | inline |
| 2.6 | `entity.name` → `name` (only when fetch was restructured) | inline |
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

The DAC index is built with **four indexes** keyed by every classic-key shape a dashboard might use: `builtin:cloud.aws.*`, `ext:cloud.aws.*`, the derived `dt.cloud.aws.*` form, and the camelCase→snake_case-derived bare `cloud.aws.<svc>.<snake>` form. New-form keys (with `.By.<PascalCase>` suffix) are rejected here.

**Known gap (next iteration):** many tail unknown-metric keys (`kafka.*`, `containerinsights.*`, `ecs.*_by_service_name`) exist in `per-key-mappings.json` under a heavier-normalized shape (prepend `ext:`, lowercase, strip underscores + aggregation infixes) that the current exact+lowercase lookup misses. The skill's `dt-migration/scripts/migration-lookup.ts` implements the full multi-attempt normalization chain — porting it is the highest-leverage way to convert more metric keys.

### Lookup tables (the data the rewriter depends on)

| File | What it indexes | Source of truth |
|---|---|---|
| `entity-mappings.ts` | classic entity type → Smartscape node type + dim | `dt-migration/references/entity-type-mapping.md` |
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

**Dashboard pipeline** (the user-facing migration loop):
- `download-dashboards` → dumps every dashboard (new platform + classic) as JSON
- `scan-dashboards` → runs the rewriter against all downloaded dashboards, filters to AWS, emits coverage report
- `rewrite-dashboard` → produces three artifacts per input: `.rewritten.json` (wrapper for re-use through our tools), `.rewrite-report.md` (per-tile transforms + warnings), `.upload.json` (inner content, name suffixed `(rewritten)`, ready to drop in via Dynatrace import UI)
- `compare-dashboard` → runs original AND rewritten queries against the tenant in parallel, classifies parity (`match` / `mismatch` / `one-side-empty` / `both-empty` / `both-error`), emits markdown side-by-side
- `discover-fields` → probes tenant for actual smartscape field schemas (used to seed `entity-field-mappings.ts`)
- `rewrite-dql` → single-query interactive form

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
| All smartscape types carry their dim on metric series | ~14 types don't (ECS, EFS, NAT Gateway, …) | `metric-dim-carriers.ts` |

When proposing a new mapping, **probe the tenant first** (`cct dql --query "smartscapeNodes <TYPE> | limit 1"`) rather than trusting type-mappings.md verbatim.

### Conventions enforced by tests

- `entity-mappings.test.ts` fails the build if any `smartscapeDimension` drifts from `dt.smartscape.${nodeType.toLowerCase()}`.
- `dql-rewriter.test.ts` covers each pass independently — when adding a pass, add a colocated test in the right `describe` block. Tests use `buildIndex([entries])` to construct a fake `RecipeIndex`.

## Reusing modules in the Dynatrace App

`tools/src/dynatrace/{dql,document,classic-dashboards}.ts`, `lib/dql-parser.ts`, `lib/stats.ts`, and `lib/types.ts` are zero-dep and rely only on Web `fetch`. They're intended to lift directly into the `cloud-migration-helper` App. The rewriter itself (`dql-rewriter.ts` and its lookup tables) is also pure-TS with no Node-specific APIs except for `node:fs/promises` in the loaders — separable if needed.
