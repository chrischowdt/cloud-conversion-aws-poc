#!/usr/bin/env python3
"""generate-migration-plan.py — Phase 3 Mode A: produce a self-contained migration plan.

Combines detect-classic-patterns.py JSON output with per-key metric mappings
(built by lookup-mapping.py) into a structured Markdown migration plan covering:
  Part 1 — Classic → new metric key reference table (grouped by service)
  Part 2 — Dashboard remediation (per-dashboard before/after)
  Part 3 — Metric event alert remediation (per-alert before/after)
  Part 4 — No-match keys with DQL discovery queries
  Part 5 — Cutover checklist

Usage:
    # First build the per-key mapping index (run once per assessment):
    python3 generate-migration-plan.py --build-mappings --provider aws --assessment ./assessment

    # Then generate the plan:
    python3 generate-migration-plan.py --provider aws --assessment ./assessment --output ./cloud-migration-plan.md

    # Or both in one step:
    python3 generate-migration-plan.py --provider aws --assessment ./assessment --output ./cloud-migration-plan.md --build-mappings

Prerequisites:
    - detect-classic-patterns.py must have been run: ./assessment/ must contain detection JSON output
      (the file is produced implicitly; this script re-runs detection internally)
    - lookup-mapping.py and its data files must be present in the same scripts/ directory

Detection JSON key reference (from detect-classic-patterns.py --json):
    "dashboards"               — affected new platform dashboards
    "alerts"                   — affected metric event alerts  (NOT "metric_events")
    "slos"                     — affected SLOs
    "infrastructure_detection" — affected infrastructure anomaly detection objects
    "davis_detectors"          — affected anomaly detectors (custom alerts)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
LOOKUP_SCRIPT = SCRIPT_DIR / "lookup-mapping.py"
DETECT_SCRIPT = SCRIPT_DIR / "detect-classic-patterns.py"

NOT_MATCHED = "not-matched"

# ── Service lookups for building the mapping index ────────────────────────────

AWS_SERVICES = [
    "AWS/RDS", "AWS/Lambda", "AWS/SQS", "AWS/ApplicationELB", "AWS/ElastiCache",
    "AWS/ECS", "AWS/EC2", "AWS/ES", "AWS/Kafka", "AWS/Neptune", "AWS/Cassandra",
    "AWS/CloudFront", "AWS/Route53", "AWS/SES", "AWS/WAFV2", "AWS/CodeBuild",
    "AWS/DocDB", "AWS/AmazonMQ", "AWS/AppStream", "ContainerInsights",
    "AWS/ApiGateway", "AWS/AutoScaling", "AWS/Bedrock",
]

AZURE_SERVICES: list[str] = []  # extend as needed

# Known manual mappings for abbreviated classic keys not in the database
_MANUAL_MAPPINGS_AWS: dict[str, tuple[str, str]] = {
    # ALB
    "cloud.aws.alb.bytes": ("cloud.aws.applicationelb.ProcessedBytes.By.LoadBalancer", "autodiscovered"),
    "dt.cloud.aws.alb.bytes": ("cloud.aws.applicationelb.ProcessedBytes.By.LoadBalancer", "autodiscovered"),
    "cloud.aws.alb.connections.active": ("cloud.aws.applicationelb.ActiveConnectionCount.By.LoadBalancer", "recommended"),
    "dt.cloud.aws.alb.connections.active": ("cloud.aws.applicationelb.ActiveConnectionCount.By.LoadBalancer", "recommended"),
    "cloud.aws.alb.connections.new": ("cloud.aws.applicationelb.NewConnectionCount.By.LoadBalancer", "recommended"),
    "dt.cloud.aws.alb.connections.new": ("cloud.aws.applicationelb.NewConnectionCount.By.LoadBalancer", "recommended"),
    "cloud.aws.alb.errors.alb.http4xx": ("cloud.aws.applicationelb.HTTPCode_ELB_4XX_Count.By.LoadBalancer", "recommended"),
    "dt.cloud.aws.alb.errors.alb.http4xx": ("cloud.aws.applicationelb.HTTPCode_ELB_4XX_Count.By.LoadBalancer", "recommended"),
    "cloud.aws.alb.errors.alb.http5xx": ("cloud.aws.applicationelb.HTTPCode_ELB_5XX_Count.By.LoadBalancer", "recommended"),
    "dt.cloud.aws.alb.errors.alb.http5xx": ("cloud.aws.applicationelb.HTTPCode_ELB_5XX_Count.By.LoadBalancer", "recommended"),
    "cloud.aws.alb.errors.targ_conn": ("cloud.aws.applicationelb.TargetConnectionErrorCount.By.LoadBalancer", "recommended"),
    "dt.cloud.aws.alb.errors.targ_conn": ("cloud.aws.applicationelb.TargetConnectionErrorCount.By.LoadBalancer", "recommended"),
    "cloud.aws.alb.errors.target.http4xx": ("cloud.aws.applicationelb.HTTPCode_Target_4XX_Count.By.LoadBalancer", "recommended"),
    "dt.cloud.aws.alb.errors.target.http4xx": ("cloud.aws.applicationelb.HTTPCode_Target_4XX_Count.By.LoadBalancer", "recommended"),
    "cloud.aws.alb.errors.target.http5xx": ("cloud.aws.applicationelb.HTTPCode_Target_5XX_Count.By.LoadBalancer", "recommended"),
    "dt.cloud.aws.alb.errors.target.http5xx": ("cloud.aws.applicationelb.HTTPCode_Target_5XX_Count.By.LoadBalancer", "recommended"),
    "cloud.aws.alb.requests": ("cloud.aws.applicationelb.RequestCount.By.LoadBalancer", "recommended"),
    "dt.cloud.aws.alb.requests": ("cloud.aws.applicationelb.RequestCount.By.LoadBalancer", "recommended"),
    "cloud.aws.alb.resp_time": ("cloud.aws.applicationelb.TargetResponseTime.By.LoadBalancer", "recommended"),
    "dt.cloud.aws.alb.resp_time": ("cloud.aws.applicationelb.TargetResponseTime.By.LoadBalancer", "recommended"),
    # API Gateway
    "cloud.aws.api_gateway.latency": ("cloud.aws.apigateway.Latency.By.ApiName.Stage", "recommended"),
    # ElastiCache custom
    "cloud.aws.eccustom.cache_hits_sum": ("cloud.aws.elasticache.CacheHits.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.cache_misses_sum": ("cloud.aws.elasticache.CacheMisses.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.cpu_utilization": ("cloud.aws.elasticache.CPUUtilization.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.curr_connections": ("cloud.aws.elasticache.CurrConnections.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.database_memory_usage_percentage": ("cloud.aws.elasticache.DatabaseMemoryUsagePercentage.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.engine_cpuutilization": ("cloud.aws.elasticache.EngineCPUUtilization.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.evictions_sum": ("cloud.aws.elasticache.Evictions.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.freeable_memory": ("cloud.aws.elasticache.FreeableMemory.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.network_bandwidth_out_allowance_exceeded_sum": ("cloud.aws.elasticache.NetworkBandwidthOutAllowanceExceeded.By.CacheClusterId", "autodiscovered"),
    "cloud.aws.eccustom.network_bandwidth_out_allowance_exceeded_sum_by_cache_node_id": ("cloud.aws.elasticache.NetworkBandwidthOutAllowanceExceeded.By.CacheClusterId.CacheNodeId", "autodiscovered"),
    "cloud.aws.eccustom.network_bytes_in_sum": ("cloud.aws.elasticache.NetworkBytesIn.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.network_bytes_out_sum": ("cloud.aws.elasticache.NetworkBytesOut.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.network_bytes_out_sum_by_cache_node_id": ("cloud.aws.elasticache.NetworkBytesOut.By.CacheClusterId.CacheNodeId", "recommended"),
    "cloud.aws.eccustom.replication_bytes": ("cloud.aws.elasticache.ReplicationBytes.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.replication_lag": ("cloud.aws.elasticache.ReplicationLag.By.CacheClusterId", "recommended"),
    "cloud.aws.eccustom.swap_usage": ("cloud.aws.elasticache.SwapUsage.By.CacheClusterId", "recommended"),
    "ext:cloud.aws.eccustom.networkbandwidthoutallowanceexceededsumbycachenodeid": ("cloud.aws.elasticache.NetworkBandwidthOutAllowanceExceeded.By.CacheClusterId.CacheNodeId", "autodiscovered"),
    # RDS abbreviated
    "cloud.aws.rds.free": ("cloud.aws.rds.FreeStorageSpace.By.DBInstanceIdentifier", "recommended"),
    "cloud.aws.rds.latency.read": ("cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier", "recommended"),
    "cloud.aws.rds.latency.write": ("cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier", "recommended"),
    "cloud.aws.rds.memory.freeable": ("cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier", "recommended"),
    "cloud.aws.rds.memory.swap": ("cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier", "recommended"),
    "cloud.aws.rds.ops.read": ("cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier", "recommended"),
    "cloud.aws.rds.ops.write": ("cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier", "recommended"),
    "cloud.aws.rds.restarts": ("cloud.aws.rds.DatabaseRestarts.By.DBInstanceIdentifier", "autodiscovered"),
    "cloud.aws.rds.throughput.read": ("cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier", "recommended"),
    "cloud.aws.rds.throughput.write": ("cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier", "recommended"),
    "builtin:cloud.aws.rds.memory.freeable": ("cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier", "recommended"),
    # dt.cloud.aws.rds mirrors
    "dt.cloud.aws.rds.free": ("cloud.aws.rds.FreeStorageSpace.By.DBInstanceIdentifier", "recommended"),
    "dt.cloud.aws.rds.latency.read": ("cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier", "recommended"),
    "dt.cloud.aws.rds.latency.write": ("cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier", "recommended"),
    "dt.cloud.aws.rds.memory.freeable": ("cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier", "recommended"),
    "dt.cloud.aws.rds.memory.swap": ("cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier", "recommended"),
    "dt.cloud.aws.rds.ops.read": ("cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier", "recommended"),
    "dt.cloud.aws.rds.ops.write": ("cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier", "recommended"),
    "dt.cloud.aws.rds.restarts": ("cloud.aws.rds.DatabaseRestarts.By.DBInstanceIdentifier", "autodiscovered"),
    "dt.cloud.aws.rds.throughput.read": ("cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier", "recommended"),
    "dt.cloud.aws.rds.throughput.write": ("cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier", "recommended"),
    # Aurora abbreviated
    "cloud.aws.aurora.read_latency": ("cloud.aws.rds.ReadLatency.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.write_latency": ("cloud.aws.rds.WriteLatency.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.read_iops": ("cloud.aws.rds.ReadIOPS.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.write_iops": ("cloud.aws.rds.WriteIOPS.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.read_throughput": ("cloud.aws.rds.ReadThroughput.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.write_throughput": ("cloud.aws.rds.WriteThroughput.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.volume_bytes_used": ("cloud.aws.rds.VolumeBytesUsed.By.DBClusterIdentifier", "recommended"),
    "cloud.aws.aurora.volume_read_iops": ("cloud.aws.rds.VolumeReadIOPs.By.DBClusterIdentifier", "recommended"),
    "cloud.aws.aurora.volume_write_iops": ("cloud.aws.rds.VolumeWriteIOPs.By.DBClusterIdentifier", "recommended"),
    "cloud.aws.aurora.commit_latency_by_role": ("cloud.aws.rds.CommitLatency.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.commit_throughput_by_role": ("cloud.aws.rds.CommitThroughput.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.disk_queue_depth_by_role": ("cloud.aws.rds.DiskQueueDepth.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.freeable_memory_average_by_role": ("cloud.aws.rds.FreeableMemory.By.DBClusterIdentifier", "recommended"),
    "cloud.aws.aurora.free_local_storage_average_by_role": ("cloud.aws.rds.FreeLocalStorage.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.aurora_replica_lag_average_by_role": ("cloud.aws.rds.AuroraReplicaLag.By.DBInstanceIdentifier", "autodiscovered"),
    "cloud.aws.aurora.buffer_cache_hit_ratio_average_by_role": ("cloud.aws.rds.BufferCacheHitRatio.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.cpu_credit_balance_average": ("cloud.aws.rds.CPUCreditBalance.By.DBInstanceIdentifier", "autodiscovered"),
    "cloud.aws.aurora.cpu_credit_usage_average": ("cloud.aws.rds.CPUCreditUsage.By.DBInstanceIdentifier", "autodiscovered"),
    "cloud.aws.aurora.cpu_utilization_maximum_by_role": ("cloud.aws.rds.CPUUtilization.By.DBClusterIdentifier.Role", "autodiscovered"),
    "cloud.aws.aurora.database_connections_average_by_role": ("cloud.aws.rds.DatabaseConnections.By.DBClusterIdentifier.Role", "autodiscovered"),
    "cloud.aws.aurora.database_connections_maximum_by_role": ("cloud.aws.rds.DatabaseConnections.By.DBClusterIdentifier.Role", "autodiscovered"),
    "cloud.aws.aurora.engine_uptime_average_by_role": ("cloud.aws.rds.EngineUptime.By.DBClusterIdentifier", "autodiscovered"),
    "cloud.aws.aurora.maximum_used_transaction_ids_average_by_role": ("cloud.aws.rds.MaximumUsedTransactionIDs.By.DBClusterIdentifier", "autodiscovered"),
    # EC2
    "cloud.aws.ec2.cpu.usage": ("cloud.aws.ec2.CPUUtilization.By.AutoScalingGroupName.InstanceId", "recommended"),
    "cloud.aws.ec2.net.rx": ("cloud.aws.ec2.NetworkIn.By.AutoScalingGroupName.InstanceId", "recommended"),
    "cloud.aws.ec2.net.tx": ("cloud.aws.ec2.NetworkOut.By.AutoScalingGroupName.InstanceId", "recommended"),
    "dt.cloud.aws.ec2.cpu.usage": ("cloud.aws.ec2.CPUUtilization.By.AutoScalingGroupName.InstanceId", "recommended"),
    "dt.cloud.aws.ec2.net.rx": ("cloud.aws.ec2.NetworkIn.By.AutoScalingGroupName.InstanceId", "recommended"),
    "dt.cloud.aws.ec2.net.tx": ("cloud.aws.ec2.NetworkOut.By.AutoScalingGroupName.InstanceId", "recommended"),
    "builtin:cloud.aws.ec2.cpu.usage": ("cloud.aws.ec2.CPUUtilization.By.AutoScalingGroupName.InstanceId", "recommended"),
    # Lambda abbreviated
    "cloud.aws.lambda.duration": ("cloud.aws.lambda.Duration.By.FunctionName", "recommended"),
    "cloud.aws.lambda.errors": ("cloud.aws.lambda.Errors.By.FunctionName", "recommended"),
    "cloud.aws.lambda.invocations": ("cloud.aws.lambda.Invocations.By.FunctionName", "recommended"),
    "cloud.aws.lambda.invocations_sum": ("cloud.aws.lambda.Invocations.By.FunctionName", "recommended"),
    "cloud.aws.lambda.throttles_sum": ("cloud.aws.lambda.Throttles.By.FunctionName", "recommended"),
    "cloud.aws.lambda.durationbyaccountidfunctionnameregionresource": ("cloud.aws.lambda.Duration.By.ExecutedVersion.FunctionName.Resource", "autodiscovered"),
    "cloud.aws.lambda.errorsbyaccountidfunctionnameregionresource": ("cloud.aws.lambda.Errors.By.ExecutedVersion.FunctionName.Resource", "autodiscovered"),
    "cloud.aws.lambda.invocationsbyaccountidfunctionnameregion": ("cloud.aws.lambda.Invocations.By.FunctionName", "recommended"),
    "dt.cloud.aws.lambda.duration": ("cloud.aws.lambda.Duration.By.FunctionName", "recommended"),
    "dt.cloud.aws.lambda.errors": ("cloud.aws.lambda.Errors.By.FunctionName", "recommended"),
    "ext:cloud.aws.lambda.errorssum:splitby": ("cloud.aws.lambda.Errors.By.FunctionName", "recommended"),
    "ext:cloud.aws.lambda.invocationssum:splitby": ("cloud.aws.lambda.Invocations.By.FunctionName", "recommended"),
    "ext:cloud.aws.lambda.throttlessum:splitby": ("cloud.aws.lambda.Throttles.By.FunctionName", "recommended"),
    # SQS abbreviated
    "cloud.aws.sqs.approximate_number_of_messages_not_visible_sum": ("cloud.aws.sqs.ApproximateNumberOfMessagesNotVisible.By.QueueName", "recommended"),
    "cloud.aws.sqs.number_of_messages_received_sum": ("cloud.aws.sqs.NumberOfMessagesReceived.By.QueueName", "recommended"),
    "cloud.aws.sqs.number_of_messages_sent_sum": ("cloud.aws.sqs.NumberOfMessagesSent.By.QueueName", "recommended"),
    # WAFv2
    "cloud.aws.wafv2.allowed_requests_sum_by_region_rule": ("cloud.aws.wafv2.AllowedRequests.By.Region.Rule.WebACL", "recommended"),
    "cloud.aws.wafv2.blocked_requests_sum_by_region_rule": ("cloud.aws.wafv2.BlockedRequests.By.Region.Rule.WebACL", "recommended"),
    "ext:cloud.aws.wafv2.allowedrequestssumbyregionrule:splitby": ("cloud.aws.wafv2.AllowedRequests.By.Region.Rule.WebACL", "recommended"),
    "ext:cloud.aws.wafv2.blockedrequestssumbyregionrule:splitby": ("cloud.aws.wafv2.BlockedRequests.By.Region.Rule.WebACL", "recommended"),
    # Route53
    "cloud.aws.route53.connectiontimebyaccountidhealthcheckidregion": ("cloud.aws.route53.ConnectionTime.By.HealthCheckId.Region", "autodiscovered"),
    "cloud.aws.route53.dns_queries_sum": ("cloud.aws.route53.DNSQueries.By.HostedZoneId", "autodiscovered"),
    # Autoscaling
    "cloud.aws.autoscaling.group_desired_capacity_average": ("cloud.aws.autoscaling.GroupDesiredCapacity.By.AutoScalingGroupName", "autodiscovered"),
    "cloud.aws.autoscaling.group_in_service_instances_average": ("cloud.aws.autoscaling.GroupInServiceInstances.By.AutoScalingGroupName", "autodiscovered"),
    # ContainerInsights
    "cloud.aws.containerinsights.node_cpu_limit": ("cloud.aws.containerinsights.node_cpu_limit.By.ClusterName", "autodiscovered"),
    "cloud.aws.containerinsights.node_memory_limit": ("cloud.aws.containerinsights.node_memory_limit.By.ClusterName", "autodiscovered"),
    # ES/OpenSearch
    "ext:cloud.aws.es.cpuutilizationaveragebyclientid": ("cloud.aws.opensearch_domain.CPUUtilization.By.ClientId.DomainName", "autodiscovered"),
}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _run(cmd: list[str]) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 and not r.stdout.strip():
        print(f"Warning: {' '.join(cmd[:3])} exited {r.returncode}: {r.stderr[:200]}", file=sys.stderr)
    return r.stdout


def service_of(key: str) -> str:
    for pat in [
        r"^(?:ext|builtin):cloud\.aws\.([^.]+)\.",
        r"^builtin:aws\.([^.]+)\.",
        r"^(?:dt\.)?cloud\.aws\.([^.]+)\.",
    ]:
        m = re.match(pat, key, re.IGNORECASE)
        if m:
            return m.group(1).lower()
    return "unknown"


def strip_selector_modifiers(key: str) -> str:
    if key.lower().startswith(("ext:", "builtin:")):
        prefix_end = key.index(":") + 1
        rest = key[prefix_end:]
        colon = rest.find(":")
        if colon != -1:
            return key[: prefix_end + colon]
        return key
    colon = key.find(":")
    return key[:colon] if colon != -1 else key


# ── Mapping index ──────────────────────────────────────────────────────────────

def build_mapping_index(provider: str, assessment_dir: Path) -> dict[str, dict]:
    """Build a lowercase-keyed mapping index for all classic keys."""
    index: dict[str, dict] = {}

    # 1. Service-level lookups from the database
    services = AWS_SERVICES if provider == "aws" else AZURE_SERVICES
    for ns in services:
        out = _run(["python3", str(LOOKUP_SCRIPT), "metric", "--service", ns,
                    "--provider", provider, "--json"])
        if not out.strip():
            continue
        try:
            entries = json.loads(out)
        except json.JSONDecodeError:
            continue
        for e in entries:
            best = e.get("bestDacKey", NOT_MATCHED)
            avail = e.get("availability", "none")
            for ck in e.get("classicKeys", []):
                if ck and ck != NOT_MATCHED:
                    index[ck.lower()] = {"bestDacKey": best, "availability": avail}

    # 2. Overlay manual mappings (higher precision for abbreviated keys)
    if provider == "aws":
        for k, (dac, avail) in _MANUAL_MAPPINGS_AWS.items():
            index[k.lower()] = {"bestDacKey": dac, "availability": avail}

    cache_path = assessment_dir / "per-key-mappings.json"
    with open(cache_path, "w") as f:
        json.dump({k: v for k, v in index.items()}, f, indent=2)
    print(f"  Mapping index: {len(index)} entries → {cache_path}", file=sys.stderr)
    return index


def load_mapping_index(assessment_dir: Path) -> dict[str, dict]:
    cache_path = assessment_dir / "per-key-mappings.json"
    if not cache_path.exists():
        print(f"Error: {cache_path} not found. Run with --build-mappings first.", file=sys.stderr)
        sys.exit(1)
    with open(cache_path) as f:
        return json.load(f)


def best_dac(classic_key: str, index: dict[str, dict]) -> tuple[str, str]:
    key = strip_selector_modifiers(classic_key)
    key_noalert = re.sub(r"_alert$", "", key, flags=re.IGNORECASE)
    for candidate in [key, key_noalert, classic_key]:
        hit = index.get(candidate.lower())
        if hit:
            return hit["bestDacKey"], hit["availability"]
    return NOT_MATCHED, "none"


# ── Plan generation ────────────────────────────────────────────────────────────

def avail_label(avail: str) -> str:
    return {
        "recommended": "recommended",
        "autodiscovered": "autodiscovered",
        "none": "no match — use DQL discovery",
    }.get(avail, avail)


def key_row(classic: str, index: dict[str, dict], seen: set | None = None) -> str | None:
    if classic.endswith("_alert"):
        return None
    if seen is not None:
        if classic in seen:
            return None
        seen.add(classic)
    new_key, avail = best_dac(classic, index)
    return f"| `{classic}` | `{new_key}` | {avail_label(avail)} |"


def generate_plan(detection: dict, index: dict[str, dict], provider: str,
                  environment: str) -> str:
    all_keys: set[str] = set()
    for assets in detection.values():
        for asset in assets or []:
            for k in asset.get("metric_keys", []):
                all_keys.add(k)

    lines: list[str] = []

    dashboards = detection.get("dashboards", [])
    # NOTE: metric event alerts are stored under "alerts", NOT "metric_events"
    alerts = detection.get("alerts", [])
    slos = detection.get("slos", [])

    lines += [
        "# AWS Classic Connection — Migration Plan",
        "",
        f"Generated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC  ",
        f"Environment: `{environment}`  ",
        f"Scope: {provider.upper()} only | **{len(dashboards)} affected dashboards · "
        f"{len(alerts)} affected metric event alerts · {len(slos)} affected SLOs**",
        "",
        "> **Availability legend:**",
        "> - **recommended** — in the default collection set; no extra connection config needed",
        "> - **autodiscovered** — set the new connection to *recommended + custom* and add this key as a custom metric",
        "> - **no match** — no direct mapping; use the DQL discovery query in Part 4",
        "",
        "> **Alert migration:** Classic metric event alerts must be deleted and re-created (cannot be edited in place).  ",
        "> Zero-gap strategy: **(1)** Create new alerts *disabled* now. **(2)** After new connection begins ingesting data, "
        "simultaneously disable old and enable new. **(3)** Delete old alerts after validation.",
        "",
        "> **Classic dashboards (Config API v1):** Cannot be scanned automatically — review manually.",
        "",
    ]

    # ── Part 1 ────────────────────────────────────────────────────────────────
    lines += ["---", "", "## Part 1: Classic → New Metric Key Reference", ""]
    by_service: dict[str, set[str]] = defaultdict(set)
    for k in all_keys:
        if not k.endswith("_alert"):
            by_service[service_of(k)].add(k)

    for svc in sorted(by_service):
        keys = sorted(by_service[svc])
        lines += [f"### {svc.upper()}", "", "| Classic key | New DAC key | Availability |", "|---|---|---|"]
        for k in keys:
            row = key_row(k, index)
            if row:
                lines.append(row)
        alert_keys = [k for k in all_keys if k.endswith("_alert") and service_of(k) == svc]
        if alert_keys:
            sample = ", ".join(f"`{k}`" for k in sorted(alert_keys)[:2])
            extra = f" and {len(alert_keys)-2} more" if len(alert_keys) > 2 else ""
            lines += ["", f"> `_alert`-suffix key(s) detected ({sample}{extra}). "
                      "These are classic-only artifacts — **do not re-create** with new keys."]
        lines.append("")

    # ── Part 2: Dashboards ────────────────────────────────────────────────────
    lines += [
        "---", "",
        f"## Part 2: Dashboard Remediation ({len(dashboards)} affected)", "",
        "Open in Dynatrace UI → edit each tile → swap classic keys for new DAC keys from Part 1.",
        "Or via CLI: `dtctl get dashboards <id> -o json` → edit `tile.query` → `dtctl apply`.",
        "",
    ]
    by_svc: dict[str, list] = defaultdict(list)
    for d in dashboards:
        svcs = sorted(set(service_of(k) for k in d.get("metric_keys", []) if not k.endswith("_alert")))
        by_svc[svcs[0] if svcs else "unknown"].append(d)

    for svc in sorted(by_svc):
        lines += [f"### {svc.upper()} Dashboards", ""]
        for d in by_svc[svc]:
            lines += [f"#### {d['asset_name']}", "", f"ID: `{d['asset_id']}`", ""]
            classic_keys = [k for k in d.get("metric_keys", []) if not k.endswith("_alert")]
            if classic_keys:
                lines += ["| Before (classic) | After (new DAC) | Availability |", "|---|---|---|"]
                seen: set[str] = set()
                for k in classic_keys:
                    row = key_row(k, index, seen)
                    if row:
                        lines.append(row)
                lines.append("")
            for es in d.get("entity_selectors", []):
                lines.append(f"**Entity selector** `{es}` → replace with `smartscapeNodes {es.upper()}` filter")
            if d.get("entity_selectors"):
                lines.append("")

    # ── Part 3: Metric Event Alerts ───────────────────────────────────────────
    lines += [
        "---", "",
        f"## Part 3: Metric Event Alert Remediation ({len(alerts)} affected)", "",
        "Navigate to: **Settings → Anomaly Detection → Metric Events**",
        "",
        "All alerts must be deleted and re-created with new metric keys. See zero-gap strategy above.",
        "",
    ]
    by_svc_a: dict[str, list] = defaultdict(list)
    for a in alerts:
        svcs = sorted(set(service_of(k) for k in a.get("metric_keys", []) if not k.endswith("_alert")))
        by_svc_a[svcs[0] if svcs else "unknown"].append(a)

    for svc in sorted(by_svc_a):
        lines += [f"### {svc.upper()} Alerts", ""]
        for a in by_svc_a[svc]:
            lines += [f"#### {a['asset_name']}", "", f"ID: `{a['asset_id']}`", ""]
            classic_keys = [k for k in a.get("metric_keys", []) if not k.endswith("_alert")]
            if classic_keys:
                lines += ["| Before (classic) | After (new DAC) | Availability |", "|---|---|---|"]
                seen2: set[str] = set()
                for k in classic_keys:
                    row = key_row(k, index, seen2)
                    if row:
                        lines.append(row)
                lines.append("")

    # ── Part 4: No-match keys ─────────────────────────────────────────────────
    no_match = {k for k in all_keys if not k.endswith("_alert") and best_dac(k, index)[1] == "none"}
    lines += ["---", "", "## Part 4: No-Match Keys — DQL Discovery", ""]
    if no_match:
        lines.append("After the new connection is active, run these DQL queries to discover live new metric keys:")
        lines.append("")
        nm_by_svc: dict[str, list[str]] = defaultdict(list)
        for k in no_match:
            nm_by_svc[service_of(k)].append(k)
        for svc in sorted(nm_by_svc):
            svc_keys = sorted(nm_by_svc[svc])
            lines += [
                f"**{svc.upper()}** ({len(svc_keys)} key(s)): " + ", ".join(f"`{k}`" for k in svc_keys),
                "",
                "```dql",
                "fetch metric.series, from:now()-1h",
                f'| filter startsWith(metric.key, "cloud.aws.{svc}.") AND isNotNull(dt.da.source)',
                "| summarize cnt=count(), by:{metric.key, dt.da.source}",
                "```",
                "",
            ]
    else:
        lines += ["All detected classic metric keys have direct mappings. No DQL discovery needed.", ""]

    # ── Part 5: Cutover checklist ─────────────────────────────────────────────
    lines += [
        "---", "",
        "## Part 5: Cutover Checklist (Phase 4)", "",
        "- [ ] **4a.** Create new connection(s) in topology-only mode (metric ingest disabled).",
        "- [ ] **4b.** Validate Smartscape node counts match expected entity counts (Phase 1 queries).",
        "- [ ] **4c.** Apply dashboard changes (Part 2). Create new alerts (Part 3) in *disabled* state.",
        "- [ ] **4d.** Enable metric ingest. Validate `dt.da.source`. Disable classic alerts, enable new alerts simultaneously.",
        "- [ ] **4e.** Disable classic connection(s) (do not delete). Re-run Phase 2 scan to confirm no remaining classic references.",
        "- [ ] **4f.** Delete classic connection(s) after ≥1 week validation buffer.",
        "",
        "> Autodiscovered metrics require the new connection configured with *recommended + custom* metric collection.",
    ]

    return "\n".join(lines)


# ── CLI ────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Phase 3 Mode A migration plan.")
    parser.add_argument("--provider", choices=["aws", "azure", "gcp"], required=True)
    parser.add_argument("--assessment", default="./assessment",
                        help="Directory containing detect-classic-patterns.py output files")
    parser.add_argument("--output", default="./cloud-migration-plan.md")
    parser.add_argument("--environment", default="", help="Environment URL for the report header")
    parser.add_argument("--build-mappings", action="store_true",
                        help="(Re)build per-key mapping index before generating the plan")
    args = parser.parse_args()

    assessment_dir = Path(args.assessment)
    assessment_dir.mkdir(parents=True, exist_ok=True)

    # Re-run detection to get fresh JSON
    print("Running detect-classic-patterns.py …", file=sys.stderr)
    out = _run(["python3", str(DETECT_SCRIPT), "--provider", args.provider,
                "--json", str(assessment_dir)])
    if not out.strip():
        print("Error: detect-classic-patterns.py produced no output.", file=sys.stderr)
        sys.exit(1)
    detection = json.loads(out)
    print(f"  dashboards={len(detection.get('dashboards',[]))}  "
          f"alerts={len(detection.get('alerts',[]))}  "   # key is "alerts", not "metric_events"
          f"slos={len(detection.get('slos',[]))}", file=sys.stderr)

    # Build or load mapping index
    if args.build_mappings:
        print("Building mapping index …", file=sys.stderr)
        index = build_mapping_index(args.provider, assessment_dir)
    else:
        index = load_mapping_index(assessment_dir)

    plan = generate_plan(detection, index, args.provider, args.environment)

    with open(args.output, "w") as f:
        f.write(plan)
    print(f"Written → {args.output} ({plan.count(chr(10))+1} lines)")


if __name__ == "__main__":
    main()
