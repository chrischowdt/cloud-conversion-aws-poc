/**
 * stage-detectors — generate REVIEW NOTEBOOKS for AWS Davis anomaly detectors.
 *
 * The alert analogue of `migrate-stage`, but it never publishes a second armed
 * detector (that would double-alert). Instead it rewrites each AWS detector and
 * lays the translated queries into notebooks (batches of N), one markdown +
 * one DQL tile per detector, for query-only human review. A notebook is inert:
 * reviewers run/fix the DQL live with zero alerting risk. `migrate-promote-
 * detectors` later reads the fixed queries back and applies them in place.
 *
 * Default PREPARE mode: writes each notebook `content` + a manifest under
 * migration/detector-review/ for inspection — no tenant writes. `--apply`
 * creates the notebooks (type notebook) and shares them with the review group.
 *
 * Scope: AWS detectors whose rewrite bucket is in --buckets (default
 * clean,soft — the actionable ones; blocked detectors need metric-mapping work,
 * not query editing). Filter further with --ids / --limit; batch with --batch-size.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REPO_ROOT, SKILL_DAC_AWS_METRICS, SKILL_MANUAL_AWS_METRICS, SKILL_PER_KEY_AWS_METRICS } from '../lib/paths.ts';
import { liveMetricsPathIfPresent } from '../lib/live-metrics.ts';
import { mzTagsPathIfPresent } from '../lib/mz-tags.ts';
import { loadRecipeIndex } from '../lib/recipe-lookup.ts';
import { isBlockingWarning } from '../lib/dql-rewriter.ts';
import { rewriteDetector, detectorQuery } from '../lib/detector-rewrite.ts';
import {
  buildDetectorNotebook,
  chunk,
  type DetectorReviewItem,
  type ReviewBucket,
} from '../lib/detector-notebook.ts';
import { DocumentClient, DocumentApiError } from '../dynatrace/document.ts';
import type { SettingsObject } from '../dynatrace/settings.ts';

export interface StageDetectorsArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  inputFile?: string;
  apply?: boolean;
  shareGroupId?: string;
  /** Create the notebook(s) but skip sharing — for a private validation run. */
  noShare?: boolean;
  batchSize?: number;
  buckets?: ReviewBucket[];
  ids?: string[];
  limit?: number;
  mappingPath?: string;
  liveMetricsPath?: string;
  minOverrideSeries?: number;
}

interface ManifestEntry {
  batch: string;
  notebookId?: string;
  notebookUrl?: string;
  detectors: Array<{ objectId: string; sectionId: string; title: string; bucket: ReviewBucket }>;
}

const notebookUiUrl = (baseUrl: string, id: string) =>
  `${baseUrl.replace(/\/+$/, '')}/ui/apps/dynatrace.notebooks/notebook/${id}`;

function bucketOf(warnings: { kind: any }[]): ReviewBucket {
  if (warnings.some((w) => isBlockingWarning(w.kind))) return 'blocked';
  return warnings.length ? 'soft' : 'clean';
}

export async function runStageDetectors(args: StageDetectorsArgs): Promise<void> {
  const base = args.outDir;
  const inputFile = args.inputFile ?? join(base, 'anomaly-detectors', 'objects.json');
  const reviewDir = join(base, 'migration', 'detector-review');
  await mkdir(reviewDir, { recursive: true });

  const batchSize = args.batchSize ?? 10;
  const wantBuckets = new Set<ReviewBucket>(args.buckets ?? ['clean', 'soft']);
  const idFilter = args.ids && args.ids.length ? new Set(args.ids) : null;

  const mappingPath = args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.with_recipes.json');
  const liveMetricsPath = args.liveMetricsPath ?? liveMetricsPathIfPresent(base);
  const index = await loadRecipeIndex(mappingPath, {
    dacPath: SKILL_DAC_AWS_METRICS,
    manualPath: SKILL_MANUAL_AWS_METRICS,
    perKeyPath: SKILL_PER_KEY_AWS_METRICS,
    liveMetricsPath,
    mzTagsPath: mzTagsPathIfPresent(base),
    minOverrideSeries: args.minOverrideSeries,
  });

  let file: { objects?: SettingsObject[] };
  try {
    file = JSON.parse(await readFile(inputFile, 'utf8'));
  } catch (e) {
    throw new Error(
      `stage-detectors: cannot read ${inputFile} — run \`cct download-anomaly-detectors\` first. (${(e as Error).message})`
    );
  }
  const objects = file.objects ?? [];

  // Rewrite every AWS detector; keep the ones in the wanted buckets.
  const items: DetectorReviewItem[] = [];
  for (const o of objects) {
    const q = detectorQuery(o.value);
    if (!q || !/cloud\.aws\./.test(q)) continue;
    if (idFilter && !idFilter.has(o.objectId)) continue;
    const r = rewriteDetector(o.value, index);
    if (!r.query) continue;
    const bucket = bucketOf(r.warnings);
    if (!wantBuckets.has(bucket)) continue;
    items.push({
      objectId: o.objectId,
      title: (o.value?.title as string) ?? o.summary ?? o.objectId,
      original: r.query.original,
      rewritten: r.query.rewritten,
      nodeType: r.nodeType,
      targetDim: r.targetDim,
      thresholdAction: r.thresholdAction,
      eventTemplateChanges: r.eventTemplateChanges,
      warnings: r.warnings,
      bucket,
    });
  }

  if (items.length === 0) {
    console.log(`No AWS detectors matched buckets [${[...wantBuckets].join(', ')}]${idFilter ? ' + id filter' : ''}.`);
    return;
  }
  const scoped = args.limit ? items.slice(0, args.limit) : items;
  const batches = chunk(scoped, batchSize);
  console.log(
    `${args.apply ? 'Staging' : 'Preparing'} ${scoped.length} AWS detector(s) into ${batches.length} review notebook(s) ` +
      `(batch size ${batchSize}, buckets [${[...wantBuckets].join(', ')}])…`
  );

  const client = args.apply ? new DocumentClient({ baseUrl: args.baseUrl, token: args.token }) : null;
  const manifest: ManifestEntry[] = [];
  const total = batches.length;
  let created = 0;

  for (let i = 0; i < batches.length; i++) {
    const label = `batch-${String(i + 1).padStart(2, '0')}`;
    const batch = batches[i]!;
    const content = buildDetectorNotebook(`${label} of ${total}`, batch);
    const name = `[MIGRATION REVIEW] AWS alerts — ${label} of ${total}`;
    const entry: ManifestEntry = {
      batch: label,
      detectors: batch.map((it) => ({ objectId: it.objectId, sectionId: `dql-${it.objectId}`, title: it.title, bucket: it.bucket })),
    };

    if (!args.apply) {
      await writeFile(join(reviewDir, `${label}.json`), JSON.stringify({ name, type: 'notebook', content }, null, 2));
      manifest.push(entry);
      continue;
    }

    try {
      const doc = await client!.createDocument({ name, type: 'notebook', content, isPrivate: args.noShare === true });
      if (!args.noShare) {
        try {
          if (args.shareGroupId) await client!.shareWithGroup(doc.id, args.shareGroupId, 'read-write');
          else await client!.shareEnvironment(doc.id, 'read-write');
        } catch (se) {
          console.log(`    (couldn't share ${doc.id}: ${(se as Error).message.slice(0, 80)} — share manually)`);
        }
      }
      entry.notebookId = doc.id;
      entry.notebookUrl = notebookUiUrl(args.baseUrl, doc.id);
      manifest.push(entry);
      created++;
      console.log(`  ✓ ${label}: notebook ${doc.id} (${batch.length} detectors)`);
    } catch (e) {
      const msg = e instanceof DocumentApiError ? `HTTP ${e.status}: ${e.body.slice(0, 120)}` : (e as Error).message;
      console.log(`  ! ${label} — create failed: ${msg}`);
    }
  }

  await writeFile(join(reviewDir, 'manifest.json'), JSON.stringify({ generated: new Date().toISOString(), batches: manifest }, null, 2));

  console.log('');
  if (args.apply) {
    const shareNote = args.noShare
      ? 'PRIVATE (not shared — validation run)'
      : args.shareGroupId
      ? `shared read-write with group ${args.shareGroupId}`
      : 'env-shared read-write';
    console.log(`Created ${created}/${total} review notebook(s) (${shareNote}). Manifest: ${join(reviewDir, 'manifest.json')}`);
    console.log('Reviewers open the notebooks, run/fix each DQL tile, save. Then `cct migrate-pull-detectors` + `cct migrate-promote-detectors`.');
  } else {
    console.log(`Prepared ${batches.length} notebook payload(s) in ${reviewDir}; no writes made. Inspect them, then re-run with --apply.`);
  }
}
