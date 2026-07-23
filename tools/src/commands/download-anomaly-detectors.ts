/**
 * download-anomaly-detectors — pull Davis anomaly detectors (Settings 2.0
 * schema `builtin:davis.anomaly-detectors`) from a tenant for offline analysis.
 *
 * Each object's `value.analyzer.input[]` carries the DQL query (the entry with
 * `key == "query"`), which the scanner rewrites. Saved as one array file since
 * settings objects are small and there are ~1k of them.
 *
 * Output:
 *   <tenant>/anomaly-detectors/objects.json
 *     { generated, baseUrl, schemaId, count, objects: SettingsObject[] }
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SettingsApiError, SettingsClient, type SettingsObject } from '../dynatrace/settings.ts';
import { OUT_DIR } from '../lib/paths.ts';

export const DAVIS_ANOMALY_SCHEMA = 'builtin:davis.anomaly-detectors';

export interface DownloadAnomalyDetectorsArgs {
  baseUrl: string;
  token: string;
  outDir?: string;
  /** Override the settings schema id (default: Davis anomaly detectors). */
  schemaId?: string;
}

export async function runDownloadAnomalyDetectors(args: DownloadAnomalyDetectorsArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  const adDir = join(outDir, 'anomaly-detectors');
  await mkdir(adDir, { recursive: true });
  const schemaId = args.schemaId ?? DAVIS_ANOMALY_SCHEMA;

  const client = new SettingsClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} (waiting ${info.delayMs.toFixed(0)}ms)`),
  });

  console.log(`Listing anomaly detectors (Settings 2.0, ${schemaId})...`);
  let objects: SettingsObject[] = [];
  try {
    objects = await client.listAllObjects({
      schemaId,
      pageSize: 500,
      onPage: (got, total) => console.log(`  ${got}/${total ?? '?'}`),
    });
  } catch (e) {
    const err = e instanceof SettingsApiError ? e : null;
    const msg =
      err?.status === 401 || err?.status === 403
        ? `Token rejected by Settings API (HTTP ${err.status}). Needs scope 'settings:objects:read'.`
        : (e as Error).message;
    console.log(`  anomaly detectors: list FAILED — ${msg}`);
    throw e;
  }

  const outPath = join(adDir, 'objects.json');
  await writeFile(
    outPath,
    JSON.stringify(
      { generated: new Date().toISOString(), baseUrl: args.baseUrl, schemaId, count: objects.length, objects },
      null,
      2
    )
  );
  console.log('');
  console.log(`Anomaly detectors: ${objects.length} objects saved.`);
  console.log(`Wrote ${outPath}`);
}
