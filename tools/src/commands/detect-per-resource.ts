/**
 * detect-per-resource — recipe search at per-resource scope.
 *
 * Aggregate-level detect ("for this account/region, fit classic vs new")
 * picks up tenant-specific scale factors that are coverage-ratio artifacts,
 * not real metric semantics. Per-resource detect ("for this specific EC2
 * instance / DynamoDB table / ..., fit classic vs new") yields the universal
 * recipe — typically scale ≈ 1.0 because the comparison is between two
 * different ingestion paths watching the *same* AWS resource.
 *
 * Bridge: every classic AWS entity has an `arn` field. New metric series
 * carry `aws.arn`. We use ARN as the universal join key. Classic side is
 * filtered by entity ID (which we resolve from ARN), new side by `aws.arn`.
 *
 * Algorithm per metric pair:
 *   1. Determine the classic entity type from the metric key prefix.
 *   2. Discover top-K candidate resources by activity on the classic side.
 *   3. Resolve each entity's ARN via `fetch dt.entity.<type>`.
 *   4. For each resource: one combined `timeseries` with both sides scoped
 *      to that resource. Run the same 8-combo recipe search detect uses.
 *   5. Aggregate per-pair across resources: pick the (classic_agg, new_agg)
 *      with the most exact/good fits, then take median scale across those.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient, type DqlResult } from '../dynatrace/dql.ts';
import { combineSeries, parseTimeseriesRecord, type ParsedSeries } from '../lib/dql-parser.ts';
import { mdCode, mdNum, mdTable } from '../lib/markdown.ts';
import { OUT_DIR, REPO_ROOT } from '../lib/paths.ts';
import { builtinToDqlClassic } from '../lib/schema-transforms.ts';
import { fitScaleAndResidual, type TimeSeriesPoint } from '../lib/stats.ts';

export type Aggregation = 'avg' | 'sum' | 'max' | 'min';
export type NewAggMode = 'raw' | 'per_second';

const CLASSIC_AGGS: Aggregation[] = ['avg', 'sum'];
const NEW_AGGS: Aggregation[] = ['avg', 'sum', 'max', 'min'];
const NEW_MODES: NewAggMode[] = ['raw', 'per_second'];

function intervalSeconds(interval: string): number {
  const m = /^(\d+)([smhd])$/.exec(interval.trim());
  if (!m) return 300;
  const n = Number(m[1]);
  switch (m[2]) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default: return 300;
  }
}

function dividePoints(points: TimeSeriesPoint[], divisor: number): TimeSeriesPoint[] {
  return points.map((p) => ({ ts: p.ts, value: p.value === null ? null : p.value / divisor }));
}

/**
 * Probe the metric to discover its `dt.source_entity.type`. Cached per metric
 * key. The probe query is cheap (one record) and authoritative — no need to
 * hardcode a prefix→type table that drifts from reality.
 */
async function discoverEntityType(
  client: DqlClient,
  classicDqlKey: string,
  from: string,
  to: string,
  cache: Map<string, string | null>
): Promise<string | null> {
  if (cache.has(classicDqlKey)) return cache.get(classicDqlKey)!;
  const query = `
    fetch metric.series, from: ${from}, to: ${to}
    | filter metric.key == ${dqlString(classicDqlKey)}
    | filter isNotNull(dt.source_entity.type)
    | summarize n = count(), by: { entity_type = dt.source_entity.type }
    | sort n desc
    | limit 1
  `.trim();
  try {
    const result = await client.query({ query, maxResultRecords: 5, fetchTimeoutSeconds: 30 });
    const r = result.records[0];
    const t = r && typeof r['entity_type'] === 'string' ? (r['entity_type'] as string) : null;
    cache.set(classicDqlKey, t);
    return t;
  } catch {
    cache.set(classicDqlKey, null);
    return null;
  }
}

export interface DetectPerResourceArgs {
  baseUrl: string;
  token: string;
  mappingPath?: string;
  limit?: number;
  service?: string;
  from?: string;
  to?: string;
  interval?: string;
  outDir?: string;
  /** How many resources per metric pair to sample. Default 5. */
  resourceSample?: number;
  /** r threshold for "fit". Default 0.85. */
  minR?: number;
  /**
   * Scope sampling to a set of AWS account IDs (e.g. the parallel-state
   * accounts discovered by `tools/out/parallel-accounts.json`). For each
   * account, top-K resources are sampled by data volume, then unioned across
   * accounts. Multiplies the candidate pool by N accounts, dramatically
   * improving the per-resource bridge's hit rate vs single-tenant sampling.
   *
   * When omitted, sampling is global (current behavior). When set to
   * `["auto"]`, the command loads `tools/out/parallel-accounts.json`.
   */
  accountIds?: string[];
}

interface PythonMapping {
  serviceMappings: Array<{
    service: string;
    slug?: string;
    builtinMetricMappings?: Array<{
      classicMetricId: string;
      classicDisplayName?: string;
      cloudwatchName?: string | null;
      newDtMetricKey?: string | null;
      newDimensions?: string[];
      category?: string;
      notes?: string;
    }>;
  }>;
}

interface Pair {
  service: string;
  classicBuiltin: string;
  classicDqlKey: string;
  newDqlKey: string;
  cloudwatchName: string | null;
  /** Resolved at run time from `dt.source_entity.type` on the metric. */
  classicEntityType?: string;
}

interface ComboFit {
  classicAgg: Aggregation;
  newAgg: Aggregation;
  newMode: NewAggMode;
  pearsonR: number | null;
  scale: number | null;
  residualSmape: number | null;
  alignedPoints: number;
}

interface ResourceResult {
  classicEntityId: string;
  arn: string;
  entityName?: string;
  combos: ComboFit[];
  bestCombo: ComboFit | null;
  /** Classified verdict from the best combo. */
  verdict: PerPairVerdict;
}

type PerPairVerdict =
  | 'exact-fit'
  | 'good-fit'
  | 'scale-only'
  | 'shape-only'
  | 'no-fit'
  | 'no-data';

const VERDICT_RANK: Record<PerPairVerdict, number> = {
  'exact-fit': 5,
  'good-fit': 4,
  'scale-only': 3,
  'shape-only': 2,
  'no-fit': 1,
  'no-data': 0,
};

interface AggregatedPair extends Pair {
  resourcesTested: number;
  perResource: ResourceResult[];
  /** Verdict counts across resources. */
  verdictCounts: Record<PerPairVerdict, number>;
  /** Consensus recipe (most-common best combo, median scale across qualifying resources). */
  consensus: {
    classicAgg: Aggregation;
    newAgg: Aggregation;
    newMode: NewAggMode;
    medianScale: number | null;
    medianPearsonR: number | null;
    medianResidualSmape: number | null;
    qualifyingResources: number;
  } | null;
  /** Highest-tier verdict observed across resources. */
  bestVerdict: PerPairVerdict;
}

function dqlIdent(metricKey: string): string {
  if (metricKey.includes('`')) {
    throw new Error(`Refusing metric key containing backtick: ${metricKey}`);
  }
  return '`' + metricKey + '`';
}

function dqlString(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function loadPairs(mapping: PythonMapping, service?: string): Pair[] {
  const pairs: Pair[] = [];
  for (const svc of mapping.serviceMappings ?? []) {
    if (service && (svc.slug ?? svc.service.toLowerCase()) !== service.toLowerCase()) continue;
    for (const bm of svc.builtinMetricMappings ?? []) {
      const classicDqlKey = builtinToDqlClassic(bm.classicMetricId);
      if (!classicDqlKey) continue;
      if (!bm.newDtMetricKey) continue;
      pairs.push({
        service: svc.service,
        classicBuiltin: bm.classicMetricId,
        classicDqlKey,
        newDqlKey: bm.newDtMetricKey,
        cloudwatchName: bm.cloudwatchName ?? null,
      });
    }
  }
  return pairs;
}

/**
 * For each AWS account ID, look up the set of classic credential entity
 * NAMES (e.g. "DEV-AirportOps", "STG-Baggage-Cargo") owned by that account.
 * Used to scope per-account metric sampling, since classic metric.series
 * carries `aws.credentials` (a list of credential names) but not raw account
 * IDs.
 *
 * Returns `Map<accountId, credentialNames[]>`. Accounts with no credentials
 * (i.e. accounts that don't appear on the classic side) are omitted.
 */
async function loadCredentialsByAccount(
  client: DqlClient,
  accountIds: string[]
): Promise<Map<string, string[]>> {
  if (accountIds.length === 0) return new Map();
  const accountArray = 'array(' + accountIds.map(dqlString).join(', ') + ')';
  const query = `
    fetch dt.entity.aws_credentials, from:now()-12h
    | filter in(awsAccountId, ${accountArray})
    | fields awsAccountId, entity.name
  `.trim();
  const out = new Map<string, string[]>();
  try {
    const result = await client.query({ query, maxResultRecords: 10_000, fetchTimeoutSeconds: 60 });
    for (const r of result.records) {
      const acct = r['awsAccountId'];
      const name = r['entity.name'];
      if (typeof acct === 'string' && typeof name === 'string') {
        if (!out.has(acct)) out.set(acct, []);
        out.get(acct)!.push(name);
      }
    }
  } catch {
    return new Map();
  }
  return out;
}

async function discoverTopResources(
  client: DqlClient,
  pair: Pair,
  entityType: string,
  k: number,
  from: string,
  to: string,
  credentialNames?: string[]
): Promise<string[]> {
  const dim = '`dt.entity.' + entityType + '`';
  // When `credentialNames` is set, scope the classic metric.series scan to
  // series owned by those credentials. `aws.credentials` is a multi-valued
  // list (the same metric can be reported by multiple credentials), so we
  // match via contains() over the stringified array. The OR chain unions
  // the credential set.
  let credFilter = '';
  if (credentialNames && credentialNames.length > 0) {
    const clauses = credentialNames.map(
      (n) => `contains(toString(aws.credentials), ${dqlString(n)})`
    );
    credFilter = `\n    | filter ${clauses.join(' OR ')}`;
  }
  const query = `
    fetch metric.series, from: ${from}, to: ${to}
    | filter metric.key == ${dqlString(pair.classicDqlKey)}
    | filter isNotNull(${dim})${credFilter}
    | summarize samples = count(), by: { eid = ${dim} }
    | sort samples desc
    | limit ${k}
  `.trim();
  try {
    const result = await client.query({
      query,
      maxResultRecords: k * 2,
      fetchTimeoutSeconds: 60,
    });
    return result.records
      .map((r) => r['eid'])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * Multi-account top-K sampling: for each account, ask `discoverTopResources`
 * for its own top-K, then union the entity IDs. The union typically has more
 * candidate IDs than K (depending on overlap between accounts), giving the
 * downstream bridge a larger pool to find aligned classic↔new pairs in.
 */
async function discoverTopResourcesPerAccount(
  client: DqlClient,
  pair: Pair,
  entityType: string,
  k: number,
  from: string,
  to: string,
  credsByAccount: Map<string, string[]>
): Promise<string[]> {
  const union = new Set<string>();
  for (const [, credentials] of credsByAccount) {
    if (credentials.length === 0) continue;
    const ids = await discoverTopResources(client, pair, entityType, k, from, to, credentials);
    for (const id of ids) union.add(id);
  }
  return [...union];
}

async function lookupArns(
  client: DqlClient,
  entityType: string,
  ids: string[]
): Promise<Map<string, { arn: string; name?: string }>> {
  if (ids.length === 0) return new Map();
  const idArray = 'array(' + ids.map(dqlString).join(', ') + ')';
  const query = `
    fetch \`dt.entity.${entityType}\`
    | filter in(id, ${idArray})
    | fields id, arn, entity.name
  `.trim();
  const result = await client.query({
    query,
    maxResultRecords: ids.length,
    fetchTimeoutSeconds: 60,
  });
  const out = new Map<string, { arn: string; name?: string }>();
  for (const r of result.records) {
    const id = r['id'];
    const arn = r['arn'];
    if (typeof id === 'string' && typeof arn === 'string' && arn.length > 0) {
      out.set(id, { arn, name: typeof r['entity.name'] === 'string' ? (r['entity.name'] as string) : undefined });
    }
  }
  return out;
}

/**
 * Filter the candidate ARNs to only those that have new-side data. Many
 * tenants run classic and new ingestion against different AWS accounts —
 * a top-classic-resource may have no new-side data at all, in which case
 * per-resource detect would just return no-data even though the recipe is
 * valid for matched resources.
 */
async function filterArnsWithNewData(
  client: DqlClient,
  newDqlKey: string,
  arns: string[],
  from: string,
  to: string
): Promise<Set<string>> {
  if (arns.length === 0) return new Set();
  const arnArray = 'array(' + arns.map(dqlString).join(', ') + ')';
  const query = `
    fetch metric.series, from: ${from}, to: ${to}
    | filter metric.key == ${dqlString(newDqlKey)}
    | filter in(aws.arn, ${arnArray})
    | summarize samples = count(), by: { arn = aws.arn }
    | filter samples > 0
  `.trim();
  try {
    const result = await client.query({ query, maxResultRecords: arns.length, fetchTimeoutSeconds: 60 });
    const out = new Set<string>();
    for (const r of result.records) {
      if (typeof r['arn'] === 'string') out.add(r['arn'] as string);
    }
    return out;
  } catch {
    return new Set();
  }
}

function buildPerResourceQuery(
  pair: Pair,
  entityType: string,
  classicEid: string,
  arn: string,
  from: string,
  to: string,
  interval: string
): string {
  const classicDim = '`dt.entity.' + entityType + '`';
  const classicFilter = `filter:{${classicDim} == ${dqlString(classicEid)}}`;
  const newFilter = `filter:{aws.arn == ${dqlString(arn)}}`;
  const classicClauses = CLASSIC_AGGS.map(
    (a) => `c_${a} = ${a}(${dqlIdent(pair.classicDqlKey)}, ${classicFilter})`
  );
  const newClauses = NEW_AGGS.map(
    (a) => `n_${a} = ${a}(${dqlIdent(pair.newDqlKey)}, ${newFilter})`
  );
  return (
    `timeseries ${[...classicClauses, ...newClauses].join(', ')}, ` +
    `interval: ${interval}, from: ${from}, to: ${to}`
  );
}

function extractSeries(result: DqlResult, fieldName: string): TimeSeriesPoint[] {
  const matches: ParsedSeries[] = result.records.flatMap((r) =>
    parseTimeseriesRecord(r, fieldName)
  );
  return combineSeries(matches);
}

function classify(combo: ComboFit | null, anyData: boolean): PerPairVerdict {
  if (!anyData) return 'no-data';
  if (!combo) return 'no-fit';
  const r = combo.pearsonR ?? 0;
  const res = combo.residualSmape ?? 1;
  if (r > 0.95 && res < 0.05) return 'exact-fit';
  if (r > 0.85 && res < 0.20) return 'good-fit';
  if (r > 0.85) return 'shape-only';
  if (res < 0.10) return 'scale-only';
  return 'no-fit';
}

function pickBestCombo(combos: ComboFit[]): ComboFit | null {
  const valid = combos.filter(
    (c) => c.residualSmape !== null && c.alignedPoints >= 3
  );
  if (valid.length === 0) return null;
  // Score: low residual + high r is good. Among similar scores, prefer
  // scale closer to 1 (universal recipe is more useful than tenant-specific).
  valid.sort((a, b) => {
    const sa = (a.residualSmape ?? 1) - 0.5 * (a.pearsonR ?? 0);
    const sb = (b.residualSmape ?? 1) - 0.5 * (b.pearsonR ?? 0);
    if (Math.abs(sa - sb) > 0.02) return sa - sb;
    // Within 0.02 of each other on score, prefer scale near 1.
    const da = Math.abs(Math.log10(Math.abs(a.scale ?? 1) || 1e-12));
    const db = Math.abs(Math.log10(Math.abs(b.scale ?? 1) || 1e-12));
    return da - db;
  });
  return valid[0]!;
}

async function detectForOneResource(
  client: DqlClient,
  pair: Pair,
  entityType: string,
  classicEid: string,
  arn: string,
  entityName: string | undefined,
  from: string,
  to: string,
  interval: string
): Promise<ResourceResult> {
  const query = buildPerResourceQuery(pair, entityType, classicEid, arn, from, to, interval);
  let dqlResult: DqlResult;
  try {
    dqlResult = await client.query({ query, maxResultRecords: 100, fetchTimeoutSeconds: 60 });
  } catch {
    return {
      classicEntityId: classicEid,
      arn,
      entityName,
      combos: [],
      bestCombo: null,
      verdict: 'no-data',
    };
  }
  const classicSeries: Record<Aggregation, TimeSeriesPoint[]> = {
    avg: extractSeries(dqlResult, 'c_avg'),
    sum: extractSeries(dqlResult, 'c_sum'),
    max: [],
    min: [],
  };
  const newSeries: Record<Aggregation, TimeSeriesPoint[]> = {
    avg: extractSeries(dqlResult, 'n_avg'),
    sum: extractSeries(dqlResult, 'n_sum'),
    max: extractSeries(dqlResult, 'n_max'),
    min: extractSeries(dqlResult, 'n_min'),
  };
  const intSec = intervalSeconds(interval);
  const combos: ComboFit[] = [];
  for (const cAgg of CLASSIC_AGGS) {
    for (const nAgg of NEW_AGGS) {
      for (const nMode of NEW_MODES) {
        // per_second only meaningful for sum/max
        if (nMode === 'per_second' && (nAgg === 'avg' || nAgg === 'min')) continue;
        const newSide = nMode === 'per_second'
          ? dividePoints(newSeries[nAgg], intSec)
          : newSeries[nAgg];
        const fit = fitScaleAndResidual(classicSeries[cAgg], newSide);
        combos.push({
          classicAgg: cAgg,
          newAgg: nAgg,
          newMode: nMode,
          pearsonR: fit.pearsonR,
          scale: fit.scale,
          residualSmape: fit.residualSmape,
          alignedPoints: fit.alignedPoints,
        });
      }
    }
  }
  const anyData = combos.some((c) => c.alignedPoints >= 3);
  const bestCombo = pickBestCombo(combos);
  return {
    classicEntityId: classicEid,
    arn,
    entityName,
    combos,
    bestCombo,
    verdict: classify(bestCombo, anyData),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function aggregateAcrossResources(perResource: ResourceResult[]): AggregatedPair['consensus'] {
  // Pick the (cAgg, nAgg) combo with the most resources where the verdict is
  // exact-fit / good-fit / scale-only. Then median the scale across those resources.
  const qualifying = perResource.filter(
    (r) => r.bestCombo !== null && (r.verdict === 'exact-fit' || r.verdict === 'good-fit' || r.verdict === 'scale-only')
  );
  if (qualifying.length === 0) return null;

  const counts = new Map<string, { count: number; cAgg: Aggregation; nAgg: Aggregation; nMode: NewAggMode }>();
  for (const r of qualifying) {
    const key = `${r.bestCombo!.classicAgg}|${r.bestCombo!.newAgg}|${r.bestCombo!.newMode}`;
    const ex = counts.get(key);
    if (ex) ex.count++;
    else counts.set(key, {
      count: 1,
      cAgg: r.bestCombo!.classicAgg,
      nAgg: r.bestCombo!.newAgg,
      nMode: r.bestCombo!.newMode,
    });
  }
  const winner = [...counts.values()].sort((a, b) => b.count - a.count)[0]!;
  const matching = qualifying.filter(
    (r) =>
      r.bestCombo!.classicAgg === winner.cAgg &&
      r.bestCombo!.newAgg === winner.nAgg &&
      r.bestCombo!.newMode === winner.nMode
  );
  return {
    classicAgg: winner.cAgg,
    newAgg: winner.nAgg,
    newMode: winner.nMode,
    medianScale: median(matching.map((r) => r.bestCombo!.scale).filter((v): v is number => v !== null)),
    medianPearsonR: median(matching.map((r) => r.bestCombo!.pearsonR).filter((v): v is number => v !== null)),
    medianResidualSmape: median(
      matching.map((r) => r.bestCombo!.residualSmape).filter((v): v is number => v !== null)
    ),
    qualifyingResources: matching.length,
  };
}

export async function runDetectPerResource(args: DetectPerResourceArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });

  const mappingPath = args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.json');
  const mapping = JSON.parse(await readFile(mappingPath, 'utf8')) as PythonMapping;

  const limit = args.limit ?? 100;
  const from = args.from ?? '-25h';
  const to = args.to ?? '-1h';
  const interval = args.interval ?? '5m';
  const k = args.resourceSample ?? 5;

  const allPairs = loadPairs(mapping, args.service);
  const queue = allPairs.slice(0, limit);
  console.log(
    `Per-resource detect on ${queue.length} pairs (of ${allPairs.length}) ` +
      `from=${from} to=${to} interval=${interval} K=${k}`
  );
  if (queue.length === 0) return;

  const client = new DqlClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} (${info.delayMs.toFixed(0)}ms)`),
  });

  // Resolve account → credential names once. Used to scope per-pair
  // sampling to a parallel-account set when `accountIds` is provided.
  let credsByAccount: Map<string, string[]> | null = null;
  if (args.accountIds && args.accountIds.length > 0) {
    credsByAccount = await loadCredentialsByAccount(client, args.accountIds);
    const accountsWithCreds = [...credsByAccount.entries()].filter(([, c]) => c.length > 0);
    const totalCreds = accountsWithCreds.reduce((sum, [, c]) => sum + c.length, 0);
    console.log(
      `Account-scoped sampling: ${accountsWithCreds.length}/${args.accountIds.length} accounts ` +
        `have classic credentials (${totalCreds} credentials total). K=${k} per account.`
    );
    if (accountsWithCreds.length === 0) {
      console.log('  ⚠ no credentials found for any requested account — falling back to global sampling.');
      credsByAccount = null;
    }
  }

  const entityTypeCache = new Map<string, string | null>();
  const results: AggregatedPair[] = [];
  let i = 0;
  for (const pair of queue) {
    i++;
    process.stdout.write(`[${i}/${queue.length}] ${pair.classicDqlKey} ... `);

    const entityType = await discoverEntityType(client, pair.classicDqlKey, from, to, entityTypeCache);
    if (!entityType) {
      console.log('no entity type (metric has no dt.source_entity.type or no data)');
      results.push({
        ...pair,
        resourcesTested: 0,
        perResource: [],
        verdictCounts: { 'exact-fit': 0, 'good-fit': 0, 'scale-only': 0, 'shape-only': 0, 'no-fit': 0, 'no-data': 0 },
        consensus: null,
        bestVerdict: 'no-data',
      });
      continue;
    }
    pair.classicEntityType = entityType;
    process.stdout.write(`(${entityType}) `);

    const eids = credsByAccount
      ? await discoverTopResourcesPerAccount(client, pair, entityType, k, from, to, credsByAccount)
      : await discoverTopResources(client, pair, entityType, k, from, to);
    if (eids.length === 0) {
      console.log('no candidate resources');
      results.push({
        ...pair,
        resourcesTested: 0,
        perResource: [],
        verdictCounts: { 'exact-fit': 0, 'good-fit': 0, 'scale-only': 0, 'shape-only': 0, 'no-fit': 0, 'no-data': 0 },
        consensus: null,
        bestVerdict: 'no-data',
      });
      continue;
    }

    let arnMap: Map<string, { arn: string; name?: string }>;
    try {
      arnMap = await lookupArns(client, entityType, eids);
    } catch (e) {
      console.log(`arn lookup failed: ${(e as Error).message}`);
      arnMap = new Map();
    }

    // Filter to ARNs that ALSO have new-side data. Avoids spending K queries
    // on resources where one ingestion path doesn't cover the resource.
    const candidateArns = [...arnMap.values()].map((v) => v.arn);
    const arnsWithNew = await filterArnsWithNewData(
      client,
      pair.newDqlKey,
      candidateArns,
      from,
      to
    );

    // Build the worklist: which eids need a per-resource fit, which are
    // pre-classified as no-data. The no-data buckets can be filled in
    // synchronously; the actual fits run with bounded concurrency so a
    // wide candidate pool (e.g. 30+ resources × 19 accounts) doesn't take
    // forever.
    type Job =
      | { kind: 'noinfo'; eid: string }
      | { kind: 'noarn'; eid: string; arn: string; name?: string }
      | { kind: 'fit'; eid: string; arn: string; name?: string };
    const jobs: Job[] = [];
    for (const eid of eids) {
      const info = arnMap.get(eid);
      if (!info) {
        jobs.push({ kind: 'noinfo', eid });
        continue;
      }
      if (!arnsWithNew.has(info.arn)) {
        jobs.push({ kind: 'noarn', eid, arn: info.arn, name: info.name });
        continue;
      }
      jobs.push({ kind: 'fit', eid, arn: info.arn, name: info.name });
    }
    const perResource: ResourceResult[] = new Array(jobs.length);
    const FIT_CONCURRENCY = 4; // bounded — tenant API has rate limits
    // entityType was null-checked above; capture as non-null for the closure
    // (TS can't narrow `string | null` across worker functions).
    const entityTypeNN: string = entityType;
    let next = 0;
    async function worker(): Promise<void> {
      while (true) {
        const idx = next++;
        if (idx >= jobs.length) return;
        const job = jobs[idx]!;
        if (job.kind === 'noinfo') {
          perResource[idx] = {
            classicEntityId: job.eid,
            arn: '',
            combos: [],
            bestCombo: null,
            verdict: 'no-data',
          };
        } else if (job.kind === 'noarn') {
          perResource[idx] = {
            classicEntityId: job.eid,
            arn: job.arn,
            entityName: job.name,
            combos: [],
            bestCombo: null,
            verdict: 'no-data',
          };
        } else {
          perResource[idx] = await detectForOneResource(
            client,
            pair,
            entityTypeNN,
            job.eid,
            job.arn,
            job.name,
            from,
            to,
            interval
          );
        }
      }
    }
    await Promise.all(Array.from({ length: FIT_CONCURRENCY }, () => worker()));

    const verdictCounts: Record<PerPairVerdict, number> = {
      'exact-fit': 0,
      'good-fit': 0,
      'scale-only': 0,
      'shape-only': 0,
      'no-fit': 0,
      'no-data': 0,
    };
    for (const r of perResource) verdictCounts[r.verdict]++;
    const consensus = aggregateAcrossResources(perResource);
    const bestVerdict = perResource.reduce<PerPairVerdict>((best, r) => {
      return VERDICT_RANK[r.verdict] > VERDICT_RANK[best] ? r.verdict : best;
    }, 'no-data');

    results.push({
      ...pair,
      resourcesTested: perResource.length,
      perResource,
      verdictCounts,
      consensus,
      bestVerdict,
    });

    const summary = `${bestVerdict}` +
      (consensus
        ? ` consensus c:${consensus.classicAgg}/n:${consensus.newAgg}` +
          (consensus.newMode === 'per_second' ? '/sec' : '') +
          ` scale=${mdNum(consensus.medianScale, 4)} r=${mdNum(consensus.medianPearsonR)} ` +
          `qualifying=${consensus.qualifyingResources}/${perResource.length}`
        : '');
    console.log(summary);
  }

  // Write reports.
  const overallVerdicts: Record<PerPairVerdict, number> = {
    'exact-fit': 0,
    'good-fit': 0,
    'scale-only': 0,
    'shape-only': 0,
    'no-fit': 0,
    'no-data': 0,
  };
  for (const r of results) overallVerdicts[r.bestVerdict]++;

  const report = {
    generated: new Date().toISOString(),
    baseUrl: args.baseUrl,
    mappingPath,
    window: { from, to, interval },
    resourceSample: k,
    minR: args.minR ?? 0.85,
    pairsTested: results.length,
    bestVerdictCounts: overallVerdicts,
    results,
  };
  await writeFile(join(outDir, 'detect_per_resource_report.json'), JSON.stringify(report, null, 2));

  // Recipes file in the same shape merge-recipes consumes.
  const recipes = results
    .filter((r) => r.consensus !== null && (r.bestVerdict === 'exact-fit' || r.bestVerdict === 'good-fit' || r.bestVerdict === 'scale-only'))
    .map((r) => ({
      classicMetricId: r.classicBuiltin,
      newDtMetricKey: r.newDqlKey,
      newAggregation: r.consensus!.newAgg,
      newAggregationMode: r.consensus!.newMode,
      classicAggregation: r.consensus!.classicAgg,
      scale: r.consensus!.medianScale,
      verdict: r.bestVerdict,
      pearsonR: r.consensus!.medianPearsonR,
      residualSmape: r.consensus!.medianResidualSmape,
      perResourceQualifying: r.consensus!.qualifyingResources,
      perResourceTested: r.resourcesTested,
      source: 'detect-per-resource',
    }));
  await writeFile(
    join(outDir, 'detected_recipes.json'),
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        window: { from, to, interval },
        source: 'detect-per-resource',
        recipes,
      },
      null,
      2
    )
  );

  // Markdown.
  const md: string[] = [];
  md.push(`# Per-resource detect report`);
  md.push('');
  md.push(`- Generated: ${report.generated}`);
  md.push(`- Tenant: ${args.baseUrl}`);
  md.push(`- Mapping: ${mappingPath}`);
  md.push(`- Window: ${from} → ${to}, interval=${interval}, K=${k} resources/pair`);
  md.push(`- Pairs tested: ${results.length}`);
  md.push('');
  md.push(`## Best verdict counts`);
  md.push('');
  md.push(
    mdTable(
      ['verdict', 'count'],
      (Object.keys(overallVerdicts) as PerPairVerdict[]).map((v) => [v, overallVerdicts[v]])
    )
  );
  md.push('');
  md.push(`## Consensus recipes (exact-fit / good-fit / scale-only only)`);
  md.push('');
  const winners = results
    .filter((r) => r.consensus !== null && (r.bestVerdict === 'exact-fit' || r.bestVerdict === 'good-fit' || r.bestVerdict === 'scale-only'))
    .sort((a, b) => VERDICT_RANK[b.bestVerdict] - VERDICT_RANK[a.bestVerdict]);
  md.push(
    mdTable(
      ['service', 'classic', 'new', 'recipe', 'mode', 'median scale', 'median r', 'median residual', 'qual./tested', 'verdict'],
      winners.map((r) => [
        r.service,
        mdCode(r.classicDqlKey),
        mdCode(r.newDqlKey),
        `c:${r.consensus!.classicAgg} ↔ n:${r.consensus!.newAgg}`,
        r.consensus!.newMode,
        mdNum(r.consensus!.medianScale, 4),
        mdNum(r.consensus!.medianPearsonR),
        mdNum(r.consensus!.medianResidualSmape),
        `${r.consensus!.qualifyingResources}/${r.resourcesTested}`,
        r.bestVerdict,
      ])
    )
  );
  await writeFile(join(outDir, 'detect_per_resource_report.md'), md.join('\n'));

  console.log('');
  console.log(`Best-verdict counts: ${JSON.stringify(overallVerdicts)}`);
  console.log(`Wrote ${join(outDir, 'detect_per_resource_report.json')}`);
  console.log(`Wrote ${join(outDir, 'detected_recipes.json')} (${recipes.length} recipes)`);
  console.log(`Wrote ${join(outDir, 'detect_per_resource_report.md')}`);
}
