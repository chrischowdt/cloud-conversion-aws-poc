/**
 * discover — for every cloud.aws.* metric key on the tenant, report how many
 * series are classic-ingested (`dt.smartscape_source.type` is null) vs
 * new-gen-ingested (`dt.smartscape_source.type` is not null).
 *
 * Both classic and new data live under the SAME metric key in DQL — the only
 * discriminator is the `dt.smartscape_source.type` dimension. Keys with both
 * counts > 0 are migration candidates suitable for direct equivalence testing.
 *
 * Outputs:
 *   tools/out/tenant_keys.aws.json         — per-key {classic, new} counts
 *   tools/out/discover_report.aws.json     — summary + verdict
 *   tools/out/discover_report.aws.md       — markdown summary
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient } from '../dynatrace/dql.ts';
import { mdCode, mdTable } from '../lib/markdown.ts';
import { OUT_DIR } from '../lib/paths.ts';

export interface DiscoverArgs {
  baseUrl: string;
  token: string;
  /** Override the DQL prefix filter. Default: cloud.aws.* */
  keyPrefixes?: string[];
  from?: string;
  to?: string;
  outDir?: string;
}

const DEFAULT_KEY_PREFIXES = ['cloud.aws.'];

interface KeyCounts {
  metricKey: string;
  classicSeries: number;
  newSeries: number;
}

function buildPrefixFilter(prefixes: string[]): string {
  return prefixes
    .map((p) => `startsWith(metric.key, "${p.replace(/"/g, '\\"')}")`)
    .join(' or ');
}

const toNumber = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

export async function runDiscover(args: DiscoverArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });

  const prefixes = args.keyPrefixes ?? DEFAULT_KEY_PREFIXES;
  // 1h offset on the trailing edge to avoid partial buckets / collection lag.
  const from = args.from ?? '-7d';
  const to = args.to ?? '-1h';

  const client = new DqlClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} (waiting ${info.delayMs.toFixed(0)}ms)`),
  });

  const dql = `
    fetch metric.series, from: ${from}, to: ${to}
    | filter ${buildPrefixFilter(prefixes)}
    | summarize {
        classic = countIf(isNull(dt.smartscape_source.type)),
        new = countIf(isNotNull(dt.smartscape_source.type))
      }, by: { metric.key }
    | sort \`metric.key\` asc
  `.trim();

  console.log(`Querying tenant for cloud-metric ingestion split (${from} → ${to})…`);
  const result = await client.query({
    query: dql,
    maxResultRecords: 50_000,
    fetchTimeoutSeconds: 90,
  });

  const keys: KeyCounts[] = [];
  for (const r of result.records) {
    const key = (r['metric.key'] ?? r['metricKey']) as string | undefined;
    if (!key) continue;
    keys.push({
      metricKey: key,
      classicSeries: toNumber(r['classic']),
      newSeries: toNumber(r['new']),
    });
  }
  keys.sort((a, b) => a.metricKey.localeCompare(b.metricKey));

  // Buckets:
  const both = keys.filter((k) => k.classicSeries > 0 && k.newSeries > 0);
  const classicOnly = keys.filter((k) => k.classicSeries > 0 && k.newSeries === 0);
  const newOnly = keys.filter((k) => k.classicSeries === 0 && k.newSeries > 0);

  await writeFile(
    join(outDir, 'tenant_keys.aws.json'),
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        baseUrl: args.baseUrl,
        prefixes,
        from,
        to,
        dql,
        count: keys.length,
        keys,
      },
      null,
      2
    )
  );

  const verdict = (() => {
    if (keys.length === 0) return 'no-data';
    if (both.length > 0) return `parallel-ingestion: ${both.length} key(s) have both classic and new data`;
    if (classicOnly.length > 0 && newOnly.length === 0) return 'classic-only';
    if (newOnly.length > 0 && classicOnly.length === 0) return 'new-only';
    return `disjoint: ${classicOnly.length} classic-only / ${newOnly.length} new-only / 0 overlap`;
  })();

  const report = {
    generated: new Date().toISOString(),
    baseUrl: args.baseUrl,
    window: { from, to },
    keyCount: keys.length,
    bucketCounts: {
      both: both.length,
      classicOnly: classicOnly.length,
      newOnly: newOnly.length,
    },
    verdict,
    bothSample: both.slice(0, 50),
    classicOnlySample: classicOnly.slice(0, 25),
    newOnlySample: newOnly.slice(0, 25),
  };

  await writeFile(
    join(outDir, 'discover_report.aws.json'),
    JSON.stringify(report, null, 2)
  );

  // Markdown.
  const md: string[] = [];
  md.push(`# Tenant ingestion-split discovery`);
  md.push('');
  md.push(`- Tenant: ${args.baseUrl}`);
  md.push(`- Generated: ${report.generated}`);
  md.push(`- Window: ${from} → ${to}`);
  md.push(`- Prefixes: ${prefixes.map(mdCode).join(', ')}`);
  md.push(`- Total \`cloud.aws.*\` metric keys: ${keys.length}`);
  md.push(`- **Verdict: ${verdict}**`);
  md.push('');
  md.push(`> Classic data = rows where \`dt.smartscape_source.type\` is null. New = rows where it is set. Same metric key, different ingestion path.`);
  md.push('');
  md.push(`## Bucket counts`);
  md.push('');
  md.push(
    mdTable(
      ['bucket', 'count', 'description'],
      [
        ['both', both.length, 'metric key has both classic and new series — equivalence-testable'],
        ['classic-only', classicOnly.length, 'classic data only; not yet migrated'],
        ['new-only', newOnly.length, 'new data only; classic already retired or never present'],
      ]
    )
  );
  md.push('');
  if (both.length > 0) {
    md.push(`## Parallel-ingestion keys (${both.length})`);
    md.push('');
    md.push(
      mdTable(
        ['metric.key', 'classic series', 'new series'],
        both.slice(0, 50).map((k) => [mdCode(k.metricKey), k.classicSeries, k.newSeries])
      )
    );
    if (both.length > 50) {
      md.push('');
      md.push(`_…and ${both.length - 50} more (see JSON report)._`);
    }
    md.push('');
  } else {
    md.push(`## Parallel-ingestion keys`);
    md.push('');
    md.push(`_None — no metric key has both classic and new series in this window. Equivalence testing requires a tenant running parallel ingestion._`);
    md.push('');
  }
  await writeFile(join(outDir, 'discover_report.aws.md'), md.join('\n'));

  // Find (account, region) clusters where BOTH classic and new have data —
  // these are the viable comparison scopes for detect/equivalence.
  const overlapDql = `
    fetch metric.series, from: ${from}, to: ${to}
    | filter startsWith(metric.key, "dt.cloud.aws.") or startsWith(metric.key, "cloud.aws.")
    | filter isNotNull(aws.account.id) and isNotNull(aws.region)
    | summarize {
        classic = countIf(startsWith(metric.key, "dt.cloud.aws.")),
        new = countIf(startsWith(metric.key, "cloud.aws."))
      }, by: { aws.account.id, aws.region }
    | filter classic > 0 and new > 0
    | sort classic + new desc
  `.trim();

  console.log('Discovering (account, region) overlap clusters…');
  let overlaps: Array<{ account: string; region: string; classicSeries: number; newSeries: number }> = [];
  try {
    const overlapResult = await client.query({
      query: overlapDql,
      maxResultRecords: 500,
      fetchTimeoutSeconds: 60,
    });
    overlaps = overlapResult.records.map((r) => ({
      account: String(r['aws.account.id'] ?? ''),
      region: String(r['aws.region'] ?? ''),
      classicSeries: toNumber(r['classic']),
      newSeries: toNumber(r['new']),
    }));
  } catch (e) {
    console.log(`  overlap query failed (continuing): ${(e as Error).message}`);
  }

  await writeFile(
    join(outDir, 'overlap_clusters.json'),
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        baseUrl: args.baseUrl,
        window: { from, to },
        dql: overlapDql,
        count: overlaps.length,
        clusters: overlaps,
      },
      null,
      2
    )
  );

  console.log('');
  console.log(`Total cloud.aws.* keys      : ${keys.length}`);
  console.log(`  both (classic AND new)    : ${both.length}`);
  console.log(`  classic-only              : ${classicOnly.length}`);
  console.log(`  new-only                  : ${newOnly.length}`);
  console.log(`Overlap clusters            : ${overlaps.length}`);
  if (overlaps.length > 0) {
    console.log('  top clusters:');
    for (const o of overlaps.slice(0, 5)) {
      console.log(`    account=${o.account} region=${o.region}  classic=${o.classicSeries} new=${o.newSeries}`);
    }
  }
  console.log(`Verdict: ${verdict}`);
  console.log(`Wrote ${join(outDir, 'tenant_keys.aws.json')}`);
  console.log(`Wrote ${join(outDir, 'discover_report.aws.json')}`);
  console.log(`Wrote ${join(outDir, 'discover_report.aws.md')}`);
  console.log(`Wrote ${join(outDir, 'overlap_clusters.json')}`);
}
