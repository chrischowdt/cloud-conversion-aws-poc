/**
 * scan-anomaly-detectors — run the DQL rewriter against downloaded Davis
 * anomaly detectors (Settings 2.0 `builtin:davis.anomaly-detectors`), filtered
 * to those that reference AWS. Emits the shared coverage report.
 *
 * DQL lives in `value.analyzer.input[]` under `key == "query"`. Extraction
 * lives in lib/asset-extractors.ts.
 *
 * Outputs (under the tenant dir):
 *   anomaly-detector-scan/summary.json | results.jsonl | summary.md
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  OUT_DIR,
  REPO_ROOT,
  SKILL_DAC_AWS_METRICS,
  SKILL_MANUAL_AWS_METRICS,
  SKILL_PER_KEY_AWS_METRICS,
} from '../lib/paths.ts';
import { liveMetricsPathIfPresent } from '../lib/live-metrics.ts';
import { loadRecipeIndex } from '../lib/recipe-lookup.ts';
import { runAssetScan, type ScanInputAsset } from '../lib/asset-scan-run.ts';
import { extractDetectorQueries } from '../lib/asset-extractors.ts';
import type { SettingsObject } from '../dynatrace/settings.ts';

export interface ScanAnomalyDetectorsArgs {
  inputFile?: string;
  outDir?: string;
  mappingPath?: string;
  limit?: number;
  all?: boolean;
  liveMetricsPath?: string;
  minOverrideSeries?: number;
}

export async function runScanAnomalyDetectors(args: ScanAnomalyDetectorsArgs): Promise<void> {
  const base = args.outDir ?? (args.inputFile ? resolve(args.inputFile, '..', '..') : OUT_DIR);
  const inputFile = args.inputFile ?? join(base, 'anomaly-detectors', 'objects.json');

  const mappingPath = args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.with_recipes.json');
  const liveMetricsPath = args.liveMetricsPath ?? liveMetricsPathIfPresent(base);
  const index = await loadRecipeIndex(mappingPath, {
    dacPath: SKILL_DAC_AWS_METRICS,
    manualPath: SKILL_MANUAL_AWS_METRICS,
    perKeyPath: SKILL_PER_KEY_AWS_METRICS,
    liveMetricsPath,
    minOverrideSeries: args.minOverrideSeries,
  });

  let file: { objects?: SettingsObject[] };
  try {
    file = JSON.parse(await readFile(inputFile, 'utf8'));
  } catch (e) {
    throw new Error(
      `scan-anomaly-detectors: cannot read ${inputFile} — run \`cct download-anomaly-detectors\` first. ` +
        `(${(e as Error).message})`
    );
  }
  const objects = file.objects ?? [];
  console.log(`Scanning ${objects.length} anomaly detectors from ${inputFile}`);

  const assets: ScanInputAsset[] = objects.map((o) => ({
    id: o.objectId,
    name: (o.value?.title as string) ?? o.summary ?? o.objectId,
    file: o.objectId,
    queries: extractDetectorQueries(o.value),
  }));

  await runAssetScan({
    assetType: 'anomaly-detectors',
    outSubdir: 'anomaly-detector-scan',
    tenantDir: base,
    index,
    assets,
    all: args.all,
    limit: args.limit,
  });
}
