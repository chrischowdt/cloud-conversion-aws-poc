#!/usr/bin/env python3
"""Fetch all Dynatrace AWS docs pages (classic per-service + new support matrix)
and extract structured metric data into JSON.

Classic per-service pages use two different rendering formats:

  1. The 9 *built-in* pages (EC2, RDS, Lambda, EBS, ALB/NLB, ELB, DynamoDB,
     EC2-AutoScaling, S3) embed a MetricV2Table inside the Next.js RSC stream
     payload. Those JSON fragments live as a JS string literal so every `"`
     is backslash-escaped. We unescape, then regex out each metric object.
     These expose Dynatrace-curated `builtin:cloud.aws.*` metric IDs.

  2. All other classic service pages (MQ, DocDB, Neptune, App Runner, ...)
     render a plain HTML `<table>` with columns
     [Name, Description, Unit, Statistics, Dimensions, Recommended]. The
     "Recommended" cell holds an <img title="Applicable"> when the metric
     is in the classic integration's recommended-metrics set. These rows
     carry raw CloudWatch metric names, not Dynatrace builtin keys.

The new "aws-support-matrix-file" page is rendered HTML. Each resource section
is delimited by an H3 containing an `AWS::X::Y` code. Inside each section we
look for an `<h5>` naming the CloudWatch namespace and `<h6>` subsections for
"Recommended metrics" and "Auto-discovery", then pull metric names from the
following table.

Output:
  data/classic-html/<slug>.html         raw cache
  data/new-html/support-matrix.html     raw cache
  mappings/classic_metrics.json         {default: [...], other: [...]} — each
                                         service entry now carries
                                         builtinMetrics + cloudwatchMetrics
  mappings/new_service_metrics.json     [{cloudFormationType, namespace, metrics, ...}]
"""
from __future__ import annotations

import concurrent.futures as cf
import html as html_mod
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MAP = ROOT / "mappings"
CLASSIC_HTML = DATA / "classic-html"
NEW_HTML = DATA / "new-html"
for d in (CLASSIC_HTML, NEW_HTML, MAP):
    d.mkdir(parents=True, exist_ok=True)

BASE = "https://docs.dynatrace.com"
NEW_MATRIX_PATH = "/docs/ingest-from/amazon-web-services/aws-support-matrix-file"
UA = "Mozilla/5.0 (compatible; cloud-conversion-research/1.0)"


def fetch(url: str, dest: Path, force: bool = False) -> str:
    if dest.exists() and not force and dest.stat().st_size > 0:
        return dest.read_text(encoding="utf-8", errors="replace")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        html_bytes = r.read().decode("utf-8", errors="replace")
    dest.write_text(html_bytes, encoding="utf-8")
    return html_bytes


# ── Classic parser ───────────────────────────────────────────────────────────

METRIC_OBJ_RE = re.compile(
    r'\{"metricId":"(?P<metricId>builtin:cloud\.aws[^"]+)"'
    r',"displayName":"(?P<displayName>[^"]*)"'
    r',"description":"(?P<description>[^"]*)"'
    r',"unit":"(?P<unit>[^"]*)"'
    r',"billable":(?P<billable>true|false)'
    r',"aggregationTypes":(?P<aggregationTypes>\[[^\]]*\])'
    r',"unitDisplay":"(?P<unitDisplay>[^"]*)"'
)


def parse_classic_builtin_metrics(html: str) -> list[dict]:
    """Extract Dynatrace-curated `builtin:cloud.aws.*` entries from the RSC payload."""
    unescaped = html.replace('\\"', '"').replace("\\n", "\n")
    seen, out = set(), []
    for m in METRIC_OBJ_RE.finditer(unescaped):
        mid = m.group("metricId")
        if mid in seen:
            continue
        seen.add(mid)
        try:
            aggs = json.loads(m.group("aggregationTypes"))
        except Exception:
            aggs = []
        out.append({
            "metricId": mid,
            "displayName": m.group("displayName"),
            "description": m.group("description"),
            "unit": m.group("unit"),
            "unitDisplay": m.group("unitDisplay"),
            "billable": m.group("billable") == "true",
            "aggregationTypes": aggs,
        })
    return out


# Rendered HTML metric table parser — columns [Name, Description, Unit,
# Statistics, Dimensions, Recommended]. The "Recommended" cell either contains
# <img title="Applicable" ...> (set) or is empty/dash.
_HTML_TABLE_RE = re.compile(r"<table[^>]*>(?P<body>.*?)</table>", re.DOTALL)
_TR_RE = re.compile(r"<tr[^>]*>(?P<body>.*?)</tr>", re.DOTALL)
_TH_RE = re.compile(r"<th[^>]*>(?P<body>.*?)</th>", re.DOTALL)
_TD_RE = re.compile(r"<td[^>]*>(?P<body>.*?)</td>", re.DOTALL)
_CODE_IN_CELL_RE = re.compile(r"<code[^>]*>([^<]+)</code>")
_TAG_STRIP_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _text(raw: str) -> str:
    txt = _TAG_STRIP_RE.sub(" ", raw)
    txt = html_mod.unescape(txt)
    return _WS_RE.sub(" ", txt).strip()


def _is_applicable_cell(raw_td: str) -> bool:
    # Dynatrace docs use two variants for "this metric is recommended":
    #   1. an SVG/image with title="Applicable" or alt="Applicable"
    #   2. the literal text "yes" (newer pages)
    if 'title="Applicable"' in raw_td or 'alt="Applicable"' in raw_td:
        return True
    return _text(raw_td).lower() == "yes"


def _parse_dimensions_cell(raw_td: str) -> list[str]:
    # Dimensions cell often contains <code>X</code>, <code>Y</code> or plain "X, Y".
    codes = _CODE_IN_CELL_RE.findall(raw_td)
    if codes:
        return [c.strip() for c in codes if c.strip()]
    txt = _text(raw_td)
    if not txt or txt == "-":
        return []
    return [p.strip() for p in txt.split(",") if p.strip()]


def parse_classic_cloudwatch_metrics(html: str) -> list[dict]:
    """Extract raw-CloudWatch rows from the rendered HTML `<table>` on each
    classic service page. Returns empty list if no matching table exists."""
    unescaped = html.replace('\\"', '"').replace("\\n", "\n")
    out: list[dict] = []
    seen: set[tuple[str, tuple[str, ...]]] = set()

    for tbl_match in _HTML_TABLE_RE.finditer(unescaped):
        body = tbl_match.group("body")
        header_row = _TR_RE.search(body)
        if not header_row:
            continue
        headers = [_text(h) for h in _TH_RE.findall(header_row.group("body"))]
        lower = [h.lower() for h in headers]
        # Accept any table whose headers start with Name + Description + Unit
        # and also include a Recommended column.
        if len(lower) < 5:
            continue
        if not (lower[0] == "name" and "unit" in lower and "recommended" in lower):
            continue

        idx_name = 0
        idx_desc = lower.index("description") if "description" in lower else -1
        idx_unit = lower.index("unit")
        idx_stat = lower.index("statistics") if "statistics" in lower else -1
        idx_dim = lower.index("dimensions") if "dimensions" in lower else -1
        idx_rec = lower.index("recommended")

        # Data rows are everything after the header row
        for tr_match in list(_TR_RE.finditer(body))[1:]:
            tds_raw = _TD_RE.findall(tr_match.group("body"))
            if len(tds_raw) <= idx_rec:
                continue
            name = _text(tds_raw[idx_name])
            if not name or name.startswith("<"):
                continue
            dims = _parse_dimensions_cell(tds_raw[idx_dim]) if idx_dim >= 0 else []
            key = (name, tuple(dims))
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "cloudwatchName": name,
                "description": _text(tds_raw[idx_desc]) if idx_desc >= 0 else "",
                "unit": _text(tds_raw[idx_unit]),
                "statistics": _text(tds_raw[idx_stat]) if idx_stat >= 0 else "",
                "dimensions": dims,
                "recommended": _is_applicable_cell(tds_raw[idx_rec]),
            })
    return out


# ── Support-matrix HTML parser ───────────────────────────────────────────────

# Resource section: <h3 id="resource-aws--x--y"><code>AWS::X::Y</code>
H3_RESOURCE_RE = re.compile(
    r'<h3[^>]*id="resource-[^"]*"[^>]*>.*?<code[^>]*>(?P<type>AWS::[A-Za-z0-9:]+)</code>',
    re.DOTALL,
)
# Namespace: <h5 ...><code>AWS/X</code> OR <h5 ...>Amazon CloudWatch namespace <code>AWS/X</code>
H5_NAMESPACE_RE = re.compile(
    r'<h5[^>]*>[^<]*(?:<code[^>]*>[^<]*</code>[^<]*)*?<code[^>]*>(?P<ns>AWS/[A-Za-z0-9/]+)</code>',
    re.DOTALL,
)
# Subsection h6 — IDs are all "heading" so match by inner text
H6_BY_TEXT_RE = re.compile(
    r'<h6[^>]*>\s*(?P<title>Recommended metrics|Auto-discovery|Dimensions)\s*</h6>',
    re.IGNORECASE,
)
CODE_RE = re.compile(r"<code[^>]*>(?P<v>[^<]+)</code>")
TABLE_RE = re.compile(r"<table[^>]*>(?P<body>.*?)</table>", re.DOTALL)


def _codes_in_tables(fragment: str) -> list[str]:
    out: list[str] = []
    for t in TABLE_RE.finditer(fragment):
        out.extend(CODE_RE.findall(t.group("body")))
    # de-noise & de-dupe
    cleaned: list[str] = []
    seen = set()
    for c in out:
        c = c.strip()
        if not c or c in seen:
            continue
        if "::" in c or "/" in c or c.startswith("AWS"):
            continue
        seen.add(c)
        cleaned.append(c)
    return cleaned


def parse_new_support_matrix(html: str) -> list[dict]:
    starts = [(m.start(), m.group("type")) for m in H3_RESOURCE_RE.finditer(html)]
    blocks: list[dict] = []
    for i, (start, typ) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(html)
        body = html[start:end]

        # All AWS/X hits inside this block (a block may have multiple namespaces)
        namespaces = sorted({m.group("ns") for m in H5_NAMESPACE_RE.finditer(body)})

        # Split into subsections by h6 title
        h6_hits = list(H6_BY_TEXT_RE.finditer(body))
        subs: dict[str, str] = {}
        for j, m in enumerate(h6_hits):
            sec_start = m.end()
            sec_end = h6_hits[j + 1].start() if j + 1 < len(h6_hits) else len(body)
            # An h6 may repeat across namespace groups; concatenate
            title = m.group("title").strip().lower()
            subs.setdefault(title, "")
            subs[title] += body[sec_start:sec_end]

        recommended_raw = _codes_in_tables(subs.get("recommended metrics", ""))
        # The "Recommended metrics" table renders each metric as:
        #   row = [ full_dt_key, cw_shortname, (optional extra dimension combo) ]
        # so entries interleave. Full keys contain "." and ".By.".
        full_keys = [r for r in recommended_raw if ".By." in r]
        short_names = [r for r in recommended_raw if ".By." not in r]

        # Auto-discovery h6 contains a Dimensions sub-table whose rows are
        # dimension combos (e.g. "InstanceId", "AutoScalingGroupName, InstanceId")
        auto_dim_combos = _codes_in_tables(subs.get("auto-discovery", ""))
        # Dimensions subsection (separate h6) if present
        dim_combos = _codes_in_tables(subs.get("dimensions", ""))
        all_dims = sorted({d for d in auto_dim_combos + dim_combos})

        # Recommended metrics as structured list, now also decoding the
        # dimension tuple from the ".By.<dim1>.<dim2>..." suffix so the
        # mapping layer can rank candidates by dimension-set similarity.
        rec_structured: list[dict] = []
        for fk in full_keys:
            m = re.match(r"cloud\.aws\.[a-z0-9_]+\.([A-Za-z0-9_%]+)\.By\.(.+)", fk)
            if m:
                cw = m.group(1)
                dims = m.group(2).split(".")
            else:
                cw, dims = None, []
            rec_structured.append({
                "dtMetricKey": fk,
                "cloudwatchName": cw,
                "dimensions": dims,
            })
        blocks.append({
            "cloudFormationType": typ,
            "smartscapeNode": typ.replace("::", "_").upper(),
            "cloudwatchNamespaces": namespaces,
            "recommendedMetrics": rec_structured,
            "recommendedMetricShortNames": sorted(set(short_names)),
            "dimensionCombos": all_dims,
        })
    return blocks


# ── Driver ───────────────────────────────────────────────────────────────────


def main() -> int:
    services = json.loads((ROOT / "scripts" / "services.json").read_text(encoding="utf-8"))
    classic_default = services["classic_default"]
    classic_other = services["classic_other"]

    def fetch_one(s: dict) -> tuple[dict, str]:
        url = BASE + s["url_path"]
        dest = CLASSIC_HTML / f"{s['slug']}.html"
        try:
            return s, fetch(url, dest)
        except Exception as e:
            print(f"FETCH FAIL {s['slug']}: {e}", file=sys.stderr)
            return s, ""

    all_services = classic_default + classic_other
    results = {"default": [], "other": []}

    with cf.ThreadPoolExecutor(max_workers=12) as ex:
        for s, page in ex.map(fetch_one, all_services):
            builtin = parse_classic_builtin_metrics(page) if page else []
            cw = parse_classic_cloudwatch_metrics(page) if page else []
            entry = {
                "service": s["service"],
                "slug": s["slug"],
                "url": BASE + s["url_path"],
                "entity_type": s.get("entity_type"),
                "primary_dimension": s.get("primary_dimension"),
                "builtinMetricCount": len(builtin),
                "cloudwatchMetricCount": len(cw),
                "recommendedCount": sum(1 for m in cw if m["recommended"]),
                "builtinMetrics": builtin,
                "cloudwatchMetrics": cw,
            }
            bucket = "default" if s in classic_default else "other"
            results[bucket].append(entry)

    (MAP / "classic_metrics.json").write_text(
        json.dumps(results, indent=2, sort_keys=False), encoding="utf-8"
    )

    new_html = fetch(BASE + NEW_MATRIX_PATH, NEW_HTML / "support-matrix.html")
    new_blocks = parse_new_support_matrix(new_html)
    (MAP / "new_service_metrics.json").write_text(
        json.dumps(new_blocks, indent=2), encoding="utf-8"
    )

    total_builtin = sum(e["builtinMetricCount"] for b in results.values() for e in b)
    total_cw = sum(e["cloudwatchMetricCount"] for b in results.values() for e in b)
    total_rec = sum(e["recommendedCount"] for b in results.values() for e in b)
    empty_classic = [e["slug"] for b in results.values() for e in b
                     if e["builtinMetricCount"] == 0 and e["cloudwatchMetricCount"] == 0]
    print(f"Classic services fetched: {len(all_services)}")
    print(f"  builtin metrics (9 default services): {total_builtin}")
    print(f"  cloudwatch-listed metrics (all services): {total_cw} (of which {total_rec} flagged Recommended)")
    print(f"Classic services with 0 metrics: {len(empty_classic)}")
    if empty_classic:
        sample = ", ".join(empty_classic[:25])
        print(f"  e.g. {sample}{' ...' if len(empty_classic) > 25 else ''}")
    print(f"New support-matrix resource blocks: {len(new_blocks)}")
    with_rec = sum(1 for b in new_blocks if b["recommendedMetrics"])
    with_ns = sum(1 for b in new_blocks if b["cloudwatchNamespaces"])
    print(f"  with recommended metrics: {with_rec}")
    print(f"  with CloudWatch namespace: {with_ns}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
