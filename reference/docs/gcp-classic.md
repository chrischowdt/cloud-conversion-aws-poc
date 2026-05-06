# Classic GCP Connections in Dynatrace

> **Scope**: This document covers the **classic** (legacy) Google Cloud Platform monitoring integration only.
> It does **NOT** cover the new GCP cloud platform monitoring (`gcp-onboarding`). The new connection creates Smartscape on Grail entities (prefixed `GCP_`) and uses `dt.da.source = "gcp-cloud-monitoring"` — see [gcp-new.md](gcp-new.md) for that.

## Overview

Classic GCP monitoring in Dynatrace is fundamentally different from classic AWS and Azure integrations. Instead of using an ActiveGate-based polling architecture configured through the Dynatrace UI (like AWS's `builtin:cloud.aws` or Azure's Configuration API), the classic GCP integration is deployed as a **self-hosted workload running on a Google Kubernetes Engine (GKE) cluster** within the customer's GCP environment.

This GKE-based integration (known as the "Dynatrace Google Cloud integration" or the "GCP Extension v1.0") polls the **Google Cloud Operations API** (formerly Stackdriver) for metrics and forwards them to the Dynatrace tenant via the Dynatrace Metrics API v2. There is **no dedicated settings schema** for classic GCP connections (unlike AWS's `builtin:cloud.aws` or Azure's Configuration API).

The integration creates **custom device entities** (`CUSTOM_DEVICE`) with `cloud:gcp:*` sub-types for all monitored GCP resources, organized under a **GCP project** entity (`cloud:gcp:project`).

---

## 1. Architecture & Deployment

### 1.1 How It Works

| Property | Value |
|---|---|
| **Data Source** | GKE-based workload polls Google Cloud Operations API (Cloud Monitoring) |
| **Deployment** | Kubernetes deployment on a GKE Autopilot cluster (recommended) or existing GKE cluster |
| **Configuration** | Deployed via Helm chart / Kubernetes manifests; dashboard YAML files for per-service configuration |
| **Settings Schema** | **None** — There is no `builtin:cloud.gcp` settings schema. Configuration is entirely within the GKE deployment. |
| **ActiveGate** | Not required (the integration runs inside GKE, not on an ActiveGate) |
| **Metric Ingestion** | Metrics API v2 (push model — the integration pushes metrics to Dynatrace) |
| **Entity Creation** | Custom device entities created via Topology & Custom Device API |
| **Log Ingestion** | Google Cloud Pub/Sub → Cloud Function or GKE-based log forwarder → Dynatrace Log API |
| **DDU Consumption** | 0.001 DDU per data point (metric × dimension) |
| **`dt.source`** | `"com.dynatrace.gcp"` (on some metrics; see Section 3 for disambiguation) |
| **`metadata.origin`** | `"extension"` |

### 1.2 Deployment Options

1. **New GKE Autopilot Cluster** (Recommended): Deploy the integration on a dedicated GKE Autopilot cluster
2. **Existing GKE Cluster**: Deploy on an existing GKE cluster in the customer's environment
3. **Metrics Only on GKE**: Deploy only metric collection (no logs) on a GKE cluster
4. **Logs Only on GKE**: Deploy only log forwarding on a GKE cluster
5. **Google Cloud Function**: Deploy metric collection as a Cloud Function (legacy approach, pre-v1.0)

### 1.3 Multi-Project Monitoring

After deploying the integration, it can monitor **multiple GCP projects** from a single installation. The integration uses a service account with cross-project permissions to query metrics from all configured projects.

---

## 2. Entity Model

### 2.1 Entity Types

All classic GCP entities are `CUSTOM_DEVICE` entities with `cloud:gcp:*` sub-types. They are queried using backtick syntax in DQL:

```dql
fetch `dt.entity.cloud:gcp:cloudsql_database`
| fieldsAdd entity.name, entity.type, id, project_id, database_id, region
```

The parent entity for all GCP resources is `cloud:gcp:project`, which represents a Google Cloud project.

### 2.2 Entity Hierarchy

```
cloud:gcp:project (GCP Project — CUSTOM_DEVICE)
├── cloud:gcp:gce_instance (Compute Engine VM)
├── cloud:gcp:cloudsql_database (Cloud SQL)
├── cloud:gcp:cloud_function (Cloud Functions)
├── cloud:gcp:cloud_run_revision (Cloud Run)
├── cloud:gcp:gcs_bucket (Cloud Storage)
├── cloud:gcp:k8s_cluster (GKE Cluster)
│   ├── cloud:gcp:k8s_node (GKE Node)
│   ├── cloud:gcp:k8s_pod (GKE Pod)
│   └── cloud:gcp:k8s_container (GKE Container)
├── cloud:gcp:pubsub_topic (Pub/Sub Topic)
├── cloud:gcp:pubsub_subscription (Pub/Sub Subscription)
├── cloud:gcp:pubsub_snapshot (Pub/Sub Snapshot)
├── cloud:gcp:spanner_instance (Cloud Spanner)
├── cloud:gcp:redis_instance (Memorystore Redis)
├── cloud:gcp:https_lb (HTTP/S Load Balancer)
├── cloud:gcp:internal_http_lb_rule (Internal HTTP LB)
├── cloud:gcp:internal_network_lb_rule (Internal Network LB)
├── cloud:gcp:network_lb_rule (Network Load Balancer)
├── cloud:gcp:tcp_ssl_proxy_rule (TCP/SSL Proxy)
├── cloud:gcp:nat_gateway (Cloud NAT Gateway)
├── cloud:gcp:vpn_gateway (Cloud VPN Gateway)
├── cloud:gcp:interconnect (Cloud Interconnect)
├── cloud:gcp:interconnect_attachment (Interconnect Attachment)
├── cloud:gcp:gce_router (Cloud Router)
├── cloud:gcp:autoscaler (Autoscaler)
├── cloud:gcp:instance_group (Instance Group)
├── cloud:gcp:gae_app (App Engine Application)
├── cloud:gcp:cloud_tasks_queue (Cloud Tasks Queue)
├── cloud:gcp:cloud_composer_environment (Cloud Composer)
├── cloud:gcp:cloud_dataproc_cluster (Dataproc Cluster)
├── cloud:gcp:filestore_instance (Filestore Instance)
├── cloud:gcp:firestore_database (Firestore Database)
├── cloud:gcp:bigtable_cluster (Bigtable Cluster)
├── cloud:gcp:bigtable_table (Bigtable Table)
├── cloud:gcp:bigquery_biengine_model (BigQuery BI Engine Model)
├── cloud:gcp:alloydb_database (AlloyDB Database)
├── cloud:gcp:alloydb_instance (AlloyDB Instance)
├── cloud:gcp:apigee_proxy (Apigee Proxy)
├── cloud:gcp:apigee_target (Apigee Target)
├── cloud:gcp:tpu_worker (Cloud TPU Worker)
├── cloud:gcp:uptime_url (Uptime Check URL)
├── cloud:gcp:vpc_access_connector (VPC Access Connector)
├── cloud:gcp:network_security_policy (Network Security Policy)
├── cloud:gcp:microsoft_ad_domain (Managed Microsoft AD)
├── cloud:gcp:netapp_volumes_replication (NetApp Replication)
├── cloud:gcp:netapp_volumes_storage_pool (NetApp Storage Pool)
├── cloud:gcp:netapp_volumes_volume (NetApp Volume)
├── cloud:gcp:storage_transfer_job (Storage Transfer Job)
├── cloud:gcp:transfer_service_agent (Storage Transfer Agent)
├── cloud:gcp:recaptcha_enterprise_key (reCAPTCHA Key)
├── cloud:gcp:pubsublite_topic_partition (Pub/Sub Lite Topic)
└── cloud:gcp:pubsublite_subscription_partition (Pub/Sub Lite Subscription)
```

> **Key Difference from AWS/Azure**: Unlike AWS (which has dedicated entity types like `EC2_INSTANCE`, `AWS_LAMBDA_FUNCTION` for built-in services) and Azure (which has `AZURE_VM`, `AZURE_SQL_SERVER`, etc.), GCP has **no dedicated classic entity types**. All GCP entities are `CUSTOM_DEVICE` entities with `cloud:gcp:*` sub-types. Even the topology entities like `GCP_ZONE` and `GOOGLE_COMPUTE_ENGINE` are separate legacy entity types created by OneAgent host detection, not by the GCP cloud integration.

### 2.3 Relationship: `child_of` → `cloud:gcp:project`

All classic GCP resource entities have a `child_of` relationship pointing to their parent `cloud:gcp:project` entity. This is the primary organizational relationship.

### 2.4 Classic Topology Entity Types (OneAgent/Host Detection)

In addition to the `cloud:gcp:*` custom device entities created by the GCP integration, Dynatrace also creates a small set of dedicated entity types via OneAgent host detection on GCE VMs:

| Entity Type | ID Prefix | Source | Purpose |
|---|---|---|---|
| `GOOGLE_COMPUTE_ENGINE` | `GOOGLE_COMPUTE_ENGINE-` | OneAgent on GCE VM | Represents the GCE VM from the OneAgent perspective |
| `GCP_ZONE` | `GCP_ZONE-` | OneAgent on GCE VM | GCP zone topology (contains GCE instances and hosts) |

These are **not** created by the GCP cloud integration but by OneAgent running on GCE VMs. The `GOOGLE_COMPUTE_ENGINE` entity has a `runs` → `host` relationship and a `belongs_to` → `GCP_ZONE` relationship.

### 2.5 Common Entity Attributes

All `cloud:gcp:*` entities share these common attributes:

| Attribute | Description | Example |
|---|---|---|
| `project_id` | GCP project ID | `my-gcp-project-id` |
| `entity.name` | Resource name (same as `gcp.resource.name`) | `my-sql-instance:my-database` |
| `entity.type` | Sub-type identifier | `cloud:gcp:cloudsql_database` |
| `id` | Dynatrace entity ID | `CUSTOM_DEVICE-169DFC0F68E6E17E` |
| `managementZones` | Management zones | `Cloud: Google` |

Service-specific attributes include `location`/`region`/`zone`, `cluster_name`, `database_id`, `instance_id`, `function_name`, etc.

---

## 3. Metric Key Format

### 3.1 Pattern

All classic GCP metrics follow the Google Cloud Monitoring API naming convention:

```
cloud.gcp.<google_api_service>.<metric_path>
```

- `<google_api_service>` — The Google Cloud API service domain, with dots replaced by underscores (e.g., `cloudsql_googleapis_com`, `compute_googleapis_com`, `pubsub_googleapis_com`)
- `<metric_path>` — The metric path from the Google Monitoring API, with slashes replaced by dots (e.g., `database.cpu.utilization`, `instance.cpu.usage_time`)

### 3.2 Examples by Service

| GCP Service | Metric Key Prefix | Example Metric Keys |
|---|---|---|
| **Cloud SQL** | `cloud.gcp.cloudsql_googleapis_com.` | `database.cpu.utilization`, `database.memory.usage`, `database.disk.bytes_used`, `database.network.sent_bytes_count`, `database.up`, `database.uptime.count` |
| **Compute Engine** | `cloud.gcp.compute_googleapis_com.` | `instance.cpu.utilization`, `instance.cpu.usage_time`, `instance.disk.read_bytes_count`, `instance.network.received_bytes_count`, `instance.uptime` |
| **Cloud Functions** | `cloud.gcp.cloudfunctions_googleapis_com.` | `function.execution_count`, `function.execution_times`, `function.active_instances`, `function.network_egress`, `function.user_memory_bytes` |
| **Pub/Sub** | `cloud.gcp.pubsub_googleapis_com.` | `subscription.num_undelivered_messages`, `subscription.oldest_unacked_message_age`, `subscription.ack_message_count`, `topic.send_message_operation_count`, `topic.message_sizes` |
| **Cloud Storage** | `cloud.gcp.storage_googleapis_com.` | `storage.total_bytes`, `storage.object_count`, `storage.total_byte_seconds` |
| **Cloud NAT** | `cloud.gcp.compute_googleapis_com.` | `nat.allocated_ports`, `nat.open_connections`, `nat.received_bytes_count`, `nat.sent_bytes_count`, `nat.new_connections_count` |
| **VPC Networking** | `cloud.gcp.networking_googleapis_com.` | `vm_flow.egress_bytes_count`, `vm_flow.ingress_bytes_count`, `vm_flow.rtt` |

### 3.3 Key Differences from AWS/Azure Metric Patterns

| Feature | AWS Classic | Azure Classic | GCP Classic |
|---|---|---|---|
| **Built-in prefix** | `dt.cloud.aws.<service>.*` | `dt.cloud.azure.<service>.*` | **None** — GCP has no `dt.cloud.gcp.*` prefix |
| **Non-built-in prefix** | `cloud.aws.<service>.*` | `cloud.azure.microsoft_<provider>.*` | `cloud.gcp.<api_service>.*` |
| **Naming source** | AWS CloudWatch metric names | Azure Monitor resource types | Google Cloud Monitoring API paths |
| **Case convention** | Mixed — PascalCase or snake_case | Lowercase or PascalCase | snake_case (dot-separated path segments) |
| **Dimension in key** | Sometimes (e.g., `By.FunctionName`) | No | No — dimensions are separate |

> **Important**: Unlike AWS and Azure, GCP has **no "built-in" vs "non-built-in" distinction**. There is only one integration approach for classic GCP, and all metrics use the `cloud.gcp.*` prefix. There are no `dt.cloud.gcp.*` metrics (which would indicate a Dynatrace-native curated set).

---

## 4. Metric Dimensions

### 4.1 Dimensions on Classic GCP Metrics

| Dimension | Description | Example |
|---|---|---|
| `project_id` | GCP project ID | `my-gcp-project` |
| `gcp.project.id` | Same as above (alternative key) | `my-gcp-project` |
| `gcp.resource.type` | Google Cloud monitored resource type | `cloudsql_database`, `gce_instance`, `pubsub_subscription` |
| `dt.entity.cloud:gcp:project` | Entity ID of the parent GCP project | `CUSTOM_DEVICE-05E36644D4B7665F` |
| `dt.source` | Integration source identifier | `com.dynatrace.gcp` (or null) |
| `metadata.origin` | Origin of the metric | `extension` (or null) |
| `dt.source_entity.type` | Source entity sub-type | `cloud:gcp:cloudsql_database` |

### 4.2 Source Attribution Split

In the gmg environment, classic GCP metrics show two attribution patterns:

| Pattern | `dt.source` | `metadata.origin` | Description |
|---|---|---|---|
| **Extension with source** | `com.dynatrace.gcp` | `extension` | GCP integration v1.0 with full attribution |
| **Extension without source** | null | `extension` | GCP integration v1.0 metrics forwarded to Grail without `dt.source` attribution |
| **Unattributed** | null | null | Historical/older metrics (possibly from Cloud Function deployment or metric forwarding from Cassandra) |

> **Note**: The split between attributed and unattributed metrics is a side effect of how the GCP integration evolved and how metrics are forwarded between classic (Cassandra) and Grail storage. For disambiguating classic from new GCP connection, see Section 6.

---

## 5. Supported Services

### 5.1 Services with Entities and Metrics

From the Dynatrace documentation and the semantic dictionary, these services create entities:

| GCP Service | Entity Type (`cloud:gcp:*`) | Has Predefined Alerts | Has Predefined Dashboards |
|---|---|---|---|
| Compute Engine | `gce_instance`, `autoscaler`, `instance_group`, `tpu_worker` | Yes | Yes |
| Cloud SQL | `cloudsql_database` | Yes | Yes |
| Cloud Functions | `cloud_function` | Yes | Yes |
| Cloud Run | `cloud_run_revision` | Yes | Yes |
| Cloud Storage | `gcs_bucket` | Yes | Yes |
| App Engine | `gae_app` | Yes | Yes |
| Kubernetes Engine | `k8s_cluster`, `k8s_container`, `k8s_node`, `k8s_pod` | Yes | Yes |
| Pub/Sub | `pubsub_topic`, `pubsub_subscription`, `pubsub_snapshot` | Yes | Yes |
| Cloud Spanner | `spanner_instance` | Yes | Yes |
| Memorystore Redis | `redis_instance` | Yes | Yes |
| Load Balancing | `https_lb`, `internal_http_lb_rule`, `internal_network_lb_rule`, `network_lb_rule`, `tcp_ssl_proxy_rule` | Yes | Yes |
| Cloud NAT | `nat_gateway` | Yes | Yes |
| Hybrid Connectivity | `interconnect`, `interconnect_attachment`, `gce_router`, `vpn_gateway` | Yes | Yes |
| Cloud Tasks | `cloud_tasks_queue` | Yes | Yes |
| Cloud Composer | `cloud_composer_environment` | Yes | Yes |
| Dataproc | `cloud_dataproc_cluster` | Yes | Yes |
| Storage Transfer | `storage_transfer_job`, `transfer_service_agent` | Yes | Yes |
| Cloud Uptime | `uptime_url` | Yes | Yes |
| Network Security | `network_security_policy` | Yes | Yes |
| VPC Access | `vpc_access_connector` | Yes | Yes |

### 5.2 Services with Entities but No Predefined Alerts/Dashboards

| GCP Service | Entity Type (`cloud:gcp:*`) |
|---|---|
| AlloyDB | `alloydb_database`, `alloydb_instance` |
| Apigee | `apigee_proxy`, `apigee_target` |
| BigQuery (BI Engine) | `bigquery_biengine_model` |
| Bigtable | `bigtable_cluster`, `bigtable_table` |
| Filestore | `filestore_instance` |
| Firestore | `firestore_database` |
| NetApp Volumes | `netapp_volumes_replication`, `netapp_volumes_storage_pool`, `netapp_volumes_volume` |
| Managed Microsoft AD | `microsoft_ad_domain` |
| Pub/Sub Lite | `pubsublite_topic_partition`, `pubsublite_subscription_partition` |
| reCAPTCHA Enterprise | `recaptcha_enterprise_key` |

### 5.3 Services with Metrics Only (No Entities)

Some services ingest metrics but do not create dedicated entities. These metrics exist only at the numeric level without entity binding. Examples include:
- Google Cloud AI Platform (`cloudml_job`, `cloudml_model_version`)
- Google Cloud APIs
- Google Cloud DNS
- Google Cloud Dataflow (metrics only in classic; entity in new)
- Google Cloud IoT Core (deprecated)

---

## 6. Disambiguating Classic vs New GCP Connection

### `dt.da.source` Values

> **Critical**: Classic GCP connections **never** set `dt.da.source` to `gcp-cloud-monitoring`. Any metric with `dt.da.source = "gcp-cloud-monitoring"` originates from the **new GCP connection**.

| `dt.da.source` Value | Origin |
|---|---|
| `gcp-cloud-monitoring` | **New** GCP connection (metric polling via Data Acquisition) |
| null | **Classic** GCP connection |

### Metric Key Pattern Difference

The new GCP connection embeds the **GCP resource type** in the metric key, creating a different pattern:

| Pattern | Connection |
|---|---|
| `cloud.gcp.<google_api>.<metric_path>` | **Classic** (e.g., `cloud.gcp.compute_googleapis_com.instance.cpu.utilization`) |
| `cloud.gcp.<resource_type>.<google_api>.<metric_path>` | **New** (e.g., `cloud.gcp.gce_instance.compute_googleapis_com.instance.cpu.utilization`) |

### How to Tell Classic from New

| Rule | Connection Type |
|---|---|
| `dt.da.source == "gcp-cloud-monitoring"` | **New** GCP connection |
| `dt.smartscape_source.type` is present (e.g., `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE`) — on metrics | **New** GCP connection |
| `smartscapeNodes GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE` returns entities | **New** GCP connection (Smartscape on Grail) |
| `dt.da.source` is null AND metric key matches `cloud.gcp.<api>.<path>` (no resource type prefix) | **Classic** GCP connection |
| `dt.source == "com.dynatrace.gcp"` | **Classic** GCP connection (GKE extension) |
| `metadata.origin == "extension"` AND `dt.da.source` is null | **Classic** GCP connection |
| `fetch \`dt.entity.cloud:gcp:gce_instance\`` returns entities | **Classic** GCP connection (CUSTOM_DEVICE) |

### Example: Same Metric, Different Key Formats

| Classic | New |
|---|---|
| `cloud.gcp.compute_googleapis_com.instance.cpu.utilization` | `cloud.gcp.gce_instance.compute_googleapis_com.instance.cpu.utilization` |
| `cloud.gcp.compute_googleapis_com.instance.disk.read_bytes_count` | `cloud.gcp.gce_instance.compute_googleapis_com.instance.disk.read_bytes_count` |
| `cloud.gcp.storage_googleapis_com.storage.total_bytes` | `cloud.gcp.gcs_bucket.storage_googleapis_com.storage.total_bytes` |
| `cloud.gcp.pubsub_googleapis_com.subscription.num_undelivered_messages` | (same key — some classic metrics share the key pattern) |

> **Warning — Parallel Ingestion**: Unlike AWS and Azure, the classic and new GCP connections can produce **different metric keys** for the same underlying Google Cloud metric because of the resource type prefix in the new connection. However, some metrics may still overlap. Running both connections in parallel is **not recommended** — it results in duplicate metric ingestion and double cost.

---

## 7. DQL Query Patterns for Classic GCP Data

### 7.1 Find All Classic GCP Project Entities

```dql
fetch `dt.entity.cloud:gcp:project`
| fieldsAdd entity.name, entity.type, id, managementZones
```

### 7.2 Find Classic GCP Entities by Type

```dql
// Cloud SQL databases
fetch `dt.entity.cloud:gcp:cloudsql_database`
| fieldsAdd entity.name, entity.type, id, project_id, database_id, region

// Compute Engine instances
fetch `dt.entity.cloud:gcp:gce_instance`
| fieldsAdd entity.name, entity.type, id, project_id, zone, instance_id

// Pub/Sub subscriptions
fetch `dt.entity.cloud:gcp:pubsub_subscription`
| fieldsAdd entity.name, entity.type, id, project_id, subscription_id, topic_id

// Cloud Functions
fetch `dt.entity.cloud:gcp:cloud_function`
| fieldsAdd entity.name, entity.type, id, project_id, function_name, region
```

### 7.3 List All Classic GCP Metric Keys

```dql
fetch metric.series
| fields metric.key, gcp.project.id, project_id, `dt.entity.cloud:gcp:project`, gcp.resource.type, metadata.origin, dt.da.source, dt.source
| filter contains(metric.key, "cloud.gcp")
| filterOut startsWith(metric.key, "dac.gcp_")
| filterOut startsWith(metric.key, "dt.sfm.da.gcp")
| filterOut dt.da.source == "gcp-cloud-monitoring"
| summarize count(), by:{metric.key, gcp.resource.type, dt.source, metadata.origin}
| sort metric.key asc
```

### 7.4 Find Classic GCP Metrics for a Specific Service

```dql
// Cloud SQL metrics
fetch metric.series
| fields metric.key, project_id, gcp.resource.type
| filter startsWith(metric.key, "cloud.gcp.cloudsql_googleapis_com")
| filter dt.da.source != "gcp-cloud-monitoring" OR isNull(dt.da.source)
| summarize count(), by:{metric.key, project_id}
| sort metric.key asc
```

### 7.5 Find GCE Hosts (OneAgent-Discovered)

```dql
// GCE instances discovered by OneAgent
fetch dt.entity.google_compute_engine
| fieldsAdd entity.name, entity.type, id, belongs_to, runs

// GCP Zones
fetch dt.entity.gcp_zone
| fieldsAdd entity.name, entity.type, id, contains
```

### 7.6 Comprehensive Classic GCP Metric Analysis

```dql
fetch metric.series
| fields metric.key, gcp.project.id, project_id, `dt.entity.cloud:gcp:project`, gcp.resource.type, metadata.origin, dt.da.source, dt.source_entity, dt.system.monitoring_source, dt.entity.custom_device, dt.source_entity.type, dt.source, dt.metrics.source
| filter contains(metric.key, "cloud.gcp")
| filterOut startsWith(metric.key, "dac.gcp_")
| filterOut startsWith(metric.key, "dt.sfm.da.gcp")
| summarize count(), by:{metric.key, gcp.project.id, project_id, `dt.entity.cloud:gcp:project`, gcp.resource.type, metadata.origin, dt.da.source, dt.source}
```

---

## 8. Migration Relevance

When assisting with cloud migration, the app needs to:

1. **Detect which classic GCP connection is active** — query `CUSTOM_DEVICE` entities with `cloud:gcp:*` sub-types and identify metric sources via `dt.source_entity.type`.
2. **Map entities to the correct metric patterns** — all classic GCP entities are `CUSTOM_DEVICE` with `cloud:gcp:*` sub-types and use the `cloud.gcp.*` metric prefix.
3. **Detect parallel classic + new connection ingestion** — when both classic (GKE-based) and new GCP connections are active for the same project, flag the overlap and quantify duplicate metric series.
4. **Account for GKE deployment** — unlike AWS and Azure, the classic GCP integration has no Settings 2.0 schema and no legacy Configuration API. Detection must rely entirely on entity and metric queries.
5. **Flag log forwarding configuration (future scope)** — classic GCP log ingest is forwarded via Google Cloud Pub/Sub (typically through a Cloud Function or GKE-based log forwarder) at the project/connection level, not per service. Log migration is out of scope for the initial implementation but should be surfaced as a deferred migration task per GCP project.

---

## 9. Key Differences from AWS and Azure Classic

| Feature | AWS Classic | Azure Classic | GCP Classic |
|---|---|---|---|
| **Configuration** | Settings 2.0 (`builtin:cloud.aws`) + Configuration API | Configuration API (`/api/config/v1/azure/credentials`) | **No settings schema** — deployed as GKE workload |
| **Deployment** | ActiveGate polls CloudWatch | ActiveGate polls Azure Monitor | GKE workload polls Google Cloud Operations API |
| **Built-in services** | Yes — dedicated entity types (e.g., `EC2_INSTANCE`) | Yes — dedicated entity types (e.g., `AZURE_VM`) | **No** — all entities are `CUSTOM_DEVICE` with `cloud:gcp:*` sub-types |
| **Built-in metric prefix** | `dt.cloud.aws.*` | `dt.cloud.azure.*` | **None** — no `dt.cloud.gcp.*` prefix exists |
| **Non-built-in metric prefix** | `cloud.aws.*` | `cloud.azure.*` | `cloud.gcp.*` |
| **Entity model** | Dedicated + `CUSTOM_DEVICE` (cloud:aws:*) | Dedicated + `CUSTOM_DEVICE` (cloud:azure:*) | **Only** `CUSTOM_DEVICE` (cloud:gcp:*) |
| **Metric Streams equivalent** | AWS CloudWatch Metric Streams | N/A | N/A — no push-based variant exists |
| **Predefined dashboards** | Yes (for some services) | Yes (for some services) | Yes (installed during GKE deployment) |
