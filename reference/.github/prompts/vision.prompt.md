---
description: "Vision document for the Cloud Migration Helper Dynatrace App. Use when: planning features, writing user stories, designing architecture, reviewing UX, validating implementation, or any task requiring context about the app's purpose and scope."
---

# Cloud Migration Helper — Vision Document

## Problem

Dynatrace customers using **classic cloud connections** (AWS, Azure, GCP) need to migrate to the new **Cloud Platform Monitoring**. This is a breaking change — classic metrics, entities, and APIs are replaced by new equivalents with different key patterns, entity models, and storage backends. Customers have no way to see what depends on their classic connections or what will break when they migrate.

## Vision

The Cloud Migration Helper shows customers what depends on their classic cloud connections, what has a known migration path, and what doesn't — so they can plan a migration with full visibility.

## Target Users

- **Dynatrace Administrator** — manages environment configuration, needs to understand the blast radius before migrating
- **Cloud Administrator** — manages AWS/Azure/GCP infrastructure, needs to know which accounts are affected

## Capabilities

### 1. Inventory — "What cloud connections do I have?"

Discover all classic and new cloud connections in the environment. Show per-provider, per-account: which accounts have classic connections, which have new connections, which have both (parallel).

- Classic connections: Settings API (`builtin:cloud.aws`) / legacy Config API (`/api/config/v1/azure/credentials`) / DQL
- New connections: Settings API (`builtin:hyperscaler-authentication.connections.{aws,azure}`)

### 2. Dependency Analysis — "What breaks if I remove classic?"

For each classic connection, find all artifacts that reference its data:

| Artifact Type | Detection Method |
|---|---|
| **Dashboards** | Document Service — scan DQL expressions and metric selectors for classic metric key prefixes and entity types |
| **Metric events / alerts** | Settings API — inspect metric event configurations for classic metric keys |
| **SLOs** | SLO API — parse metric expressions for classic metric references |

For each dependency, identify the specific classic metric keys and entity types used. This is the blast radius.

### 3. Migration Readiness — "Can I migrate?"

For each discovered dependency, check whether a known mapping exists to a new equivalent:

| Tier | Meaning | Example |
|---|---|---|
| **Blocker** | No known mapping exists — classic-only metric/entity with no new equivalent | A built-in classic metric with no entry in the mapping table and no new connection equivalent |
| **Warning** | Mapping exists but the artifact hasn't been updated yet | Dashboard using `dt.cloud.aws.ec2.*` where `cloud.aws.ec2.*` equivalent is known |
| **Ready** | Already uses new connection data or has no classic dependency | Artifact queries only new-connection metrics |

Summary view: "You have 3 blockers, 12 warnings, 47 items ready."

## Domain Knowledge

The app's value comes from curated, per-provider knowledge that does not exist elsewhere:

- **Metric key mapping tables** (JSON) — classic → new metric key translations. See `docs/dac-{aws,azure}-to-2ndgen-metrics.json`.
- **Entity type mapping tables** (JSON) — classic → new entity type translations. See `docs/dac-{aws,azure}-to-2ndgen-entities.json`.
- **DQL detection patterns** — queries that distinguish classic from new data based on metric key prefixes, `dt.da.source` dimension, `dt.source_entity.type` dimension, entity type patterns, and settings schema IDs. Documented in `docs/dql-patterns.md`.
- **Per-provider know-how** — documented in `docs/{aws,azure,gcp}-{classic,new}.md`.

### Metric Mapping Strategies

| Classic Source | New Equivalent | Approach | Difficulty |
|---|---|---|---|
| **Built-in classic** (`dt.cloud.aws.*`, `dt.cloud.azure.*`) | New metrics (`cloud.aws.*`, `cloud.azure.*`) | Curated mapping table — names differ completely | Hard |
| **Non-built-in classic** (`cloud.aws.<svc>.*`, `cloud.azure.microsoft_*`) | New metrics (same key format) | Pass-through — keys are identical, distinguished by `dt.da.source` dimension | Easy |
| **Metric Streams** (`cloud.aws.<svc>.<camelCase>`) | New metrics (`cloud.aws.<svc>.<PascalCase>`) | Curated mapping table — naming conventions differ | Medium |

### Entity Mapping

Classic and new connections create **separate entity systems** (Cassandra vs. Grail). The app maintains per-provider mapping tables:

- Classic entity type → new Smartscape entity type
- Classic `CUSTOM_DEVICE` sub-types (`cloud:aws:*`, `cloud:azure:*`) → new entity types

> **AWS name collisions**: Some type names exist in both systems (`AWS_LAMBDA_FUNCTION`, `AWS_APPLICATION_LOAD_BALANCER`). These are different entities in different storage backends.

## Provider Scope

All three providers: **AWS**, **Azure**, **GCP**. Implement AWS first (most mature on the new side), then Azure, then GCP.

Shared conceptual framework across providers (same capability set, readiness tiers, dependency categories). Provider-specific detection patterns and mapping tables.

| Provider | Classic Config | New Config |
|---|---|---|
| **AWS** | `builtin:cloud.aws` (Settings 2.0) | `builtin:hyperscaler-authentication.connections.aws` |
| **Azure** | Legacy Config API v1 | `builtin:hyperscaler-authentication.connections.azure` |
| **GCP** | GKE cluster-based | New GCP connections via Clouds app |

## Constraints

- **Read-only** — the app MUST NOT modify any customer configuration. All output is informational.
- **No workflow tracking** — the app does not manage migration state or progress. Customers use their own change management processes.
- **No setup guidance** — for setting up new connections, link to the Clouds app and official Dynatrace documentation.
- **Single-environment scope** — operates within one Dynatrace environment.

## Future Scope (not v1)

- Scanning workflows, notebooks, and management zones
- Exportable migration reports (CSV, JSON)
- Assisted migration with customer review/approval
- Multi-environment support

## What Success Looks Like

- "I can see everything that depends on my classic cloud connections in one place"
- "I know exactly which dashboards, alerts, and SLOs will break"
- "I can see clearly what's blocking me — 3 blockers, 12 warnings, 47 items ready"
- "I understand which classic metrics have known new equivalents and which don't"

## Technical Notes

- Use `useDql` hook from `@dynatrace-sdk/react-hooks` for all data fetching
- Cache discovery results in App State to avoid repeated expensive scans
- Metric/entity mapping tables maintained as JSON in `docs/`
- DQL detection patterns are a primary research output — document in `docs/dql-patterns.md`
- Deep-link to the Clouds app where possible (specific connections/resources)
- Cross-environment migration coordination
- Migration of custom extensions or third-party integrations that depend on classic cloud data
- ActiveGate lifecycle management (the app advises on config changes but doesn't manage ActiveGate infrastructure)
- Real-time migration monitoring (the app is a planning and assessment tool, not a live migration orchestrator)
- Duplicating Clouds App functionality (cloud inventory, topology browsing, metric/log exploration)

## Open Questions

1. **Clouds app deep-linking**: What URL patterns does the Clouds app support for deep-linking to specific connections or resources in its Classic and New explorers?
2. **Metric metadata**: Do new cloud metrics carry metadata that could help validate defined mappings (e.g., descriptions, units, dimensions)?
3. **GCP connection details**: Classic and new GCP connection documentation (entity types, metric key patterns, settings schemas) needs to be created as know-how files before GCP implementation begins.

## Reference Documentation

- [Classic AWS monitoring setup](https://docs.dynatrace.com/docs/ingest-from/amazon-web-services/integrate-with-aws)
- [New AWS Cloud Platform Monitoring](https://docs.dynatrace.com/docs/ingest-from/amazon-web-services/aws-onboarding)
- [Clouds app documentation](https://docs.dynatrace.com/docs/observe/infrastructure-observability/cloud-platform-monitoring/clouds-app)
