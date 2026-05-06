# New Azure Connection in Dynatrace (Smartscape on Grail)

> **Scope**: This document covers the **new** Azure Cloud Platform Monitoring integration only.
> It does **NOT** cover the classic (legacy) Azure monitoring integration — see [azure-classic.md](azure-classic.md) for that.

## Overview

The new Azure connection is Dynatrace's next-generation Azure monitoring integration, built on the Grail data lakehouse. It replaces the classic ActiveGate-based architecture with a cloud-native data acquisition (DA) pipeline that runs entirely within the Dynatrace platform. It introduces **Smartscape on Grail** — a purpose-built entity model where each Azure resource type gets its own dedicated entity type (prefixed `AZURE_MICROSOFT_`), with rich topology and relationships.

Dynatrace scans Azure subscriptions using **Azure Resource Graph** to discover resources and persist them as Smartscape on Grail entities, and polls **Azure Monitor** APIs to ingest native platform metrics linked to those entities.

> **Preview**: As of March 2026, the new Azure connection is in Preview. The supported services and metric collection sets are incrementally expanded.

---

## 1. Architecture

### 1.1 Data Acquisition Components

| Component | `dt.da.source` Value | Purpose |
|---|---|---|
| **Metric Poller** | `azure-metric-poller` | Polls Azure Monitor `getBatch` and `ListMetricDefinitions` APIs on 5-minute intervals with 5-minute delay |
| **Smartscape Poller** | *(topology only — no separate DA source observed)* | Scans Azure Resource Graph every 12 hours (full) + every 15 minutes (tags + resource changes) |

> Unlike the classic connection, which requires an ActiveGate for non-built-in services, the new connection runs entirely inside the Dynatrace platform as a managed data acquisition service.

### 1.2 Authentication & Connection Configuration

| Property | Value |
|---|---|
| **Settings Schema** | `builtin:hyperscaler-authentication.connections.azure` |
| **Auth Methods** | Federated Identity Credential (`federatedIdentityCredential`) |
| **Connection Properties** | `name` (text), `type` (enum), auth config (consumers list) |

#### Consumers

Each connection specifies which Dynatrace integrations consume it:

| Consumer | Display Name | Purpose |
|---|---|---|
| `SVC:com.dynatrace.da` | Data Acquisition | Metric polling + Smartscape topology discovery |

> **Key insight**: Only connections with `SVC:com.dynatrace.da` as a consumer perform metric and Smartscape polling. The consumer model is the same as the new AWS connection — additional consumers (e.g., FinOps, OpenPipeline) may be added in the future.

#### Querying Connections

Configured connections can be queried via the Settings V2 API:

```
dtctl get settings --schema builtin:hyperscaler-authentication.connections.azure
```

Each settings object returns:
- `value.name` — connection name
- `value.type` — auth method (`federatedIdentityCredential`)
- `value.federatedIdentityCredential.consumers` — list of consumers using the connection

### 1.3 Metric Polling Schedule

- Polling runs every **5 minutes**, evaluating a 5-minute window
- **5-minute delay** to account for Azure Monitor eventual consistency (late aggregations)
- Example: A job starting at 9:00 AM evaluates data points for 8:50–8:55 AM

### 1.4 Topology Data Freshness

- **Full topology scan**: Every 12 hours via Azure Resource Graph
- **Tag refresh + resource changes**: Every 15 minutes
- When querying topology, select at least the last hour to list all active resources
- Topology is scoped to the Azure Regions that have been selected for monitoring

---

## 2. Smartscape on Grail Entity Model

### 2.1 Entity Types

The new connection creates **Smartscape on Grail** entities. The naming convention converts the Azure resource type to uppercase and substitutes `.` and `/` with `_`:

**Pattern**: `AZURE_MICROSOFT_<PROVIDER>_<RESOURCETYPE>`

Example: Azure resource type `microsoft.compute/virtualmachines` → Smartscape entity type `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES`

| Smartscape Entity Type | Azure Resource Type | Azure Service |
|---|---|---|
| `AZURE_MICROSOFT_EVENTHUB_NAMESPACES` | `microsoft.eventhub/namespaces` | Event Hubs Namespace |
| `AZURE_MICROSOFT_STORAGE_STORAGEACCOUNTS` | `microsoft.storage/storageaccounts` | Storage Account |
| `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINESCALESETS` | `microsoft.compute/virtualmachinescalesets` | VM Scale Sets |
| `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES` | `microsoft.compute/virtualmachines` | Virtual Machines |
| `AZURE_MICROSOFT_NETWORK_LOADBALANCERS` | `microsoft.network/loadbalancers` | Load Balancer |
| `AZURE_MICROSOFT_WEB_SITES` | `microsoft.web/sites` | Web App / Function App |
| `AZURE_MICROSOFT_SQL_SERVERS_DATABASES` | `microsoft.sql/servers/databases` | SQL Database |
| `AZURE_MICROSOFT_APP_CONTAINERAPPS` | `microsoft.app/containerapps` | Container Apps |
| `AZURE_MICROSOFT_CACHE_REDIS` | `microsoft.cache/redis` | Cache for Redis |
| `AZURE_MICROSOFT_CACHE_REDISENTERPRISE` | `microsoft.cache/redisenterprise` | Managed Redis |
| `AZURE_MICROSOFT_NETWORK_APPLICATIONGATEWAYS` | `microsoft.network/applicationgateways` | Application Gateway |
| `AZURE_MICROSOFT_APIMANAGEMENT_SERVICE` | `microsoft.apimanagement/service` | API Management |
| `AZURE_MICROSOFT_DOCUMENTDB_DATABASEACCOUNTS` | `microsoft.documentdb/databaseaccounts` | Cosmos DB |

> **Entity ID Format**: `<ENTITY_TYPE>-<HEX_ID>`, e.g., `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES-FD50E056292D0BF3`.

> **Important**: Smartscape on Grail entities are queried with `smartscapeNodes "<Entity_Type>"` and **MUST NOT** be confused with classic entities queried via `fetch dt.entity.<type>`. The new Azure connection only creates Smartscape nodes and never uses classic entities.

### 2.2 Full Documented Entity Types (Support Matrix)

The Dynatrace support matrix documents the following Azure resource types. Each maps to a Smartscape on Grail entity type:

**AI and Machine Learning**: `Microsoft.CognitiveServices/accounts` (Anomaly Detector, Bing, Computer Vision, Face API, Immersive Reader, LUIS, OpenAI, Foundry, Personalizer, Speech, Text Analytics, Translator), `Microsoft.MachineLearningServices/workspaces`

**Analytics**: `Microsoft.Kusto/Clusters` (Data Explorer), `Microsoft.DataFactory/factories`, `Microsoft.DataShare/accounts`, `Microsoft.HDInsight/clusters`, `Microsoft.StreamAnalytics/streamingjobs`, `Microsoft.Synapse/workspaces` (+ `bigDataPools`, `sqlPools`), `Microsoft.PowerBIDedicated/capacities`

**Compute**: `Microsoft.Web/hostingEnvironments` (App Service Environment), `Microsoft.Web/serverfarms` (App Service Plan), `Microsoft.Web/sites` (Web App, Function App, Logic App Standard), `Microsoft.Batch/batchAccounts`, `Microsoft.AppPlatform/Spring`, `Microsoft.Compute/virtualMachines`, `Microsoft.Compute/virtualMachineScaleSets`, `Microsoft.VMwareCloudSimple/virtualMachines`

**Containers**: `Microsoft.App/containerApps`, `Microsoft.App/managedEnvironments`, `Microsoft.ContainerInstance/containerGroups`, `Microsoft.ContainerRegistry/registries`, `Microsoft.ContainerService/managedClusters` (AKS)

**Databases**: `Microsoft.Cache/redis`, `Microsoft.Cache/redisEnterprise`, `Microsoft.DocumentDB/databaseAccounts` (Cosmos DB GlobalDocumentDB + MongoDB), `Microsoft.DBforMySQL/flexibleServers`, `Microsoft.DBforPostgreSQL/flexibleServers`, `Microsoft.DBforPostgreSQL/serversv2` (Hyperscale/Citus), `Microsoft.Sql/servers/databases` (vCore, DTU, Hyperscale), `Microsoft.Sql/servers/elasticpools`, `Microsoft.Sql/managedInstances`

**Integration**: `Microsoft.ApiManagement/service`, `Microsoft.EventGrid/domains`, `Microsoft.EventGrid/systemTopics`, `Microsoft.EventGrid/topics`, `Microsoft.EventHub/clusters`, `Microsoft.EventHub/namespaces`, `Microsoft.Logic/workflows`, `Microsoft.NotificationHubs/namespaces/notificationHubs`, `Microsoft.Relay/namespaces`, `Microsoft.ServiceBus/namespaces` (Standard + Premium)

**IoT**: `Microsoft.DataBoxEdge/dataBoxEdgeDevices`, `Microsoft.IoTCentral/IoTApps`, `Microsoft.Devices/IotHubs`, `Microsoft.Devices/provisioningServices`

**Management**: `Microsoft.Insights/components` (Application Insights), `Microsoft.Automation/automationAccounts`, `Microsoft.RecoveryServices/Vaults`, `Microsoft.OperationalInsights/workspaces` (Log Analytics)

**Networking**: `Microsoft.Network/applicationGateways`, `Microsoft.Network/dnszones`, `Microsoft.Network/expressRouteCircuits`, `Microsoft.Network/expressRoutePorts`, `Microsoft.Network/azureFirewalls`, `Microsoft.Network/frontdoors`, `Microsoft.Cdn/Profiles` (Front Door + CDN), `Microsoft.Network/loadBalancers` (Standard + Gateway), `Microsoft.Network/networkWatchers/connectionMonitors`, `Microsoft.Peering/peerings`, `Microsoft.Network/privateDnsZones`, `Microsoft.Network/trafficManagerProfiles`, `Microsoft.Network/virtualNetworks`, `Microsoft.Network/connections`, `Microsoft.Network/virtualnetworkgateways`, `Microsoft.Network/networkInterfaces`, `Microsoft.Network/publicIPAddresses`

**Security**: `Microsoft.Cdn/cdnwebapplicationfirewallpolicies`, `Microsoft.KeyVault/vaults`

**Storage**: `Microsoft.Storage/storageAccounts` (+ blobServices, fileServices, queueServices, tableServices), `Microsoft.StorageSync/storageSyncServices`, `Microsoft.NetApp/netAppAccounts/capacityPools` (+ volumes)

**Web**: `Microsoft.AppConfiguration/configurationStores`, `Microsoft.Search/searchServices`, `Microsoft.Maps/accounts`, `Microsoft.ServiceFabricMesh/applications`, `Microsoft.SignalRService/SignalR`

### 2.3 Topology & Relationships

The support matrix defines relationships between Azure resource types. Examples:

| Source | Relationship | Target |
|---|---|---|
| `Microsoft.Compute/virtualMachines` | `is_attached_to` | `Microsoft.Network/networkInterfaces` |
| `Microsoft.Compute/virtualMachines` | `belongs_to` | `Microsoft.Compute/availabilitySets` |
| `Microsoft.Compute/virtualMachines` | `belongs_to` | `Microsoft.Compute/virtualMachineScaleSets` |
| `Microsoft.Compute/virtualMachines` | `is_attached_to` | `Microsoft.Compute/disks` |
| `Microsoft.Web/sites` | `runs_on` | `Microsoft.Web/serverFarms` |
| `Microsoft.Web/sites` | `is_attached_to` | `Microsoft.Network/virtualNetworks/subnets` |
| `Microsoft.App/containerApps` | `runs_on` | `Microsoft.App/managedEnvironments` |
| `Microsoft.ContainerService/managedClusters` | `uses` | `Microsoft.Network/virtualNetworks/subnets` |
| `Microsoft.Sql/servers/elasticpools` | `belongs_to` | `Microsoft.Sql/servers` |
| `Microsoft.Cache/redis` | `is_attached_to` | `Microsoft.Network/virtualNetworks/subnets` |
| `Microsoft.EventHub/namespaces` | `is_attached_to` | `Microsoft.Network/privateEndpoints` |
| `Microsoft.Storage/storageAccounts` | `uses` | `Microsoft.Network/privateEndpoints` |
| `Microsoft.Network/loadBalancers` | `is_attached_to` | `Microsoft.Network/virtualNetworks/subnets` |
| `Microsoft.Network/applicationGateways` | `uses` | `Microsoft.Network/virtualNetworks/subnets` |
| `Microsoft.Devices/IotHubs` | `routes_to` | `Microsoft.Storage/storageAccounts/blobServices/containers` |

Relationship types: `uses`, `is_attached_to`, `belongs_to`, `runs_on`, `contains`, `balances`, `routes_to`

### 2.4 Entity Attributes

All Azure Smartscape on Grail entities have these common attributes:

| Attribute | Description | Example |
|---|---|---|
| `azure.subscription` | Azure Subscription ID | `08b9810e-ddfb-42f4-899e-d0a378305c24` |
| `azure.location` | Azure Region | `eastus` |
| `azure.resource.id` | Full Azure Resource ID | `/subscriptions/.../providers/Microsoft.Compute/virtualMachines/myVM` |
| `azure.resource.group` | Resource Group name | `my-resource-group` |
| `azure.resource.name` | Resource name | `myVM` |
| `azure.resource.type` | Azure resource type (lowercase) | `microsoft.compute/virtualmachines` |
| `azure.object` | Full resource configuration (JSON) | `{"configuration": "<output_of_arg_api>"}` |
| `tags` | Azure resource tags | `{"owner_team": "team-acme"}` |

### 2.5 Resource Discovery

Dynatrace discovers resources by querying **Azure Resource Graph** (ARG) and **Azure Resource Manager** (ARM) APIs. The `azure.object` attribute contains the full resource configuration from these APIs.

---

## 3. Metric Key Format

### 3.1 Pattern

All new connection metrics follow a single, consistent format:

```
cloud.azure.microsoft_<provider>.<resource>.<MetricName>
```

- `microsoft_<provider>` — lowercase Azure resource provider namespace (e.g., `microsoft_compute`, `microsoft_storage`, `microsoft_cache`)
- `<resource>` — resource type (e.g., `virtualmachines`, `storageaccounts`, `redis`)
- `<MetricName>` — Azure Monitor metric name, preserving original casing (PascalCase or snake_case depending on the Azure service)

Examples:
- `cloud.azure.microsoft_compute.virtualmachines.PercentageCPU`
- `cloud.azure.microsoft_storage.storageaccounts.Transactions`
- `cloud.azure.microsoft_cache.redis.cachehits`
- `cloud.azure.microsoft_sql.servers.databases.cpu_percent`
- `cloud.azure.microsoft_eventhub.namespaces.IncomingRequests`
- `cloud.azure.microsoft_documentdb.databaseaccounts.TotalRequests`

### 3.2 Shared Pattern with Classic Cloud Services

> **Important**: The `cloud.azure.microsoft_<provider>.<resource>.<metric>` pattern is **identical** to what the classic cloud services (non-built-in) produce. See [Section 5](#5-disambiguating-new-vs-classic-connection) for how to tell them apart.

This contrasts with classical built-in services which use a different prefix (`dt.cloud.azure.*`).

### 3.3 Metric Collection Sets (MCS)

The new connection supports three types of Metric Collection Sets:

| MCS Type | API Name | Description |
|---|---|---|
| **Recommended** | `<provider>_<resource>_essential` | Immutable, opinionated Dynatrace metric set per service. Optimal starting point. |
| **Recommended + Custom** | `<provider>_<resource>_essentialplus` | Recommended metrics plus additional Dynatrace-curated metrics. |
| **Auto-Discovery** | — | All metrics for a service auto-discovered. Pre-set, immutable dimensions. High cost risk. |

Only one MCS can be assigned to a service at a time (1:1).

Example MCS identifiers:
- `microsoft_compute.virtualmachines_essential`
- `microsoft_cache.redis_essential`
- `microsoft_eventhub.namespaces_essential`
- `microsoft_web.sites_functionapp_essential`

### 3.4 Default Recommended Services

When onboarding via the Recommended path, a predefined set of services is enabled by default. Services marked "Recommended" in the support matrix are enabled automatically. This list is continuously evolving.

### 3.5 Advanced Metric Ingest

#### Ingest Any Azure Monitor Metric

The new connection supports ingesting **any** Azure Monitor native platform metric — even those not in the predefined collection sets. Configure by providing:

| Parameter | Required | Description |
|---|---|---|
| Type | Yes | Azure resource type (e.g., `Microsoft.Compute/virtualMachines`) |
| Kinds | No | Filter by resource kinds |
| SKU name | No | Filter by SKU |
| Suffix | No | Resource type suffix |
| Name | Yes | Metric name from Azure Monitor (e.g., `Percentage CPU`) |
| Dimensions | No | Comma-separated dimensions to include |
| Time grain | Yes | Aggregation interval (e.g., `PT5M`) |
| Statistics | Yes | Aggregation type (e.g., `Average`, `Sum`) |

---

## 4. Metric Dimensions and Enrichment

### 4.1 Platform-Enriched Dimensions

Every metric from the new connection carries these enrichment dimensions:

| Dimension | Description | Example |
|---|---|---|
| `dt.da.source` | Data acquisition source identifier | `azure-metric-poller` |
| `dt.smartscape_source.type` | Smartscape entity type | `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES` |
| `dt.smartscape_source.id` | Smartscape entity ID | `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES-FD50E056292D0BF3` |
| `azure.subscription` | Azure Subscription ID | `08b9810e-ddfb-42f4-899e-d0a378305c24` |
| `azure.resource.type` | Azure resource type (lowercase) | `microsoft.compute/virtualmachines` |
| `azure.resource.group` | Azure Resource Group | `my-resource-group` |

### 4.2 Azure Tag Enrichment

Metrics are enriched with Azure tags as `azure.tag.<TagKeyName>` dimensions. Up to 20 user-provided tags can be used for enrichment. Tag-based filtering supports up to 5 include and 5 exclude rules.

> **Note**: Azure tag enrichment is only possible for signals that were successfully linked to an entity (Azure Resource).

### 4.3 Azure Monitor Dimension Passthrough

Azure Monitor dimensions from the metric definition are passed through as top-level dimensions on the metric series. For example:

| Entity Type | Metric | Passthrough Dimensions |
|---|---|---|
| `AZURE_MICROSOFT_CACHE_REDIS` | `cachehits` | `ShardId` |
| `AZURE_MICROSOFT_CACHE_REDIS` | `errors` | `ShardId`, `ErrorType` |
| `AZURE_MICROSOFT_NETWORK_LOADBALANCERS` | `DipAvailability` | `ProtocolType`, `BackendPort`, `FrontendIPAddress`, `FrontendPort`, `BackendIPAddress` |
| `AZURE_MICROSOFT_NETWORK_LOADBALANCERS` | `ByteCount` | `FrontendIPAddress`, `FrontendPort`, `Direction` |
| `AZURE_MICROSOFT_STORAGE_STORAGEACCOUNTS` | `Transactions` | `Authentication`, `GeoType`, `ApiName`, `ResponseType`, `TransactionType` |
| `AZURE_MICROSOFT_EVENTHUB_NAMESPACES` | `Size` | `EntityName` |

### 4.4 Dimensions NOT Present (vs Classic)

| Dimension | Present in Classic | Present in New |
|---|---|---|
| `dt.source_entity` | Yes (entity ID) | **No** |
| `dt.source_entity.type` | Yes (e.g., `azure_vm`, `cloud:azure:cache:redis`) | **No** |
| `dt.source` | Yes | **No** |
| `dt.metrics.source` | Yes | **No** |

---

## 5. Disambiguating New vs Classic Connection

The same `cloud.azure.microsoft_<provider>.<resource>.<metric>` metric key can come from either the new connection or the classic cloud services (non-built-in). These rules distinguish them:

| Rule | Connection Type |
|---|---|
| `dt.da.source == "azure-metric-poller"` | **New** connection |
| `dt.smartscape_source.type` is present (e.g., `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES`) | **New** connection |
| `dt.smartscape_source.id` is present | **New** connection |
| `azure.resource.type` dimension is present | **New** connection |
| `dt.source_entity.type` starts with `cloud:azure:` | **Classic** cloud service (non-built-in) |
| `dt.source_entity.type` is a built-in type (e.g., `azure_vm`, `azure_redis_cache`) | **Classic** built-in |
| `dt.da.source` is null AND `dt.source_entity.type` is present | **Classic** connection |
| Metric key starts with `dt.cloud.azure.*` | **Classic** built-in (exclusive — never from new connection) |

> **Warning — Parallel Ingestion**: When both classic and new connections monitor the same Azure subscription, the same `cloud.azure.microsoft_*` metric can be ingested twice — once by each connection. This results in **double cost** and **duplicate data points**. In this scenario, metrics will carry a mix of dimensions from both connections. Running both connections in parallel should be flagged as a migration issue.

> **Note — Entity Name Differences**: Unlike AWS (where `AWS_LAMBDA_FUNCTION` collides between classic and new), Azure classic entity types (`AZURE_VM`, `AZURE_SQL_SERVER`, etc.) use **different names** from new connection types (`AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES`, `AZURE_MICROSOFT_SQL_SERVERS_DATABASES`). This reduces confusion, but be aware that both refer to the same Azure resources.

---

## 6. Complete Metric Inventory

### 6.1 By Entity Type

#### AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES (14 metrics)
- `cloud.azure.microsoft_compute.virtualmachines.AvailableMemoryBytes`
- `cloud.azure.microsoft_compute.virtualmachines.AvailableMemoryPercentage`
- `cloud.azure.microsoft_compute.virtualmachines.CPUCreditsConsumed`
- `cloud.azure.microsoft_compute.virtualmachines.CPUCreditsRemaining`
- `cloud.azure.microsoft_compute.virtualmachines.DiskReadBytes`
- `cloud.azure.microsoft_compute.virtualmachines.DiskReadOperations_Sec`
- `cloud.azure.microsoft_compute.virtualmachines.DiskWriteBytes`
- `cloud.azure.microsoft_compute.virtualmachines.DiskWriteOperations_Sec`
- `cloud.azure.microsoft_compute.virtualmachines.InboundFlows`
- `cloud.azure.microsoft_compute.virtualmachines.NetworkInTotal`
- `cloud.azure.microsoft_compute.virtualmachines.NetworkOutTotal`
- `cloud.azure.microsoft_compute.virtualmachines.OSDiskLatency`
- `cloud.azure.microsoft_compute.virtualmachines.OutboundFlows`
- `cloud.azure.microsoft_compute.virtualmachines.PercentageCPU`

#### AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINESCALESETS (9 metrics)
- `cloud.azure.microsoft_compute.virtualmachinescalesets.AvailableMemoryBytes`
- `cloud.azure.microsoft_compute.virtualmachinescalesets.CPUCreditsRemaining`
- `cloud.azure.microsoft_compute.virtualmachinescalesets.DataDiskLatency`
- `cloud.azure.microsoft_compute.virtualmachinescalesets.DiskReadBytes`
- `cloud.azure.microsoft_compute.virtualmachinescalesets.DiskReadOperations_Sec`
- `cloud.azure.microsoft_compute.virtualmachinescalesets.DiskWriteBytes`
- `cloud.azure.microsoft_compute.virtualmachinescalesets.DiskWriteOperations_Sec`
- `cloud.azure.microsoft_compute.virtualmachinescalesets.NetworkInTotal`
- `cloud.azure.microsoft_compute.virtualmachinescalesets.NetworkOutTotal`
- `cloud.azure.microsoft_compute.virtualmachinescalesets.PercentageCPU`

#### AZURE_MICROSOFT_STORAGE_STORAGEACCOUNTS (17 metrics)
- `cloud.azure.microsoft_storage.storageaccounts.Availability`
- `cloud.azure.microsoft_storage.storageaccounts.Egress`
- `cloud.azure.microsoft_storage.storageaccounts.Ingress`
- `cloud.azure.microsoft_storage.storageaccounts.Transactions`
- `cloud.azure.microsoft_storage.storageaccounts.UsedCapacity`
- `cloud.azure.microsoft_storage.storageaccounts.blobservices.Availability`
- `cloud.azure.microsoft_storage.storageaccounts.blobservices.BlobCapacity`
- `cloud.azure.microsoft_storage.storageaccounts.blobservices.Transactions`
- `cloud.azure.microsoft_storage.storageaccounts.fileservices.Availability`
- `cloud.azure.microsoft_storage.storageaccounts.fileservices.FileCapacity`
- `cloud.azure.microsoft_storage.storageaccounts.fileservices.Transactions`
- `cloud.azure.microsoft_storage.storageaccounts.queueservices.Availability`
- `cloud.azure.microsoft_storage.storageaccounts.queueservices.QueueCapacity`
- `cloud.azure.microsoft_storage.storageaccounts.queueservices.QueueMessageCount`
- `cloud.azure.microsoft_storage.storageaccounts.queueservices.Transactions`
- `cloud.azure.microsoft_storage.storageaccounts.tableservices.Availability`
- `cloud.azure.microsoft_storage.storageaccounts.tableservices.TableCapacity`
- `cloud.azure.microsoft_storage.storageaccounts.tableservices.Transactions`

#### AZURE_MICROSOFT_EVENTHUB_NAMESPACES (5 metrics)
- `cloud.azure.microsoft_eventhub.namespaces.ActiveConnections`
- `cloud.azure.microsoft_eventhub.namespaces.IncomingRequests`
- `cloud.azure.microsoft_eventhub.namespaces.Size`
- `cloud.azure.microsoft_eventhub.namespaces.SuccessfulRequests`
- `cloud.azure.microsoft_eventhub.namespaces.ThrottledRequests`

#### AZURE_MICROSOFT_WEB_SITES (18 metrics)
- `cloud.azure.microsoft_web.sites.AverageResponseTime`
- `cloud.azure.microsoft_web.sites.BytesReceived`
- `cloud.azure.microsoft_web.sites.BytesSent`
- `cloud.azure.microsoft_web.sites.FunctionExecutionCount`
- `cloud.azure.microsoft_web.sites.FunctionExecutionUnits`
- `cloud.azure.microsoft_web.sites.Http2xx`
- `cloud.azure.microsoft_web.sites.Http4xx`
- `cloud.azure.microsoft_web.sites.Http5xx`
- `cloud.azure.microsoft_web.sites.HttpResponseTime`
- `cloud.azure.microsoft_web.sites.IoOtherBytesPerSecond`
- `cloud.azure.microsoft_web.sites.IoOtherOperationsPerSecond`
- `cloud.azure.microsoft_web.sites.IoReadBytesPerSecond`
- `cloud.azure.microsoft_web.sites.IoReadOperationsPerSecond`
- `cloud.azure.microsoft_web.sites.IoWriteBytesPerSecond`
- `cloud.azure.microsoft_web.sites.IoWriteOperationsPerSecond`
- `cloud.azure.microsoft_web.sites.MemoryWorkingSet`
- `cloud.azure.microsoft_web.sites.Requests`
- `cloud.azure.microsoft_web.sites.RequestsInApplicationQueue`

#### AZURE_MICROSOFT_CACHE_REDIS (11 metrics)
- `cloud.azure.microsoft_cache.redis.cachehits`
- `cloud.azure.microsoft_cache.redis.cacheLatency`
- `cloud.azure.microsoft_cache.redis.cachemisses`
- `cloud.azure.microsoft_cache.redis.cachemissrate`
- `cloud.azure.microsoft_cache.redis.connectedclients`
- `cloud.azure.microsoft_cache.redis.errors`
- `cloud.azure.microsoft_cache.redis.evictedkeys`
- `cloud.azure.microsoft_cache.redis.percentProcessorTime`
- `cloud.azure.microsoft_cache.redis.serverLoad`
- `cloud.azure.microsoft_cache.redis.totalcommandsprocessed`
- `cloud.azure.microsoft_cache.redis.usedmemorypercentage`

#### AZURE_MICROSOFT_CACHE_REDISENTERPRISE (8 metrics)
- `cloud.azure.microsoft_cache.redisenterprise.cachehits`
- `cloud.azure.microsoft_cache.redisenterprise.cachemisses`
- `cloud.azure.microsoft_cache.redisenterprise.connectedclients`
- `cloud.azure.microsoft_cache.redisenterprise.evictedkeys`
- `cloud.azure.microsoft_cache.redisenterprise.percentProcessorTime`
- `cloud.azure.microsoft_cache.redisenterprise.serverLoad`
- `cloud.azure.microsoft_cache.redisenterprise.totalcommandsprocessed`
- `cloud.azure.microsoft_cache.redisenterprise.usedmemorypercentage`

#### AZURE_MICROSOFT_NETWORK_LOADBALANCERS (4 metrics)
- `cloud.azure.microsoft_network.loadbalancers.ByteCount`
- `cloud.azure.microsoft_network.loadbalancers.DipAvailability`
- `cloud.azure.microsoft_network.loadbalancers.PacketCount`
- `cloud.azure.microsoft_network.loadbalancers.VipAvailability`

#### AZURE_MICROSOFT_NETWORK_APPLICATIONGATEWAYS (7 metrics)
- `cloud.azure.microsoft_network.applicationgateways.CurrentConnections`
- `cloud.azure.microsoft_network.applicationgateways.FailedRequests`
- `cloud.azure.microsoft_network.applicationgateways.HealthyHostCount`
- `cloud.azure.microsoft_network.applicationgateways.ResponseStatus`
- `cloud.azure.microsoft_network.applicationgateways.Throughput`
- `cloud.azure.microsoft_network.applicationgateways.TotalRequests`
- `cloud.azure.microsoft_network.applicationgateways.UnhealthyHostCount`

#### AZURE_MICROSOFT_SQL_SERVERS_DATABASES (14 metrics)
- `cloud.azure.microsoft_sql.servers.databases.availability`
- `cloud.azure.microsoft_sql.servers.databases.cpu_limit`
- `cloud.azure.microsoft_sql.servers.databases.cpu_percent`
- `cloud.azure.microsoft_sql.servers.databases.cpu_used`
- `cloud.azure.microsoft_sql.servers.databases.dtu_consumption_percent`
- `cloud.azure.microsoft_sql.servers.databases.dtu_limit`
- `cloud.azure.microsoft_sql.servers.databases.dtu_used`
- `cloud.azure.microsoft_sql.servers.databases.log_write_percent`
- `cloud.azure.microsoft_sql.servers.databases.physical_data_read_percent`
- `cloud.azure.microsoft_sql.servers.databases.sessions_count`
- `cloud.azure.microsoft_sql.servers.databases.sessions_percent`
- `cloud.azure.microsoft_sql.servers.databases.storage`
- `cloud.azure.microsoft_sql.servers.databases.storage_percent`
- `cloud.azure.microsoft_sql.servers.databases.workers_percent`
- `cloud.azure.microsoft_sql.servers.databases.xtp_storage_percent`

#### AZURE_MICROSOFT_DOCUMENTDB_DATABASEACCOUNTS (9 metrics)
- `cloud.azure.microsoft_documentdb.databaseaccounts.DataUsage`
- `cloud.azure.microsoft_documentdb.databaseaccounts.DocumentCount`
- `cloud.azure.microsoft_documentdb.databaseaccounts.DocumentQuota`
- `cloud.azure.microsoft_documentdb.databaseaccounts.IndexUsage`
- `cloud.azure.microsoft_documentdb.databaseaccounts.MetadataRequests`
- `cloud.azure.microsoft_documentdb.databaseaccounts.ServerSideLatency`
- `cloud.azure.microsoft_documentdb.databaseaccounts.ServiceAvailability`
- `cloud.azure.microsoft_documentdb.databaseaccounts.TotalRequestUnits`
- `cloud.azure.microsoft_documentdb.databaseaccounts.TotalRequests`

#### AZURE_MICROSOFT_APP_CONTAINERAPPS (9 metrics)
- `cloud.azure.microsoft_app.containerapps.Replicas`
- `cloud.azure.microsoft_app.containerapps.Requests`
- `cloud.azure.microsoft_app.containerapps.ResiliencyRequestsPendingConnectionPool`
- `cloud.azure.microsoft_app.containerapps.RestartCount`
- `cloud.azure.microsoft_app.containerapps.RxBytes`
- `cloud.azure.microsoft_app.containerapps.TotalCoresQuotaUsed`
- `cloud.azure.microsoft_app.containerapps.TxBytes`
- `cloud.azure.microsoft_app.containerapps.UsageNanoCores`
- `cloud.azure.microsoft_app.containerapps.WorkingSetBytes`

#### AZURE_MICROSOFT_APIMANAGEMENT_SERVICE (2 metrics)
- `cloud.azure.microsoft_apimanagement.service.Capacity`
- `cloud.azure.microsoft_apimanagement.service.Requests`

### 6.2 Self-Monitoring Metrics

| Metric Key | `dt.da.source` | Description |
|---|---|---|
| `dt.sfm.da.azure.metric.data_points.count` | `azure-metric-poller` | SFM: metric data point count |

---

## 7. Settings & Configuration

### 7.1 Connection Settings Schema

| Property | Value |
|---|---|
| **Schema ID** | `builtin:hyperscaler-authentication.connections.azure` |
| **Auth Method** | `federatedIdentityCredential` (Azure Federated Identity Credential) |
| **Scope** | Tenant-level |
| **Consumer** | `SVC:com.dynatrace.da` for metric polling + topology |

### 7.2 Detecting Connections

The most reliable way to detect new Azure connections is via the Settings V2 API:

```
dtctl get settings --schema builtin:hyperscaler-authentication.connections.azure
```

> **Classic connections** remain managed through the legacy Configuration API (`/api/config/v1/azure/credentials`), not Settings 2.0.

---

## 8. DQL Query Patterns

### 8.1 List All New Connection Metrics

```dql
fetch metric.series
| fields metric.key, dt.da.source, dt.smartscape_source.type
| filter dt.da.source == "azure-metric-poller"
| summarize cnt=count(), by:{metric.key, dt.smartscape_source.type}
| sort dt.smartscape_source.type asc, cnt desc
```

### 8.2 List All Azure Smartscape Entity Types

Smartscape on Grail entities **must** be queried with `smartscapeNodes`, not `fetch metric.series` or `fetch dt.entity.*`:

```dql
smartscapeNodes "*"
| filter startsWith(type, "AZURE_")
| summarize cnt = count(), by: { type }
| sort cnt desc
```

> **Note**: This returns ALL Smartscape entity types discovered via Azure Resource Graph — including sub-resources like `AZURE_MICROSOFT_NETWORK_VIRTUALNETWORKS_SUBNETS`, `AZURE_MICROSOFT_STORAGE_STORAGEACCOUNTS_BLOBSERVICES_CONTAINERS`, availability zones, etc. In the gdq-dev environment, 86 distinct `AZURE_*` entity types exist — far more than reported by metrics alone.

### 8.2a Query a Specific Azure Entity Type

```dql
smartscapeNodes AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES
| fields id, name, type, azure.subscription, azure.location, azure.resource.group, azure.resource.name
| limit 10
```

### 8.2b Count Entities Per Type (Metrics-Linked Only)

To count only entity types that have metrics linked (via `dt.smartscape_source.type` on metric series):

```dql
fetch metric.series
| fieldsKeep dt.da.source, dt.smartscape_source.type, dt.smartscape_source.id
| filter dt.da.source == "azure-metric-poller"
  AND isNotNull(dt.smartscape_source.type)
| summarize entity_count = countDistinct(dt.smartscape_source.id), by:{dt.smartscape_source.type}
| sort entity_count desc
```

### 8.3 Find All Azure Data Acquisition Sources

```dql
fetch metric.series
| fieldsKeep dt.da.source
| filter isNotNull(dt.da.source) AND contains(dt.da.source, "azure")
| summarize cnt=count(), by:{dt.da.source}
| sort cnt desc
```

### 8.4 Detect Parallel Classic + New Ingestion

```dql
// Metrics that have BOTH classic and new connection dimensions
fetch metric.series
| fields metric.key, dt.da.source, dt.source_entity.type, dt.smartscape_source.type
| filter startsWith(metric.key, "cloud.azure.")
| summarize
    has_new = countIf(dt.da.source == "azure-metric-poller") > 0,
    has_classic = countIf(isNotNull(dt.source_entity.type)) > 0,
    by:{metric.key}
| filter has_new AND has_classic
```

### 8.5 Detect Active New Connections via Settings API

```
// Settings V2 API (not DQL — use dtctl)
dtctl get settings --schema builtin:hyperscaler-authentication.connections.azure
```

Each settings object returns:
- `value.name` — connection name
- `value.type` — auth method (`federatedIdentityCredential`)
- `value.federatedIdentityCredential.consumers` — list of consumers

Only connections with `SVC:com.dynatrace.da` as a consumer perform metric and Smartscape polling.

### 8.6 Query Azure Topology via Smartscape

```dql
// List all Azure Smartscape entity types
smartscapeNodes "*"
| filter startsWith(type, "AZURE_")
| summarize cnt = count(), by: { type }
| sort cnt desc
```

```dql
// Count entities by type across all monitored subscriptions
smartscapeNodes "AZURE_MICROSOFT*"
| summarize count=count(), by:{azure.subscription, azure.location, type}
| sort count desc

// Query VMs with a specific tag
smartscapeNodes "AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES"
| filter tags[owner_team]=="team-acme"

// Query VM disk configuration
smartscapeNodes "AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES"
| parse azure.object, "JSON:azurejson"
| fieldsAdd managedDiskId=azurejson[configuration][properties][storageProfile][osDisk][managedDisk][id],
            storageAccountType=azurejson[configuration][properties][storageProfile][osDisk][managedDisk][storageAccountType],
            diskSizeGB=azurejson[configuration][properties][storageProfile][osDisk][diskSizeGB]
| fieldsRemove azure.object, azurejson

// Query discovered relationship types
smartscapeEdges "AZURE*"
| summarize count=count(), by: {edgeType=type, sourceType=source_type, targetType=target_type}
```

### 8.7 Self-Monitoring Overview

```dql
fetch metric.series
| fieldsKeep metric.key, dt.da.source
| filter contains(dt.da.source, "azure") AND (startsWith(metric.key, "dac.") OR startsWith(metric.key, "dt.sfm.da.azure."))
| summarize cnt=count(), by:{metric.key, dt.da.source}
| sort dt.da.source asc
```

---

## 9. Key Differences: New vs Classic

| Aspect | New Connection | Classic Built-in | Classic Cloud Services |
|---|---|---|---|
| **Architecture** | Cloud-native DA service (no ActiveGate) | ActiveGate/Cluster polling | ActiveGate polling |
| **Entity model** | Smartscape on Grail (`AZURE_MICROSOFT_*`) | Dedicated types (`AZURE_VM`, `AZURE_SQL_SERVER`) | `CUSTOM_DEVICE` (`cloud:azure:*`) |
| **Entity ID format** | `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES-<hex>` | `AZURE_VM-<hex>` | `CUSTOM_DEVICE-<hex>` |
| **Entity naming** | Derived from Azure resource type | Dynatrace-curated names | `cloud:azure:<provider>:<resource>` sub-type |
| **Metric key prefix** | `cloud.azure.microsoft_*` | `dt.cloud.azure.*` | `cloud.azure.microsoft_*` |
| **Metric key naming** | Azure Monitor original casing | Dynatrace-curated snake_case | Azure Monitor lowercase |
| **`dt.da.source`** | `azure-metric-poller` | (null) | (null) |
| **`dt.smartscape_source.type`** | `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES`, etc. | (null) | (null) |
| **`dt.source_entity.type`** | (null) | Built-in type name | `cloud:azure:<provider>:<resource>` |
| **`azure.resource.type`** | Present (e.g., `microsoft.compute/virtualmachines`) | (null) | (null) |
| **Azure tags** | `azure.tag.*` dimensions (up to 20) | Imported to entity | Imported to entity |
| **Topology** | Full (Smartscape on Grail — rich relationships) | Full (built-in — Cassandra-based) | Custom device groups |
| **Configuration query** | DQL (`smartscapeNodes`) + `azure.object` | Entity properties | Entity properties |
| **Signals-in-context** | Yes (metrics linked to Smartscape entities) | Yes | Limited |
| **Settings Schema** | `builtin:hyperscaler-authentication.connections.azure` | Legacy Config API v1 | Legacy Config API v1 |
| **Connection Detection** | Settings API + metrics + Smartscape | Config API only | Config API only |
| **Metric ingest** | Configurable (MCS: Recommended / Custom / Auto-discovery) | Fixed, non-configurable | Configurable per service |
| **ActiveGate** | Not required | Not required (small envs) | Required |
| **Polling interval** | 5 min | 5 min | 5 min |
| **Metric Streaming** | Not currently planned | Not available | Not available |

---

## 10. Classic-to-New Entity Type Mapping

| Classic Entity Type | Classic Sub-type | New Smartscape Entity Type |
|---|---|---|
| `AZURE_VM` | — | `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES` |
| `AZURE_VM_SCALE_SET` | — | `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINESCALESETS` |
| `AZURE_LOAD_BALANCER` | — | `AZURE_MICROSOFT_NETWORK_LOADBALANCERS` |
| `AZURE_APPLICATION_GATEWAY` | — | `AZURE_MICROSOFT_NETWORK_APPLICATIONGATEWAYS` |
| `AZURE_REDIS_CACHE` | — | `AZURE_MICROSOFT_CACHE_REDIS` |
| `AZURE_COSMOS_DB` | — | `AZURE_MICROSOFT_DOCUMENTDB_DATABASEACCOUNTS` |
| `AZURE_SQL_SERVER` / `AZURE_SQL_DATABASE` | — | `AZURE_MICROSOFT_SQL_SERVERS_DATABASES` |
| `AZURE_SQL_ELASTIC_POOL` | — | `AZURE_MICROSOFT_SQL_SERVERS_ELASTICPOOLS` |
| `AZURE_EVENT_HUB_NAMESPACE` | — | `AZURE_MICROSOFT_EVENTHUB_NAMESPACES` |
| `AZURE_SERVICE_BUS_NAMESPACE` | — | `AZURE_MICROSOFT_SERVICEBUS_NAMESPACES` |
| `AZURE_FUNCTION_APP` / `AZURE_WEB_APP` | — | `AZURE_MICROSOFT_WEB_SITES` |
| `AZURE_STORAGE_ACCOUNT` | — | `AZURE_MICROSOFT_STORAGE_STORAGEACCOUNTS` |
| `AZURE_IOT_HUB` | — | `AZURE_MICROSOFT_DEVICES_IOTHUBS` |
| `AZURE_API_MANAGEMENT_SERVICE` | — | `AZURE_MICROSOFT_APIMANAGEMENT_SERVICE` |
| `CUSTOM_DEVICE` | `cloud:azure:cache:redis` | `AZURE_MICROSOFT_CACHE_REDIS` |
| `CUSTOM_DEVICE` | `cloud:azure:containerservice:managedcluster` | `AZURE_MICROSOFT_CONTAINERSERVICE_MANAGEDCLUSTERS` |
| `CUSTOM_DEVICE` | `cloud:azure:postgresql:flexibleservers` | `AZURE_MICROSOFT_DBFORPOSTGRESQL_FLEXIBLESERVERS` |
| `CUSTOM_DEVICE` | `cloud:azure:cognitiveservices:openai` | `AZURE_MICROSOFT_COGNITIVESERVICES_ACCOUNTS` |
| `CUSTOM_DEVICE` | `cloud:azure:storage:storageaccounts` | `AZURE_MICROSOFT_STORAGE_STORAGEACCOUNTS` |
| `CUSTOM_DEVICE` | `cloud:azure:network:loadbalancers:standard` | `AZURE_MICROSOFT_NETWORK_LOADBALANCERS` |
| `CUSTOM_DEVICE` | `cloud:azure:app:containerapps` | `AZURE_MICROSOFT_APP_CONTAINERAPPS` |
| `CUSTOM_DEVICE` | `cloud:azure:apimanagement:service` | `AZURE_MICROSOFT_APIMANAGEMENT_SERVICE` |

---

## 11. Migration Relevance

When assisting with cloud migration from classic to new Azure connections, the app needs to:

1. **Detect active new connections** — use a multi-layered detection strategy:
   - **Settings API** (primary, always reliable): Query `builtin:hyperscaler-authentication.connections.azure` to find all configured connections. Only connections with `SVC:com.dynatrace.da` as a consumer do metric/Smartscape polling.
   - **Smartscape topology** (secondary): Query `smartscapeNodes "AZURE_MICROSOFT*"` to discover which Azure subscriptions have active topology entities.
   - **Metric series** (supplementary): Query for `dt.da.source == "azure-metric-poller"` and enumerate `dt.smartscape_source.type` values. This confirms active metric ingestion but will miss connections where metric polling is disabled.

2. **Map classic entities to new entities** — e.g., `AZURE_VM` (classic built-in) → `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES` (new), `CUSTOM_DEVICE` with `cloud:azure:cache:redis` (classic cloud service) → `AZURE_MICROSOFT_CACHE_REDIS` (new). See Section 10 for the full mapping.

3. **Detect parallel ingestion** — when both classic and new connections are active for the same subscription, flag the overlap and quantify duplicate metric series. Both consume DDUs independently.

4. **Map metric keys** — classic built-in metrics (`dt.cloud.azure.*`) have **no** direct equivalent in the new connection. The new connection uses `cloud.azure.microsoft_*` keys exclusively. Classic cloud service metrics (`cloud.azure.microsoft_*`) use the same prefix as the new connection but can be distinguished via `dt.da.source`.

5. **Handle entity type differences** — classic `CUSTOM_DEVICE` entities with `cloud:azure:*` sub-types and classic dedicated types (e.g., `AZURE_VM`) both need to be mapped to the corresponding `AZURE_MICROSOFT_*` Smartscape entity types.

6. **Account for coverage gaps** — the new connection is in Preview and may not yet support all services that the classic connection monitors. Compare active services in both connections.

7. **Verify tag enrichment** — classic tags are imported to entities; new connection tags are enriched as `azure.tag.*` metric dimensions. Migration must preserve tag-based dashboards and alerts.

8. **Classic Configuration API** — classic Azure connections are NOT in Settings 2.0. They use the legacy `/api/config/v1/azure/credentials` endpoint. Both APIs must be queried for complete connection inventory.
9. **Flag log ingest configuration (future scope)** — log migration from classic Azure diagnostic settings/Event Hub to the new connection's native log pipeline (via `SVC:com.dynatrace.openpipeline` consumer) is a per-connection/subscription task, not per-service. Out of scope for the initial implementation.

---

## 12. Key Differences from AWS New Connection

| Aspect | Azure New Connection | AWS New Connection |
|---|---|---|
| **Entity type naming** | `AZURE_MICROSOFT_<PROVIDER>_<RESOURCE>` (from Azure resource type) | `AWS_<SERVICE>_<RESOURCE>` (from CloudFormation type) |
| **Metric key format** | `cloud.azure.microsoft_<provider>.<resource>.<MetricName>` | `cloud.aws.<service>.<MetricName>.By.<Dim1>.<Dim2>` |
| **Dimensions in metric key** | NOT embedded in key name | Dimensions appear as `By.<Dim1>.<Dim2>` suffix |
| **`dt.da.source`** | `azure-metric-poller` | `aws-metric-poller` |
| **Topology discovery** | Azure Resource Graph (ARG) | AWS APIs (DescribeInstances, ListFunctions, etc.) |
| **Topology refresh interval** | Full: 12 hours; Tags/changes: 15 minutes | Full + Lightweight + Resource-changes pollers |
| **Auth method** | Federated Identity Credential | IAM Cross-account Role / Web Identity |
| **Settings schema** | `builtin:hyperscaler-authentication.connections.azure` | `builtin:hyperscaler-authentication.connections.aws` |
| **Metric streaming** | Not planned | CloudWatch Metric Streams (planned) |
| **Entity name collision with classic** | **No collision** — classic uses `AZURE_VM`, new uses `AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES` | **Collision** — `AWS_LAMBDA_FUNCTION` exists in both classic and new |
| **Status** | Preview | Generally available |

---

## References

- [Azure topology (Smartscape on Grail)](https://docs.dynatrace.com/docs/ingest-from/microsoft-azure-services/ingest-telemetry/azure-topology-pp)
- [Supported Azure services](https://docs.dynatrace.com/docs/ingest-from/microsoft-azure-services/ingest-telemetry/azure-supported-services)
- [Azure Monitor metrics](https://docs.dynatrace.com/docs/ingest-from/microsoft-azure-services/ingest-telemetry/azure-monitor-metrics-pp)
