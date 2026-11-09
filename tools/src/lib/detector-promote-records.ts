/**
 * detector-promote-records — the files migrate-promote-detectors keeps for each
 * alert it wrote, and the selection that verify and rollback share.
 *
 *   <base>/migration/detector-promote/pre/<objectId>.json        { objectId, title, snapshotAt, value }
 *     the live value just before the publish wrote it (the first snapshot wins)
 *   <base>/migration/detector-promote/published/<objectId>.json  { objectId, publishedAt, value }
 *     the value the publish wrote
 *
 * An alert the tool recorded without writing it (someone had already applied the
 * approved query by hand) is `promoted` on the sheet but has neither file.
 *
 * Node-only (fs + the workbook).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { selectPublished, type ManifestBatch, type PublishedTarget } from './detector-publish.ts';
import { ALERTS_SHEET, readRows } from './tracker-xlsx.ts';

/** `<base>/migration/detector-promote`. */
export function promoteDirOf(base: string): string {
  return join(base, 'migration', 'detector-promote');
}

export interface PromoteRecord {
  objectId?: string;
  title?: string;
  /** `pre/` only. */
  snapshotAt?: string;
  /** `published/` only. */
  publishedAt?: string;
  value: Record<string, unknown>;
}

/** A record file: absent, present but unusable (why), or read. */
export type RecordRead = { kind: 'missing'; path: string } | { kind: 'bad'; path: string; problem: string } | { kind: 'ok'; path: string; record: PromoteRecord };

/** Read `pre/<id>.json` or `published/<id>.json`. A file without a value object is `bad`, never a value of `{}`. */
export async function readPromoteRecord(promoteDir: string, kind: 'pre' | 'published', objectId: string): Promise<RecordRead> {
  const path = join(promoteDir, kind, `${objectId}.json`);
  if (!existsSync(path)) return { kind: 'missing', path };
  try {
    const record = JSON.parse(await readFile(path, 'utf8')) as PromoteRecord;
    const v = record?.value as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { kind: 'bad', path, problem: 'it holds no value object' };
    return { kind: 'ok', path, record };
  } catch (e) {
    return { kind: 'bad', path, problem: (e as Error)?.message ?? String(e) };
  }
}

/**
 * The published alerts a verify or rollback run acts on (see `selectPublished`),
 * read from the alerts sheet, with batch membership from the review manifest.
 * The manifest is required only with `batches`; without, it is read when present
 * so each alert still shows its batch. Prints the batches it does not know and
 * why each named id was left out. `rows` is the whole sheet as read.
 */
export async function loadPublishedTargets(a: {
  /** The command name, for error messages. */
  command: string;
  outDir: string;
  trackerPath: string;
  statuses: readonly string[];
  batches?: string[];
  ids?: string[];
  log: (line: string) => void;
}): Promise<{ targets: PublishedTarget[]; rows: Map<string, Record<string, string>> }> {
  const reviewDir = join(a.outDir, 'migration', 'detector-review');
  const manifestPath = join(reviewDir, 'manifest.json');
  let batches: ManifestBatch[] = [];
  if (a.batches?.length || existsSync(manifestPath)) {
    try {
      batches = (JSON.parse(await readFile(manifestPath, 'utf8')) as { batches?: ManifestBatch[] }).batches ?? [];
    } catch (e) {
      if (a.batches?.length) {
        throw new Error(`${a.command}: --batches needs the review manifest in ${reviewDir}, which cannot be read (${(e as Error).message}).`);
      }
    }
  }
  if (!existsSync(a.trackerPath)) {
    throw new Error(`${a.command}: no workbook at ${a.trackerPath}. Pass --tracker <path> or set DT_TRACKER_PATH.`);
  }
  const rows = await readRows(a.trackerPath, ALERTS_SHEET);
  const sel = selectPublished(rows, batches, { statuses: a.statuses, batches: a.batches, ids: a.ids });
  if (sel.unknownBatches.length) {
    a.log(`Not found in the manifest, or never published as a review notebook: ${sel.unknownBatches.join(', ')}.`);
  }
  if (sel.notSelected.length) {
    a.log(`${sel.notSelected.length} of the --ids not selected:`);
    for (const n of sel.notSelected) a.log(`  ${n.id}: ${n.reason}`);
  }
  return { targets: sel.targets, rows };
}
