/**
 * migrate-pull — fetch the current content of each staged review copy (after a
 * human has fixed it) so promote can cut it over. Reads via the Document API
 * (DocumentClient, admin-access); saves to
 * <base>/migration/reviewed/<originalId>.json and sets status=in-review.
 *
 * Selects rows with status=staged and a review_copy_id. Filter with --ids/--limit.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DocumentClient, DocumentApiError } from '../dynatrace/document.ts';
import { readRows, upsertRows, type AssetType, type TrackerRow } from '../lib/tracker-xlsx.ts';

export interface MigratePullArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  trackerPath?: string;
  ids?: string[];
  limit?: number;
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
      copyId: r['review_copy_id']!,
    }));
  if (args.limit) staged = staged.slice(0, args.limit);

  if (staged.length === 0) {
    console.log('No staged review copies to pull (need status=staged with a review_copy_id).');
    return;
  }

  const client = new DocumentClient({ baseUrl: args.baseUrl, token: args.token });
  const updates: TrackerRow[] = [];
  let pulled = 0;
  for (const s of staged) {
    try {
      const full = await client.getDocumentFull(s.copyId, true);
      await writeFile(join(reviewedDir, `${s.id}.json`), JSON.stringify({ content: full.content }, null, 2));
      updates.push({ asset_id: s.id, asset_type: s.type, name: s.name, status: 'in-review' });
      pulled++;
      console.log(`  ✓ pulled copy ${s.copyId} → migration/reviewed/${s.id}.json`);
    } catch (e) {
      const msg = e instanceof DocumentApiError ? `HTTP ${e.status}` : (e as Error).message;
      console.log(`  ! ${s.id}: ${msg}`);
    }
  }
  if (updates.length) await upsertRows(trackerPath, updates);

  console.log('');
  console.log(`Pulled ${pulled}/${staged.length} review copies into ${reviewedDir}.`);
  console.log('Set `decision` = "Ready To Publish" in the tracker for the ones ready, then run `cct migrate-promote`.');
}
