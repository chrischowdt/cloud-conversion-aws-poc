#!/usr/bin/env python3
"""generate-assessment.py — Generate a structured migration assessment report.

Combines connection discovery results (from discover-connections.sh) with
classic pattern detection results (from detect-classic-patterns.py) into
a single Markdown assessment report.

Usage:
    python3 generate-assessment.py ./assessment/
    python3 generate-assessment.py ./assessment/ --json

Reads: aws-classic.json, aws-new.json, aws-metric-streams.json,
       azure-classic.json, azure-classic-subscriptions.json, azure-new.json,
       gcp-classic.json, gcp-new.json,
       dashboards-details.json, metric-events.json, slos.json,
       infrastructure-detection.json, davis-detectors.json
Output: Markdown report to stdout (default) or JSON (--json).
"""

import argparse
import importlib.util
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Import the pattern detector (same directory)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from importlib import import_module

# Inline the detection to avoid import issues in some environments
try:
    detect = import_module("detect-classic-patterns")
    scan_dashboards = detect.scan_dashboards
    scan_metric_events = detect.scan_metric_events
    scan_slos = detect.scan_slos
    scan_infrastructure_detection = detect.scan_infrastructure_detection
    scan_davis_detectors = detect.scan_davis_detectors
except Exception:
    # Fallback: import by path if hyphenated module name fails
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "detect_classic_patterns",
        os.path.join(SCRIPT_DIR, "detect-classic-patterns.py"),
    )
    if spec and spec.loader:
        detect = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(detect)
        scan_dashboards = detect.scan_dashboards
        scan_metric_events = detect.scan_metric_events
        scan_slos = detect.scan_slos
        scan_infrastructure_detection = detect.scan_infrastructure_detection
        scan_davis_detectors = detect.scan_davis_detectors
    else:
        print("Error: cannot import detect-classic-patterns.py", file=sys.stderr)
        sys.exit(1)

# Import the mapping lookup module
try:
    lookup_spec = importlib.util.spec_from_file_location(
        "lookup_mapping",
        os.path.join(SCRIPT_DIR, "lookup-mapping.py"),
    )
    if lookup_spec and lookup_spec.loader:
        lookup = importlib.util.module_from_spec(lookup_spec)
        lookup_spec.loader.exec_module(lookup)
        lookup_metric_by_key = lookup.lookup_metric_by_key
        lookup_entity_by_key = lookup.lookup_entity_by_key
        load_eol_index = lookup.load_eol_index
        get_metric_file = lookup.get_metric_file
        get_entity_file = lookup.get_entity_file
        load_json_file = lookup.load_json_file
        LOOKUP_AVAILABLE = True
    else:
        LOOKUP_AVAILABLE = False
except Exception:
    LOOKUP_AVAILABLE = False

REFERENCES_DIR = Path(SCRIPT_DIR).parent / "references"


def load_json(path: str) -> Any:
    """Load a JSON file, returning [] if missing, invalid, or null."""
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            result = json.load(f)
        return result if result is not None else []
    except (json.JSONDecodeError, OSError):
        return []


def extract_records(data: Any) -> list[dict]:
    """Normalize dtctl query output to a flat list of records."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("records", "result", "items", "documents", "slo"):
            if key in data and isinstance(data[key], list):
                return data[key]
    return []


# ── Connection classification ────────────────────────────────────────────────

def classify_connections(directory: str) -> list[dict]:
    """Classify each cloud account as Not Started / Parallel / Complete."""
    inventory: list[dict] = []

    # AWS — join on numeric account ID, not entity name
    classic_aws = extract_records(load_json(os.path.join(directory, "aws-classic.json")))
    new_aws = extract_records(load_json(os.path.join(directory, "aws-new.json")))
    streams = extract_records(load_json(os.path.join(directory, "aws-metric-streams.json")))

    # Classic uses awsAccountId; new Smartscape nodes use aws.account.id
    classic_by_id: dict[str, list[dict]] = {}
    for r in classic_aws:
        acct_id = r.get("awsAccountId", "")
        classic_by_id.setdefault(acct_id, []).append(r)

    new_by_id: dict[str, dict] = {}
    for r in new_aws:
        acct_id = r.get("aws.account.id", "")
        new_by_id[acct_id] = r

    stream_account_ids: set[str] = {r.get("aws.account.id", "") for r in streams}

    all_aws_ids = set(classic_by_id.keys()) | set(new_by_id.keys())
    for acct_id in sorted(all_aws_ids):
        has_classic = acct_id in classic_by_id
        has_new = acct_id in new_by_id
        if has_classic and has_new:
            status = "Parallel"
        elif has_new:
            status = "Complete"
        else:
            status = "Not Started"

        # Connection name: use classic entity name(s) if available, else new node name
        if has_classic:
            name = ", ".join(r.get("entity.name", acct_id) for r in classic_by_id[acct_id])
        else:
            name = new_by_id[acct_id].get("name", acct_id)

        blocked = acct_id in stream_account_ids and has_classic
        inventory.append({
            "provider": "AWS",
            "account_id": acct_id,
            "name": name,
            "status": status,
            "metric_streams_blocked": blocked,
        })

    # Azure
    classic_az = extract_records(load_json(os.path.join(directory, "azure-classic.json")))
    classic_subs = extract_records(load_json(os.path.join(directory, "azure-classic-subscriptions.json")))
    new_az = extract_records(load_json(os.path.join(directory, "azure-new.json")))

    classic_sub_names = {r.get("entity.name", ""): r for r in classic_subs}
    new_sub_names = {r.get("entity.name", ""): r for r in new_az}

    # Use subscriptions for matching (credentials are parent containers)
    all_azure = set(classic_sub_names.keys()) | set(new_sub_names.keys())
    for name in sorted(all_azure):
        has_classic = name in classic_sub_names
        has_new = name in new_sub_names
        if has_classic and has_new:
            status = "Parallel"
        elif has_new:
            status = "Complete"
        else:
            status = "Not Started"

        inventory.append({
            "provider": "Azure",
            "account_id": name,
            "name": name,
            "status": status,
            "metric_streams_blocked": False,
        })

    # GCP
    classic_gcp = extract_records(load_json(os.path.join(directory, "gcp-classic.json")))
    new_gcp = extract_records(load_json(os.path.join(directory, "gcp-new.json")))

    classic_gcp_names = {r.get("entity.name", ""): r for r in classic_gcp}
    new_gcp_names = {r.get("entity.name", ""): r for r in new_gcp}

    all_gcp = set(classic_gcp_names.keys()) | set(new_gcp_names.keys())
    for name in sorted(all_gcp):
        has_classic = name in classic_gcp_names
        has_new = name in new_gcp_names
        if has_classic and has_new:
            status = "Parallel"
        elif has_new:
            status = "Complete"
        else:
            status = "Not Started"

        inventory.append({
            "provider": "GCP",
            "account_id": name,
            "name": name,
            "status": status,
            "metric_streams_blocked": False,
        })

    return inventory


# ── Metric/entity mapping enrichment ─────────────────────────────────────────

def _load_mapping_data() -> dict:
    """Load metric and entity mapping data for enrichment. Returns empty dicts on failure."""
    data = {"metrics": {}, "entities": {}, "eol_index": {}}
    if not LOOKUP_AVAILABLE:
        return data
    try:
        data["eol_index"] = load_eol_index(REFERENCES_DIR)
        for provider in ("aws", "azure"):
            try:
                data["metrics"][provider] = load_json_file(get_metric_file(provider, REFERENCES_DIR))
            except SystemExit:
                data["metrics"][provider] = []
            try:
                data["entities"][provider] = load_json_file(get_entity_file(provider, REFERENCES_DIR))
            except SystemExit:
                data["entities"][provider] = []
    except Exception:
        pass
    return data


def enrich_findings(findings: list[dict], mapping_data: dict) -> list[dict]:
    """Enrich findings with mapped new metric keys and entity types."""
    if not LOOKUP_AVAILABLE or not mapping_data.get("metrics"):
        return findings

    eol_index = mapping_data.get("eol_index", {})

    for f in findings:
        provider = f.get("provider", "").lower()
        if provider not in ("aws", "azure"):
            continue

        metric_data = mapping_data["metrics"].get(provider, [])
        entity_data = mapping_data["entities"].get(provider, [])

        # Enrich metric keys
        mapped_metrics = []
        for key in f.get("metric_keys", []):
            results = lookup_metric_by_key(key, provider, metric_data, eol_index)
            for r in results:
                best = r.get("bestDacKey", "not-matched")
                if best != "not-matched":
                    mapped_metrics.append({
                        "classic": key,
                        "new": best,
                        "availability": r.get("availability", "unknown"),
                        "endOfLife": r.get("endOfLife", False),
                        "eolDate": r.get("eolDate"),
                    })
        if mapped_metrics:
            f["mapped_metrics"] = mapped_metrics

        # Enrich entity types
        mapped_entities = []
        for etype in f.get("entity_types", []):
            results = lookup_entity_by_key(etype, provider, entity_data, eol_index)
            for r in results:
                if provider == "aws":
                    new_type = r.get("dacResourceType", "not-matched")
                elif provider == "azure":
                    new_type = r.get("smartscapeNodeType", "not-matched")
                else:
                    new_type = "not-matched"
                if new_type != "not-matched":
                    mapped_entities.append({
                        "classic": etype,
                        "new": new_type,
                        "endOfLife": r.get("endOfLife", False),
                        "eolDate": r.get("eolDate"),
                    })
        if mapped_entities:
            f["mapped_entities"] = mapped_entities

    return findings


# ── Markdown report ──────────────────────────────────────────────────────────

def generate_markdown(
    inventory: list[dict],
    dash_findings: list[dict],
    alert_findings: list[dict],
    slo_findings: list[dict],
    infra_findings: list[dict],
    davis_findings: list[dict],
) -> str:
    """Generate the assessment report as Markdown."""
    lines: list[str] = []
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines.append(f"# Cloud Migration Assessment")
    lines.append(f"")
    lines.append(f"Generated: {now}")
    lines.append("")

    # Summary counts
    not_started = sum(1 for c in inventory if c["status"] == "Not Started")
    parallel = sum(1 for c in inventory if c["status"] == "Parallel")
    complete = sum(1 for c in inventory if c["status"] == "Complete")
    blocked = sum(1 for c in inventory if c.get("metric_streams_blocked"))
    lines.append(f"**Connections:** {len(inventory)} total — "
                 f"{not_started} Not Started, {parallel} Parallel, {complete} Complete"
                 f"{f', {blocked} Metric Streams blocked' if blocked else ''}")

    unique_dash = len({f["asset_id"] for f in dash_findings})
    unique_alert = len({f["asset_id"] for f in alert_findings})
    unique_slo = len({f["asset_id"] for f in slo_findings})
    unique_infra = len({f["asset_id"] for f in infra_findings})
    unique_davis = len({f["asset_id"] for f in davis_findings})
    lines.append(f"**Dependencies:** {unique_dash} dashboard(s), "
                 f"{unique_alert} metric event alert(s), "
                 f"{unique_infra} infrastructure detection object(s), "
                 f"{unique_davis} anomaly detector(s), "
                 f"{unique_slo} SLO(s) with classic references")
    lines.append("")

    # Connection inventory table
    lines.append("## Connection Inventory")
    lines.append("")
    lines.append("| Provider | Account ID | Name | Migration Status | Migration Blocked |")
    lines.append("|----------|-----------|------|-----------------|-------------------|")
    for c in inventory:
        ms = "Yes (Metric Streams)" if c.get("metric_streams_blocked") else "No"
        lines.append(f"| {c['provider']} | {c['account_id']} | {c['name']} | {c['status']} | {ms} |")
    lines.append("")

    # Dependencies
    def format_findings(label: str, findings: list[dict]) -> None:
        unique = {f["asset_id"] for f in findings}
        lines.append(f"### {label} ({len(unique)} affected)")
        lines.append("")
        if not findings:
            lines.append("No classic references found.")
            lines.append("")
            return
        for f in findings:
            parts: list[str] = []
            if f["metric_keys"]:
                parts.append(f"metrics: {', '.join(f['metric_keys'][:5])}")
                if len(f["metric_keys"]) > 5:
                    parts.append(f"…and {len(f['metric_keys']) - 5} more")
            elif f["metric_prefixes"]:
                parts.append(f"prefixes: {', '.join(f['metric_prefixes'])}")
            if f["entity_types"]:
                parts.append(f"entities: {', '.join(f['entity_types'])}")
            if f["entity_selectors"]:
                parts.append(f"selectors: {', '.join(f['entity_selectors'])}")
            detail = " — ".join(parts) if parts else "classic reference detected"
            lines.append(f"- **{f['asset_name']}** [{f['provider'].upper()}] — {detail}")

            # Include mapped new keys if available
            mapped_m = f.get("mapped_metrics", [])
            if mapped_m:
                for m in mapped_m[:5]:
                    eol_warn = " ⚠ EOL" if m.get("endOfLife") else ""
                    lines.append(f"  - `{m['classic']}` → `{m['new']}` ({m['availability']}){eol_warn}")
                if len(mapped_m) > 5:
                    lines.append(f"  - …and {len(mapped_m) - 5} more mapped metrics")
            mapped_e = f.get("mapped_entities", [])
            if mapped_e:
                for e in mapped_e[:5]:
                    eol_warn = " ⚠ EOL" if e.get("endOfLife") else ""
                    lines.append(f"  - `{e['classic']}` → `{e['new']}`{eol_warn}")
        lines.append("")

    lines.append("## Classic Dependencies Found")
    lines.append("")
    format_findings("Dashboards", dash_findings)
    format_findings("Metric Event Alerts", alert_findings)
    format_findings("Infrastructure Anomaly Detection", infra_findings)
    format_findings("Anomaly Detectors (Custom Alerts)", davis_findings)
    format_findings("SLOs", slo_findings)

    lines.append("## Out of Scope")
    lines.append("")
    lines.append("- **Classic dashboards (Config API v1)** — not scannable via dtctl.")
    lines.append("  If you have classic dashboards with cloud monitoring tiles, review them manually.")
    lines.append("")

    # Alert migration strategy note (only shown when alert findings exist)
    if alert_findings:
        lines.append("## Metric Event Alert Migration Strategy")
        lines.append("")
        lines.append("Classic metric event alerts cannot be edited in place to swap the metric key —")
        lines.append("they must be deleted and re-created with the new key.")
        lines.append("**Recommended approach (Option 1 — zero alerting gap):**")
        lines.append("")
        lines.append("1. **Now (Phase 4c)**: Create new alerts in *disabled* state using the new metric keys")
        lines.append("   from this report. Do not enable them yet.")
        lines.append("2. **After new connection ingests data (Phase 4d)**: Simultaneously disable the classic")
        lines.append("   alerts and enable the new alerts in a single operation.")
        lines.append("3. **After a validation period**: Delete the old classic alerts.")
        lines.append("")
        lines.append("> This avoids both double-alerting (both old and new active at once) and an alerting gap")
        lines.append("> (a window with no coverage). The alternative (Option 2) is to migrate alerts only")
        lines.append("> after the classic connection is removed — acceptable if a brief gap is tolerable.")
        lines.append("")
        lines.append("> **Note on `_alert` suffix keys**: Classic metric event alerts sometimes define a paired")
        lines.append("> key with an `_alert` suffix alongside the primary key")
        lines.append("> (e.g. `ext:cloud.aws.amazonmq.cpuUtilizationAverage_alert`).")
        lines.append("> These `_alert` variants are classic-only artifacts — they have no equivalent in the")
        lines.append("> new connection. When re-creating alerts with the new metric key, use only the primary")
        lines.append("> mapped new key. Do not look for or attempt to create an `_alert` variant.")
        lines.append("")

    # Infrastructure detection note (only shown when infra findings exist)
    if infra_findings:
        lines.append("## Infrastructure Anomaly Detection Note")
        lines.append("")
        lines.append("Classic AWS infrastructure anomaly detection is auto-managed by Dynatrace.")
        lines.append("**No manual migration is required.** When the new connection is active,")
        lines.append("new Smartscape entity types will have their own built-in anomaly detection.")
        lines.append("")
        lines.append("Review any **customised thresholds** on the classic infrastructure detection")
        lines.append("before disabling the classic connection — custom values do not carry over.")
        lines.append("Consider creating equivalent Anomaly Detectors with new metric keys")
        lines.append("to preserve custom monitoring behaviour.")
        lines.append("")

    # Davis detector migration note (only shown when davis findings exist)
    if davis_findings:
        lines.append("## Anomaly Detector Migration Strategy")
        lines.append("")
        lines.append("Anomaly detectors (custom alerts) referencing classic cloud metrics need their analyzer")
        lines.append("inputs updated to use new connection metric keys. Detectors must be")
        lines.append("**deleted and re-created** with updated inputs.")
        lines.append("")
        lines.append("**Recommended approach:**")
        lines.append("")
        lines.append("1. Use `lookup-mapping.py metric --key \"<classic_key>\" --provider <provider> --json`")
        lines.append("   to find the new metric key for each classic reference.")
        lines.append("2. Create a new anomaly detector in *disabled* state with the updated analyzer inputs.")
        lines.append("3. After the new connection ingests data, disable the classic detector and enable the new one.")
        lines.append("4. After validation, delete the old classic detector.")
        lines.append("")

    return "\n".join(lines)


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a cloud migration assessment report from discovery and scan data."
    )
    parser.add_argument("directory", help="Path to assessment directory with JSON exports")
    parser.add_argument("--provider", choices=["aws", "azure", "gcp", "all"], default="all",
                        help="Limit dependency scan and report to a single provider (default: all)")
    parser.add_argument("--json", dest="json_output", action="store_true",
                        help="Output as JSON instead of Markdown")
    parser.add_argument("--output", "-o", help="Write report to file instead of stdout")
    args = parser.parse_args()

    if not os.path.isdir(args.directory):
        print(f"Error: {args.directory} is not a directory", file=sys.stderr)
        sys.exit(1)

    providers = [args.provider] if args.provider != "all" else ["aws", "azure", "gcp"]

    # Classify connections (then filter to selected provider scope)
    inventory = classify_connections(args.directory)
    if args.provider != "all":
        inventory = [c for c in inventory if c["provider"].lower() == args.provider]

    # Scan dependencies
    dashboards = load_json(os.path.join(args.directory, "dashboards-details.json"))
    metric_events = load_json(os.path.join(args.directory, "metric-events.json"))
    slos = load_json(os.path.join(args.directory, "slos.json"))
    infra_detection = load_json(os.path.join(args.directory, "infrastructure-detection.json"))
    davis_detectors = load_json(os.path.join(args.directory, "davis-detectors.json"))

    dash_findings = scan_dashboards(dashboards, providers)
    alert_findings = scan_metric_events(metric_events, providers)
    slo_findings = scan_slos(slos, providers)
    infra_findings = scan_infrastructure_detection(infra_detection, providers)
    davis_findings = scan_davis_detectors(davis_detectors, providers)

    # Enrich findings with mapped new metric keys and entity types
    mapping_data = _load_mapping_data()
    dash_findings = enrich_findings(dash_findings, mapping_data)
    alert_findings = enrich_findings(alert_findings, mapping_data)
    slo_findings = enrich_findings(slo_findings, mapping_data)
    davis_findings = enrich_findings(davis_findings, mapping_data)

    if args.json_output:
        report = {
            "generated": datetime.now(timezone.utc).isoformat(),
            "inventory": inventory,
            "dependencies": {
                "dashboards": dash_findings,
                "alerts": alert_findings,
                "slos": slo_findings,
                "infrastructure_detection": infra_findings,
                "davis_detectors": davis_findings,
            },
        }
        output = json.dumps(report, indent=2)
    else:
        output = generate_markdown(
            inventory, dash_findings, alert_findings, slo_findings,
            infra_findings, davis_findings,
        )

    if args.output:
        with open(args.output, "w") as f:
            f.write(output)
            f.write("\n")
        print(f"Report written to {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
