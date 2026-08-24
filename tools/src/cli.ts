#!/usr/bin/env node
/**
 * cct — cloud-conversion tooling CLI.
 *
 * Subcommands:
 *   build-mapping  Transform the reference DAC JSON into unified mappings.
 *   discover       Enumerate builtin metrics on a tenant via DQL.
 *   equivalence    Compare paired (classic, new) metric values via DQL.
 *   dql            Run a raw DQL query (for iteration).
 *
 * All tenant-touching commands use the Dynatrace Grail Storage Query API and
 * require a Platform Token (Bearer). The base URL must be the AppEngine host
 * (https://<env-id>.apps.dynatrace.com).
 */

import { runBuildMapping } from './commands/build-mapping.ts';
import { runDetect } from './commands/detect.ts';
import { runDetectAll } from './commands/detect-all.ts';
import { runDetectPerResource } from './commands/detect-per-resource.ts';
import { runDownloadDashboards } from './commands/download-dashboards.ts';
import { runDiscover } from './commands/discover.ts';
import { runDql } from './commands/dql.ts';
import { runEquivalence } from './commands/equivalence.ts';
import { runMergeRecipes } from './commands/merge-recipes.ts';
import { runCompareDashboard } from './commands/compare-dashboard.ts';
import { runDiscoverEntityTypes } from './commands/discover-entity-types.ts';
import { runDiscoverFields } from './commands/discover-fields.ts';
import { runDiscoverMetrics } from './commands/discover-metrics.ts';
import { runDiscoverTags } from './commands/discover-tags.ts';
import { runRewriteDashboard } from './commands/rewrite-dashboard.ts';
import { runRewriteDql } from './commands/rewrite-dql.ts';
import { runScanDashboards } from './commands/scan-dashboards.ts';
import { runReconcileMetrics } from './commands/reconcile-metrics.ts';
import { runDownloadNotebooks } from './commands/download-notebooks.ts';
import { runDownloadAnomalyDetectors } from './commands/download-anomaly-detectors.ts';
import { runScanNotebooks } from './commands/scan-notebooks.ts';
import { runScanAnomalyDetectors } from './commands/scan-anomaly-detectors.ts';
import { runMigrateRefresh } from './commands/migrate-refresh.ts';
import { runMigrateStage } from './commands/migrate-stage.ts';
import { runMigratePull } from './commands/migrate-pull.ts';
import { runMigratePromote } from './commands/migrate-promote.ts';
import { runMigrateVerify } from './commands/migrate-verify.ts';
import { runMigrateRollback } from './commands/migrate-rollback.ts';
import { runStageDetectors } from './commands/stage-detectors.ts';
import { runDiscoverManagementZones } from './commands/discover-management-zones.ts';
import type { ReviewBucket } from './lib/detector-notebook.ts';
import { SHARED_OUT_DIR, tenantOutDir } from './lib/paths.ts';
import type { CloudProvider } from './lib/types.ts';

interface Args {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(a.slice(2), next);
          i++;
        } else {
          flags.set(a.slice(2), true);
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function getString(flags: Map<string, string | boolean>, key: string): string | undefined {
  const v = flags.get(key);
  return typeof v === 'string' ? v : undefined;
}

function getNumber(flags: Map<string, string | boolean>, key: string): number | undefined {
  const v = getString(flags, key);
  return v === undefined ? undefined : Number(v);
}

function requireBaseAndToken(flags: Map<string, string | boolean>): {
  baseUrl: string;
  token: string;
} {
  const fromFlagBase = getString(flags, 'base-url');
  const fromFlagToken = getString(flags, 'token');
  const baseUrl = fromFlagBase ?? process.env.DT_BASE_URL;
  const token = fromFlagToken ?? process.env.DT_TOKEN;
  if (!baseUrl) {
    throw new Error(
      'Missing tenant URL. Set DT_BASE_URL in tools/.env.local or pass --base-url.'
    );
  }
  if (!token) {
    throw new Error(
      'Missing token. Set DT_TOKEN in tools/.env.local or pass --token.'
    );
  }
  if (!/\.apps\.dynatrace\.com/i.test(baseUrl)) {
    console.warn(
      `Warning: DT_BASE_URL "${baseUrl}" doesn't look like an AppEngine host. ` +
        `DQL endpoints are served at https://<env-id>.apps.dynatrace.com — if requests fail with 404, switch the URL.`
    );
  }
  const baseSrc = fromFlagBase ? 'flag' : '.env/env';
  const tokenSrc = fromFlagToken ? 'flag' : '.env/env';
  console.log(`Using tenant ${baseUrl} (base-url from ${baseSrc}, token from ${tokenSrc})`);
  return { baseUrl, token };
}

/**
 * Tenant-scoped output dir for an API-touching command. Honors `--out-dir`
 * (verbatim) and `--env` (label), otherwise derives `tools/out/<env-id>` from
 * the tenant URL. Two tenants can never write to the same directory.
 */
function tenantOut(flags: Map<string, string | boolean>, baseUrl: string): string {
  const dir = tenantOutDir({
    baseUrl,
    env: getString(flags, 'env'),
    override: getString(flags, 'out-dir'),
  });
  return dir;
}

/**
 * Output dir for an offline command that consumes tenant-scoped data (e.g.
 * `scan-dashboards` reads downloaded dashboards) but does NOT call the API.
 * Resolves the env from `--out-dir`, `--env`, `--base-url`, or DT_BASE_URL —
 * returns `undefined` when none is available so the caller can error with a
 * helpful message instead of silently writing to the wrong place.
 */
function offlineTenantOut(flags: Map<string, string | boolean>): string | undefined {
  const override = getString(flags, 'out-dir');
  const env = getString(flags, 'env');
  const baseUrl = getString(flags, 'base-url') ?? process.env.DT_BASE_URL;
  if (!override && !env && !baseUrl) return undefined;
  return tenantOutDir({ baseUrl, env, override });
}

const HELP = `cct — cloud-conversion tooling

USAGE
  cct <command> [flags]

COMMANDS
  build-mapping     Transform reference DAC metric JSON into unified mappings.
  discover          Enumerate cloud metric keys on a tenant via DQL.
  discover-tags     Find which AWS tags the new connection enriches onto
                    metrics (writes enriched-tags.json). Enriched tags become
                    cheap aws.tags.<key> dim filters; others need a
                    smartscapeNodes lookup. Flags: --from, --da-source,
                    --sample-size.
  discover-metrics  Inventory live new-connection metric keys + series counts
                    (writes live-metrics.json). The rewriter uses it to repair
                    empty .By.<Dim> variants: if a DAC-mapped key has no data
                    but a sibling dim does, it prefers the populated one.
                    Flags: --from, --da-source.
  migrate-refresh   Build/refresh the shared migration tracker (.xlsx) from
                    scan + compare + manifest artifacts already on disk. Read-only
                    (no tenant/dtctl). Assigns each AWS asset a confidence + lane
                    (fast/review/blocked) and preserves human decision/notes.
                    Flags: --env/--base-url/--out-dir, --tracker <path>.
  migrate-stage     Review lane: publish a migrated COPY of each review-lane
                    asset (original untouched) via the Document API for human
                    review. Needs an admin token (DT_BASE_URL + DT_TOKEN). Default
                    PREPARE writes the create payload; --apply creates the copy
                    (env-visible) and marks rows staged. Converted tiles carry the
                    original classic query as a // reference comment. --restage
                    updates already-staged copies in place (re-applies the rewrite)
                    instead of creating new ones. --share-group <id> (or env
                    DT_SHARE_GROUP_ID) shares each copy read-write with an access
                    group; falls back to environment-wide if neither is set.
                    Flags: --apply, --restage, --share-group <id>, --ids <a,b>,
                    --limit, --tracker.
  discover-management-zones
                    Read classic management zones and reduce each to the AWS tag
                    predicates defining it, so mzName(...) in a classicEntitySelector
                    converts to a native enriched-tag dimension filter
                    (aws.tags.<key>). Writes <tenant>/management-zones.json; every
                    command picks it up automatically. Zones with no consistent AWS
                    tag rules are left untranslated. Flags: --name-contains <s>,
                    --page-size <n>.
  stage-detectors   Alert lane: generate REVIEW NOTEBOOKS for AWS Davis anomaly
                    detectors (never a second armed detector — a notebook is
                    inert, zero double-alert risk). Rewrites each detector and
                    lays the translated queries into notebooks (batches of N),
                    one markdown + one DQL tile each, for query-only review.
                    Default PREPARE writes notebook payloads + a manifest under
                    migration/detector-review/; --apply creates the notebooks and
                    shares them. Flags: --apply, --share-group <id> (or env
                    DT_SHARE_GROUP_ID), --batch-size <n> (default 10), --buckets
                    <clean,soft> (default), --ids <a,b>, --limit, --input-file.
  migrate-pull      Fetch the human-fixed review copies (Document API) into
                    migration/reviewed/ and mark rows in-review. Needs the admin
                    token. Flags: --ids, --limit, --tracker.
  migrate-promote   Cutover: update each APPROVED original IN PLACE via the
                    Document API with admin-access (any owner). Needs an admin
                    token (DT_BASE_URL + DT_TOKEN with document:documents:read+
                    write+admin). Default PREPARE writes the payload; --apply
                    performs the write with a drift guard (--force to override)
                    + a pre-cutover snapshot. Flags: --apply, --force, --ids,
                    --limit.
  migrate-verify    Confirm a cutover landed (live version advanced). Marks
                    verified. Needs the admin token. Flags: --ids, --limit.
  migrate-rollback  Re-apply the pre-cutover snapshot (admin write) to revert a
                    promoted original. Default prints intent; --apply executes.
                    Requires --ids or --all. Flags: --apply, --ids, --all.
  reconcile-metrics Join this tenant's classic keys (discover) to their new
                    equivalents (mapping chain), then check each against the
                    live inventory (discover-metrics). Emits
                    metric-reconciliation.csv + .md showing which metrics the
                    new integration already collects, which to enable, and
                    which have no standard equivalent (custom/Metric Streams).
                    Run discover + discover-metrics first. Flags: --min-series,
                    --by-account (per-account CSV; needs discover --by-account),
                    --env/--base-url/--out-dir, --mapping.
  discover-entity-types
                    Derive the AWS service -> Smartscape node-type bridge from
                    live metrics' dt.smartscape_source.type (writes
                    entity-source-types.json). Lets the rewriter disambiguate
                    a classic custom_device to a real node type via the query's
                    metric key. Flags: --from, --da-source.
  equivalence       Test whether classic↔new metric pairs return same data.
  detect            Per pair, search aggregations + scale to find the
                    recipe that reproduces classic from new.
  detect-all        Run detect across every balanced (account, region)
                    overlap cluster from discover output, then aggregate
                    the best recipe per metric.
  detect-per-resource
                    Per metric pair, sample top-K AWS resources, fit
                    classic vs new for each (filtered by classic entity
                    ID and aws.arn), then output consensus recipes.
  merge-recipes     Fold detected recipes back into mappings/aws_mapping.json
                    and emit a punchlist of pairs that need manual research.
  rewrite-dql       Apply metric mapping + dt-migration entity rules to a
                    classic DQL query. Flags constructs needing manual
                    migration (classicEntitySelector, relationships, formulas).
  download-dashboards
                    Pull every dashboard from the tenant for offline
                    analysis: new dashboards via Document Service, classic
                    dashboards via Config API v1. Clears the target dir first
                    (fresh dump). Flags: --skip-new, --skip-classic, --limit,
                    --used-within-days <N> (scope NEW dashboards to those opened
                    in the last N days, via dt.system.events).
  download-notebooks
                    Pull every notebook (Document Service, type=notebook)
                    for offline analysis. DQL lives in
                    sections[].state.input.value. Clears the target dir first.
                    Flags: --limit, --used-within-days <N> (scope to notebooks
                    opened in the last N days).
  download-anomaly-detectors
                    Pull Davis anomaly detectors (Settings 2.0,
                    builtin:davis.anomaly-detectors) whose analyzer input
                    carries DQL. Flags: --schema to override the schema id.
  scan-notebooks    Run the rewriter against downloaded notebooks (filtered
                    to AWS-referencing ones); emits a coverage report under
                    notebook-scan/. Flags: --all, --limit, --input-dir.
  scan-anomaly-detectors
                    Run the rewriter against downloaded Davis anomaly
                    detectors; emits a coverage report under
                    anomaly-detector-scan/. Flags: --all, --limit, --input-file.
  scan-dashboards   Run the DQL rewriter against every downloaded new
                    dashboard, filtered to AWS-using ones. Emits a coverage
                    summary + per-dashboard JSONL.
  rewrite-dashboard Apply the rewriter to every query in one dashboard JSON,
                    emitting a new dashboard ready for upload + a markdown
                    transform/warning report.
  compare-dashboard Run each tile's ORIGINAL and REWRITTEN query against the
                    tenant; emit a side-by-side parity report. Confidence
                    check before piling on more translation patterns.
  dql               Run a raw DQL query and dump records (for iteration).

CREDENTIALS
  Copy tools/.env.example → tools/.env.local and fill in DT_BASE_URL and
  DT_TOKEN. The npm scripts auto-load .env.local. Flags override env.

  DT_BASE_URL must be the AppEngine host:
    https://<env-id>.apps.dynatrace.com
  DT_TOKEN must be a Platform Token with at least:
    storage:metrics:read

GLOBAL FLAGS
  --base-url        Tenant URL (overrides DT_BASE_URL)
  --token           Platform Token (overrides DT_TOKEN)
  --env <label>     Output namespace (default: env-id derived from the tenant
                    URL, e.g. https://nic55601.apps… → tools/out/nic55601).
                    Tenant-touching commands write under tools/out/<env>/ so
                    two tenants never overwrite each other's analysis.
  --out-dir <path>  Explicit output dir; overrides the per-tenant default.

OUTPUT LAYOUT
  tools/out/<env-id>/   per-tenant: dashboards/, dashboard-scan/,
                        dashboard-compare/, discover_*, detect_*, dql_*…
  tools/out/shared/     tenant-independent: build-mapping unified outputs.

build-mapping
  --provider AWS|Azure|all   default: all

discover
  Enumerate cloud.aws.* keys; per key, count classic vs new series.
  --from <token>             default: -7d (DQL relative, e.g. -1h, -24h, -30d)
  --to <token>               default: -1h (1h offset to avoid partial buckets)
  --python-mapping <path>    override path to mappings/aws_mapping.json
  --dac-metrics <path>       override path to dac-aws-to-2ndgen-metrics.json

equivalence
  Compare classic vs new keys via DQL. Pairs come from the Python scrape
  mapping. Classic side: builtin: → dt. with snake_case segments. New side:
  newDtMetricKey as-is.

  --mapping <path>           Python scrape JSON. default: mappings/aws_mapping.json
  --service <slug>           e.g. "ec2", "dynamodb", "alb"
  --limit <n>                default: 25
  --aggregation avg|sum|max|min|count   default: avg
  --from <token>             default: -25h
  --to <token>               default: -1h (1h offset to avoid partial buckets)
  --interval <token>         DQL bucket size, default: 5m
  --skip-missing             omit keys where either side is empty
  --no-skip-both-missing     keep keys where both sides are empty (default skips)

detect-per-resource
  Recipe search at per-resource scope using arn as the classic-to-new bridge.
  Yields universal scale ~ 1 recipes when shape matches.
  --mapping <path>           default: mappings/aws_mapping.json
  --service <slug>           e.g. "ec2", "alb"
  --limit <n>                default: 100 pairs
  --resource-sample <K>      resources sampled per pair, default: 5
  --from <token>             default: -25h
  --to <token>               default: -1h
  --interval <token>         DQL bucket size, default: 5m

detect
  For each (classic,new) pair: tries 2×4 = 8 (classic_agg, new_agg)
  combinations plus a least-squares scale factor k, picks the recipe
  with highest r and lowest residual sMAPE.
  --mapping <path>           default: mappings/aws_mapping.json
  --service <slug>           e.g. "ec2", "alb", "dynamodb"
  --limit <n>                default: 100
  --from <token>             default: -10d
  --to <token>               default: -8d
  --interval <token>         DQL bucket size, default: 5m
  --min-r <n>                r threshold for "fit", default: 0.85
  --filter "<dql>"           DQL filter expression applied to both sides.
                             Example: --filter 'aws.account.id == "1234"
                                       and aws.region == "us-east-1"'

dql
  --query "<dql>"            inline DQL string (or use --file)
  --file <path>              read DQL from a file
  --from <token>             default timeframe start (optional)
  --to <token>               default timeframe end (optional)
  --preview <n>              records to print to stdout (default: 10)

EXAMPLES
  cct build-mapping
  cct discover
  cct equivalence --mapping out/aws_mapping.unified.json --limit 10 --skip-missing
  cct dql --query "fetch metric.series, from:-1h | summarize by:{metric.key} | limit 50"
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.positional[0];

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
    return;
  }

  const outDirOverride = getString(args.flags, 'out-dir');

  switch (cmd) {
    case 'build-mapping': {
      const provider = (getString(args.flags, 'provider') as CloudProvider | 'all' | undefined) ?? 'all';
      // Tenant-independent — reads DAC reference files, not a live tenant.
      await runBuildMapping({ provider, outDir: outDirOverride ?? SHARED_OUT_DIR });
      return;
    }
    case 'discover': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDiscover({
        baseUrl,
        token,
        from: getString(args.flags, 'from'),
        to: getString(args.flags, 'to'),
        outDir: tenantOut(args.flags, baseUrl),
        byAccount: args.flags.get('by-account') === true,
      });
      return;
    }
    case 'equivalence': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      const aggFlag = getString(args.flags, 'aggregation');
      const allowedAgg = ['avg', 'sum', 'max', 'min', 'count'] as const;
      if (aggFlag && !(allowedAgg as readonly string[]).includes(aggFlag)) {
        throw new Error(`--aggregation must be one of ${allowedAgg.join('|')}, got "${aggFlag}".`);
      }
      await runEquivalence({
        baseUrl,
        token,
        mappingPath: getString(args.flags, 'mapping'),
        limit: getNumber(args.flags, 'limit'),
        service: getString(args.flags, 'service'),
        aggregation: aggFlag as (typeof allowedAgg)[number] | undefined,
        from: getString(args.flags, 'from'),
        to: getString(args.flags, 'to'),
        interval: getString(args.flags, 'interval'),
        skipMissing: args.flags.get('skip-missing') === true,
        skipBothMissing: args.flags.get('no-skip-both-missing') !== true,
        outDir: tenantOut(args.flags, baseUrl),
      });
      return;
    }
    case 'detect': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDetect({
        baseUrl,
        token,
        mappingPath: getString(args.flags, 'mapping'),
        limit: getNumber(args.flags, 'limit'),
        service: getString(args.flags, 'service'),
        from: getString(args.flags, 'from'),
        to: getString(args.flags, 'to'),
        interval: getString(args.flags, 'interval'),
        minR: getNumber(args.flags, 'min-r'),
        filter: getString(args.flags, 'filter'),
        outDir: tenantOut(args.flags, baseUrl),
      });
      return;
    }
    case 'detect-per-resource': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      const outDir = tenantOut(args.flags, baseUrl);
      // --accounts <id,id,...>  OR  --accounts auto  (load parallel-accounts.json
      // from this tenant's output dir)
      const accountsFlag = getString(args.flags, 'accounts');
      let accountIds: string[] | undefined;
      if (accountsFlag === 'auto') {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const parallelPath = join(outDir, 'parallel-accounts.json');
        try {
          const raw = JSON.parse(await readFile(parallelPath, 'utf8'));
          accountIds = (raw.parallel ?? []).map((p: { awsAccountId: string }) => p.awsAccountId);
          console.log(`Loaded ${accountIds!.length} parallel accounts from ${parallelPath}`);
        } catch (e) {
          throw new Error(`--accounts auto: failed to load ${parallelPath}: ${(e as Error).message}`);
        }
      } else if (accountsFlag) {
        accountIds = accountsFlag.split(',').map((s) => s.trim()).filter(Boolean);
      }
      await runDetectPerResource({
        baseUrl,
        token,
        mappingPath: getString(args.flags, 'mapping'),
        limit: getNumber(args.flags, 'limit'),
        service: getString(args.flags, 'service'),
        from: getString(args.flags, 'from'),
        to: getString(args.flags, 'to'),
        interval: getString(args.flags, 'interval'),
        resourceSample: getNumber(args.flags, 'resource-sample'),
        minR: getNumber(args.flags, 'min-r'),
        accountIds,
        outDir,
      });
      return;
    }
    case 'detect-all': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDetectAll({
        baseUrl,
        token,
        mappingPath: getString(args.flags, 'mapping'),
        from: getString(args.flags, 'from'),
        to: getString(args.flags, 'to'),
        interval: getString(args.flags, 'interval'),
        minSeries: getNumber(args.flags, 'min-series'),
        maxRatio: getNumber(args.flags, 'max-ratio'),
        maxClusters: getNumber(args.flags, 'max-clusters'),
        outDir: tenantOut(args.flags, baseUrl),
      });
      return;
    }
    case 'download-dashboards': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDownloadDashboards({
        baseUrl,
        token,
        limit: getNumber(args.flags, 'limit'),
        skipNew: args.flags.get('skip-new') === true,
        skipClassic: args.flags.get('skip-classic') === true,
        usedWithinDays: getNumber(args.flags, 'used-within-days'),
        outDir: tenantOut(args.flags, baseUrl),
      });
      return;
    }
    case 'rewrite-dql': {
      // Offline single-query rewrite — not tenant-specific. Lands in shared/
      // unless --out-dir overrides.
      await runRewriteDql({
        query: getString(args.flags, 'query'),
        file: getString(args.flags, 'file'),
        mappingPath: getString(args.flags, 'mapping'),
        outDir: outDirOverride ?? SHARED_OUT_DIR,
      });
      return;
    }
    case 'scan-dashboards': {
      // Offline, but consumes a tenant's downloaded dashboards. Resolve the
      // env from --out-dir / --env / --base-url / DT_BASE_URL.
      const outDir = offlineTenantOut(args.flags);
      if (!outDir && !getString(args.flags, 'input-dir')) {
        throw new Error(
          'scan-dashboards: cannot tell which tenant to scan. Pass --env <id>, ' +
            '--base-url <url>, set DT_BASE_URL, or pass --input-dir <dir> explicitly.'
        );
      }
      await runScanDashboards({
        inputDir: getString(args.flags, 'input-dir'),
        mappingPath: getString(args.flags, 'mapping'),
        outDir,
        limit: getNumber(args.flags, 'limit'),
        all: args.flags.get('all') === true,
        liveMetricsPath: getString(args.flags, 'live-metrics'),
        minOverrideSeries: getNumber(args.flags, 'min-override-series'),
      });
      return;
    }
    case 'download-notebooks': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDownloadNotebooks({
        baseUrl,
        token,
        outDir: tenantOut(args.flags, baseUrl),
        limit: getNumber(args.flags, 'limit'),
        usedWithinDays: getNumber(args.flags, 'used-within-days'),
      });
      return;
    }
    case 'download-anomaly-detectors': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDownloadAnomalyDetectors({
        baseUrl,
        token,
        outDir: tenantOut(args.flags, baseUrl),
        schemaId: getString(args.flags, 'schema'),
      });
      return;
    }
    case 'scan-notebooks': {
      const outDir = offlineTenantOut(args.flags);
      if (!outDir && !getString(args.flags, 'input-dir')) {
        throw new Error(
          'scan-notebooks: pass --env <id>, --base-url <url>, set DT_BASE_URL, or pass --input-dir.'
        );
      }
      await runScanNotebooks({
        inputDir: getString(args.flags, 'input-dir'),
        outDir,
        mappingPath: getString(args.flags, 'mapping'),
        limit: getNumber(args.flags, 'limit'),
        all: args.flags.get('all') === true,
        liveMetricsPath: getString(args.flags, 'live-metrics'),
        minOverrideSeries: getNumber(args.flags, 'min-override-series'),
      });
      return;
    }
    case 'scan-anomaly-detectors': {
      const outDir = offlineTenantOut(args.flags);
      if (!outDir && !getString(args.flags, 'input-file')) {
        throw new Error(
          'scan-anomaly-detectors: pass --env <id>, --base-url <url>, set DT_BASE_URL, or pass --input-file.'
        );
      }
      await runScanAnomalyDetectors({
        inputFile: getString(args.flags, 'input-file'),
        outDir,
        mappingPath: getString(args.flags, 'mapping'),
        limit: getNumber(args.flags, 'limit'),
        all: args.flags.get('all') === true,
        liveMetricsPath: getString(args.flags, 'live-metrics'),
        minOverrideSeries: getNumber(args.flags, 'min-override-series'),
      });
      return;
    }
    case 'migrate-refresh': {
      // Offline: builds the .xlsx tracker from scan/compare/manifest artifacts.
      const outDir = offlineTenantOut(args.flags);
      if (!outDir) {
        throw new Error(
          'migrate-refresh: pass --env <id>, --base-url <url>, set DT_BASE_URL, or --out-dir <dir>.'
        );
      }
      await runMigrateRefresh({
        outDir,
        trackerPath: getString(args.flags, 'tracker'),
      });
      return;
    }
    case 'migrate-stage': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      const idsFlag = getString(args.flags, 'ids');
      await runMigrateStage({
        outDir: tenantOut(args.flags, baseUrl),
        baseUrl,
        token,
        trackerPath: getString(args.flags, 'tracker'),
        ids: idsFlag ? idsFlag.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        limit: getNumber(args.flags, 'limit'),
        apply: args.flags.get('apply') === true,
        restage: args.flags.get('restage') === true,
        shareGroupId: getString(args.flags, 'share-group') ?? process.env.DT_SHARE_GROUP_ID,
        mappingPath: getString(args.flags, 'mapping'),
        liveMetricsPath: getString(args.flags, 'live-metrics'),
        minOverrideSeries: getNumber(args.flags, 'min-override-series'),
      });
      return;
    }
    case 'discover-management-zones': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDiscoverManagementZones({
        outDir: tenantOut(args.flags, baseUrl),
        baseUrl,
        token,
        nameContains: getString(args.flags, 'name-contains'),
        pageSize: getNumber(args.flags, 'page-size'),
      });
      return;
    }
    case 'stage-detectors': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      const idsFlag = getString(args.flags, 'ids');
      const bucketsFlag = getString(args.flags, 'buckets');
      await runStageDetectors({
        outDir: tenantOut(args.flags, baseUrl),
        baseUrl,
        token,
        inputFile: getString(args.flags, 'input-file'),
        apply: args.flags.get('apply') === true,
        noShare: args.flags.get('no-share') === true,
        shareGroupId: getString(args.flags, 'share-group') ?? process.env.DT_SHARE_GROUP_ID,
        batchSize: getNumber(args.flags, 'batch-size'),
        buckets: bucketsFlag
          ? (bucketsFlag.split(',').map((s) => s.trim()).filter(Boolean) as ReviewBucket[])
          : undefined,
        ids: idsFlag ? idsFlag.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        limit: getNumber(args.flags, 'limit'),
        mappingPath: getString(args.flags, 'mapping'),
        liveMetricsPath: getString(args.flags, 'live-metrics'),
        minOverrideSeries: getNumber(args.flags, 'min-override-series'),
      });
      return;
    }
    case 'migrate-pull': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      const ids = getString(args.flags, 'ids');
      await runMigratePull({
        outDir: tenantOut(args.flags, baseUrl),
        baseUrl,
        token,
        trackerPath: getString(args.flags, 'tracker'),
        ids: ids ? ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        limit: getNumber(args.flags, 'limit'),
      });
      return;
    }
    case 'migrate-promote': {
      // Cutover writes via the Document API with admin-access — needs an admin
      // token (document:documents:read+write+admin), not dtctl.
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      const ids = getString(args.flags, 'ids');
      await runMigratePromote({
        outDir: tenantOut(args.flags, baseUrl),
        baseUrl,
        token,
        trackerPath: getString(args.flags, 'tracker'),
        ids: ids ? ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        limit: getNumber(args.flags, 'limit'),
        apply: args.flags.get('apply') === true,
        force: args.flags.get('force') === true,
        mappingPath: getString(args.flags, 'mapping'),
        liveMetricsPath: getString(args.flags, 'live-metrics'),
        minOverrideSeries: getNumber(args.flags, 'min-override-series'),
      });
      return;
    }
    case 'migrate-verify': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      const ids = getString(args.flags, 'ids');
      await runMigrateVerify({
        outDir: tenantOut(args.flags, baseUrl),
        baseUrl,
        token,
        trackerPath: getString(args.flags, 'tracker'),
        ids: ids ? ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        limit: getNumber(args.flags, 'limit'),
      });
      return;
    }
    case 'migrate-rollback': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      const ids = getString(args.flags, 'ids');
      await runMigrateRollback({
        outDir: tenantOut(args.flags, baseUrl),
        baseUrl,
        token,
        trackerPath: getString(args.flags, 'tracker'),
        ids: ids ? ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        all: args.flags.get('all') === true,
        apply: args.flags.get('apply') === true,
      });
      return;
    }
    case 'reconcile-metrics': {
      // Offline: joins this tenant's tenant_keys.aws.json (discover) to
      // live-metrics.json (discover-metrics). Resolve the env like other
      // offline commands.
      const outDir = offlineTenantOut(args.flags);
      if (!outDir) {
        throw new Error(
          'reconcile-metrics: cannot tell which tenant to reconcile. Pass --env <id>, ' +
            '--base-url <url>, set DT_BASE_URL, or pass --out-dir <dir>.'
        );
      }
      await runReconcileMetrics({
        outDir,
        mappingPath: getString(args.flags, 'mapping'),
        minSeries: getNumber(args.flags, 'min-series'),
        minOverrideSeries: getNumber(args.flags, 'min-override-series'),
        byAccount: args.flags.get('by-account') === true,
      });
      return;
    }
    case 'rewrite-dashboard': {
      const input = getString(args.flags, 'in') ?? getString(args.flags, 'input');
      if (!input) throw new Error('rewrite-dashboard: pass --in <dashboard.json>.');
      // Writes next to the input dashboard by default; --out-dir overrides.
      await runRewriteDashboard({
        input,
        mappingPath: getString(args.flags, 'mapping'),
        outDir: outDirOverride,
        liveMetricsPath: getString(args.flags, 'live-metrics'),
        minOverrideSeries: getNumber(args.flags, 'min-override-series'),
      });
      return;
    }
    case 'discover-fields': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDiscoverFields({
        baseUrl,
        token,
        outDir: tenantOut(args.flags, baseUrl),
        filter: getString(args.flags, 'filter'),
      });
      return;
    }
    case 'discover-tags': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDiscoverTags({
        baseUrl,
        token,
        outDir: tenantOut(args.flags, baseUrl),
        from: getString(args.flags, 'from'),
        daSource: getString(args.flags, 'da-source'),
        sampleSize: getNumber(args.flags, 'sample-size'),
      });
      return;
    }
    case 'discover-metrics': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDiscoverMetrics({
        baseUrl,
        token,
        outDir: tenantOut(args.flags, baseUrl),
        from: getString(args.flags, 'from'),
        daSource: getString(args.flags, 'da-source'),
      });
      return;
    }
    case 'discover-entity-types': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDiscoverEntityTypes({
        baseUrl,
        token,
        outDir: tenantOut(args.flags, baseUrl),
        from: getString(args.flags, 'from'),
        daSource: getString(args.flags, 'da-source'),
      });
      return;
    }
    case 'compare-dashboard': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      const input = getString(args.flags, 'in') ?? getString(args.flags, 'input');
      if (!input) throw new Error('compare-dashboard: pass --in <dashboard.json>.');
      // --vars Name=v1,v2;Other=x — multi-value with semicolons between vars.
      // --account-id <id1,id2,...> — shorthand for the common AWS account vars
      //   (AccountID, AccountId, awsAccountId, account, Account). Substitutes
      //   them all to the same list, so a dashboard's `in(awsAccountId,
      //   $AccountID)` filter resolves cleanly against either side.
      const injectedVars = new Map<string, string[]>();
      const varsFlag = getString(args.flags, 'vars');
      if (varsFlag) {
        for (const pair of varsFlag.split(';')) {
          const eq = pair.indexOf('=');
          if (eq <= 0) continue;
          const name = pair.slice(0, eq).trim();
          const vals = pair.slice(eq + 1).split(',').map((s) => s.trim()).filter(Boolean);
          if (name && vals.length > 0) injectedVars.set(name, vals);
        }
      }
      const accountIdFlag = getString(args.flags, 'account-id');
      if (accountIdFlag) {
        const accountIds = accountIdFlag.split(',').map((s) => s.trim()).filter(Boolean);
        // Only inject onto variables that clearly hold AWS account *IDs*.
        // `$Account` / `$account` typically hold the human-readable account
        // *name* and would be incorrectly filtered out by numeric IDs.
        for (const name of ['AccountID', 'AccountId', 'accountId', 'AccountID_', 'awsAccountId']) {
          injectedVars.set(name, accountIds);
        }
      }
      await runCompareDashboard({
        baseUrl,
        token,
        input,
        mappingPath: getString(args.flags, 'mapping'),
        outDir: tenantOut(args.flags, baseUrl),
        from: getString(args.flags, 'from'),
        to: getString(args.flags, 'to'),
        limit: getNumber(args.flags, 'limit'),
        includeVariables: args.flags.get('no-variables') !== true,
        injectedVars: injectedVars.size > 0 ? injectedVars : undefined,
        liveMetricsPath: getString(args.flags, 'live-metrics'),
        minOverrideSeries: getNumber(args.flags, 'min-override-series'),
      });
      return;
    }
    case 'merge-recipes': {
      await runMergeRecipes({
        recipesPath: getString(args.flags, 'recipes'),
        mappingPath: getString(args.flags, 'mapping'),
        outPath: getString(args.flags, 'out'),
        punchlistPath: getString(args.flags, 'punchlist'),
        manualRecipesPath: getString(args.flags, 'manual-recipes'),
        inPlace: args.flags.get('in-place') === true,
      });
      return;
    }
    case 'dql': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDql({
        baseUrl,
        token,
        query: getString(args.flags, 'query'),
        file: getString(args.flags, 'file'),
        from: getString(args.flags, 'from'),
        to: getString(args.flags, 'to'),
        preview: getNumber(args.flags, 'preview'),
        outDir: tenantOut(args.flags, baseUrl),
      });
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error(HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
