#!/usr/bin/env bash
# scan-dependencies.sh — Run Phase 1 Step 3 dependency scans.
#
# Exports dashboards, metric event alerts, infrastructure anomaly detection,
# anomaly detectors (custom alerts), and SLOs as JSON for offline classic-pattern
# detection by detect-classic-patterns.py.
#
# Usage:  ./scan-dependencies.sh [--type dashboards|alerts|slos|all] [--context <name>]
#
# Requires: dtctl >= 0.27.0 configured and authenticated.
#           For complete dashboard coverage, the OAuth token should include
#           the document:documents:admin permission.
# Output:   JSON files in ./assessment/ — one per asset type.

set -euo pipefail

CONTEXT=""
CONTEXT_FLAG=""
TYPE_VALUE="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --context)
      CONTEXT="$2"
      CONTEXT_FLAG="--context $2"
      shift 2
      ;;
    --type)
      TYPE_VALUE="$2"
      shift 2
      ;;
    *)
      TYPE_VALUE="$1"
      shift
      ;;
  esac
done

OUTDIR="./assessment"
mkdir -p "$OUTDIR"

echo "▸ Verifying dtctl authentication…"
if ! dtctl $CONTEXT_FLAG query "fetch dt.entity.host, from:now()-1m | limit 1" -o json > /dev/null 2>&1; then
  echo "  ✗ Authentication failed — run: dtctl auth login" >&2
  exit 1
fi
echo "  ✓ Authenticated"

echo "▸ Verifying dtctl version…"
DTCTL_MIN_VERSION="0.27.0"
DTCTL_VERSION=$(dtctl version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "0.0.0")
if ! printf '%s\n%s\n' "$DTCTL_MIN_VERSION" "$DTCTL_VERSION" | sort -V -C; then
  echo "  ✗ dtctl $DTCTL_VERSION is below minimum required $DTCTL_MIN_VERSION" >&2
  echo "  Update: https://github.com/dynatrace-oss/dtctl/releases" >&2
  exit 1
fi
echo "  ✓ dtctl $DTCTL_VERSION"

# ── Dashboards ───────────────────────────────────────────────────────────────

scan_dashboards() {
  echo "▸ Scanning new dashboards (Document Service)…"
  local list_file="$OUTDIR/dashboards-list.json"

  local list_stderr="$OUTDIR/dashboards-list.stderr"
  local DASH_FILTER="not (originAppId exists and originAppId starts-with 'dynatrace.') and (type == 'dashboard')"
  local admin_used=0

  if dtctl $CONTEXT_FLAG get dashboards \
      --admin-access \
      --filter "$DASH_FILTER" \
      -o json > "$list_file" 2>"$list_stderr"; then
    admin_used=1
  else
    echo "  ⚠ --admin-access unavailable — add \`document:documents:admin\` OAuth permission for complete scan" >&2
    if ! dtctl $CONTEXT_FLAG get dashboards \
        --filter "$DASH_FILTER" \
        -o json > "$list_file" 2>"$list_stderr"; then
      echo "  ✗ dtctl get dashboards failed" >&2
      if [ -s "$list_stderr" ]; then cat "$list_stderr" >&2; fi
      echo "[]" > "$list_file"
      return
    fi
  fi

  local count
  count=$(python3 -c "
import json, sys
data = json.load(open('$list_file'))
items = data if isinstance(data, list) else data.get('documents', data.get('items', []))
print(len(items))
" 2>/dev/null || echo "?")

  local admin_note=""
  if [ "$admin_used" -eq 0 ]; then
    admin_note=" (user-visible only — add \`document:documents:admin\` for complete scan)"
  fi
  echo "  ✓ $count dashboard(s) found${admin_note}"
  if [ -s "$list_stderr" ]; then
    echo "  ⚠ warnings: $(cat "$list_stderr")" >&2
  fi

  # Fetch each dashboard's full definition for DQL tile inspection.
  # Uses direct HTTP calls (not dtctl subprocesses) to avoid macOS Keychain
  # contention when spawning many parallel processes.
  local details_file="$OUTDIR/dashboards-details.json"
  echo "  Fetching dashboard details (parallel)…"
  # Pass file paths via env vars (heredoc uses 'PYEOF' to prevent shell expansion)
  export _DT_LIST_FILE="$list_file"
  export _DT_DETAILS_FILE="$details_file"
  export _DT_CONTEXT="$CONTEXT"
  python3 << 'PYEOF'
import json, platform, subprocess, sys, base64, os, re, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

LIST_FILE = os.environ.get('_DT_LIST_FILE', '')
DETAILS_FILE = os.environ.get('_DT_DETAILS_FILE', '')

# ── Read dtctl config to find current context env URL and token-ref ──────────
config_path = os.path.expanduser(os.path.join(
    os.environ.get('HOME', ''), 'Library', 'Application Support', 'dtctl', 'config'))
try:
    with open(config_path) as f:
        config_text = f.read()
except FileNotFoundError:
    print('ERROR: dtctl config not found. Run: dtctl auth login', file=sys.stderr)
    sys.exit(1)

current_ctx_match = re.search(r'^current-context:\s*(\S+)', config_text, re.MULTILINE)
current_ctx = current_ctx_match.group(1) if current_ctx_match else ''
override_ctx = os.environ.get('_DT_CONTEXT', '')
if override_ctx:
    current_ctx = override_ctx
ctx_blocks = re.findall(
    r'-\s+name:\s*(\S+)\s*\n\s+context:\s*\n\s+environment:\s*(\S+)\s*\n\s+token-ref:\s*(\S+)',
    config_text)
env_url, token_ref = '', ''
for (name, env, ref) in ctx_blocks:
    if name == current_ctx:
        env_url, token_ref = env, ref
        break

if not env_url:
    print(f'ERROR: Could not determine environment URL for context "{current_ctx}"', file=sys.stderr)
    sys.exit(1)

# Derive SSO URL and client_id from environment URL
if '.dev.apps.' in env_url:
    sso_token_url = 'https://sso-dev.dynatracelabs.com/sso/oauth2/token'
    client_id = 'dt0s12.dtctl-dev'
    kc_acct = f'oauth:dev:{token_ref}'
elif '.sprint.apps.' in env_url:
    sso_token_url = 'https://sso-sprint.dynatracelabs.com/sso/oauth2/token'
    client_id = 'dt0s12.dtctl-sprint'
    kc_acct = f'oauth:sprint:{token_ref}'
else:
    sso_token_url = 'https://sso.dynatracelabs.com/sso/oauth2/token'
    client_id = 'dt0s12.dtctl'
    kc_acct = f'oauth:prod:{token_ref}'

# ── Get refresh token from macOS Keychain ────────────────────────────────────
if platform.system() != "Darwin":
    print("ERROR: Token auto-refresh requires macOS Keychain. Run: dtctl auth login --context <ctx>", file=sys.stderr)
    sys.exit(1)
kc_out = subprocess.run(
    ['security', 'find-generic-password', '-a', kc_acct, '-w'],
    capture_output=True, text=True).stdout.strip()
if not kc_out or 'go-keyring-base64:' not in kc_out:
    print('ERROR: Token not found in Keychain. Run: dtctl auth login', file=sys.stderr)
    sys.exit(1)

b64 = kc_out[len('go-keyring-base64:'):]
pad = 4 - len(b64) % 4
if pad != 4: b64 += '=' * pad
refresh_token = json.loads(base64.b64decode(b64).decode()).get('refresh_token', '')
if not refresh_token:
    print('ERROR: No refresh token in Keychain. Re-authenticate with: dtctl auth login', file=sys.stderr)
    sys.exit(1)

# ── Exchange refresh token for access token (one-shot, avoids Keychain lock) ─
def oauth_refresh(refresh_tok):
    data = urllib.parse.urlencode({
        'grant_type': 'refresh_token', 'refresh_token': refresh_tok,
        'client_id': client_id, 'resource': env_url
    }).encode()
    req = urllib.request.Request(sso_token_url, data=data, method='POST')
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    with urllib.request.urlopen(req, timeout=20) as resp:
        result = json.loads(resp.read())
    return result.get('access_token', ''), result.get('refresh_token', refresh_tok)

try:
    access_token, _ = oauth_refresh(refresh_token)
except Exception as e:
    print(f'ERROR: OAuth token refresh failed: {e}', file=sys.stderr)
    print('Re-authenticate with: dtctl auth login', file=sys.stderr)
    sys.exit(1)
if not access_token:
    print('ERROR: No access token in OAuth response', file=sys.stderr)
    sys.exit(1)

# ── Parse multipart/form-data response into dtctl-compatible dict ─────────────
def parse_multipart(body: bytes, content_type: str) -> dict:
    boundary = None
    for part in content_type.split(';'):
        if 'boundary=' in part:
            boundary = part.strip().split('=', 1)[1].strip('"\'')
            break
    if not boundary:
        return json.loads(body)
    parts = body.split(('--' + boundary).encode())
    metadata, content = {}, {}
    for part in parts:
        idx = part.find(b'\r\n\r\n')
        if idx == -1:
            idx = part.find(b'\n\n')
        if idx == -1:
            continue
        part_body = part[idx:].strip()
        if not part_body or part_body == b'--':
            continue
        try:
            parsed = json.loads(part_body)
            if isinstance(parsed, dict):
                # Content part: has 'tiles' key (unique to dashboard content JSON)
                if 'tiles' in parsed:
                    content = parsed
                # Metadata part: has 'name' + 'id' (unique to document metadata JSON)
                elif 'name' in parsed and 'id' in parsed:
                    metadata = parsed
        except Exception:
            pass
    return {**metadata, 'content': content}

# ── Fetch dashboards in parallel using direct HTTP (no Keychain contention) ───
with open(LIST_FILE) as f:
    data = json.load(f)
items = data if isinstance(data, list) else data.get('documents', data.get('items', []))
ids = [item.get('id', '') for item in items if item.get('id')]

def fetch_one(did):
    url = f'{env_url}/platform/document/v1/documents/{did}'
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {access_token}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            ct = resp.headers.get('Content-Type', '')
            body = resp.read()
        return parse_multipart(body, ct)
    except urllib.error.HTTPError as e:
        return {'id': did, 'error': f'HTTP {e.code}: {e.reason}'}
    except Exception as e:
        return {'id': did, 'error': str(e)}

details = []
done = 0
total = len(ids)

with ThreadPoolExecutor(max_workers=20) as pool:
    futures = {pool.submit(fetch_one, did): did for did in ids}
    for future in as_completed(futures):
        details.append(future.result())
        done += 1
        if done % 50 == 0 or done == total:
            print(f'  … {done}/{total}', flush=True)

with open(DETAILS_FILE, 'w') as f:
    json.dump(details, f, indent=2)
print(f'  ✓ {len(details)} dashboard detail(s) → {DETAILS_FILE}')
PYEOF
  unset _DT_LIST_FILE _DT_DETAILS_FILE _DT_CONTEXT
}


# ── Metric Event Alerts ─────────────────────────────────────────────────────

scan_alerts() {
  echo "▸ Scanning metric event alerts…"
  local outfile="$OUTDIR/metric-events.json"

  local stderrfile="$OUTDIR/metric-events.stderr"
  if dtctl $CONTEXT_FLAG get settings --schema builtin:anomaly-detection.metric-events -o json > "$outfile" 2>"$stderrfile"; then
    local count
    count=$(python3 -c "
import json, sys
data = json.load(open('$outfile'))
items = data if isinstance(data, list) else data.get('items', [])
print(len(items))
" 2>/dev/null || echo "?")
    echo "  ✓ $count metric event(s) → $outfile"
    if [ -s "$stderrfile" ]; then
      echo "  ⚠ warnings: $(cat "$stderrfile")" >&2
    fi
  else
    echo "  ✗ metric events fetch failed" >&2
    if [ -s "$stderrfile" ]; then
      cat "$stderrfile" >&2
    fi
    echo "[]" > "$outfile"
  fi

  # ── Infrastructure Anomaly Detection (AWS only) ──────────────────────────
  echo "▸ Scanning infrastructure anomaly detection (AWS)…"
  local infra_outfile="$OUTDIR/infrastructure-detection.json"
  local infra_stderrfile="$OUTDIR/infrastructure-detection.stderr"
  if dtctl $CONTEXT_FLAG get settings --schema builtin:anomaly-detection.infrastructure-aws --scope environment -o json > "$infra_outfile" 2>"$infra_stderrfile"; then
    local infra_count
    infra_count=$(python3 -c "
import json, sys
data = json.load(open('$infra_outfile'))
items = data if isinstance(data, list) else data.get('items', [])
print(len(items))
" 2>/dev/null || echo "?")
    echo "  ✓ $infra_count infrastructure detection object(s) → $infra_outfile"
    if [ -s "$infra_stderrfile" ]; then
      echo "  ⚠ warnings: $(cat "$infra_stderrfile")" >&2
    fi
  else
    echo "  ⚠ infrastructure detection fetch failed (may not exist) — writing []" >&2
    if [ -s "$infra_stderrfile" ]; then
      cat "$infra_stderrfile" >&2
    fi
    echo "[]" > "$infra_outfile"
  fi

  # ── Anomaly Detectors (Custom Alerts) ─────────────────────────────────────
  echo "▸ Scanning anomaly detectors (custom alerts)…"
  local davis_outfile="$OUTDIR/davis-detectors.json"
  local davis_stderrfile="$OUTDIR/davis-detectors.stderr"
  if dtctl $CONTEXT_FLAG get settings --schema builtin:davis.anomaly-detectors -o json > "$davis_outfile" 2>"$davis_stderrfile"; then
    local davis_count
    davis_count=$(python3 -c "
import json, sys
data = json.load(open('$davis_outfile'))
items = data if isinstance(data, list) else data.get('items', [])
print(len(items))
" 2>/dev/null || echo "?")
    echo "  ✓ $davis_count anomaly detector(s) → $davis_outfile"
    if [ -s "$davis_stderrfile" ]; then
      echo "  ⚠ warnings: $(cat "$davis_stderrfile")" >&2
    fi
  else
    echo "  ⚠ Anomaly detectors fetch failed (schema may not exist) — writing []" >&2
    if [ -s "$davis_stderrfile" ]; then
      cat "$davis_stderrfile" >&2
    fi
    echo "[]" > "$davis_outfile"
  fi
}

# ── SLOs ─────────────────────────────────────────────────────────────────────

scan_slos() {
  echo "▸ Scanning SLOs…"
  local outfile="$OUTDIR/slos.json"

  local stderrfile="$OUTDIR/slos.stderr"
  if dtctl $CONTEXT_FLAG get slos -o json > "$outfile" 2>"$stderrfile"; then
    local count
    count=$(python3 -c "
import json, sys
data = json.load(open('$outfile'))
items = data if isinstance(data, list) else data.get('slo', data.get('items', []))
print(len(items))
" 2>/dev/null || echo "?")
    echo "  ✓ $count SLO(s) → $outfile"
    if [ -s "$stderrfile" ]; then
      echo "  ⚠ warnings: $(cat "$stderrfile")" >&2
    fi
  else
    echo "  ✗ SLO fetch failed" >&2
    if [ -s "$stderrfile" ]; then
      cat "$stderrfile" >&2
    fi
    echo "[]" > "$outfile"
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

echo "═══ Dependency Scan ═══"
echo "Output: $OUTDIR/"
echo ""

TYPE_VALUE_LOWER=$(echo "$TYPE_VALUE" | tr '[:upper:]' '[:lower:]')
case "$TYPE_VALUE_LOWER" in
  dashboards) scan_dashboards ;;
  alerts)     scan_alerts ;;
  slos)       scan_slos ;;
  all)
    scan_dashboards
    echo ""
    scan_alerts
    echo ""
    scan_slos
    ;;
  *)
    echo "Unknown type: $TYPE_VALUE (use dashboards, alerts, slos, or all)" >&2
    exit 1
    ;;
esac

echo ""
echo "═══ Scan complete. Run detect-classic-patterns.py on the output. ═══"
