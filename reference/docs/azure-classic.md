# Classic Azure Connections in Dynatrace

> **Scope**: This document covers the **classic** (legacy) Azure monitoring integration only.
> It does **NOT** cover the new Azure cloud platform monitoring (`azure-onboarding`). New-connection Smartscape entities (Smartscape on Grail) always start with `AZURE_` prefix (e.g., `AZURE_VM_INSTANCE`, `AZURE_STORAGE_ACCOUNT`) — do not confuse with classic entity types that share similar names but originate from the classic connection.

## Overview

Classic Azure monitoring in Dynatrace provides two distinct methods for ingesting Azure Monitor metrics, plus a third option via Azure Native Dynatrace Service. Each method produces different entity types, metric key formats, and data flows. Understanding these differences is critical for the Cloud Migration Helper App.

Unlike AWS (which has three distinct flavours), Azure classic monitoring has two primary flavours that share the same `builtin:cloud.azure` settings configuration, plus an Azure Native integration that provides the same monitoring capabilities but is deployed from the Azure Marketplace.

---

## 1. The Two Flavours of Classic Azure Connections

### 1.1 Classic (formerly "Built-in") Services — Default Polling

| Property | Value |
|---|---|
| **Data Source** | Dynatrace Cluster (or Environment ActiveGate) polls Azure Monitor APIs on 5-minute intervals |
| **Configuration** | Via Dynatrace UI: Settings → Cloud and virtualization → Azure |
| **Settings Schema** | Classic Azure connections are managed through the **legacy Configuration API** (`GET/POST /api/config/v1/azure/credentials`), **not** through Settings 2.0. There is no `builtin:cloud.azure` schema. |
| **Environment ActiveGate** | Not required for classic (built-in) services in small environments |
| **Metric Selection** | Not possible — predefined set of metrics, cannot be customized |
| **Entities** | Full topology with **dedicated entity types** (e.g., `AZURE_VM`, `AZURE_SQL_SERVER`, `AZURE_COSMOS_DB`) |
| **Metric Key Prefix (Grail)** | `dt.cloud.azure.<service>.<metricName>` |
| **Metric Key Prefix (Classic Dynatrace - Cassandra)** | `builtin:cloud.azure.<service>.<metricName>` |
| **Tags** | Available (imported from Azure) |
| **DDU Consumption** | 0.001 DDU per data point (metric × dimension) |

This is the oldest and most feature-complete Azure monitoring approach. Dynatrace polls the Azure Monitor REST API to retrieve metrics for a curated set of services. Each built-in service has its own dedicated Dynatrace entity type with rich topology.

**Key characteristic**: Classic services use a predefined, non-configurable set of metrics. You cannot choose which metrics to monitor or add new ones.

### 1.2 Cloud Services — Non-Built-in Polling (Additional/Configurable Services)

| Property | Value |
|---|---|
| **Data Source** | Environment ActiveGate polls Azure Monitor APIs on 5-minute intervals |
| **Configuration** | Via Dynatrace UI: Settings → Cloud and virtualization → Azure → Manage services |
| **Settings Schema** | Same legacy Configuration API as classic services |
| **Environment ActiveGate** | **Required** — customer must install ActiveGate in their cloud environment |
| **Metric Selection** | **Configurable** — you can choose which metrics and dimensions to monitor per service |
| **Entities** | `CUSTOM_DEVICE` with type `cloud:azure:<provider>:<resource>` |
| **Parent Entity** | `CUSTOM_DEVICE_GROUP` (named per service, e.g., "Azure Cache for Redis", "Azure PostgreSQL Flexible Servers") |
| **Metric Key Prefix (Grail)** | `cloud.azure.microsoft_<provider>.<resource>.<metricname>` (all lowercase) |
| **Metric Key Prefix (Classic Dynatrace - Cassandra)** | `ext:cloud.azure.microsoft_<provider>.<resource>.<metricname>` |
| **Tags** | Available (imported from Azure) |
| **DDU Consumption** | 0.001 DDU per data point (metric × dimension) |

Cloud services are the newer, configurable alternative to classic built-in services. They allow monitoring of a much wider range of Azure services with customizable metrics. Some services exist as **both** classic and cloud service — you can migrate from the classic version to the cloud service version, but **cannot run both simultaneously** for the same service.

**Key characteristic**: Cloud services use `CUSTOM_DEVICE` entities with `cloud:azure:*` sub-types, and metric keys follow the Azure Monitor resource provider naming (`microsoft_<provider>.<resource>`).

### 1.3 Azure Native Dynatrace Service (Marketplace Integration)

| Property | Value |
|---|---|
| **Data Source** | Same Azure Monitor polling as above, but deployment is managed via Azure Portal |
| **Configuration** | Via Azure Portal → Azure Native Dynatrace Service resource |
| **Deployment** | Dynatrace environment is provisioned as an Azure-native resource |
| **ActiveGate** | Not required (managed by Azure) |
| **Metric collection** | Same classic + cloud services model after setup |
| **Log collection** | Subscription activity logs + Azure resource logs via Azure diagnostic settings |
| **OneAgent** | Can be deployed to VMs and App Services directly from Azure Portal |
| **SSO** | Microsoft Entra ID integration available |
| **Entities & Metrics** | Same as 1.1 and 1.2 — produces the same entity types and metric keys |

This is **not a different monitoring flavour** but rather a different **deployment model**. The Azure Native Dynatrace Service creates a Dynatrace environment linked to an Azure subscription, and then uses the same classic/cloud service monitoring infrastructure described above. The key difference is that configuration, billing, and lifecycle management happen through the Azure Portal rather than the Dynatrace UI.

---

## 2. Metric Key Format Comparison

### 2.1 Two Metric Key Prefixes (Grail)

| Prefix (Grail) | Source | Description | Example |
|---|---|---|---|
| `dt.cloud.azure.<service>.*` | Classic built-in services | Curated, Dynatrace-native metric keys with dedicated entity types | `dt.cloud.azure.vm.cpu_usage` |
| `cloud.azure.microsoft_<provider>.<resource>.<metric>` | Cloud services (non-built-in) | Azure Monitor metric names, following resource provider naming | `cloud.azure.microsoft_cache.redis.cachehits` |

> **Note**: The documentation references different prefixes for Classic Dynatrace (2nd generation; metrics stored in Cassandra, not Grail). When metrics get (automatically) forwarded from Cassandra to Grail, the prefix changed:
> - Classic built-in: `builtin:cloud.azure.*` → `dt.cloud.azure.*`
> - Cloud services: `ext:cloud.azure.*` → `cloud.azure.*`

### 2.2 Naming Pattern Examples

#### Virtual Machines

| Type | Metric Keys (Grail) |
|---|---|
| **Built-in (`dt.cloud.azure.`)** | `dt.cloud.azure.vm.cpu_usage`, `dt.cloud.azure.vm.disk.read`, `dt.cloud.azure.vm.disk.read_ops`, `dt.cloud.azure.vm.disk.write`, `dt.cloud.azure.vm.disk.write_ops`, `dt.cloud.azure.vm.network.bytes_in`, `dt.cloud.azure.vm.network.bytes_out` |

#### Azure Cache for Redis

| Type | Metric Keys (Grail) |
|---|---|
| **Built-in (`dt.cloud.azure.`)** | `dt.cloud.azure.redis.cache.hits`, `dt.cloud.azure.redis.cache.misses`, `dt.cloud.azure.redis.cache.read`, `dt.cloud.azure.redis.cache.write`, `dt.cloud.azure.redis.commands.get`, `dt.cloud.azure.redis.commands.set`, `dt.cloud.azure.redis.commands.total`, `dt.cloud.azure.redis.connected`, `dt.cloud.azure.redis.keys.evicted`, `dt.cloud.azure.redis.keys.expired`, `dt.cloud.azure.redis.keys.total`, `dt.cloud.azure.redis.memory.used`, `dt.cloud.azure.redis.memory.usedRss`, `dt.cloud.azure.redis.load`, `dt.cloud.azure.redis.processorTime` |
| **Cloud service** | `cloud.azure.microsoft_cache.redis.cachehits`, `cloud.azure.microsoft_cache.redis.cachemisses`, `cloud.azure.microsoft_cache.redis.cachemissrate`, `cloud.azure.microsoft_cache.redis.connectedclients`, `cloud.azure.microsoft_cache.redis.percentprocessortime`, `cloud.azure.microsoft_cache.redis.totalcommandsprocessed`, `cloud.azure.microsoft_cache.redis.usedmemorypercentage` |

#### Azure Load Balancer

| Type | Metric Keys (Grail) |
|---|---|
| **Built-in (`dt.cloud.azure.`)** | `dt.cloud.azure.loadbalancer.availability.dip_tcp`, `dt.cloud.azure.loadbalancer.availability.dip_udp`, `dt.cloud.azure.loadbalancer.availability.vip`, `dt.cloud.azure.loadbalancer.snat_connection.est`, `dt.cloud.azure.loadbalancer.snat_connection.pending`, `dt.cloud.azure.loadbalancer.snat_connection.rej`, `dt.cloud.azure.loadbalancer.traffic.byte_in`, `dt.cloud.azure.loadbalancer.traffic.byte_out`, `dt.cloud.azure.loadbalancer.traffic.packet_in`, `dt.cloud.azure.loadbalancer.traffic.packet_out`, `dt.cloud.azure.loadbalancer.traffic.packet_syn_in`, `dt.cloud.azure.loadbalancer.traffic.packet_syn_out` |
| **Cloud service (Standard LB)** | `cloud.azure.microsoft_network.loadbalancers.dipavailability`, `cloud.azure.microsoft_network.loadbalancers.vipavailability` |

#### Azure Storage Account

| Type | Metric Keys (Grail) |
|---|---|
| **Built-in (`dt.cloud.azure.`)** | `dt.cloud.azure.storage.blob.capacity`, `dt.cloud.azure.storage.blob.containers`, `dt.cloud.azure.storage.blob.entities`, `dt.cloud.azure.storage.blob.transactions`, `dt.cloud.azure.storage.blob.transactions.network.*`, `dt.cloud.azure.storage.file.*`, `dt.cloud.azure.storage.queue.*`, `dt.cloud.azure.storage.table.*` |
| **Cloud service** | `cloud.azure.microsoft_storage.storageaccounts.transactions`, `cloud.azure.microsoft_storage.storageaccounts.usedcapacity`, `cloud.azure.microsoft_storage.storageaccounts.blobservices.*`, `cloud.azure.microsoft_storage.storageaccounts.fileservices.*`, etc. |

---

## 3. Classic vs Cloud Service Migration Mapping

Dynatrace provides a migration path from classic built-in services to configurable cloud services. The following table shows the mapping:

| Cloud Service | Classic Service (Deprecated) |
|---|---|
| Azure API Management Service | Azure API Management services (built-in) *(deprecated)* |
| Azure Application Gateway | Azure Application Gateway (built-in) |
| Azure Basic/Gateway/Standard Load Balancer | Azure Load Balancer (built-in) |
| Azure Cache for Redis | Azure Redis (built-in) |
| Azure Cosmos DB Account (GlobalDocumentDB) | Azure Cosmos DB (built-in) |
| Azure Cosmos DB Account (MongoDB) | Azure Cosmos DB (built-in) |
| Azure IoT Hub | Azure IoT Hubs (built-in) |
| Azure SQL Server | Azure SQL (built-in) |
| Azure SQL Database (DTU) | Azure SQL (built-in) |
| Azure SQL Database (vCore) | Azure SQL (built-in) |
| Azure SQL elastic pool (DTU) | Azure SQL (built-in) |
| Azure SQL elastic pool (vCore) | Azure SQL (built-in) |
| Azure Storage Account | Azure Storage accounts (built-in) |
| Azure Storage Blob/File/Queue/Table Services | Azure Storage accounts (built-in) |

> **Important Migration Impact**:
> - Classic and cloud services monitor the **same Azure resources** but are treated as **two different Dynatrace entities** with different entity IDs and metric keys.
> - You **cannot run both simultaneously** for the same service — enabling the cloud version automatically disables the classic version, and vice versa.
> - Historical data remains on the classic service entity. If you switch back, there will be gaps for the period the cloud service was active.
> - There is **no direct link** between the classic entity and the cloud service entity containing the new data.
> - Dashboards, alerts, and management zones based on entity IDs or metric keys must be updated after migration.

---

## 4. Entity Model

### 4.1 Classic Built-in Entity Types (Dedicated)

These services have their own first-class Dynatrace entity types (not `CUSTOM_DEVICE`):

| Entity Type | ID Prefix | Azure Service |
|---|---|---|
| `AZURE_VM` | `AZURE_VM-` | Virtual Machines |
| `AZURE_VM_SCALE_SET` | `AZURE_VM_SCALE_SET-` | VM Scale Sets |
| `AZURE_LOAD_BALANCER` | `AZURE_LOAD_BALANCER-` | Load Balancer |
| `AZURE_EVENT_HUB_NAMESPACE` | `AZURE_EVENT_HUB_NAMESPACE-` | Event Hub Namespace |
| `AZURE_EVENT_HUB` | `AZURE_EVENT_HUB-` | Event Hub |
| `AZURE_REDIS_CACHE` | `AZURE_REDIS_CACHE-` | Redis Cache |
| `AZURE_FUNCTION_APP` | `AZURE_FUNCTION_APP-` | Function App |
| `AZURE_STORAGE_ACCOUNT` | `AZURE_STORAGE_ACCOUNT-` | Storage Account |
| `AZURE_COSMOS_DB` | `AZURE_COSMOS_DB-` | Cosmos DB |
| `AZURE_WEB_APP` | `AZURE_WEB_APP-` | Web App (App Service) |
| `AZURE_SQL_SERVER` | `AZURE_SQL_SERVER-` | SQL Server |
| `AZURE_SQL_DATABASE` | `AZURE_SQL_DATABASE-` | SQL Database |
| `AZURE_SQL_ELASTIC_POOL` | `AZURE_SQL_ELASTIC_POOL-` | SQL Elastic Pool |
| `AZURE_IOT_HUB` | `AZURE_IOT_HUB-` | IoT Hub |
| `AZURE_API_MANAGEMENT_SERVICE` | `AZURE_API_MANAGEMENT_SERVICE-` | API Management |
| `AZURE_APPLICATION_GATEWAY` | `AZURE_APPLICATION_GATEWAY-` | Application Gateway |
| `AZURE_SERVICE_BUS_NAMESPACE` | `AZURE_SERVICE_BUS_NAMESPACE-` | Service Bus Namespace |
| `AZURE_SERVICE_BUS_QUEUE` | `AZURE_SERVICE_BUS_QUEUE-` | Service Bus Queue |
| `AZURE_SERVICE_BUS_TOPIC` | `AZURE_SERVICE_BUS_TOPIC-` | Service Bus Topic |

#### Topology-only Entity Types (Infrastructure)

| Entity Type | ID Prefix | Purpose |
|---|---|---|
| `AZURE_CREDENTIALS` | `AZURE_CREDENTIALS-` | Azure connection itself |
| `AZURE_SUBSCRIPTION` | `AZURE_SUBSCRIPTION-` | Azure Subscription |
| `AZURE_TENANT` | `AZURE_TENANT-` | Azure Entra Tenant |
| `AZURE_MGMT_GROUP` | `AZURE_MGMT_GROUP-` | Management Group |
| `AZURE_REGION` | `AZURE_REGION-` | Azure Region |

### 4.2 Non-Built-in (Cloud Service) Entities (Custom Devices)

Cloud services create entities under the `CUSTOM_DEVICE` type with a `cloud:azure:*` sub-type:

| Entity Type (sub-type) | ID Prefix | Azure Service |
|---|---|---|
| `cloud:azure:storage:storageaccounts` | `CUSTOM_DEVICE-` | Storage Account |
| `cloud:azure:storage:storageaccounts:blob` | `CUSTOM_DEVICE-` | Storage Blob |
| `cloud:azure:storage:storageaccounts:file` | `CUSTOM_DEVICE-` | Storage File |
| `cloud:azure:storage:storageaccounts:queue` | `CUSTOM_DEVICE-` | Storage Queue |
| `cloud:azure:storage:storageaccounts:table` | `CUSTOM_DEVICE-` | Storage Table |
| `cloud:azure:network:networkinterfaces` | `CUSTOM_DEVICE-` | Network Interface |
| `cloud:azure:postgresql:flexibleservers` | `CUSTOM_DEVICE-` | PostgreSQL Flexible Servers |
| `cloud:azure:network:publicipaddresses` | `CUSTOM_DEVICE-` | Public IP Address |
| `cloud:azure:cache:redis` | `CUSTOM_DEVICE-` | Cache for Redis |
| `cloud:azure:network:loadbalancers:standard` | `CUSTOM_DEVICE-` | Standard Load Balancer |
| `cloud:azure:containerservice:managedcluster` | `CUSTOM_DEVICE-` | AKS Managed Cluster |
| `cloud:azure:cognitiveservices:openai` | `CUSTOM_DEVICE-` | Azure OpenAI |
| `cloud:azure:apimanagement:service` | `CUSTOM_DEVICE-` | API Management |
| `cloud:azure:network:dnszones` | `CUSTOM_DEVICE-` | DNS Zone |

Parent grouping: `CUSTOM_DEVICE_GROUP` entities per service (e.g., "Azure Cache for Redis", "Azure PostgreSQL Flexible Servers").

### 4.3 Entity Hierarchy

```
AZURE_TENANT (Entra Directory)
├── AZURE_MGMT_GROUP (optional)
│   └── AZURE_SUBSCRIPTION
└── AZURE_SUBSCRIPTION
    ├── AZURE_CREDENTIALS (connection — belongs_to subscription)
    │   └── can_access → CUSTOM_DEVICE, CUSTOM_DEVICE_GROUP
    ├── AZURE_REGION (topology)
    │   ├── AZURE_VM (built-in)
    │   ├── AZURE_LOAD_BALANCER (built-in)
    │   ├── AZURE_APPLICATION_GATEWAY (built-in)
    │   ├── AZURE_SQL_SERVER (built-in)
    │   │   ├── AZURE_SQL_DATABASE
    │   │   └── AZURE_SQL_ELASTIC_POOL
    │   │       └── AZURE_SQL_DATABASE
    │   ├── AZURE_EVENT_HUB_NAMESPACE (built-in)
    │   │   └── AZURE_EVENT_HUB
    │   ├── AZURE_SERVICE_BUS_NAMESPACE (built-in)
    │   │   ├── AZURE_SERVICE_BUS_QUEUE
    │   │   └── AZURE_SERVICE_BUS_TOPIC
    │   ├── AZURE_COSMOS_DB (built-in)
    │   ├── AZURE_REDIS_CACHE (built-in)
    │   ├── AZURE_IOT_HUB (built-in)
    │   ├── AZURE_API_MANAGEMENT_SERVICE (built-in)
    │   ├── AZURE_STORAGE_ACCOUNT (built-in)
    │   │   └── AZURE_EVENT_HUB (storage-backed)
    │   └── CUSTOM_DEVICE (cloud:azure:* sub-types)
    ├── CUSTOM_DEVICE (belongs_to subscription)
    └── CUSTOM_DEVICE_GROUP (per service, belongs_to subscription)
        └── CUSTOM_DEVICE (cloud:azure:* instances)
```

> **Note**: `AZURE_SUBSCRIPTION` → `can_access` relationship grants access to built-in entities (AZURE_VM, AZURE_SQL_SERVER, etc.). The `AZURE_CREDENTIALS` → `can_access` only references `CUSTOM_DEVICE` and `CUSTOM_DEVICE_GROUP` (non-built-in cloud services).

### 4.4 Full List of Documented `cloud:azure:*` Entity Types

From the Dynatrace documentation, the known set of cloud service entity types (partial list of most common):

`cloud:azure:apimanagement:service`, `cloud:azure:app:containerapps`, `cloud:azure:app:managedenvironments`, `cloud:azure:appconfiguration:configurationstores`, `cloud:azure:appplatform:spring`, `cloud:azure:automation:automationaccounts`, `cloud:azure:batch:account`, `cloud:azure:cache:redis`, `cloud:azure:cdn:cdnwebapplicationfirewallpolicies`, `cloud:azure:cdn:profiles`, `cloud:azure:classic_virtual_machine`, `cloud:azure:classic_storage_account`, `cloud:azure:classic_storage_account:blob`, `cloud:azure:classic_storage_account:file`, `cloud:azure:classic_storage_account:queue`, `cloud:azure:classic_storage_account:table`, `cloud:azure:cognitiveservices:openai`, `cloud:azure:cognitiveservices:allinone`, `cloud:azure:cognitiveservices:speech`, `cloud:azure:cognitiveservices:textanalytics`, `cloud:azure:containerinstance:containergroup`, `cloud:azure:containerregistry:registries`, `cloud:azure:containerservice:managedcluster`, `cloud:azure:datafactory:v1`, `cloud:azure:datafactory:v2`, `cloud:azure:datalakeanalytics:accounts`, `cloud:azure:datalakestore:accounts`, `cloud:azure:datashare:accounts`, `cloud:azure:devices:iothubs`, `cloud:azure:devices:provisioningservices`, `cloud:azure:documentdb:databaseaccounts:global`, `cloud:azure:documentdb:databaseaccounts:mongo`, `cloud:azure:eventgrid:domains`, `cloud:azure:eventgrid:systemtopics`, `cloud:azure:eventgrid:topics`, `cloud:azure:eventhub:clusters`, `cloud:azure:hdinsight:cluster`, `cloud:azure:hybridcompute:machines`, `cloud:azure:insights:components`, `cloud:azure:iotcentral:iotapps`, `cloud:azure:keyvault:vaults`, `cloud:azure:kusto:clusters`, `cloud:azure:logic:integrationserviceenvironments`, `cloud:azure:logic:workflows`, `cloud:azure:machinelearningservices:workspaces`, `cloud:azure:maps:accounts`, `cloud:azure:mariadb:server`, `cloud:azure:media:mediaservices`, `cloud:azure:media:mediaservices:streamingendpoints`, `cloud:azure:mysql:flexibleservers`, `cloud:azure:mysql:server`, `cloud:azure:netapp:netappaccounts:capacitypools`, `cloud:azure:netapp:netappaccounts:capacitypools:volumes`, `cloud:azure:network:applicationgateways`, `cloud:azure:network:azurefirewalls`, `cloud:azure:network:dnszones`, `cloud:azure:network:expressroutecircuits`, `cloud:azure:network:loadbalancers:basic`, `cloud:azure:network:loadbalancers:gateway`, `cloud:azure:network:loadbalancers:standard`, `cloud:azure:network:networkinterfaces`, `cloud:azure:network:networkwatchers:connectionmonitors`, `cloud:azure:network:privatednszones`, `cloud:azure:network:publicipaddresses`, `cloud:azure:notificationhubs:namespaces:notificationhubs`, `cloud:azure:postgresql:flexibleservers`, `cloud:azure:postgresql:server`, `cloud:azure:postgresql:serverv2`, `cloud:azure:powerbidedicated:capacities`, `cloud:azure:recoveryservices:vaults`, `cloud:azure:relay:namespaces`, `cloud:azure:search:searchservices`, `cloud:azure:servicefabricmesh:applications`, `cloud:azure:signalrservice:signalr`, `cloud:azure:sql:managed`, `cloud:azure:sql:servers`, `cloud:azure:sql:servers:databases:datawarehouse`, `cloud:azure:sql:servers:databases:dtu`, `cloud:azure:sql:servers:databases:hyperscale`, `cloud:azure:sql:servers:databases:vcore`, `cloud:azure:sql:servers:elasticpools:dtu`, `cloud:azure:sql:servers:elasticpools:vcore`, `cloud:azure:storage:storageaccounts`, `cloud:azure:storage:storageaccounts:blob`, `cloud:azure:storage:storageaccounts:file`, `cloud:azure:storage:storageaccounts:queue`, `cloud:azure:storage:storageaccounts:table`, `cloud:azure:storagesync:storagesyncservices`, `cloud:azure:streamanalytics:streamingjobs`, `cloud:azure:synapse:workspaces`, `cloud:azure:synapse:workspaces:bigdatapools`, `cloud:azure:synapse:workspaces:sqlpools`, `cloud:azure:timeseriesinsights:environments`, `cloud:azure:traffic_manager_profile`, `cloud:azure:virtual_network_gateway`, `cloud:azure:web:hostingenvironments:v2`, `cloud:azure:web:serverfarms`, `cloud:azure:web:appslots`, `cloud:azure:web:functionslots`, `cloud:azure:frontdoor`

---

## 5. Disambiguating Classic vs New Azure Connection

### `dt.da.source` Values

> **Critical**: Classic Azure connections **never** set `dt.da.source`. Any non-null `dt.da.source` value containing `azure` originates from the **new Azure connection**.

| `dt.da.source` Value | Origin |
|---|---|
| `azure-metric-poller` | **New** Azure connection (metric polling) |
| `azure-smartscape-poller-*` | **New** Azure connection (topology discovery) |
| (null) | **Classic** connection |

### How to Tell Classic from New

| Dimension / Rule | Connection Type |
|---|---|
| `dt.da.source` is null | **Classic** connection |
| `dt.da.source == "azure-metric-poller"` + smartscape dimensions present | **New** Azure connection |
| `dt.source_entity.type` is a built-in entity type (e.g., `azure_vm`, `azure_redis_cache`) | Built-in classic service |
| `dt.source_entity.type` starts with `cloud:azure:` | Cloud service (non-built-in classic) |
| `dt.source_entity.type == "azure_subscription"` | Account/region-level aggregated metrics (classic) |
| `dt.metrics.source == "openpipeline:logs"` | Log-derived Azure metrics |

> **Warning — Parallel Ingestion**: The new Azure connection creates **Smartscape on Grail** entities (e.g., `AZURE_VM_INSTANCE`), which are completely separate from classic entities (e.g., `AZURE_VM`). Classic entities live in Cassandra and are queried with `fetch dt.entity.<type>`; Smartscape on Grail entities live in Grail and are queried with `smartscapeNodes <EntityType>`. When both connections coexist, entities from both systems will be present for the same Azure resources.

---

## 6. Settings & Configuration

### 6.1 Classic Azure Connection Configuration

Classic Azure connections are managed through the **legacy Configuration API** (v1), not through the Settings 2.0 framework:

| API Endpoint | Purpose |
|---|---|
| `GET /api/config/v1/azure/credentials` | List all classic Azure connections |
| `POST /api/config/v1/azure/credentials` | Create a new classic Azure connection |
| `GET /api/config/v1/azure/credentials/{id}` | Get specific connection details |
| `GET /api/config/v1/azure/supportedServices` | List all available Azure services on the cluster |

### 6.2 Related Settings Schemas

| Schema ID | Purpose |
|---|---|
| `builtin:hyperscaler-authentication.connections.azure` | New Azure cloud platform connections (NOT classic) |
| `builtin:logmonitoring.azure-log-forwarding-configuration` | Azure log forwarding configuration |
| `app:dynatrace.azure.connector:microsoft-entra-identity-developer-connection` | Azure connector Entra ID developer connection |

> **Note**: Unlike AWS (which has `builtin:cloud.aws`), there is **no** `builtin:cloud.azure` settings schema. Classic Azure connections predate the Settings 2.0 framework entirely.

### 6.3 Authentication

Classic Azure connections use Azure Active Directory (Entra ID) app registration with:
- **Directory (tenant) ID**
- **Application (client) ID**  
- **Client secret** (or certificate)
- **Subscription scope** (one or more Azure subscriptions to monitor)

Required Azure RBAC role: **Reader** role on monitored subscriptions (or management group).

---

## 7. Metric Key Prefix by Entity Type

### 7.1 Built-in Entity Metrics (`dt.cloud.azure.*`)

| Entity Type | Metric Key Prefix (Grail) | Sample Metrics |
|---|---|---|
| `azure_vm` | `dt.cloud.azure.vm.*` | `cpu_usage`, `disk.read`, `disk.read_ops`, `disk.write`, `disk.write_ops`, `network.bytes_in`, `network.bytes_out` |
| `azure_vm_scale_set` | `dt.cloud.azure.vm_scale_set.*` | `cpu_usage`, `disk.read`, `disk.read_ops`, `disk.write`, `disk.write_ops`, `network.bytes_in`, `network.bytes_out` |
| `azure_load_balancer` | `dt.cloud.azure.loadbalancer.*` | `availability.dip_tcp`, `availability.dip_udp`, `availability.vip`, `snat_connection.*`, `traffic.*` |
| `azure_redis_cache` | `dt.cloud.azure.redis.*` | `cache.hits`, `cache.misses`, `cache.read`, `cache.write`, `commands.*`, `connected`, `keys.*`, `memory.*`, `load`, `processorTime` |
| `azure_cosmos_db` | `dt.cloud.azure.cosmos.*` | `available_storage`, `data_usage`, `document_count`, `document_quota`, `index_usage`, `metadata_requests`, `provisioned_throughput`, `replication_latency`, `request_units`, `requests`, `service_availability`, `normalized_ru_consumption` |
| `azure_iot_hub` | `dt.cloud.azure.iot_hub.*` | `command.*`, `device.*`, `event_hub.*`, `messages.*`, `service_bus.*`, `storage_endpoints.*` |
| `azure_event_hub` | `dt.cloud.azure.event_hub.*` | `capture.*`, `errors.*`, `requests.*`, `traffic.*` |
| `azure_event_hub_namespace` | `dt.cloud.azure.event_hub_namespace.*` | `connections.active`, `connections.closed`, `connections.opened` |
| `azure_service_bus_namespace` | `dt.cloud.azure.service_bus.namespace.*` | `connections.active`, `errors.*`, `messages.*`, `requests.*` |
| `azure_service_bus_queue` | `dt.cloud.azure.service_bus.queue.*` | `errors.*`, `messages.*`, `requests.*` |
| `azure_service_bus_topic` | `dt.cloud.azure.service_bus.topic.*` | `errors.*`, `messages.*`, `requests.*` |
| `azure_storage_account` | `dt.cloud.azure.storage.*` | `blob.*`, `file.*`, `queue.*`, `table.*` (transactions, capacity, latency, egress/ingress) |
| `azure_function_app` | `dt.cloud.azure.app_service.functions.*` | `execution.count`, `http.status.*`, `io.*`, `traffic.*` |
| `azure_web_app` | `dt.cloud.azure.app_service.*` | `http.status.*`, `io.*`, `response.avg`, `traffic.*` |
| `azure_subscription` | `dt.cloud.azure.region.*` / `dt.cloud.azure.vm_scale_set.*` | `vms.initializing`, `vms.running`, `vms.stopped` (regional aggregates) |

### 7.2 Cloud Service Metrics (`cloud.azure.microsoft_*`)

| Entity Type (`cloud:azure:*`) | Metric Key Prefix (Grail) | Sample Metrics |
|---|---|---|
| `cloud:azure:cache:redis` | `cloud.azure.microsoft_cache.redis.*` | `cachehits`, `cachemisses`, `cachemissrate`, `connectedclients`, `percentprocessortime`, `totalcommandsprocessed`, `usedmemorypercentage` |
| `cloud:azure:containerservice:managedcluster` | `cloud.azure.microsoft_containerservice.managedclusters.*` | `kube_node_status_allocatable_cpu_cores`, `kube_node_status_condition`, `kube_pod_status_phase`, `kube_pod_status_ready`, `node_cpu_usage_percentage`, `node_memory_working_set_*` |
| `cloud:azure:postgresql:flexibleservers` | `cloud.azure.microsoft_dbforpostgresql.flexibleservers.*` | `active_connections`, `backup_storage_used`, `connections_failed`, `cpu_percent`, `disk_queue_depth`, `iops`, `memory_percent`, `network_bytes_*`, `read_iops`, `storage_*`, `write_iops` |
| `cloud:azure:cognitiveservices:openai` | `cloud.azure.microsoft_cognitiveservices.accounts.*` | `blockedcalls`, `clienterrors`, `datain`, `dataout`, `generatedtokens`, `latency`, `processedprompttokens`, `ratelimit`, `successfulcalls`, `successrate` |
| `cloud:azure:storage:storageaccounts` | `cloud.azure.microsoft_storage.storageaccounts.*` | `transactions`, `usedcapacity` |
| `cloud:azure:storage:storageaccounts:blob` | `cloud.azure.microsoft_storage.storageaccounts.blobservices.*` | `blobcapacity`, `transactions` |
| `cloud:azure:apimanagement:service` | `cloud.azure.microsoft_apimanagement.service.*` | `capacity`, `requests` |
| `cloud:azure:network:loadbalancers:standard` | `cloud.azure.microsoft_network.loadbalancers.*` | `dipavailability`, `vipavailability` |
| `cloud:azure:network:networkinterfaces` | `cloud.azure.microsoft_network.networkinterfaces.*` | `bytesreceivedrate`, `bytessentrate`, `packetsreceivedrate` |
| `cloud:azure:network:publicipaddresses` | `cloud.azure.microsoft_network.publicipaddresses.*` | `bytecount`, `packetcount`, `syncount`, `vipavailability` |
| `cloud:azure:network:dnszones` | `cloud.azure.microsoft_network.dnszones.*` | `recordsetcapacityutilization`, `recordsetcount` |

---

## 8. Metric Key Prefix Summary

| Metric Key Pattern (Grail) | Connection Type | Entity Type | Notes |
|---|---|---|---|
| `dt.cloud.azure.<service>.<metric>` | Built-in classic service | Dedicated type (e.g., `AZURE_VM`, `AZURE_REDIS_CACHE`) | Curated, Dynatrace-native, snake_case names |
| `cloud.azure.microsoft_<provider>.<resource>.<metric>` | Cloud service (non-built-in classic) | `CUSTOM_DEVICE` (`cloud:azure:*`) | Azure Monitor resource provider naming, all lowercase |
| `dac.azure_*` | **New** Azure connection (NOT classic) | Smartscape on Grail entities | Data acquisition metrics — filter out for classic analysis |

---

## 9. Key Differences from AWS Classic

| Aspect | Azure Classic | AWS Classic |
|---|---|---|
| **Connection flavours** | 2 (built-in + cloud services) | 3 (built-in + non-built-in + metric streams) |
| **Configuration API** | Legacy Config API v1 (no Settings 2.0) | Settings 2.0 `builtin:cloud.aws` |
| **Push-based ingestion** | Not available | CloudWatch Metric Streams |
| **Built-in → Cloud migration** | Explicit migration (cannot run both simultaneously) | Built-in and non-built-in can coexist for different services |
| **Cloud service metric naming** | `cloud.azure.microsoft_<provider>.<resource>.<metric>` | `cloud.aws.<service>.<MetricName>.By.<Dim>` |
| **Built-in metric naming** | `dt.cloud.azure.<service>.<metric>` | `dt.cloud.aws.<service>.<metric>` |
| **Topology hierarchy** | Tenant → MgmtGroup → Subscription → Region → Resources | Credentials → AZ → Resources |
| **Entity Hierarchy Depth** | Deeper (Tenant/MgmtGroup/Subscription/Region layers) | Shallower (Credentials/AZ) |

---

## 10. DQL Query Patterns for Classic Azure Data

### 11.1 Find All Classic Azure Entities

```dql
// Built-in entities
fetch dt.entity.azure_vm | limit 10
fetch dt.entity.azure_credentials | limit 10
fetch dt.entity.azure_subscription | limit 10

// Non-built-in (custom device) entities
fetch dt.entity.custom_device
| filter contains(toString(entity.type), "cloud:azure")
| summarize cnt=count(), by:{entity.type}
| sort cnt desc
```

### 11.2 Identify Metric Source Type

```dql
fetch metric.series
| fields metric.key, dt.da.source, dt.source_entity.type, dt.source, dt.metrics.source
| filter contains(metric.key, "azure")
| filterOut startsWith(metric.key, "remote_dsfm.")
| filterOut startsWith(metric.key, "dt.sfm.")
| summarize cnt=count(), by:{dt.da.source, dt.source_entity.type, dt.source, dt.metrics.source}
| sort cnt desc
```

### 11.3 List All Cloud Service Metrics

```dql
fetch metric.series
| fields metric.key, dt.source_entity.type
| filter startsWith(metric.key, "cloud.azure.") AND contains(toString(dt.source_entity.type), "cloud:azure:")
| summarize cnt=count(), by:{metric.key, dt.source_entity.type}
| sort dt.source_entity.type asc, metric.key asc
```

### 11.4 Comprehensive Metric Analysis (All Classic Sources)

```dql
fetch metric.series
| fields metric.key, azure.subscription, azure.management_group, dt.source_entity, dt.da.source, azure.resource.type, dt.entity.custom_device, dt.source_entity.type, dt.metrics.source, dt.system.monitoring_source, dt.source
| filter contains(metric.key, "azure")
| filterOut startsWith(metric.key, "dac.azure_")
| filterOut startsWith(metric.key, "remote_dsfm.server.azure.")
| filterOut startsWith(metric.key, "remote_dsfm.active_gate.azure.")
| filterOut dt.system.monitoring_source == "fullstack_host"
| filterOut startsWith(metric.key, "dt.sfm.active_gate.azure.") OR startsWith(metric.key, "dt.sfm.server.azure.")
| summarize count(), by:{metric.key, azure.subscription, dt.system.monitoring_source, dt.da.source, azure.resource.type, dt.source_entity.type, dt.source, dt.metrics.source}
```

---

## 11. Key Differences Summary

| Aspect | Built-in Classic | Cloud Services (Non-Built-in) |
|---|---|---|
| **Metric prefix** | `dt.cloud.azure.*` | `cloud.azure.microsoft_*` |
| **Entity type** | Dedicated (e.g., `AZURE_VM`) | `CUSTOM_DEVICE` (`cloud:azure:*`) |
| **`dt.da.source`** | (null) | (null) — **not** `azure-metric-poller` (that's new connection) |
| **`dt.source_entity.type`** | Built-in type name (lowercase) | `cloud:azure:<provider>:<resource>` |
| **Metric naming** | Dynatrace-curated, snake_case | Azure Monitor names, all lowercase |
| **Metric configurability** | Fixed — cannot customize | Configurable per service |
| **ActiveGate requirement** | Not required (small envs) | Required |
| **Collection** | Pull (ActiveGate/Cluster → Azure Monitor API) | Pull (ActiveGate → Azure Monitor API) |
| **Interval** | 5 minutes | 5 minutes |
| **Tags** | Yes | Yes |
| **Topology** | Full — dedicated entity types with rich relationships | Custom device topology |

---

## 12. Migration Relevance

When assisting with cloud migration, the app needs to:

1. **Detect which classic connection flavours are active** — query `AZURE_CREDENTIALS` entities and identify metric sources by `dt.source_entity.type`
2. **Identify built-in vs cloud service split** — some services (e.g., Redis, Load Balancer, Storage) may exist as *both* built-in entities and cloud service custom devices, but never simultaneously for the same resource
3. **Map entities to the correct metric patterns** — `dt.cloud.azure.*` for built-in, `cloud.azure.microsoft_*` for cloud services
4. **Understand the classic-to-cloud-service migration** — switching from a built-in to a cloud service creates a new entity with different ID and metric keys, breaking existing dashboards and alerts
5. **Detect the classic Configuration API** — classic Azure connections are NOT in Settings 2.0 (`builtin:cloud.azure` does not exist); they use the legacy `/api/config/v1/azure/credentials` endpoint
6. **Detect parallel classic + new connection** — when both classic and new Azure connections are active for the same subscription, entities from both systems (classic + Smartscape on Grail) will coexist
7. **Flag log forwarding configuration (future scope)** — classic Azure log ingest uses Azure diagnostic settings and Event Hub, configured via `builtin:logmonitoring.azure-log-forwarding-configuration`. Log migration is per-connection/subscription, not per-service. Out of scope for the initial implementation.
