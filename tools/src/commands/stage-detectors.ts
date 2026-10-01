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
import { enrichedTagsPathIfPresent } from '../lib/enriched-tags.ts';
import { entityCandidatesPathIfPresent } from '../lib/entity-candidates.ts';
import { loadRecipeIndex } from '../lib/recipe-lookup.ts';
import { isBlockingWarning } from '../lib/dql-rewriter.ts';
import { lintAsset } from '../lib/output-lint.ts';
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
  /**
   * Re-render the notebooks already published (from the manifest) IN PLACE
   * instead of creating new ones — the way to push improved conversions to a
   * review notebook without changing its id, url, or shares. Keeps the SAME
   * detector-to-batch assignment so reviewers don't lose their place.
   */
  restage?: boolean;
  /** Batch by the team prefix in each detector title instead of arbitrary runs of N. */
  groupByTeam?: boolean;
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
    enrichedTagsPath: enrichedTagsPathIfPresent(base),
    entityCandidatesPath: entityCandidatesPathIfPresent(base),
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

  // Detectors already sitting in a published review notebook. Without this a
  // plain run re-stages the same first N into a second notebook, giving the
  // same detector two verdict cards in two places. `--ids` and `--restage` are
  // explicit about what they want, so they opt out.
  const alreadyStaged = new Set<string>();
  if (!idFilter && !args.restage) {
    try {
      const prior = (JSON.parse(await readFile(join(reviewDir, 'manifest.json'), 'utf8')) as {
        batches?: ManifestEntry[];
      }).batches ?? [];
      for (const b of prior) {
        if (!b.notebookId) continue;
        for (const d of b.detectors ?? []) alreadyStaged.add(d.objectId);
      }
    } catch {
      /* first run */
    }
  }

  // Rewrite every AWS detector; keep the ones in the wanted buckets.
  const items: DetectorReviewItem[] = [];
  let skippedStaged = 0;
  for (const o of objects) {
    const q = detectorQuery(o.value);
    if (!q || !/cloud\.aws\./.test(q)) continue;
    if (idFilter && !idFilter.has(o.objectId)) continue;
    if (alreadyStaged.has(o.objectId)) { skippedStaged++; continue; }
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
      lint: lintAsset({ query: r.query.rewritten })
        .filter((f) => f.severity === 'blocking')
        .map((f) => ({ ruleId: f.ruleId, message: f.message, fix: f.fix })),
    });
  }

  if (items.length === 0) {
    console.log(`No AWS detectors matched buckets [${[...wantBuckets].join(', ')}]${idFilter ? ' + id filter' : ''}.`);
    return;
  }

  // --restage: rebuild exactly the batches already published, from the manifest,
  // so a notebook keeps its id/url/shares and its reviewers keep their place.
  if (args.restage) {
    const prior = JSON.parse(await readFile(join(reviewDir, 'manifest.json'), 'utf8')) as {
      batches?: ManifestEntry[];
    };
    const published = (prior.batches ?? []).filter((b) => b.notebookId);
    if (!published.length) throw new Error('stage-detectors --restage: no published notebooks in the manifest.');
    const byId = new Map(items.map((it) => [it.objectId, it]));
    const client2 = new DocumentClient({ baseUrl: args.baseUrl, token: args.token });
    let updated = 0;
    for (const b of published) {
      const batch = b.detectors.map((d) => byId.get(d.objectId)).filter((x): x is DetectorReviewItem => !!x);
      if (!batch.length) {
        console.log(`  - ${b.batch}: no detectors resolve (bucket filter?) — skipped`);
        continue;
      }
      const content = buildDetectorNotebook(`${b.batch} of ${published.length}`, batch);
      const name = `[MIGRATION REVIEW] AWS alerts — ${b.batch} of ${published.length}`;
      if (!args.apply) {
        await writeFile(join(reviewDir, `${b.batch}.json`), JSON.stringify({ name, type: 'notebook', content }, null, 2));
        console.log(`  · ${b.batch}: prepared refresh for notebook ${b.notebookId} (${batch.length} detectors)`);
        continue;
      }
      try {
        const live = await client2.getDocumentFull(b.notebookId!, true);
        await client2.updateContent(b.notebookId!, {
          name,
          type: 'notebook',
          content,
          version: live.metadata.version,
          adminAccess: true,
        });
        updated++;
        console.log(`  ✓ ${b.batch}: refreshed notebook ${b.notebookId} in place (${batch.length} detectors)`);
      } catch (e) {
        const msg = e instanceof DocumentApiError ? `HTTP ${e.status}: ${e.body.slice(0, 120)}` : (e as Error).message;
        console.log(`  ! ${b.batch}: refresh failed — ${msg}`);
      }
    }
    console.log(
      args.apply
        ? `\nRefreshed ${updated}/${published.length} notebook(s) in place — same ids, urls and shares.`
        : `\nPrepared refreshes in ${reviewDir}; no writes made. Re-run with --apply.`
    );
    return;
  }

  const scoped = args.limit ? items.slice(0, args.limit) : items;

  // Group by the team prefix detector titles already carry ("CWE - Lambda
  // Timeout is High"). 629 of the 807 AWS detectors have one, so this makes each
  // notebook belong to a single team — reviewable by the people who own those
  // alerts, and assignable without anyone first working out who owns what.
  // Untagged detectors collect into MISC. Batch size still caps each notebook.
  const batches: DetectorReviewItem[][] = [];
  const labels: string[] = [];
  if (args.groupByTeam) {
    const groups = new Map<string, DetectorReviewItem[]>();
    for (const it of scoped) {
      const m = /^([A-Z][A-Z0-9]{1,5})\b/.exec(it.title.trim());
      const key = m ? m[1]! : 'MISC';
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
    }
    // Pack WHOLE teams into notebooks up to batchSize rather than giving every
    // team its own: 67 prefixes, most with only a handful of detectors, would
    // mean ~70 near-empty notebooks. A team bigger than a batch is split across
    // sequential notebooks; smaller teams share one but stay contiguous, so a
    // notebook is still assignable to a small set of owners.
    const ordered = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    let cur: DetectorReviewItem[] = [];
    let curTeams: string[] = [];
    const flush = () => {
      if (!cur.length) return;
      batches.push(cur);
      labels.push(curTeams.length <= 3 ? curTeams.join(' + ') : `${curTeams.slice(0, 3).join(' + ')} +${curTeams.length - 3} more`);
      cur = []; curTeams = [];
    };
    for (const [team, list] of ordered) {
      if (list.length >= batchSize) {
        flush();
        const parts = chunk(list, batchSize);
        parts.forEach((p, i) => {
          batches.push(p);
          labels.push(parts.length > 1 ? `${team} ${i + 1} of ${parts.length}` : team);
        });
        continue;
      }
      if (cur.length + list.length > batchSize) flush();
      cur.push(...list);
      curTeams.push(team);
    }
    flush();
  } else {
    // Continue numbering from the batches already published. Restarting at 01
    // every run collides with a live notebook: the label names the prepared
    // file AND the notebook, so a second run silently overwrote batch-01's
    // payload and added a duplicate manifest entry.
    let nextBatch = 1;
    try {
      const prior = (JSON.parse(await readFile(join(reviewDir, 'manifest.json'), 'utf8')) as {
        batches?: ManifestEntry[];
      }).batches ?? [];
      for (const b of prior) {
        const m = /^batch-(\d+)$/.exec(String(b.batch ?? ''));
        if (m) nextBatch = Math.max(nextBatch, Number(m[1]) + 1);
      }
    } catch {
      /* first run */
    }
    for (const [i, c] of chunk(scoped, batchSize).entries()) {
      batches.push(c);
      labels.push(`batch-${String(nextBatch + i).padStart(2, '0')}`);
    }
  }
  console.log(
    `${args.apply ? 'Staging' : 'Preparing'} ${scoped.length} AWS detector(s) into ${batches.length} review notebook(s) ` +
      `(batch size ${batchSize}, buckets [${[...wantBuckets].join(', ')}])…` +
      (skippedStaged ? ` — skipped ${skippedStaged} already in a published batch` : '')
  );

  const client = args.apply ? new DocumentClient({ baseUrl: args.baseUrl, token: args.token }) : null;
  const manifest: ManifestEntry[] = [];
  const total = batches.length;
  let created = 0;

  for (let i = 0; i < batches.length; i++) {
    const label = labels[i]!;
    const batch = batches[i]!;
    const content = buildDetectorNotebook(label, batch);
    const name = `[MIGRATION REVIEW] AWS alerts — ${label}`;
    const entry: ManifestEntry = {
      batch: label,
      detectors: batch.map((it) => ({ objectId: it.objectId, sectionId: `dql-${it.objectId}`, title: it.title, bucket: it.bucket })),
    };

    if (!args.apply) {
      const fileLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await writeFile(join(reviewDir, `${fileLabel}.json`), JSON.stringify({ name, type: 'notebook', content }, null, 2));
      // Deliberately NOT added to the manifest: a prepare run publishes nothing,
      // and an id-less entry both pollutes the record of live notebooks and
      // pushes the next run's batch numbering past a batch that never existed.
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

  // MERGE, don't clobber. Each run publishes its own notebooks, but the manifest
  // is the only record of every notebook we've created — `--restage` iterates it
  // to push improved conversions into notebooks reviewers already have open. A
  // wholesale overwrite would orphan every previously published notebook. Keyed
  // by notebookId (batch labels repeat across runs); prepare-mode entries have
  // no id and are not persisted over prior ones.
  const manifestPath = join(reviewDir, 'manifest.json');
  let priorBatches: ManifestEntry[] = [];
  try {
    priorBatches = (JSON.parse(await readFile(manifestPath, 'utf8')) as { batches?: ManifestEntry[] }).batches ?? [];
  } catch {
    /* first run */
  }
  const freshIds = new Set(manifest.map((m) => m.notebookId).filter(Boolean));
  const merged = [...priorBatches.filter((b) => b.notebookId && !freshIds.has(b.notebookId)), ...manifest];
  await writeFile(manifestPath, JSON.stringify({ generated: new Date().toISOString(), batches: merged }, null, 2));

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
