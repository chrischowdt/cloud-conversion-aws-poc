/**
 * migrate-verify — confirm a cutover actually landed: re-read the promoted
 * original via `dtctl get` and check its version advanced past the recorded
 * `pre_promote_version`. Marks the row status=verified.
 *
 * This is a "the update took" check, not a data-parity recheck — for a deeper
 * check, run `compare-dashboard` on the asset. Needs dtctl (read). --ids/--limit.
 */

import { join } from 'node:path';

import { Dtctl } from '../dynatrace/dtctl.ts';
import { resourceSingular, versionFromGet } from '../lib/migrate-support.ts';
import { readRows, upsertRows, type AssetType, type TrackerRow } from '../lib/tracker-xlsx.ts';

export interface MigrateVerifyArgs {
  outDir: string;
  trackerPath?: string;
  ids?: string[];
  limit?: number;
  dtctlBin?: string;
  context?: string;
}

export async function runMigrateVerify(args: MigrateVerifyArgs): Promise<void> {
  const base = args.outDir;
  const trackerPath = args.trackerPath ?? join(base, 'migration-tracker.xlsx');
  const rows = await readRows(trackerPath);

  const idFilter = args.ids?.length ? new Set(args.ids) : null;
  let targets = [...rows.entries()]
    .filter(([id, r]) => r['status'] === 'promoted' && (!idFilter || idFilter.has(id)))
    .map(([id, r]) => ({
      id,
      type: (r['asset_type'] as AssetType) ?? 'dashboard',
      name: r['name'] ?? id,
      preVersion: r['pre_promote_version'] ? Number(r['pre_promote_version']) : undefined,
    }));
  if (args.limit) targets = targets.slice(0, args.limit);

  if (targets.length === 0) {
    console.log('No promoted assets to verify (need status=promoted).');
    return;
  }

  const dtctl = new Dtctl({ bin: args.dtctlBin, context: args.context });
  if (!(await dtctl.available())) {
    throw new Error('dtctl not found on PATH (set --dtctl-bin or $DTCTL_BIN). migrate-verify reads via dtctl.');
  }

  const updates: TrackerRow[] = [];
  let verified = 0;
  let suspect = 0;
  for (const t of targets) {
    try {
      const env = await dtctl.get(resourceSingular(t.type), t.id);
      const live = versionFromGet(env);
      const landed = live !== undefined && (t.preVersion === undefined || live > t.preVersion);
      if (landed) {
        updates.push({ asset_id: t.id, asset_type: t.type, name: t.name, status: 'verified', verified_at: new Date().toISOString() });
        verified++;
        console.log(`  ✓ ${t.id} (${t.name}) — live v${live}${t.preVersion !== undefined ? ` > pre v${t.preVersion}` : ''}`);
      } else {
        suspect++;
        console.log(`  ? ${t.id} (${t.name}) — live v${live ?? '?'} did not advance past v${t.preVersion ?? '?'}; check by hand`);
      }
    } catch (e) {
      suspect++;
      console.log(`  ! ${t.id}: ${(e as Error).message}`);
    }
  }
  if (updates.length) await upsertRows(trackerPath, updates);

  console.log('');
  console.log(`Verified ${verified}/${targets.length}; ${suspect} need a look.`);
}
