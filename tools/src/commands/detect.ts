/**
 * detect — for each (classic, new) pair in the mapping, search a small space
 * of aggregation recipes on the new side and pick the one that best
 * reproduces the classic series.
 *
 * Recipe space (per pair):
 *   classic_agg ∈ {avg, sum}
 *   new_agg     ∈ {avg, sum, max, min}
 *   plus a least-squares scale factor k, so classic ≈ k * new_agg(new_key)
 *
 * Why those: classic is pre-aggregated by Dynatrace (some sum, some avg, some
 * custom). The classic side's natural read is `:avg` (read the precomputed
 * value as-is) but for counter-style metrics `:sum` recovers a useful total.
 * On the new side, raw CloudWatch gets reduced by one of the four aggregations
 * across all dimensions baked into the key (e.g. `By.InstanceId`).
 *
 * For each combo we compute Pearson r, then a least-squares best-fit scale
 * factor `k` (no intercept), then the residual sMAPE between classic and
 * `k * new_agg`. The "best recipe" for a pair is the combo with the highest
 * r (≥ 0.85 to qualify) and lowest residual sMAPE.
 *
 * All combos for a pair go in one DQL query (multi-clause `timeseries`), so
 * we run 1 query per pair instead of 8.
 *
 * Output:
 *   tools/out/detect_report.json — per-pair recipe with all combos
 *   tools/out/detect_report.md   — markdown summary, sorted by best fit
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

/**
 * Modes for transforming the raw new-side aggregation before comparing:
 *   - 'raw'        : use the aggregation result directly
 *   - 'per_second' : divide by the bucket interval in seconds
 *                    (CloudWatch counters arrive as totals over the period;
 *                     classic Dynatrace often pre-divided by 1s for a rate.)
 */
export type NewAggMode = 'raw' | 'per_second';

const CLASSIC_AGGS: Aggregation[] = ['avg', 'sum'];
const NEW_AGGS: Aggregation[] = ['avg', 'sum', 'max', 'min'];
const NEW_MODES: NewAggMode[] = ['raw', 'per_second'];

export interface DetectArgs {
  baseUrl: string;
  token: string;
  mappingPath?: string;
  limit?: number;
  service?: string;
  from?: string;
  to?: string;
  interval?: string;
  outDir?: string;
  /** r threshold for a recipe to qualify as "fit". Default 0.85. */
  minR?: number;
  /**
   * DQL filter expression injected into every aggregation clause via
   * `agg(metric_key, filter: { <expression> })`. Use this to scope to one
   * AWS account, region, or any other dimension match. Example:
   *   --filter 'aws.account.id == "003946647406" and aws.region == "us-east-1"'
   */
  filter?: string;
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
  category: string;
  notes: string;
}

interface ComboResult {
  classicAgg: Aggregation;
  newAgg: Aggregation;
  newMode: NewAggMode;
  pearsonR: number | null;
  scale: number | null;
  residualSmape: number | null;
  medianRelError: number | null;
  alignedPoints: number;
  classicMean: number | null;
  newMean: number | null;
}

interface PairRecipeResult extends Pair {
  query: string;
  combos: ComboResult[];
  best: ComboResult | null;
  /** Verdict bucket. */
  verdict:
    | 'exact-fit'        // r > 0.95 AND residual sMAPE < 0.05 — recipe nails it
    | 'good-fit'         // r > 0.85 AND residual sMAPE < 0.20 — usable recipe
    | 'shape-only'       // r > 0.85 but residual still ≥ 0.20 — shape ok, scale needs more than scalar
    | 'scale-only'       // residual < 0.10 but r ≤ 0.85 — scale fits, fine-grained shape is noisy
    | 'no-fit'           // neither r nor residual cross thresholds
    | 'no-data';
  /** Conversion factor as 1/scale (so result = scale-divided new value), rounded for human readability. */
  conversionFactor: number | null;
}

function dqlIdent(metricKey: string): string {
  if (metricKey.includes('`')) {
    throw new Error(`Refusing metric key containing backtick: ${metricKey}`);
  }
  return '`' + metricKey + '`';
}

/**
 * Parse a DQL interval token like "5m", "1h", "30s" into seconds.
 * Falls back to 300 (5min) if the format is unrecognized.
 */
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

/** Divide every value in a time series by a constant. */
function dividePoints(points: TimeSeriesPoint[], divisor: number): TimeSeriesPoint[] {
  return points.map((p) => ({
    ts: p.ts,
    value: p.value === null ? null : p.value / divisor,
  }));
}

/**
 * Build a single DQL query that returns 2 + 4 = 6 series for a pair.
 * Field names: c_avg, c_sum, n_avg, n_sum, n_max, n_min.
 *
 * When `filter` is supplied, it's wrapped in `filter: { ... }` and added to
 * every aggregation so both sides are scoped identically.
 */
function buildPairQuery(
  classicKey: string,
  newKey: string,
  from: string,
  to: string,
  interval: string,
  filter?: string
): string {
  const filterClause = filter ? `, filter: { ${filter} }` : '';
  const classicClauses = CLASSIC_AGGS.map(
    (a) => `c_${a} = ${a}(${dqlIdent(classicKey)}${filterClause})`
  );
  const newClauses = NEW_AGGS.map(
    (a) => `n_${a} = ${a}(${dqlIdent(newKey)}${filterClause})`
  );
  return (
    `timeseries ${[...classicClauses, ...newClauses].join(', ')}, ` +
    `interval: ${interval}, from: ${from}, to: ${to}`
  );
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
        category: bm.category ?? '',
        notes: bm.notes ?? '',
      });
    }
  }
  return pairs;
}

/** Pick a single named series out of a multi-clause timeseries result. */
function extractSeries(result: DqlResult, fieldName: string): TimeSeriesPoint[] {
  const matches: ParsedSeries[] = result.records.flatMap((r) =>
    parseTimeseriesRecord(r, fieldName)
  );
  return combineSeries(matches);
}

function meanOf(points: TimeSeriesPoint[]): number | null {
  let sum = 0;
  let n = 0;
  for (const p of points) {
    if (p.value !== null && !Number.isNaN(p.value)) {
      sum += p.value;
      n++;
    }
  }
  return n === 0 ? null : sum / n;
}

/**
 * Pick the best combo by a combined score that prefers low residual sMAPE
 * and high r without gating on either. We then classify based on the
 * chosen combo's stats.
 */
function pickBest(combos: ComboResult[]): ComboResult | null {
  const qualified = combos.filter(
    (c) => c.residualSmape !== null && c.alignedPoints >= 3
  );
  if (qualified.length === 0) return null;
  qualified.sort((a, b) => {
    // Combined score: residualSmape - 0.5 * r. Lower wins.
    // (Equivalent to "minimize residual sMAPE, with each 0.1 of r worth 0.05 of residual.")
    const sa = (a.residualSmape ?? 1) - 0.5 * (a.pearsonR ?? 0);
    const sb = (b.residualSmape ?? 1) - 0.5 * (b.pearsonR ?? 0);
    return sa - sb;
  });
  return qualified[0]!;
}

function classify(best: ComboResult | null, anyData: boolean): PairRecipeResult['verdict'] {
  if (!anyData) return 'no-data';
  if (!best) return 'no-fit';
  const r = best.pearsonR ?? 0;
  const res = best.residualSmape ?? 1;
  if (r > 0.95 && res < 0.05) return 'exact-fit';
  if (r > 0.85 && res < 0.20) return 'good-fit';
  if (r > 0.85) return 'shape-only';
  if (res < 0.10) return 'scale-only';
  return 'no-fit';
}

export async function runDetect(args: DetectArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });

  const mappingPath =
    args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.json');
  const mapping = JSON.parse(await readFile(mappingPath, 'utf8')) as PythonMapping;

  const limit = args.limit ?? 100;
  const from = args.from ?? '-10d';
  const to = args.to ?? '-8d';
  const interval = args.interval ?? '5m';
  const minR = args.minR ?? 0.85;

  const allPairs = loadPairs(mapping, args.service);
  const queue = allPairs.slice(0, limit);
  console.log(
    `Detecting recipes for ${queue.length} pairs (of ${allPairs.length} from ${mappingPath}) ` +
      `from=${from} to=${to} interval=${interval} minR=${minR}`
  );
  if (queue.length === 0) return;

  const client = new DqlClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} — sleeping ${info.delayMs.toFixed(0)}ms`),
  });

  const results: PairRecipeResult[] = [];
  let i = 0;
  for (const pair of queue) {
    i++;
    process.stdout.write(`[${i}/${queue.length}] ${pair.classicDqlKey} ... `);
    const query = buildPairQuery(pair.classicDqlKey, pair.newDqlKey, from, to, interval, args.filter);

    let dqlResult: DqlResult;
    try {
      dqlResult = await client.query({
        query,
        maxResultRecords: 100,
        fetchTimeoutSeconds: 60,
      });
    } catch (e) {
      results.push({
        ...pair,
        query,
        combos: [],
        best: null,
        verdict: 'no-data',
        conversionFactor: null,
      });
      console.log(`error (${(e as Error).message})`);
      continue;
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

    const intervalSec = intervalSeconds(interval);
    const combos: ComboResult[] = [];
    for (const cAgg of CLASSIC_AGGS) {
      for (const nAgg of NEW_AGGS) {
        for (const nMode of NEW_MODES) {
          const classic = classicSeries[cAgg];
          const newSide = nMode === 'per_second'
            ? dividePoints(newSeries[nAgg], intervalSec)
            : newSeries[nAgg];
          // 'per_second' only makes sense for sum (and arguably max). Skip
          // avg/min in per_second mode — they'd just rescale already-averaged
          // values and add noise to the picker.
          if (nMode === 'per_second' && (nAgg === 'avg' || nAgg === 'min')) continue;
          const fit = fitScaleAndResidual(classic, newSide);
          combos.push({
            classicAgg: cAgg,
            newAgg: nAgg,
            newMode: nMode,
            pearsonR: fit.pearsonR,
            scale: fit.scale,
            residualSmape: fit.residualSmape,
            medianRelError: fit.medianRelError,
            alignedPoints: fit.alignedPoints,
            classicMean: meanOf(classic),
            newMean: meanOf(newSide),
          });
        }
      }
    }

    const anyData = combos.some((c) => c.alignedPoints >= 3);
    const best = pickBest(combos);
    const verdict = classify(best, anyData);
    const conversionFactor =
      best?.scale !== null && best?.scale !== undefined && best.scale !== 0
        ? best.scale
        : null;

    results.push({ ...pair, query, combos, best, verdict, conversionFactor });

    if (best) {
      const modeNote = best.newMode === 'per_second' ? '/sec' : '';
      console.log(
        `${verdict} c=${best.classicAgg} n=${best.newAgg}${modeNote} ` +
          `scale=${mdNum(best.scale, 4)} r=${mdNum(best.pearsonR)} resSmape=${mdNum(best.residualSmape)}`
      );
    } else {
      console.log(verdict);
    }
  }

  const verdicts = results.reduce<Record<string, number>>((m, r) => {
    m[r.verdict] = (m[r.verdict] ?? 0) + 1;
    return m;
  }, {});

  const report = {
    generated: new Date().toISOString(),
    baseUrl: args.baseUrl,
    mappingPath,
    window: { from, to, interval },
    filter: args.filter ?? null,
    minR,
    totalTested: results.length,
    verdictCounts: verdicts,
    results,
  };

  const jsonPath = join(outDir, 'detect_report.json');
  await writeFile(jsonPath, JSON.stringify(report, null, 2));

  // Also emit a "recipes" file shaped to merge into mappings/aws_mapping.json.
  const recipes = results
    .filter((r) => r.best && (r.verdict === 'exact-fit' || r.verdict === 'good-fit' || r.verdict === 'scale-only'))
    .map((r) => ({
      classicMetricId: r.classicBuiltin,
      newDtMetricKey: r.newDqlKey,
      newAggregation: r.best!.newAgg,
      newAggregationMode: r.best!.newMode,
      classicAggregation: r.best!.classicAgg,
      scale: r.best!.scale,
      verdict: r.verdict,
      pearsonR: r.best!.pearsonR,
      residualSmape: r.best!.residualSmape,
    }));
  const recipesPath = join(outDir, 'detected_recipes.json');
  await writeFile(
    recipesPath,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        window: { from, to, interval },
        recipes,
      },
      null,
      2
    )
  );

  const mdPath = join(outDir, 'detect_report.md');
  await writeFile(mdPath, renderMarkdown(report));

  console.log('');
  console.log(`Verdict summary: ${JSON.stringify(verdicts)}`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${recipesPath}  (${recipes.length} actionable recipes)`);
  console.log(`Wrote ${mdPath}`);
}

interface DetectReport {
  generated: string;
  baseUrl: string;
  mappingPath: string;
  window: { from: string; to: string; interval: string };
  minR: number;
  totalTested: number;
  verdictCounts: Record<string, number>;
  results: PairRecipeResult[];
}

const VERDICT_ORDER: Array<PairRecipeResult['verdict']> = [
  'exact-fit',
  'good-fit',
  'scale-only',
  'shape-only',
  'no-fit',
  'no-data',
];

function renderMarkdown(report: DetectReport): string {
  const lines: string[] = [];
  lines.push(`# Recipe detection`);
  lines.push('');
  lines.push(`- Generated: ${report.generated}`);
  lines.push(`- Tenant: ${report.baseUrl}`);
  lines.push(`- Mapping: ${report.mappingPath}`);
  lines.push(`- Window: ${report.window.from} → ${report.window.to}, interval=${report.window.interval}`);
  lines.push(`- minR threshold: ${report.minR}`);
  lines.push(`- Pairs tested: ${report.totalTested}`);
  lines.push('');
  lines.push(`## Verdict summary`);
  lines.push('');
  lines.push(
    mdTable(
      ['verdict', 'count', 'meaning'],
      [
        ['exact-fit', report.verdictCounts['exact-fit'] ?? 0, 'r > 0.95 AND residual sMAPE < 0.05 — recipe nails it'],
        ['good-fit', report.verdictCounts['good-fit'] ?? 0, 'r > 0.85 AND residual sMAPE < 0.20 — usable recipe'],
        ['scale-only', report.verdictCounts['scale-only'] ?? 0, 'residual sMAPE < 0.10 but r ≤ 0.85 — scale fits, fine-grained shape is noisy'],
        ['shape-only', report.verdictCounts['shape-only'] ?? 0, 'r > 0.85 but residual ≥ 0.20 — shapes correlate, no scalar fits cleanly'],
        ['no-fit', report.verdictCounts['no-fit'] ?? 0, 'neither r nor residual cross thresholds'],
        ['no-data', report.verdictCounts['no-data'] ?? 0, 'one or both sides empty in window'],
      ]
    )
  );
  lines.push('');

  for (const v of VERDICT_ORDER) {
    const subset = report.results.filter((r) => r.verdict === v);
    if (subset.length === 0) continue;
    lines.push(`## ${v} (${subset.length})`);
    lines.push('');
    if (v === 'exact-fit' || v === 'good-fit' || v === 'scale-only') {
      lines.push(
        mdTable(
          ['service', 'classic', 'new', 'recipe', 'mode', 'scale (k)', 'r', 'residual sMAPE'],
          subset.map((r) => [
            r.service,
            mdCode(r.classicDqlKey),
            mdCode(r.newDqlKey),
            r.best ? `c:${r.best.classicAgg} ↔ n:${r.best.newAgg}` : '',
            r.best?.newMode ?? '',
            mdNum(r.best?.scale ?? null, 4),
            mdNum(r.best?.pearsonR ?? null),
            mdNum(r.best?.residualSmape ?? null),
          ])
        )
      );
    } else if (v === 'shape-only') {
      lines.push(
        mdTable(
          ['service', 'classic', 'new', 'best recipe', 'r', 'residual sMAPE', 'comment'],
          subset.map((r) => [
            r.service,
            mdCode(r.classicDqlKey),
            mdCode(r.newDqlKey),
            r.best ? `c:${r.best.classicAgg} ↔ n:${r.best.newAgg}` : '—',
            mdNum(r.best?.pearsonR ?? null),
            mdNum(r.best?.residualSmape ?? null),
            'shape correlates but no scalar k fits cleanly — likely needs a per-dimension reduction or a custom formula',
          ])
        )
      );
    } else {
      lines.push(
        mdTable(
          ['service', 'classic', 'new', 'cw name', 'classic notes'],
          subset.map((r) => [r.service, mdCode(r.classicDqlKey), mdCode(r.newDqlKey), r.cloudwatchName ?? '', r.notes])
        )
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
