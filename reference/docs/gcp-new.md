# New GCP Connection in Dynatrace

> **Scope**: This document covers the **new** Google Cloud Platform monitoring connection (cloud-native Data Acquisition pipeline).
> It does **NOT** cover the classic GKE-based integration. Classic GCP creates `CUSTOM_DEVICE` entities with `cloud:gcp:*` sub-types and uses `dt.source = "com.dynatrace.gcp"` — see [gcp-classic.md](gcp-classic.md) for that.

## Overview

The new GCP connection is part of Dynatrace's cloud-native Data Acquisition (DA) pipeline, replacing the self-hosted GKE-based classic integration with a fully managed, in-product connection. It uses the settings schema `builtin:hyperscaler-authentication.connections.gcp` and creates **Smartscape on Grail** entities with `GCP_*` prefixes.

Like the new AWS and Azure connections, this connection is managed entirely from the Dynatrace UI (or via Terraform) — no external deployment, no ActiveGate, no GKE cluster required.

> **Status**: This connection is currently in **Preview** (as of 2025). Not all services have "metrics in context" (entity-linked metrics) yet.

---

## 1. Architecture & Configuration

### 1.1 How It Works

| Property | Value |
|---|---|
| **Pipeline** | Cloud-native Data Acquisition (DA) |
| **Settings Schema** | `builtin:hyperscaler-authentication.connections.gcp` |
| **Authentication** | Service Account Impersonation (recommended) or Service Account Key |
| **Consumer** | `SVC:com.dynatrace.da` (DA service) |
| **`dt.da.source`** | `"gcp-cloud-monitoring"` |
| **Entity Type** | Smartscape on Grail entities (e.g., `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE`) |
| **Metric Ingestion** | DA pipeline polls Google Cloud Monitoring API |
| **Entity Discovery** | DA pipeline queries Google Cloud Asset Inventory for resource topology |
| **ActiveGate** | Not required |
| **DDU Consumption** | Per metric data point |

### 1.2 Authentication: Service Account Impersonation

The recommended authentication method is **Service Account Impersonation**:

1. **Dynatrace Service Account** (managed by Dynatrace): Acts as the identity principal
2. **Customer's GCP Service Account** (in customer's GCP project): Configured with the `Service Account Token Creator` role, allowing the Dynatrace account to impersonate it
3. **Monitoring Permissions**: The customer service account needs `Monitoring Viewer` and `Cloud Asset Viewer` roles on monitored projects

This avoids exporting service account keys, which is more secure. The alternative (direct service account key JSON) is supported but not recommended.

### 1.3 Connection Settings

```
Schema: builtin:hyperscaler-authentication.connections.gcp
```

| Setting | Description | Example |
|---|---|---|
| `name` | Connection name | `gcp-production` |
| `type` | Auth type | `serviceAccountImpersonation` or `serviceAccountKey` |
| `impersonatedServiceAccountEmail` | GCP SA to impersonate | `dynatrace-mon@my-project.iam.gserviceaccount.com` |
| `dynatraceServiceAccountEmail` | Dynatrace-managed SA | (auto-generated) |
| `consumer` | DA consumer service | `SVC:com.dynatrace.da` |

### 1.4 Terraform Configuration

New GCP connections can be created via the Dynatrace Terraform provider:

```hcl
resource "dynatrace_hyperscaler_gcp_connection" "example" {
  name           = "gcp-production"
  project_id     = "my-gcp-project"
  auth_type      = "service_account_impersonation"
  service_account_email = "dynatrace-mon@my-project.iam.gserviceaccount.com"
}
```

### 1.5 DQL: Query Connection Settings

```dql
fetch dt.settings
| filter schema == "builtin:hyperscaler-authentication.connections.gcp"
| fieldsAdd value, key, summary
```

---

## 2. Entity Model: Smartscape on Grail

### 2.1 Entity Type Pattern

New GCP Smartscape entities derive their type from **Google Cloud Asset Inventory asset types**, NOT from Cloud Monitoring monitored resource types. The pattern is:

```
GCP_<CLOUD_ASSET_INVENTORY_SERVICE>_<ASSET_RESOURCE_TYPE>
```

Where:
- `<CLOUD_ASSET_INVENTORY_SERVICE>` is the Cloud Asset Inventory service domain, uppercased, with dots replaced by underscores (e.g., `COMPUTE_GOOGLEAPIS_COM`)
- `<ASSET_RESOURCE_TYPE>` is the Cloud Asset Inventory resource type, uppercased (e.g., `INSTANCE`)

Examples (asset type → Smartscape entity type):
- `compute.googleapis.com/Instance` → `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE`
- `storage.googleapis.com/Bucket` → `GCP_STORAGE_GOOGLEAPIS_COM_BUCKET`
- `sqladmin.googleapis.com/Instance` → `GCP_SQLADMIN_GOOGLEAPIS_COM_INSTANCE`
- `container.googleapis.com/Cluster` → `GCP_CONTAINER_GOOGLEAPIS_COM_CLUSTER`
- `k8s.io/Pod` → `GCP_K8S_IO_POD`

> **Important — Asset Types ≠ Monitored Resource Types**: The Cloud Asset Inventory asset type (used for Smartscape entity naming) differs from the Cloud Monitoring "monitored resource type" (used in metric keys). For example, Cloud SQL uses asset type `sqladmin.googleapis.com/Instance` (entity: `GCP_SQLADMIN_GOOGLEAPIS_COM_INSTANCE`) but its monitoring resource type is `cloudsql_database` (metric key: `cloud.gcp.cloudsql_database.cloudsql_googleapis_com.*`).

To discover all GCP Smartscape entity types in an environment:

```dql
smartscapeNodes "*"
| filter startsWith(type, "GCP_")
| summarize cnt = count(), by: { type }
| sort cnt desc
```

### 2.2 Known Smartscape Entity Types (Verified)

The following entity types have been confirmed present in real Dynatrace environments via `smartscapeNodes` queries.

#### Compute & Infrastructure

| Smartscape Entity Type | GCP Service | Cloud Asset Inventory Asset Type |
|---|---|---|
| `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE` | Compute Engine (VM) | `compute.googleapis.com/Instance` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_DISK` | Compute Engine (Disk) | `compute.googleapis.com/Disk` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_NETWORK` | VPC Network | `compute.googleapis.com/Network` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_SUBNETWORK` | VPC Subnetwork | `compute.googleapis.com/Subnetwork` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_FIREWALL` | VPC Firewall Rule | `compute.googleapis.com/Firewall` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_ROUTE` | VPC Route | `compute.googleapis.com/Route` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_ROUTER` | Cloud Router | `compute.googleapis.com/Router` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_ADDRESS` | IP Address | `compute.googleapis.com/Address` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_FORWARDINGRULE` | Forwarding Rule (LB) | `compute.googleapis.com/ForwardingRule` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_BACKENDSERVICE` | Backend Service (LB) | `compute.googleapis.com/BackendService` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_BACKENDBUCKET` | Backend Bucket (LB) | `compute.googleapis.com/BackendBucket` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_URLMAP` | URL Map (LB) | `compute.googleapis.com/UrlMap` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_TARGETHTTPSPROXY` | HTTPS Proxy (LB) | `compute.googleapis.com/TargetHttpsProxy` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_TARGETHTTPPROXY` | HTTP Proxy (LB) | `compute.googleapis.com/TargetHttpProxy` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_SSLCERTIFICATE` | SSL Certificate | `compute.googleapis.com/SslCertificate` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_SECURITYPOLICY` | Cloud Armor Policy | `compute.googleapis.com/SecurityPolicy` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_NETWORKENDPOINTGROUP` | Network Endpoint Group | `compute.googleapis.com/NetworkEndpointGroup` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_HEALTHCHECK` | Health Check | `compute.googleapis.com/HealthCheck` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCETEMPLATE` | Instance Template | `compute.googleapis.com/InstanceTemplate` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCESETTINGS` | Instance Settings | `compute.googleapis.com/InstanceSettings` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_RESOURCEPOLICY` | Resource Policy | `compute.googleapis.com/ResourcePolicy` |
| `GCP_COMPUTE_GOOGLEAPIS_COM_PROJECT` | Compute Project | `compute.googleapis.com/Project` |

#### Serverless & App Platforms

| Smartscape Entity Type | GCP Service | Cloud Asset Inventory Asset Type |
|---|---|---|
| `GCP_CLOUDFUNCTIONS_GOOGLEAPIS_COM_FUNCTION` | Cloud Functions (2nd Gen) | `cloudfunctions.googleapis.com/Function` |
| `GCP_CLOUDFUNCTIONS_GOOGLEAPIS_COM_CLOUDFUNCTION` | Cloud Functions (1st Gen) | `cloudfunctions.googleapis.com/CloudFunction` |
| `GCP_RUN_GOOGLEAPIS_COM_SERVICE` | Cloud Run (Service) | `run.googleapis.com/Service` |
| `GCP_RUN_GOOGLEAPIS_COM_REVISION` | Cloud Run (Revision) | `run.googleapis.com/Revision` |
| `GCP_RUN_GOOGLEAPIS_COM_EXECUTION` | Cloud Run (Job Execution) | `run.googleapis.com/Execution` |
| `GCP_RUN_GOOGLEAPIS_COM_JOB` | Cloud Run (Job) | `run.googleapis.com/Job` |

#### Kubernetes Engine (GKE)

| Smartscape Entity Type | GCP Service | Cloud Asset Inventory Asset Type |
|---|---|---|
| `GCP_CONTAINER_GOOGLEAPIS_COM_CLUSTER` | GKE Cluster | `container.googleapis.com/Cluster` |
| `GCP_CONTAINER_GOOGLEAPIS_COM_NODEPOOL` | GKE Node Pool | `container.googleapis.com/NodePool` |
| `GCP_K8S_IO_POD` | K8s Pod | `k8s.io/Pod` |
| `GCP_K8S_IO_NODE` | K8s Node | `k8s.io/Node` |
| `GCP_K8S_IO_NAMESPACE` | K8s Namespace | `k8s.io/Namespace` |
| `GCP_K8S_IO_SERVICE` | K8s Service | `k8s.io/Service` |
| `GCP_K8S_IO_SERVICEACCOUNT` | K8s ServiceAccount | `k8s.io/ServiceAccount` |
| `GCP_K8S_IO_ENDPOINTS` | K8s Endpoints | `k8s.io/Endpoints` |
| `GCP_K8S_IO_RESOURCEQUOTA` | K8s ResourceQuota | `k8s.io/ResourceQuota` |
| `GCP_APPS_K8S_IO_DEPLOYMENT` | K8s Deployment | `apps.k8s.io/Deployment` |
| `GCP_APPS_K8S_IO_REPLICASET` | K8s ReplicaSet | `apps.k8s.io/ReplicaSet` |
| `GCP_APPS_K8S_IO_DAEMONSET` | K8s DaemonSet | `apps.k8s.io/DaemonSet` |
| `GCP_APPS_K8S_IO_STATEFULSET` | K8s StatefulSet | `apps.k8s.io/StatefulSet` |
| `GCP_RBAC_AUTHORIZATION_K8S_IO_CLUSTERROLE` | K8s ClusterRole | `rbac.authorization.k8s.io/ClusterRole` |
| `GCP_RBAC_AUTHORIZATION_K8S_IO_CLUSTERROLEBINDING` | K8s ClusterRoleBinding | `rbac.authorization.k8s.io/ClusterRoleBinding` |
| `GCP_RBAC_AUTHORIZATION_K8S_IO_ROLE` | K8s Role | `rbac.authorization.k8s.io/Role` |
| `GCP_RBAC_AUTHORIZATION_K8S_IO_ROLEBINDING` | K8s RoleBinding | `rbac.authorization.k8s.io/RoleBinding` |

#### Data & Storage

| Smartscape Entity Type | GCP Service | Cloud Asset Inventory Asset Type |
|---|---|---|
| `GCP_STORAGE_GOOGLEAPIS_COM_BUCKET` | Cloud Storage | `storage.googleapis.com/Bucket` |
| `GCP_SQLADMIN_GOOGLEAPIS_COM_INSTANCE` | Cloud SQL | `sqladmin.googleapis.com/Instance` |
| `GCP_ALLOYDB_GOOGLEAPIS_COM_CLUSTER` | AlloyDB (Cluster) | `alloydb.googleapis.com/Cluster` |
| `GCP_ALLOYDB_GOOGLEAPIS_COM_INSTANCE` | AlloyDB (Instance) | `alloydb.googleapis.com/Instance` |
| `GCP_ALLOYDB_GOOGLEAPIS_COM_BACKUP` | AlloyDB (Backup) | `alloydb.googleapis.com/Backup` |
| `GCP_FIRESTORE_GOOGLEAPIS_COM_DATABASE` | Firestore | `firestore.googleapis.com/Database` |
| `GCP_REDIS_GOOGLEAPIS_COM_INSTANCE` | Memorystore Redis (Instance) | `redis.googleapis.com/Instance` |
| `GCP_REDIS_GOOGLEAPIS_COM_CLUSTER` | Memorystore Redis (Cluster) | `redis.googleapis.com/Cluster` |
| `GCP_NETAPP_GOOGLEAPIS_COM_VOLUME` | NetApp Volumes (Volume) | `netapp.googleapis.com/Volume` |
| `GCP_NETAPP_GOOGLEAPIS_COM_STORAGEPOOL` | NetApp Volumes (Pool) | `netapp.googleapis.com/StoragePool` |

#### Messaging & Integration

| Smartscape Entity Type | GCP Service | Cloud Asset Inventory Asset Type |
|---|---|---|
| `GCP_PUBSUB_GOOGLEAPIS_COM_TOPIC` | Pub/Sub Topic | `pubsub.googleapis.com/Topic` |
| `GCP_PUBSUB_GOOGLEAPIS_COM_SUBSCRIPTION` | Pub/Sub Subscription | `pubsub.googleapis.com/Subscription` |
| `GCP_PUBSUB_GOOGLEAPIS_COM_SCHEMA` | Pub/Sub Schema | `pubsub.googleapis.com/Schema` |

#### Data Analytics & AI

| Smartscape Entity Type | GCP Service | Cloud Asset Inventory Asset Type |
|---|---|---|
| `GCP_DATAFLOW_GOOGLEAPIS_COM_JOB` | Dataflow Job | `dataflow.googleapis.com/Job` |
| `GCP_DATAPROC_GOOGLEAPIS_COM_CLUSTER` | Dataproc Cluster | `dataproc.googleapis.com/Cluster` |
| `GCP_DATAPROC_GOOGLEAPIS_COM_JOB` | Dataproc Job | `dataproc.googleapis.com/Job` |
| `GCP_AIPLATFORM_GOOGLEAPIS_COM_CUSTOMJOB` | Vertex AI Custom Job | `aiplatform.googleapis.com/CustomJob` |
| `GCP_AIPLATFORM_GOOGLEAPIS_COM_METADATASTORE` | Vertex AI Metadata | `aiplatform.googleapis.com/MetadataStore` |
| `GCP_AIPLATFORM_GOOGLEAPIS_COM_NOTEBOOKRUNTIMETEMPLATE` | Vertex AI Notebook | `aiplatform.googleapis.com/NotebookRuntimeTemplate` |
| `GCP_DATAPLEX_GOOGLEAPIS_COM_ENTRYGROUP` | Dataplex Entry Group | `dataplex.googleapis.com/EntryGroup` |
| `GCP_DATAPLEX_GOOGLEAPIS_COM_DATASCAN` | Dataplex DataScan | `dataplex.googleapis.com/DataScan` |
| `GCP_DATAFORM_GOOGLEAPIS_COM_REPOSITORY` | Dataform Repository | `dataform.googleapis.com/Repository` |

#### Operations & Monitoring

| Smartscape Entity Type | GCP Service | Cloud Asset Inventory Asset Type |
|---|---|---|
| `GCP_LOGGING_GOOGLEAPIS_COM_LOGSINK` | Logging Sink | `logging.googleapis.com/LogSink` |
| `GCP_LOGGING_GOOGLEAPIS_COM_LOGBUCKET` | Logging Bucket | `logging.googleapis.com/LogBucket` |
| `GCP_LOGGING_GOOGLEAPIS_COM_LOGMETRIC` | Logging Metric | `logging.googleapis.com/LogMetric` |
| `GCP_LOGGING_GOOGLEAPIS_COM_SAVEDQUERY` | Logging Saved Query | `logging.googleapis.com/SavedQuery` |
| `GCP_LOGGING_GOOGLEAPIS_COM_RECENTQUERY` | Logging Recent Query | `logging.googleapis.com/RecentQuery` |
| `GCP_MONITORING_GOOGLEAPIS_COM_DASHBOARD` | Monitoring Dashboard | `monitoring.googleapis.com/Dashboard` |
| `GCP_MONITORING_GOOGLEAPIS_COM_ALERTPOLICY` | Monitoring Alert Policy | `monitoring.googleapis.com/AlertPolicy` |
| `GCP_MONITORING_GOOGLEAPIS_COM_NOTIFICATIONCHANNEL` | Monitoring Notification | `monitoring.googleapis.com/NotificationChannel` |
| `GCP_MONITORING_GOOGLEAPIS_COM_UPTIMECHECKCONFIG` | Uptime Check | `monitoring.googleapis.com/UptimeCheckConfig` |

#### Identity & Security

| Smartscape Entity Type | GCP Service | Cloud Asset Inventory Asset Type |
|---|---|---|
| `GCP_IAM_GOOGLEAPIS_COM_SERVICEACCOUNT` | IAM Service Account | `iam.googleapis.com/ServiceAccount` |
| `GCP_IAM_GOOGLEAPIS_COM_SERVICEACCOUNTKEY` | IAM SA Key | `iam.googleapis.com/ServiceAccountKey` |
| `GCP_IAM_GOOGLEAPIS_COM_ROLE` | IAM Custom Role | `iam.googleapis.com/Role` |
| `GCP_IAM_GOOGLEAPIS_COM_WORKLOADIDENTITYPOOL` | Workload Identity Pool | `iam.googleapis.com/WorkloadIdentityPool` |
| `GCP_IAM_GOOGLEAPIS_COM_WORKLOADIDENTITYPOOLPROVIDER` | Workload Identity Provider | `iam.googleapis.com/WorkloadIdentityPoolProvider` |
| `GCP_CLOUDKMS_GOOGLEAPIS_COM_KEYRING` | KMS Key Ring | `cloudkms.googleapis.com/KeyRing` |
| `GCP_CLOUDKMS_GOOGLEAPIS_COM_CRYPTOKEY` | KMS Crypto Key | `cloudkms.googleapis.com/CryptoKey` |
| `GCP_CLOUDKMS_GOOGLEAPIS_COM_CRYPTOKEYVERSION` | KMS Key Version | `cloudkms.googleapis.com/CryptoKeyVersion` |
| `GCP_SECRETMANAGER_GOOGLEAPIS_COM_SECRET` | Secret Manager (Secret) | `secretmanager.googleapis.com/Secret` |
| `GCP_SECRETMANAGER_GOOGLEAPIS_COM_SECRETVERSION` | Secret Manager (Version) | `secretmanager.googleapis.com/SecretVersion` |
| `GCP_SECURITYCENTERMANAGEMENT_GOOGLEAPIS_COM_SECURITYCENTERSERVICE` | Security Center | `securitycentermanagement.googleapis.com/SecurityCenterService` |
| `GCP_RECAPTCHAENTERPRISE_GOOGLEAPIS_COM_KEY` | reCAPTCHA Enterprise | `recaptchaenterprise.googleapis.com/Key` |

#### Networking & Connectivity

| Smartscape Entity Type | GCP Service | Cloud Asset Inventory Asset Type |
|---|---|---|
| `GCP_DNS_GOOGLEAPIS_COM_MANAGEDZONE` | Cloud DNS Zone | `dns.googleapis.com/ManagedZone` |
| `GCP_DNS_GOOGLEAPIS_COM_POLICY` | Cloud DNS Policy | `dns.googleapis.com/Policy` |
| `GCP_DNS_GOOGLEAPIS_COM_RESOURCERECORDSET` | DNS Record Set | `dns.googleapis.com/ResourceRecordSet` |
| `GCP_DNS_GOOGLEAPIS_COM_RESPONSEPOLICY` | DNS Response Policy | `dns.googleapis.com/ResponsePolicy` |
| `GCP_DNS_GOOGLEAPIS_COM_RESPONSEPOLICYRULE` | DNS Response Policy Rule | `dns.googleapis.com/ResponsePolicyRule` |
| `GCP_NETWORKCONNECTIVITY_GOOGLEAPIS_COM_INTERNALRANGE` | Network Connectivity | `networkconnectivity.googleapis.com/InternalRange` |
| `GCP_NETWORKMANAGEMENT_GOOGLEAPIS_COM_CONNECTIVITYTEST` | Network Management | `networkmanagement.googleapis.com/ConnectivityTest` |
| `GCP_SERVICENETWORKING_GOOGLEAPIS_COM_CONNECTION` | Service Networking | `servicenetworking.googleapis.com/Connection` |
| `GCP_VPCACCESS_GOOGLEAPIS_COM_CONNECTOR` | VPC Access Connector | `vpcaccess.googleapis.com/Connector` |
| `GCP_SERVICEDIRECTORY_GOOGLEAPIS_COM_NAMESPACE` | Service Directory NS | `servicedirectory.googleapis.com/Namespace` |
| `GCP_SERVICEDIRECTORY_GOOGLEAPIS_COM_SERVICE` | Service Directory Svc | `servicedirectory.googleapis.com/Service` |
| `GCP_SERVICEDIRECTORY_GOOGLEAPIS_COM_ENDPOINT` | Service Directory EP | `servicedirectory.googleapis.com/Endpoint` |

#### Other Services

| Smartscape Entity Type | GCP Service | Cloud Asset Inventory Asset Type |
|---|---|---|
| `GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT` | Resource Manager Project | `cloudresourcemanager.googleapis.com/Project` |
| `GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_TAGKEY` | Resource Manager Tag Key | `cloudresourcemanager.googleapis.com/TagKey` |
| `GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_TAGVALUE` | Resource Manager Tag Value | `cloudresourcemanager.googleapis.com/TagValue` |
| `GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_LIEN` | Resource Manager Lien | `cloudresourcemanager.googleapis.com/Lien` |
| `GCP_CLOUDBILLING_GOOGLEAPIS_COM_PROJECTBILLINGINFO` | Billing Info | `cloudbilling.googleapis.com/ProjectBillingInfo` |
| `GCP_SERVICEUSAGE_GOOGLEAPIS_COM_SERVICE` | Enabled API Service | `serviceusage.googleapis.com/Service` |
| `GCP_ARTIFACTREGISTRY_GOOGLEAPIS_COM_REPOSITORY` | Artifact Registry Repo | `artifactregistry.googleapis.com/Repository` |
| `GCP_ARTIFACTREGISTRY_GOOGLEAPIS_COM_DOCKERIMAGE` | Artifact Registry Image | `artifactregistry.googleapis.com/DockerImage` |
| `GCP_CLOUDTASKS_GOOGLEAPIS_COM_QUEUE` | Cloud Tasks Queue | `cloudtasks.googleapis.com/Queue` |
| `GCP_CLOUDBUILD_GOOGLEAPIS_COM_BUILDTRIGGER` | Cloud Build Trigger | `cloudbuild.googleapis.com/BuildTrigger` |
| `GCP_STORAGETRANSFER_GOOGLEAPIS_COM_TRANSFERJOB` | Storage Transfer Job | `storagetransfer.googleapis.com/TransferJob` |
| `GCP_APIGEE_GOOGLEAPIS_COM_ORGANIZATION` | Apigee Organization | `apigee.googleapis.com/Organization` |
| `GCP_OSCONFIG_GOOGLEAPIS_COM_OSPOLICYASSIGNMENT` | OS Config Policy | `osconfig.googleapis.com/OSPolicyAssignment` |
| `GCP_EVENTARC_GOOGLEAPIS_COM_TRIGGER` | Eventarc Trigger | `eventarc.googleapis.com/Trigger` |
| `GCP_PRIVATECA_GOOGLEAPIS_COM_CAPOOL` | Private CA Pool | `privateca.googleapis.com/CaPool` |
| `GCP_FIREBASERULES_GOOGLEAPIS_COM_RULESET` | Firebase Rules | `firebaserules.googleapis.com/Ruleset` |
| `GCP_CLOUDQUOTAS_GOOGLEAPIS_COM_QUOTAPREFERENCE` | Cloud Quotas | `cloudquotas.googleapis.com/QuotaPreference` |
| `GCP_CLOUDASSET_GOOGLEAPIS_COM_FEED` | Cloud Asset Feed | `cloudasset.googleapis.com/Feed` |
| `GCP_CONFIG_GOOGLEAPIS_COM_PREVIEW` | Infrastructure Manager | `config.googleapis.com/Preview` |
| `GCP_APIHUB_GOOGLEAPIS_COM_APIHUBINSTANCE` | API Hub | `apihub.googleapis.com/ApiHubInstance` |

#### Topology Types

| Smartscape Entity Type | Description |
|---|---|
| `GCP_REGION` | GCP region (e.g., `europe-west1`, `us-central1`) |
| `GCP_ZONE` | GCP zone (e.g., `europe-west1-b`, `us-central1-a`) |

> **Entity Discovery**: The DA pipeline queries **Google Cloud Asset Inventory** to discover ALL resources in monitored projects. Smartscape entities are created for every discovered asset type — this includes infrastructure resources (VPC networks, firewall rules, IAM service accounts, DNS records, etc.) well beyond just the services that have Cloud Monitoring metrics. The list above was compiled from two live environments and is not exhaustive — additional entity types will appear based on what GCP resources exist in monitored projects.

### 2.3 Entity Dimensions on Metrics

When metrics are linked to Smartscape entities ("metrics in context"), the metric data includes:

| Dimension | Description | Example |
|---|---|---|
| `dt.smartscape_source.type` | Smartscape entity type | `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE` |
| `dt.smartscape_source.id` | Smartscape entity ID | `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE-1234ABCD` |
| `dt.da.source` | Data Acquisition source | `gcp-cloud-monitoring` |
| `gcp.resource.type` | Google monitored resource type | `gce_instance` |
| `project_id` | GCP project ID | `my-gcp-project` |

---

## 3. Metric Key Format

### 3.1 Pattern

New GCP metrics embed the **GCP resource type** in the metric key:

```
cloud.gcp.<resource_type>.<google_api_service>.<metric_path>
```

- `<resource_type>` — The Google Cloud monitored resource type (e.g., `gce_instance`, `gcs_bucket`, `logging_sink`)
- `<google_api_service>` — The Google API service domain, with dots replaced by underscores (e.g., `compute_googleapis_com`)
- `<metric_path>` — The metric path, with slashes replaced by dots (e.g., `instance.cpu.utilization`)

### 3.2 Key Pattern Comparison: Classic vs New

The critical difference is the **resource type prefix** in the new connection:

| Classic Key | New Key |
|---|---|
| `cloud.gcp.compute_googleapis_com.instance.cpu.utilization` | `cloud.gcp.gce_instance.compute_googleapis_com.instance.cpu.utilization` |
| `cloud.gcp.cloudsql_googleapis_com.database.cpu.utilization` | `cloud.gcp.cloudsql_database.cloudsql_googleapis_com.database.cpu.utilization` |
| `cloud.gcp.storage_googleapis_com.storage.total_bytes` | `cloud.gcp.gcs_bucket.storage_googleapis_com.storage.total_bytes` |
| `cloud.gcp.pubsub_googleapis_com.subscription.num_undelivered_messages` | `cloud.gcp.pubsub_subscription.pubsub_googleapis_com.subscription.num_undelivered_messages` |
| `cloud.gcp.cloudfunctions_googleapis_com.function.execution_count` | `cloud.gcp.cloud_function.cloudfunctions_googleapis_com.function.execution_count` |

### 3.3 Metric Examples by Service

| GCP Service | Resource Type | Example New Metric Key |
|---|---|---|
| **Compute Engine** | `gce_instance` | `cloud.gcp.gce_instance.compute_googleapis_com.instance.cpu.utilization` |
| **Compute Engine** | `gce_instance` | `cloud.gcp.gce_instance.compute_googleapis_com.instance.disk.read_bytes_count` |
| **Cloud Storage** | `gcs_bucket` | `cloud.gcp.gcs_bucket.storage_googleapis_com.storage.total_bytes` |
| **Cloud Storage** | `gcs_bucket` | `cloud.gcp.gcs_bucket.storage_googleapis_com.storage.object_count` |
| **Logging (Sink)** | `logging_sink` | `cloud.gcp.logging_sink.logging_googleapis_com.exports.byte_count` |
| **Pub/Sub** | `pubsub_topic` | `cloud.gcp.pubsub_topic.pubsub_googleapis_com.topic.send_message_operation_count` |
| **Pub/Sub** | `pubsub_subscription` | `cloud.gcp.pubsub_subscription.pubsub_googleapis_com.subscription.num_undelivered_messages` |
| **Cloud SQL** | `cloudsql_database` | `cloud.gcp.cloudsql_database.cloudsql_googleapis_com.database.cpu.utilization` |
| **Cloud Functions** | `cloud_function` | `cloud.gcp.cloud_function.cloudfunctions_googleapis_com.function.execution_count` |

---

## 4. Metric Collection Sets

Like the new AWS and Azure connections, the new GCP connection supports **metric collection sets** that control which metrics are ingested:

### 4.1 Collection Set Options

| Set | Description |
|---|---|
| **Recommended** (default) | Curated set of important metrics per service. Lowest cost, covers common use cases. |
| **Recommended + custom** | Recommended set plus user-specified additional metrics (custom metric selectors). |
| **Auto-discovery** | Ingests all available metrics from Google Cloud Monitoring. Highest cost, most comprehensive. |

### 4.2 Configuring Metric Collection

Metric collection sets are configured per-service in the **Cloud platform monitoring** settings (`gcp-onboarding` app). Each service can independently use a different collection set.

---

## 5. Metrics in Context (Entity-Linked Metrics)

### 5.1 Overview

"Metrics in context" means metrics are **linked to their Smartscape on Grail entity**, enabling:
- Viewing metrics on entity detail pages
- Filtering metrics by entity
- Entity-based alerting with full topology context
- Relationship traversal from metrics to entities

### 5.2 Services WITH Metrics in Context (Verified)

These services have full entity linking — metrics include `dt.smartscape_source.type` and `dt.smartscape_source.id`.

**Verified via live DQL query** (gmg environment, `dt.smartscape_source.type` values observed on `dt.da.source == "gcp-cloud-monitoring"` metrics):

| `dt.smartscape_source.type` on Metrics | Entity Count | GCP Service |
|---|---|---|
| `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE` | 108 series | Compute Engine |
| `GCP_STORAGE_GOOGLEAPIS_COM_BUCKET` | 36 series | Cloud Storage |
| `GCP_PUBSUB_GOOGLEAPIS_COM_SUBSCRIPTION` | 24 series | Pub/Sub |
| `GCP_LOGGING_GOOGLEAPIS_COM_LOGSINK` | 4 series | Operations (Logging) |
| `GCP_PUBSUB_GOOGLEAPIS_COM_TOPIC` | 2 series | Pub/Sub |

> **Important — Entity Type Names Differ Between Asset Inventory and Metrics**: The Smartscape entity type on metrics (e.g., `GCP_STORAGE_GOOGLEAPIS_COM_BUCKET`) matches the Cloud Asset Inventory asset type — NOT the Cloud Monitoring "monitored resource type" used in metric keys (e.g., `gcs_bucket`). Do not confuse these two naming systems.

The following services are documented as having metrics in context support but were not observed in the queried environments (may require those specific GCP services to be active):

| GCP Service | Expected `dt.smartscape_source.type` | Cloud Monitoring Resource Type |
|---|---|---|
| Cloud Functions | `GCP_CLOUDFUNCTIONS_GOOGLEAPIS_COM_FUNCTION` | `cloud_function` |
| Cloud Run | `GCP_RUN_GOOGLEAPIS_COM_REVISION` | `cloud_run_revision` |
| Kubernetes Engine | `GCP_CONTAINER_GOOGLEAPIS_COM_CLUSTER`, `GCP_K8S_IO_NODE`, `GCP_K8S_IO_POD` | `k8s_cluster`, `k8s_node`, `k8s_pod` |
| Bigtable | (not confirmed) | `bigtable_cluster` |
| Cloud Spanner | (not confirmed) | `spanner_instance` |
| Memorystore Redis | `GCP_REDIS_GOOGLEAPIS_COM_INSTANCE` | `redis_instance` |
| Dataflow | `GCP_DATAFLOW_GOOGLEAPIS_COM_JOB` | `dataflow_job` |
| Dataproc | `GCP_DATAPROC_GOOGLEAPIS_COM_CLUSTER` | `cloud_dataproc_cluster` |
| Filestore | (not confirmed) | `filestore_instance` |
| Cloud Tasks | `GCP_CLOUDTASKS_GOOGLEAPIS_COM_QUEUE` | `cloud_tasks_queue` |
| Cloud Composer | (not confirmed) | `cloud_composer_environment` |
| Hybrid Connectivity | (not confirmed) | `interconnect` |
| App Engine | (not confirmed) | `gae_app` |
| Apigee | `GCP_APIGEE_GOOGLEAPIS_COM_ORGANIZATION` | `apigee_proxy` |
| BigQuery | (not confirmed) | `bigquery_table` |
| reCAPTCHA Enterprise | `GCP_RECAPTCHAENTERPRISE_GOOGLEAPIS_COM_KEY` | `recaptcha_enterprise_key` |

### 5.3 Services WITHOUT Metrics in Context

These services have **metrics only** — no entity linking. Metrics are ingested but not bound to a Smartscape entity:

| GCP Service | Resource Types |
|---|---|
| Cloud SQL | `cloudsql_database` |
| Load Balancing | `https_lb_rule`, `internal_http_lb_rule`, etc. |
| Cloud NAT | `nat_gateway` |
| VPN Gateway | `vpn_gateway` |
| Vertex AI | Various |
| NetApp Volumes | `netapp_volume`, `netapp_storage_pool` |
| Network Security | `network_security_policy` |
| Firebase | Various |
| Firestore | `firestore_database` |

> **Note**: This list evolves. As Dynatrace adds "metrics in context" support for more services, they move from the "without" to the "with" category. Check the latest documentation for current status.

---

## 6. Disambiguating New vs Classic GCP Connection

### 6.1 Quick Reference Table

| Signal | New GCP Connection | Classic GCP Connection |
|---|---|---|
| **`dt.da.source`** | `"gcp-cloud-monitoring"` | null |
| **`dt.smartscape_source.type`** | `GCP_*` (e.g., `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE`) — on metrics with entity linking | Not present |
| **`dt.smartscape_source.id`** | Present (e.g., `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE-...`) — on metrics with entity linking | Not present |
| **`smartscapeNodes` query** | `smartscapeNodes GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE` returns entities | No Smartscape on Grail entities |
| **`dt.source`** | null | `"com.dynatrace.gcp"` (or null) |
| **`metadata.origin`** | null | `"extension"` (or null) |
| **Settings schema** | `builtin:hyperscaler-authentication.connections.gcp` | None (GKE deployment) |
| **Entity types** | `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE`, etc. | `CUSTOM_DEVICE` (cloud:gcp:gce_instance, etc.) |
| **Entity ID prefix** | `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE-` | `CUSTOM_DEVICE-` |
| **Metric key pattern** | `cloud.gcp.<resource_type>.<api>.<path>` | `cloud.gcp.<api>.<path>` |

### 6.2 DQL Filter: Only New GCP Metrics

```dql
fetch metric.series
| fields metric.key, dt.da.source, dt.smartscape_source.type, dt.smartscape_source.id, gcp.resource.type, project_id
| filter dt.da.source == "gcp-cloud-monitoring"
| summarize count(), by:{metric.key, dt.smartscape_source.type, gcp.resource.type}
| sort metric.key asc
```

### 6.3 DQL Filter: Only Classic GCP Metrics

```dql
fetch metric.series
| fields metric.key, dt.source, metadata.origin, gcp.resource.type, project_id
| filter contains(metric.key, "cloud.gcp")
| filterOut startsWith(metric.key, "dac.gcp_")
| filterOut startsWith(metric.key, "dt.sfm.da.gcp")
| filter isNull(dt.da.source) OR dt.da.source != "gcp-cloud-monitoring"
| summarize count(), by:{metric.key, gcp.resource.type, dt.source, metadata.origin}
| sort metric.key asc
```

### 6.4 DQL: Compare Classic vs New Side-by-Side

```dql
// Show all GCP metrics with their source attribution
fetch metric.series
| fields metric.key, dt.da.source, dt.source, metadata.origin, dt.smartscape_source.type, gcp.resource.type
| filter contains(metric.key, "cloud.gcp")
| filterOut startsWith(metric.key, "dac.gcp_")
| filterOut startsWith(metric.key, "dt.sfm.da.gcp")
| summarize count(), by:{metric.key, dt.da.source, dt.source, metadata.origin, dt.smartscape_source.type, gcp.resource.type}
| sort metric.key asc
```

---

## 7. DQL Query Patterns for New GCP Data

### 7.1 List All New GCP Smartscape Entity Types

Smartscape on Grail entities are queried with `smartscapeNodes`, NOT `fetch dt.entity.*` or `fetch metric.series`:

```dql
smartscapeNodes "*"
| filter startsWith(type, "GCP_")
| summarize cnt = count(), by: { type }
| sort cnt desc
```

### 7.1b Query a Specific GCP Smartscape Entity Type

```dql
smartscapeNodes GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE
| fields id, name, type, gcp.project.id, gcp.resource.type, gcp.region, gcp.zone, gcp.asset.type, cloud.provider
```

### 7.1c List Entity Types That Have Metrics Linked (Metrics in Context)

To find which entity types have metrics linked via `dt.smartscape_source.type` (as opposed to just topology):

```dql
fetch metric.series
| fields dt.smartscape_source.type, dt.da.source
| filter dt.da.source == "gcp-cloud-monitoring"
| filter isNotNull(dt.smartscape_source.type)
| summarize cnt = count(), by: { dt.smartscape_source.type }
| sort cnt desc
```

### 7.2 Find New GCP Connection Metrics for Compute Engine

```dql
fetch metric.series
| fields metric.key, dt.smartscape_source.type, dt.smartscape_source.id, gcp.resource.type, project_id
| filter dt.da.source == "gcp-cloud-monitoring"
| filter gcp.resource.type == "gce_instance"
| summarize count(), by:{metric.key}
| sort metric.key asc
```

### 7.3 Query Timeseries Data for New GCP Metrics

```dql
timeseries avg(cloud.gcp.gce_instance.compute_googleapis_com.instance.cpu.utilization), by:{dt.smartscape_source.id, project_id}
| filter dt.da.source == "gcp-cloud-monitoring"
```

### 7.4 List Resource Types with Metric Counts

```dql
fetch metric.series
| fields metric.key, gcp.resource.type
| filter dt.da.source == "gcp-cloud-monitoring"
| summarize metric_count = countDistinct(metric.key), by:{gcp.resource.type}
| sort metric_count desc
```

### 7.5 Find GCP Connection Settings

```dql
fetch dt.settings
| filter schema == "builtin:hyperscaler-authentication.connections.gcp"
| fieldsAdd value, key, summary
```

---

## 8. Key Differences from Classic GCP

| Feature | Classic GCP | New GCP |
|---|---|---|
| **Deployment** | Self-hosted GKE workload | Fully managed (in-product) |
| **Configuration** | GKE manifests / Helm | Settings 2.0 UI / Terraform |
| **ActiveGate** | Not needed (but runs on GKE) | Not needed |
| **Entity types** | `CUSTOM_DEVICE` with `cloud:gcp:*` subtypes | Smartscape on Grail (`GCP_*`) — derived from Cloud Asset Inventory asset types |
| **Entity ID prefix** | `CUSTOM_DEVICE-` | `GCP_<SERVICE>_<TYPE>-` (e.g., `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE-`) |
| **Entity query** | `fetch \`dt.entity.cloud:gcp:gce_instance\`` | `smartscapeNodes GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE` |
| **Metric key pattern** | `cloud.gcp.<api>.<path>` | `cloud.gcp.<resource_type>.<api>.<path>` |
| **`dt.da.source`** | null | `gcp-cloud-monitoring` |
| **`dt.source`** | `com.dynatrace.gcp` | null |
| **Metric collection sets** | All metrics from configured services | Recommended / Recommended+custom / Auto-discovery |
| **Metrics in context** | Metrics linked to CUSTOM_DEVICE entities | Metrics linked to Smartscape entities (for supported services) |
| **Service coverage** | 50+ services with entities | Growing — some services have metrics only (no entity linking yet) |
| **PreReqs** | GKE cluster, SA with monitoring permissions | GCP SA with `Service Account Token Creator` for Dynatrace SA |
| **Parallel operation** | Can run alongside new | Can run alongside classic (not recommended — duplicate ingestion) |
| **Settings schema** | None | `builtin:hyperscaler-authentication.connections.gcp` |

---

## 9. Migration Relevance

When assisting with cloud migration from classic to new GCP connections, the app needs to:

1. **Detect active new connections** — query `builtin:hyperscaler-authentication.connections.gcp` settings to find all configured connections. Only connections with `SVC:com.dynatrace.da` as a consumer perform metric and Smartscape polling.
2. **Map classic entities to new entities** — classic `CUSTOM_DEVICE` entities with `cloud:gcp:*` sub-types must be mapped to the corresponding `GCP_*` Smartscape entity types.
3. **Detect parallel ingestion** — when both classic (GKE-based) and new GCP connections are active for the same project, flag the overlap and quantify duplicate metric series.
4. **Map metric keys** — classic GCP metrics use the `cloud.gcp.<resource_type>.<api>.<path>` prefix with the resource type first; new connection metrics use a similar prefix but are attributed via `dt.da.source == "gcp-cloud-monitoring"`.
5. **Account for no classic settings schema** — unlike AWS and Azure, the classic GCP integration cannot be detected via any Settings 2.0 API. Detection relies entirely on entity and metric data in Grail.
6. **Flag log ingest configuration (future scope)** — classic GCP log ingest flows via Google Cloud Pub/Sub at the project level, not per service. Migration to the new connection's native log ingest is a per-project task. Out of scope for the initial implementation.

---

## 10. Key Differences from New AWS and Azure Connections

| Feature | New AWS | New Azure | New GCP |
|---|---|---|---|
| **Settings schema** | `builtin:hyperscaler-authentication.connections.aws` | `builtin:hyperscaler-authentication.connections.azure` | `builtin:hyperscaler-authentication.connections.gcp` |
| **`dt.da.source`** | `aws-cloudwatch` | `azure-monitor` | `gcp-cloud-monitoring` |
| **Entity prefix** | `AWS_*` (e.g., `AWS_EC2_INSTANCE`) | `AZURE_*` (e.g., `AZURE_VM`) | `GCP_*` (e.g., `GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE`) |
| **Entity naming** | Short service names | Short service names | Full Google API domain (verbose) |
| **Auth method** | IAM role / access key | App registration / managed identity | Service account impersonation / key |
| **Metric key prefix** | `cloud.aws.<resource_type>.*` | `cloud.azure.<resource_type>.*` | `cloud.gcp.<resource_type>.<api>.<path>` |
| **Entity discovery** | AWS resource APIs | Azure Resource Graph | Google Cloud Asset Inventory |
