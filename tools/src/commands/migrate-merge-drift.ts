/**
 * migrate-merge-drift — reconcile reviewed copies whose ORIGINAL was edited
 * while it sat in review, so `migrate-promote` can cut them over without
 * `--force`.
 *
 * The drift guard exists so a cutover never silently discards the owner's work.
 * The two ways past it are both lossy: `--force` throws away the owner's edits,
 * re-staging throws away the reviewer's. This merges them — in practice they
 * touch different things (the reviewer rewrites queries, the owner adjusts
 * layout and visualisations), so both survive.
 *
 * For each drifted row it merges (staged original, reviewed copy, live original),
 * writes the result back over migration/reviewed/<id>.json, and re-bases
 * `based_on_version` to the live version so the guard passes honestly on the next
 * promote rather than being overridden.
 *
 * Default is a DRY RUN. Conflicts (both sides changed the same leaf) keep the
 * migration side and are always printed — never swallowed.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DocumentClient, DocumentApiError } from '../dynatrace/document.ts';
import { findOriginal } from '../lib/migrate-support.ts';
import { threeWayMerge } from '../lib/three-way-merge.ts';
import { readRows, upsertRows, type AssetType, type TrackerRow } from '../lib/tracker-xlsx.ts';

export interface MigrateMergeDriftArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  trackerPath?: string;
  ids?: string[];
  apply?: boolean;
}

export async function runMigrateMergeDrift(args: MigrateMergeDriftArgs): Promise<void> {
  const base = args.outDir;
  const trackerPath = args.trackerPath ?? join(base, 'migration-tracker.xlsx');
  const reviewedDir = join(base, 'migration', 'reviewed');
  const rows = await readRows(trackerPath);
  const idFilter = args.ids?.length ? new Set(args.ids) : null;

  // Candidates: anything with a pulled copy whose based_on_version is behind live.
  const candidates = [...rows.entries()]
    .filter(([id, r]) => (!idFilter || idFilter.has(id)) && existsSync(join(reviewedDir, `${id}.json`)))
    .map(([id, r]) => ({ id, name: r['name'] ?? id, type: (r['asset_type'] as AssetType) ?? 'dashboard', basedOn: r['based_on_version'] ? Number(r['based_on_version']) : undefined }));

  if (!candidates.length) {
    console.log('No pulled review copies found. Run `cct migrate-pull` first.');
    return;
  }

  const client = new DocumentClient({ baseUrl: args.baseUrl, token: args.token });
  const updates: TrackerRow[] = [];
  let merged = 0, skipped = 0;

  for (const c of candidates) {
    let live;
    try {
      live = await client.getDocumentFull(c.id, true);
    } catch (e) {
      const msg = e instanceof DocumentApiError ? `HTTP ${e.status}` : (e as Error).message;
      console.log(`  ! ${c.name}: ${msg}`);
      continue;
    }
    if (c.basedOn !== undefined && live.metadata.version === c.basedOn) { skipped++; continue; } // no drift

    const op = await findOriginal(base, c.type, c.id);
    if (!op) {
      console.log(`  ! ${c.name}: the staged original isn't on disk (scope narrowed?) — cannot merge safely, skipping`);
      continue;
    }
    const bw = JSON.parse(await readFile(op, 'utf8')) as { content?: unknown };
    const staged = typeof bw.content === 'string' ? JSON.parse(bw.content) : bw.content;
    const revPath = join(reviewedDir, `${c.id}.json`);
    const ours = (JSON.parse(await readFile(revPath, 'utf8')) as { content?: unknown }).content;

    const { merged: out, report } = threeWayMerge(staged, ours, live.content);
    const took = report.ownerChangesTaken.length + report.ownerAdditions.length;
    console.log(
      `  ${c.name.slice(0, 42).padEnd(44)} v${c.basedOn ?? '?'} -> v${live.metadata.version}  ` +
        `owner kept: ${took + report.conflictsOwnerWon.length}  migration kept on conflict: ${report.conflicts.length}`
    );
    for (const p of report.conflicts.slice(0, 5)) console.log(`      conflict: ${p}`);

    if (args.apply) {
      await writeFile(revPath, JSON.stringify({ content: out }, null, 2));
      updates.push({
        asset_id: c.id,
        asset_type: c.type,
        name: c.name,
        status: 'in-review',
        based_on_version: live.metadata.version,
      });
    }
    merged++;
  }

  if (args.apply && updates.length) await upsertRows(trackerPath, updates);
  console.log('');
  console.log(
    args.apply
      ? `Merged ${merged} drifted copy(ies) and re-based them to live; ${skipped} had no drift. Run \`cct migrate-promote --apply\`.`
      : `${merged} drifted copy(ies) would be merged; ${skipped} have no drift. No writes made — re-run with --apply.`
  );
}
