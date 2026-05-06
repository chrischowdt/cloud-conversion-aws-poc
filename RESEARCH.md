# AWS Classic → New Cloud Platform Monitoring: Research Findings

Research date: 2026-04-21. All facts cited to docs.dynatrace.com pages retrieved on that date. When a page is ambiguous, I've said so.

## 1. The two products

| | **Classic AWS monitoring** | **New AWS Cloud Platform Monitoring** |
|---|---|---|
| Docs section | `/docs/ingest-from/amazon-web-services/integrate-with-aws/*` ("Classic Cloud Platform Monitoring") | `/docs/ingest-from/amazon-web-services/aws-onboarding` ("New Cloud Platform Monitoring") |
| Data flow | ActiveGate polls CloudWatch in-account; metrics written to classic metrics store | Dynatrace SaaS polls CloudWatch (no ActiveGate for metrics); logs via CloudWatch → Firehose; topology via Dynatrace scan |
| Storage | Classic metrics store (builtin) + classic topology | **Grail** (metrics, Smartscape nodes/edges, logs, events) |
| UI / config app | Classic AWS integration config | **Clouds app** |

**Status caveat:** the AWS index page still labels the new section "New Cloud Platform Monitoring" without a GA/Preview badge; the onboarding page (`aws-onboarding`, published 2025-09-25) reads as a shipped product. We framed this project around AWS being GA — that's consistent with the doc tone, but I did **not** find an explicit "GA as of <date>" announcement on docs.dynatrace.com. Worth confirming with the product team before messaging it to customers.

Source: https://docs.dynatrace.com/docs/ingest-from/amazon-web-services , https://docs.dynatrace.com/docs/ingest-from/amazon-web-services/aws-onboarding

## 2. Metric model — this is where the hard work lives

### Classic
- Prefix: `builtin:cloud.aws.<service>.<shortname>`
- Curated, **derived/precalculated** metrics, often already normalized to a rate or percentage
- Aggregations: `auto avg max min` (sometimes `sum count value`)
- Example (EC2, https://docs.dynatrace.com/.../cloudwatch-ec2/ec2-builtin):

  | Classic metric | Unit |
  | --- | --- |
  | `builtin:cloud.aws.ec2.cpu.usage` | Percent |
  | `builtin:cloud.aws.ec2.disk.readOps` | Per second |
  | `builtin:cloud.aws.ec2.disk.readRate` | kB/s |
  | `builtin:cloud.aws.ec2.disk.writeOps` | Per second |
  | `builtin:cloud.aws.ec2.disk.writeRate` | kB/s |
  | `builtin:cloud.aws.ec2.net.rx` | Byte/s |
  | `builtin:cloud.aws.ec2.net.tx` | Byte/s |

- Example (RDS, https://docs.dynatrace.com/.../aws-service-relational-database-service-rds-builtin): 14 metrics, `builtin:cloud.aws.rds.cpu.usage` (%), `.latency.read/write` (s), `.memory.freeable` (Byte), `.net.rx/tx` (Byte/s), `.ops.read/write` (per second), `.throughput.read/write` (Byte/s), `.connections`, `.free` (% free storage), `.restarts`.
- Example (Lambda, https://docs.dynatrace.com/.../lambda-builtin): `builtin:cloud.aws.lambda.concExecutions`, `.duration` (ms), `.errors`, `.errorsRate` (%), `.invocations`, `.provConcExecutions`, `.provConcInvocations`, `.provConcSpilloverInvocations`, `.throttlers`.

### New
- Prefix: **`cloud.aws.<service>.<CloudWatchMetricName>.By.<Dimensions>`** (no `builtin:` prefix; uses `.` separators like other `dt.*` / `cloud.*` metrics in Grail)
- Raw CloudWatch metric names preserved (PascalCase): `CPUUtilization`, `ConsumedReadCapacityUnits`, `4XXError`, `BurstCreditBalance`, `DiskReadBytes`, etc.
- Dimensions in the metric **key** (`.By.InstanceId`, `.By.TableName`, `.By.ApiName`, `.By.FileSystemId`) — and also attached as datapoint attributes (`aws.account.id`, `aws.region`, `aws.tag.<KeyName>`, etc.)
- Ingestion model: **Metric Collection Sets** (MCS):
  - *Recommended* — immutable Dynatrace-curated list per service
  - *Recommended + Custom* — recommended plus additional user-selected CloudWatch metrics
  - *Auto-Discovery* — auto-discovers all key metrics for a service
- Polling: "every 5 minutes, evaluating a 5-minute window with a 7-minute delay" (per docs)
- Source: https://docs.dynatrace.com/docs/ingest-from/amazon-web-services/aws-support-matrix-file , https://docs.dynatrace.com/docs/ingest-from/amazon-web-services/ingest-telemetry/aws-cloudwatch-metrics

### Mapping is NOT 1:1 — three categories

1. **Direct (unit-preserving)** — classic metric ≈ raw CloudWatch metric with same unit. Example:
   - Classic `builtin:cloud.aws.ec2.cpu.usage` (%) ≈ new `cloud.aws.ec2.CPUUtilization.By.InstanceId` (%). Straight rename.
2. **Unit-converting / derived** — classic is already a rate or percentage; new is the raw counter. Example:
   - Classic `builtin:cloud.aws.ec2.net.rx` (Byte/**second**) vs new `cloud.aws.ec2.NetworkIn.By.InstanceId` (Bytes over 5-min window). Converter must insert a `rate()` / divide-by-interval.
   - Classic `builtin:cloud.aws.rds.free` (% free storage) — CloudWatch only exposes `FreeStorageSpace` in bytes. Converter needs the instance's allocated storage to compute a percentage.
3. **No direct equivalent** — classic Dynatrace-computed rollups that don't come from CloudWatch. Example:
   - `builtin:cloud.aws.az.running|stopped|terminated` (count of EC2 instances per state, per AZ). New model: has to be reconstructed from Smartscape — `smartscapeNodes "AWS_EC2_INSTANCE" | summarize count=count(), by: {aws.availability_zone, status}`.
   - Classic `builtin:cloud.aws.lambda.errorsRate` (%) — new `Errors`/`Invocations` both exposed raw, so `timeseries ratio = sum(errors)/sum(invocations)` in DQL.

**Implication for the tool:** mapping table needs a per-metric entry with `category`, `new_metric_key`, and for categories 2/3 a **DQL expression template** rather than just a metric rename. Plan to hand-curate this starting with the top ~10 services (EC2, RDS, Lambda, ALB/NLB/ELB, EBS, AutoScaling, DynamoDB, S3, SQS/SNS, API Gateway).

## 3. Entity / topology model

### Classic entity types (examples, from `aws-all-services`)
- `EC2_INSTANCE` (InstanceId)
- `AUTO_SCALING_GROUP` (AutoScalingGroupName)
- `AWS_LAMBDA_FUNCTION` (FunctionName)
- `AWS_APPLICATION_LOAD_BALANCER` / `AWS_NETWORK_LOAD_BALANCER` / `ELASTIC_LOAD_BALANCER` (LoadBalancer / LoadBalancerName)
- `EBS_VOLUME` (VolumeId)
- `RELATIONAL_DATABASE_SERVICE` (DBInstanceIdentifier)

Referenced in classic DQL / metric selectors as `dt.entity.<type_lowercase>`, e.g. `dt.entity.ec2_instance`, `dt.entity.relational_database_service`.

### New — Smartscape on Grail
- "Smartscape node types for AWS follow the CloudFormation resource type notation, making all letters uppercase and substituting `::` with `_`." (source: `/ingest-telemetry/aws-topology`)
- Node type examples: `AWS_EC2_INSTANCE`, `AWS_EC2_VOLUME`, `AWS_RDS_DBINSTANCE`, `AWS_LAMBDA_FUNCTION`, `AWS_ELASTICLOADBALANCINGV2_LOADBALANCER`, `AWS_AUTOSCALING_AUTOSCALINGGROUP`, `AWS_S3_BUCKET`, `AWS_DYNAMODB_TABLE`, etc.
- Full set is documented in the **AWS Support Matrix** page (https://docs.dynatrace.com/docs/ingest-from/amazon-web-services/aws-support-matrix-file). I pulled the full list — ~100+ node types across all AWS service categories.
- Queried via DQL **smartscape commands** (https://docs.dynatrace.com/docs/platform/grail/dynatrace-query-language/commands/smartscape-commands):
  - `smartscapeNodes "AWS_EC2_INSTANCE" | filter tags[owner_team]=="team-acme"`
  - `smartscapeEdges "*" | summarize count=count(), by: {edgeType=type}`
  - `traverse is_attached_to, AWS_EC2_VOLUME, direction: backward`
- Resource identifiers on nodes: `aws.account.id`, `aws.region`, `aws.resource.id`, `aws.resource.name`, `aws.arn`, `aws.resource.type`, plus the full `aws.object` JSON config.

**Implication for the tool:**
- Classic entity IDs (`HOST-ABC123` / `EC2_INSTANCE-ABC123`) and new Smartscape node IDs are **not the same identifiers** — the docs don't assert compatibility and the path to the node is completely different.
- The tool can't mechanically translate a classic entity ID into a new Smartscape ID without a lookup against live data. For **asset conversion**, the most reliable translation is **symbolic**: rewrite `dt.entity.ec2_instance == "EC2_INSTANCE-ABC"` into `aws.resource.id == "i-..."` — but only if the asset referenced the resource by AWS ID in the first place. Otherwise we need a runtime resolver (hit the tenant API, list both classic entities and Smartscape nodes, build ID↔ARN map).
- Conversion strategy: **prefer query patterns over exact IDs** where possible — e.g. rewrite per-entity filters to tag/name/ARN filters on the new side.

## 4. DQL command landscape

From the DQL commands index (https://docs.dynatrace.com/docs/discover-dynatrace/references/dynatrace-query-language/commands):

- **Data source**: `data`, `describe`, `fetch`, `load`
- **Metric**: `timeseries`, `metrics`
- **Smartscape** (new): `smartscapeNodes`, `smartscapeEdges`, `traverse`
- **Filter/search/fields/parse/limit/sort**: standard
- **Structuring/aggregation**: `expand`, `fieldsFlatten`, `fieldsSummary`, `makeTimeseries`, `summarize`
- **Correlation/join**: `append`, `join`, `joinNested`, `lookup`

**`timeseries` signature** (source: `/commands/metric-commands`):
```
timeseries [col=] aggregation(metricKey [, filter:][, default:][, rollup:][, rate:][, scalar:]),
           ..., [by:], [filter:], [union:], [nonempty:], [interval:|bins:],
           [from:], [to:], [timeframe:], [shift:], [bucket:]
```

Examples (all new-style) quoted from docs:
- `timeseries usage=avg(dt.host.cpu.usage)`
- `timeseries min(dt.host.cpu.iowait, default: -1), by: dt.entity.host`
- `filter:in(dt.entity.host, 'HOST-1', 'HOST-2')`

**Classic metric selectors are a different syntax** (`builtin:…:splitBy("…"):avg`, sometimes used inside `timeseries` or the Metrics v2 API), not the dotted new-style. Our converter needs to parse both.

I did not find an official published DQL parser / AST grammar on docs.dynatrace.com. If we need one, options:
- Best-effort string/regex rewrite for the subset of DQL that dashboards/alerts actually use.
- Ask internally — the Grail team almost certainly has a Go/Rust/TS parser we could reuse.

## 5. Asset format — what the converter has to read & write

### Dashboards
- New Dashboards (Grail-native) — tiles run DQL. Download/upload as **JSON**. No public schema doc I could find; the Dashboards app UI exposes Download/Upload.
- Classic Dashboards — still exist as a distinct system with their own JSON API (Config API `/api/config/v1/dashboards`, tile type enumerated there with a `metric` field holding classic metric selectors). Terraform exposes both as different resources (historically `dynatrace_dashboard` / `dynatrace_json_dashboard` for classic; a `dynatrace_document` resource for new Grail dashboards — I couldn't confirm the exact resource name from the registry page because WebFetch returned only the header).
- CaC tools: **Monaco** and **Terraform** both claim to support dashboards, notebooks, and anomaly detection (source: `/docs/manage/configuration-as-code`). I could not retrieve the resource list from the Terraform Registry page — that needs verification via a direct pull of the provider repo's `/resources` directory on GitHub.

### Alerts
- **Classic metric events** — still documented (`/docs/dynatrace-intelligence/anomaly-detection/metric-events`). Target of migration. I could not pull the exact Settings 2.0 schema ID from this page; likely `builtin:anomaly-detection.metric-events` or `builtin:metric-events` — **verify via `GET /platform/classic/environment-api/v2/settings/schemas`**. Fields include a metric selector + entity scope + threshold.
- **Davis anomaly detectors (new, Grail/DQL native)** — schema verified from `/docs/dynatrace-intelligence/anomaly-detection/set-up-anomaly-detectors-via-api`:
  - API: `POST https://{env}.apps.dynatrace.com/platform/classic/environment-api/v2/settings/objects`
  - `schemaId: "builtin:davis.anomaly-detectors"`
  - Scope: `"environment"`
  - `value`: `{ enabled, title, description, source, executionSettings{actor, queryOffset}, analyzer{name, input[]}, eventTemplate{properties[]} }`
  - `analyzer.input[].value` holds the DQL query, e.g. `"timeseries avg(dt.host.disk.free), by:{dt.entity.host, dt.entity.disk}"`
  - Condition operators: `ABOVE | BELOW | OUTSIDE`, with `threshold`, `violatingSamples`, `slidingWindow`
- Docs explicitly position anomaly detectors as the successor: "supports DQL queries in addition to Grail records" and "alerting on data such as logs, spans, and business events."

### SLOs, SRGs — deferred until after dashboards/alerts, per project scope.

## 6. Official migration tooling — not found

I did not find:
- An official Dynatrace-published migration tool for converting classic AWS dashboards/alerts to the new model.
- An official classic → new metric mapping table (neither on docs nor in the Dynatrace Hub pages I reached).
- A DQL rewrite helper.

That's the gap this project is filling.

What does exist:
- Monaco + Terraform exports for both classic and new resource types (so the I/O layer for reading/writing assets can piggy-back on those).
- The AWS Support Matrix page (section 2 above) — de facto source of truth for what the new integration emits; a good input for mapping-table generation.

## 7. Open questions / verification to-dos

1. GA vs Preview status of the new AWS integration — confirm official word internally.
2. Exact Settings 2.0 schema ID for classic metric events (likely `builtin:anomaly-detection.metric-events`, unverified).
3. Whether Dynatrace already has an internal prototype for this migration — worth asking the Clouds app team.
4. Whether the Smartscape node ID format is stable enough to persist in converted assets, or whether we should **always** rewrite to symbolic filters (`aws.resource.id == "i-..."`).
5. Does the new AWS integration ever emit `builtin:*` metrics (dual-write during transition)? If yes, the conversion isn't strictly mandatory for data availability — just for "moving off the old model."
6. Scraping the aws-support-matrix-file page into a structured JSON — is there a machine-readable source? We may need to parse the HTML.
