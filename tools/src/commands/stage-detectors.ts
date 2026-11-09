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
import { entityArnsPathIfPresent } from '../lib/entity-arns.ts';
import { entityCandidatesPathIfPresent } from '../lib/entity-candidates.ts';
import { loadRecipeIndex } from '../lib/recipe-lookup.ts';
import { isBlockingWarning } from '../lib/dql-rewriter.ts';
import { lintAsset } from '../lib/output-lint.ts';
import { rewriteDetector, detectorQuery, type DetectorRewriteResult } from '../lib/detector-rewrite.ts';
import { applySourceBinding, DAVIS_SERIES_CAP, resolveBinding } from '../lib/detector-binding.ts';
import { planRestage } from '../lib/detector-restage.ts';
import { DqlClient } from '../dynatrace/dql.ts';
import {
  buildDetectorNotebook,
  chunk,
  type DetectorReviewItem,
  type ReviewBucket,
} from '../lib/detector-notebook.ts';
import { DocumentClient, DocumentApiError } from '../dynatrace/document.ts';
import { ALERTS_SHEET, readRows, upsertRows, type TrackerRow } from '../lib/tracker-xlsx.ts';
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
   * Push improved conversions into notebooks already published (from the
   * manifest), IN PLACE: same id, url, shares and detector-to-batch assignment.
   * Card by card: only a card nobody has touched is replaced (see restageCards).
   */
  restage?: boolean;
  /** With --restage: only these batches (e.g. batch-14,batch-15). Default: every published batch. */
  batches?: string[];
  /** Batch by the team prefix in each detector title instead of arbitrary runs of N. */
  groupByTeam?: boolean;
  batchSize?: number;
  buckets?: ReviewBucket[];
  ids?: string[];
  limit?: number;
  /**
   * The alert tracker. This is the RECORD of which detectors are already in a
   * review notebook — the manifest is only a fallback for when the file is
   * absent or a reviewer has it open (xlsx locks on write). Read and written on
   * the `alerts` SHEET of the team workbook; dashboards/notebooks keep
   * `migration`. Defaults to <tenant>/migration-tracker.xlsx — point --tracker
   * (or DT_TRACKER_PATH) at the shared copy.
   */
  trackerPath?: string;
  /** Record already-published detectors in the tracker and stop; stage nothing. */
  recordOnly?: boolean;
  mappingPath?: string;
  liveMetricsPath?: string;
  minOverrideSeries?: number;
  /** Add the series' own entity to unbound alerts after a grain check on the tenant. Default on. */
  bindEntities?: boolean;
}

interface ManifestEntry {
  batch: string;
  notebookId?: string;
  notebookUrl?: string;
  detectors: Array<{ objectId: string; sectionId: string; title: string; bucket: ReviewBucket }>;
}

/**
 * What to do once the review notebooks are out: review, then publish one batch
 * at a time, starting with a prepare run (no --apply). The approved query is read
 * live from the notebook, so there is no pull step.
 */
export function nextStepHint(batches: string[]): string {
  const first = batches[0] ?? '<batch>';
  return (
    'Reviewers open the notebooks, run/fix each DQL tile, save, and set the decision on the alerts sheet. ' +
    `Then publish one batch at a time, starting with a prepare run: \`cct migrate-promote-detectors --batches ${first}\`` +
    (batches.length > 1 ? ` (this run staged ${batches.join(', ')}).` : '.')
  );
}

const notebookUiUrl = (baseUrl: string, id: string) =>
  `${baseUrl.replace(/\/+$/, '')}/ui/apps/dynatrace.notebooks/notebook/${id}`;

function bucketOf(warnings: { kind: any }[]): ReviewBucket {
  if (warnings.some((w) => isBlockingWarning(w.kind))) return 'blocked';
  return warnings.length ? 'soft' : 'clean';
}

/** Days of data the binding check compares over (sparse alert metrics need more than the alert's window). */
const BINDING_CHECK_DAYS = 7;

async function bindEntities(
  scoped: DetectorReviewItem[],
  rewrites: Map<string, DetectorRewriteResult>,
  args: StageDetectorsArgs,
): Promise<void> {
  const dql = new DqlClient({ baseUrl: args.baseUrl, token: args.token });
  const end = new Date();
  const start = new Date(end.getTime() - BINDING_CHECK_DAYS * 864e5);
  const count = async (q: string): Promise<number> => {
    const r = await dql.query({
      query: q,
      defaultTimeframeStart: start.toISOString(),
      defaultTimeframeEnd: end.toISOString(),
      // One past the cap is enough to know a split is too big for Davis.
      maxResultRecords: DAVIS_SERIES_CAP + 1,
      fetchTimeoutSeconds: 120,
    });
    return (r.records ?? []).length;
  };
  const tally: Record<string, number> = {};
  const queue = [...scoped];
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      const r = rewrites.get(it.objectId);
      if (!r?.query) continue;
      const out = await resolveBinding(r.query.rewritten, count, `the last ${BINDING_CHECK_DAYS} days`);
      tally[out.kind] = (tally[out.kind] ?? 0) + 1;
      if (out.query) {
        applySourceBinding(r, out.query, out.note!);
        it.rewritten = r.query.rewritten;
        it.targetDim = r.targetDim;
        it.eventTemplateChanges = r.eventTemplateChanges;
        it.bindingNote = out.note;
        it.lint = lintAsset({ query: it.rewritten })
          .filter((f) => f.severity === 'blocking')
          .map((f) => ({ ruleId: f.ruleId, message: f.message, fix: f.fix }));
      }
      if (out.warning) {
        it.warnings = [...it.warnings, out.warning];
        it.bucket = bucketOf(it.warnings);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const say = (k: string, label: string) => (tally[k] ? `${tally[k]} ${label}` : '');
  console.log(
    `Entity binding: ${[
      say('already', 'already bound'),
      say('bound', 'bound, grain unchanged'),
      say('per-entity', 'bound per resource (threshold to check)'),
      say('unverified', 'bound without data to check the grain'),
      say('too-many', `left unbound: over ${DAVIS_SERIES_CAP} series`),
      say('skipped', 'not bindable automatically'),
      say('error', 'check failed'),
    ].filter(Boolean).join(', ') || 'nothing to check'}.`,
  );
}

/**
 * --restage: bring today's conversion to published review notebooks, card by
 * card (lib/detector-restage.ts). The base for each batch is the payload the
 * tool last wrote, `<batch>.json`; a batch without one is skipped, since there
 * is then no way to tell an untouched card from an edited one. The tracker is
 * read, not written: placement doesn't change, and a reviewer may have it open.
 */
async function restageCards(
  items: DetectorReviewItem[],
  rewrites: Map<string, DetectorRewriteResult>,
  args: StageDetectorsArgs,
  reviewDir: string,
  trackerPath: string,
): Promise<void> {
  const prior = JSON.parse(await readFile(join(reviewDir, 'manifest.json'), 'utf8')) as { batches?: ManifestEntry[] };
  const wanted = args.batches?.length ? new Set(args.batches) : null;
  const published = (prior.batches ?? []).filter((b) => b.notebookId && (!wanted || wanted.has(b.batch)));
  if (!published.length) throw new Error('stage-detectors --restage: no published notebooks match.');

  // A decision, reviewer or notes on the tracker row means a person has judged
  // the card as it stands. An assignee alone is a plan, not a review.
  const reviewed = new Set<string>();
  try {
    for (const [id, r] of await readRows(trackerPath, ALERTS_SHEET)) {
      if (['decision', 'reviewer', 'notes'].some((k) => String(r[k] ?? '').trim())) reviewed.add(id);
    }
  } catch (e) {
    throw new Error(`stage-detectors --restage: cannot read ${trackerPath} (${(e as Error).message.slice(0, 80)}) — it is how reviewed cards are kept.`);
  }

  const inScope = new Set(published.flatMap((b) => b.detectors.map((d) => d.objectId)));
  const scoped = items.filter((it) => inScope.has(it.objectId));
  if (args.bindEntities !== false) await bindEntities(scoped, rewrites, args);
  const byId = new Map(scoped.map((it) => [it.objectId, it]));

  const client = new DocumentClient({ baseUrl: args.baseUrl, token: args.token });
  const totals: Record<string, number> = {};
  for (const b of published) {
    let base: { name: string; type: string; content: { sections: any[] } };
    try {
      base = JSON.parse(await readFile(join(reviewDir, `${b.batch}.json`), 'utf8'));
    } catch {
      console.log(`  - ${b.batch}: no saved payload to compare against — skipped`);
      continue;
    }
    const fresh = new Map<string, any[]>();
    for (const d of b.detectors) {
      const it = byId.get(d.objectId);
      if (it) fresh.set(d.objectId, buildDetectorNotebook(b.batch, [it]).sections.slice(1, 3));
    }
    const live = await client.getDocumentFull(b.notebookId!, true);
    const liveContent = typeof live.content === 'string' ? JSON.parse(live.content) : live.content;
    const { next, nextBase, plans } = planRestage(liveContent, base.content, fresh, b.detectors.map((d) => d.objectId), reviewed);
    const count: Record<string, number> = {};
    for (const p of plans) { count[p.action] = (count[p.action] ?? 0) + 1; totals[p.action] = (totals[p.action] ?? 0) + 1; }
    const summary = Object.entries(count).map(([k, n]) => `${n} ${k}`).join(', ');
    const restaged = plans.filter((p) => p.action === 'restage').map((p) => p.objectId);
    if (!restaged.length) { console.log(`  = ${b.batch}: nothing to restage (${summary})`); continue; }
    if (!args.apply) {
      await writeFile(join(reviewDir, `${b.batch}.restage.json`), JSON.stringify({ name: live.metadata.name, type: 'notebook', content: next }, null, 2));
      console.log(`  · ${b.batch}: would restage ${restaged.length} card(s) in ${b.notebookId} v${live.metadata.version} (${summary})`);
      continue;
    }
    try {
      await mkdir(join(reviewDir, 'pre-restage'), { recursive: true });
      await writeFile(join(reviewDir, 'pre-restage', `${b.notebookId}.v${live.metadata.version}.json`), JSON.stringify(live, null, 2));
      await client.updateContent(b.notebookId!, { name: live.metadata.name, type: 'notebook', content: next, version: live.metadata.version, adminAccess: true });
      // Prove it: every section outside the restaged cards is byte-identical.
      const back = await client.getDocumentFull(b.notebookId!, true);
      const bc = typeof back.content === 'string' ? JSON.parse(back.content) : back.content;
      const touchedIds = new Set(restaged.flatMap((id) => [`md-${id}`, `dql-${id}`]));
      const othersSame = liveContent.sections.every((s: any) => touchedIds.has(s.id) || JSON.stringify(bc.sections.find((x: any) => x.id === s.id)) === JSON.stringify(s));
      const written = next.sections.every((s: any) => !touchedIds.has(s.id) || JSON.stringify(bc.sections.find((x: any) => x.id === s.id)) === JSON.stringify(s));
      await writeFile(join(reviewDir, `${b.batch}.json`), JSON.stringify({ ...base, content: nextBase }, null, 2));
      console.log(
        `  ✓ ${b.batch}: restaged ${restaged.length} card(s), v${live.metadata.version} → v${back.metadata.version} (${summary}); ` +
          `written: ${written}; every other section identical: ${othersSame && bc.sections.length === liveContent.sections.length}`
      );
    } catch (e) {
      const msg = e instanceof DocumentApiError ? `HTTP ${e.status}: ${e.body.slice(0, 120)}` : (e as Error).message;
      console.log(`  ! ${b.batch}: restage failed — ${msg}`);
    }
  }
  console.log(
    `\n${args.apply ? 'Restaged' : 'Would restage'} ${totals.restage ?? 0} card(s) across ${published.length} notebook(s); ` +
      `kept ${(totals.edited ?? 0) + (totals.reviewed ?? 0)} a reviewer touched, ${totals.current ?? 0} already current, ` +
      `${(totals.missing ?? 0) + (totals.unresolved ?? 0)} not comparable.` +
      (args.apply ? '' : ` Proposed notebooks: ${reviewDir}/<batch>.restage.json; no writes made. Re-run with --apply.`)
  );
}

export async function runStageDetectors(args: StageDetectorsArgs): Promise<void> {
  const base = args.outDir;
  const inputFile = args.inputFile ?? join(base, 'anomaly-detectors', 'objects.json');
  const reviewDir = join(base, 'migration', 'detector-review');
  const trackerPath = args.trackerPath ?? join(base, 'migration-tracker.xlsx');
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
    entityArnsPath: entityArnsPathIfPresent(base),
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
  // What is already in a reviewer's notebook. The TRACKER is the record — but
  // it is an xlsx a human can have open, so a publish can succeed while the
  // write-back fails. The manifest covers that gap, and anything it knows that
  // the tracker does not is queued as a backfill, which makes the sheet
  // self-healing rather than something we have to remember to repair.
  const alreadyStaged = new Set<string>();
  const backfill: TrackerRow[] = [];
  if (!idFilter && !args.restage) {
    const tracked = new Set<string>();
    try {
      for (const [id, r] of await readRows(trackerPath, ALERTS_SHEET)) {
        if (String(r['asset_type'] ?? '') !== 'anomaly-detector') continue;
        if (String(r['review_copy_url'] ?? '').trim()) tracked.add(id);
      }
    } catch {
      /* no tracker yet, or a reviewer has it open */
    }
    for (const id of tracked) alreadyStaged.add(id);

    try {
      const prior = (JSON.parse(await readFile(join(reviewDir, 'manifest.json'), 'utf8')) as {
        batches?: ManifestEntry[];
      }).batches ?? [];
      for (const b of prior) {
        if (!b.notebookId) continue;
        for (const d of b.detectors ?? []) {
          alreadyStaged.add(d.objectId);
          if (tracked.has(d.objectId)) continue;
          backfill.push({
            asset_id: d.objectId,
            asset_type: 'anomaly-detector',
            name: d.title,
            status: 'staged',
            review_copy_id: b.notebookId,
            review_copy_url: b.notebookUrl ?? notebookUiUrl(args.baseUrl, b.notebookId),
            reasons: `review batch ${b.batch}`,
            review_batch: b.batch,
          });
        }
      }
    } catch {
      /* first run */
    }
  }

  // Rewrite every AWS detector; keep the ones in the wanted buckets.
  const items: DetectorReviewItem[] = [];
  const rewrites = new Map<string, DetectorRewriteResult>();
  let skippedStaged = 0;
  let unreadable = 0;
  for (const o of objects) {
    const q = detectorQuery(o.value);
    if (!q) {
      // No recognised query input. If the detector still MENTIONS cloud.aws
      // anywhere, it is an AWS detector we cannot read — say so, instead of
      // dropping it the way the query.expression variant was dropped for months.
      if (JSON.stringify((o.value?.analyzer as { input?: unknown } | undefined)?.input ?? []).includes('cloud.aws.')) unreadable++;
      continue;
    }
    if (!/cloud\.aws\./.test(q)) continue;
    if (idFilter && !idFilter.has(o.objectId)) continue;
    if (alreadyStaged.has(o.objectId)) { skippedStaged++; continue; }
    const r = rewriteDetector(o.value, index);
    if (!r.query) continue;
    const bucket = bucketOf(r.warnings);
    if (!wantBuckets.has(bucket)) continue;
    rewrites.set(o.objectId, r);
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

  // Record what is already published into the tracker and stop. The way to
  // repair the sheet after a publish that could not write it, without
  // re-rendering notebook content and discarding reviewers' in-place fixes.
  if (args.recordOnly) {
    if (backfill.length === 0) {
      console.log(`Tracker ${trackerPath} already records every published detector (${alreadyStaged.size}).`);
      return;
    }
    if (!args.apply) {
      console.log(`Would record ${backfill.length} published detector(s) in ${trackerPath}. No writes made; re-run with --apply.`);
      return;
    }
    const { added, updated } = await upsertRows(trackerPath, backfill, ALERTS_SHEET);
    console.log(`Recorded ${backfill.length} published detector(s) in ${trackerPath} (${added} added, ${updated} updated).`);
    return;
  }

  if (items.length === 0) {
    console.log(`No AWS detectors matched buckets [${[...wantBuckets].join(', ')}]${idFilter ? ' + id filter' : ''}.`);
    return;
  }

  if (args.restage) {
    await restageCards(items, rewrites, args, reviewDir, trackerPath);
    return;
  }

  const scoped = args.limit ? items.slice(0, args.limit) : items;

  // Attach each alert to its entity where the classic query never named one
  // (lib/detector-binding.ts). Only for what is being staged: it runs each
  // candidate on the tenant, read-only, in prepare mode too.
  if (args.bindEntities !== false) await bindEntities(scoped, rewrites, args);

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
      (skippedStaged ? ` — skipped ${skippedStaged} already in a published batch` : '') +
      (unreadable ? ` — ${unreadable} AWS detector(s) have no readable query input and were NOT considered` : '')
  );

  const client = args.apply ? new DocumentClient({ baseUrl: args.baseUrl, token: args.token }) : null;
  const manifest: ManifestEntry[] = [];
  const trackerUpdates: TrackerRow[] = [...backfill];
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
      // Record the placement in the tracker, so the next run's scope comes from
      // the sheet the team actually reads rather than a file only we know about.
      for (const it of batch) {
        trackerUpdates.push({
          asset_id: it.objectId,
          asset_type: 'anomaly-detector',
          name: it.title,
          status: 'staged',
          review_copy_id: doc.id,
          review_copy_url: entry.notebookUrl,
          staged_at: new Date().toISOString(),
          reasons: `review batch ${label}`,
          review_batch: label,
        });
      }
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
  if (args.apply && trackerUpdates.length) {
    if (backfill.length) console.log(`  Backfilling ${backfill.length} detector(s) published while the tracker was unwritable.`);
    try {
      const { added, updated } = await upsertRows(trackerPath, trackerUpdates, ALERTS_SHEET);
      console.log(`  Tracker ${trackerPath}: ${added} added, ${updated} updated.`);
    } catch (e) {
      // An xlsx a reviewer has open cannot be written. Say so loudly rather
      // than leaving the sheet quietly out of step with what is published.
      // Don't suggest --restage here: it re-renders notebook CONTENT and would
      // discard a reviewer's in-place fixes just to record a URL.
      console.log(
        `  ! Could not write ${trackerPath}: ${(e as Error).message.slice(0, 120)}\n` +
          `    The notebooks ARE published; only the tracker is behind. Close the file (or pass ` +
          `--tracker <path>) and run \`cct stage-detectors --record-only --apply\` to repair the sheet.`
      );
    }
  }

  // A prepare run publishes nothing, so it must not touch the manifest. It used
  // to rewrite it from an empty set of fresh entries, which wiped the record of
  // every published notebook — and with it the fallback the tracker relies on
  // when a reviewer has the sheet open.
  if (!args.apply) {
    console.log('');
    console.log(`Prepared ${batches.length} notebook payload(s) in ${reviewDir}; no writes made. Inspect them, then re-run with --apply.`);
    return;
  }

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
    console.log(nextStepHint(manifest.map((m) => m.batch)));
  } else {
    console.log(`Prepared ${batches.length} notebook payload(s) in ${reviewDir}; no writes made. Inspect them, then re-run with --apply.`);
  }
}
