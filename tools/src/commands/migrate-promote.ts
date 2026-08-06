/**
 * migrate-promote — the cutover. For rows marked "Ready To Publish", update the ORIGINAL
 * document in place with the migrated content (same id/URL → users see the
 * migrated asset seamlessly, no interruption).
 *
 * Writes via the Document Service directly with admin-access (DocumentClient),
 * NOT dtctl: an admin token (`document:documents:read+write+admin`) can update
 * a document owned by ANYONE, which dtctl can't do. Owner is preserved (a
 * content update, not an ownership change).
 *
 * Content source: review lane → the pulled, human-fixed copy
 * (migration/reviewed/<id>.json); fast lane → a fresh rewrite of the original.
 *
 * Default PREPARE mode (no writes): write the intended content to
 * migration/promote/<id>.json for inspection. `--apply` performs the in-place
 * update with a DRIFT GUARD (re-reads the live version; aborts if it changed
 * since we based on it — override with --force) and records
 * `pre_promote_version` so migrate-rollback can restore the prior content.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, SKILL_DAC_AWS_METRICS, SKILL_MANUAL_AWS_METRICS, SKILL_PER_KEY_AWS_METRICS } from '../lib/paths.ts';
import { liveMetricsPathIfPresent } from '../lib/live-metrics.ts';
import { loadRecipeIndex } from '../lib/recipe-lookup.ts';
import { rewriteInPlace, stripOriginalCommentsInPlace, type QueryHit } from './rewrite-dashboard.ts';
import { buildApply, type AssetType } from '../lib/doc-apply.ts';
import { DocumentClient, DocumentApiError } from '../dynatrace/document.ts';
import { findOriginal } from '../lib/migrate-support.ts';
import { readRows, readDecisions, upsertRows, isReadyToPublish, isPublished, PUBLISHED, type TrackerRow } from '../lib/tracker-xlsx.ts';

export interface MigratePromoteArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  trackerPath?: string;
  ids?: string[];
  limit?: number;
  apply?: boolean;
  force?: boolean;
  mappingPath?: string;
  liveMetricsPath?: string;
  minOverrideSeries?: number;
}

interface Candidate {
  id: string;
  type: AssetType;
  name: string;
  lane: string;
  basedOn?: number;
}

export async function runMigratePromote(args: MigratePromoteArgs): Promise<void> {
  const base = args.outDir;
  const trackerPath = args.trackerPath ?? join(base, 'migration-tracker.xlsx');
  const promoteDir = join(base, 'migration', 'promote');
  const reviewedDir = join(base, 'migration', 'reviewed');
  const prePromoteDir = join(base, 'migration', 'pre-promote');
  await mkdir(promoteDir, { recursive: true });

  const rows = await readRows(trackerPath);
  if (rows.size === 0) throw new Error(`Empty/absent tracker ${trackerPath}. Run \`cct migrate-refresh\` first.`);
  const decisions = await readDecisions(trackerPath);

  const idFilter = args.ids?.length ? new Set(args.ids) : null;
  let candidates: Candidate[] = [...rows.entries()]
    .filter(([id, r]) => {
      const dec = decisions.get(id)?.decision;
      const ready = isReadyToPublish(dec);
      const done = isPublished(dec) || r['status'] === 'promoted' || r['status'] === 'verified';
      const lane = r['lane'];
      return ready && !done && (lane === 'fast' || lane === 'review') && (!idFilter || idFilter.has(id));
    })
    .map(([id, r]) => ({
      id,
      type: (r['asset_type'] as AssetType) ?? 'dashboard',
      name: r['name'] ?? id,
      lane: r['lane'] ?? 'review',
      basedOn: r['based_on_version'] ? Number(r['based_on_version']) : undefined,
    }));
  if (args.limit) candidates = candidates.slice(0, args.limit);

  if (candidates.length === 0) {
    console.log('No assets to publish (need decision="Ready To Publish" and not already Published/promoted).');
    return;
  }
  console.log(`${args.apply ? 'Publishing (in-place cutover)' : 'Preparing cutover for'} ${candidates.length} ready asset(s)…`);

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
  let promoted = 0;
  let prepared = 0;
  let skipped = 0;

  for (const c of candidates) {
    // Resolve content to cut over.
    let content: unknown;
    if (c.lane === 'review') {
      const revPath = join(reviewedDir, `${c.id}.json`);
      if (!existsSync(revPath)) {
        console.log(`  ! ${c.id} (${c.name}) — no pulled copy; run \`cct migrate-pull\` first. Skipping.`);
        skipped++;
        continue;
      }
      const rev = JSON.parse(await readFile(revPath, 'utf8')) as Record<string, unknown>;
      content = (rev['content'] as unknown) ?? rev;
    } else {
      const origPath = await findOriginal(base, c.type, c.id);
      if (!origPath) {
        console.log(`  ! ${c.id} (${c.name}) — downloaded original not found. Skipping.`);
        skipped++;
        continue;
      }
      const wrapper = JSON.parse(await readFile(origPath, 'utf8')) as { content?: unknown };
      const raw = typeof wrapper.content === 'string' ? JSON.parse(wrapper.content) : wrapper.content;
      const clone = structuredClone(raw);
      const hits: QueryHit[] = [];
      rewriteInPlace(clone, index, hits, '');
      content = clone;
    }

    // Strip any migration reference comments (added at stage) so the promoted
    // production dashboard carries only the clean migrated query.
    stripOriginalCommentsInPlace(content);

    // buildApply(update) restores the original (unsuffixed) name + mirrors it
    // into content.settings.name for dashboards.
    const apply = buildApply({
      wrapper: { metadata: { id: c.id, name: c.name }, content },
      assetType: c.type,
      mode: 'update',
      targetId: c.id,
    });

    if (!args.apply) {
      await writeFile(join(promoteDir, `${c.id}.json`), JSON.stringify({ id: c.id, name: apply.name, content: apply.content }, null, 2));
      prepared++;
      continue;
    }

    // Drift guard + pre-cutover snapshot (one admin read).
    let live;
    try {
      live = await client.getDocumentFull(c.id, true);
    } catch (e) {
      const msg = e instanceof DocumentApiError && (e.status === 401 || e.status === 403)
        ? `not accessible/authorized (HTTP ${e.status}) — token needs document:documents:read+admin`
        : (e as Error).message;
      console.log(`  ! ${c.id} (${c.name}) — ${msg}. Skipping.`);
      skipped++;
      continue;
    }
    const liveVersion = live.metadata.version;
    if (c.basedOn !== undefined && liveVersion !== undefined && liveVersion !== c.basedOn && !args.force) {
      console.log(`  ! ${c.id} (${c.name}) — DRIFT: live v${liveVersion}, based on v${c.basedOn}. Skipping (--force to override).`);
      skipped++;
      continue;
    }
    await mkdir(prePromoteDir, { recursive: true });
    await writeFile(join(prePromoteDir, `${c.id}.json`), JSON.stringify({ content: live.content, owner: live.metadata.owner }, null, 2));

    try {
      await client.updateContent(c.id, { name: apply.name, type: c.type, content: apply.content, version: liveVersion, adminAccess: true });
    } catch (e) {
      const msg = e instanceof DocumentApiError && e.status === 403
        ? `HTTP 403 — token needs document:documents:write (+ admin for others' docs)`
        : (e as Error).message;
      console.log(`  ! ${c.id} (${c.name}) — cutover failed: ${msg}`);
      skipped++;
      continue;
    }
    updates.push({
      asset_id: c.id,
      asset_type: c.type,
      name: c.name,
      status: 'promoted',
      decision: PUBLISHED, // stamp the team-facing lifecycle value in column V
      pre_promote_version: liveVersion,
      promoted_at: new Date().toISOString(),
    });
    promoted++;
    console.log(`  ✓ cut over ${c.id} (${c.name}) in place${liveVersion !== undefined ? ` (was v${liveVersion})` : ''}`);
  }

  if (args.apply && updates.length) await upsertRows(trackerPath, updates);

  console.log('');
  if (args.apply) {
    console.log(`Promoted ${promoted} asset(s) in place; ${skipped} skipped.`);
    console.log('Run `cct migrate-verify` to confirm, or `cct migrate-rollback --ids <id>` to revert.');
  } else {
    console.log(`Prepared ${prepared} cutover payload(s) in ${promoteDir}; ${skipped} skipped. No writes made. Re-run with --apply.`);
  }
}
