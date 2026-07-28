/**
 * migrate-stage — review lane: publish a migrated *copy* of each review-lane
 * asset so a human can review/fix it before any cutover. The original is never
 * touched. Copies are created via the Document API (DocumentClient) with the
 * platform token — no dtctl.
 *
 * Default PREPARE mode (no writes): rewrite the downloaded original and write
 * the create payload to migration/staged/<id>.json for inspection. `--apply`
 * creates the copy (env-visible), records the copy id/url + the original's
 * version (`based_on_version`, for the later drift guard), sets status=staged.
 *
 * Selects tracker rows with lane=review and status=candidate (fast-lane assets
 * skip staging; they cut over directly at promote). Filter with --ids / --limit.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REPO_ROOT, SKILL_DAC_AWS_METRICS, SKILL_MANUAL_AWS_METRICS, SKILL_PER_KEY_AWS_METRICS } from '../lib/paths.ts';
import { liveMetricsPathIfPresent } from '../lib/live-metrics.ts';
import { loadRecipeIndex } from '../lib/recipe-lookup.ts';
import { rewriteInPlace, type QueryHit } from './rewrite-dashboard.ts';
import { buildApply, type AssetType } from '../lib/doc-apply.ts';
import { DocumentClient, DocumentApiError } from '../dynatrace/document.ts';
import { findOriginal } from '../lib/migrate-support.ts';
import { readRows, upsertRows, type TrackerRow } from '../lib/tracker-xlsx.ts';

export interface MigrateStageArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  trackerPath?: string;
  ids?: string[];
  limit?: number;
  apply?: boolean;
  /** Update already-staged copies in place (re-rewrite from original) instead of creating new ones. */
  restage?: boolean;
  /** Share each new copy read-write with this group id (direct-share). If unset, falls back to an environment-wide share. */
  shareGroupId?: string;
  mappingPath?: string;
  liveMetricsPath?: string;
  minOverrideSeries?: number;
}

const uiUrl = (baseUrl: string, type: AssetType, id: string) =>
  `${baseUrl.replace(/\/+$/, '')}/ui/apps/dynatrace.${type === 'dashboard' ? 'dashboards/dashboard' : 'notebooks/notebook'}/${id}`;

export async function runMigrateStage(args: MigrateStageArgs): Promise<void> {
  const base = args.outDir;
  const trackerPath = args.trackerPath ?? join(base, 'migration-tracker.xlsx');
  const stagedDir = join(base, 'migration', 'staged');
  await mkdir(stagedDir, { recursive: true });

  const rows = await readRows(trackerPath);
  if (rows.size === 0) throw new Error(`Empty/absent tracker ${trackerPath}. Run \`cct migrate-refresh\` first.`);

  const idFilter = args.ids && args.ids.length ? new Set(args.ids) : null;
  // Default: stage fresh copies from candidate rows. `--restage`: update the
  // copies already published (status=staged, with a review_copy_id) in place —
  // e.g. to re-apply an improved rewrite to review dashboards already out there.
  const wantStatus = args.restage ? 'staged' : 'candidate';
  let candidates = [...rows.entries()]
    .filter(([id, r]) => r['lane'] === 'review' && r['status'] === wantStatus && (!idFilter || idFilter.has(id)))
    .map(([id, r]) => ({
      id,
      type: (r['asset_type'] as AssetType) ?? 'dashboard',
      name: r['name'] ?? id,
      copyId: (r['review_copy_id'] as string | undefined) || undefined,
    }));
  if (args.restage) candidates = candidates.filter((c) => c.copyId);
  if (args.limit) candidates = candidates.slice(0, args.limit);

  if (candidates.length === 0) {
    console.log(
      args.restage
        ? 'No staged review copies to restage (need lane=review, status=staged, review_copy_id set).'
        : 'No review-lane candidates to stage (need lane=review, status=candidate).'
    );
    return;
  }
  const verb = args.restage ? (args.apply ? 'Restaging' : 'Preparing restage of') : args.apply ? 'Staging' : 'Preparing';
  console.log(`${verb} ${candidates.length} review-lane asset(s)…`);

  const client = new DocumentClient({ baseUrl: args.baseUrl, token: args.token });
  const mappingPath = args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.with_recipes.json');
  const liveMetricsPath = args.liveMetricsPath ?? liveMetricsPathIfPresent(base);
  const index = await loadRecipeIndex(mappingPath, {
    dacPath: SKILL_DAC_AWS_METRICS,
    manualPath: SKILL_MANUAL_AWS_METRICS,
    perKeyPath: SKILL_PER_KEY_AWS_METRICS,
    liveMetricsPath,
    minOverrideSeries: args.minOverrideSeries,
  });

  const updates: TrackerRow[] = [];
  let prepared = 0;
  let staged = 0;
  let missing = 0;

  for (const c of candidates) {
    const origPath = await findOriginal(base, c.type, c.id);
    if (!origPath) {
      console.log(`  ! ${c.id} (${c.name}) — downloaded original not found; skipping`);
      missing++;
      continue;
    }
    const wrapper = JSON.parse(await readFile(origPath, 'utf8')) as {
      metadata?: { id?: string; name?: string; version?: number };
      content?: unknown;
    };
    const content = typeof wrapper.content === 'string' ? JSON.parse(wrapper.content) : wrapper.content;
    const clone = structuredClone(content);
    const hits: QueryHit[] = [];
    // Annotate converted tiles with their original classic query (a `//`
    // reference block) so reviewers can eyeball the before/after inline. Stripped
    // again at promote so the production dashboard stays clean.
    rewriteInPlace(clone, index, hits, '', { annotateOriginal: true });

    const apply = buildApply({
      wrapper: { metadata: wrapper.metadata, content: clone },
      assetType: c.type,
      mode: 'create', // copies keep the [MIGRATION REVIEW] prefix in both modes
    });

    if (!args.apply) {
      await writeFile(join(stagedDir, `${c.id}.json`), JSON.stringify({ name: apply.name, type: c.type, content: apply.content }, null, 2));
      prepared++;
      continue;
    }

    try {
      if (args.restage) {
        // Update the existing copy in place — no new document, keeps its id/url + shares.
        const live = await client.getDocumentFull(c.copyId!, true);
        await client.updateContent(c.copyId!, {
          name: apply.name,
          type: c.type,
          content: apply.content,
          version: live.metadata.version,
          adminAccess: true,
        });
        updates.push({ asset_id: c.id, asset_type: c.type, name: c.name, status: 'staged', staged_at: new Date().toISOString() });
        staged++;
        console.log(`  ✓ restaged ${c.id} → copy ${c.copyId} (in place)`);
      } else {
        const created = await client.createDocument({ name: apply.name, type: c.type, content: apply.content, isPrivate: false });
        try {
          if (args.shareGroupId) await client.shareWithGroup(created.id, args.shareGroupId, 'read-write');
          else await client.shareEnvironment(created.id, 'read-write');
        } catch (se) {
          console.log(`    (couldn't share ${created.id}: ${(se as Error).message.slice(0, 80)} — share manually)`);
        }
        updates.push({
          asset_id: c.id,
          asset_type: c.type,
          name: c.name,
          status: 'staged',
          review_copy_id: created.id,
          review_copy_url: uiUrl(args.baseUrl, c.type, created.id),
          based_on_version: wrapper.metadata?.version,
          staged_at: new Date().toISOString(),
        });
        staged++;
        console.log(`  ✓ staged ${c.id} → copy ${created.id}`);
      }
    } catch (e) {
      const msg = e instanceof DocumentApiError ? `HTTP ${e.status}: ${e.body.slice(0, 100)}` : (e as Error).message;
      console.log(`  ! ${c.id} (${c.name}) — ${args.restage ? 'restage' : 'create'} failed: ${msg}`);
      missing++;
    }
  }

  if (args.apply && updates.length) await upsertRows(trackerPath, updates);

  console.log('');
  if (args.apply) {
    if (args.restage) {
      console.log(`Restaged ${staged} review copies in place; ${missing} failed.`);
      console.log('Converted tiles now carry the original classic query as a `//` reference comment.');
    } else {
      const shareNote = args.shareGroupId ? `shared read-write with group ${args.shareGroupId}` : 'env-shared read-write';
      console.log(`Staged ${staged} review copies (${shareNote}); ${missing} skipped.`);
      console.log('Reviewers can open + edit the copies (named "[MIGRATION REVIEW] …"). Then `cct migrate-pull` + `cct migrate-promote`.');
    }
  } else {
    console.log(`Prepared ${prepared} create payload(s) in ${stagedDir}; ${missing} skipped. No writes made. Re-run with --apply.`);
  }
}
