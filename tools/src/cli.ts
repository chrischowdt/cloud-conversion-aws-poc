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
import { runDiscoverFields } from './commands/discover-fields.ts';
import { runDiscoverMetrics } from './commands/discover-metrics.ts';
import { runDiscoverTags } from './commands/discover-tags.ts';
import { runRewriteDashboard } from './commands/rewrite-dashboard.ts';
import { runRewriteDql } from './commands/rewrite-dql.ts';
import { runScanDashboards } from './commands/scan-dashboards.ts';
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
                    dashboards via Config API v1.
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
