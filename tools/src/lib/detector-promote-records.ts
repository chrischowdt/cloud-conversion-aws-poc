/**
 * detector-promote-records — the files migrate-promote-detectors keeps for each
 * alert it writes, the marker migrate-rollback-detectors leaves, and the
 * selection that verify and rollback share. Under
 * `<base>/migration/detector-promote/`:
 *
 *   pre/<id>.json                { objectId, title, snapshotAt, value }
 *     the live value just before a publish wrote it. A later publish keeps it
 *     while the live alert's query and event fields still equal it (a retry of
 *     an earlier attempt); otherwise it is moved aside to `pre/<id>.<stamp>.json`
 *     and a fresh one is taken, so a rollback never restores an out-of-date one
 *   published/<id>.pending.json  { objectId, pendingAt, approvedQuery, value }
 *     written just before the write; renamed to `published/<id>.json` once the
 *     write is checked. Left behind, it is a write that may have landed (no
 *     answer and no re-read, or a crash), which the next run reads as published
 *   published/<id>.json          { objectId, publishedAt, approvedQuery, value, storedValue }
 *     `value` is what the publish wrote, `storedValue` what the re-read after it
 *     found (absent when that re-read failed), `approvedQuery` the review tile's
 *     query it was built from
 *   rolled-back/<id>.json        { objectId, rolledBackAt }
 *     left by an applied rollback. A publish run skips the alert while its sheet
 *     row looks older than the rollback, and moves the file aside to
 *     `rolled-back/<id>.<stamp>.json` when it publishes the alert again
 *
 * An alert the tool recorded without writing it (someone had already applied the
 * approved query by hand) is `promoted` on the sheet but has neither a `pre/` nor
 * a `published/` file.
 *
 * Node-only (fs + the workbook).
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  /** The pending record only. */
  pendingAt?: string;
  /** `published/` and pending: the review tile's query the value was built from. */
  approvedQuery?: string;
  /** What was written (`published/`, pending), or what was live (`pre/`). */
  value: Record<string, unknown>;
  /** `published/` only: what the re-read after the write found. */
  storedValue?: Record<string, unknown>;
}

/** Which record: the snapshot, the published record, or the one written just before a write. */
export type RecordKind = 'pre' | 'published' | 'pending';

/** Where a record of an alert lives. */
export function recordPath(promoteDir: string, kind: RecordKind, objectId: string): string {
  if (kind === 'pending') return join(promoteDir, 'published', `${objectId}.pending.json`);
  return join(promoteDir, kind, `${objectId}.json`);
}

/** A record file: absent, present but unusable (why), or read. */
export type RecordRead = { kind: 'missing'; path: string } | { kind: 'bad'; path: string; problem: string } | { kind: 'ok'; path: string; record: PromoteRecord };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Read a record. A file without a value object is `bad`, never a value of `{}`;
 * so is one whose `storedValue` is there but not an object, since verify and
 * rollback would compare against it.
 */
export async function readPromoteRecord(promoteDir: string, kind: RecordKind, objectId: string): Promise<RecordRead> {
  const path = recordPath(promoteDir, kind, objectId);
  if (!existsSync(path)) return { kind: 'missing', path };
  try {
    const record = JSON.parse(await readFile(path, 'utf8')) as PromoteRecord;
    if (!isObject(record?.value)) return { kind: 'bad', path, problem: 'it holds no value object' };
    if (record.storedValue !== undefined && !isObject(record.storedValue)) return { kind: 'bad', path, problem: 'its storedValue is not an object' };
    return { kind: 'ok', path, record };
  } catch (e) {
    return { kind: 'bad', path, problem: (e as Error)?.message ?? String(e) };
  }
}

/**
 * The value an alert holds once its publish landed: what the re-read after the
 * write found (`storedValue`), else what was written. Verify, the rollback guard
 * and the drift check compare the live alert with this, so a field the server
 * normalised is not read as an edit.
 */
export function publishedValueOf(record: PromoteRecord): Record<string, unknown> {
  return record.storedValue ?? record.value;
}

/** Write a record as JSON, creating its folder. `wx` refuses to replace a file that exists. */
export async function writeRecord(path: string, data: unknown, flag?: 'wx'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), flag ? { flag } : undefined);
}

/** A UTC time as part of a file name, to the millisecond: `20261109T120000.123Z`. */
export function fileStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '');
}

/**
 * Move `<dir>/<id>.json` to `<dir>/<id>.<stamp>.json`, never over another file
 * (a second move in the same millisecond gets `-1`, `-2`, …). Returns the new path.
 */
export async function moveAside(path: string, at: Date): Promise<string> {
  const base = path.replace(/\.json$/, '');
  const stamp = fileStamp(at);
  let target = `${base}.${stamp}.json`;
  for (let n = 1; existsSync(target); n++) target = `${base}.${stamp}-${n}.json`;
  await rename(path, target);
  return target;
}

/** `rolled-back/<id>.json`. */
export function rolledBackPath(promoteDir: string, objectId: string): string {
  return join(promoteDir, 'rolled-back', `${objectId}.json`);
}

/** Record that a rollback put the alert back, replacing an earlier such record. */
export async function writeRolledBack(promoteDir: string, objectId: string, rolledBackAt: string): Promise<void> {
  await writeRecord(rolledBackPath(promoteDir, objectId), { objectId, rolledBackAt });
}

/**
 * The record a rollback left, or undefined when there is none. A file that
 * cannot be read still counts (the alert WAS rolled back), with no time.
 */
export async function readRolledBack(promoteDir: string, objectId: string): Promise<{ path: string; rolledBackAt?: string } | undefined> {
  const path = rolledBackPath(promoteDir, objectId);
  if (!existsSync(path)) return undefined;
  try {
    const rec = JSON.parse(await readFile(path, 'utf8')) as { rolledBackAt?: unknown };
    return typeof rec?.rolledBackAt === 'string' ? { path, rolledBackAt: rec.rolledBackAt } : { path };
  } catch {
    return { path };
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
