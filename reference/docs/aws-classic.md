# Classic AWS Connections in Dynatrace

> **Scope**: This document covers the **classic** (legacy) AWS monitoring integration only.
> It does **NOT** cover the new AWS cloud platform monitoring (`aws-onboarding`). New-connection Smartscape entities (Smartscape on Grail) always start with `AWS_` (e.g., `AWS_EC2_INSTANCE`, `AWS_LAMBDA_FUNCTION`) — do not confuse with classic entity types that share similar names but originate from the classic connection.

## Overview

Classic AWS monitoring in Dynatrace provides three distinct methods for ingesting AWS CloudWatch metrics. Each method produces different entity types, metric key formats, and data flows. Understanding these differences is critical for the Cloud Migration Helper App.

---

## 1. The Three Flavours of Classic AWS Connections

### 1.1 Default CloudWatch Integration (Polling / "Built-in" / Limited set of AWS services)

| Property | Value |
|---|---|
| **Data Source** | Dynatrace Cluster (Cluster ActiveGate) polls CloudWatch APIs on 5-minute intervals |
| **Configuration** | Via Dynatrace UI: Settings → Cloud and virtualization → AWS |
| **Settings Schema** | `builtin:cloud.aws` (connect AWS Account) |
| **Environment ActiveGate** | Not required for built-in services with AWS Account < 2000 AWS resources |
| **Firehose** | Not required |
| **Metric Selection** | Not possible for built-in services. Recommended metrics are always selected and cannot be changed |
| **Entities** | Full topology (dedicated entity types for built-in services) |
| **Metric Key Prefix (Grail)** | `dt.cloud.aws.<service>.<metricName>` |
| **Metric Key Prefix (Classic Dynatrace - Cassandra)** | `builtin:cloud.aws.<service>.<MetricName>` |
| **Tags** | Available (imported from AWS) |
| **Predefined Alerts** | Unclear - needs verification |
| **Predefined Dashboards** | Not available |
| **DDU Consumption** | 0.001 DDU per data point (metric × dimension) |

This is the oldest and most feature-complete approach. The ActiveGate (or Dynatrace Cluster for small environments) calls the CloudWatch `GetMetricData` API to pull metrics.

### 1.2 Default CloudWatch Integration (Polling / "Non-Built-in" ("Cloud services") / Additional Services)

| Property | Value |
|---|---|
| **Data Source** | Environment ActiveGate polls CloudWatch APIs on 5-minute intervals, but for additional AWS services |
| **Configuration** | Via Dynatrace UI: Settings → Cloud and virtualization → AWS |
| **Settings Schema** | `builtin:cloud.aws` (connect AWS Account) |
| **Environment ActiveGate** | Required for non-built-in services; customer needs to install ActiveGate in his cloud environment |
| **Firehose** | Not required |
| **Entities** | Full topology (`CUSTOM_DEVICE` for non-built-in) |
| **Entity Type** | `CUSTOM_DEVICE` with type `cloud:aws:<service>` (e.g., `cloud:aws:s3`, `cloud:aws:aurora`) |
| **Parent Entity** | `CUSTOM_DEVICE_GROUP` (named per service, e.g., "AWS Lambda", "AWS Billing", "AWS WAF") |
| **Metric Key Prefix (Grail)** | `cloud.aws.<service>.<MetricName>` (snake_case, sometimes `_by_<Dimension>` and services names and metric names are split by '_') |
| **Metric Key Prefix (Classic Dynatrace - Cassandra)** | `ext:cloud.aws.<service>.<metricName>` |
| **`dt.da.source`** | Not set (null) — important to distinguish non-builtin from metrics from NEW aws connection (aws-new.md) |
| **`dt.source_entity.type`** | `cloud:aws:<service>` (e.g., `cloud:aws:aurora`, `cloud:aws:rds`) |
| **Tags** | Available (imported from AWS) |
| **Predefined Alerts** | Available |
| **Predefined Dashboards** | Available (for most services) |

These are services you enable manually in the AWS connection configuration beyond the default classic services.

### 1.3 CloudWatch Metric Streams

| Property | Value |
|---|---|
| **Data Source** | AWS CloudWatch → Kinesis Data Firehose → Dynatrace API endpoint |
| **Configuration** | CloudFormation template deployed in each AWS region |
| **ActiveGate** | Not required |
| **Firehose** | Required |
| **HTTPS Ingress** | Dynatrace tenant must be open to incoming internet traffic |
| **Metric Selection** | In AWS CloudWatch console — namespace level only |
| **Metric Key Prefix** | `cloud.aws.<service>.<metricName>By<Dimension1><Dimension2>...` (camelCase, dimensions in key) |
| **`dt.source`** | `"AWS Metric Streams"` |
| **Entities** | Available only with the "AWS Entities for Metric Streaming" extension enabled |
| **Tags** | Not available |
| **Predefined Alerts** | Not available |
| **Predefined Dashboards** | Available (via GitHub upload script) |

Metrics are pushed from AWS rather than pulled. This enables monitoring of **all** CloudWatch metrics, not just the curated Dynatrace set.

---

## 2. Metric Key Format Comparison

### 2.1 Three Metric Key Prefixes (Grail)

| Prefix (Grail) | Source | Description | Example |
|---|---|---|---|
| `dt.cloud.aws.<service>.*` | Built-in classic services | Curated, Dynatrace-native metric keys with dedicated entity types | `dt.cloud.aws.ec2.cpu.usage` |
| `cloud.aws.<service>.<MetricName>.By.<Dim>` | Classic non-built-in polling **AND** new AWS connection | CloudWatch metric names with dot-separated dimensions | `cloud.aws.lambda.ConcurrentExecutions.By.FunctionName` |
| `cloud.aws.<service>.<metricName>By<Dim1><Dim2>` | Metric Streams | camelCase metric names with dimensions concatenated in key | `cloud.aws.lambda.durationByAccountIdFunctionNameRegion` |

> **Important**: The `cloud.aws.<service>.<MetricName>.By.<Dim>` pattern is **shared** between the classic non-built-in polling and the **new AWS connection**. See [Section 4](#4-disambiguating-classic-vs-new-aws-connection) for how to tell them apart.

> **Note**: The documentation references an `ext:cloud.aws.<service>` prefix for classic non-built-in services. This prefix is used in Classic Dynatrace (2nd generation; metrics have been stored in Cassandra and not Grail). When metrics get (automatically) forwarded from Cassandra to Grail, the prefix changed from `ext:cloud.aws` to `cloud.aws.*`. Similary, it changed for builtin-services from `builtin:cloud.aws` to `dt.cloud.aws`.

### 2.2 Naming Pattern Examples (Lambda)

| Type | Metric Keys (Grail) |
|---|---|
| **Built-in (`dt.cloud.aws.`)** | `dt.cloud.aws.lambda.invocations`, `dt.cloud.aws.lambda.duration`, `dt.cloud.aws.lambda.errors`, `dt.cloud.aws.lambda.errors_rate`, `dt.cloud.aws.lambda.conc_executions`, `dt.cloud.aws.lambda.throttlers` |
| **Non-built-in polling** | `cloud.aws.lambda.ConcurrentExecutions.By.FunctionName`, `cloud.aws.lambda.Invocations.By.FunctionName`, `cloud.aws.lambda.Errors.By.FunctionName`, `cloud.aws.lambda.Duration.By.FunctionName`, `cloud.aws.lambda.Throttles.By.FunctionName` |
| **Metric Streams** | `cloud.aws.lambda.invocationsByAccountIdFunctionNameRegion`, `cloud.aws.lambda.durationByAccountIdFunctionNameRegion`, `cloud.aws.lambda.errorsByAccountIdFunctionNameRegion`, `cloud.aws.lambda.concurrentExecutionsByAccountIdFunctionNameRegion`, `cloud.aws.lambda.throttlesByAccountIdFunctionNameRegion` |

### 2.3 Non-built-in Custom Device Metrics (with `cloud:aws:*` entity types)

These metrics use the `cloud.aws.<service>.*` prefix but are tied to `CUSTOM_DEVICE` entities via `dt.source_entity.type`:

| Entity Type (`cloud:aws:*`) | Metric Key Prefix (Grail) | Example Metrics |
|---|---|---|
| `cloud:aws:aurora` | `cloud.aws.aurora.*` | `cpu_utilization_average`, `database_connections_average`, `read_iops`, `write_latency`, `volume_bytes_used` |
| `cloud:aws:rds` | `cloud.aws.rds.*` | `cpu_utilization`, `database_connections_sum`, `free_storage_space`, `read_latency`, `write_latency` |
| `cloud:aws:elasticachecustom` | `cloud.aws.eccustom.*` | `cache_hits_sum`, `cache_misses_sum`, `cpu_utilization`, `freeable_memory`, `replication_lag` |
| `cloud:aws:s3` | `cloud.aws.s3.*` | (S3 bucket metrics) |
| `cloud:aws:billing` | `cloud.aws.billing.*` | `estimated_charges_by_currency` |
| `cloud:aws:cloud_front` | `cloud.aws.cloudfront.*` | `requests_sum_by_region`, `4xx_error_rate_average_by_region`, `bytes_downloaded_sum_by_region` |
| `cloud:aws:wafv2` | `cloud.aws.waf.*` | (WAF metrics) |
| `cloud:aws:lambda` | `cloud.aws.lambda.*` | `concurrent_executions_sum`, `duration`, `errors_sum`, `invocations_sum`, `throttles_sum` |
| `cloud:aws:nat_gateway` | `cloud.aws.nat_gateways.*` | `active_connection_count_maximum`, `packets_drop_count_sum` |
| `cloud:aws:sqs` | `cloud.aws.sqs.*` | (SQS queue metrics) |
| `cloud:aws:api_gateway` | `cloud.aws.api_gateway.*` | `4xx_error_sum`, `5xx_error_sum`, `count_sum`, `latency` |
| `cloud:aws:sns` | `cloud.aws.sns.*` | (SNS topic metrics) |

---

## 3. Metric Key Prefix Summary

| Metric Key Pattern (Grail) | Connection Type | Entity Type | Notes |
|---|---|---|---|
| `dt.cloud.aws.<service>.<metric>` | Built-in classic polling | Dedicated type (e.g., `EC2_INSTANCE`) | Curated, short names, Dynatrace-native |
| `dt.cloud.aws.az.*` | Built-in classic | `AWS_CREDENTIALS` | Account-level AZ statistics |
| `cloud.aws.<service>.<MetricName>.By.<Dim>` | Non-built-in polling (classic) **or new AWS connection** | `CUSTOM_DEVICE` (`cloud:aws:*`) for classic; Smartscape entities for new | CW metric names, `By` separators, PascalCase. See [Section 4](#4-disambiguating-classic-vs-new-aws-connection) to distinguish. |
| `cloud.aws.<service>.<snake_case_metric>` | Non-built-in polling (entity-bound) | `CUSTOM_DEVICE` (`cloud:aws:*`) | snake_case, tied to `dt.source_entity.type` |
| `cloud.aws.<service>.<camelCase>By<Dim1><Dim2>` | Metric Streams | None (unless extension enabled) | Dimensions concatenated in key name |
| `cloud.aws.<service>.<metric>_by_region` | Non-built-in polling (group-level) | `CUSTOM_DEVICE_GROUP` | Regional aggregations |
---

## 4. Entity Model

### 4.1 Classic Built-in Entity Types (Dedicated)

These services have their own first-class Dynatrace entity types (not `CUSTOM_DEVICE`):

| Entity Type | ID Prefix | AWS Service |
|---|---|---|
| `EC2_INSTANCE` | `EC2_INSTANCE-` | Amazon EC2 |
| `EBS_VOLUME` | `EBS_VOLUME-` | Amazon EBS |
| `AWS_LAMBDA_FUNCTION` | `AWS_LAMBDA_FUNCTION-` | AWS Lambda |

> **Warning — Entity Name Collision**: `AWS_LAMBDA_FUNCTION`, `AWS_APPLICATION_LOAD_BALANCER`, `AWS_NETWORK_LOAD_BALANCER`, and `AWS_AVAILABILITY_ZONE` share **identical type names** with Smartscape on Grail entities created by the new AWS connection. These are completely separate entity systems: classic entities live in Cassandra and are queried with `fetch dt.entity.<type>`; Smartscape on Grail entities live in Grail and are queried with `smartscapeNodes <EntityType>`. When both connections coexist, entities from both systems will be present for the same AWS resources.

| `AUTO_SCALING_GROUP` | `AUTO_SCALING_GROUP-` | EC2 Auto Scaling |
| `AWS_APPLICATION_LOAD_BALANCER` | `AWS_APPLICATION_LOAD_BALANCER-` | Application Load Balancer |
| `AWS_NETWORK_LOAD_BALANCER` | `AWS_NETWORK_LOAD_BALANCER-` | Network Load Balancer |
| `ELASTIC_LOAD_BALANCER` | `ELASTIC_LOAD_BALANCER-` | Classic Load Balancer (ELB) |
| `RELATIONAL_DATABASE_SERVICE` | `RELATIONAL_DATABASE_SERVICE-` | Amazon RDS (built-in) |
| `DYNAMO_DB_TABLE` | `DYNAMO_DB_TABLE-` | Amazon DynamoDB (built-in) |
| `AWS_CREDENTIALS` | `AWS_CREDENTIALS-` | AWS Connection itself |
| `AWS_AVAILABILITY_ZONE` | `AWS_AVAILABILITY_ZONE-` | Availability Zone topology |

### 4.2 Non-Built-in Entities (Custom Devices)

Non-built-in AWS services create entities under the `CUSTOM_DEVICE` type with a sub-type:

| Entity Type (sub-type) | ID Prefix | AWS Service |
|---|---|---|
| `cloud:aws:s3` | `CUSTOM_DEVICE-` | Amazon S3 |
| `cloud:aws:rds` | `CUSTOM_DEVICE-` | Amazon RDS (non-built-in) |
| `cloud:aws:elasticachecustom` | `CUSTOM_DEVICE-` | Amazon ElastiCache |
| `cloud:aws:aurora` | `CUSTOM_DEVICE-` | Amazon Aurora |
| `cloud:aws:billing` | `CUSTOM_DEVICE-` | AWS Billing |
| `cloud:aws:wafv2` | `CUSTOM_DEVICE-` | AWS WAF v2 |
| `cloud:aws:cloud_front` | `CUSTOM_DEVICE-` | Amazon CloudFront |
| `cloud:aws:sqs` | `CUSTOM_DEVICE-` | Amazon SQS |
| `cloud:aws:nat_gateway` | `CUSTOM_DEVICE-` | VPC NAT Gateway |
| `cloud:aws:api_gateway` | `CUSTOM_DEVICE-` | Amazon API Gateway |
| `cloud:aws:lambda` | `CUSTOM_DEVICE-` | AWS Lambda (non-built-in) |
| `cloud:aws:sns` | `CUSTOM_DEVICE-` | Amazon SNS |

Parent grouping: `CUSTOM_DEVICE_GROUP` entities like "AWS Lambda", "AWS Billing", "AWS WAF".

### 4.3 Entity Hierarchy

```
AWS_CREDENTIALS (connection)
├── AWS_AVAILABILITY_ZONE (topology)
├── EC2_INSTANCE (built-in)
├── EBS_VOLUME (built-in)
├── AWS_LAMBDA_FUNCTION (built-in)
├── AUTO_SCALING_GROUP (built-in)
├── AWS_APPLICATION_LOAD_BALANCER (built-in)
├── AWS_NETWORK_LOAD_BALANCER (built-in)
├── ELASTIC_LOAD_BALANCER (built-in)
├── RELATIONAL_DATABASE_SERVICE (built-in)
├── DYNAMO_DB_TABLE (built-in)
└── CUSTOM_DEVICE_GROUP (per service)
    └── CUSTOM_DEVICE (cloud:aws:<service>) (non-built-in)
```

### 4.4 Complete List of Documented `cloud:aws:*` Entity Types

From the Dynatrace documentation, the full set of supported non-built-in entity types:

`cloud:aws:acmprivateca`, `cloud:aws:api_gateway`, `cloud:aws:app_runner`, `cloud:aws:appstream`, `cloud:aws:appsync`, `cloud:aws:athena`, `cloud:aws:aurora`, `cloud:aws:autoscaling`, `cloud:aws:billing`, `cloud:aws:cloud_front`, `cloud:aws:cloudhsm`, `cloud:aws:cloudsearch`, `cloud:aws:codebuild`, `cloud:aws:datasync`, `cloud:aws:dax`, `cloud:aws:dms`, `cloud:aws:documentdb`, `cloud:aws:dxcon`, `cloud:aws:dynamodb`, `cloud:aws:ebs`, `cloud:aws:ec2_spot`, `cloud:aws:ecs`, `cloud:aws:ecs:cluster`, `cloud:aws:efs`, `cloud:aws:eks:cluster`, `cloud:aws:elasticache`, `cloud:aws:elasticbeanstalk`, `cloud:aws:elastictranscoder`, `cloud:aws:es`, `cloud:aws:events`, `cloud:aws:fsx`, `cloud:aws:gamelift`, `cloud:aws:glue`, `cloud:aws:inspector`, `cloud:aws:kafka`, `cloud:aws:lambda`, `cloud:aws:lex`, `cloud:aws:logs`, `cloud:aws:media_tailor`, `cloud:aws:mediaconnect`, `cloud:aws:mediapackagelive`, `cloud:aws:mediapackagevod`, `cloud:aws:nat_gateway`, `cloud:aws:neptune`, `cloud:aws:opsworks`, `cloud:aws:qldb`, `cloud:aws:rds`, `cloud:aws:redshift`, `cloud:aws:robomaker`, `cloud:aws:route53`, `cloud:aws:route53resolver`, `cloud:aws:s3`, `cloud:aws:sage_maker:endpoint`, `cloud:aws:sage_maker:endpoint_instance`, `cloud:aws:sns`, `cloud:aws:sqs`, `cloud:aws:storagegateway`, `cloud:aws:swf`, `cloud:aws:transfer`, `cloud:aws:transitgateway`, `cloud:aws:vpn`, `cloud:aws:wafv2`, `cloud:aws:workmail`, `cloud:aws:workspaces`

---

## 5. Disambiguating Classic vs New AWS Connection

The metric key pattern `cloud.aws.<service>.<MetricName>.By.<Dim>` is used by **both** the classic non-built-in polling and the new AWS connection. This makes disambiguation essential.

### `dt.da.source` Values

> **Critical**: Classic connections never set `dt.da.source`. Any non-null `dt.da.source` value containing `aws` originates from the **new AWS connection**.

| `dt.da.source` Value | Origin |
|---|---|
| `aws-metric-poller` | **New** AWS connection (metric polling) |
| (null) | Classic connection or Metric Streams |

For the full list of `dt.da.source` values used by the new connection (including Smartscape pollers and log ingest), see [aws-new.md Section 1.1](aws-new.md#11-data-acquisition-components).

### How to Tell Classic from New

| Dimension / Rule | Connection Type |
|---|---|
| `dt.da.source == "aws-metric-poller"` + smartscape dimensions present (`dt.smartscape_source.id`, `dt.smartscape_source.type`) | **New** AWS connection |
| `dt.entity.cloud:aws:account` dimension present (custom device entity ID of the AWS Account) | **Classic** connection |
| `dt.source == "AWS Metric Streams"` | CloudWatch Metric Streams (classic setup) |
| `dt.source_entity.type` is a built-in entity type (e.g., `ec2_instance`, `ebs_volume`) | Built-in classic polling |
| `dt.source_entity.type` starts with `cloud:aws:` | Non-built-in classic polling (custom device) |
| `dt.source_entity.type == "aws_credentials"` | Account-level aggregated metrics (classic) |
| `dt.source_entity.type == "custom_device_group"` | Service-group-level aggregated metrics by region (classic) |
| `dt.metrics.source == "openpipeline:logs"` | Log-derived AWS metrics |

> **Warning — Parallel Ingestion**: It is possible for the same metric to be ingested by both the classic and the new AWS connection simultaneously. In this case, the metric will carry dimensions from **both** connections (e.g., both `dt.da.source` and `dt.entity.cloud:aws:account`). Running both connections in parallel is **not recommended** — it results in duplicate metric ingestion and double cost.

--- 

## 6. Settings Schemas

| Schema ID | Purpose |
|---|---|
| `builtin:cloud.aws` | AWS classic connections |
| `builtin:anomaly-detection.infrastructure-aws` | Anomaly detection for classic AWS services (CPU, memory, disk) |
| `builtin:hyperscaler-authentication.aws.connection` | AWS connection auth for Workflows (NOT classic) |
| `builtin:hyperscaler-authentication.connections.aws` | AWS connections for new cloud platform (NOT classic) |

> **Note**: Classic AWS connection configuration is managed through the legacy Configuration API, not the Settings 2.0 framework. Classic connections are accessed via `GET/POST /api/config/v1/aws/credentials`.

---

## 7. DQL Query Patterns for Classic AWS Data

### 7.1 Find All Classic AWS Entities

```dql
// Built-in entities
fetch dt.entity.ec2_instance | limit 10
fetch dt.entity.ebs_volume | limit 10
fetch dt.entity.aws_lambda_function | limit 10
fetch dt.entity.aws_credentials | limit 10

// Non-built-in (custom device) entities
fetch dt.entity.custom_device
| filter contains(toString(entity.type), "cloud:aws")
| summarize cnt=count(), by:{entity.type}
| sort cnt desc
```

### 7.2 Identify Metric Source Type

```dql
fetch metric.series
| fields metric.key, dt.da.source, dt.source_entity.type, dt.source, dt.metrics.source
| filter startsWith(metric.key, "cloud.aws.") OR startsWith(metric.key, "dt.cloud.aws.")
| summarize cnt=count(), by:{dt.da.source, dt.source_entity.type, dt.source, dt.metrics.source}
| sort cnt desc
```

### 7.3 List All Non-Built-in Service Metrics

```dql
fetch metric.series
| fields metric.key, dt.source_entity.type
| filter startsWith(metric.key, "cloud.aws.") AND contains(toString(dt.source_entity.type), "cloud:aws:")
| summarize cnt=count(), by:{metric.key, dt.source_entity.type}
| sort dt.source_entity.type asc, metric.key asc
```

### 7.4 List All Metric Streams Metrics

```dql
fetch metric.series
| fields metric.key, dt.source
| filter dt.source == "AWS Metric Streams"
| summarize cnt=count(), by:{metric.key}
| sort metric.key asc
```

### 7.5 Comprehensive Metric Analysis (All Classic Sources)

```dql
fetch metric.series
| fields metric.key, aws.credentials, dt.system.monitoring_source, dt.da.source, aws.resource_type, dt.source_entity.type, dt.source, service, type, dt.metrics.source
| filter contains(metric.key, "aws")
| filterOut startsWith(metric.key, "dac.aws_")
| filterOut startsWith(metric.key, "remote_dsfm.active_gate.aws.")
| filterOut dt.system.monitoring_source == "fullstack_host"
| filterOut startsWith(metric.key, "dt.sfm.active_gate.aws.") OR startsWith(metric.key, "dt.sfm.server.aws.")
| summarize cnt=count(), by:{metric.key, aws.credentials, dt.system.monitoring_source, dt.da.source, aws.resource_type, dt.source_entity.type, dt.source, service, type, dt.metrics.source}
| sort cnt desc
```

---

## 8. Key Differences Summary

| Aspect | Built-in Classic | Non-Built-in Polling (Classic) | Metric Streams |
|---|---|---|---|
| **Metric prefix** | `dt.cloud.aws.*` | `cloud.aws.*` | `cloud.aws.*` |
| **Entity type** | Dedicated (e.g., `EC2_INSTANCE`) | `CUSTOM_DEVICE` (`cloud:aws:*`) | None (requires extension) |
| **`dt.da.source`** | (null) | (null) — **not** `aws-metric-poller` (that's new connection) | (null) |
| **`dt.source`** | (null) | (null) | `"AWS Metric Streams"` |
| **`dt.source_entity.type`** | Built-in type name | `cloud:aws:<service>` | (null) |
| **Classic identifier** | `dt.source_entity.type` = built-in type | `dt.entity.cloud:aws:account` dimension | `dt.source == "AWS Metric Streams"` |
| **Metric naming** | Short, Dynatrace-curated | CW names, snake_case / `_by_<dim>` | camelCase, dims in key |
| **Collection** | Pull (ActiveGate → CloudWatch API) | Pull (ActiveGate → CloudWatch API) | Push (AWS → Firehose → DT API) |
| **Interval** | 5 minutes | 5 minutes | Near real-time (1-3 min) |
| **Tags** | Yes | Yes | No |
| **Alerts** | No predefined | Predefined available | No predefined |
| **Topology** | Full | Custom device topology | Requires extension |

---

## 9. Migration Relevance

When assisting with cloud migration, the app needs to:

1. **Detect which classic connection flavours are active** — query `AWS_CREDENTIALS` entities and identify metric sources
2. **Map entities to the correct metric patterns** — a single AWS service (e.g., Lambda) can appear through multiple paths simultaneously (built-in entity + non-built-in custom device + Metric Streams)
3. **Understand metric deduplication** — the same logical metric (e.g., Lambda invocations) exists under different keys depending on the ingestion path
4. **Account for missing topology in Metric Streams** — Metric Streams metrics lack entity context unless the extension is enabled
5. **Handle the entity type split** — RDS, Lambda, and DynamoDB exist as both built-in entity types AND `cloud:aws:*` custom devices with different metric key formats
6. **Detect parallel classic + new connection ingestion** — when both classic and new AWS connections are active for the same account, the same `cloud.aws.*` metric may carry dimensions from both. This results in double cost and should be flagged as a migration issue
7. **Flag log forwarding configuration (future scope)** — classic AWS log ingest is typically configured via Kinesis Data Firehose at the connection/account level, not per service. Log migration is out of scope for the initial implementation but should be surfaced as a deferred migration task per cloud account.


