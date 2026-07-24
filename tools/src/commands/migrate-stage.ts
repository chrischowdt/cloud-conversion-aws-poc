/**
 * migrate-stage — review lane: publish a migrated *copy* of each review-lane
 * asset so a human can review/fix it before any cutover. The original is never
 * touched.
 *
 * Default is PREPARE mode (no dtctl needed): rewrite the downloaded original,
 * write the dtctl apply file per asset, and print the exact `dtctl apply`
 * command. With `--apply` it drives dtctl live (create → new review copy),
 * records the copy id + the original's version (`based_on_version`, for the
 * later drift guard), and sets status=`staged`.
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
import { buildApply, type AssetType } from '../lib/dtctl-apply.ts';
import { Dtctl, idFromApplyResult } from '../dynatrace/dtctl.ts';
import { findOriginal } from '../lib/migrate-support.ts';
import { readRows, upsertRows, type TrackerRow } from '../lib/tracker-xlsx.ts';

export interface MigrateStageArgs {
  outDir: string;
  trackerPath?: string;
  ids?: string[];
  limit?: number;
  /** Actually invoke dtctl (create the copies). Default false = prepare only. */
  apply?: boolean;
  dtctlBin?: string;
  context?: string;
  mappingPath?: string;
  liveMetricsPath?: string;
  minOverrideSeries?: number;
}

export async function runMigrateStage(args: MigrateStageArgs): Promise<void> {
  const base = args.outDir;
  const trackerPath = args.trackerPath ?? join(base, 'migration-tracker.xlsx');
  const stagedDir = join(base, 'migration', 'staged');
  await mkdir(stagedDir, { recursive: true });

  const rows = await readRows(trackerPath);
  if (rows.size === 0) throw new Error(`Empty/absent tracker ${trackerPath}. Run \`cct migrate-refresh\` first.`);

  const idFilter = args.ids && args.ids.length ? new Set(args.ids) : null;
  let candidates = [...rows.entries()]
    .filter(([id, r]) => r['lane'] === 'review' && r['status'] === 'candidate' && (!idFilter || idFilter.has(id)))
    .map(([id, r]) => ({ id, type: (r['asset_type'] as AssetType) ?? 'dashboard', name: r['name'] ?? id }));
  if (args.limit) candidates = candidates.slice(0, args.limit);

  if (candidates.length === 0) {
    console.log('No review-lane candidates to stage (need lane=review, status=candidate).');
    return;
  }
  console.log(`${args.apply ? 'Staging' : 'Preparing'} ${candidates.length} review-lane asset(s)…`);

  const dtctl = new Dtctl({ bin: args.dtctlBin, context: args.context });
  if (args.apply && !(await dtctl.available())) {
    throw new Error('dtctl not found on PATH (set --dtctl-bin or $DTCTL_BIN). Omit --apply to prepare only.');
  }
  let scopesChecked = false;

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
  const commands: string[] = [];
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
    rewriteInPlace(clone, index, hits, '');

    const apply = buildApply({
      wrapper: { metadata: wrapper.metadata, content: clone },
      assetType: c.type,
      mode: 'create',
    });
    const applyPath = join(stagedDir, `${c.id}.apply.json`);
    await writeFile(applyPath, JSON.stringify(apply, null, 2));
    prepared++;

    if (!args.apply) {
      const ctx = args.context ? ` --context ${args.context}` : '';
      commands.push(`dtctl apply -f "${applyPath}"${ctx}`);
      continue;
    }

    if (!scopesChecked) {
      if (!(await dtctl.canApply(applyPath))) {
        throw new Error(
          'Token lacks the scopes to create documents (checked via dtctl --check-scopes). ' +
            'Add document:documents:write to the platform token.'
        );
      }
      scopesChecked = true;
    }
    const env = await dtctl.applyFile(applyPath);
    const copyId = idFromApplyResult(env);
    updates.push({
      asset_id: c.id,
      asset_type: c.type,
      name: c.name,
      status: 'staged',
      review_copy_id: copyId ?? '',
      based_on_version: wrapper.metadata?.version,
      staged_at: new Date().toISOString(),
    });
    staged++;
    console.log(`  ✓ staged ${c.id} → copy ${copyId ?? '(id not parsed — check dtctl output)'}`);
  }

  if (args.apply && updates.length) await upsertRows(trackerPath, updates);

  console.log('');
  if (args.apply) {
    console.log(`Staged ${staged} review copies (apply files in ${stagedDir}); ${missing} skipped.`);
    console.log('Reviewers can now open + fix the copies; then run `cct migrate-pull` and `cct migrate-promote`.');
  } else {
    console.log(`Prepared ${prepared} apply file(s) in ${stagedDir}; ${missing} skipped. No writes made.`);
    console.log('Review the files, then either re-run with --apply, or run the printed commands:');
    for (const cmd of commands.slice(0, 50)) console.log(`  ${cmd}`);
    if (commands.length > 50) console.log(`  … and ${commands.length - 50} more (one per staged asset).`);
  }
}
