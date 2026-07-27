/**
 * migrate-rollback — revert a promoted asset by re-applying the exact
 * pre-cutover content that migrate-promote snapshotted to
 * migration/pre-promote/<id>.json (a `dtctl apply` with the original id).
 *
 * We re-apply saved content rather than `dtctl restore <version>` because dtctl
 * snapshots don't exist by default ("No snapshots found"), so version-restore is
 * unreliable — re-applying our own snapshot always works.
 *
 * Default prints what it would do; `--apply` executes. Requires --ids (or --all)
 * so a bulk revert is never accidental.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Dtctl } from '../dynatrace/dtctl.ts';
import { buildApply, type AssetType } from '../lib/dtctl-apply.ts';
import { readRows, upsertRows, type TrackerRow } from '../lib/tracker-xlsx.ts';

export interface MigrateRollbackArgs {
  outDir: string;
  trackerPath?: string;
  ids?: string[];
  all?: boolean;
  apply?: boolean;
  dtctlBin?: string;
  context?: string;
}

export async function runMigrateRollback(args: MigrateRollbackArgs): Promise<void> {
  const base = args.outDir;
  const trackerPath = args.trackerPath ?? join(base, 'migration-tracker.xlsx');
  const prePromoteDir = join(base, 'migration', 'pre-promote');
  const rollbackDir = join(base, 'migration', 'rollback');
  const rows = await readRows(trackerPath);

  const idFilter = args.ids?.length ? new Set(args.ids) : null;
  if (!idFilter && !args.all) {
    throw new Error('migrate-rollback: specify --ids <a,b> (or --all) — bulk revert is opt-in.');
  }
  const targets = [...rows.entries()]
    .filter(([id, r]) => {
      const promoted = r['status'] === 'promoted' || r['status'] === 'verified';
      return promoted && (!idFilter || idFilter.has(id));
    })
    .map(([id, r]) => ({ id, type: (r['asset_type'] as AssetType) ?? 'dashboard', name: r['name'] ?? id }));

  if (targets.length === 0) {
    console.log('No promoted assets match the selection.');
    return;
  }

  const dtctl = new Dtctl({ bin: args.dtctlBin, context: args.context });
  if (args.apply && !(await dtctl.available())) {
    throw new Error('dtctl not found on PATH (set --dtctl-bin or $DTCTL_BIN). Omit --apply to preview.');
  }
  await mkdir(rollbackDir, { recursive: true });

  const updates: TrackerRow[] = [];
  let done = 0;
  let missing = 0;
  for (const t of targets) {
    const snapPath = join(prePromoteDir, `${t.id}.json`);
    if (!existsSync(snapPath)) {
      console.log(`  ! ${t.id} (${t.name}) — no pre-cutover snapshot at ${snapPath}; cannot roll back.`);
      missing++;
      continue;
    }
    const snap = JSON.parse(await readFile(snapPath, 'utf8')) as Record<string, unknown>;
    const content = (snap['content'] as unknown) ?? snap;
    const apply = buildApply({
      wrapper: { metadata: { id: t.id, name: t.name }, content },
      assetType: t.type,
      mode: 'update',
      targetId: t.id,
    });
    const applyPath = join(rollbackDir, `${t.id}.apply.json`);
    await writeFile(applyPath, JSON.stringify(apply, null, 2));

    if (!args.apply) {
      console.log(`  dtctl apply -f "${applyPath}"   # restores pre-cutover content of ${t.id}`);
      continue;
    }
    try {
      await dtctl.applyFile(applyPath);
      updates.push({ asset_id: t.id, asset_type: t.type, name: t.name, status: 'rolled-back' });
      done++;
      console.log(`  ✓ rolled back ${t.id} (${t.name}) to pre-cutover content`);
    } catch (e) {
      console.log(`  ! ${t.id}: ${(e as Error).message}`);
    }
  }
  if (args.apply && updates.length) await upsertRows(trackerPath, updates);

  console.log('');
  console.log(
    args.apply
      ? `Rolled back ${done}/${targets.length}; ${missing} missing a snapshot.`
      : `Prepared ${targets.length - missing} rollback apply file(s). Re-run with --apply to execute.`
  );
}
