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
 * count() by metric.key`, split by key prefix wherever a part reaches Grail's
 * silent 100,000-series cap (`lib/series-inventory.ts`). Before 2026-10-27 this
 * was ONE query, so every inventory was a truncated sample of the keys.
 *
 * Output: `<tenant-out>/live-metrics.json`
 *   { generated, baseUrl, daSource, from, metricCount, queries, capped,
 *     metrics: { key: seriesCount }, entities: { key: distinct dt.smartscape_source.id } }
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient } from '../dynatrace/dql.ts';
import { OUT_DIR } from '../lib/paths.ts';
import { SERIES_CAP, inventorySeries, partFilter } from '../lib/series-inventory.ts';

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

  console.log(`Inventorying live new-connection metrics on ${args.baseUrl}`);
  console.log(`  source=${daSource}  from=${from}`);
  // Entities (distinct `dt.smartscape_source.id`) per key: how many resources a
  // variant actually covers, which series counts overstate for finer variants
  // (es CPUUtilization: DomainName 32 series / 8 domains, …NodeId 1769 / 92).
  // A capped sample can only undercount, so keep the highest count seen.
  const entities: Record<string, number> = {};
  const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
  const inv = await inventorySeries(async (part) => {
    const query =
      `fetch metric.series, from:${from} ` +
      `| filter dt.da.source == "${daSource}" and ${partFilter(part)} ` +
      `| summarize seriesCount = count(), entities = countDistinct(dt.smartscape_source.id), by:{ metric.key }`;
    const result = await client.query({ query, maxResultRecords: SERIES_CAP, fetchTimeoutSeconds: 90 });
    const rows: Record<string, number> = {};
    for (const rec of result.records ?? []) {
      const key = rec['metric.key'];
      if (typeof key !== 'string' || key.length === 0) continue;
      rows[key] = num(rec['seriesCount']);
      entities[key] = Math.max(entities[key] ?? 0, num(rec['entities']));
    }
    return rows;
  }, '', {
    onProgress: (q, keys) => {
      if (q % 25 === 0) console.log(`  … ${q} queries, ${keys} keys so far`);
    },
  });

  const metrics = Object.fromEntries(Object.entries(inv.metrics).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const metricCount = Object.keys(metrics).length;

  const payload = {
    generated: new Date().toISOString(),
    baseUrl: args.baseUrl,
    daSource,
    from,
    metricCount,
    queries: inv.queries,
    capped: inv.capped,
    metrics,
    entities: Object.fromEntries(Object.keys(metrics).map((k) => [k, entities[k] ?? 0])),
  };
  const outPath = join(outDir, 'live-metrics.json');
  await writeFile(outPath, JSON.stringify(payload, null, 2));

  console.log(`  ${metricCount} distinct live metric keys (${inv.queries} queries)`);
  if (inv.capped.length) console.log(`  ${inv.capped.length} key(s) over ${SERIES_CAP} series, counted at the cap: ${inv.capped.join(', ')}`);
  console.log(`Wrote ${outPath}`);
}
