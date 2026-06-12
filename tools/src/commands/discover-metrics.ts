/**
 * discover-metrics — inventory the new connection's live metric keys + series
 * counts for a tenant, written to `live-metrics.json`.
 *
 * WHY: the DAC mapping resolves a classic key to ONE new key with a specific
 * `.By.<Dim>` suffix, but that variant isn't always the one populated on a
 * given tenant. Verified on nic55601: `cloud.aws.rds.DatabaseConnections.By.DBClusterIdentifier`
 * (the DAC's pick) has 0 series while `…By.DBInstanceIdentifier` has 109. The
 * lookup chain uses this inventory to detect an empty-variant mapping and
 * prefer a populated sibling (`live-metrics.ts` → `preferPopulatedVariant`).
 *
 * HOW: `fetch metric.series | filter dt.da.source == <source> | summarize
 * count() by metric.key`. One row per live key. ~700 keys on a typical AWS
 * tenant — small JSON.
 *
 * Output: `<tenant-out>/live-metrics.json`
 *   { generated, baseUrl, daSource, from, metricCount, metrics: { key: seriesCount } }
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient } from '../dynatrace/dql.ts';
import { OUT_DIR } from '../lib/paths.ts';

export interface DiscoverMetricsArgs {
  baseUrl: string;
  token: string;
  outDir?: string;
  /** Relative timeframe start. Default `now()-3d`. */
  from?: string;
  /** New-connection DA source. Default `aws-metric-poller`. */
  daSource?: string;
}

export async function runDiscoverMetrics(args: DiscoverMetricsArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });
  const from = args.from ?? 'now()-3d';
  const daSource = args.daSource ?? 'aws-metric-poller';

  const client = new DqlClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} (${info.delayMs.toFixed(0)}ms)`),
  });

  const query =
    `fetch metric.series, from:${from} ` +
    `| filter dt.da.source == "${daSource}" ` +
    `| summarize seriesCount = count(), by:{ metric.key } ` +
    `| sort metric.key asc`;

  console.log(`Inventorying live new-connection metrics on ${args.baseUrl}`);
  console.log(`  source=${daSource}  from=${from}`);
  const result = await client.query({ query, maxResultRecords: 50_000, fetchTimeoutSeconds: 90 });

  const metrics: Record<string, number> = {};
  for (const rec of result.records ?? []) {
    const key = rec['metric.key'];
    const cnt = rec['seriesCount'];
    if (typeof key === 'string' && key.length > 0) {
      metrics[key] = typeof cnt === 'number' ? cnt : Number(cnt) || 0;
    }
  }
  const metricCount = Object.keys(metrics).length;

  const payload = {
    generated: new Date().toISOString(),
    baseUrl: args.baseUrl,
    daSource,
    from,
    metricCount,
    metrics,
  };
  const outPath = join(outDir, 'live-metrics.json');
  await writeFile(outPath, JSON.stringify(payload, null, 2));

  console.log(`  ${metricCount} distinct live metric keys`);
  console.log(`Wrote ${outPath}`);
}
