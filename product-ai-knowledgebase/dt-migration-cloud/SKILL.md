---
name: dt-migration-cloud
description: "Guide cloud connection migration from classic to new (Smartscape on Grail) for AWS, Azure, and GCP. Use when users want to assess migration readiness, discover classic cloud dependencies (connections, metrics, entities, dashboards, SLOs, alerts), classify migration status, detect migration blockers, or get guided remediation for migrating to new cloud connections."
license: Apache-2.0
---

# Cloud Connection Migration Skill

Guide customers through migrating Dynatrace cloud monitoring from **classic connections** to **new connections (Smartscape on Grail)** for AWS, Azure, and GCP.

Use it to:

- discover and inventory classic vs new cloud connections per provider
- classify each cloud account's migration status (Not Started / Parallel / Complete)
- detect classic metric, entity, and entity-selector references in dashboards, SLOs, and alerts
- explain what changes between classic and new connections and why
- guide remediation: rewrite DQL, suggest new metric keys, update dashboards and alerts
- guide cutover: new connection setup, entity validation, asset migration, metric enablement, classic removal

### Prerequisites

- Load **`dtctl`** (or `dynatrace-control`) >= **0.27.0** before running any queries — all data gathering uses `dtctl query` and `dtctl get`. Run `dtctl version` to verify. See [dynatrace-oss/dtctl releases](https://github.com/dynatrace-oss/dtctl/releases).
- Phase 2 scanning requires a **Dynatrace platform token** (`dt0s16.*`) with the scopes below. Set it in a `.dtmigration` file (copy `.dtmigration.example`) or export `DT_PLATFORM_TOKEN` in your shell. The active `dtctl` context must point to the same environment.
  - Required scopes: `document:documents:read`, `document:documents:admin`, `settings:objects:read`
- The **`scripts/`** directory contains automation scripts for Phase 2 and Phase 3 (IDE only):
  - **`scripts/detect-classic-patterns.py`** — Phase 2: scans exported JSON for classic cloud patterns. JSON output keys: `dashboards`, `metric_events`, `slos`, `infrastructure_detection`, `davis_detectors`.
  - **`scripts/generate-assessment.py`** — Phase 2: combines discovery, detection, and mapping into a full assessment report
  - **`scripts/lookup-mapping.py`** — Phase 3: queries the authoritative JSON mapping databases in `references/` for metric/entity translation. Use `--json` for machine-readable output or `--format markdown` for report embedding.
  - **`scripts/generate-migration-plan.py`** — Phase 3 Mode A: produces a self-contained migration plan. Reads detection output and `references/per-key-mappings.json`. Run: `python3 scripts/generate-migration-plan.py --provider aws --assessment ./assessment --output ./cloud-migration-plan.md`
  - **`scripts/build-per-key-mappings.py`** — Regenerates `references/per-key-mappings.json` from the DAC databases. Run once after updating the DAC JSON files: `python3 scripts/build-per-key-mappings.py`
- In DT Assist or when scripts are unavailable, the model executes all steps using native DQL and document read tools — no scripts are required. Phase 1 queries are in `references/discovery-queries.md`; detection rules are in `references/classic-detection-patterns.json`; mapping rules are in `references/per-key-mappings.json`.
- Phase output follows the contract in `references/phase-output-contract.md`. Use `references/migration-plan-format.md` as the Phase 3 plan template.

## Interaction Model

This skill is designed for **iterative use across multiple conversations**, not a single end-to-end run. Each phase is a natural conversation boundary. The typical flow:

1. **Phase 1** — Discover and classify all cloud connections → user reviews inventory
2. **Phase 2** — Scan for classic dependencies within a user-selected scope → user reviews assessment report
3. **Phase 3** — Get migration guidance per asset (report or guided execution) → user decides how to proceed
4. **Phase 4** — Set up new connections, validate, migrate assets, enable metrics, remove classic → user executes in UI with agent guidance

At each phase boundary, **pause and ask the user** how to proceed. Do not automatically advance to the next phase.

## Use Cases

| Use case | What to do |
|---|---|
| Assess migration readiness for all cloud accounts | Run Phase 1 (Discovery & Classification) |
| Check a specific provider's connection status | Run Phase 1, focus on that provider |
| Find dashboards referencing classic cloud metrics | Run Phase 2 with dashboard scanning selected |
| Find alerts using classic metric keys | Run Phase 2 with alert scanning selected |
| Find SLOs using classic metric keys | Run Phase 2 with SLO scanning selected |
| Understand classic vs new metric key differences | Load the provider-specific reference for the provider in question |
| Get a migration plan for affected assets | Run Phase 3 in report-only mode |
| Interactively migrate a dashboard or SLO | Run Phase 3 in guided execution mode |
| Set up a new cloud connection and cut over | Run Phase 4 |

## Concepts

### Connection Types

Each cloud provider has **classic** and **new** connection types. They coexist during migration.

| Aspect | Classic | New (Smartscape on Grail) |
|---|---|---|
| **Entity model** | `dt.entity.*` (dedicated types + `CUSTOM_DEVICE`) | Smartscape nodes (`AWS_*`, `AZURE_*`, `GCP_*`) |
| **Entity query** | `fetch dt.entity.<type>` | `smartscapeNodes <TYPE>` |
| **Metric prefixes** | `dt.cloud.<provider>.*`, `cloud.<provider>.*`, `builtin:cloud.<provider>.*`, `ext:cloud.<provider>.*` | `cloud.<provider>.<Service>.<Metric>.By.<Dim>` (new DA source) |
| **Data acquisition** | ActiveGate polling or Metric Streams | Platform-managed DA service |
| **Settings schema** | `builtin:cloud.aws` / Config API v1 (Azure) / none (GCP) | `builtin:hyperscaler-authentication.connections.*` |

### Migration Status Classification

Each cloud account falls into one of four states:

| Status | Condition | Meaning |
|---|---|---|
| **Not Started** | Classic connection exists, no new connection for the same account ID | Migration has not begun for this account |
| **Parallel** | Both classic and new connections exist for the **same** account ID | Running in parallel — ready to cut over |
| **Complete** | New connection only, no classic connection for this account ID | Migration finished |

### Classic Detection Patterns

Classic dependencies are identified by metric key prefix and entity type. The full detection rules (all prefixes per provider, all entity types, disambiguation logic) are in [references/classic-detection-patterns.md](references/classic-detection-patterns.md).

**Key indicators:**
- **Metric prefixes**: `dt.cloud.<provider>.*`, `builtin:cloud.<provider>.*`, `ext:cloud.<provider>.*`, and ambiguous `cloud.<provider>.*` keys without `dt.da.source`
- **Entity types**: `fetch dt.entity.<classic_cloud_type>` or `custom_device` with `cloud:<provider>:*` sub-types

When the prefix `cloud.<provider>.*` is ambiguous (could be classic or new), apply the disambiguation rules in [references/disambiguation.md](references/disambiguation.md).

## Phase 1: Discovery & Classification

**Goal**: Build a complete inventory of all cloud connections across AWS, Azure, and GCP. Classify each account's migration status.

> Run the queries from [references/discovery-queries.md](references/discovery-queries.md) using the DQL tool (`dtctl query` in the IDE, or the native DQL tool in DT Assist). The file contains all queries with the correct join-key fields for each provider. The manual steps below describe the same workflow in detail.

Run these steps in order. All queries use `dtctl query`.

### Step 1: Discover Cloud Connections

Run the connection discovery queries for each provider. Load [references/discovery-queries.md](references/discovery-queries.md) for the full set.

**Summary of queries to run:**

1. **AWS classic:** `fetch dt.entity.aws_credentials` — one row per classic connection
2. **AWS new:** `smartscapeNodes AWS_ACCOUNT` — one row per new connection
3. **Azure classic:** `fetch dt.entity.azure_credentials` with subscription lookup
4. **Azure new:** `smartscapeNodes AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS`
5. **GCP classic:** `` fetch `dt.entity.cloud:gcp:project` ``
6. **GCP new:** `smartscapeNodes GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT`
7. **AWS Metric Streams:** `fetch metric.series | filter dt.source == "AWS Metric Streams"` — flag affected accounts

### Step 2: Classify Each Account

For each account ID found across classic and new queries:

1. If account appears in **classic only** (no matching account ID in new connections) → status: `Not Started`
2. If account appears in **new only** (no matching account ID in classic connections) → status: `Complete`
3. If the **same account ID** appears in both classic and new → status: `Parallel`
4. If AWS and Metric Streams detected for same account → add `not-yet-supported` flag (Metric Streams is not yet supported by new connections; only the Metric Streams portion is blocked — classic built-in and non-built-in polling can still be migrated. See [references/metric-streams.md](references/metric-streams.md).)

Present results as a summary table: Provider | Account ID | Connection Name | Status | Blocked?

### Step 3: Conversation Boundary — Scope Selection

After presenting the inventory table, **pause and ask the user**:

> "Which cloud providers do you want to assess for classic dependencies? (all providers, or a specific one like AWS/Azure/GCP)"
> "Which asset types should I scan for classic cloud dependencies? (default: all)"
> - New platform dashboards
> - Alerts (metric events, infrastructure anomaly detection, anomaly detectors)
> - SLOs
> - All of the above

> - **Out of scope — alerting profiles and management-zone-scoped alerts.** These belong to a broader alerting skill that covers all domains, not cloud-specific migration. Do not attempt to scan, remediate, or comment on these within this skill.

Scoping guidance:
- For environments with **fewer than 20 cloud accounts**: scanning all providers at once is reasonable
- For environments with **20+ cloud accounts**: recommend scoping to **one provider at a time** to keep the assessment manageable
- Scoping is **by provider only** — it is not possible to filter by individual cloud account when scanning dashboards, alerts, and SLOs

Do **not** proceed to Phase 2 without the user's scope selection.

## Phase 2: Dependency Assessment

**Goal**: Scan dashboards, alerts, and SLOs for classic cloud references within the provider scope and asset types selected in Phase 1. Produce a detailed assessment report.

> **IDE automation** — the `scripts/` directory implements the full Phase 2 pipeline. Run in order:
> 1. Fetch assets: `dtctl get dashboards`, `dtctl get settings --schema builtin:anomaly-detection.metric-events`, etc. (see Step 2 table). Export each to `./assessment/`.
> 2. `scripts/detect-classic-patterns.py` — scans exported JSON for classic metric, entity, and entity-selector patterns:
>    ```bash
>    python3 scripts/detect-classic-patterns.py --provider aws ./assessment
>    ```
> 3. `scripts/generate-assessment.py` — combines discovery data, detection results, and metric/entity mappings into a complete assessment report:
>    ```bash
>    python3 scripts/generate-assessment.py --provider aws --output ./report.md ./assessment
>    ```
>
> **DT Assist** — use native document and settings read tools to fetch each asset type, then apply detection rules from `references/classic-detection-patterns.json`. The manual steps below describe the same workflow.

### Step 1: Confirm Scope and Selected Asset Types

Confirm the provider scope and asset types selected in Phase 1.

Default to scanning **all asset types** if the user does not specify.

### Step 2: Scan Selected Asset Types

| Asset type | Fetch command | What to inspect | Reference |
|---|---|---|---|
| Dashboards (new platform only) | `dtctl get dashboards --admin-access --filter "not (originAppId exists and originAppId starts-with 'dynatrace.') and (type == 'dashboard')" -o json` then fetch each ID via Document Service | `tile.query`, `tile.queries[].query` — preset dashboards and non-dashboard types excluded server-side by `--filter` (type restriction required due to dtctl bug where `--filter` bypasses implicit type scoping); `--admin-access` (requires `document:documents:admin` OAuth permission) includes all users' dashboards; script gracefully falls back to user-visible scan when permission is absent | [dashboard-scanning.md](references/dashboard-scanning.md) |
| Alerts — metric events | `dtctl get settings --schema builtin:anomaly-detection.metric-events -o json` | `queryDefinition.metricKey`, `queryDefinition.metricSelector` | [alert-scanning.md](references/alert-scanning.md) |
| Alerts — infrastructure anomaly detection (AWS only) | `dtctl get settings --schema builtin:anomaly-detection.infrastructure-aws --scope environment -o json` | Presence of any object signals classic AWS entity type monitoring | [alert-scanning.md](references/alert-scanning.md) |
| Alerts — anomaly detectors (custom alerts) | `dtctl get settings --schema builtin:davis.anomaly-detectors -o json` | `analyzer.input[].value` — scan each input value for classic metric patterns | [alert-scanning.md](references/alert-scanning.md) |
| SLOs | `dtctl get slos -o json` | `metricExpression`, `filter` | [slo-scanning.md](references/slo-scanning.md) |

> **Classic dashboards (Config API v1):** Run `python3 scripts/detect-classic-patterns.py --type classic-dashboards ./assessment` to scan them when `DT_API_TOKEN` (dt0c01.* with `ReadConfig` scope) is set in `.dtmigration`. Without that token, classic dashboards cannot be scanned automatically — inform the user: *"Classic dashboards (Config API v1) require a `DT_API_TOKEN` with `ReadConfig` scope. Set it in `.dtmigration` and re-run. Without it, review classic dashboards manually."*

### Step 3: Apply Detection Rules

For all scanned content, apply the classic detection patterns:
- Classic metric prefix matching — see [references/classic-detection-patterns.md](references/classic-detection-patterns.md)
- Ambiguous prefix disambiguation — see [references/disambiguation.md](references/disambiguation.md)
- Classic entity type detection — see [Classic Detection Patterns](#classic-detection-patterns) above

### Step 4: Produce Assessment Report

Produce two outputs:

1. **Chat summary** — A concise overview: count of affected dashboards, alerts, and SLOs (out of total scanned), plus an "out of scope" note for classic dashboards (Config API v1).

2. **Detailed report file** — A local markdown file (e.g., `cloud-migration-assessment.md`) or Dynatrace Document containing: connection inventory table (Provider | Account ID | Name | Status | Blocked?), then each affected asset grouped by type with name, ID, owner, and the specific classic patterns detected.

See [references/assessment-report-template.md](references/assessment-report-template.md) for the full template.

### Step 5: Conversation Boundary — Remediation Mode

After presenting the assessment, **pause and ask the user**:

> "How would you like to proceed with migration guidance?"
> 1. **Report only** — I'll produce a detailed migration plan file with all suggested changes. You execute them independently.
> 2. **Guided execution** — I'll walk you through each change interactively, with confirmation before applying anything.
>
> "At what granularity do you want to work?"
> - One asset at a time
> - By asset type (all dashboards first, then alerts, then SLOs)
> - All at once

Do **not** proceed to Phase 3 without the user's mode and granularity selection.

## Phase 3: Migration Guidance & Remediation

**Goal**: For each classic dependency found in Phase 2, provide migration guidance. The user controls whether this is a report or guided execution.

### Mode A: Report Only

> **Automation**: Use `scripts/generate-migration-plan.py` to produce the plan in one step:
> ```bash
> python3 scripts/generate-migration-plan.py --provider aws \
>     --assessment ./assessment \
>     --output ./cloud-migration-plan.md
> ```
> The script reads the pre-built mapping index from `references/per-key-mappings.json`. If that file is missing, regenerate it first with `python3 scripts/build-per-key-mappings.py`.

When running manually (script unavailable), produce a structured migration plan file (markdown) that the user can execute independently. For each affected asset, document:

1. **What is classic**: the specific metric key, entity type, or DQL pattern detected
2. **What the new equivalent is**: the replacement metric key, Smartscape node type, or rewritten DQL
3. **What needs to change**: concrete before/after showing the exact modification

Include all rewritten DQL snippets, new metric keys, and entity type mappings so the file is self-contained.

> **Detection JSON key**: Metric event alert findings are under the key `"metric_events"` in `detect-classic-patterns.py --json` output.

> **Grouping findings by service**: When organising the migration plan by AWS/Azure service (e.g. a
> "Lambda" section, an "EC2" section), extract the service segment from each classic metric key using
> `extract_service_segment(key, provider)` from `scripts/lookup-mapping.py`. Do **not** use simple
> substring replacement such as `key.replace('cloud.aws.', '')` — this strips `cloud.aws.` from
> within the string, so `builtin:cloud.aws.lambda.*` becomes `builtin:lambda.*`, producing
> `builtin:lambda` as the service group name instead of `lambda`.

### Mode B: Guided Execution

Work through assets at the user-chosen granularity (one at a time, by type, or all at once). For each asset:

1. Explain what classic references were found and why they need to change
2. Show the proposed change (before/after)
3. **Ask for confirmation** before applying any modification
4. Help apply the change (create updated dashboard, update alert, re-create SLO)

### Metric Key Migration

For each classic metric key detected in Phase 2, translate it to the new connection equivalent using the authoritative mapping database.

#### Primary: Lookup Script (AWS, Azure)

Use `scripts/lookup-mapping.py` to look up exact mappings from the JSON databases in `references/` (53K+ AWS entries, 46K+ Azure entries).

**Metric lookups:**

```bash
# Single metric — returns best DAC key, availability, EOL status
python3 scripts/lookup-mapping.py metric --key "<classic_metric_key>" --provider <aws|azure> --json
# Bulk by service — all metrics for a CloudWatch namespace or ARM type
python3 scripts/lookup-mapping.py metric --service "<CloudWatch_namespace_or_ARM_type>" --provider <aws|azure> --format markdown
# Reverse — find the classic key from a known new key
python3 scripts/lookup-mapping.py metric --reverse "<new_dac_metric_key>" --provider <aws|azure> --json
```

**Interpreting results:**

The script returns a **list** of candidate matches. Use the first entry with a non-`not-matched` `dacRecommendedKey`; fall back to `dacAutodiscoveredKey` if `dacRecommendedKey` is `not-matched`.

| Field | Meaning |
|---|---|
| `dacRecommendedKey` | Available in the recommended metric collection set — no extra configuration needed on the new connection |
| `dacAutodiscoveredKey` | Available but **not** in the recommended set — requires configuring the new connection with "recommended + custom" and adding this key as a custom metric |
| `bestDacKey` | The preferred key (`dacRecommendedKey` if available, else `dacAutodiscoveredKey`) |
| `availability` | `recommended`, `autodiscovered`, or `none` |
| `endOfLife` | `true` if the service is end-of-life — report the EOL date and announcement URL to the user |
| `guidance` | Human-readable guidance text for the user |

When both `dacRecommendedKey` and `dacAutodiscoveredKey` are `"not-matched"`, the metric has no direct mapping in the database — use the fallback approach below.

#### Fallback: Heuristic Rules + Discovery Query (all providers including GCP)

When the lookup script returns no match, or for GCP (mapping database not yet available), apply heuristic rules from [references/metric-key-mapping.md](references/metric-key-mapping.md):

- `dt.cloud.aws.<service>.<metric>` → `cloud.aws.<Service>.<Metric>.By.<Dim>` (with `dt.da.source` filter for new DA)
- `builtin:cloud.aws.*` / `ext:cloud.aws.*` → look up the Grail equivalent first, then map to new
- Azure and GCP follow similar patterns — see provider-specific references

When neither the database nor heuristics produce a match, discover the new key from live data:

> **Note:** In the `dtctl query` examples below, inner quotes are escaped for the shell (`\"`). When running DQL directly (e.g., in a notebook), use standard double-quotes.

```
dtctl query "fetch metric.series, from:now()-1h
| filter startsWith(metric.key, \"cloud.aws.<service>\") AND isNotNull(dt.da.source)
| summarize cnt=count(), by:{metric.key, dt.da.source}"
```

#### End-of-Life Checks

Always check end-of-life status for services referenced in the migration. Use the EOL subcommand:

```bash
python3 scripts/lookup-mapping.py eol --check "<resource_type>"
python3 scripts/lookup-mapping.py eol --all
```

When a service is end-of-life, **report this prominently to the user** with the EOL date and announcement URL. The user may choose to skip migration for EOL services rather than invest effort in migrating metrics for a retiring service.

### Entity Migration

For each classic entity type detected in Phase 2, translate it to the new Smartscape node type.

#### Primary: Lookup Script (AWS, Azure)

Use `scripts/lookup-mapping.py` to look up exact entity mappings:

```bash
# Single entity — by classic built-in type, sub-type, or DAC resource type
python3 scripts/lookup-mapping.py entity --key "<classic_entity_type>" --provider <aws|azure> --json
# Bulk by service
python3 scripts/lookup-mapping.py entity --service "<resource_type>" --provider <aws|azure> --format markdown
```

#### Fallback: Heuristic Tables (all providers including GCP)

When the lookup script returns no match, or for GCP, use the mapping tables in [references/entity-type-mapping.md](references/entity-type-mapping.md).

Key DQL rewrite patterns:
- `fetch dt.entity.<classic_type>` → `smartscapeNodes <NEW_TYPE>`
- `entity.name` → `name` in Smartscape context
- `custom_device` with `cloud:*` sub-types → use the dedicated Smartscape node type from the lookup script or mapping table
- Classic entity selectors in SLO `filter` fields → rewrite using Smartscape node filters

Load [references/entity-type-mapping.md](references/entity-type-mapping.md) for the full heuristic mapping tables (AWS, Azure, GCP) and query syntax change details.

### Dashboard Remediation

For each affected dashboard:
1. Explain which tiles have classic references and what the replacement is
2. Provide rewritten DQL for each affected tile
3. If the user confirms, help create an updated dashboard or guide manual editing

### Alert Remediation

There are three types of classic alerts to remediate:

#### Metric Event Alerts

For each affected metric event:
1. Explain the classic metric key and its new equivalent
2. Suggest the replacement metric key or DQL expression
3. Guide creation of an Anomaly Detector as a modern replacement if appropriate

> **Classic `_alert` suffix keys**: Classic metric event alerts sometimes define a paired key with an
> `_alert` suffix alongside the primary key (e.g. `ext:cloud.aws.amazonmq.cpuUtilizationAverage_alert`).
> These `_alert` variants are classic-only artifacts — they have no equivalent in the new connection.
> When re-creating an alert with the new metric key, use only the primary mapped new key.
> Do not look for or attempt to create an `_alert` variant.

#### Infrastructure Anomaly Detection (AWS Only)

Classic AWS infrastructure anomaly detection (`builtin:anomaly-detection.infrastructure-aws`) is auto-managed by Dynatrace. **No manual migration is required.** When the new connection is active, new Smartscape entity types have their own built-in anomaly detection.

However, if **customised thresholds** exist on the classic infrastructure detection (e.g., custom CPU thresholds for EC2), these do not carry over. Review custom thresholds before cutover and consider creating equivalent Anomaly Detectors with new metric keys.

#### Anomaly Detectors (Custom Alerts)

For each affected anomaly detector:
1. Identify which analyzer input fields contain classic metric references
2. Look up new metric key equivalents via `scripts/lookup-mapping.py`
3. Re-create the detector with updated analyzer inputs (detectors must be deleted and re-created — inputs cannot be edited in place)
4. Follow the same zero-gap migration strategy as metric events: create new disabled → enable after new connection ingests data → delete old

Load [references/alert-scanning.md](references/alert-scanning.md) for the full detection logic, remediation workflow, and report formats for all three alert types.

### SLO Remediation

For each affected SLO:
1. Explain the classic metric/entity reference
2. Provide the rewritten metric expression using new keys
3. Guide SLO re-creation with the updated definition (classic SLOs using metric selectors cannot be edited to use DQL — they must be re-created)

## Phase 4: Cutover & Validation

**Goal**: Guide the user through setting up new connections, validating entities, migrating assets, enabling metrics with parallel running, and removing classic connections. **All guidance-only** — the user executes steps in the Dynatrace UI.

Load [references/cutover-guide.md](references/cutover-guide.md) for provider-specific setup instructions, required permissions, and validation queries.

### Sub-steps

1. **4a. New Connection Setup — Topology Only** — Create the new connection with metric ingest disabled. Smartscape nodes appear; no metric data flows yet. Per-provider auth: AWS (IAM role), Azure (service principal with Reader), GCP (service account with Viewer — replaces classic GKE deployment entirely).
2. **4b. Entity Validation** — Re-run new connection discovery queries from Phase 1. Compare expected vs actual Smartscape node counts. Troubleshoot gaps (permissions, service enablement, propagation time).
3. **4c. Asset Migration** — Apply Phase 3 remediation output. This happens **before** enabling metric ingest — migrated assets won't show data until 4d. For alerts, **pause and ask the user**: (Option 1) create new alerts disabled now, swap at 4d — no alerting gap, no double alerting; (Option 2) migrate alerts after classic is disabled at 4e — brief coverage gap during switchover. The choice depends on risk tolerance and environment criticality.
4. **4d. Metric Configuration & Parallel Running** — Enable metric ingest on the new connection. Prioritize services referenced by scanned assets. Validate: check `dt.da.source` on new metrics, spot-check dashboards, verify SLOs. If Option 1, simultaneously disable classic alerts and enable new alerts. Note: classic entity IDs do **not** carry over to new Smartscape nodes.
5. **4e. Classic Connection Removal** — Disable (don't delete) the classic connection. Re-validate with Phase 1 + Phase 2 queries. If Option 2, create and enable new alerts now. Recommend a buffer period before full deletion. Classic historical data is retained per retention settings.

Detailed per-provider instructions, IAM/RBAC requirements, validation queries, and metric validation DQL are all in [references/cutover-guide.md](references/cutover-guide.md).

## References

### General

- [references/discovery-queries.md](references/discovery-queries.md) — All DQL queries for connection discovery and classification
- [references/metric-key-mapping.md](references/metric-key-mapping.md) — Classic → new metric key translation rules and lookup strategy
- [references/entity-type-mapping.md](references/entity-type-mapping.md) — Classic entity type → Smartscape node type mapping table
- [references/classic-detection-patterns.md](references/classic-detection-patterns.md) — All classic metric prefix and entity type detection rules
- [references/disambiguation.md](references/disambiguation.md) — How to distinguish classic vs new when metric prefixes overlap
- [references/assessment-report-template.md](references/assessment-report-template.md) — Chat summary and detailed report templates for Phase 2
- [references/phase-output-contract.md](references/phase-output-contract.md) — Full multi-phase run document contract: front-matter manifest, per-phase section structure, resume behavior
- [references/phase-output.schema.json](references/phase-output.schema.json) — JSON Schema for the phase-output manifest and per-phase findings arrays
- [references/migration-plan-format.md](references/migration-plan-format.md) — Phase 3 Mode A migration plan output spec: section structure, table formats, availability labels

### Scanning & Remediation

- [references/dashboard-scanning.md](references/dashboard-scanning.md) — New platform dashboard scanning patterns and edge cases
- [references/alert-scanning.md](references/alert-scanning.md) — Alert scanning: metric events, infrastructure anomaly detection (AWS), and anomaly detectors (custom alerts)
- [references/slo-scanning.md](references/slo-scanning.md) — SLO scanning patterns (classic and new format)
- [references/cutover-guide.md](references/cutover-guide.md) — New connection setup, entity validation, parallel running, and classic removal guidance
- [references/metric-streams.md](references/metric-streams.md) — AWS Metric Streams detection and migration-blocked logic

### Provider Deep References

- [references/aws-classic.md](references/aws-classic.md) — Classic AWS connection flavours, metric key formats, entity types
- [references/aws-new.md](references/aws-new.md) — New AWS connection, Smartscape entity types, DA sources
- [references/azure-classic.md](references/azure-classic.md) — Classic Azure connection flavours, metric key formats
- [references/azure-new.md](references/azure-new.md) — New Azure connection, Smartscape entity types
- [references/gcp-classic.md](references/gcp-classic.md) — Classic GCP connection (GKE-based), custom device model
- [references/gcp-new.md](references/gcp-new.md) — New GCP connection, Smartscape entity types

### Related Skills

- Load `dtctl` or `dynatrace-control` for running `dtctl` commands against a Dynatrace environment.
