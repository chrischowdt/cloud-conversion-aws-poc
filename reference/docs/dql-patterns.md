# DQL Patterns — Cloud Migration Helper

Verified DQL patterns for the Cloud Migration Helper app. All queries have been validated against the `gmg` Dynatrace environment using `dtctl verify query` and/or live execution.

> **Verification status key**
> - ✅ Verified — syntax confirmed valid via `dtctl verify query`
> - ✅🟢 Verified + live — executed with real data in the `gmg` environment
> - ⚠️ Note — valid syntax with a caveats or environment-specific behaviour

---

## Table of Contents

1. [Classic AWS Connections](#1-classic-aws-connections)
2. [Classic Azure Connections](#2-classic-azure-connections)
3. [Classic GCP Connections](#3-classic-gcp-connections)
4. [New Connections — DA Source Detection](#4-new-connections--da-source-detection)
5. [Parallel Ingestion Detection](#5-parallel-ingestion-detection)
6. [Account-Scoped Entity Counts — AWS](#6-account-scoped-entity-counts--aws)
7. [Account-Scoped Entity Counts — Azure](#7-account-scoped-entity-counts--azure)
8. [Account-Scoped Entity Counts — GCP](#8-account-scoped-entity-counts--gcp)
9. [New Connection Entity Counts (Smartscape)](#9-new-connection-entity-counts-smartscape)
10. [Batched Entity Count Queries](#10-batched-entity-count-queries)
11. [Account ID Extraction (Topology-Centric)](#11-account-id-extraction-topology-centric)

---

## Syntax Corrections (vs. Story Drafts)

These patterns differ from what was originally written in the story drafts and must be used in code:

| Original (incorrect) | Correct | Issue |
|---|---|---|
| `arrayContains(arr, val)` | `in(val, arr)` | `arrayContains` does not exist in DQL |
| `lifetime["end"]` | `lifetime[\`end\`]` | String subscripts are not allowed; use backtick-quoted identifier |
| `now() - duration("48h")` | `now() - 48h` | `duration()` function does not take a string; use inline duration suffix |

---

## 1. Classic AWS Connections

### 1.1 Enumerate all classic AWS accounts (primary detection query)
✅🟢 Verified + live (gmg, 2026-04-07)
```dql
fetch dt.entity.aws_credentials
| fieldsAdd awsAccountId, entity.name, id, lifetime
| fieldsRemove can_access
```
`awsAccountId` is a direct string field — the AWS Account ID (numeric string, e.g. `"444652832050"`). `entity.name` is the human-readable credential name. `id` is the Dynatrace entity ID (`AWS_CREDENTIALS-*`). This is the **primary topology enumeration query** — one row per classic AWS account.

### 1.2 Connection entities (name + entity ID only)
✅ Verified
```dql
fetch dt.entity.aws_credentials
| fields entity.name, id
```
Lightweight query for name-to-entity-ID cross-reference. Prefer §1.1 when account ID is also needed.

### 1.3 Classic AWS metric streams detection
✅ Verified
```dql
fetch metric.series, from:now()-1h
| filter dt.source == "AWS Metric Streams"
| summarize cnt=count(), by:{metric.key}
```
Presence of `dt.source == "AWS Metric Streams"` indicates the metric streams flavour is active.

### 1.4 Classic AWS metric source classification (all flavours)
✅ Verified
```dql
fetch metric.series, from:now()-1h
| filter startsWith(metric.key, "cloud.aws.") OR startsWith(metric.key, "dt.cloud.aws.")
| summarize cnt=count(), by:{dt.da.source, dt.source_entity.type, dt.source}
| sort cnt desc
```
Discriminates classic built-in polling (`dt.da.source` null, dedicated entity type), non-built-in (`CUSTOM_DEVICE`), and metric streams (`dt.source == "AWS Metric Streams"`).

### 1.5 Classic AWS non-built-in custom device counts
✅ Verified
```dql
fetch dt.entity.custom_device
| filter contains(toString(entity.type), "cloud:aws")
| summarize cnt=count(), by:{entity.type}
| sort cnt desc
```
Returns per-subtype counts (e.g. `cloud:aws:s3`, `cloud:aws:sqs`).

---

## 2. Classic Azure Connections

### 2.1 Connection entities
✅ Verified
```dql
fetch dt.entity.azure_credentials
| fields entity.name, id
```

### 2.2 Azure Subscription UUID — single-query lookup (primary detection query)
✅🟢 Verified + live (gmg, 2026-04-07)
```dql
fetch dt.entity.azure_credentials
| fieldsAdd entity.name, id, belongs_to
| fieldsRemove can_access
| fieldsAdd sub_id = belongs_to[`dt.entity.azure_subscription`][0]
| lookup [fetch dt.entity.azure_subscription | fieldsAdd azureSubscriptionUuid],
    sourceField:sub_id, lookupField:id, prefix:"sub."
| fields entity.name, id, sub_id, sub.azureSubscriptionUuid
```
`sub.azureSubscriptionUuid` is the Azure Subscription ID (e.g. `"7a78220a-499a-4093-94ba-4ab2f1d20ae2"`). This is the **primary topology enumeration query** — one row per classic Azure credential, with the subscription UUID resolved inline.

**Key syntax notes:**
- `belongs_to` returns a map of arrays keyed by related entity type. Extract the first element with `[0]` to get a scalar suitable for `lookup`'s `sourceField`.
- `lookup` requires a scalar `sourceField` — you cannot pass an array expression directly. Always extract to an intermediate field first (`fieldsAdd sub_id = ...`).
- Some legacy credentials have `belongs_to: null` or no Azure subscription linked — these produce `sub_id: null` and `sub.azureSubscriptionUuid: null`. They are not errors; include them with `accountId: null`.
- `fieldsRemove can_access` avoids exposing internal IAM fields in query results.

### 2.3 Subscription entity IDs — two-step approach (legacy reference)
✅ Verified
```dql
fetch dt.entity.azure_credentials
| fields id, subscriptionIds = belongs_to[`dt.entity.azure_subscription`]
```
Returns the subscription entity ID(s) for each credential as an **array**, then a second query fetches subscription UUID:
```dql
fetch dt.entity.azure_subscription
| fields id, azureSubscriptionUuid
```
> **Prefer §2.2** for new code — the single-query lookup is more robust and self-contained. Use this two-step approach only if the inline lookup exceeds query complexity limits.

### 2.3 Classic Azure metric source classification
✅ Verified
```dql
fetch metric.series, from:now()-1h
| filter contains(metric.key, "azure")
| filterOut startsWith(metric.key, "dac.azure_")
| filterOut startsWith(metric.key, "remote_dsfm.")
| filterOut startsWith(metric.key, "dt.sfm.")
| summarize cnt=count(), by:{dt.da.source, dt.source_entity.type}
| sort cnt desc
```
`filterOut` is valid DQL (verified).

### 2.4 Classic Azure non-built-in custom device counts
✅ Verified
```dql
fetch dt.entity.custom_device
| filter contains(toString(entity.type), "cloud:azure")
| summarize cnt=count(), by:{entity.type}
| sort cnt desc
```

---

## 3. Classic GCP Connections

### 3.1 GCP custom device entity counts (all sub-types)
✅ Verified
```dql
fetch dt.entity.custom_device
| filter contains(toString(entity.type), "cloud:gcp")
| summarize cnt=count(), by:{entity.type}
| sort cnt desc
```

### 3.2 GCP project entities — active accounts with project ID
✅🟢 Verified + live (gmg, 2026-04-07)
```dql
fetch `dt.entity.cloud:gcp:project`, from:now()-12h
| fields entity.name, id, lifetime
```
`entity.name` **is the GCP Project ID** (e.g. `"dtp-dev204-sql-plsrv"`). This is the **primary topology enumeration query** for classic GCP — one row per active classic GCP project. The entity type must be backtick-quoted in `fetch` due to the `:` characters.

**Lifetime filtering**: Grail applies the `from:` timeframe against the entity `lifetime` field automatically — projects whose `lifetime.end` precedes the window start are excluded without any extra pipeline steps. An explicit `| fieldsAdd lifetime_end ... | filter ...` is therefore not required when a `from:` clause is present.

**Key syntax notes (retained for reference when constructing manual filters):**
- `lifetime` is a record with `start` and `end` fields. Access `end` via backtick subscript: `lifetime[\`end\`]` — string subscripts (`lifetime["end"]`) are a parse error.
- Duration arithmetic uses inline suffix syntax: `now() - 48h`. The `duration()` function is not for string arguments.
- `lifetime.end` causes a `FIELD_DOES_NOT_EXIST` error in `fieldsAdd` — always use the subscript form `lifetime[\`end\`]`.
- `isNull()` is valid and symmetric with `isNotNull()`.
- Extract the field with `fieldsAdd` before using it in `filter` for clarity and to avoid repeated evaluation.

### 3.3 Classic GCP metric source classification
✅ Verified
```dql
fetch metric.series, from:now()-1h
| filter contains(metric.key, "cloud.gcp")
| filterOut startsWith(metric.key, "dac.gcp_")
| filterOut startsWith(metric.key, "dt.sfm.da.gcp")
| summarize cnt=count(), by:{dt.da.source, dt.source, metadata.origin}
| sort cnt desc
```

---

## 4. New Connections — DA Source Detection

### 4.1 Detect active DA sources
✅ Verified
```dql
fetch metric.series, from:now()-2h
| filter dt.da.source == "aws-metric-poller"
    OR dt.da.source == "azure-metric-poller"
    OR dt.da.source == "gcp-cloud-monitoring"
| summarize cnt=count(), by:{dt.da.source}
```

---

## 5. Parallel Ingestion Detection

### 5.1 AWS parallel ingestion (metric key overlap)
✅ Verified
```dql
fetch metric.series, from:now()-1h
| filter startsWith(metric.key, "cloud.aws.")
| summarize cnt=count(), by:{dt.da.source, dt.source_entity.type, dt.source}
| sort cnt desc
```
A metric key with rows for both `dt.da.source == "aws-metric-poller"` and a non-null `dt.source` (metric streams) indicates dual-ingestion of that key.

### 5.2 Azure parallel ingestion (metric key overlap)
✅ Verified
```dql
fetch metric.series, from:now()-1h
| filter contains(metric.key, "azure")
| filterOut startsWith(metric.key, "dac.azure_")
| filterOut startsWith(metric.key, "remote_dsfm.")
| filterOut startsWith(metric.key, "dt.sfm.")
| summarize cnt=count(), by:{dt.da.source, dt.source_entity.type}
| sort cnt desc
```

### 5.3 GCP parallel ingestion
✅ Verified
```dql
fetch metric.series, from:now()-1h
| filter contains(metric.key, "cloud.gcp")
| filterOut startsWith(metric.key, "dac.gcp_")
| filterOut startsWith(metric.key, "dt.sfm.da.gcp")
| summarize cnt=count(), by:{dt.da.source, dt.source, metadata.origin}
| sort cnt desc
```

---

## 6. Account-Scoped Entity Counts — AWS

> **Relationship field confirmed**: EC2 instances carry `accessible_by[dt.entity.aws_credentials]` as an array of credential entity IDs. Filtering uses `in(credentialEntityId, accessible_by[...])`.
>
> ⚠️ `accessible_by` availability varies by entity type — confirmed on `ec2_instance` (live, 240 results). Not available on `ebs_volume` (field does not exist). On `aws_lambda_function`, the field exists in schema but was null in the test environment — treat as unconfirmed until verified in your environment.

### 6.1 EC2 instances scoped to a credential
✅🟢 Verified + live (240 results for credential `AWS_CREDENTIALS-A4BE6E5B22DB0101`)
```dql
fetch dt.entity.ec2_instance
| filter in("AWS_CREDENTIALS-<entity_id>", accessible_by[`dt.entity.aws_credentials`])
| summarize count()
```

**Syntax note**: Use `in(value, array_field)` for array membership — `arrayContains(arr, val)` does not exist in DQL.

### 6.2 EC2 + Lambda + (other built-in types) scoped count in one query
✅🟢 Verified + live using `append`
```dql
fetch dt.entity.ec2_instance
| filter in("AWS_CREDENTIALS-<entity_id>", accessible_by[`dt.entity.aws_credentials`])
| append [
    fetch dt.entity.aws_lambda_function
    | filter in("AWS_CREDENTIALS-<entity_id>", accessible_by[`dt.entity.aws_credentials`])
  ]
| summarize count(), by:{entity.type}
```

**Note on batching**: Fetching multiple entity types in a single `fetch` statement is not supported (`TOO_MANY_POSITIONAL_PARAMETERS` error). `union` is not a DQL command. Use `append` to combine results from multiple entity type queries. Each appended sub-query is independently filtered.

### 6.3 AWS custom devices scoped to a credential
✅ Verified
```dql
fetch dt.entity.custom_device
| filter contains(toString(entity.type), "cloud:aws")
    AND in("AWS_CREDENTIALS-<entity_id>", accessible_by[`dt.entity.aws_credentials`])
| summarize cnt=count(), by:{entity.type}
| sort cnt desc
```

---

## 7. Account-Scoped Entity Counts — Azure

### 7.1 Azure built-in entities scoped to a subscription
✅ Verified
```dql
fetch dt.entity.azure_vm
| filter in("AZURE_SUBSCRIPTION-<entity_id>", accessible_by[`dt.entity.azure_subscription`])
| summarize count()
```
Use `append` to batch multiple Azure entity types (same pattern as §6.2).

### 7.2 Azure custom devices scoped to a subscription
✅ Verified
```dql
fetch dt.entity.custom_device
| filter contains(toString(entity.type), "cloud:azure")
    AND in("AZURE_SUBSCRIPTION-<entity_id>", accessible_by[`dt.entity.azure_subscription`])
| summarize cnt=count(), by:{entity.type}
| sort cnt desc
```

---

## 8. Account-Scoped Entity Counts — GCP

### 8.1 GCP custom devices scoped by project ID
✅ Verified
```dql
fetch dt.entity.custom_device
| filter contains(toString(entity.type), "cloud:gcp")
    AND project_id == "my-gcp-project"
| summarize cnt=count(), by:{entity.type}
| sort cnt desc
```
GCP entities carry `project_id` directly — no relationship traversal needed.

---

## 9. New Connection Entity Counts (Smartscape)

### 9.1 New AWS entities scoped by account
✅ Verified
```dql
fetch metric.series, from:now()-2h
| fieldsKeep dt.da.source, dt.smartscape_source.type, dt.smartscape_source.id, aws.account.id
| filter dt.da.source == "aws-metric-poller"
    AND aws.account.id == "497414168292"
    AND isNotNull(dt.smartscape_source.type)
| summarize entity_count = countDistinct(dt.smartscape_source.id), by:{dt.smartscape_source.type}
| sort entity_count desc
```

### 9.2 New Azure entities scoped by subscription
✅ Verified
```dql
fetch metric.series, from:now()-2h
| fieldsKeep dt.da.source, dt.smartscape_source.type, dt.smartscape_source.id, azure.subscription
| filter dt.da.source == "azure-metric-poller"
    AND azure.subscription == "08b9810e-ddfb-42f4-899e-d0a378305c24"
    AND isNotNull(dt.smartscape_source.type)
| summarize entity_count = countDistinct(dt.smartscape_source.id), by:{dt.smartscape_source.type}
| sort entity_count desc
```

### 9.3 New GCP entities scoped by project
✅ Verified
```dql
fetch metric.series, from:now()-2h
| fieldsKeep dt.da.source, dt.smartscape_source.type, dt.smartscape_source.id, gcp.project.id
| filter dt.da.source == "gcp-cloud-monitoring"
    AND gcp.project.id == "my-gcp-project"
    AND isNotNull(dt.smartscape_source.type)
| summarize entity_count = countDistinct(dt.smartscape_source.id), by:{dt.smartscape_source.type}
| sort entity_count desc
```

### 9.4 New GCP entities via Smartscape nodes (alternative — no metric time window needed)
✅ Verified
```dql
smartscapeNodes "*"
| filter startsWith(type, "GCP_")
| summarize cnt=count(), by:{type}
```
Does not depend on a metric series time window. Use when you need current entity counts independent of recent metric activity.

---

## 10. Batched Entity Count Queries

### 10.1 Multiple entity types in one result set using `append`
✅🟢 Verified + live
```dql
fetch dt.entity.ec2_instance
| append [fetch dt.entity.ebs_volume]
| append [fetch dt.entity.aws_lambda_function]
| summarize count(), by:{entity.type}
```
Live result (gmg environment): `EC2_INSTANCE: 1952`, `EBS_VOLUME: 2908`, `AWS_LAMBDA_FUNCTION: 1837`.

**DQL batching behaviour:**
- A single `fetch` can only target one entity type (multiple positional args = `TOO_MANY_POSITIONAL_PARAMETERS` error).
- `union` does not exist in DQL.
- `append` chains result sets — each sub-query inside `[...]` is a fully independent pipeline that can have its own `filter`, `fields`, and `summarize` commands.
- For account-scoped batches, apply the credential/subscription filter inside each appended sub-query.

---

## 11. Account ID Extraction (Topology-Centric)

> These are the **primary cloud account enumeration queries** used by `useCloudAccountInventory` (Story 001 v2.0). Account IDs are extracted directly from DQL entity properties — no Config API required. All three patterns verified against the `gmg` environment on 2026-04-07.

### 11.1 AWS — Account ID from credential entity
✅🟢 Verified + live (gmg, 2026-04-07 — e.g. `"444652832050"`)
```dql
fetch dt.entity.aws_credentials
| fieldsAdd awsAccountId, entity.name, id, lifetime
| fieldsRemove can_access
```
`awsAccountId` is a direct string field. One credential entity = one AWS Account ID. See §1.1 for full annotation.

### 11.2 Azure — Subscription UUID via inline lookup
✅🟢 Verified + live (gmg, 2026-04-07 — e.g. `"7a78220a-499a-4093-94ba-4ab2f1d20ae2"`)
```dql
fetch dt.entity.azure_credentials
| fieldsAdd entity.name, id, belongs_to
| fieldsRemove can_access
| fieldsAdd sub_id = belongs_to[`dt.entity.azure_subscription`][0]
| lookup [fetch dt.entity.azure_subscription | fieldsAdd azureSubscriptionUuid],
    sourceField:sub_id, lookupField:id, prefix:"sub."
| fields entity.name, id, sub_id, sub.azureSubscriptionUuid
```
`sub.azureSubscriptionUuid` is the Azure Subscription ID. See §2.2 for full annotation including the `[0]` extraction requirement and null-handling for legacy credentials.

### 11.3 GCP — Project ID from project entity name
✅🟢 Verified + live (gmg, 2026-04-07 — e.g. `"dtp-dev204-sql-plsrv"`)
```dql
fetch `dt.entity.cloud:gcp:project`, from:now()-12h
| fields entity.name, id, lifetime
```
`entity.name` **is the GCP Project ID**. The backtick-quoted entity type is required. Grail applies the `from:` timeframe against the entity lifetime field — no explicit pipeline filter needed. See §3.2 for full annotation.

---

## 12. New Connection Enumeration (Smartscape)

> These patterns enumerate **new cloud connection** accounts/subscriptions/projects via **Smartscape on Grail** entities (`smartscapeNodes`). They are the canonical detection method for new connections — Smartscape pollers run independently of metric polling, so entities exist even when metric ingest is disabled.
>
> **Scope required**: `storage:smartscape:read`. This is distinct from `storage:entities:read` used by `fetch dt.entity.*` queries.
>
> **Timeframe / `from:` behaviour**: Smartscape entities have a **35-day default retention period** in Grail storage. `from:` is valid and filters by last-modified time — entities not updated within the window are excluded. Without `from:`, DQL applies the global default timeframe of **2 hours**, so queries without an explicit `from:` only return accounts actively updated in the last 2 hours. Always specify `from:` explicitly to avoid this silent truncation.
>
> **`name` vs account ID**: The `name` field on all three entity types is the **cloud-side display name** (AWS account alias, Azure subscription display name, GCP project display name) — NOT the Dynatrace connection config name. It is the preferred label for the inventory UI. The account ID fields (`aws.account.id`, `azure.subscription`, `gcp.project.id`) are the **join keys** to classic connection entities.

### 12.1 New AWS connections — all monitored accounts
✅🟢 Verified + live (gdq-dev, 2026-04-07 — e.g. `"038026236411"`)
```dql
smartscapeNodes AWS_ACCOUNT
| fields id, name, `aws.account.id`
```
- `aws.account.id` — AWS account number (numeric string, e.g. `"038026236411"`). **Join key** to `awsAccountId` from `dt.entity.aws_credentials` (§11.1).
- `name` — AWS account alias/display name (e.g. `"Dynatrace InfObs Clouds Playground"`). Cloud-side name.
- `id` — Smartscape entity ID (e.g. `AWS_ACCOUNT-CED3A106E0BCEA69`).
- One row per monitored AWS account.

### 12.2 New Azure connections — all monitored subscriptions
✅🟢 Verified + live (gdq-dev, 2026-04-07 — e.g. `"08b9810e-ddfb-42f4-899e-d0a378305c24"`)
```dql
smartscapeNodes AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS
| fields id, name, `azure.subscription`
```
- `azure.subscription` — Azure Subscription UUID (e.g. `"08b9810e-ddfb-42f4-899e-d0a378305c24"`). **Join key** to `sub.azureSubscriptionUuid` from the classic `dt.entity.azure_credentials` lookup (§11.2).
- `name` — Azure subscription display name (e.g. `"Dynatrace-InfObs-Clouds-Playground"`). Cloud-side name.
- `id` — Smartscape entity ID (e.g. `AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS-CEC54AF7A38150B6`).
- One row per monitored Azure subscription.

### 12.3 New GCP connections — all monitored projects
✅🟢 Verified + live (gdq-dev, 2026-04-07 — e.g. `"dynatrace-infobs-clouds-dev"`)
```dql
smartscapeNodes GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT
| fields id, name, `gcp.project.id`
```
- `gcp.project.id` — GCP project ID slug (e.g. `"dynatrace-infobs-clouds-dev"`). **Join key** to `entity.name` from `dt.entity.cloud:gcp:project` (§11.3).
- `name` — GCP project **display name** (e.g. `"Dynatrace InfObs Clouds Dev"`). **Not the project slug** — use `gcp.project.id` as the join key, not `name`.
- `id` — Smartscape entity ID (e.g. `GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT-5A0247EE4343F723`).
- One row per monitored GCP project.
