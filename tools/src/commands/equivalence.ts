/**
 * equivalence — for each (classic, new) metric pair derived from the local
 * mapping, query both via DQL on the tenant and compare values.
 *
 * Pair derivation (Python scrape `mappings/aws_mapping.json`):
 *   classic v2-API key   builtin:cloud.aws.alb.connections.active
 *   classic DQL key      dt.cloud.aws.alb.connections.active     (transformed)
 *   new DQL key          cloud.aws.applicationelb.ActiveConnectionCount.By.LoadBalancer
 *                                                                (newDtMetricKey)
 *
 * The transform is: strip `builtin:` → prepend `dt.`, snake-case every
 * dotted segment. Verified empirically: 75 of 92 Python-mapped classic keys
 * resolve directly to keys present on the tested tenant.
 *
 * For each pair we issue two parallel DQL queries (one per side) so a key
 * missing on one side becomes a finding rather than a hard failure.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient } from '../dynatrace/dql.ts';
import { combineSeries, parseTimeseriesRecord, type ParsedSeries } from '../lib/dql-parser.ts';
import { mdCode, mdNum, mdTable } from '../lib/markdown.ts';
import { OUT_DIR, REPO_ROOT } from '../lib/paths.ts';
import { builtinToDqlClassic } from '../lib/schema-transforms.ts';
import { compareAligned, summarize, type TimeSeriesPoint } from '../lib/stats.ts';

export type Aggregation = 'avg' | 'sum' | 'max' | 'min' | 'count';

export interface EquivalenceArgs {
  baseUrl: string;
  token: string;
  /** Path to a Python-scrape mapping file. Defaults to repo's mappings/aws_mapping.json. */
  mappingPath?: string;
  limit?: number;
  /** Filter pairs by service slug (e.g. "ec2", "dynamo"). */
  service?: string;
  aggregation?: Aggregation;
  from?: string;
  to?: string;
  interval?: string;
  outDir?: string;
  /** Skip pairs where one side is empty. */
  skipMissing?: boolean;
  /** Skip pairs where both sides are empty (default true). */
  skipBothMissing?: boolean;
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

interface PairResult extends Pair {
  classicQuery: string;
  newQuery: string;
  aggregation: Aggregation;
  classicSeriesCount: number;
  newSeriesCount: number;
  comparison: ReturnType<typeof compareAligned>;
  classicSummary: ReturnType<typeof summarize>;
  newSummary: ReturnType<typeof summarize>;
  error?: string;
}

const VERDICT_ORDER: Array<PairResult['comparison']['verdict']> = [
  'identical',
  'scaled',
  'correlated',
  'different',
  'no-data',
];

function dqlIdent(metricKey: string): string {
  if (metricKey.includes('`')) {
    throw new Error(`Refusing metric key containing backtick: ${metricKey}`);
  }
  return '`' + metricKey + '`';
}

function buildQuery(
  metricKey: string,
  agg: Aggregation,
  from: string,
  to: string,
  interval: string
): string {
  return `timeseries val = ${agg}(${dqlIdent(metricKey)}), interval: ${interval}, from: ${from}, to: ${to}`;
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

async function fetchSeries(
  client: DqlClient,
  metricKey: string,
  agg: Aggregation,
  from: string,
  to: string,
  interval: string
): Promise<{ points: TimeSeriesPoint[]; seriesCount: number; error?: string }> {
  const query = buildQuery(metricKey, agg, from, to, interval);
  try {
    const result = await client.query({
      query,
      maxResultRecords: 1000,
      fetchTimeoutSeconds: 60,
    });
    const allSeries: ParsedSeries[] = result.records.flatMap((r) => parseTimeseriesRecord(r, 'val'));
    if (allSeries.length === 0) {
      return { points: [], seriesCount: 0 };
    }
    return { points: combineSeries(allSeries), seriesCount: allSeries.length };
  } catch (e) {
    return { points: [], seriesCount: 0, error: (e as Error).message };
  }
}

export async function runEquivalence(args: EquivalenceArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });

  const mappingPath =
    args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.json');
  const mapping = JSON.parse(await readFile(mappingPath, 'utf8')) as PythonMapping;

  const limit = args.limit ?? 25;
  // 1h offset on the trailing edge to avoid partial buckets / collection lag.
  const from = args.from ?? '-25h';
  const to = args.to ?? '-1h';
  const interval = args.interval ?? '5m';
  const aggregation: Aggregation = args.aggregation ?? 'avg';
  const skipBothMissing = args.skipBothMissing ?? true;

  const allPairs = loadPairs(mapping, args.service);
  const queue = allPairs.slice(0, limit);

  console.log(
    `Testing ${queue.length} pairs (of ${allPairs.length} from ${mappingPath}) ` +
      `from=${from} to=${to} interval=${interval} agg=${aggregation}`
  );
  if (queue.length === 0) {
    console.log('No candidates. Nothing to do.');
    return;
  }

  const client = new DqlClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} — sleeping ${info.delayMs.toFixed(0)}ms`),
  });

  const results: PairResult[] = [];
  let i = 0;
  for (const pair of queue) {
    i++;
    process.stdout.write(`[${i}/${queue.length}] ${pair.classicDqlKey} vs ${pair.newDqlKey} ... `);

    const [classicData, newData] = await Promise.all([
      fetchSeries(client, pair.classicDqlKey, aggregation, from, to, interval),
      fetchSeries(client, pair.newDqlKey, aggregation, from, to, interval),
    ]);

    const error = classicData.error
      ? `classic: ${classicData.error}`
      : newData.error
      ? `new: ${newData.error}`
      : undefined;

    const classicEmpty = classicData.points.length === 0;
    const newEmpty = newData.points.length === 0;
    if (skipBothMissing && classicEmpty && newEmpty && !error) {
      console.log('skipped (both empty)');
      continue;
    }
    if (args.skipMissing && (classicEmpty || newEmpty) && !error) {
      console.log(`skipped (${classicEmpty ? 'classic empty' : 'new empty'})`);
      continue;
    }

    const cmp = compareAligned(classicData.points, newData.points);
    results.push({
      ...pair,
      classicQuery: buildQuery(pair.classicDqlKey, aggregation, from, to, interval),
      newQuery: buildQuery(pair.newDqlKey, aggregation, from, to, interval),
      aggregation,
      classicSeriesCount: classicData.seriesCount,
      newSeriesCount: newData.seriesCount,
      comparison: cmp,
      classicSummary: summarize(classicData.points.map((p) => p.value)),
      newSummary: summarize(newData.points.map((p) => p.value)),
      error,
    });

    console.log(
      error
        ? `error (${error})`
        : `${cmp.verdict}` +
            ` classic=${classicData.seriesCount} new=${newData.seriesCount}` +
            (cmp.pearsonR !== null ? ` r=${cmp.pearsonR.toFixed(3)}` : '') +
            (cmp.smape !== null ? ` smape=${cmp.smape.toFixed(3)}` : '')
    );
  }

  const verdicts = results.reduce<Record<string, number>>((m, r) => {
    m[r.comparison.verdict] = (m[r.comparison.verdict] ?? 0) + 1;
    return m;
  }, {});

  const report = {
    generated: new Date().toISOString(),
    baseUrl: args.baseUrl,
    mappingPath,
    window: { from, to, interval, aggregation },
    totalTested: results.length,
    verdictCounts: verdicts,
    results,
  };

  const jsonPath = join(outDir, 'equivalence_report.json');
  await writeFile(jsonPath, JSON.stringify(report, null, 2));

  const mdPath = join(outDir, 'equivalence_report.md');
  await writeFile(mdPath, renderMarkdown(report));

  console.log('');
  console.log(`Verdict summary: ${JSON.stringify(verdicts)}`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

interface EquivalenceReport {
  generated: string;
  baseUrl: string;
  mappingPath: string;
  window: { from: string; to: string; interval: string; aggregation: Aggregation };
  totalTested: number;
  verdictCounts: Record<string, number>;
  results: PairResult[];
}

function renderMarkdown(report: EquivalenceReport): string {
  const lines: string[] = [];
  lines.push(`# Equivalence report`);
  lines.push('');
  lines.push(`- Generated: ${report.generated}`);
  lines.push(`- Tenant: ${report.baseUrl}`);
  lines.push(`- Mapping: ${report.mappingPath}`);
  lines.push(
    `- Window: ${report.window.from} → ${report.window.to}, interval=${report.window.interval}, aggregation=${report.window.aggregation}`
  );
  lines.push(`- Pairs tested: ${report.totalTested}`);
  lines.push('');
  lines.push(`## Verdict summary`);
  lines.push('');
  lines.push(
    mdTable(
      ['verdict', 'count'],
      VERDICT_ORDER.map((v) => [v, report.verdictCounts[v] ?? 0])
    )
  );
  lines.push('');

  for (const verdict of VERDICT_ORDER) {
    const subset = report.results.filter((r) => r.comparison.verdict === verdict);
    if (subset.length === 0) continue;
    lines.push(`## ${verdict} (${subset.length})`);
    lines.push('');
    const rows = subset.map((r) => [
      r.service,
      mdCode(r.classicDqlKey),
      mdCode(r.newDqlKey),
      r.cloudwatchName ?? '',
      mdNum(r.comparison.pearsonR),
      mdNum(r.comparison.smape),
      mdNum(r.comparison.meanRatio),
      r.comparison.alignedPoints,
      r.comparison.unalignedPoints,
      r.classicSeriesCount,
      r.newSeriesCount,
      r.error ?? '',
    ]);
    lines.push(
      mdTable(
        [
          'service',
          'classic',
          'new',
          'cw name',
          'r',
          'smape',
          'mean ratio',
          'aligned',
          'unaligned',
          'cs',
          'ns',
          'error',
        ],
        rows
      )
    );
    lines.push('');
  }
  return lines.join('\n');
}
