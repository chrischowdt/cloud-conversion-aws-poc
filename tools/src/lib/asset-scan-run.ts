/**
 * asset-scan-run — Node-side runner that folds a list of extracted assets
 * through the shared scan core and writes the coverage artifacts. Kept separate
 * from the pure `asset-scan.ts` (which stays fetch/fs-free for App reuse).
 *
 * Writes, under `<tenantDir>/<outSubdir>/`:
 *   summary.json    — the ScanSummary
 *   results.jsonl   — one line per AWS asset (id, name, buckets, details)
 *   summary.md      — human-readable coverage report
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

import { ScanAccumulator, hasAwsMarker, type ExtractedQuery, type ScanSummary } from './asset-scan.ts';
import type { RecipeIndex } from './recipe-lookup.ts';
import { mdTable } from './markdown.ts';

export interface ScanInputAsset {
  id: string;
  name: string;
  file: string;
  queries: ExtractedQuery[];
}

export async function runAssetScan(opts: {
  assetType: string;
  outSubdir: string;
  tenantDir: string;
  index: RecipeIndex;
  assets: ScanInputAsset[];
  /** Scan every asset, not just AWS-referencing ones. */
  all?: boolean;
  /** Process at most N AWS assets. */
  limit?: number;
}): Promise<ScanSummary> {
  const scanDir = join(opts.tenantDir, opts.outSubdir);
  await mkdir(scanDir, { recursive: true });
  const acc = new ScanAccumulator(opts.assetType);
  const resultsStream = createWriteStream(join(scanDir, 'results.jsonl'), { encoding: 'utf8' });

  let awsCounted = 0;
  try {
    for (const asset of opts.assets) {
      acc.markFile();
      // Scan only the AWS-referencing queries. A notebook can carry dozens of
      // unrelated cells (logs, other clouds); folding those in would drown the
      // conversion rate in non-AWS no-ops. `--all` keeps everything.
      const scanQueries = opts.all ? asset.queries : asset.queries.filter((q) => hasAwsMarker(q.query));
      if (scanQueries.length === 0) {
        acc.markNonAws();
        continue;
      }
      if (opts.limit && awsCounted >= opts.limit) continue;
      awsCounted++;
      const per = acc.add({ id: asset.id, name: asset.name, file: asset.file }, scanQueries, opts.index);
      resultsStream.write(JSON.stringify(per) + '\n');
    }
  } finally {
    await new Promise<void>((res) => resultsStream.end(res));
  }

  await writeFile(join(scanDir, 'summary.json'), JSON.stringify(acc.summary, null, 2));

  // ── Markdown ──
  const t = acc.summary.totals;
  const denom = t.queries || 1;
  const pct = (n: number) => `${((n / denom) * 100).toFixed(1)}%`;
  const md: string[] = [];
  md.push(`# ${opts.assetType} scan`);
  md.push('');
  md.push(`- Generated: ${acc.summary.generated}`);
  md.push(`- Files: ${t.files} (AWS: ${t.awsAssets}, non-AWS: ${t.nonAwsAssets}, parse-errors: ${t.parseErrors})`);
  md.push(`- Queries in AWS assets: **${t.queries}**`);
  if (t.rewriteErrors > 0) md.push(`- Rewriter errors (isolated, counted as not-converted): ${t.rewriteErrors}`);
  md.push('');
  md.push('## Coverage');
  md.push('');
  md.push(
    mdTable(
      ['bucket', 'count', 'share', 'meaning'],
      [
        ['converted (clean+soft)', acc.summary.converted, pct(acc.summary.converted), 'rewriter produced working new-form DQL'],
        ['· clean', t.clean, pct(t.clean), '≥1 transform, no caveats'],
        ['· soft', t.soft, pct(t.soft), 'working, but has a verify-me warning'],
        ['blocked', t.blocked, pct(t.blocked), 'no new equivalent / needs manual work'],
        ['no-op', t.noop, pct(t.noop), 'already new-form or nothing AWS to change'],
      ]
    )
  );
  md.push('');
  const topTransforms = Object.entries(acc.summary.transformKindCounts).sort((a, b) => b[1] - a[1]);
  if (topTransforms.length) {
    md.push('## Transform kinds');
    md.push('');
    md.push(mdTable(['kind', 'count'], topTransforms.map(([k, n]) => [k, n])));
    md.push('');
  }
  const topWarnings = Object.entries(acc.summary.warningKindCounts).sort((a, b) => b[1] - a[1]);
  if (topWarnings.length) {
    md.push('## Warning kinds');
    md.push('');
    md.push(mdTable(['kind', 'count'], topWarnings.map(([k, n]) => [k, n])));
    md.push('');
    md.push('### One example per warning kind');
    md.push('');
    for (const ex of acc.summary.warningExamples) {
      md.push(`- **${ex.kind}** (${ex.file} @ ${ex.location}): ${ex.text}`);
    }
    md.push('');
  }
  if (acc.summary.rewriteErrorExamples.length) {
    md.push('## Rewriter errors (isolated)');
    md.push('');
    for (const ex of acc.summary.rewriteErrorExamples) {
      md.push(`- **${ex.error}** (${ex.file} @ ${ex.location}): \`${ex.querySnippet.replace(/\n/g, ' ')}\``);
    }
    md.push('');
  }
  await writeFile(join(scanDir, 'summary.md'), md.join('\n') + '\n');

  console.log(
    `${opts.assetType}: ${t.awsAssets}/${t.files} AWS assets, ${t.queries} queries — ` +
      `converted ${acc.summary.converted} (${pct(acc.summary.converted)}), blocked ${t.blocked}, no-op ${t.noop}.`
  );
  console.log(`Wrote ${join(scanDir, 'summary.json')} / results.jsonl / summary.md`);
  return acc.summary;
}
