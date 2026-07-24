/**
 * migrate-rollback — revert a promoted asset to the version it had immediately
 * before the cutover, via `dtctl restore <resource> <id> --version <N>` where N
 * is the `pre_promote_version` recorded at promote time.
 *
 * Default prints the restore command; `--apply` executes it. Requires an
 * explicit --ids (or --all) so a bulk revert is never accidental.
 */

import { join } from 'node:path';

import { Dtctl } from '../dynatrace/dtctl.ts';
import { resourceSingular } from '../lib/migrate-support.ts';
import { readRows, upsertRows, type AssetType, type TrackerRow } from '../lib/tracker-xlsx.ts';

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
  const rows = await readRows(trackerPath);

  const idFilter = args.ids?.length ? new Set(args.ids) : null;
  if (!idFilter && !args.all) {
    throw new Error('migrate-rollback: specify --ids <a,b> (or --all) — bulk revert is opt-in.');
  }
  const targets = [...rows.entries()]
    .filter(([id, r]) => {
      const promoted = r['status'] === 'promoted' || r['status'] === 'verified';
      return promoted && r['pre_promote_version'] && (!idFilter || idFilter.has(id));
    })
    .map(([id, r]) => ({
      id,
      type: (r['asset_type'] as AssetType) ?? 'dashboard',
      name: r['name'] ?? id,
      version: Number(r['pre_promote_version']),
    }));

  if (targets.length === 0) {
    console.log('No promoted assets with a recorded pre_promote_version match the selection.');
    return;
  }

  const dtctl = new Dtctl({ bin: args.dtctlBin, context: args.context });
  if (args.apply && !(await dtctl.available())) {
    throw new Error('dtctl not found on PATH (set --dtctl-bin or $DTCTL_BIN). Omit --apply to print commands.');
  }

  const updates: TrackerRow[] = [];
  let done = 0;
  for (const t of targets) {
    if (!args.apply) {
      const ctx = args.context ? ` --context ${args.context}` : '';
      console.log(`  dtctl restore ${resourceSingular(t.type)} ${t.id} --version ${t.version}${ctx}`);
      continue;
    }
    try {
      await dtctl.restore(resourceSingular(t.type), t.id, t.version);
      updates.push({ asset_id: t.id, asset_type: t.type, name: t.name, status: 'rolled-back' });
      done++;
      console.log(`  ✓ restored ${t.id} (${t.name}) to v${t.version}`);
    } catch (e) {
      console.log(`  ! ${t.id}: ${(e as Error).message}`);
    }
  }
  if (args.apply && updates.length) await upsertRows(trackerPath, updates);

  console.log('');
  console.log(
    args.apply
      ? `Rolled back ${done}/${targets.length} asset(s).`
      : `Printed ${targets.length} restore command(s). Re-run with --apply to execute.`
  );
}
