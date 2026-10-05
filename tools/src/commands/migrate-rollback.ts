/**
 * migrate-rollback — revert a promoted asset by re-applying the exact
 * pre-cutover content that migrate-promote snapshotted to
 * migration/pre-promote/<id>.json, via an admin Document write (DocumentClient).
 * Self-contained (no reliance on server snapshots, which don't exist by default).
 *
 * Default prints what it would do; `--apply` executes. Requires --ids (or --all)
 * so a bulk revert is never accidental.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DocumentClient, DocumentApiError } from '../dynatrace/document.ts';
import { readRows, upsertRows, type AssetType, type TrackerRow } from '../lib/tracker-xlsx.ts';
import { PUBLISHED_NEW_STATUS } from './publish-notebook.ts';

export interface MigrateRollbackArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  trackerPath?: string;
  ids?: string[];
  all?: boolean;
  apply?: boolean;
}

export async function runMigrateRollback(args: MigrateRollbackArgs): Promise<void> {
  const base = args.outDir;
  const trackerPath = args.trackerPath ?? join(base, 'migration-tracker.xlsx');
  const prePromoteDir = join(base, 'migration', 'pre-promote');
  // Notebooks published as NEW: the thing that changed is the review copy, not
  // the original, so that is what gets restored — the original is never written.
  const prePublishDir = join(base, 'migration', 'pre-publish');
  const rows = await readRows(trackerPath);

  const idFilter = args.ids?.length ? new Set(args.ids) : null;
  if (!idFilter && !args.all) {
    throw new Error('migrate-rollback: specify --ids <a,b> (or --all) — bulk revert is opt-in.');
  }
  const targets = [...rows.entries()]
    .filter(([id, r]) => {
      const promoted =
        r['status'] === 'promoted' || r['status'] === 'verified' || r['status'] === PUBLISHED_NEW_STATUS;
      return promoted && (!idFilter || idFilter.has(id));
    })
    .map(([id, r]) => ({
      id,
      type: (r['asset_type'] as AssetType) ?? 'dashboard',
      name: r['name'] ?? id,
      publishedNew: r['status'] === PUBLISHED_NEW_STATUS,
    }));

  if (targets.length === 0) {
    console.log('No promoted assets match the selection.');
    return;
  }

  const client = new DocumentClient({ baseUrl: args.baseUrl, token: args.token });
  const updates: TrackerRow[] = [];
  let done = 0;
  let missing = 0;
  for (const t of targets) {
    if (t.publishedNew) {
      const snapPath = join(prePublishDir, `${t.id}.json`);
      if (!existsSync(snapPath)) {
        console.log(`  ! ${t.id} (${t.name}) — no pre-publish snapshot at ${snapPath}; cannot roll back.`);
        missing++;
        continue;
      }
      const snap = JSON.parse(await readFile(snapPath, 'utf8')) as { reviewCopyId: string; name: string; content: unknown };
      if (!args.apply) {
        console.log(`  would restore review copy ${snap.reviewCopyId} of ${t.name} to "${snap.name}" (the original is untouched either way)`);
        continue;
      }
      try {
        const live = await client.getDocumentFull(snap.reviewCopyId, true);
        await client.updateContent(snap.reviewCopyId, {
          name: snap.name,
          type: 'notebook',
          content: snap.content,
          version: live.metadata.version,
          adminAccess: true,
        });
        updates.push({ asset_id: t.id, asset_type: t.type, name: t.name, status: 'rolled-back' });
        done++;
        console.log(`  ✓ restored review copy ${snap.reviewCopyId} to "${snap.name}" (original untouched)`);
      } catch (e) {
        const msg = e instanceof DocumentApiError ? `HTTP ${e.status}` : (e as Error).message;
        console.log(`  ! ${t.id}: ${msg}`);
      }
      continue;
    }

    const snapPath = join(prePromoteDir, `${t.id}.json`);
    if (!existsSync(snapPath)) {
      console.log(`  ! ${t.id} (${t.name}) — no pre-cutover snapshot at ${snapPath}; cannot roll back.`);
      missing++;
      continue;
    }
    const snap = JSON.parse(await readFile(snapPath, 'utf8')) as { content?: unknown };
    const content = snap.content ?? snap;

    if (!args.apply) {
      console.log(`  would restore ${t.id} (${t.name}) from ${snapPath}`);
      continue;
    }
    try {
      const live = await client.getDocumentFull(t.id, true);
      await client.updateContent(t.id, { name: t.name, type: t.type, content, version: live.metadata.version, adminAccess: true });
      updates.push({ asset_id: t.id, asset_type: t.type, name: t.name, status: 'rolled-back' });
      done++;
      console.log(`  ✓ rolled back ${t.id} (${t.name}) to pre-cutover content`);
    } catch (e) {
      const msg = e instanceof DocumentApiError ? `HTTP ${e.status}` : (e as Error).message;
      console.log(`  ! ${t.id}: ${msg}`);
    }
  }
  if (args.apply && updates.length) await upsertRows(trackerPath, updates);

  console.log('');
  console.log(
    args.apply
      ? `Rolled back ${done}/${targets.length}; ${missing} missing a snapshot.`
      : `Would roll back ${targets.length - missing} asset(s). Re-run with --apply.`
  );
}
