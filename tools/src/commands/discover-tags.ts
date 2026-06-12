/**
 * discover-tags — find which AWS tags the new connection enriches onto metric
 * series for a tenant, and emit a per-tenant `enriched-tags.json`.
 *
 * WHY: the new (Smartscape) AWS connection lets the customer choose which AWS
 * tags get enriched onto every metric as `aws.tags.<key>` dims. The enriched
 * set is per-connection and varies by tenant. When the rewriter translates a
 * classic tag filter (e.g. `classicEntitySelector("tags([AWS]ApplicationCI:x)")`),
 * it can use a cheap direct dim filter `aws.tags.applicationci == "x"` ONLY if
 * that tag is enriched. For non-enriched tags the new query must instead do a
 * `smartscapeNodes <TYPE>` lookup and read `tags:aws` off the node — correct
 * but more expensive. This command discovers which tags take the cheap path.
 *
 * HOW: a single `fetch metric.series` sample (no value arrays — series metadata
 * only) over the new-connection source, then a client-side scan of every
 * record's keys for the `aws.tags.` prefix. Enrichment is a connection-level
 * setting, so any `aws.tags.<key>` present on a sampled series means that key
 * is enriched (and at least one resource carries it). Coverage % is reported
 * for context but presence is what determines the cheap-vs-lookup decision.
 *
 * Tag keys are reported lowercased — verified on tenant nic55601 the
 * enrichment lowercases keys (classic `[AWS]ApplicationCI` → `aws.tags.applicationci`).
 *
 * Output: `<tenant-out>/enriched-tags.json`
 *   { generated, baseUrl, daSource, sampleSize, tags: [{ key, count, coveragePct }],
 *     enrichedTagKeys: string[] }
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient } from '../dynatrace/dql.ts';
import { OUT_DIR } from '../lib/paths.ts';

export interface DiscoverTagsArgs {
  baseUrl: string;
  token: string;
  outDir?: string;
  /** Relative timeframe start for the sample. Default `now()-3d`. */
  from?: string;
  /** New-connection DA source to scope to. Default `aws-metric-poller`. */
  daSource?: string;
  /** How many series records to sample. Default 5000. */
  sampleSize?: number;
}

const TAG_PREFIX = 'aws.tags.';

interface TagStat {
  key: string;
  count: number;
  coveragePct: number;
}

export async function runDiscoverTags(args: DiscoverTagsArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });
  const from = args.from ?? 'now()-3d';
  const daSource = args.daSource ?? 'aws-metric-poller';
  const sampleSize = args.sampleSize ?? 5000;

  const client = new DqlClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} (${info.delayMs.toFixed(0)}ms)`),
  });

  // `fetch metric.series` (no trailing timeseries/aggregation) returns one
  // metadata record per series with its dimension fields — NOT the value
  // arrays — so this stays light even at a 5k sample.
  const query =
    `fetch metric.series, from:${from} ` +
    `| filter dt.da.source == "${daSource}" ` +
    `| limit ${sampleSize}`;

  console.log(`Discovering enriched tags on ${args.baseUrl}`);
  console.log(`  source=${daSource}  from=${from}  sample=${sampleSize}`);
  const result = await client.query({ query, maxResultRecords: sampleSize, fetchTimeoutSeconds: 90 });
  const records = result.records ?? [];
  console.log(`  sampled ${records.length} series records`);

  // Tally distinct `aws.tags.<key>` fields that are non-null across the sample.
  const counts = new Map<string, number>();
  let typeField = 0;
  for (const rec of records) {
    if (rec['dt.smartscape_source.type'] != null) typeField++;
    for (const [k, v] of Object.entries(rec)) {
      if (!k.startsWith(TAG_PREFIX)) continue;
      if (v === null || v === undefined || v === '') continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }

  const n = records.length || 1;
  const tags: TagStat[] = [...counts.entries()]
    .map(([fullKey, count]) => ({
      // Strip the `aws.tags.` prefix → the tag key; already lowercased by enrichment.
      key: fullKey.slice(TAG_PREFIX.length),
      count,
      coveragePct: Math.round((count / n) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count);

  const enrichedTagKeys = tags.map((t) => t.key);

  const payload = {
    generated: new Date().toISOString(),
    baseUrl: args.baseUrl,
    daSource,
    from,
    sampleSize: records.length,
    tags,
    enrichedTagKeys,
  };
  const outPath = join(outDir, 'enriched-tags.json');
  await writeFile(outPath, JSON.stringify(payload, null, 2));

  console.log('');
  if (tags.length === 0) {
    console.log(
      `No \`${TAG_PREFIX}*\` dims found in the sample. Either no tags are enriched on ` +
        `this connection, or the sample window/source returned no new-connection series.`
    );
  } else {
    console.log(`Enriched tags (${tags.length}):`);
    for (const t of tags) {
      console.log(`  ${t.key.padEnd(28)} ${String(t.count).padStart(6)} series  (${t.coveragePct}% of sample)`);
    }
  }
  console.log('');
  console.log(`Wrote ${outPath}`);
}
