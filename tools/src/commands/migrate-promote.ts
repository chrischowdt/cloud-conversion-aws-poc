/**
 * migrate-promote — the cutover. For approved assets, update the ORIGINAL
 * document in place with the migrated content (same id/URL → users see the
 * migrated asset seamlessly, no interruption).
 *
 * Content source: review lane → the pulled, human-fixed copy
 * (migration/reviewed/<id>.json); fast lane → a fresh rewrite of the original.
 *
 * Default PREPARE mode (no dtctl): write the update apply file (id = original)
 * and print `dtctl apply` / `dtctl diff` commands. `--apply` drives dtctl live
 * with a DRIFT GUARD: it re-reads the original's live version and aborts if it
 * changed since we based our content on it (override with --force). It records
 * `pre_promote_version` so migrate-rollback can restore the exact prior version.
 *
 * Selects rows where decision=approve (from the Excel) and status is not yet
 * promoted/verified. Filter with --ids/--limit.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, SKILL_DAC_AWS_METRICS, SKILL_MANUAL_AWS_METRICS, SKILL_PER_KEY_AWS_METRICS } from '../lib/paths.ts';
import { liveMetricsPathIfPresent } from '../lib/live-metrics.ts';
import { loadRecipeIndex } from '../lib/recipe-lookup.ts';
import { rewriteInPlace, type QueryHit } from './rewrite-dashboard.ts';
import { buildApply, type AssetType } from '../lib/dtctl-apply.ts';
import { Dtctl } from '../dynatrace/dtctl.ts';
import { findOriginal, resourceSingular, versionFromGet } from '../lib/migrate-support.ts';
import { readRows, readDecisions, upsertRows, type TrackerRow } from '../lib/tracker-xlsx.ts';

export interface MigratePromoteArgs {
  outDir: string;
  trackerPath?: string;
  ids?: string[];
  limit?: number;
  apply?: boolean;
  force?: boolean;
  dtctlBin?: string;
  context?: string;
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
      const approved = decisions.get(id)?.decision === 'approve';
      const done = r['status'] === 'promoted' || r['status'] === 'verified';
      const lane = r['lane'];
      return approved && !done && (lane === 'fast' || lane === 'review') && (!idFilter || idFilter.has(id));
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
    console.log('No approved assets to promote (need decision=approve and status not promoted/verified).');
    return;
  }
  console.log(`${args.apply ? 'Promoting (in-place cutover)' : 'Preparing cutover for'} ${candidates.length} approved asset(s)…`);

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
  let promoted = 0;
  let prepared = 0;
  let skipped = 0;

  for (const c of candidates) {
    // Resolve the content to cut over.
    let content: unknown;
    let basedOn = c.basedOn;
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
      // fast lane — rewrite the downloaded original fresh.
      const origPath = await findOriginal(base, c.type, c.id);
      if (!origPath) {
        console.log(`  ! ${c.id} (${c.name}) — downloaded original not found. Skipping.`);
        skipped++;
        continue;
      }
      const wrapper = JSON.parse(await readFile(origPath, 'utf8')) as {
        metadata?: { version?: number };
        content?: unknown;
      };
      if (basedOn === undefined) basedOn = wrapper.metadata?.version;
      const raw = typeof wrapper.content === 'string' ? JSON.parse(wrapper.content) : wrapper.content;
      const clone = structuredClone(raw);
      const hits: QueryHit[] = [];
      rewriteInPlace(clone, index, hits, '');
      content = clone;
    }

    const apply = buildApply({
      wrapper: { metadata: { id: c.id, name: c.name }, content },
      assetType: c.type,
      mode: 'update',
      targetId: c.id,
    });
    const applyPath = join(promoteDir, `${c.id}.apply.json`);
    await writeFile(applyPath, JSON.stringify(apply, null, 2));

    if (!args.apply) {
      const ctx = args.context ? ` --context ${args.context}` : '';
      commands.push(`dtctl diff -f "${applyPath}"${ctx}   # preview`);
      commands.push(`dtctl apply -f "${applyPath}"${ctx}  # cutover (in-place)`);
      prepared++;
      continue;
    }

    // Drift guard: has the original changed since we based our content on it?
    const liveEnv = await dtctl.get(resourceSingular(c.type), c.id);
    const liveVersion = versionFromGet(liveEnv);
    if (basedOn !== undefined && liveVersion !== undefined && liveVersion !== basedOn && !args.force) {
      console.log(
        `  ! ${c.id} (${c.name}) — DRIFT: original is v${liveVersion}, we based on v${basedOn}. ` +
          `Skipping (re-review, or --force to override).`
      );
      skipped++;
      continue;
    }

    // Snapshot the exact pre-cutover doc locally so rollback can re-apply it.
    // (dtctl `restore` needs server-side snapshots, which don't exist by default.)
    await mkdir(prePromoteDir, { recursive: true });
    await writeFile(join(prePromoteDir, `${c.id}.json`), JSON.stringify(liveEnv.result ?? {}, null, 2));

    if (!scopesChecked) {
      if (!(await dtctl.canApply(applyPath))) {
        throw new Error(
          'Token lacks the scopes to update documents (checked via dtctl --check-scopes). ' +
            'Add document:documents:write (+ :admin to cut over others’ dashboards).'
        );
      }
      scopesChecked = true;
    }
    // Preview via apply --dry-run (structured, exit-0). Non-fatal — a failed
    // preview must not abort the cutover. (`dtctl diff` exits non-zero whenever
    // there ARE differences, so it's unsuitable as an automated gate.)
    try {
      const dry = await dtctl.applyFile(applyPath, { dryRun: true });
      const a = (dry.result ?? {}) as { action?: string; resourceType?: string };
      console.log(`    preview: would ${a.action ?? 'update'} ${a.resourceType ?? c.type} ${c.id}`);
    } catch (e) {
      console.log(`    (dry-run preview unavailable: ${(e as Error).message.slice(0, 80)})`);
    }
    await dtctl.applyFile(applyPath); // in-place update
    updates.push({
      asset_id: c.id,
      asset_type: c.type,
      name: c.name,
      status: 'promoted',
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
    console.log('Run `cct migrate-verify` to confirm, or `cct migrate-rollback --id <id>` to revert.');
  } else {
    console.log(`Prepared ${prepared} cutover apply file(s) in ${promoteDir}; ${skipped} skipped. No writes made.`);
    console.log('Preview with `dtctl diff`, then re-run with --apply (or run the printed commands):');
    for (const cmd of commands.slice(0, 60)) console.log(`  ${cmd}`);
    if (commands.length > 60) console.log(`  … and more.`);
  }
}
