#!/usr/bin/env python3
"""lookup-mapping.py — Look up metric/entity mappings from classic to new cloud connections.

Queries the authoritative JSON mapping files (DAC → 2nd Gen) to translate classic
cloud metric keys and entity types to their new connection equivalents.

Usage:
    # Single metric lookup (classic → new)
    python3 lookup-mapping.py metric --key "dt.cloud.aws.lambda.invocations" --provider aws
    python3 lookup-mapping.py metric --key "builtin:cloud.azure.apiMgmt.capacity" --provider azure

    # Bulk: all metrics for a service
    python3 lookup-mapping.py metric --service "AWS/Lambda" --provider aws
    python3 lookup-mapping.py metric --service "Microsoft.ApiManagement/service" --provider azure

    # Reverse lookup: new → classic
    python3 lookup-mapping.py metric --reverse "cloud.aws.lambda.Invocations.By.FunctionName" --provider aws

    # Entity lookup
    python3 lookup-mapping.py entity --key "EC2_INSTANCE" --provider aws
    python3 lookup-mapping.py entity --key "cloud:aws:s3" --provider aws
    python3 lookup-mapping.py entity --service "AWS::EC2::Instance" --provider aws

    # End-of-life checks
    python3 lookup-mapping.py eol --check "AWS::QLDB::Ledger"
    python3 lookup-mapping.py eol --all

    # Output formats
    python3 lookup-mapping.py metric --key "..." --provider aws --json
    python3 lookup-mapping.py metric --service "AWS/Lambda" --provider aws --format markdown

Data files: ../references/dac-{aws,azure}-to-2ndgen-{metrics,entities}.json
            ../references/end-of-life-services.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Optional

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = SCRIPT_DIR.parent / "references"

NOT_MATCHED = "not-matched"


# ── Data loading ─────────────────────────────────────────────────────────────

def load_json_file(path: Path) -> list[dict]:
    """Load a JSON array file. Exit with error if missing or invalid."""
    if not path.exists():
        print(f"Error: data file not found: {path}", file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        data = json.load(f)
    if not isinstance(data, list):
        print(f"Error: expected JSON array in {path}", file=sys.stderr)
        sys.exit(1)
    return data


def get_metric_file(provider: str, data_dir: Path) -> Path:
    """Return the metric mapping file path for a provider."""
    files = {
        "aws": data_dir / "dac-aws-to-2ndgen-metrics.json",
        "azure": data_dir / "dac-azure-to-2ndgen-metrics.json",
    }
    if provider not in files:
        print(f"Error: metric mapping files not yet available for '{provider}'. "
              f"Use heuristic fallback from metric-key-mapping.md.", file=sys.stderr)
        sys.exit(1)
    return files[provider]


def get_entity_file(provider: str, data_dir: Path) -> Path:
    """Return the entity mapping file path for a provider."""
    files = {
        "aws": data_dir / "dac-aws-to-2ndgen-entities.json",
        "azure": data_dir / "dac-azure-to-2ndgen-entities.json",
    }
    if provider not in files:
        print(f"Error: entity mapping files not yet available for '{provider}'. "
              f"Use heuristic fallback from entity-type-mapping.md.", file=sys.stderr)
        sys.exit(1)
    return files[provider]


def get_eol_file(data_dir: Path) -> Path:
    return data_dir / "end-of-life-services.json"


# ── EOL cross-reference ─────────────────────────────────────────────────────

def load_eol_index(data_dir: Path) -> dict[str, dict]:
    """Build an index of EOL services keyed by (cloud, resourceType, kind)."""
    eol_data = load_json_file(get_eol_file(data_dir))
    index: dict[str, dict] = {}
    for entry in eol_data:
        cloud = entry.get("cloud", "").lower()
        rt = entry.get("resourceType", "")
        kind = entry.get("kind") or ""
        # Index by multiple keys for flexible lookup
        index[f"{cloud}:{rt}:{kind}".lower()] = entry
        index[f"{cloud}:{rt}".lower()] = entry
        index[rt.lower()] = entry
    return index


def find_eol_info(eol_index: dict[str, dict], resource_type: str,
                  cloud: str = "", kind: str = "") -> dict | None:
    """Look up EOL info for a resource type."""
    candidates = [
        f"{cloud}:{resource_type}:{kind}".lower(),
        f"{cloud}:{resource_type}".lower(),
        resource_type.lower(),
    ]
    for key in candidates:
        if key in eol_index:
            return eol_index[key]
    return None


# ── Metric lookup ────────────────────────────────────────────────────────────

def _is_matched(value: str) -> bool:
    return value and value != NOT_MATCHED


def _classic_keys_for_entry(entry: dict, provider: str) -> list[str]:
    """Return all classic metric keys from an entry (non-not-matched)."""
    keys = []
    bi = entry.get("builtInMetricKey", NOT_MATCHED)
    if _is_matched(bi):
        keys.append(bi)
    if provider == "aws":
        sg = entry.get("secondGenMetricKey", NOT_MATCHED)
        if _is_matched(sg):
            keys.append(sg)
    elif provider == "azure":
        ss = entry.get("supportingServiceMetricKey", NOT_MATCHED)
        if _is_matched(ss):
            keys.append(ss)
    return keys


def _dac_keys_for_entry(entry: dict) -> dict[str, str]:
    """Return DAC metric keys with availability classification."""
    rec = entry.get("dacRecommendedMetricKey", NOT_MATCHED)
    auto = entry.get("dacAutodiscoveredMetricKey", NOT_MATCHED)
    result = {}
    if _is_matched(rec):
        result["recommended"] = rec
    if _is_matched(auto):
        result["autodiscovered"] = auto
    return result


def _best_dac_key(entry: dict) -> tuple[str, str]:
    """Return (key, availability) — recommended preferred over autodiscovered."""
    dac = _dac_keys_for_entry(entry)
    if "recommended" in dac:
        return dac["recommended"], "recommended"
    if "autodiscovered" in dac:
        return dac["autodiscovered"], "autodiscovered"
    return NOT_MATCHED, "none"


def _service_key_for_entry(entry: dict, provider: str) -> str:
    """Return the service identifier for grouping."""
    if provider == "aws":
        return entry.get("cloudwatchNamespace", "unknown")
    elif provider == "azure":
        return entry.get("armResourceType", "unknown")
    return "unknown"


def _format_metric_result(entry: dict, provider: str, eol_index: dict) -> dict:
    """Format a single metric entry as a result dict."""
    dac_key, availability = _best_dac_key(entry)
    dac_keys = _dac_keys_for_entry(entry)
    classic_keys = _classic_keys_for_entry(entry, provider)

    result: dict[str, Any] = {
        "classicKeys": classic_keys,
        "dacRecommendedKey": dac_keys.get("recommended", NOT_MATCHED),
        "dacAutodiscoveredKey": dac_keys.get("autodiscovered", NOT_MATCHED),
        "bestDacKey": dac_key,
        "availability": availability,
        "endOfLife": entry.get("endOfLife", False),
    }

    if provider == "aws":
        result["cloudwatchNamespace"] = entry.get("cloudwatchNamespace", "")
        result["cloudwatchMetricName"] = entry.get("cloudwatchMetricName", "")
        result["cloudwatchDimensions"] = entry.get("cloudwatchDimensions", [])
    elif provider == "azure":
        result["armResourceType"] = entry.get("armResourceType", "")
        result["azureMonitorMetricName"] = entry.get("azureMonitorMetricName", "")
        result["azureMonitorDimensions"] = entry.get("azureMonitorDimensions") or []

    # EOL enrichment
    if entry.get("endOfLife"):
        service_key = _service_key_for_entry(entry, provider)
        eol_info = find_eol_info(eol_index, service_key,
                                 cloud="aws" if provider == "aws" else "azure")
        if eol_info:
            result["eolDate"] = eol_info.get("endOfLifeDate", "unknown")
            result["eolAnnouncementUrl"] = eol_info.get("announcementUrl", "")

    # Guidance
    if availability == "recommended":
        result["guidance"] = "Available in recommended metric collection. No extra configuration needed."
    elif availability == "autodiscovered":
        result["guidance"] = ("Not in recommended set. Configure new connection with "
                              "'recommended + custom' and add this metric key as a custom metric.")
    else:
        result["guidance"] = ("No DAC mapping found. Use heuristic rules from metric-key-mapping.md "
                              "or discover the new key via live DQL query.")

    return result


# ── Key normalization helpers ────────────────────────────────────────────────

def _normalize_builtin_key(key: str) -> str | None:
    """Normalize classic key variants to builtin:<provider>.* for matching.

    The JSON builtInMetricKey field uses the Cassandra-era prefix ``builtin:aws.*``
    while alerts may reference the Grail-era prefix ``builtin:cloud.aws.*``.
    Also normalizes ``dt.cloud.aws.*`` → ``builtin:aws.*``.
    """
    if key.lower().startswith("builtin:cloud."):
        return "builtin:" + key[len("builtin:cloud."):]
    # dt.cloud.aws.ec2.cpu.usage → builtin:aws.ec2.cpu.usage
    m = re.match(r'^dt\.cloud\.(\w+)\.(.+)$', key, re.IGNORECASE)
    if m:
        return f"builtin:{m.group(1)}.{m.group(2)}"
    return None


def _strip_dimension_suffix(key: str) -> str | None:
    """Strip dimension suffix (e.g. ByRegion, ByFunctionName) from a metric key.

    The JSON secondGenMetricKey stores dimension-specific variants as suffixes:
    ``ext:cloud.aws.lambda.durationByResource`` → ``ext:cloud.aws.lambda.duration``
    Returns the stripped key, or None if no suffix was found.
    """
    m = re.search(r'By[A-Z][a-zA-Z]*$', key)
    if m:
        return key[:m.start()]
    return None


def _strip_selector_modifiers(key: str) -> str:
    """Strip metric selector modifiers like :avg, :splitBy(...), :filter(...).

    Metric event alerts may include selector chains appended to the base key.
    This returns only the base metric key.
    """
    # Prefixed keys: builtin:x.y.z or ext:x.y.z — the first : is part of the key
    if key.lower().startswith(("builtin:", "ext:")):
        prefix_end = key.index(":") + 1
        rest = key[prefix_end:]
        # Next : (if any) starts a selector modifier
        colon = rest.find(":")
        if colon != -1:
            return key[:prefix_end + colon]
        return key
    # Unprefixed keys: dt.cloud.aws.foo or cloud.aws.foo
    colon = key.find(":")
    if colon != -1:
        return key[:colon]
    return key


def _extract_service_segment(key: str, provider: str) -> str | None:
    """Extract the service segment from a classic metric key.

    Examples for AWS:
      ext:cloud.aws.lambda.duration → lambda
      builtin:cloud.aws.ec2.cpuUtilization → ec2
      builtin:aws.ec2.cpu.utilization → ec2
      dt.cloud.aws.lambda.invocations → lambda
      cloud.aws.lambda.duration → lambda

    Uses regex patterns to match all known classic prefixes, so it correctly
    handles keys like `builtin:cloud.aws.lambda.*` without producing incorrect
    service names (e.g. 'builtin:lambda') that would result from naive substring
    replacement such as str.replace('cloud.aws.', '').
    """
    if provider == "aws":
        patterns = [
            r'^(?:ext|builtin):cloud\.aws\.([^.]+)\.',
            r'^builtin:aws\.([^.]+)\.',
            r'^(?:dt\.)?cloud\.aws\.([^.]+)\.',
        ]
    elif provider == "azure":
        patterns = [
            r'^(?:ext|builtin):cloud\.azure\.([^.]+)\.',
            r'^builtin:azure\.([^.]+)\.',
            r'^(?:dt\.)?cloud\.azure\.([^.]+)\.',
        ]
    else:
        return None
    for pat in patterns:
        m = re.match(pat, key, re.IGNORECASE)
        if m:
            return m.group(1)
    return None


# Public alias — use this when grouping findings by service in migration plans
# to avoid producing incorrect service names from naive prefix stripping.
extract_service_segment = _extract_service_segment


def _resolve_namespace_for_segment(segment: str, provider: str,
                                   data: list[dict]) -> str | None:
    """Resolve the cloudwatchNamespace (AWS) or armResourceType (Azure) for a service segment.

    Scans the JSON mapping data for entries whose classic key contains the segment
    and returns their authoritative service identifier.
    """
    segment_lower = segment.lower()
    if provider == "aws":
        for entry in data:
            sg = (entry.get("secondGenMetricKey") or "").lower()
            if f"cloud.aws.{segment_lower}." in sg:
                ns = entry.get("cloudwatchNamespace", "")
                if ns:
                    return ns
    elif provider == "azure":
        for entry in data:
            ss = (entry.get("supportingServiceMetricKey") or "").lower()
            if f"cloud.azure.{segment_lower}." in ss:
                arm = entry.get("armResourceType", "")
                if arm:
                    return arm
    return None


# ── Metric lookup ── key-based with fallback chain ───────────────────────────

def _lookup_metric_exact(key: str, provider: str, data: list[dict],
                         eol_index: dict) -> list[dict]:
    """Find metric entries matching a classic key exactly (case-insensitive)."""
    key_lower = key.lower()
    results = []
    for entry in data:
        bi = (entry.get("builtInMetricKey") or "").lower()
        if provider == "aws":
            sg = (entry.get("secondGenMetricKey") or "").lower()
            if key_lower in (bi, sg):
                results.append(_format_metric_result(entry, provider, eol_index))
        elif provider == "azure":
            ss = (entry.get("supportingServiceMetricKey") or "").lower()
            if key_lower in (bi, ss):
                results.append(_format_metric_result(entry, provider, eol_index))
    return results


def _lookup_by_dac_key(key: str, provider: str, data: list[dict],
                       eol_index: dict) -> list[dict]:
    """Match input key against dacRecommendedMetricKey / dacAutodiscoveredMetricKey
    after stripping the .By.<Dim> dimension suffix from the DAC key."""
    key_lower = key.lower()
    results = []
    for entry in data:
        for field in ("dacRecommendedMetricKey", "dacAutodiscoveredMetricKey"):
            dac = (entry.get(field) or "").lower()
            if not dac or dac == NOT_MATCHED.lower():
                continue
            dac_base = re.sub(r'\.by\.[a-z].*$', '', dac, flags=re.IGNORECASE)
            if key_lower == dac_base:
                results.append(_format_metric_result(entry, provider, eol_index))
                break
    return results


def lookup_metric_by_key(key: str, provider: str, data: list[dict],
                         eol_index: dict) -> list[dict]:
    """Find metric entries matching a classic key.

    Applies a fallback chain when exact match fails:
    1. Exact match on builtInMetricKey and secondGenMetricKey
    2. Strip metric selector modifiers (:avg, :splitBy, etc.) and retry
    3. Normalize builtin:cloud.* → builtin:* prefix and retry
    4. Strip dimension suffix (By[A-Z].*) and retry (with normalization)
    5. Extract service segment, resolve cloudwatchNamespace from JSON,
       fall back to service-level lookup
    """
    # Step 1: Exact match
    results = _lookup_metric_exact(key, provider, data, eol_index)
    if results:
        return results

    # Step 2: Strip selector modifiers and retry
    clean_key = _strip_selector_modifiers(key)
    if clean_key != key:
        results = _lookup_metric_exact(clean_key, provider, data, eol_index)
        if results:
            return results
    else:
        clean_key = key

    # Step 3: Normalize builtin:cloud.* prefix and retry
    normalized = _normalize_builtin_key(clean_key)
    if normalized:
        results = _lookup_metric_exact(normalized, provider, data, eol_index)
        if results:
            return results

    # Step 3.5: Match against DAC output keys (for cloud.aws.* inputs)
    results = _lookup_by_dac_key(clean_key, provider, data, eol_index)
    if results:
        return results

    # Step 4: Strip dimension suffix and retry
    stripped = _strip_dimension_suffix(clean_key)
    if stripped and stripped != clean_key:
        results = _lookup_metric_exact(stripped, provider, data, eol_index)
        if results:
            return results
        # Also try normalized + stripped
        if normalized:
            norm_stripped = _strip_dimension_suffix(normalized)
            if norm_stripped and norm_stripped != normalized:
                results = _lookup_metric_exact(norm_stripped, provider, data, eol_index)
                if results:
                    return results

    # Step 5: Service-segment extraction → namespace → service fallback
    segment = _extract_service_segment(clean_key, provider)
    if segment:
        namespace = _resolve_namespace_for_segment(segment, provider, data)
        if namespace:
            return lookup_metric_by_service(namespace, provider, data, eol_index)

    return []


def lookup_metric_by_service(service: str, provider: str, data: list[dict],
                             eol_index: dict) -> list[dict]:
    """Find all metric entries for a service (namespace or ARM type)."""
    service_lower = service.lower()
    results = []
    for entry in data:
        entry_service = _service_key_for_entry(entry, provider).lower()
        if entry_service == service_lower:
            results.append(_format_metric_result(entry, provider, eol_index))
    return results


def lookup_metric_reverse(new_key: str, provider: str, data: list[dict],
                          eol_index: dict) -> list[dict]:
    """Find metric entries matching a new (DAC) key — reverse lookup."""
    key_lower = new_key.lower()
    results = []
    for entry in data:
        rec = (entry.get("dacRecommendedMetricKey") or "").lower()
        auto = (entry.get("dacAutodiscoveredMetricKey") or "").lower()
        if key_lower in (rec, auto):
            results.append(_format_metric_result(entry, provider, eol_index))
    return results


# ── Entity lookup ────────────────────────────────────────────────────────────

def _format_entity_result(entry: dict, provider: str, eol_index: dict) -> dict:
    """Format a single entity entry as a result dict."""
    result: dict[str, Any] = {
        "endOfLife": entry.get("endOfLife", False),
    }

    if provider == "aws":
        result["builtInEntityType"] = entry.get("builtInEntityType", NOT_MATCHED)
        result["builtInEntityName"] = entry.get("builtInEntityName", NOT_MATCHED)
        result["supportingServiceEntityType"] = entry.get("supportingServiceEntityType", NOT_MATCHED)
        result["supportingServiceEntityName"] = entry.get("supportingServiceEntityName", NOT_MATCHED)
        result["dacResourceType"] = entry.get("dacResourceType", NOT_MATCHED)
        result["dacSemDictTitle"] = entry.get("dacSemDictTitle", NOT_MATCHED)
        result["dacSemDictBrief"] = entry.get("dacSemDictBrief", NOT_MATCHED)
        resource_type = entry.get("dacResourceType", "")
    elif provider == "azure":
        result["builtInEntityType"] = entry.get("builtInEntityType", NOT_MATCHED)
        result["builtInEntityName"] = entry.get("builtInEntityName", NOT_MATCHED)
        result["supportingServiceEntityType"] = entry.get("supportingServiceEntityType", NOT_MATCHED)
        result["armResourceType"] = entry.get("armResourceType", NOT_MATCHED)
        result["smartscapeNodeType"] = entry.get("smartscapeNodeType", NOT_MATCHED)
        result["smartscapeTitle"] = entry.get("smartscapeTitle", NOT_MATCHED)
        resource_type = entry.get("armResourceType", "")
    else:
        resource_type = ""

    # EOL enrichment
    if entry.get("endOfLife"):
        cloud_name = "AWS" if provider == "aws" else "Azure"
        eol_info = find_eol_info(eol_index, resource_type, cloud=cloud_name.lower())
        if eol_info:
            result["eolDate"] = eol_info.get("endOfLifeDate", "unknown")
            result["eolAnnouncementUrl"] = eol_info.get("announcementUrl", "")

    return result


def lookup_entity_by_key(key: str, provider: str, data: list[dict],
                         eol_index: dict) -> list[dict]:
    """Find entity entries matching a classic entity type or sub-type (case-insensitive)."""
    key_lower = key.lower()
    results = []
    for entry in data:
        if provider == "aws":
            bi = (entry.get("builtInEntityType") or "").lower()
            ss = (entry.get("supportingServiceEntityType") or "").lower()
            dac = (entry.get("dacResourceType") or "").lower()
            if key_lower in (bi, ss, dac):
                results.append(_format_entity_result(entry, provider, eol_index))
        elif provider == "azure":
            bi = (entry.get("builtInEntityType") or "").lower()
            ss = (entry.get("supportingServiceEntityType") or "").lower()
            arm = (entry.get("armResourceType") or "").lower()
            ssn = (entry.get("smartscapeNodeType") or "").lower()
            if key_lower in (bi, ss, arm, ssn):
                results.append(_format_entity_result(entry, provider, eol_index))
    return results


def lookup_entity_by_service(service: str, provider: str, data: list[dict],
                             eol_index: dict) -> list[dict]:
    """Find all entity entries for a service/resource type."""
    service_lower = service.lower()
    results = []
    for entry in data:
        if provider == "aws":
            dac = (entry.get("dacResourceType") or "").lower()
            ss_name = (entry.get("supportingServiceEntityName") or "").lower()
            if service_lower in (dac, ss_name) or dac.startswith(service_lower):
                results.append(_format_entity_result(entry, provider, eol_index))
        elif provider == "azure":
            arm = (entry.get("armResourceType") or "").lower()
            if service_lower == arm or arm.startswith(service_lower):
                results.append(_format_entity_result(entry, provider, eol_index))
    return results


# ── EOL lookup ───────────────────────────────────────────────────────────────

def lookup_eol_check(resource_type: str, data_dir: Path) -> list[dict]:
    """Check EOL status for a resource type."""
    eol_data = load_json_file(get_eol_file(data_dir))
    rt_lower = resource_type.lower()
    results = []
    for entry in eol_data:
        entry_rt = (entry.get("resourceType") or "").lower()
        entry_kind = (entry.get("kind") or "").lower()
        if rt_lower == entry_rt or rt_lower == entry_kind or rt_lower in entry_rt:
            results.append(entry)
    return results


def lookup_eol_all(data_dir: Path) -> list[dict]:
    """Return all EOL services."""
    return load_json_file(get_eol_file(data_dir))


# ── Output formatting ────────────────────────────────────────────────────────

def print_json(results: list[dict]) -> None:
    """Print results as JSON."""
    json.dump(results, sys.stdout, indent=2)
    print()


def print_metric_table(results: list[dict], provider: str) -> None:
    """Print metric results as a human-readable table."""
    if not results:
        print("No matching metrics found.")
        return

    for i, r in enumerate(results):
        if i > 0:
            print("---")
        classic = ", ".join(r["classicKeys"]) if r["classicKeys"] else "(none)"
        print(f"Classic key(s):     {classic}")

        if provider == "aws":
            print(f"CloudWatch:         {r.get('cloudwatchNamespace', '')} / "
                  f"{r.get('cloudwatchMetricName', '')}")
            dims = r.get("cloudwatchDimensions", [])
            if dims:
                print(f"Dimensions:         {', '.join(dims)}")
        elif provider == "azure":
            print(f"ARM resource:       {r.get('armResourceType', '')}")
            print(f"Azure Monitor:      {r.get('azureMonitorMetricName', '')}")
            dims = r.get("azureMonitorDimensions", [])
            if dims:
                print(f"Dimensions:         {', '.join(dims)}")

        rec = r["dacRecommendedKey"]
        auto = r["dacAutodiscoveredKey"]
        if rec != NOT_MATCHED:
            print(f"DAC recommended:    {rec}")
        if auto != NOT_MATCHED and auto != rec:
            print(f"DAC autodiscovered: {auto}")
        if rec == NOT_MATCHED and auto == NOT_MATCHED:
            print(f"DAC key:            (no mapping available)")

        print(f"Availability:       {r['availability']}")
        print(f"Guidance:           {r['guidance']}")

        if r.get("endOfLife"):
            eol_date = r.get("eolDate", "unknown")
            eol_url = r.get("eolAnnouncementUrl", "")
            print(f"⚠ END OF LIFE:      {eol_date}" +
                  (f" — {eol_url}" if eol_url else ""))


def print_entity_table(results: list[dict], provider: str) -> None:
    """Print entity results as a human-readable table."""
    if not results:
        print("No matching entities found.")
        return

    for i, r in enumerate(results):
        if i > 0:
            print("---")

        bi = r.get("builtInEntityType", NOT_MATCHED)
        if _is_matched(bi):
            print(f"Built-in type:            {bi}")
            bi_name = r.get("builtInEntityName", "")
            if _is_matched(bi_name):
                print(f"Built-in name:            {bi_name}")

        if provider == "aws":
            ss = r.get("supportingServiceEntityType", NOT_MATCHED)
            if _is_matched(ss):
                print(f"Supporting service type:   {ss}")
                ss_name = r.get("supportingServiceEntityName", "")
                if _is_matched(ss_name):
                    print(f"Supporting service name:   {ss_name}")
            dac = r.get("dacResourceType", NOT_MATCHED)
            if _is_matched(dac):
                print(f"DAC resource type:        {dac}")
            title = r.get("dacSemDictTitle", NOT_MATCHED)
            if _is_matched(title):
                print(f"DAC title:                {title}")
            brief = r.get("dacSemDictBrief", NOT_MATCHED)
            if _is_matched(brief):
                print(f"DAC description:          {brief}")
        elif provider == "azure":
            ss = r.get("supportingServiceEntityType", NOT_MATCHED)
            if _is_matched(ss):
                print(f"Supporting service type:   {ss}")
            arm = r.get("armResourceType", NOT_MATCHED)
            if _is_matched(arm):
                print(f"ARM resource type:        {arm}")
            ssn = r.get("smartscapeNodeType", NOT_MATCHED)
            if _is_matched(ssn):
                print(f"Smartscape node type:     {ssn}")
            title = r.get("smartscapeTitle", NOT_MATCHED)
            if _is_matched(title):
                print(f"Smartscape title:         {title}")

        if r.get("endOfLife"):
            eol_date = r.get("eolDate", "unknown")
            eol_url = r.get("eolAnnouncementUrl", "")
            print(f"⚠ END OF LIFE:            {eol_date}" +
                  (f" — {eol_url}" if eol_url else ""))


def print_eol_table(results: list[dict]) -> None:
    """Print EOL results as a human-readable table."""
    if not results:
        print("No matching EOL services found.")
        return

    for entry in results:
        cloud = entry.get("cloud", "")
        rt = entry.get("resourceType", "")
        kind = entry.get("kind") or ""
        date = entry.get("endOfLifeDate", "unknown")
        url = entry.get("announcementUrl", "")
        kind_str = f" (kind: {kind})" if kind else ""
        print(f"⚠ {cloud} {rt}{kind_str} — EOL: {date}")
        if url:
            print(f"  Announcement: {url}")


def print_markdown_metric_table(results: list[dict], provider: str) -> None:
    """Print metric results as a markdown table for embedding in reports."""
    if not results:
        print("No matching metrics found.")
        return

    if provider == "aws":
        print("| Classic Key | CloudWatch Metric | DAC Key | Availability | Guidance |")
        print("|---|---|---|---|---|")
        for r in results:
            classic = ", ".join(r["classicKeys"]) if r["classicKeys"] else "—"
            cw = f"{r.get('cloudwatchNamespace', '')} / {r.get('cloudwatchMetricName', '')}"
            dac = r["bestDacKey"] if r["bestDacKey"] != NOT_MATCHED else "—"
            avail = r["availability"]
            eol_warn = " ⚠ EOL" if r.get("endOfLife") else ""
            guidance = r["guidance"][:60] + "…" if len(r["guidance"]) > 60 else r["guidance"]
            print(f"| `{classic}` | {cw} | `{dac}` | {avail}{eol_warn} | {guidance} |")
    elif provider == "azure":
        print("| Classic Key | ARM Type / Azure Monitor | DAC Key | Availability | Guidance |")
        print("|---|---|---|---|---|")
        for r in results:
            classic = ", ".join(r["classicKeys"]) if r["classicKeys"] else "—"
            az = f"{r.get('armResourceType', '')} / {r.get('azureMonitorMetricName', '')}"
            dac = r["bestDacKey"] if r["bestDacKey"] != NOT_MATCHED else "—"
            avail = r["availability"]
            eol_warn = " ⚠ EOL" if r.get("endOfLife") else ""
            guidance = r["guidance"][:60] + "…" if len(r["guidance"]) > 60 else r["guidance"]
            print(f"| `{classic}` | {az} | `{dac}` | {avail}{eol_warn} | {guidance} |")


def print_markdown_entity_table(results: list[dict], provider: str) -> None:
    """Print entity results as a markdown table for embedding in reports."""
    if not results:
        print("No matching entities found.")
        return

    if provider == "aws":
        print("| Built-in Type | Supporting Service | DAC Resource Type | DAC Title |")
        print("|---|---|---|---|")
        for r in results:
            bi = r.get("builtInEntityType", "—")
            bi = bi if bi != NOT_MATCHED else "—"
            ss = r.get("supportingServiceEntityType", "—")
            ss = ss if ss != NOT_MATCHED else "—"
            dac = r.get("dacResourceType", "—")
            dac = dac if dac != NOT_MATCHED else "—"
            title = r.get("dacSemDictTitle", "—")
            title = title if title != NOT_MATCHED else "—"
            eol_warn = " ⚠ EOL" if r.get("endOfLife") else ""
            print(f"| {bi} | {ss} | {dac} | {title}{eol_warn} |")
    elif provider == "azure":
        print("| Built-in Type | Supporting Service | ARM Type | Smartscape Node |")
        print("|---|---|---|---|")
        for r in results:
            bi = r.get("builtInEntityType", "—")
            bi = bi if bi != NOT_MATCHED else "—"
            ss = r.get("supportingServiceEntityType", "—")
            ss = ss if ss != NOT_MATCHED else "—"
            arm = r.get("armResourceType", "—")
            arm = arm if arm != NOT_MATCHED else "—"
            ssn = r.get("smartscapeNodeType", "—")
            ssn = ssn if ssn != NOT_MATCHED else "—"
            eol_warn = " ⚠ EOL" if r.get("endOfLife") else ""
            print(f"| {bi} | {ss} | {arm} | {ssn}{eol_warn} |")


# ── CLI ──────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Look up metric/entity mappings from classic to new cloud connections.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR,
                        help=f"Path to JSON mapping files (default: {DEFAULT_DATA_DIR})")

    sub = parser.add_subparsers(dest="command", required=True)

    # metric subcommand
    metric_p = sub.add_parser("metric", help="Look up metric key mappings")
    metric_group = metric_p.add_mutually_exclusive_group(required=True)
    metric_group.add_argument("--key", "-k", help="Classic metric key to look up")
    metric_group.add_argument("--service", "-s",
                              help="CloudWatch namespace (AWS) or ARM resource type (Azure)")
    metric_group.add_argument("--reverse", "-r", help="New (DAC) metric key for reverse lookup")
    metric_p.add_argument("--provider", "-p", required=True, choices=["aws", "azure"],
                          help="Cloud provider")
    metric_p.add_argument("--json", dest="json_output", action="store_true",
                          help="Output as JSON")
    metric_p.add_argument("--format", choices=["text", "markdown"], default="text",
                          help="Output format (default: text)")

    # entity subcommand
    entity_p = sub.add_parser("entity", help="Look up entity type mappings")
    entity_group = entity_p.add_mutually_exclusive_group(required=True)
    entity_group.add_argument("--key", "-k",
                              help="Classic entity type, sub-type, or ARM/CloudFormation type")
    entity_group.add_argument("--service", "-s",
                              help="Service/resource type for bulk entity lookup")
    entity_p.add_argument("--provider", "-p", required=True, choices=["aws", "azure"],
                          help="Cloud provider")
    entity_p.add_argument("--json", dest="json_output", action="store_true",
                          help="Output as JSON")
    entity_p.add_argument("--format", choices=["text", "markdown"], default="text",
                          help="Output format (default: text)")

    # eol subcommand
    eol_p = sub.add_parser("eol", help="Check end-of-life status for cloud services")
    eol_group = eol_p.add_mutually_exclusive_group(required=True)
    eol_group.add_argument("--check", "-c", help="Resource type to check for EOL")
    eol_group.add_argument("--all", "-a", dest="show_all", action="store_true",
                           help="List all EOL services")
    eol_p.add_argument("--json", dest="json_output", action="store_true",
                       help="Output as JSON")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    data_dir: Path = args.data_dir

    if args.command == "metric":
        metric_data = load_json_file(get_metric_file(args.provider, data_dir))
        eol_index = load_eol_index(data_dir)

        if args.key:
            results = lookup_metric_by_key(args.key, args.provider, metric_data, eol_index)
        elif args.service:
            results = lookup_metric_by_service(args.service, args.provider, metric_data, eol_index)
        elif args.reverse:
            results = lookup_metric_reverse(args.reverse, args.provider, metric_data, eol_index)
        else:
            results = []

        if not results:
            print(f"No matching metrics found for the given input.", file=sys.stderr)
            print(f"Fallback: use heuristic rules from references/metric-key-mapping.md "
                  f"or discover via live DQL query.", file=sys.stderr)
            sys.exit(0)

        if args.json_output:
            print_json(results)
        elif args.format == "markdown":
            print_markdown_metric_table(results, args.provider)
        else:
            print_metric_table(results, args.provider)

    elif args.command == "entity":
        entity_data = load_json_file(get_entity_file(args.provider, data_dir))
        eol_index = load_eol_index(data_dir)

        if args.key:
            results = lookup_entity_by_key(args.key, args.provider, entity_data, eol_index)
        elif args.service:
            results = lookup_entity_by_service(args.service, args.provider, entity_data, eol_index)
        else:
            results = []

        if not results:
            print(f"No matching entities found for the given input.", file=sys.stderr)
            print(f"Fallback: use heuristic rules from references/entity-type-mapping.md.",
                  file=sys.stderr)
            sys.exit(0)

        if args.json_output:
            print_json(results)
        elif args.format == "markdown":
            print_markdown_entity_table(results, args.provider)
        else:
            print_entity_table(results, args.provider)

    elif args.command == "eol":
        if args.check:
            results = lookup_eol_check(args.check, data_dir)
        elif args.show_all:
            results = lookup_eol_all(data_dir)
        else:
            results = []

        if not results:
            if args.check:
                print(f"No EOL information found for '{args.check}'.")
            sys.exit(0)

        if args.json_output:
            print_json(results)
        else:
            print_eol_table(results)


if __name__ == "__main__":
    main()
