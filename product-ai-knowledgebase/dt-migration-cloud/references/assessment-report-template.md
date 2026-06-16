# Assessment Report Template

Templates for the two outputs produced in Phase 2 Step 4.

---

## Table of Contents

- [1. Chat Summary](#1-chat-summary)
- [2. Detailed Report File](#2-detailed-report-file)

---

## 1. Chat Summary

Present this concise overview in the conversation:

```
## Classic Dependencies Found

- **Dashboards**: <count> affected (out of <total> scanned)
- **Metric Event Alerts**: <count> affected (out of <total> scanned)
- **Infrastructure Anomaly Detection**: <count> affected (AWS only)
- **Anomaly Detectors (Custom Alerts)**: <count> affected (out of <total> scanned)
- **SLOs**: <count> affected (out of <total> scanned)

Note: Classic dashboards (Config API v1) were not scanned — out of scope.
```

---

## 2. Detailed Report File

Write a local markdown file (e.g., `cloud-migration-assessment.md`) or a Dynatrace Document via `dtctl` containing the full assessment. Use this structure:

```
## Cloud Migration Assessment — <environment name>

### Connection Inventory
| Provider | Account ID | Name | Migration Status | Migration Blocked     |
|----------|-----------|------|----------------|--------------------------|
| AWS      | 123456789 | prod | Parallel       | No                       |
| ...      |           |      |                | Yes (AWS Metric Streams) |

### Classic Dependencies Found
#### Dashboards (<count> affected)
- <dashboard name> (<id>) — patterns: dt.cloud.aws.ec2.*, fetch dt.entity.ec2_instance

#### Metric Event Alerts (<count> affected)
- <alert name> (<id>) — metric: dt.cloud.aws.lambda.invocations

#### Infrastructure Anomaly Detection (<count> affected)
- AWS Infrastructure Anomaly Detection (<objectId>) — classic AWS entity types monitored

#### Anomaly Detectors (Custom Alerts) (<count> affected)
- <detector title> (<objectId>) — metrics: dt.cloud.aws.lambda.errors (in analyzer input: timeSeriesSelector)

#### SLOs (<count> affected)
- <SLO name> (<id>) — metric: builtin:cloud.aws.ec2.cpu.usage

### Out of Scope
- Classic dashboards (Config API v1) — not scannable via dtctl
```

For each affected asset, include: name, ID, owner (if available), and each classic reference detected with its location (tile name, metric key field, etc.).
