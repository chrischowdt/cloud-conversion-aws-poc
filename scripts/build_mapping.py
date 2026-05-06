#!/usr/bin/env python3
"""Join classic AWS metric inventory to the new-integration support-matrix
and emit a per-service, per-metric mapping plus a gap analysis.

Two classic metric sources drive the mapping:

  * **builtinMetrics** — the 9 classic "-builtin" pages carry Dynatrace-curated
    `builtin:cloud.aws.*` metric IDs inside the Next.js RSC payload. These
    hide the CloudWatch name and often pre-normalise units; we use a hand-
    curated override table to bind each to its CloudWatch counterpart and
    category.

  * **cloudwatchMetrics** — every classic service page (including the built-
    in nine) renders an HTML `<table>` listing the raw CloudWatch metric
    rows it supports: Name, Description, Unit, Statistics, Dimensions, and a
    Recommended flag. For these we join directly on CloudWatch name and
    rank target new-integration metrics by dimension-set overlap.

For each classic service we also pick the best-matching new support-matrix
block by overlap of CloudWatch metric names — that gives us the target
Smartscape node type, CloudWatch namespace, and the new integration's
recommended-metric set.

Outputs:
  mappings/aws_mapping.json — machine-readable mapping
  GAP_ANALYSIS.md           — human-readable summary
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAP = ROOT / "mappings"

# ── Curated overrides for the 9 built-in classic services ─────────────────────
# classic metricId → (cloudwatchName | None, category, notes)
# None means "no CloudWatch equivalent — Dynatrace rollup / computed metric".
OVERRIDES: dict[str, tuple[str | None, str, str]] = {
    # EC2
    "builtin:cloud.aws.ec2.cpu.usage":        ("CPUUtilization", "direct", "both Percent"),
    "builtin:cloud.aws.ec2.disk.readOps":     ("DiskReadOps", "unit_conversion", "classic is per-second rate; CW is count/period — apply rate:"),
    "builtin:cloud.aws.ec2.disk.writeOps":    ("DiskWriteOps", "unit_conversion", "rate vs count/period"),
    "builtin:cloud.aws.ec2.disk.readRate":    ("DiskReadBytes", "unit_conversion", "kB/s vs bytes/period — divide by period*1024"),
    "builtin:cloud.aws.ec2.disk.writeRate":   ("DiskWriteBytes", "unit_conversion", "kB/s vs bytes/period"),
    "builtin:cloud.aws.ec2.net.rx":           ("NetworkIn", "unit_conversion", "Byte/s vs bytes/period — divide by period"),
    "builtin:cloud.aws.ec2.net.tx":           ("NetworkOut", "unit_conversion", "Byte/s vs bytes/period"),
    "builtin:cloud.aws.az.running":           (None, "no_direct_equivalent", "Dynatrace AZ rollup — reconstruct via smartscapeNodes \"AWS_EC2_INSTANCE\" | filter state==\"running\""),
    "builtin:cloud.aws.az.stopped":           (None, "no_direct_equivalent", "Dynatrace AZ rollup — same pattern, filter state==\"stopped\""),
    "builtin:cloud.aws.az.terminated":        (None, "no_direct_equivalent", "Dynatrace AZ rollup — use CloudTrail events"),
    # ASG
    "builtin:cloud.aws.asg.running":          (None, "no_direct_equivalent", "Dynatrace ASG rollup — use GroupInServiceInstances from AWS/AutoScaling or smartscapeNodes under AWS_AUTOSCALING_AUTOSCALINGGROUP"),
    "builtin:cloud.aws.asg.stopped":          (None, "no_direct_equivalent", "Dynatrace ASG rollup — no CW equivalent"),
    "builtin:cloud.aws.asg.terminated":       (None, "no_direct_equivalent", "Dynatrace ASG rollup — use CloudTrail events"),
    # Lambda
    "builtin:cloud.aws.lambda.invocations":   ("Invocations", "direct", ""),
    "builtin:cloud.aws.lambda.errors":        ("Errors", "direct", ""),
    "builtin:cloud.aws.lambda.throttlers":    ("Throttles", "direct", "typo-ish classic name — maps to Throttles"),
    "builtin:cloud.aws.lambda.duration":      ("Duration", "direct", ""),
    "builtin:cloud.aws.lambda.concExecutions":("ConcurrentExecutions", "direct", ""),
    "builtin:cloud.aws.lambda.provConcExecutions":  ("ProvisionedConcurrentExecutions", "direct", ""),
    "builtin:cloud.aws.lambda.provConcInvocations": ("ProvisionedConcurrencyInvocations", "direct", ""),
    "builtin:cloud.aws.lambda.provConcSpilloverInvocations": ("ProvisionedConcurrencySpilloverInvocations", "direct", ""),
    "builtin:cloud.aws.lambda.errorsRate":    (None, "no_direct_equivalent", "Dynatrace ratio Errors/Invocations — rebuild in DQL as a ratio"),
    # DynamoDB
    "builtin:cloud.aws.dynamo.capacityUnits.consumed.read":       ("ConsumedReadCapacityUnits", "direct", ""),
    "builtin:cloud.aws.dynamo.capacityUnits.consumed.write":      ("ConsumedWriteCapacityUnits", "direct", ""),
    "builtin:cloud.aws.dynamo.capacityUnits.provisioned.read":    ("ProvisionedReadCapacityUnits", "direct", ""),
    "builtin:cloud.aws.dynamo.capacityUnits.provisioned.write":   ("ProvisionedWriteCapacityUnits", "direct", ""),
    "builtin:cloud.aws.dynamo.capacityUnits.read":    (None, "no_direct_equivalent", "Dynatrace utilisation % — rebuild: Consumed/Provisioned*100"),
    "builtin:cloud.aws.dynamo.capacityUnits.write":   (None, "no_direct_equivalent", "Dynatrace utilisation % — rebuild: Consumed/Provisioned*100"),
    "builtin:cloud.aws.dynamo.errors.system":         ("SystemErrors", "direct", ""),
    "builtin:cloud.aws.dynamo.errors.user":           ("UserErrors", "direct", ""),
    "builtin:cloud.aws.dynamo.requests.latency":      ("SuccessfulRequestLatency", "direct", ""),
    "builtin:cloud.aws.dynamo.requests.returnedItems":("ReturnedItemCount", "direct", ""),
    "builtin:cloud.aws.dynamo.requests.throttled":    ("ThrottledRequests", "direct", ""),
    "builtin:cloud.aws.dynamo.throttledEvents.read":  ("ReadThrottleEvents", "direct", ""),
    "builtin:cloud.aws.dynamo.throttledEvents.write": ("WriteThrottleEvents", "direct", ""),
    "builtin:cloud.aws.dynamo.tables":                (None, "no_direct_equivalent", "Dynatrace-computed table count per AZ — use smartscapeNodes \"AWS_DYNAMODB_TABLE\""),
    # ALB
    "builtin:cloud.aws.alb.connections.active":       ("ActiveConnectionCount", "direct", ""),
    "builtin:cloud.aws.alb.connections.new":          ("NewConnectionCount", "direct", ""),
    "builtin:cloud.aws.alb.errors.alb.http4xx":       ("HTTPCode_ELB_4XX_Count", "direct", ""),
    "builtin:cloud.aws.alb.errors.alb.http5xx":       ("HTTPCode_ELB_5XX_Count", "direct", ""),
    "builtin:cloud.aws.alb.errors.target.http4xx":    ("HTTPCode_Target_4XX_Count", "direct", ""),
    "builtin:cloud.aws.alb.errors.target.http5xx":    ("HTTPCode_Target_5XX_Count", "direct", ""),
    "builtin:cloud.aws.alb.errors.rejCon":            ("RejectedConnectionCount", "direct", ""),
    "builtin:cloud.aws.alb.errors.targConn":          ("TargetConnectionErrorCount", "direct", ""),
    "builtin:cloud.aws.alb.errors.tlsNeg":            ("ClientTLSNegotiationErrorCount", "direct", ""),
    "builtin:cloud.aws.alb.bytes":                    ("ProcessedBytes", "direct", "AWS/ApplicationELB namespace"),
    "builtin:cloud.aws.alb.lcus":                     ("ConsumedLCUs", "direct", ""),
    "builtin:cloud.aws.alb.requests":                 ("RequestCount", "direct", ""),
    "builtin:cloud.aws.alb.respTime":                 ("TargetResponseTime", "direct", ""),
    # NLB
    "builtin:cloud.aws.nlb.flow.active":              ("ActiveFlowCount", "direct", ""),
    "builtin:cloud.aws.nlb.flow.new":                 ("NewFlowCount", "direct", ""),
    "builtin:cloud.aws.nlb.tcp.reset.client":         ("TCP_Client_Reset_Count", "direct", ""),
    "builtin:cloud.aws.nlb.tcp.reset.elb":            ("TCP_ELB_Reset_Count", "direct", ""),
    "builtin:cloud.aws.nlb.tcp.reset.target":         ("TCP_Target_Reset_Count", "direct", ""),
    "builtin:cloud.aws.nlb.bytes":                    ("ProcessedBytes", "direct", "AWS/NetworkELB namespace"),
    "builtin:cloud.aws.nlb.lcus":                     ("ConsumedLCUs", "direct", "AWS/NetworkELB namespace"),
    # Classic ELB
    "builtin:cloud.aws.elb.errors.backend.connection":("BackendConnectionErrors", "direct", ""),
    "builtin:cloud.aws.elb.errors.backend.http2xx":   ("HTTPCode_Backend_2XX", "direct", ""),
    "builtin:cloud.aws.elb.errors.backend.http3xx":   ("HTTPCode_Backend_3XX", "direct", ""),
    "builtin:cloud.aws.elb.errors.backend.http4xx":   ("HTTPCode_Backend_4XX", "direct", ""),
    "builtin:cloud.aws.elb.errors.backend.http5xx":   ("HTTPCode_Backend_5XX", "direct", ""),
    "builtin:cloud.aws.elb.errors.elb.http4xx":       ("HTTPCode_ELB_4XX", "direct", ""),
    "builtin:cloud.aws.elb.errors.elb.http5xx":       ("HTTPCode_ELB_5XX", "direct", ""),
    "builtin:cloud.aws.elb.errors.frontend":          (None, "no_direct_equivalent", "Dynatrace-computed frontend error % — rebuild as HTTPCode_ELB_[45]XX / RequestCount"),
    "builtin:cloud.aws.elb.hosts.healthy":            ("HealthyHostCount", "direct", ""),
    "builtin:cloud.aws.elb.hosts.unhealthy":          ("UnHealthyHostCount", "direct", ""),
    "builtin:cloud.aws.elb.latency":                  ("Latency", "direct", ""),
    "builtin:cloud.aws.elb.reqCompl":                 ("RequestCount", "direct", ""),
    # RDS
    "builtin:cloud.aws.rds.cpu.usage":         ("CPUUtilization", "direct", "both Percent"),
    "builtin:cloud.aws.rds.latency.read":      ("ReadLatency", "direct", ""),
    "builtin:cloud.aws.rds.latency.write":     ("WriteLatency", "direct", ""),
    "builtin:cloud.aws.rds.memory.freeable":   ("FreeableMemory", "direct", ""),
    "builtin:cloud.aws.rds.memory.swap":       ("SwapUsage", "direct", ""),
    "builtin:cloud.aws.rds.net.rx":            ("NetworkReceiveThroughput", "direct", "both are Bytes/second"),
    "builtin:cloud.aws.rds.net.tx":            ("NetworkTransmitThroughput", "direct", ""),
    "builtin:cloud.aws.rds.ops.read":          ("ReadIOPS", "direct", "both are per-second"),
    "builtin:cloud.aws.rds.ops.write":         ("WriteIOPS", "direct", ""),
    "builtin:cloud.aws.rds.throughput.read":   ("ReadThroughput", "direct", "both Bytes/second"),
    "builtin:cloud.aws.rds.throughput.write":  ("WriteThroughput", "direct", ""),
    "builtin:cloud.aws.rds.connections":       ("DatabaseConnections", "direct", ""),
    "builtin:cloud.aws.rds.free":              (None, "no_direct_equivalent", "Dynatrace-computed free storage % — rebuild: FreeStorageSpace / AllocatedStorage*100"),
    "builtin:cloud.aws.rds.restarts":          (None, "no_direct_equivalent", "No CW metric; RDS restart events come via EventBridge/RDS events"),
    # EBS
    "builtin:cloud.aws.ebs.latency.read":      (None, "no_direct_equivalent", "Dynatrace-computed — rebuild: VolumeTotalReadTime / VolumeReadOps"),
    "builtin:cloud.aws.ebs.latency.write":     (None, "no_direct_equivalent", "Dynatrace-computed — rebuild: VolumeTotalWriteTime / VolumeWriteOps"),
    "builtin:cloud.aws.ebs.ops.consumed":      (None, "no_direct_equivalent", "Sum of read+write OPS — rebuild: VolumeReadOps + VolumeWriteOps, divide by period"),
    "builtin:cloud.aws.ebs.ops.read":          ("VolumeReadOps", "unit_conversion", "rate vs count/period"),
    "builtin:cloud.aws.ebs.ops.write":         ("VolumeWriteOps", "unit_conversion", "rate vs count/period"),
    "builtin:cloud.aws.ebs.throughput.percent":("VolumeThroughputPercentage", "direct", "both Percent; io1 volumes only"),
    "builtin:cloud.aws.ebs.throughput.read":   ("VolumeReadBytes", "unit_conversion", "Bytes/second vs bytes/period"),
    "builtin:cloud.aws.ebs.throughput.write":  ("VolumeWriteBytes", "unit_conversion", ""),
    "builtin:cloud.aws.ebs.idleTime":          ("VolumeIdleTime", "unit_conversion", "classic is % of period idle; CW is seconds idle — divide by period and *100"),
    "builtin:cloud.aws.ebs.queue":             ("VolumeQueueLength", "direct", ""),
}

# ── Pick best new-integration block per classic service ──────────────────────

_NAME_TOKEN_RE = re.compile(r"[a-z0-9]+")
_CAMEL_SPLIT_RE = re.compile(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_SEGMENT_SPLIT_RE = re.compile(r"[:/\s]+")

# Known abbreviations where neither camelCase-split tokens nor a ≥4-char prefix
# match (vowel contractions etc). Symmetric pairs.
_TOKEN_ALIASES = {
    "docdb": "documentdb",
    "documentdb": "docdb",
}


def _name_tokens(*parts: str) -> set[str]:
    """Split a service name/slug into lowercase alnum tokens.

    Produces both the camelCase-split pieces ("Document","DB") and the fused
    lowercased segment ("documentdb"), so tokens from "AWS::DocDB::DBCluster"
    include both ("doc","db","docdb","cluster","dbcluster")."""
    out: set[str] = set()
    for p in parts:
        if not p:
            continue
        for seg in _SEGMENT_SPLIT_RE.split(p):
            if not seg:
                continue
            # fused form (segment lowercased, alnum only)
            fused = "".join(_NAME_TOKEN_RE.findall(seg.lower()))
            if fused:
                out.add(fused)
            # camelCase split
            for chunk in _CAMEL_SPLIT_RE.split(seg):
                out.update(_NAME_TOKEN_RE.findall(chunk.lower()))
    return out - {"aws", "amazon", "db", "service", "services", "other"}


def _tokens_match(svc_tokens: set[str], block_tokens: set[str]) -> bool:
    """Match if any pair is equal, a ≥4-char prefix of the other, or an alias
    pair. Threshold 4 avoids "app" in AppRunner firing on AppStream/AppSync."""
    for c in svc_tokens:
        for b in block_tokens:
            if c == b:
                return True
            if _TOKEN_ALIASES.get(c) == b:
                return True
            short, long_ = (c, b) if len(c) <= len(b) else (b, c)
            if len(short) >= 4 and long_.startswith(short):
                return True
    return False


def pick_new_blocks(
    classic_cw_names: set[str],
    new_blocks: list[dict],
    service_name: str = "",
    slug: str = "",
) -> list[dict]:
    """Return all new support-matrix blocks that plausibly map to this classic
    service, ordered best-first.

    Namespace-matched blocks (service-name tokens match the block's namespace
    or CloudFormation type) are always included when they share ≥1 CW name or
    when the block has empty namespaces but its CF-type still token-matches.
    When no block namespace-matches, fall back to the single best block by raw
    CW-name overlap (so services like OpsWorks can still match something).
    """
    if not classic_cw_names and not service_name:
        return []
    svc_tokens = _name_tokens(service_name, slug)
    ns_matches: list[tuple[int, dict]] = []
    best_fallback, best_overlap = None, 0
    for b in new_blocks:
        new_cw = {m["cloudwatchName"] for m in b.get("recommendedMetrics", []) if m.get("cloudwatchName")}
        overlap = len(classic_cw_names & new_cw) if new_cw else 0
        ns_text = " ".join(b.get("cloudwatchNamespaces", []) or [])
        cf_text = b.get("cloudFormationType", "") or ""
        block_tokens = _name_tokens(ns_text, cf_text)
        ns_match = _tokens_match(svc_tokens, block_tokens)
        if ns_match and overlap >= 1:
            # namespace-matched blocks are kept when they share at least one
            # CW metric with the classic page; score by overlap so the best is
            # listed first. (An earlier "include if block has 0 recommended
            # metrics" fallback was removed — it pulled in e.g. 27 empty EC2
            # sub-resources.)
            ns_matches.append((overlap, b))
        if overlap > best_overlap:
            best_fallback, best_overlap = b, overlap
    if ns_matches:
        ns_matches.sort(key=lambda x: x[0], reverse=True)
        return [b for _, b in ns_matches]
    return [best_fallback] if best_fallback else []


def dim_similarity(classic_dims: list[str], new_dims: list[str]) -> float:
    """Return 1.0 if the dimension sets are equal, 0.8 if one is a superset of
    the other, else Jaccard overlap. 0 if either side is empty."""
    cset, nset = set(classic_dims), set(new_dims)
    if not cset or not nset:
        return 0.0
    if cset == nset:
        return 1.0
    if cset <= nset or nset <= cset:
        return 0.8
    inter = cset & nset
    union = cset | nset
    return len(inter) / len(union)


def best_new_dt_key(
    cw_name: str,
    classic_dims: list[str],
    new_recommended: list[dict],
) -> tuple[str | None, list[str], float, str | None]:
    """Pick the new-integration metric row whose CloudWatch name and dimension
    set best match. Returns (dtMetricKey, newDims, score, sourceCfType)."""
    candidates = [r for r in new_recommended if r.get("cloudwatchName") == cw_name]
    if not candidates:
        return None, [], 0.0, None
    scored = [(dim_similarity(classic_dims, r.get("dimensions", [])), r) for r in candidates]
    scored.sort(key=lambda x: x[0], reverse=True)
    top_score, top = scored[0]
    return top["dtMetricKey"], top.get("dimensions", []), top_score, top.get("_sourceCf")


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    classic = json.loads((MAP / "classic_metrics.json").read_text(encoding="utf-8"))
    new_blocks = json.loads((MAP / "new_service_metrics.json").read_text(encoding="utf-8"))

    service_mappings: list[dict] = []
    all_classic = classic["default"] + classic["other"]
    matched_cf_types: set[str] = set()

    for svc_entry in all_classic:
        slug = svc_entry["slug"]
        cw_metrics = svc_entry.get("cloudwatchMetrics", [])
        builtin_metrics = svc_entry.get("builtinMetrics", [])
        if not cw_metrics and not builtin_metrics:
            continue

        classic_cw_name_set = {m["cloudwatchName"] for m in cw_metrics}
        # Builtin-only services (EC2, Lambda, RDS, …) have no HTML CW table on
        # the classic page; pull their CW names from OVERRIDES so pick_new_block
        # has something to match against.
        for m in builtin_metrics:
            ov = OVERRIDES.get(m["metricId"])
            if ov and ov[0]:
                classic_cw_name_set.add(ov[0])
        matched_blocks = pick_new_blocks(
            classic_cw_name_set,
            new_blocks,
            service_name=svc_entry["service"],
            slug=slug,
        )
        for b in matched_blocks:
            matched_cf_types.add(b["cloudFormationType"])

        # Pool recommended rows across all matched blocks, tagging each with
        # its source CloudFormation type so we can surface it in output rows.
        new_recommended: list[dict] = []
        for b in matched_blocks:
            for r in b.get("recommendedMetrics", []):
                new_recommended.append({**r, "_sourceCf": b["cloudFormationType"]})
        new_cw_to_rows: dict[str, list[dict]] = {}
        for r in new_recommended:
            new_cw_to_rows.setdefault(r.get("cloudwatchName") or "", []).append(r)

        # ── Built-in metric mappings (curated) ───────────────────────────────
        builtin_rows: list[dict] = []
        for m in builtin_metrics:
            mid = m["metricId"]
            cw, category, notes = OVERRIDES.get(mid, (None, "unknown", "no override — review manually"))
            dt_key, new_dims, dim_score, source_cf = (None, [], 0.0, None)
            if cw:
                dt_key, new_dims, dim_score, source_cf = best_new_dt_key(cw, [], new_recommended)
                if not dt_key and category != "no_direct_equivalent":
                    notes = (notes + "; " if notes else "") + (
                        "CW metric exists in AWS but is not in the new integration's "
                        "recommended-metrics list — enable recommended+custom MCS and add explicitly"
                    )
            builtin_rows.append({
                "classicMetricId": mid,
                "classicDisplayName": m["displayName"],
                "classicUnit": m["unit"],
                "cloudwatchName": cw,
                "newDtMetricKey": dt_key,
                "newDimensions": new_dims,
                "newSourceCfType": source_cf,
                "category": category,
                "notes": notes,
                "source": "override",
            })

        # ── CloudWatch-listed metric mappings (derived) ──────────────────────
        cw_rows: list[dict] = []
        for m in cw_metrics:
            cw_name = m["cloudwatchName"]
            classic_dims = m.get("dimensions", [])
            dt_key, new_dims, dim_score, source_cf = best_new_dt_key(cw_name, classic_dims, new_recommended)
            if dt_key:
                if dim_score == 1.0:
                    category = "direct"
                    notes = ""
                elif dim_score >= 0.8:
                    category = "direct"
                    notes = f"dimension set differs slightly (classic={classic_dims} vs new={new_dims})"
                else:
                    category = "dimension_change"
                    notes = f"same CW metric, different dimensioning (classic={classic_dims} vs new={new_dims})"
            elif cw_name in new_cw_to_rows:
                # recommended in new under a completely different dimension set
                first = new_cw_to_rows[cw_name][0]
                dt_key = first.get("dtMetricKey")
                new_dims = first.get("dimensions", [])
                source_cf = first.get("_sourceCf")
                category = "dimension_change"
                notes = f"no dimension-match; closest new row has dims={new_dims}"
            elif not matched_blocks:
                category = "no_new_coverage"
                notes = "no new-integration support matrix block mapped to this classic service"
            else:
                category = "requires_custom_metric"
                notes = (
                    "CW metric is real in AWS but the new integration does not include it "
                    "in the recommended-metrics list for this resource — enable recommended+custom "
                    "MCS and add it explicitly"
                )
            cw_rows.append({
                "cloudwatchName": cw_name,
                "classicUnit": m["unit"],
                "classicStatistics": m.get("statistics", ""),
                "classicDimensions": classic_dims,
                "classicRecommended": m.get("recommended", False),
                "newDtMetricKey": dt_key,
                "newDimensions": new_dims,
                "newSourceCfType": source_cf,
                "category": category,
                "notes": notes,
            })

        service_mappings.append({
            "service": svc_entry["service"],
            "slug": slug,
            "classicUrl": svc_entry["url"],
            "classicEntityType": svc_entry.get("entity_type"),
            "classicPrimaryDimension": svc_entry.get("primary_dimension"),
            "matchedNewBlocks": [
                {
                    "cloudFormationType": b["cloudFormationType"],
                    "smartscapeNode": b["smartscapeNode"],
                    "cloudwatchNamespaces": b.get("cloudwatchNamespaces", []),
                    "recommendedMetricCount": len(b.get("recommendedMetrics", [])),
                }
                for b in matched_blocks
            ],
            "builtinMetricCount": len(builtin_rows),
            "cloudwatchMetricCount": len(cw_rows),
            "builtinMetricMappings": builtin_rows,
            "cloudwatchMetricMappings": cw_rows,
        })

    # New-only services (no classic counterpart matched)
    new_only_services = [
        {
            "cloudFormationType": b["cloudFormationType"],
            "smartscapeNode": b["smartscapeNode"],
            "cloudwatchNamespaces": b.get("cloudwatchNamespaces", []),
            "recommendedMetricCount": len(b.get("recommendedMetrics", [])),
        }
        for b in new_blocks
        if b["cloudFormationType"] not in matched_cf_types
        and b.get("recommendedMetrics")
    ]

    out = {
        "generated": "2026-04-21",
        "classicServicesMapped": len(service_mappings),
        "newResourceBlocksTotal": len(new_blocks),
        "newResourceBlocksMatched": len(matched_cf_types),
        "newOnlyServiceCount": len(new_only_services),
        "serviceMappings": service_mappings,
        "newOnlyServices": new_only_services,
    }
    (MAP / "aws_mapping.json").write_text(json.dumps(out, indent=2), encoding="utf-8")

    # ── Gap analysis markdown ──────────────────────────────────────────────
    def count(pred) -> int:
        return sum(
            1
            for s in service_mappings
            for r in s["builtinMetricMappings"] + s["cloudwatchMetricMappings"]
            if pred(r)
        )

    total_builtin_rows = sum(len(s["builtinMetricMappings"]) for s in service_mappings)
    total_cw_rows = sum(len(s["cloudwatchMetricMappings"]) for s in service_mappings)
    total_cw_recommended = sum(
        1 for s in service_mappings for r in s["cloudwatchMetricMappings"] if r["classicRecommended"]
    )

    builtin_direct = sum(
        1 for s in service_mappings for r in s["builtinMetricMappings"] if r["category"] == "direct"
    )
    builtin_unit = sum(
        1 for s in service_mappings for r in s["builtinMetricMappings"] if r["category"] == "unit_conversion"
    )
    builtin_none = sum(
        1 for s in service_mappings for r in s["builtinMetricMappings"] if r["category"] == "no_direct_equivalent"
    )
    cw_direct = sum(
        1 for s in service_mappings for r in s["cloudwatchMetricMappings"] if r["category"] == "direct"
    )
    cw_dimchange = sum(
        1 for s in service_mappings for r in s["cloudwatchMetricMappings"] if r["category"] == "dimension_change"
    )
    cw_custom = sum(
        1 for s in service_mappings for r in s["cloudwatchMetricMappings"] if r["category"] == "requires_custom_metric"
    )
    cw_nocov = sum(
        1 for s in service_mappings for r in s["cloudwatchMetricMappings"] if r["category"] == "no_new_coverage"
    )

    L: list[str] = []
    L.append("# AWS Classic → New Integration Gap Analysis")
    L.append("")
    L.append(f"_Generated 2026-04-21 from `mappings/aws_mapping.json`._")
    L.append("")
    L.append("## Summary")
    L.append("")
    L.append(f"- Classic services mapped: **{len(service_mappings)}**")
    L.append(f"- New support-matrix resource blocks: **{len(new_blocks)}** (matched: **{len(matched_cf_types)}**, new-only: **{len(new_only_services)}**)")
    L.append(f"- Classic builtin metrics (the 9 `-builtin` pages, DT-curated `builtin:cloud.aws.*` keys): **{total_builtin_rows}**")
    L.append(f"  - direct: {builtin_direct}, unit_conversion: {builtin_unit}, no_direct_equivalent: {builtin_none}")
    L.append(f"- Classic raw-CloudWatch metric rows (all services): **{total_cw_rows}** (of which {total_cw_recommended} flagged Recommended)")
    L.append(f"  - direct: {cw_direct}, dimension_change: {cw_dimchange}, requires_custom_metric: {cw_custom}, no_new_coverage: {cw_nocov}")
    L.append("")
    L.append("## Category definitions")
    L.append("")
    L.append("Applied to the **builtin** metrics (9 DT-curated services):")
    L.append("- **direct** — classic `builtin:*` key maps 1:1 to a CloudWatch metric in the new integration; same unit.")
    L.append("- **unit_conversion** — the same CloudWatch metric exists but classic pre-normalises it (per-second rate, kB/s, %), so DQL must apply `rate:` or divide by the statistic period.")
    L.append("- **no_direct_equivalent** — classic metric is Dynatrace-computed (AZ/ASG rollups, ratios, utilisation %); rebuild from Smartscape or multi-metric DQL.")
    L.append("")
    L.append("Applied to the **raw-CloudWatch** metric rows (every classic page):")
    L.append("- **direct** — the new integration's recommended-metrics list covers this CloudWatch name with the same (or superset) dimensions.")
    L.append("- **dimension_change** — the new integration exposes the same CloudWatch metric but under a different dimension combo; DQL filters need to be rewritten.")
    L.append("- **requires_custom_metric** — the CloudWatch metric is published by AWS and is in the classic page, but the new integration's recommended set omits it. Customer must enable **Recommended + custom** MCS and add it explicitly.")
    L.append("- **no_new_coverage** — the new integration has no support-matrix block matching this classic service at all.")
    L.append("")

    # Per-service — two sub-tables per service
    L.append("## Per-service mapping")
    L.append("")
    for s in service_mappings:
        L.append(f"### {s['service']} (`{s['slug']}`)")
        L.append("")
        blocks = s.get("matchedNewBlocks") or []
        L.append(f"- Classic entity: `{s['classicEntityType']}` (dimension `{s['classicPrimaryDimension']}`)")
        if blocks:
            if len(blocks) == 1:
                mb = blocks[0]
                nss = ", ".join(f"`{n}`" for n in mb["cloudwatchNamespaces"]) or "_none_"
                L.append(f"- New block: `{mb['cloudFormationType']}` → Smartscape `{mb['smartscapeNode']}`")
                L.append(f"- Namespaces: {nss}")
                L.append(f"- New recommended metrics: {mb['recommendedMetricCount']}")
            else:
                L.append(f"- Matched {len(blocks)} new blocks:")
                for mb in blocks:
                    nss = ", ".join(f"`{n}`" for n in mb["cloudwatchNamespaces"]) or "_none_"
                    L.append(
                        f"  - `{mb['cloudFormationType']}` → `{mb['smartscapeNode']}` "
                        f"(namespaces: {nss}, recommended: {mb['recommendedMetricCount']})"
                    )
        else:
            L.append(f"- **New block: no match** — new integration does not yet cover this service.")
        L.append("")

        if s["builtinMetricMappings"]:
            L.append("**Built-in `builtin:cloud.aws.*` metrics**")
            L.append("")
            L.append("| Classic metric | Unit | Category | CloudWatch name | New DT key | New dims | Notes |")
            L.append("|---|---|---|---|---|---|---|")
            for r in s["builtinMetricMappings"]:
                cw = f"`{r['cloudwatchName']}`" if r["cloudwatchName"] else "_—_"
                dt = f"`{r['newDtMetricKey']}`" if r["newDtMetricKey"] else "_—_"
                nd = ", ".join(r["newDimensions"]) if r["newDimensions"] else "_—_"
                L.append(
                    f"| `{r['classicMetricId']}` | {r['classicUnit']} | {r['category']} | "
                    f"{cw} | {dt} | {nd} | {r['notes']} |"
                )
            L.append("")

        if s["cloudwatchMetricMappings"]:
            rec_rows = [r for r in s["cloudwatchMetricMappings"] if r["classicRecommended"]]
            if rec_rows:
                L.append(f"**Raw CloudWatch metrics — Recommended ({len(rec_rows)})**")
                L.append("")
                L.append("| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |")
                L.append("|---|---|---|---|---|---|---|")
                for r in rec_rows:
                    cd = ", ".join(r["classicDimensions"]) if r["classicDimensions"] else "_—_"
                    dt = f"`{r['newDtMetricKey']}`" if r["newDtMetricKey"] else "_—_"
                    nd = ", ".join(r["newDimensions"]) if r["newDimensions"] else "_—_"
                    L.append(
                        f"| `{r['cloudwatchName']}` | {r['classicUnit']} | {cd} | {r['category']} | "
                        f"{dt} | {nd} | {r['notes']} |"
                    )
                L.append("")
            non_rec = [r for r in s["cloudwatchMetricMappings"] if not r["classicRecommended"]]
            if non_rec:
                L.append(f"<details><summary>Raw CloudWatch metrics — Non-recommended ({len(non_rec)})</summary>")
                L.append("")
                L.append("| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |")
                L.append("|---|---|---|---|---|---|")
                for r in non_rec:
                    cd = ", ".join(r["classicDimensions"]) if r["classicDimensions"] else "_—_"
                    dt = f"`{r['newDtMetricKey']}`" if r["newDtMetricKey"] else "_—_"
                    nd = ", ".join(r["newDimensions"]) if r["newDimensions"] else "_—_"
                    L.append(
                        f"| `{r['cloudwatchName']}` | {r['classicUnit']} | {cd} | {r['category']} | {dt} | {nd} |"
                    )
                L.append("")
                L.append("</details>")
                L.append("")

    if new_only_services:
        L.append("## New-integration-only Smartscape resource types")
        L.append("")
        L.append("These support-matrix blocks have recommended metrics but **no classic service page mapped to them by CloudWatch-name overlap**. Some of these may well have classic pages — if so the mapping heuristic missed the link (e.g. because the classic page uses a different CloudWatch namespace for the same concept) and it's worth auditing.")
        L.append("")
        L.append("| CloudFormation type | Smartscape node | Namespaces | Recommended metrics |")
        L.append("|---|---|---|---|")
        for n in new_only_services:
            nss = ", ".join(f"`{x}`" for x in n["cloudwatchNamespaces"]) or "_none_"
            L.append(
                f"| `{n['cloudFormationType']}` | `{n['smartscapeNode']}` | {nss} | {n['recommendedMetricCount']} |"
            )
        L.append("")

    (ROOT / "GAP_ANALYSIS.md").write_text("\n".join(L), encoding="utf-8")

    print(f"Wrote mappings/aws_mapping.json")
    print(f"  classic services mapped: {len(service_mappings)}")
    print(f"  matched new blocks: {len(matched_cf_types)} / {len(new_blocks)}  (new-only: {len(new_only_services)})")
    print(f"  builtin rows: {total_builtin_rows}  (direct {builtin_direct} / unit {builtin_unit} / none {builtin_none})")
    print(f"  cw rows: {total_cw_rows}, recommended {total_cw_recommended}")
    print(f"    direct {cw_direct} / dim_change {cw_dimchange} / custom {cw_custom} / no_coverage {cw_nocov}")
    print(f"Wrote GAP_ANALYSIS.md")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
