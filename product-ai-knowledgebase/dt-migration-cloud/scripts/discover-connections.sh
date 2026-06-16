#!/usr/bin/env bash
# discover-connections.sh — Run all Phase 1 Step 1 connection discovery queries.
#
# Usage:  ./discover-connections.sh [--provider aws|azure|gcp|all] [--context <name>]
#
# Requires: dtctl configured and authenticated.
# Output:   JSON files in ./assessment/ — one per query.

set -euo pipefail

CONTEXT=""
CONTEXT_FLAG=""
PROVIDER_VALUE="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --context)
      CONTEXT="$2"
      CONTEXT_FLAG="--context $2"
      shift 2
      ;;
    --provider)
      PROVIDER_VALUE="$2"
      shift 2
      ;;
    *)
      PROVIDER_VALUE="$1"
      shift
      ;;
  esac
done

OUTDIR="./assessment"
mkdir -p "$OUTDIR"

run_query() {
  local label="$1"
  local query="$2"
  local outfile="$OUTDIR/${label}.json"
  local stderrfile="$OUTDIR/${label}.stderr"
  echo "▸ $label"
  if dtctl $CONTEXT_FLAG query "$query" -o json > "$outfile" 2>"$stderrfile"; then
    local count
    count=$(python3 -c "import json,sys; d=json.load(open('$outfile')); print(len(d.get('records',d.get('result',[]))))" 2>/dev/null || echo "?")
    echo "  ✓ $count record(s) → $outfile"
    if [ -s "$stderrfile" ]; then
      echo "  ⚠ warnings: $(cat "$stderrfile")" >&2
    fi
  else
    echo "  ✗ query failed — check dtctl auth" >&2
    if [ -s "$stderrfile" ]; then
      cat "$stderrfile" >&2
    fi
    echo "[]" > "$outfile"
  fi
}

# ── AWS ──────────────────────────────────────────────────────────────────────

run_aws() {
  run_query "aws-classic" \
    'fetch dt.entity.aws_credentials, from:now()-12h
| fieldsAdd awsAccountId, entity.name, id, lifetime
| fieldsRemove can_access
| sort entity.name asc'

  run_query "aws-new" \
    'smartscapeNodes AWS_ACCOUNT, from:now()-12h
| fields id, name, `aws.account.id`'

  run_query "aws-metric-streams" \
    'fetch metric.series, from:now()-12h
| filter dt.source == "AWS Metric Streams"
| summarize cnt=count(), by:`aws.account.id`'
}

# ── Azure ────────────────────────────────────────────────────────────────────

run_azure() {
  run_query "azure-classic" \
    'fetch dt.entity.azure_credentials, from:now()-12h
| fieldsAdd entity.name, id, belongs_to
| fieldsRemove can_access
| fieldsAdd sub_id = belongs_to[`dt.entity.azure_subscription`][0]
| lookup [fetch dt.entity.azure_subscription | fieldsAdd azureSubscriptionUuid],
    sourceField:sub_id, lookupField:id, prefix:"sub."
| fields entity.name, id, sub_id, sub.azureSubscriptionUuid'

  run_query "azure-classic-subscriptions" \
    'fetch dt.entity.azure_subscription, from:now()-12h
| fieldsAdd entity.name, id, azureSubscriptionUuid, lifetime
| fieldsRemove can_access
| sort entity.name asc'

  run_query "azure-new" \
    'smartscapeNodes AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS, from:now()-12h
| fields id, name, `azure.subscription`'
}

# ── GCP ──────────────────────────────────────────────────────────────────────

run_gcp() {
  run_query "gcp-classic" \
    'fetch `dt.entity.cloud:gcp:project`, from:now()-12h
| fields entity.name, id, lifetime
| sort entity.name asc'

  run_query "gcp-new" \
    'smartscapeNodes GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT, from:now()-12h
| fields id, name, `gcp.project.id`'
}

# ── Main ─────────────────────────────────────────────────────────────────────

echo "═══ Cloud Connection Discovery ═══"
echo "Output: $OUTDIR/"
echo ""

PROVIDER_VALUE_LOWER=$(echo "$PROVIDER_VALUE" | tr '[:upper:]' '[:lower:]')
case "$PROVIDER_VALUE_LOWER" in
  aws)   run_aws ;;
  azure) run_azure ;;
  gcp)   run_gcp ;;
  all)
    run_aws
    echo ""
    run_azure
    echo ""
    run_gcp
    ;;
  *)
    echo "Unknown provider: $PROVIDER_VALUE (use aws, azure, gcp, or all)" >&2
    exit 1
    ;;
esac

echo ""
echo "═══ Discovery complete. Run detect-classic-patterns.py next. ═══"
