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
| 1.52 | **Entity-id pin → `aws.arn`**: a query pinned to ONE resource by classic id (`dt.entity.custom_device == "CUSTOM_DEVICE-…"`, `in(…)`, `or`-chains) becomes a filter on the metric's `aws.arn`. Classic and Smartscape ids are different id spaces — converting the dim around the literal gave a comparison that can never match (`toSmartscapeId()` returns a custom device id unchanged). Only runs when the metric key was swapped (classic series carry no `aws.arn`). In `filter:{}` it substitutes in place; post-aggregation (`| filter`) it also adds `aws.arn` to the by-clause, since only by-dims survive as columns. Never half-converts: an `in()` with any unresolved id is left whole and raises the **blocking** `entity-id-unresolved`. | `entity-id-pins.ts` + `entity-arns.ts` (per-tenant `entity-arns.json` from `discover-entity-arns`) |
| 1.55 | Disambiguate `dt.entity.custom_device` → real node type via the query's **metric service** (`cloud.aws.<svc>.…`) or an `entity.type == "cloud:aws:X"` filter: `fetch` → `smartscapeNodes <TYPE>`, bare refs (e.g. `by:{dt.entity.custom_device}`) → `dt.smartscape.<type>`. Warns only on multi-node grain (rds/docdb/neptune) or a leftover credential traversal. | `aws-service-node-types.ts` (baked from `discover-entity-types`) |
| 1.6 | `fetch dt.entity.X` → `smartscapeNodes <TYPE>` | `entity-mappings.ts` |
| 1.7 | `<edge>[dt.entity.X]` → `references[<edge>.<x>]`, with edge validation | `smartscape-edges.ts` |
| 2 | `dt.entity.X` → `dt.smartscape.X` (in any context) | `entity-mappings.ts` |
| 2.5 | `entityName(x)` → `getNodeName(x)`, `entityAttr(x, "f")` → `getNodeField(x, "f")` | inline |
| 2.6 | `entity.name` → `name` (only when fetch was restructured) | inline |
| 2.65 | Classic source-entity signal fields → Smartscape: `dt.source_entity.type` → `dt.smartscape_source.type`, bare `dt.source_entity` → `dt.smartscape_source.id` | inline |
| 2.7 | Classic field rename within Smartscape context (`awsAccountId` → `aws.account.id`) | `entity-field-mappings.ts` |
| 2.73–2.73c | **Classic tag ARRAY idioms → `tags:aws` RECORD key reads.** Classic tags are `"[AWS]Key:value"` strings; the new field is a record whose toString() is JSON, so every classic idiom runs and returns nothing. 2.73 `contains(tags,"K:v")` → `contains(tags[K],"v")`; 2.73b `expand tags` + `splitString`/`matchesPhrase(tags,"[AWS]K:")` pairs → key reads, expand dropped (guard reads live code only, not comments); 2.73c `parse [lower(]toString(arraySort(tags))[)], "LD 'K:'ALPHA:x …"` → `fieldsAdd x = [lower(]tags[K][)]` (+ `DATA`, char-class types, backtick keys with colons) and inline `contains(toString(tags),"K:v")`. `location` → `aws.region` field. Each verified side by side on sfz80352. What remains (e.g. two entity types' tags merged in one `if()` then expanded) is lint-blocked for a human. | inline |
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

**Measured 2026-09-15 — do NOT port the skill's normalization chain.** This section used to claim that porting `scripts/migration-lookup.ts`'s multi-attempt normalization was "the highest-leverage way to convert more metric keys". It isn't. That chain was implemented and run against the keys our lookup *actually* fails on: it resolved **3 of 67** on nic55601 and **1 of 76** on sfz80352. Its steps target `builtin:` / `ext:` / `dt.cloud.` prefixes, `:avg`-style selector modifiers and `ByFoo` suffixes — shapes our corpus has already normalized away. Our unresolved keys are bare `cloud.aws.<service>.<snake_case>` that genuinely have no entry in any tier (e.g. `cloud.aws.lambda.concurrent_executions_max`, `cloud.aws.fsx.free_data_storage_capacity_sum`). They need mapping-table coverage, not smarter normalization. (When measuring this, scope to keys that fail OUR chain — regex-scraping every key out of a query flagged `unknown-metric` picks up keys that resolve fine and inflates the number.)

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
- `download-dashboards` → dumps every dashboard (new platform + classic) as JSON. Clears the target dir first (fresh dump — no stale/deleted files linger). `--used-within-days <N>` scopes the **new** side to dashboards *opened* in the last N days (usage via `dt.system.events`, `lib/asset-usage.ts`); classic dashboards aren't documents so the filter skips them.
- `scan-dashboards` → runs the rewriter against all downloaded dashboards, filters to AWS, emits coverage report
- `rewrite-dashboard` → produces three artifacts per input: `.rewritten.json` (wrapper for re-use through our tools), `.rewrite-report.md` (per-tile transforms + warnings), `.upload.json` (inner content, name suffixed `(rewritten)`, ready to drop in via Dynatrace import UI)
- `compare-dashboard` → runs original AND rewritten queries against the tenant in parallel, classifies parity (`match` / `mismatch` / `one-side-empty` / `both-empty` / `both-error`), emits markdown side-by-side
- `discover-fields` → probes tenant for actual smartscape field schemas (used to seed `entity-field-mappings.ts`)
- `discover-tags` → finds which AWS tags the new connection enriches onto metrics (writes `enriched-tags.json`); enriched tags become cheap `aws.tags.<key>` dim filters, others need a `smartscapeNodes` lookup
- `discover-entity-arns` → resolves every classic entity id found in the downloaded QUERIES to the ARN of the resource it named (writes `entity-arns.json`, merged so a resolved ARN survives the classic entity later disappearing). Reads query text only — never whole notebook files, which hold the stored results of past runs (1.9 GB on nic55601). The ARN is the join key on all three sides: the classic entity's `arn`, the Smartscape node's `aws.arn`, and `aws.arn` as a dimension on 45/45 services' new metric series.
- `discover-metrics` → inventories live new-connection metric keys + series counts (writes `live-metrics.json`); feeds the dim-variant validation in the lookup chain
- `rewrite-dql` → single-query interactive form

**Notebook + anomaly-detector pipeline** (same rewriter, other asset types):
- `download-notebooks` → dumps every notebook (Document Service, `type == 'notebook'`) as `<tenant>/notebooks/<id>__<slug>.json` (same `{ metadata, content }` wrapper as dashboards; clears the dir first). Notebook DQL lives in `content.sections[].state.input.value`. `--used-within-days <N>` scopes to notebooks opened in the last N days (`lib/asset-usage.ts`; manifest records `lastAccessed`/`accessCount`).
- `download-anomaly-detectors` → dumps Davis anomaly detectors (Settings 2.0 `builtin:davis.anomaly-detectors`, via `dynatrace/settings.ts`) to `<tenant>/anomaly-detectors/objects.json`. DQL lives in `value.analyzer.input[]` under `key == "query"`. (Classic `builtin:anomaly-detection.metric-events` use metric *selectors*, not DQL — a separate transform, not yet built.)
- `scan-notebooks` / `scan-anomaly-detectors` → run the rewriter over the extracted DQL, filtered to AWS-referencing assets, emitting a coverage report (`<subdir>/summary.json|results.jsonl|summary.md`). Both are thin wrappers over the shared scan core.
- Shared core: `lib/asset-scan.ts` (AWS markers incl. the **bare `cloud.aws.`** form — `scan-dashboards` uses the same list; its old private copy lacked the bare form and hid every bare-key dashboard (487 across both tenants, found 2026-10-07), `looksLikeDql`, `classifyRewrite` into clean/soft/blocked/no-op, `ScanAccumulator`) — kept fetch/fs-free for App reuse; `lib/asset-scan-run.ts` (Node runner + report writer); `lib/asset-extractors.ts` (`extractNotebookQueries`, `extractDetectorQueries`, pure + tested). The bucketing matches `scan-dashboards` so reports are comparable.

**Placement pipeline (staged publish → human review → in-place cutover):** turns rewritten content into *live* assets safely, tracked per-asset in a shared `.xlsx` (`<tenant>/migration-tracker.xlsx`; the team's live copy lives outside the repo — point `--tracker`, or `DT_TRACKER_PATH` once, at it), gated by confidence. **All tenant I/O goes through the Document Service API** (`dynatrace/document.ts`, `DocumentClient`) with an **admin platform token** (`document:documents:read+write+admin`): create (stage copy), get (pull), update-with-`admin-access` (cutover, works for **any** owner), delete. **No dtctl** — its `apply` can’t admin-write others’ docs. Cutover preserves owner (a content update, not an ownership change; no owner-flip needed).
- `migrate-refresh` → **read-only**; builds/refreshes the tracker by joining scan buckets + `compare-dashboard` parity + download manifest, assigning each AWS asset a **confidence + lane** via `lib/asset-confidence.ts`: **fast** (clean rewrite AND parity all-match → cut over directly after approval), **review** (soft/mismatch/some-blocked → publish a copy, human fixes), **blocked** (nothing auto-converted → manual rebuild). Preserves human columns + workflow status.
- `migrate-stage` → review lane: create a migrated **copy** (`createDocument`), name **prefixed** `[MIGRATION REVIEW] `, shared **read-write with an access group** (`--share-group <id>` / `DT_SHARE_GROUP_ID`, else environment-wide via `shareEnvironment`). Each converted tile keeps its **original classic query as a `//` reference comment** (`commentOriginal`, `annotateOriginal` opt on `rewriteInPlace`). Original untouched. `--restage` re-applies the rewrite to already-published copies in place.
- `migrate-pull` → fetch the human-fixed copy (`getDocumentFull`) into `migration/reviewed/<id>.json`.
- `migrate-promote` → **cutover**: publishes rows whose `decision` = **Ready To Publish**. **Notebooks are never cut over in place** — a notebook stores the results of its past runs, so overwriting it destroys them. Instead the reviewed copy is published AS a new notebook (`publish-notebook.ts` + `lib/notebook-publish.ts`) under the original's **own title** (no suffix — later upgrades would stack them), reference comments stripped, **labelled `aws-new-integration`** (the original gets `aws-classic-superseded`; labels exist on the live API though SDK 1.30 lacks them — set via one multipart `labels` field each on `PATCH /documents/{id}`, a write REPLACES the set so always merge, filterable with `labels contains '…'`). The labels — not the tracker — decide "already published": a stale save of the shared workbook reverted the tool's rows on 2026-10-06, so a labelled pair is recorded and left alone unless `--republish`. `scan-notebooks` skips superseded originals. a notice tile prepended (id `cct-migration-notice`, idempotent) linking the original, and given the original's **owner and exact sharing settings** — `isPrivate`, `isReshareable`, every direct share (user/group recipients + access) and every environment share (`lib/doc-sharing.ts` plans the diff **per access level** — a document has at most ONE direct share per level and a second create is HTTP 409, so recipients are added/removed on the existing share (`/direct-shares/{id}/recipients/add|remove`), never a second share; treating that 409 as "already shared" cost 5 users their access in the first bulk run). **Notebook drift guard:** before publishing, the live original's *authored* content (sections, order, query, markdown, title, chart type — not stored results or `visualizationSettings`) is compared with the downloaded base the copy was staged from; any owner edit skips it (`authoredChangesSince`; `--force` overrides), since the new notebook would be missing that work. A version check can't do this: running a query bumps a notebook's version. Order matters: flags are owner-only, so sharing is mirrored while the tool still owns the copy and `:transfer-owner` (which removes our own access; we keep working via admin-access) goes last; both are then re-read and verified. The original gets exactly ONE change — a pointer tile at its top (id `cct-migration-pointer`) linking the new notebook, since otherwise its owner can't find it; the write is version-locked and the original is re-read to prove every other section (stored results included) is byte-identical. Its tracker status is `published-new` (not `promoted`), so verify/rollback never treat the ORIGINAL as cut over; `migrate-rollback` restores the copy from `migration/pre-publish/<id>.json` and removes only the pointer section from the original (not a snapshot restore, so owner edits made since survive). **Dashboards** are updated **original in place** via `DocumentClient.updateContent` (multipart PATCH, `admin-access`; name restored, reference comments stripped via `stripOriginalCommentsInPlace`), then stamps `decision` = **Published** back. Needs an admin token (DT_BASE_URL + DT_TOKEN). Drift-guarded (re-reads live version vs `based_on_version`, abort unless `--force`); snapshots the pre-cutover content to `migration/pre-promote/<id>.json` and records `pre_promote_version`.
- `migrate-verify` / `migrate-rollback` → confirm the live version advanced / re-apply the pre-cutover snapshot (admin write). Both use the admin token, not dtctl.
- **Every mutating command defaults to PREPARE mode** (writes the payload under `migration/{staged,promote}/` for inspection, **no writes**); `--apply` performs the Document-API write. Safety: copy = new doc (no interruption during review); cutover = in-place content swap on the same id/URL (owner preserved); drift guard on promote; nothing writes without `--apply`.
- Modules: `dynatrace/document.ts` (`DocumentClient`: create/get/update/delete, multipart, `admin-access` — the whole tenant write+read surface, validated live), `lib/doc-apply.ts` (build the apply object; create=no id, update=original id), `lib/tracker-xlsx.ts` (**exceljs** — tool owns its columns, humans own `assignee`/`decision`/`reviewer`/`notes`, joined by `asset_id`; **one workbook, two sheets**: `migration` for dashboards+notebooks, `alerts` for anomaly detectors (`sheetForAssetType`), since the two have different lifecycles but reviewers want one file. `upsertRows` **throws** rather than write a row onto the wrong sheet — mixing 990 detector rows into the dashboards sheet is painful to undo in a file the team has open; `decision` is a dropdown-enforced vocabulary — **Descope / Needs Review / In Progress / Ready To Publish / Published** (`DECISION_STATES`) — and the tool writes back only `Published` after a cutover), `lib/asset-confidence.ts`, `lib/migrate-support.ts` (`findOriginal`). Reuses the exported `rewriteInPlace` from `rewrite-dashboard.ts`. **New runtime dep: `exceljs`**. **Prereq:** an admin platform token with `document:documents:read+write+admin` (all migrate commands).

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
