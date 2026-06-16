# Metric Key Mapping — Heuristic Fallback Guide

> **Primary approach**: Use `scripts/lookup-mapping.py metric --key "<classic_key>" --provider <aws|azure>` to look up exact mappings from the authoritative JSON database (53K+ AWS entries, 46K+ Azure entries). The rules below are **heuristic fallbacks** for metrics not found in the mapping database, and for GCP (mapping database not yet available).
>
> **Abbreviated and non-standard classic key overrides** (e.g. `cloud.aws.alb.*`, `cloud.aws.eccustom.*`, `cloud.aws.aurora.*`) are maintained as authoritative data in [`references/manual-metric-mappings.json`](manual-metric-mappings.json). That file is the single source of truth for those keys — do not duplicate entries here.

Rules for translating classic cloud metric keys to their new connection equivalents when the exact mapping is not available in the JSON database.

---

## Table of Contents

- [1. Mapping Strategy](#1-mapping-strategy)
- [2. AWS Metric Key Migration](#2-aws-metric-key-migration)
- [3. Azure Metric Key Migration](#3-azure-metric-key-migration)
- [4. GCP Metric Key Migration](#4-gcp-metric-key-migration)
- [5. Discovery Queries](#5-discovery-queries)

---

## 1. Mapping Strategy

The primary mapping approach is the **authoritative JSON database** queried via `scripts/lookup-mapping.py`. When that returns no match, apply the heuristic rules below.

There is **no 1:1 rename** from classic to new metric keys. The metric key format, naming convention, and enrichment dimensions all change. The heuristic strategy is:

1. **Identify the classic prefix type** (built-in `dt.cloud.*`, non-built-in `cloud.*`, Cassandra-era `builtin:*` / `ext:*`)
2. **Apply the key format transformation** using the patterns below
3. **Discover the new metric key** by querying live metric data for the new connection (Section 5)
4. **Validate the new key produces data** for the same resources

### Key Format Differences

| Classic | New | Example |
|---|---|---|
| `dt.cloud.aws.<service>.<metric>` | `cloud.aws.<service>.<Metric>.By.<Dim>` | `dt.cloud.aws.ec2.cpu.usage` → `cloud.aws.ec2.CPUUtilization.By.InstanceId` |
| `cloud.aws.<service>.<snake_case>` | `cloud.aws.<service>.<PascalCase>.By.<Dim>` | `cloud.aws.lambda.concurrent_executions_sum` → `cloud.aws.lambda.ConcurrentExecutions.By.FunctionName` |
| `dt.cloud.azure.<service>.<metric>` | `cloud.azure.microsoft_<provider>.<resource>.<Metric>` | `dt.cloud.azure.vm.cpu_usage` → `cloud.azure.microsoft_compute.virtualmachines.PercentageCPU` |
| `cloud.gcp.<api>_googleapis_com.<path>` | `cloud.gcp.<resource>.<api>_googleapis_com.<path>` | `cloud.gcp.compute_googleapis_com.instance.cpu.utilization` → `cloud.gcp.gce_instance.compute_googleapis_com.instance.cpu.utilization` |

---

## 2. AWS Metric Key Migration

### Built-in → New Connection

Classic built-in (`dt.cloud.aws.*`) metric names are Dynatrace-curated short names. New connection uses CloudWatch original names (PascalCase) with `.By.` dimension separators.

**Lambda examples:**

| Classic (`dt.cloud.aws.`) | New Connection |
|---|---|
| `dt.cloud.aws.lambda.invocations` | `cloud.aws.lambda.Invocations.By.FunctionName` |
| `dt.cloud.aws.lambda.duration` | `cloud.aws.lambda.Duration.By.FunctionName` |
| `dt.cloud.aws.lambda.errors` | `cloud.aws.lambda.Errors.By.FunctionName` |
| `dt.cloud.aws.lambda.conc_executions` | `cloud.aws.lambda.ConcurrentExecutions.By.FunctionName` |
| `dt.cloud.aws.lambda.throttlers` | `cloud.aws.lambda.Throttles.By.FunctionName` |

**EC2 examples:**

| Classic (`dt.cloud.aws.`) | New Connection |
|---|---|
| `dt.cloud.aws.ec2.cpu.usage` | `cloud.aws.ec2.CPUUtilization.By.InstanceId` |
| `dt.cloud.aws.ec2.network.in` | `cloud.aws.ec2.NetworkIn.By.InstanceId` |
| `dt.cloud.aws.ec2.network.out` | `cloud.aws.ec2.NetworkOut.By.InstanceId` |
| `dt.cloud.aws.ec2.disk.read` | `cloud.aws.ec2.DiskReadBytes.By.InstanceId` |
| `dt.cloud.aws.ec2.disk.write` | `cloud.aws.ec2.DiskWriteBytes.By.InstanceId` |

**RDS examples:**

| Classic (`dt.cloud.aws.`) | New Connection |
|---|---|
| `dt.cloud.aws.rds.cpuUsage` | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` |
| `dt.cloud.aws.rds.freeStorage` | `cloud.aws.rds.FreeStorageSpace.By.DBInstanceIdentifier` |
| `dt.cloud.aws.rds.readLatency` | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` |

### Non-Built-in (Classic) → New Connection

Classic non-built-in keys use snake_case; new connection uses PascalCase. The service segment is often the same.

| Classic non-built-in | New Connection |
|---|---|
| `cloud.aws.lambda.concurrent_executions_sum` | `cloud.aws.lambda.ConcurrentExecutions.By.FunctionName` |
| `cloud.aws.s3.number_of_objects_average` | *(discover via query — S3 metrics differ by filter)* |

### Cassandra-era Selectors

| Cassandra-era prefix | Grail equivalent | Then migrate to |
|---|---|---|
| `builtin:cloud.aws.<service>.*` | `dt.cloud.aws.<service>.*` | New connection key |
| `ext:cloud.aws.<service>.*` | `cloud.aws.<service>.*` | New connection key |

---

## 3. Azure Metric Key Migration

### Built-in → New Connection

Classic built-in (`dt.cloud.azure.*`) uses Dynatrace-curated names. New connection uses Azure Monitor original names.

**VM examples:**

| Classic (`dt.cloud.azure.`) | New Connection |
|---|---|
| `dt.cloud.azure.vm.cpu_usage` | `cloud.azure.microsoft_compute.virtualmachines.PercentageCPU` |
| `dt.cloud.azure.vm.disk.read` | `cloud.azure.microsoft_compute.virtualmachines.DiskReadBytes` |
| `dt.cloud.azure.vm.network.bytes_in` | `cloud.azure.microsoft_compute.virtualmachines.NetworkInTotal` |

**Redis examples:**

| Classic (`dt.cloud.azure.`) | New Connection |
|---|---|
| `dt.cloud.azure.redis.cache.hits` | `cloud.azure.microsoft_cache.redis.cachehits` |
| `dt.cloud.azure.redis.cache.misses` | `cloud.azure.microsoft_cache.redis.cachemisses` |
| `dt.cloud.azure.redis.connected` | `cloud.azure.microsoft_cache.redis.connectedclients` |

### Cloud Service (Classic) → New Connection

Classic cloud service metrics and new connection metrics often share the **same key** (`cloud.azure.microsoft_*`). Distinguish by `dt.da.source`:
- Classic: `dt.da.source` is null
- New: `dt.da.source == "azure-metric-poller"`

If the key is identical, no metric key rewrite is needed — only the entity migration matters.

---

## 4. GCP Metric Key Migration

GCP classic and new connection keys differ by an inserted resource type segment:

| Classic | New |
|---|---|
| `cloud.gcp.<api>_googleapis_com.<metric_path>` | `cloud.gcp.<resource_type>.<api>_googleapis_com.<metric_path>` |

**Examples:**

| Classic | New |
|---|---|
| `cloud.gcp.compute_googleapis_com.instance.cpu.utilization` | `cloud.gcp.gce_instance.compute_googleapis_com.instance.cpu.utilization` |
| `cloud.gcp.cloudsql_googleapis_com.database.cpu.utilization` | `cloud.gcp.cloudsql_database.cloudsql_googleapis_com.database.cpu.utilization` |
| `cloud.gcp.pubsub_googleapis_com.subscription.num_undelivered_messages` | `cloud.gcp.pubsub_subscription.pubsub_googleapis_com.subscription.num_undelivered_messages` |
| `cloud.gcp.storage_googleapis_com.storage.total_bytes` | `cloud.gcp.gcs_bucket.storage_googleapis_com.storage.total_bytes` |

---

## 5. Discovery Queries

When the exact new metric key is unknown, discover it from live data.

> **Note:** In the `dtctl query` examples below, inner quotes are escaped for the shell (`\"`). When running DQL directly, use standard double-quotes.

### Discover New AWS Metric Keys for a Service

```
dtctl query "fetch metric.series, from:now()-1h
| filter startsWith(metric.key, \"cloud.aws.<service>\") AND dt.da.source == \"aws-metric-poller\"
| summarize cnt=count(), by:{metric.key, dt.da.source, dt.smartscape_source.type}"
```

### Discover New Azure Metric Keys for a Service

```
dtctl query "fetch metric.series, from:now()-1h
| filter startsWith(metric.key, \"cloud.azure.microsoft_<provider>\") AND dt.da.source == \"azure-metric-poller\"
| summarize cnt=count(), by:{metric.key, dt.da.source, dt.smartscape_source.type}"
```

### Discover New GCP Metric Keys for a Service

```
dtctl query "fetch metric.series, from:now()-1h
| filter startsWith(metric.key, \"cloud.gcp.\") AND dt.da.source == \"gcp-cloud-monitoring\"
| summarize cnt=count(), by:{metric.key, dt.da.source, dt.smartscape_source.type}"
```

### Validate a Specific Metric Key Has Data

```
dtctl query "fetch metric.series, from:now()-1h
| filter metric.key == \"<new_metric_key>\"
| summarize cnt=count()"
```
