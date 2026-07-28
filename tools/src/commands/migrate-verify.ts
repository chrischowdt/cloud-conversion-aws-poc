/**
 * migrate-verify — confirm a cutover actually landed: re-read the promoted
 * original (admin Document read) and check its version advanced past the
 * recorded `pre_promote_version`. Marks the row status=verified.
 *
 * A "the update took" check, not a data-parity recheck — for deeper validation
 * run `compare-dashboard` on the asset. --ids/--limit.
 */

import { join } from 'node:path';

import { DocumentClient, DocumentApiError } from '../dynatrace/document.ts';
import { readRows, upsertRows, type AssetType, type TrackerRow } from '../lib/tracker-xlsx.ts';

export interface MigrateVerifyArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  trackerPath?: string;
  ids?: string[];
  limit?: number;
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

  const client = new DocumentClient({ baseUrl: args.baseUrl, token: args.token });
  const updates: TrackerRow[] = [];
  let verified = 0;
  let suspect = 0;
  for (const t of targets) {
    try {
      const live = await client.getDocumentFull(t.id, true);
      const v = live.metadata.version;
      const landed = v !== undefined && (t.preVersion === undefined || v > t.preVersion);
      if (landed) {
        updates.push({ asset_id: t.id, asset_type: t.type, name: t.name, status: 'verified', verified_at: new Date().toISOString() });
        verified++;
        console.log(`  ✓ ${t.id} (${t.name}) — live v${v}${t.preVersion !== undefined ? ` > pre v${t.preVersion}` : ''}`);
      } else {
        suspect++;
        console.log(`  ? ${t.id} (${t.name}) — live v${v ?? '?'} did not advance past v${t.preVersion ?? '?'}; check by hand`);
      }
    } catch (e) {
      suspect++;
      const msg = e instanceof DocumentApiError ? `HTTP ${e.status}` : (e as Error).message;
      console.log(`  ! ${t.id}: ${msg}`);
    }
  }
  if (updates.length) await upsertRows(trackerPath, updates);

  console.log('');
  console.log(`Verified ${verified}/${targets.length}; ${suspect} need a look.`);
}
