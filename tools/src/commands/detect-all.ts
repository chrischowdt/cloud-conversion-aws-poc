/**
 * detect-all — run `detect` across every balanced (account, region) overlap
 * cluster from `discover`'s output, then aggregate per metric: take the
 * best recipe across clusters.
 *
 * "Best" = highest verdict tier (exact-fit > good-fit > scale-only > shape-only),
 * tiebroken by lowest residual sMAPE.
 *
 * Default cluster filter: both sides ≥ 50 series, classic/new ratio in [0.3, 3.0].
 * Tighten with --min-series and --max-ratio if you want fewer clusters.
 *
 * Inputs:
 *   tools/out/overlap_clusters.json   (output of `discover`)
 *
 * Outputs:
 *   tools/out/detect_all_report.json  (per-cluster + aggregated results)
 *   tools/out/detected_recipes.json   (best-per-metric, ready for merge-recipes)
 *   tools/out/detect_all_report.md    (markdown summary)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runDetect, type DetectArgs } from './detect.ts';
import { mdCode, mdNum, mdTable } from '../lib/markdown.ts';
import { OUT_DIR } from '../lib/paths.ts';

export interface DetectAllArgs {
  baseUrl: string;
  token: string;
  mappingPath?: string;
  from?: string;
  to?: string;
  interval?: string;
  outDir?: string;
  /** Minimum series count on each side for a cluster to qualify. Default 50. */
  minSeries?: number;
  /** Max ratio between sides (in either direction). Default 3.0. */
  maxRatio?: number;
  /** Optional cap on how many clusters to test. */
  maxClusters?: number;
}

interface OverlapCluster {
  account: string;
  region: string;
  classicSeries: number;
  newSeries: number;
}

interface OverlapClustersFile {
  clusters: OverlapCluster[];
  window: { from: string; to: string };
}

interface DetectReportFile {
  generated: string;
  baseUrl: string;
  window: { from: string; to: string; interval: string };
  filter: string | null;
  results: Array<{
    classicBuiltin: string;
    classicDqlKey: string;
    newDqlKey: string;
    cloudwatchName: string | null;
    service: string;
    verdict: string;
    best: {
      classicAgg: string;
      newAgg: string;
      newMode: string;
      pearsonR: number | null;
      scale: number | null;
      residualSmape: number | null;
    } | null;
  }>;
}

const VERDICT_RANK: Record<string, number> = {
  'exact-fit': 5,
  'good-fit': 4,
  'scale-only': 3,
  'shape-only': 2,
  'no-fit': 1,
  'no-data': 0,
};

interface AggregatedPick {
  classicMetricId: string;
  newDtMetricKey: string;
  service: string;
  /** Cluster the winning recipe came from. */
  winningCluster: { account: string; region: string };
  verdict: string;
  classicAggregation: string;
  newAggregation: string;
  newAggregationMode: string;
  scale: number | null;
  pearsonR: number | null;
  residualSmape: number | null;
  /** All clusters that produced ANY result for this pair, with their verdict. */
  perClusterVerdict: Record<string, string>;
}

export async function runDetectAll(args: DetectAllArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });

  const minSeries = args.minSeries ?? 50;
  const maxRatio = args.maxRatio ?? 3.0;
  const overlapPath = join(outDir, 'overlap_clusters.json');

  let overlapFile: OverlapClustersFile;
  try {
    overlapFile = JSON.parse(await readFile(overlapPath, 'utf8')) as OverlapClustersFile;
  } catch {
    throw new Error(`No overlap_clusters.json at ${overlapPath}. Run \`cct discover\` first.`);
  }

  const balanced = overlapFile.clusters
    .filter((c) => {
      if (c.classicSeries < minSeries || c.newSeries < minSeries) return false;
      const r = c.classicSeries / c.newSeries;
      return r >= 1 / maxRatio && r <= maxRatio;
    })
    .slice(0, args.maxClusters ?? Infinity);

  console.log(
    `Running detect across ${balanced.length} balanced clusters ` +
      `(minSeries=${minSeries}, maxRatio=${maxRatio}) over ${args.from ?? '-10d'} → ${args.to ?? '-5d'}`
  );
  if (balanced.length === 0) {
    console.log('No balanced clusters available. Loosen --min-series or --max-ratio.');
    return;
  }

  const perClusterReports: Array<{ cluster: OverlapCluster; report: DetectReportFile }> = [];
  for (let i = 0; i < balanced.length; i++) {
    const c = balanced[i]!;
    const filter = `aws.account.id == "${c.account}" and aws.region == "${c.region}"`;
    console.log(
      `\n=== [${i + 1}/${balanced.length}] cluster ${c.account} ${c.region}  ` +
        `(classic=${c.classicSeries}, new=${c.newSeries}) ===`
    );
    const detectArgs: DetectArgs = {
      baseUrl: args.baseUrl,
      token: args.token,
      mappingPath: args.mappingPath,
      from: args.from,
      to: args.to,
      interval: args.interval,
      filter,
      outDir,
    };
    await runDetect(detectArgs);

    // Capture the report this run wrote (detect overwrites detect_report.json each time).
    const report = JSON.parse(await readFile(join(outDir, 'detect_report.json'), 'utf8')) as DetectReportFile;
    perClusterReports.push({ cluster: c, report });
  }

  // Aggregate per pair: pick the highest verdict across clusters, tiebreak on residual sMAPE.
  const bestByKey = new Map<string, AggregatedPick>();
  for (const { cluster, report } of perClusterReports) {
    const clusterLabel = `${cluster.account}/${cluster.region}`;
    for (const r of report.results) {
      const existing = bestByKey.get(r.classicBuiltin);
      const perCluster = existing?.perClusterVerdict ?? {};
      perCluster[clusterLabel] = r.verdict;
      const candidate: AggregatedPick = {
        classicMetricId: r.classicBuiltin,
        newDtMetricKey: r.newDqlKey,
        service: r.service,
        winningCluster: { account: cluster.account, region: cluster.region },
        verdict: r.verdict,
        classicAggregation: r.best?.classicAgg ?? '',
        newAggregation: r.best?.newAgg ?? '',
        newAggregationMode: r.best?.newMode ?? 'raw',
        scale: r.best?.scale ?? null,
        pearsonR: r.best?.pearsonR ?? null,
        residualSmape: r.best?.residualSmape ?? null,
        perClusterVerdict: perCluster,
      };
      if (!existing) {
        bestByKey.set(r.classicBuiltin, candidate);
        continue;
      }
      const ra = VERDICT_RANK[r.verdict] ?? 0;
      const rb = VERDICT_RANK[existing.verdict] ?? 0;
      if (ra > rb) {
        bestByKey.set(r.classicBuiltin, candidate);
      } else if (ra === rb) {
        const newRes = r.best?.residualSmape ?? Infinity;
        const oldRes = existing.residualSmape ?? Infinity;
        if (newRes < oldRes) bestByKey.set(r.classicBuiltin, candidate);
      }
      // Always keep perClusterVerdict up to date even if we don't swap pick.
      bestByKey.get(r.classicBuiltin)!.perClusterVerdict = perCluster;
    }
  }

  const aggregated = [...bestByKey.values()];
  const verdictCounts: Record<string, number> = {};
  for (const a of aggregated) verdictCounts[a.verdict] = (verdictCounts[a.verdict] ?? 0) + 1;

  // Write detect_all report.
  const reportOut = {
    generated: new Date().toISOString(),
    baseUrl: args.baseUrl,
    clustersTested: balanced.length,
    clusters: balanced,
    aggregatedVerdictCounts: verdictCounts,
    aggregated,
  };
  await writeFile(join(outDir, 'detect_all_report.json'), JSON.stringify(reportOut, null, 2));

  // Overwrite detected_recipes.json with the aggregated best.
  const recipes = aggregated
    .filter((a) => a.verdict === 'exact-fit' || a.verdict === 'good-fit' || a.verdict === 'scale-only')
    .map((a) => ({
      classicMetricId: a.classicMetricId,
      newDtMetricKey: a.newDtMetricKey,
      newAggregation: a.newAggregation,
      newAggregationMode: a.newAggregationMode,
      classicAggregation: a.classicAggregation,
      scale: a.scale,
      verdict: a.verdict,
      pearsonR: a.pearsonR,
      residualSmape: a.residualSmape,
      winningCluster: `${a.winningCluster.account}/${a.winningCluster.region}`,
    }));
  await writeFile(
    join(outDir, 'detected_recipes.json'),
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        window: {
          from: args.from ?? '-10d',
          to: args.to ?? '-5d',
          interval: args.interval ?? '5m',
        },
        source: 'detect-all (best across balanced clusters)',
        clustersTested: balanced.length,
        recipes,
      },
      null,
      2
    )
  );

  // Markdown.
  const md: string[] = [];
  md.push(`# Detect-all aggregated report`);
  md.push('');
  md.push(`- Generated: ${reportOut.generated}`);
  md.push(`- Tenant: ${args.baseUrl}`);
  md.push(`- Clusters tested: ${balanced.length} (minSeries=${minSeries}, maxRatio=${maxRatio})`);
  md.push(`- Total unique pairs aggregated: ${aggregated.length}`);
  md.push('');
  md.push(`## Verdict counts (best across all clusters)`);
  md.push('');
  md.push(
    mdTable(
      ['verdict', 'count'],
      ['exact-fit', 'good-fit', 'scale-only', 'shape-only', 'no-fit', 'no-data'].map((v) => [
        v,
        verdictCounts[v] ?? 0,
      ])
    )
  );
  md.push('');
  md.push(`## Clusters tested`);
  md.push('');
  md.push(
    mdTable(
      ['#', 'account', 'region', 'classic series', 'new series', 'ratio c/n'],
      balanced.map((c, i) => [
        i + 1,
        c.account,
        c.region,
        c.classicSeries,
        c.newSeries,
        (c.classicSeries / c.newSeries).toFixed(3),
      ])
    )
  );
  md.push('');
  md.push(`## Aggregated recipes (exact-fit + good-fit + scale-only)`);
  md.push('');
  const actionable = aggregated
    .filter((a) => a.verdict === 'exact-fit' || a.verdict === 'good-fit' || a.verdict === 'scale-only')
    .sort((a, b) => (VERDICT_RANK[b.verdict] ?? 0) - (VERDICT_RANK[a.verdict] ?? 0));
  md.push(
    mdTable(
      ['service', 'classic', 'new', 'recipe', 'mode', 'scale', 'r', 'residual', 'verdict', 'won-in'],
      actionable.map((a) => [
        a.service,
        mdCode(a.classicMetricId),
        mdCode(a.newDtMetricKey),
        `c:${a.classicAggregation} ↔ n:${a.newAggregation}`,
        a.newAggregationMode,
        mdNum(a.scale, 4),
        mdNum(a.pearsonR),
        mdNum(a.residualSmape),
        a.verdict,
        `${a.winningCluster.account}/${a.winningCluster.region}`,
      ])
    )
  );
  await writeFile(join(outDir, 'detect_all_report.md'), md.join('\n'));

  console.log('');
  console.log(`Aggregated ${aggregated.length} unique pairs across ${balanced.length} clusters.`);
  console.log(`Verdict counts: ${JSON.stringify(verdictCounts)}`);
  console.log(`Wrote ${join(outDir, 'detect_all_report.json')}`);
  console.log(`Wrote ${join(outDir, 'detected_recipes.json')} (${recipes.length} actionable recipes)`);
  console.log(`Wrote ${join(outDir, 'detect_all_report.md')}`);
}
