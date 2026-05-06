# Scanning Dashboards for Metric and Entity References

> **Purpose**: Describes how the Cloud Migration Helper discovers which metrics and entities are referenced in Dynatrace dashboards — both classic (ME model) and new (DQL-based).

## Key Finding

**DQL cannot query document content.** The Document Service stores dashboard content as an opaque blob. There is no `fetch documents` DQL command. Dashboard scanning **must** use the Document Service API (`@dynatrace-sdk/client-document`) to list and download dashboard content, then parse the JSON client-side.

---

## Two Dashboard Formats

Dynatrace environments may contain both classic and new dashboards. Each requires a different API and parsing approach.

### New Dashboards (Document Service / DQL-based)

New dashboards are stored as **documents** in the Document Service with `type: "dashboard"`. The content is a JSON blob containing tiles, each with a `query` field holding a DQL string.

#### Retrieval: Document Service API

```ts
import { documentsClient } from "@dynatrace-sdk/client-document";

// Step 1: List all dashboards
const dashboards = await documentsClient.listDocuments({
  filter: "type = 'dashboard'",
  pageSize: 1000,
});

// Step 2: Download content for each dashboard
for (const doc of dashboards.documents) {
  const { content } = await documentsClient.getDocument({ id: doc.id });
  const parsed = JSON.parse(await content.text());

  // Step 3: Walk all tiles, extract query strings
  for (const [key, tile] of Object.entries(parsed.tiles ?? {})) {
    if (tile.type === "data" && tile.query) {
      // tile.query contains the raw DQL string
      // Parse it for metric keys and entity references
    }
  }
}
```

#### What to scan in the DQL query strings

| Pattern to detect | What it means | Example |
|---|---|---|
| `fetch dt.entity.<type>` | Classic entity reference | `fetch dt.entity.ec2_instance` |
| `smartscapeNodes <Type>` | New Smartscape entity reference | `smartscapeNodes AWS_EC2_INSTANCE` |
| `timeseries <metric_key>` | Metric selector (classic or new) | `timeseries avg(dt.cloud.aws.ec2.cpu.usage)` |
| `fetch metric.series` + filter on `metric.key` | DQL metric query | `filter startsWith(metric.key, "cloud.aws.")` |
| Entity ID literals | Hardcoded entity references | `EC2_INSTANCE-ABC123`, `CUSTOM_DEVICE-DEF456` |
| `dt.entity.<type>` in filter expressions | Entity type scoping | `filter dt.entity.aws_lambda_function == "..."` |

#### Permissions

- Requires `document:documents:read` scope
- To scan dashboards owned by other users, the app needs `document:documents:admin` permission and must pass `adminAccess: true`

#### Constraints

- `listDocuments` returns max 1000 per page — paginate with `pageKey`
- Content is opaque — no server-side filtering on content; all matching happens client-side after download
- Consider caching scan results to avoid repeated expensive full scans

---

### Classic Dashboards (ME Model / Metric Expressions)

Classic dashboards use the older **Dashboards API** (`/api/config/v1/dashboards`). Their tiles reference metrics via **metric selectors** (not DQL) and entities via **entity selectors**.

#### Retrieval: Dashboards Config API v1

```bash
# List all classic dashboards
curl -X GET "https://{env-id}.apps.dynatrace.com/api/config/v1/dashboards" \
  -H "Authorization: Api-Token {token}"

# Get full dashboard definition with tiles
curl -X GET "https://{env-id}.apps.dynatrace.com/api/config/v1/dashboards/{dashboard-id}" \
  -H "Authorization: Api-Token {token}"
```

#### Tile types and where metrics/entities live

| Tile Type | Where metrics/entities live |
|---|---|
| **DATA_EXPLORER** | `queries[].metric` (metric selector), `queries[].filterBy.nestedFilters[].criteria[].value` (entity IDs), `queries[].entityType` |
| **CUSTOM_CHARTING** | `filterConfig.chartConfig.series[].metric` (metric key), `filterConfig.chartConfig.series[].dimensions[].values` (entity IDs), `filterConfig.filtersPerEntityType` |
| **SLO** | `sloId` → then look up the SLO definition separately |
| **DTAQL** (User Sessions) | `query` field with USQL |
| **MARKDOWN** | May contain hardcoded entity URLs |
| **HOSTS / SERVICES / APPLICATIONS** | `filterConfig.entityFilter` with entity type and entity selectors |

#### What to extract from classic tiles

- **Metric selectors**: `builtin:cloud.aws.*`, `ext:cloud.aws.*`, `builtin:cloud.azure.*` — classic cloud metric keys
- **Entity selectors**: `type("EC2_INSTANCE")`, `entityId("EC2_INSTANCE-ABC123")`, `type("CUSTOM_DEVICE"),tag("cloud:aws:*")`
- **Management zone filters**: `filterConfig.managementZoneId` or `managementZone.id`

---

## Summary: Scanning Strategy for the Migration Helper

| Step | Classic Dashboards | New Dashboards |
|---|---|---|
| **List** | Config API v1 `/dashboards` | Document Service `listDocuments` with `type = 'dashboard'` |
| **Download** | Config API v1 `/dashboards/{id}` | Document Service `getDocument` / `downloadDocumentContent` |
| **Parse** | Walk tile JSON, extract `metric` and entity selector fields | Walk tile JSON, extract `query` DQL strings |
| **Detect cloud refs** | Regex/string match on metric selectors for `builtin:cloud.*`, `ext:cloud.*`, `cloud.aws.*`, `cloud.azure.*` | Regex/string match on DQL strings for same metric key patterns + `fetch dt.entity.<cloud_type>` |
| **Entity detection** | Parse entity selectors for cloud entity types | Parse DQL for `fetch dt.entity.*` and entity ID literals |
| **Permission** | Requires `ReadConfig` API token permission | Requires `document:documents:read` scope (+ `document:documents:admin` for all users' dashboards) |

### Notebooks

Notebooks follow the same Document Service pattern as new dashboards — they are documents with `type: "notebook"` containing sections with DQL queries. The same scanning approach applies: list via `listDocuments`, download content, parse JSON, extract DQL strings from query sections.
