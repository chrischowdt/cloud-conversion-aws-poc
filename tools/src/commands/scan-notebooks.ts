/**
 * scan-notebooks — run the DQL rewriter against every downloaded notebook,
 * filtered to those that reference AWS. Emits the shared coverage report.
 *
 * Notebook DQL lives in `content.sections[].state.input.value` (sections of
 * type "dql"). Extraction lives in lib/asset-extractors.ts.
 *
 * Outputs (under the tenant dir):
 *   notebook-scan/summary.json | results.jsonl | summary.md
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  OUT_DIR,
  REPO_ROOT,
  SKILL_DAC_AWS_METRICS,
  SKILL_MANUAL_AWS_METRICS,
  SKILL_PER_KEY_AWS_METRICS,
} from '../lib/paths.ts';
import { liveMetricsPathIfPresent } from '../lib/live-metrics.ts';
import { enrichedTagsPathIfPresent } from '../lib/enriched-tags.ts';
import { mzTagsPathIfPresent } from '../lib/mz-tags.ts';
import { loadRecipeIndex } from '../lib/recipe-lookup.ts';
import { runAssetScan, type ScanInputAsset } from '../lib/asset-scan-run.ts';
import { extractNotebookQueries } from '../lib/asset-extractors.ts';

export interface ScanNotebooksArgs {
  inputDir?: string;
  outDir?: string;
  mappingPath?: string;
  limit?: number;
  all?: boolean;
  liveMetricsPath?: string;
  minOverrideSeries?: number;
}

export async function runScanNotebooks(args: ScanNotebooksArgs): Promise<void> {
  const base = args.outDir ?? (args.inputDir ? resolve(args.inputDir, '..') : OUT_DIR);
  const inputDir = args.inputDir ?? join(base, 'notebooks');

  const mappingPath = args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.with_recipes.json');
  const liveMetricsPath = args.liveMetricsPath ?? liveMetricsPathIfPresent(base);
  const index = await loadRecipeIndex(mappingPath, {
    dacPath: SKILL_DAC_AWS_METRICS,
    manualPath: SKILL_MANUAL_AWS_METRICS,
    perKeyPath: SKILL_PER_KEY_AWS_METRICS,
    liveMetricsPath,
    enrichedTagsPath: enrichedTagsPathIfPresent(base),
    mzTagsPath: mzTagsPathIfPresent(base),
    minOverrideSeries: args.minOverrideSeries,
  });

  const files = (await readdir(inputDir)).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
  console.log(`Scanning ${files.length} notebooks in ${inputDir}`);

  const assets: ScanInputAsset[] = [];
  for (const file of files) {
    let parsed: { metadata?: { id?: string; name?: string }; content?: unknown };
    try {
      parsed = JSON.parse(await readFile(join(inputDir, file), 'utf8'));
    } catch {
      continue;
    }
    const content =
      typeof parsed.content === 'string'
        ? (() => {
            try {
              return JSON.parse(parsed.content as string);
            } catch {
              return null;
            }
          })()
        : parsed.content;
    if (!content) continue;
    assets.push({
      id: parsed.metadata?.id ?? file,
      name: parsed.metadata?.name ?? '(unnamed)',
      file,
      queries: extractNotebookQueries(content),
    });
  }

  await runAssetScan({
    assetType: 'notebooks',
    outSubdir: 'notebook-scan',
    tenantDir: base,
    index,
    assets,
    all: args.all,
    limit: args.limit,
  });
}
