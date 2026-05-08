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
import { runRewriteDql } from './commands/rewrite-dql.ts';
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

const HELP = `cct — cloud-conversion tooling

USAGE
  cct <command> [flags]

COMMANDS
  build-mapping     Transform reference DAC metric JSON into unified mappings.
  discover          Enumerate cloud metric keys on a tenant via DQL.
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
  --out-dir <path>  Where to write JSON outputs (default: tools/out)

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

  const outDir = getString(args.flags, 'out-dir');

  switch (cmd) {
    case 'build-mapping': {
      const provider = (getString(args.flags, 'provider') as CloudProvider | 'all' | undefined) ?? 'all';
      await runBuildMapping({ provider, outDir });
      return;
    }
    case 'discover': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
      await runDiscover({
        baseUrl,
        token,
        from: getString(args.flags, 'from'),
        to: getString(args.flags, 'to'),
        outDir,
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
        outDir,
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
        outDir,
      });
      return;
    }
    case 'detect-per-resource': {
      const { baseUrl, token } = requireBaseAndToken(args.flags);
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
        outDir,
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
        outDir,
      });
      return;
    }
    case 'rewrite-dql': {
      await runRewriteDql({
        query: getString(args.flags, 'query'),
        file: getString(args.flags, 'file'),
        mappingPath: getString(args.flags, 'mapping'),
        outDir,
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
        outDir,
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
