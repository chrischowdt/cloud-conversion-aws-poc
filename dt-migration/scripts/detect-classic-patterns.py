#!/usr/bin/env python3
"""detect-classic-patterns.py — Detect classic cloud metric/entity patterns in JSON exports.

Scans dashboard, metric event, SLO, infrastructure anomaly detection, and
anomaly detector (custom alert) JSON files (produced by scan-dependencies.sh) for classic
cloud connection references. Ports the detection logic from
ui/app/utils/classicPatterns.ts to a standalone Python script for use with dtctl.

Usage:
    python3 detect-classic-patterns.py ./assessment/
    python3 detect-classic-patterns.py ./assessment/ --provider aws
    python3 detect-classic-patterns.py ./assessment/ --json

Reads: dashboards-details.json, metric-events.json, slos.json,
       infrastructure-detection.json, davis-detectors.json from the given directory.
Output: Human-readable report (default) or JSON (--json).

JSON output schema (--json):
{
  "dashboards":               [ { "asset_id", "asset_name", "provider", "metric_prefixes",
                                  "metric_keys", "entity_types", "entity_selectors" }, ... ],
  "alerts":                   [ { same fields } ],   # metric event alerts — key is "alerts"
  "slos":                     [ { same fields } ],
  "infrastructure_detection": [ { same fields } ],
  "davis_detectors":          [ { same fields } ]
}
IMPORTANT: The key for metric event alert findings is "alerts", NOT "metric_events".
"""

import argparse
import json
import os
import re
import sys
from typing import Any

# ── Classic metric prefix detection ──────────────────────────────────────────

CLASSIC_METRIC_PREFIXES: dict[str, list[str]] = {
    "aws": [
        "dt.cloud.aws.",
        "builtin:cloud.aws.",
        "ext:cloud.aws.",
        "cloud.aws.",
    ],
    "azure": [
        "dt.cloud.azure.",
        "builtin:cloud.azure.",
        "ext:cloud.azure.",
        "cloud.azure.microsoft_",
    ],
    "gcp": [
        "cloud.gcp.",
        "builtin:cloud.gcp.",
    ],
}

# ── Classic entity types ─────────────────────────────────────────────────────

CLASSIC_ENTITY_TYPES: dict[str, list[str]] = {
    "aws": [
        "ec2_instance", "ebs_volume", "aws_lambda_function",
        "auto_scaling_group", "aws_application_load_balancer",
        "aws_network_load_balancer", "elastic_load_balancer",
        "relational_database_service", "dynamo_db_table",
    ],
    "azure": [
        "azure_vm", "azure_vm_scale_set", "azure_load_balancer",
        "azure_event_hub_namespace", "azure_event_hub", "azure_redis_cache",
        "azure_function_app", "azure_storage_account", "azure_cosmos_db",
        "azure_web_app", "azure_sql_server", "azure_sql_database",
    ],
    "gcp": [
        "custom_device",
    ],
}

# ── Pattern detection functions ──────────────────────────────────────────────

def detect_classic_metrics(text: str, provider: str) -> list[str]:
    """Return classic metric prefixes found in text (with disambiguation)."""
    prefixes = CLASSIC_METRIC_PREFIXES.get(provider, [])
    found: set[str] = set()
    lower = text.lower()

    for prefix in prefixes:
        # AWS cloud.aws.* — only flag classic non-builtin (snake_case after service)
        # DAC/new-connection keys use .By.<PascalCase> dimension suffix — exclude them.
        #
        # NOTE: do NOT use a negative lookahead like (?!\.By\.[A-Z]) here. The greedy
        # [a-z0-9_]* quantifier backtracks, causing the lookahead to match mid-word
        # (e.g. on "node_cpu_usage_tota" where the next char is "l", not ".By.").
        # Instead, extract each full key token and check the whole string for ".By.".
        if provider == "aws" and prefix == "cloud.aws.":
            for m in re.finditer(r"cloud\.aws\.[a-z0-9_]+\.[a-zA-Z][\w.:\-]*", text):
                full_key = m.group(0)
                # New-connection keys have a .By.<PascalCase> segment — skip them
                if re.search(r"\.By\.[A-Z]", full_key):
                    continue
                # Must match the classic snake_case pattern after the service segment
                if re.match(r"^cloud\.aws\.[a-z0-9_]+\.[a-z][a-z0-9_]*", full_key):
                    found.add(prefix)
                    break
            continue

        # GCP cloud.gcp.* — only flag classic (2nd segment ends _googleapis_com)
        if provider == "gcp" and prefix == "cloud.gcp.":
            if re.search(r"cloud\.gcp\.[a-z0-9]+_googleapis_com\.", text):
                found.add(prefix)
            continue

        if prefix.lower() in lower:
            found.add(prefix)

    return sorted(found)


def extract_classic_metric_keys(text: str, provider: str) -> list[str]:
    """Extract full classic metric key tokens from text."""
    prefixes = CLASSIC_METRIC_PREFIXES.get(provider, [])
    found: set[str] = set()
    lower = text.lower()

    for prefix in prefixes:
        lp = prefix.lower()
        pos = 0
        while pos < len(lower):
            idx = lower.find(lp, pos)
            if idx == -1:
                break
            # Skip if embedded in a longer prefix (e.g. ext:cloud.aws.*)
            if idx > 0 and lower[idx - 1] == ":":
                pos = idx + len(lp)
                continue

            m = re.match(r"[\w.:\-]+", text[idx:])
            if m:
                key = re.sub(
                    r":(?:avg|min|max|sum|count|value|auto|fold|default|first|last|percentile\d*).*",
                    "", m.group(0), flags=re.IGNORECASE,
                )
                # AWS disambiguation
                if provider == "aws" and key.startswith("cloud.aws."):
                    if not re.match(r"^cloud\.aws\.[a-z0-9_]+\.[a-z][a-z0-9_]*", key):
                        pos = idx + 1
                        continue
                    # DAC keys use .By.<Dimension> suffix — not classic
                    if re.search(r"\.By\.[A-Z][a-zA-Z0-9]*", key):
                        pos = idx + 1
                        continue
                # GCP disambiguation
                if provider == "gcp" and key.startswith("cloud.gcp."):
                    if not re.match(r"^cloud\.gcp\.[a-z0-9]+_googleapis_com\.", key):
                        pos = idx + 1
                        continue
                found.add(key)

            pos = idx + len(prefix)

    return sorted(found)


def detect_classic_entities(text: str, provider: str) -> list[str]:
    """Return classic entity type references in DQL text."""
    types = CLASSIC_ENTITY_TYPES.get(provider, [])
    found: set[str] = set()
    for et in types:
        if re.search(rf"fetch\s+dt\.entity\.{et}\b", text, re.IGNORECASE):
            found.add(f"dt.entity.{et}")
    if provider == "azure" and re.search(r"fetch\s+dt\.entity\.azure_", text, re.IGNORECASE):
        found.add("dt.entity.azure_*")
    return sorted(found)


def detect_classic_entity_selectors(text: str, provider: str) -> list[str]:
    """Return classic entity type references in entity selector strings."""
    types = CLASSIC_ENTITY_TYPES.get(provider, [])
    found: set[str] = set()
    for et in types:
        upper = et.upper()
        if re.search(rf"type\({upper}\)", text, re.IGNORECASE):
            found.add(upper)
    return sorted(found)


# ── Asset scanning ───────────────────────────────────────────────────────────

def deep_text_extract(obj: Any) -> str:
    """Recursively extract all string values from a nested JSON structure."""
    if isinstance(obj, str):
        return obj + "\n"
    if isinstance(obj, dict):
        return "".join(deep_text_extract(v) for v in obj.values())
    if isinstance(obj, list):
        return "".join(deep_text_extract(v) for v in obj)
    return ""


def scan_asset(asset_id: str, asset_name: str, text: str, providers: list[str]) -> list[dict]:
    """Scan a single asset's text for classic patterns across providers."""
    findings: list[dict] = []
    for provider in providers:
        metrics = detect_classic_metrics(text, provider)
        keys = extract_classic_metric_keys(text, provider)
        entities = detect_classic_entities(text, provider)
        selectors = detect_classic_entity_selectors(text, provider)

        if metrics or keys or entities or selectors:
            findings.append({
                "asset_id": asset_id,
                "asset_name": asset_name,
                "provider": provider,
                "metric_prefixes": metrics,
                "metric_keys": keys,
                "entity_types": entities,
                "entity_selectors": selectors,
            })
    return findings


def load_json(path: str) -> Any:
    """Load a JSON file, returning [] if missing or invalid."""
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def scan_dashboards(
    data: Any,
    providers: list[str],
    *,
    sample_check: bool = False,
) -> list[dict]:
    """Scan dashboard JSON for classic patterns.

    If sample_check=True, prints a coverage summary: total dashboards,
    how many were skipped due to fetch errors, how many were successfully
    scanned, and how many DQL query strings were actually inspected.
    """
    findings: list[dict] = []
    items = data if isinstance(data, list) else []

    total = len(items)
    error_count = 0
    scanned_count = 0
    dql_query_count = 0

    for dash in items:
        did = dash.get("id", "unknown")

        # Skip entries where the detail fetch failed (e.g. auth error)
        if "error" in dash and len(dash) <= 2:
            error_count += 1
            continue

        scanned_count += 1
        name = dash.get("name", dash.get("dashboardMetadata", {}).get("name", did))

        # Count DQL query strings for --sample-check confidence metric
        if sample_check:
            dql_query_count += _count_dql_queries(dash)

        text = deep_text_extract(dash)
        findings.extend(scan_asset(did, name, text, providers))

    if sample_check:
        print("── Dashboard Scan Coverage ──────────────────────")
        print(f"  Total entries in dashboards-details.json : {total}")
        print(f"  Successfully fetched (scanned)           : {scanned_count}")
        print(f"  Skipped — fetch error (auth/access)      : {error_count}")
        print(f"  DQL query strings inspected              : {dql_query_count}")
        if error_count > 0:
            pct = error_count * 100 // total if total else 0
            print(f"  ⚠ {pct}% of dashboards were NOT scanned due to fetch errors.")
            print(f"    Re-run scan-dependencies.sh with a valid token to get full coverage.")
        print("─────────────────────────────────────────────────")

    return findings


def _count_dql_queries(dash: dict) -> int:
    """Count DQL query strings in a dashboard tile structure.

    Supports both the new platform dashboard schema (content.tiles dict)
    and the legacy schema (top-level tiles list/dict or layoutV2.tiles).
    """
    count = 0
    # New platform: tiles live under content.tiles
    content = dash.get("content", {})
    tiles = (
        content.get("tiles")
        or dash.get("tiles")
        or dash.get("layoutV2", {}).get("tiles")
        or []
    )
    if isinstance(tiles, dict):
        tiles = list(tiles.values())
    for tile in tiles:
        if isinstance(tile, dict):
            if tile.get("query"):
                count += 1
            for q in tile.get("queries", []):
                if isinstance(q, dict) and q.get("query"):
                    count += 1
    return count


def scan_metric_events(data: Any, providers: list[str]) -> list[dict]:
    """Scan metric event alert JSON for classic patterns."""
    findings: list[dict] = []
    items = data if isinstance(data, list) else data.get("items", [])
    for evt in items:
        eid = evt.get("objectId", evt.get("id", "unknown"))
        val = evt.get("value", evt)
        name = val.get("summary", val.get("queryDefinition", {}).get("metricKey", eid))
        text = deep_text_extract(evt)
        findings.extend(scan_asset(eid, name, text, providers))
    return findings


def scan_slos(data: Any, providers: list[str]) -> list[dict]:
    """Scan SLO JSON for classic patterns."""
    findings: list[dict] = []
    if data is None:
        return findings
    items = data if isinstance(data, list) else data.get("slo", data.get("items", []))
    for slo in items:
        sid = slo.get("id", "unknown")
        name = slo.get("name", sid)
        text = deep_text_extract(slo)
        findings.extend(scan_asset(sid, name, text, providers))
    return findings


def scan_infrastructure_detection(data: Any, providers: list[str]) -> list[dict]:
    """Scan AWS infrastructure anomaly detection settings for classic references.

    Any object in this schema signals classic AWS entity type monitoring.
    Only produces findings when 'aws' is in the providers list.
    """
    findings: list[dict] = []
    if "aws" not in providers:
        return findings
    items = data if isinstance(data, list) else data.get("items", [])
    for obj in items:
        oid = obj.get("objectId", obj.get("id", "unknown"))
        findings.append({
            "asset_id": oid,
            "asset_name": "AWS Infrastructure Anomaly Detection",
            "provider": "aws",
            "metric_prefixes": [],
            "metric_keys": [],
            "entity_types": ["Classic AWS entity types"],
            "entity_selectors": [],
        })
    return findings


def scan_davis_detectors(data: Any, providers: list[str]) -> list[dict]:
    """Scan anomaly detector (custom alert) settings for classic metric references.

    Extracts analyzer input field values and applies classic pattern detection
    to identify detectors that reference classic cloud metrics.
    """
    findings: list[dict] = []
    items = data if isinstance(data, list) else data.get("items", [])
    for obj in items:
        oid = obj.get("objectId", obj.get("id", "unknown"))
        val = obj.get("value", obj)

        # Extract analyzer input field values
        analyzer = val.get("analyzer", {})
        input_fields = analyzer.get("input", []) if isinstance(analyzer, dict) else []
        texts_to_scan: list[str] = []
        for field in input_fields:
            if isinstance(field, dict) and isinstance(field.get("value"), str) and field["value"]:
                texts_to_scan.append(field["value"])

        if not texts_to_scan:
            continue

        # Detect classic patterns in each input value
        name = (
            val.get("title", "")
            or val.get("name", "")
            or oid
        )

        for provider in providers:
            all_keys: set[str] = set()
            matching_inputs: list[str] = []
            for text in texts_to_scan:
                if detect_classic_metrics(text, provider):
                    all_keys.update(extract_classic_metric_keys(text, provider))
                    matching_inputs.append(text)

            if not all_keys:
                continue

            findings.append({
                "asset_id": oid,
                "asset_name": name,
                "provider": provider,
                "metric_prefixes": [],
                "metric_keys": sorted(all_keys),
                "entity_types": [],
                "entity_selectors": [],
                "matching_inputs": matching_inputs,
            })

    return findings


# ── Report output ────────────────────────────────────────────────────────────

def print_findings(label: str, findings: list[dict]) -> None:
    """Print findings in human-readable format."""
    if not findings:
        print(f"\n{label}: ✓ No classic references found")
        return

    unique_assets = {f["asset_id"] for f in findings}
    print(f"\n{label}: ✗ {len(unique_assets)} asset(s) with classic references")
    for f in findings:
        print(f"  • {f['asset_name']} [{f['provider'].upper()}]")
        if f["metric_keys"]:
            print(f"    metric keys: {', '.join(f['metric_keys'])}")
        elif f["metric_prefixes"]:
            print(f"    metric prefixes: {', '.join(f['metric_prefixes'])}")
        if f["entity_types"]:
            print(f"    entity types: {', '.join(f['entity_types'])}")
        if f["entity_selectors"]:
            print(f"    entity selectors: {', '.join(f['entity_selectors'])}")


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Detect classic cloud metric/entity patterns in dependency scan exports."
    )
    parser.add_argument("directory", help="Path to assessment directory with JSON exports")
    parser.add_argument("--provider", choices=["aws", "azure", "gcp", "all"], default="all",
                        help="Limit detection to a single provider (default: all)")
    parser.add_argument("--json", dest="json_output", action="store_true",
                        help="Output results as JSON instead of human-readable text")
    parser.add_argument("--sample-check", dest="sample_check", action="store_true",
                        help="Print dashboard scan coverage stats: total/scanned/errored entries "
                             "and number of DQL queries actually inspected")
    args = parser.parse_args()

    if not os.path.isdir(args.directory):
        print(f"Error: {args.directory} is not a directory", file=sys.stderr)
        sys.exit(1)

    providers = [args.provider] if args.provider != "all" else ["aws", "azure", "gcp"]

    dashboards = load_json(os.path.join(args.directory, "dashboards-details.json"))
    metric_events = load_json(os.path.join(args.directory, "metric-events.json"))
    slos = load_json(os.path.join(args.directory, "slos.json"))
    infra_detection = load_json(os.path.join(args.directory, "infrastructure-detection.json"))
    davis_detectors = load_json(os.path.join(args.directory, "davis-detectors.json"))

    dash_findings = scan_dashboards(dashboards, providers, sample_check=args.sample_check)
    alert_findings = scan_metric_events(metric_events, providers)
    slo_findings = scan_slos(slos, providers)
    infra_findings = scan_infrastructure_detection(infra_detection, providers)
    davis_findings = scan_davis_detectors(davis_detectors, providers)

    all_findings = {
        "dashboards": dash_findings,
        "alerts": alert_findings,
        "slos": slo_findings,
        "infrastructure_detection": infra_findings,
        "davis_detectors": davis_findings,
    }

    if args.json_output:
        json.dump(all_findings, sys.stdout, indent=2)
        print()
    else:
        total = (len(dash_findings) + len(alert_findings) + len(slo_findings)
                 + len(infra_findings) + len(davis_findings))
        print("═══ Classic Pattern Detection Report ═══")
        print(f"Providers: {', '.join(p.upper() for p in providers)}")
        print_findings("Dashboards", dash_findings)
        print_findings("Metric Event Alerts", alert_findings)
        print_findings("Infrastructure Anomaly Detection", infra_findings)
        print_findings("Anomaly Detectors (Custom Alerts)", davis_findings)
        print_findings("SLOs", slo_findings)
        print(f"\n═══ Total: {total} classic reference(s) found ═══")

    if dash_findings or alert_findings or slo_findings or infra_findings or davis_findings:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
