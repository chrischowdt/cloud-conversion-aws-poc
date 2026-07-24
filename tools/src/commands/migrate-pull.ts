/**
 * migrate-pull — fetch the current content of each staged review copy (after a
 * human has fixed it) so promote can cut it over. Reads from the tenant via
 * `dtctl get` (needs dtctl); saves to <base>/migration/reviewed/<originalId>.json
 * and moves the row to status=in-review.
 *
 * Selects rows with status=staged and a review_copy_id. Filter with --ids/--limit.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Dtctl } from '../dynatrace/dtctl.ts';
import { resourceSingular } from '../lib/migrate-support.ts';
import { readRows, upsertRows, type AssetType, type TrackerRow } from '../lib/tracker-xlsx.ts';

export interface MigratePullArgs {
  outDir: string;
  trackerPath?: string;
  ids?: string[];
  limit?: number;
  dtctlBin?: string;
  context?: string;
}

export async function runMigratePull(args: MigratePullArgs): Promise<void> {
  const base = args.outDir;
  const trackerPath = args.trackerPath ?? join(base, 'migration-tracker.xlsx');
  const reviewedDir = join(base, 'migration', 'reviewed');
  await mkdir(reviewedDir, { recursive: true });

  const rows = await readRows(trackerPath);
  const idFilter = args.ids?.length ? new Set(args.ids) : null;
  let staged = [...rows.entries()]
    .filter(([id, r]) => r['status'] === 'staged' && r['review_copy_id'] && (!idFilter || idFilter.has(id)))
    .map(([id, r]) => ({
      id,
      type: (r['asset_type'] as AssetType) ?? 'dashboard',
      name: r['name'] ?? id,
      copyId: r['review_copy_id'],
    }));
  if (args.limit) staged = staged.slice(0, args.limit);

  if (staged.length === 0) {
    console.log('No staged review copies to pull (need status=staged with a review_copy_id).');
    return;
  }

  const dtctl = new Dtctl({ bin: args.dtctlBin, context: args.context });
  if (!(await dtctl.available())) {
    throw new Error('dtctl not found on PATH (set --dtctl-bin or $DTCTL_BIN). migrate-pull reads copies via dtctl.');
  }

  const updates: TrackerRow[] = [];
  let pulled = 0;
  for (const s of staged) {
    try {
      const env = await dtctl.get(resourceSingular(s.type), s.copyId!);
      await writeFile(join(reviewedDir, `${s.id}.json`), JSON.stringify(env.result ?? {}, null, 2));
      updates.push({ asset_id: s.id, asset_type: s.type, name: s.name, status: 'in-review' });
      pulled++;
      console.log(`  ✓ pulled copy ${s.copyId} → migration/reviewed/${s.id}.json`);
    } catch (e) {
      console.log(`  ! ${s.id}: ${(e as Error).message}`);
    }
  }
  if (updates.length) await upsertRows(trackerPath, updates);

  console.log('');
  console.log(`Pulled ${pulled}/${staged.length} review copies into ${reviewedDir}.`);
  console.log('Set `decision` = approve in the tracker for the ones ready, then run `cct migrate-promote`.');
}
