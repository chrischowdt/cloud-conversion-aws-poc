/**
 * dql — run a raw DQL query against a tenant. Useful during iteration to
 * sanity-check syntax / explore what's on the tenant before wiring it into
 * a higher-level command.
 *
 * Usage:
 *   cct dql --query "fetch metric.series | filter ..."
 *   cct dql --file path/to/query.dql
 *
 * Output:
 *   - prints record count + first N records to stdout
 *   - writes the full result to tools/out/dql_<timestamp>.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient } from '../dynatrace/dql.ts';
import { OUT_DIR } from '../lib/paths.ts';

export interface DqlArgs {
  baseUrl: string;
  token: string;
  query?: string;
  file?: string;
  from?: string;
  to?: string;
  /** How many records to print to stdout. Default 10. */
  preview?: number;
  outDir?: string;
}

export async function runDql(args: DqlArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });

  let query: string | undefined = args.query;
  if (!query && args.file) {
    query = await readFile(args.file, 'utf8');
  }
  if (!query || query.trim().length === 0) {
    throw new Error('Provide --query "..." or --file <path>.');
  }

  const client = new DqlClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} (waiting ${info.delayMs.toFixed(0)}ms)`),
  });

  console.log(`Running DQL (${query.length} chars)…`);
  const t0 = Date.now();
  const result = await client.query({
    query,
    defaultTimeframeStart: args.from,
    defaultTimeframeEnd: args.to,
    maxResultRecords: 10_000,
    fetchTimeoutSeconds: 90,
  });
  const elapsed = Date.now() - t0;

  const filename = `dql_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outPath = join(outDir, filename);
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        elapsedMs: elapsed,
        baseUrl: args.baseUrl,
        query,
        timeframe: { from: args.from ?? null, to: args.to ?? null },
        recordCount: result.records.length,
        scannedBytes: result.metadata?.scannedBytes,
        notifications: result.metadata?.notifications,
        records: result.records,
      },
      null,
      2
    )
  );

  console.log('');
  console.log(`${result.records.length} records, ${elapsed}ms` +
    (result.metadata?.scannedBytes ? `, scanned ${result.metadata.scannedBytes} B` : ''));
  console.log(`Wrote ${outPath}`);

  const preview = args.preview ?? 10;
  if (preview > 0 && result.records.length > 0) {
    console.log('');
    console.log(`Preview (first ${Math.min(preview, result.records.length)}):`);
    console.log(JSON.stringify(result.records.slice(0, preview), null, 2));
  }
}
