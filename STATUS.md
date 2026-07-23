# Project status — AWS classic→Smartscape asset conversion

_Snapshot for transferring context between sessions. Updated 2026-07-23._

This is a **living status doc**, not background. `RESEARCH.md` / `GAP_ANALYSIS.md`
are dated and frozen; `INTEGRATION.md` explains the two-halves composition;
`CLAUDE.md` is the architecture reference. This file is "where we are right now."

Scope has grown beyond dashboards: the same DQL rewriter now also drives
**notebooks** and **Davis anomaly detectors**, and a **metric reconciliation**
answers "which metric keys must we add to the new integration?" (see the
2026-07-23 section).

## 2026-07-23 — metric reconciliation + notebooks & Davis anomaly detectors

**Metric reconciliation (`reconcile-metrics`).** Offline join: a tenant's
discovered classic keys (`discover`) → mapped new key (lookup chain) → live
new-integration inventory (`discover-metrics`). Buckets every classic-with-data
key as **collected** / **add-to-new** (maps to a real new key not flowing here)
/ **unmapped-add-metric** (service onboarded, this metric absent) /
**custom-or-metric-streams** (service not collected at all → arbitrary custom
key — the Metric Streams case). Answers "which metric keys must we add to the new
integration?". Pure logic in `lib/metric-reconcile.ts` (tested); the unmapped
tail is placed via a data-driven classic→new *service bridge* + a conservative
metric-name match (heuristic rows labelled "verify"). **nic55601 snapshot:** 1000
classic-with-data keys vs 579 live new keys → **485 already collected**, **515
add-candidates** (292 add-to-new [263 autodiscovered → add via `recommended +
custom`, 29 recommended-but-absent → verify resource present], 186
service-onboarded-metric-absent, 37 service-entirely-absent → custom/Metric
Streams). `--by-account` also emits a per-account CSV (791 accounts). **Caveat:**
classic series mostly don't carry `aws.account.id` (account lives in the classic
entity model), so the per-account *classic* side is partial (375/791 accounts
carry any account-tagged classic key); the *new* side is complete. Artifacts:
`<tenant>/metric-reconciliation.csv|.md` (+ `-by-account`). Committed `ec24062`.

**Notebooks + Davis anomaly detectors — same rewriter, new asset types.** The
download+scan framework now covers three asset types. New commands:
`download-notebooks` / `scan-notebooks` (Document Service `type=='notebook'`; DQL
at `sections[].state.input.value`) and `download-anomaly-detectors` /
`scan-anomaly-detectors` (Settings 2.0 `builtin:davis.anomaly-detectors` via
`dynatrace/settings.ts`; DQL at `analyzer.input[].value` where `key=="query"`).
Shared scan core `lib/asset-scan.ts` (AWS markers incl. the **bare `cloud.aws.`**
form these assets use — dashboards use `dt.cloud.aws.`; `classifyRewrite`
clean/soft/blocked/no-op identical to `scan-dashboards`; App-portable) +
`asset-scan-run.ts` (Node runner/report) + `asset-extractors.ts` (pure, tested).

Scanners filter to **AWS-referencing queries per-query** (a notebook averages
~40 cells, most unrelated logs/other-cloud; `--all` overrides) so the rate isn't
drowned in non-AWS no-ops. Per-query rewrite errors are **isolated** (non-fatal,
recorded) — this surfaced a latent `RangeError: Invalid array length` the
rewriter throws on one *non-AWS* query; out of scope (we don't process it), but
the isolation keeps a batch of thousands from dying on one input.

**nic55601 coverage:**

| asset | total | AWS | AWS queries | converted | blocked | no-op |
|---|--:|--:|--:|--:|--:|--:|
| notebooks | 3,305 | 384 | 2,386 | **56.8%** | 37.8% | 5.3% |
| Davis anomaly detectors | 1,083 | 645 | 645 | **39.4%** | 60.6% | 0% |

Anomaly detectors convert lower because they lean on the
`classicEntitySelector("type(custom_device),tag(\"[AWS]…\"))` idiom — the same
manual-migration blocker as dashboards. Other blockers are genuine: classic ELB
(`dt.entity.elastic_load_balancer`, no new equivalent → re-architect onto ALB/
NLB), Metric Streams camelCase keys, and the unknown-metric tail. Reports:
`<tenant>/{notebook-scan,anomaly-detector-scan}/summary.md`. Tests 224→238.

**Usage-scoped, fresh downloads (2026-07-23).** The dashboard dump was stale
(late May). `download-dashboards` / `download-notebooks` now **clear their target
dir first** (a dump reflects the current tenant, not accumulated deleted assets)
and take `--used-within-days <N>`, which keeps only documents *opened* in the
last N days — usage from `dt.system.events` AUDIT_EVENT GETs by the Dashboards/
Notebooks apps (`lib/asset-usage.ts`; parses the documentId out of the
`/documents/<id>/content` resource). Manifests record `lastAccessed`/`accessCount`.
90-day scope on nic55601: dashboards 4,586→**1,868**, notebooks 3,305→**1,063**
(existing ∩ used). Fresh scoped coverage: **dashboards** 218 AWS / 5,818 queries →
48.6% converted all-up (73.6% AWS-relevant); **notebooks** 115 AWS / 953 AWS
queries → 51.9% converted. (Davis anomaly detectors are Settings objects, not
documents, so this usage signal doesn't apply — left at full scope, 39.4%.)

**Deferred (asked + parked):** (1) classic **metric events**
(`builtin:anomaly-detection.metric-events`, ~1,100 objects, ~66% AWS) use classic
metric *selectors* (`queryDefinition.metricKey`/`metricSelector` + `entityFilter`),
**not DQL** — a separate transform path (map the metricKey via the lookup chain +
translate the entityFilter dimension). (2) **Re-importable rewrite artifacts** for
notebooks/detectors (like the dashboard `.upload.json` / a Settings PUT-ready
object). This pass is scan + coverage report only (non-mutating).

## 2026-06-16 — product-team knowledge base added (`product-ai-knowledgebase/`)

The user dropped in Dynatrace product-team content and **relocated the original
`dt-migration/` skill to `product-ai-knowledgebase/dt-migration-cloud/`**; added a
general `dt-migration/` (classic→Grail entities/DQL/tags) and `dt-dql-essentials/`
(full DQL + Smartscape topology). The move **broke every runtime loader** — fixed
`tools/src/lib/paths.ts` `SKILL_*` → `dt-migration-cloud/references/` (const
`SKILL_CLOUD_REFS`); tests green. Assessment (3 parallel deep-reads):

- **Lever 2 is SETTLED — don't build identity-by-default.** No mapping file carries
  unit/statistic/gauge-vs-counter metadata, and the skill's own agg/scale method is
  *empirical live-tenant verification* (`metric-key-mapping.md`). So `mapped-no-recipe`
  is honest; the recipe-tier + dim-variant probing is the correct mechanism. The
  gauge/counter heuristic has no authoritative basis — drop it.
- **Credential/account = a FIELD READ, not an edge.** No resource→AWS_ACCOUNT edge
  exists; `aws.account.id` is denormalized on the resource, name via join to
  `smartscapeNodes AWS_ACCOUNT` on `aws.account.id`. **Validates Pass 0.5**, and is
  how to extend to the `entityAttr(...accessible_by...)` fieldsAdd form (the ~2,457
  co-blocker). A traverse/`references` toward AWS_ACCOUNT would silently return empty.
- **Metric Streams keys (camelCase `…By<Dims>`) are unmappable by design** — flag
  `migration-blocked (Metric Streams)`, not a closeable gap.

**Implemented from the KB backlog (2026-06-16):**
- **Tag value-extraction idiom** — Pass 2.5 maps `entityAttr(x,"tags")`→`getNodeField(x,"tags:aws")`; Pass 2.55 collapses `splitString(toString(<src>),"[AWS]?<Key>:")…`→`<src>[<Key>]`. 3,388/3,450 (98.2%) converted. (commit 7a23766)
- **Service→node map expanded** 40→55 from `dac-aws-to-2ndgen-entities.json` (api_gateway, emr, athena, appsync, fsx, kinesis*, eventbridge, mwaa, aurora…); +ecs/route53/elasticache/aurora to MULTI_NODE_SERVICES; node types tenant-validated. Entity wall 22%→~18%. (8a64385)
- **Credential/account field-read** (Pass 0.6) — the `entityAttr(custom_device,"accessible_by")[aws_credentials]`→`entityName(...)` idiom now collapses to the resource→`aws.account.id`→AWS_ACCOUNT join (no fake traversal). 2,645/3,040 (87%) converted. Also corrected a warning mislabel: the credential-collapse caveat was counted as `unmapped-entity-type` (inflated the wall); new kind `credential-collapsed`. Accurate scan now: clean 21.0%, wall (real not-planned) 17.7%, credential-collapsed 23.1%. (85c8b93)

Tests 184→195. Clean rate held ~21% across all three — these are **correctness** wins (tag columns populate, account names resolve, DQL is valid) on the heavily-flagged custom_device family; clean doesn't move because those panels still carry `mapped-no-recipe` (Lever 2, settled-unverifiable) + the credential-breadth caveat.

**Remaining KB backlog:**
- Flag Metric Streams camelCase keys as `migration-blocked` instead of unknown-metric (they're unmappable by design — don't count them as a closeable gap).
- Optional: adopt `relationship-mappings.md` (150+ edges, static-vs-dynamic flag) to widen `smartscape-edges.ts` + enable `traverse` for dynamic edges.

## Scope

**AWS only** right now. Azure/GCP mappings exist in `dt-migration/references/`
but are out of scope until AWS auto-conversion is much higher.

**New platform only** (decided 2026-07-23). Conversion targets new-platform
assets: new dashboards, notebooks, and Davis anomaly detectors. **Classic
dashboards are out of scope** — they can't be usage-scoped (not Document-Service
documents, so no `dt.system.events` per-doc open signal), and the migration is
about the new platform. `download-dashboards` still supports the classic side
(Config API v1) if that changes, but we don't scan/convert it.

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

## Current conversion rate (tenant nic55601, 518 AWS dashboards / 11,561 panels)

`scan-dashboards` reports a **reframed scoreboard** (every query in exactly
one bucket). As of 2026-07-16 (after **AWS-only entity scoping** — see below):

| Bucket | share | meaning |
|---|---:|---|
| **CONVERTED** (produces working DQL) | **44.7%** | clean **6.8%** + converted-with-verify-caveat **37.9%** |
| BLOCKED (no equiv / needs manual) | 16.1% | AWS-only blockers: unknown-metric, metric-streams, custom_device lookup-chains, classic-id-literal |
| No-op (already new-form / non-DQL / **non-AWS left untouched**) | 39.2% | — |

**The all-up rate dropped from 57.7% because the rewriter now only touches AWS
entities** (see "AWS-only scoping"). The **AWS-relevant** conversion rate is
unchanged: of tiles that exercise AWS conversion, **73.5%** convert
(5,172 CONVERTED / 7,033 AWS-relevant = converted+blocked); the rest of the
corpus (~39% no-op) is non-AWS (APM/K8s/Azure) or already-new-form. Caveat on
the soft tier: solid for gauge metrics; rate/counter `mapped-no-recipe` may
carry a wrong *scale*. Classification source of truth: `BLOCKING_WARNING_KINDS`
in `dql-rewriter.ts`.

**AWS-only entity scoping (2026-07-16).** The rewriter now converts **only AWS
entities** (those mapping to an `AWS_*` Smartscape node); every non-AWS entity —
APM `service`/`host`/`process_group[_instance]`, RUM `application`, Kubernetes
`cloud_application*`/`kubernetes_*`, `azure_*`, `disk`, `network_interface`, … —
is left **untouched** and flagged with a non-blocking `non-aws-entity` note.
Rationale: those belong to the general classic→Grail migration, aren't
decommissioned by the cloud-integration migration, and converting them was
*over-reach that failed at runtime* — a real dashboard tile converting
`dt.entity.process_group_instance → dt.smartscape.process` (+ an `append
[smartscapeNodes PROCESS]`) passed the rewriter clean but hit
`ENRICHMENT_FUNCTION_TABLE_SIZE`, forcing a manual revert. `entityScope()` in
`entity-mappings.ts` is the gate; it fires in Pass 1.6 (fetch), 1.7
(relationship target), 2 (dim-swap), and 2.5 (entityName/entityAttr). Effect:
~4,670 non-AWS refs no longer converted; `unmapped-entity-type` 5,373→2,757 and
`entity-relationship-traversal` 896→175 (their non-AWS share reclassified to the
non-blocking `non-aws-entity`, so BLOCKED is now AWS-only).

**Counter-aggregation triage (2026-06-17).** Tenant comparison (classic
`dt.cloud.aws.*` vs new `cloud.aws.*`) showed gauges keep their CloudWatch unit
(CPU %, latency s/ms, memory bytes) so an `avg()` key-swap is unit-safe — but
*counters* don't: e.g. `avg(dt.cloud.aws.alb.requests)`≈510 vs naive
`avg(cloud.aws.applicationelb.RequestCount.By.LoadBalancer)`≈0.74 (~700× low),
Lambda `Invocations` 288→1.0. The classic metric was a rolled-up interval count;
the new key is a raw CloudWatch **Sum** series, so the preserved `avg()` under-
reports. The DAC encodes the statistic in `secondGenMetricKey` (`…requestCount`**`Sum`**`By…`);
`dac-lookup.ts` now indexes it (`statisticByLiveBase`). When a `Sum` metric is
resolved via `mapped-no-recipe` and queried with a non-`sum` aggregation, the
rewriter **auto-corrects `avg()`→`sum()`** for metrics that are unambiguously
additive counters (`isAdditiveSumMetric` — requests, invocations, errors, bytes,
ops, consumed capacity), recording an `aggregation-corrected` transform; Pass 1.4
realigns any downstream `avg(key)` column refs to the flipped call. For the
gauge-like exceptions the DAC *also* labels `Sum` (`ConcurrentExecutions`,
`Provisioned*CapacityUnits`, `*HostCount`, `ActiveConnectionCount`,
`StatusCheckFailed`, `Container*` — concurrency/level/state, where `avg()` is
correct) it does **not** flip, emitting a non-blocking `aggregation-mismatch`
warning instead. Corpus: **1,270 auto-corrected** + **426 warned** (was 1,696
all-warned before the flip). Doesn't move the headline rate (these were already
`converted-soft` via `mapped-no-recipe`) but eliminates the silent ~100–700×
under-report on counter tiles — the reviewer no longer has to find and fix them
by hand. Classification is corpus-complete (all 39 distinct Sum-with-non-sum
metrics on nic55601 hand-checked) with general patterns for out-of-corpus safety;
unknown metrics default to the safe side (warn, don't flip).

**The 57.7% denominator includes ~20% non-AWS noise.** The corpus is "AWS
*dashboards*", but individual panels often reference only K8s/APM/GCP/Azure/SQL
entities — out of scope for an AWS-integration tool. Classifying each query by
AWS-relevance (AWS marker in original *or* rewritten, or a classic AWS entity
type like `ec2_instance`) and re-bucketing:

| Denominator | queries | CONVERTED | BLOCKED | no-op |
|---|---:|---:|---:|---:|
| All queries (headline) | 11,561 | 57.7% | 23.0% | 19.3% |
| **AWS-only** (pure non-AWS removed) | 9,243 | **72.1%** | 27.6% | 0.3% |
| *removed: pure non-AWS* | 2,318 | 0.2% | 4.8% | **95.0%** |

**The honest "how good are we at our actual job" number is ~72%, with a ceiling
near ~81%.** The 19.3% no-op bucket was almost entirely non-AWS (2,202 / 2,231
were already-new-form K8s/APM panels) — removing non-AWS deletes the no-ops, so
AWS queries are nearly all *real* conversion attempts. Of the 2,548 AWS-blocked,
**1,020 (40%) are *mixed*** (an AWS metric joined to a K8s/APM entity that is the
actual blocker) — held back by their out-of-scope half, not by an AWS limitation;
discount those and the pure-AWS rate is ~81.4%. The genuinely in-scope failures
are **1,528 queries (~17% of AWS)**: `custom_device` lookup-chains
(kafka/ecs/ec2), unknown AWS metrics, Metric Streams (unmappable by design),
classic-id literals, and the credential `accessible_by` variant (the only one
with tractable headroom left).

**Carrier-table refresh (2026-06-17) — biggest single win this session.**
`metric-dim-carriers.ts` lists which Smartscape types DON'T carry their own
`dt.smartscape.<type>` dim on metric series. It was probed 2026-05-12 and had
gone **stale**: re-probing the live tenant showed **13 of 14** listed
"non-carriers" now DO carry their dim (ECS = 287 distinct cluster buckets over
1833 series; also API Gateway, EFS, NAT Gateway, VPC endpoints, EKS, EventBridge,
autoscaling, ECR, AppSync, Firehose, Route53) — the connection's enrichment
matured. The rewriter was emitting a **false** `by:{dt.smartscape.X}` non-carrier
warning for these AND (bug) tagging it `unmapped-entity-type`, which is *blocking* —
so ~470 ECS/API-Gateway panels with valid, working DQL were mis-counted as BLOCKED.
Fix: move the 13 verified carriers (only `AWS_APIGATEWAYV2_API` stays — no live
data to verify) + give the genuine caveat its own **non-blocking** `dim-not-carried`
kind. Net: CONVERTED 53.8% → 57.7% (+448), BLOCKED 26.9% → 23.0%; the false warnings
were *eliminated*, not reclassified (`dim-not-carried` now fires <20×). Re-probe
method is in the `metric-dim-carriers.ts` header — the table will drift again, so
this is worth turning into a `discover-carriers` command.

**Note on the remaining 11.9% unmapped-entity-type wall:** re-running the rewriter
to capture the *actual* trigger texts shows it's now ~⅔ genuinely **non-AWS**
(`cloud_application`/K8s, `process_group`/APM, `cloud:gcp:*`, `azure_function_app`,
`sql:*`, `ibmmq:*`, `custom:solace`) — out of scope for an AWS-integration tool —
plus genuine AWS blocks (`cloud:aws:kafka`/`ecs`/`ec2` custom_device *lookup-chain*
idioms that need manual redesign per the not-planned bailout). Little low-hanging
fruit remains here.

**Access-data insight (still valid):** ~64% of scanned AWS dashboards have zero
user opens in 90 days — likely droppable from the migration target list, which
would lift the effective rate further.

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
