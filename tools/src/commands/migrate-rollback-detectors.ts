/**
 * migrate-rollback-detectors — undo a publish by migrate-promote-detectors: put
 * the query input and event fields an alert had before the publish back, from
 * its snapshot `migration/detector-promote/pre/<id>.json`.
 *
 * Only those two parts are written, and onto the CURRENT live value (see
 * `restoreValue`): everything else (threshold, enabled, the user it runs as,
 * other inputs) stays as it is live, so an owner's change since the publish
 * survives the rollback, and a snapshot older than the publish cannot revert a
 * field the publish never touched.
 *
 * Selection: rows of the alerts sheet with status `promoted` or `verified`, by
 * --ids and/or --batches (membership from the review manifest); one of the two
 * is required, so a rollback never takes every published alert.
 *
 * Per alert, one at a time:
 *   - no snapshot (an alert the tool recorded after someone had applied it by
 *     hand): refused, "no snapshot; cannot roll back"
 *   - read the live alert; already holding the snapshot's parts: recorded as
 *     rolled back, not written again (a re-run after a failed sheet write)
 *   - its query and event fields still what was published (`published/<id>.json`:
 *     what the server stored when the record has it, else what was sent)
 *     → restore; edited since, or no published record to check against →
 *     refused, saying what differs, unless --force (which needs --ids)
 *   - after a restore, or an "already rolled back" record, an apply leaves
 *     `detector-promote/rolled-back/<id>.json` ({ objectId, rolledBackAt }), so a
 *     stale save of the workbook showing the alert Ready cannot publish it again
 *
 * PREPARE (the default) reads the alerts and writes only files: plan.json and
 * the value each alert would get (payloads/<id>.json) under
 * migration/detector-rollback/prepare/<stamp>/. No tenant write, no workbook write.
 *
 * APPLY (--apply, with --allow-env naming the connected environment) also keeps
 * the value read just before each write (before/<id>.json; nothing is written
 * without it), writes with the update token of that read (never without one;
 * never retried: a 5xx or no answer is settled by one re-read), re-reads and
 * checks the restored parts. Any HTTP 401/403 stops further writes. One write to
 * the alerts sheet at the end, made even when the run stopped: rolled-back
 * alerts get status `rolled-back` and decision Needs Review (so the next publish
 * run leaves them alone until a person re-approves them); refused and skipped
 * ones get their reason. A failed sheet write never undoes a rollback; the
 * command names the ids to record.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  assertAllowedEnv,
  isAuthFailure,
  publishedPartsDiff,
  publishedPartsEqual,
  restoreValue,
  rollbackDecision,
  type PublishedTarget,
} from '../lib/detector-publish.ts';
import {
  loadPublishedTargets,
  promoteDirOf,
  publishedValueOf,
  readPromoteRecord,
  rolledBackPath,
  writeRolledBack,
} from '../lib/detector-promote-records.ts';
import type { DecisionState } from '../lib/decision-states.ts';
import { envIdFromBaseUrl } from '../lib/paths.ts';
import { ALERTS_SHEET, upsertRows, type TrackerRow } from '../lib/tracker-xlsx.ts';
import { SettingsApiError, SettingsClient, type SettingsObject } from '../dynatrace/settings.ts';
import { errText, reasonsText } from './migrate-promote-detectors.ts';

export interface RollbackDetectorsArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  /** The alerts workbook. Defaults to <outDir>/migration-tracker.xlsx. */
  trackerPath?: string;
  /** Review batches (`batch-NN`) to roll back. This or `ids` is required. */
  batches?: string[];
  ids?: string[];
  apply?: boolean;
  /** With --ids: restore named alerts although they were edited after publishing. */
  force?: boolean;
  /** With --apply: the environment id the token must be connected to. */
  allowEnv?: string;
}

export interface RollbackDeps {
  /** The two Settings calls a rollback makes. */
  settings?: Pick<SettingsClient, 'getObject' | 'putObject'>;
  /** Defaults to `upsertRows`. */
  upsert?: (path: string, rows: TrackerRow[], sheet: string) => Promise<unknown>;
  log?: (line: string) => void;
  now?: () => Date;
}

/** What a run did with one alert. plan.json is a list of these. */
export interface RollbackItem {
  objectId: string;
  title: string;
  batch?: string;
  /**
   * would-restore: prepare only, it would be written. rolled-back: written.
   * recorded: it already held the snapshot's parts, so only the sheet needs it.
   * refused: a rollback would discard an edit, or there is no snapshot.
   * skipped: it could not be written (read failed, no token, write refused).
   * not-attempted: the run stopped on an HTTP 401/403 at or before it.
   */
  result: 'would-restore' | 'rolled-back' | 'recorded' | 'refused' | 'skipped' | 'not-attempted';
  reasons: string[];
}

export interface RollbackRun {
  items: RollbackItem[];
  /** The rows given to the alerts sheet (none in prepare). */
  rows: TrackerRow[];
  /** False when the sheet write failed; the rollbacks stand. */
  recorded: boolean;
  /** Where plan.json, payloads/ and before/ were written. */
  runDir: string;
}

const COMMAND = 'migrate-rollback-detectors';
const STATUSES = ['promoted', 'verified'] as const;
const NEEDS_REVIEW: DecisionState = 'Needs Review';

interface Ctx {
  apply: boolean;
  force: boolean;
  promoteDir: string;
  runDir: string;
  settings: Pick<SettingsClient, 'getObject' | 'putObject'>;
  now: () => Date;
}

/** `query`, `event fields`, or both, with the verb that agrees. */
function partsPhrase(parts: string[], singular: string, plural: string): string {
  return `${parts.join(' and ')} ${parts.length === 1 && parts[0] === 'query' ? singular : plural}`;
}

async function writeJson(path: string, data: unknown, flag?: 'wx'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), flag ? { flag } : undefined);
}

/** Roll back one alert. Returns the HTTP 401/403 that must stop the run, if one came. */
async function rollbackOne(t: PublishedTarget, ctx: Ctx): Promise<{ item: RollbackItem; stop?: unknown }> {
  const id = t.objectId;
  const item: RollbackItem = { objectId: id, title: t.title, ...(t.batch ? { batch: t.batch } : {}), result: 'skipped', reasons: [] };
  const end = (result: RollbackItem['result'], reasons: string[], stop?: unknown) => {
    item.result = result;
    item.reasons = reasons;
    return { item, stop };
  };
  const forceHint = `--force --ids ${id}`;

  // 1. The snapshot: without it there is nothing to put back.
  const pre = await readPromoteRecord(ctx.promoteDir, 'pre', id);
  if (pre.kind === 'missing') {
    return end('refused', [
      `no snapshot; cannot roll back: there is no ${pre.path}. The tool snapshots an alert only when it writes it, ` +
        'so an alert it recorded after someone had applied the approved query by hand has none.',
    ]);
  }
  if (pre.kind === 'bad') return end('refused', [`no snapshot; cannot roll back: ${pre.path} could not be read (${pre.problem}).`]);
  const snapshot = pre.record.value;
  const published = await readPromoteRecord(ctx.promoteDir, 'published', id);

  // 2. The live alert, read in this run: its update token locks the write.
  let live: SettingsObject;
  try {
    live = await ctx.settings.getObject(id);
  } catch (e) {
    if (isAuthFailure(e)) return end('not-attempted', [`not rolled back: the run stopped here, the read was refused: ${errText(e)}`], e);
    if (e instanceof SettingsApiError && e.status === 404) return end('skipped', ['not rolled back: the alert no longer exists (HTTP 404).']);
    return end('skipped', [`not rolled back: the alert could not be read: ${errText(e)}`]);
  }
  const value = live.value ?? {};
  if (typeof value.title === 'string' && value.title.trim()) item.title = value.title;

  // 3. Already rolled back (a re-run after a failed sheet write): record only.
  if (publishedPartsEqual(value, snapshot)) {
    return end('recorded', ['already rolled back: the live alert already has the query and event fields of the snapshot, so it is recorded, not written again.']);
  }

  // 4. Edited since the publish? A rollback would discard that edit.
  const beforePath = join(ctx.runDir, 'before', `${id}.json`);
  const notes: string[] = [];
  if (published.kind !== 'ok') {
    const why = published.kind === 'missing' ? `no published record (${published.path})` : `the published record ${published.path} could not be read (${published.problem})`;
    if (!ctx.force) {
      return end('refused', [
        `not rolled back: ${why}, so an edit made after publishing cannot be ruled out. Once a person has checked the alert, restore it with ${forceHint}.`,
      ]);
    }
    notes.push(`--force: restored without a check for an edit made after publishing (${why}); the value before the rollback is in ${beforePath}.`);
  } else {
    // What the server stored when the record has it: a field it normalised is not an edit.
    const publishedValue = publishedValueOf(published.record);
    const parts = publishedPartsDiff(value, publishedValue);
    const what = `its ${partsPhrase(parts, 'no longer matches', 'no longer match')} what was published${published.record.publishedAt ? ` (${published.record.publishedAt})` : ''}`;
    if (rollbackDecision(value, publishedValue, ctx.force) === 'refuse-edited') {
      return end('refused', [
        `not rolled back: edited after publishing: ${what}, and a rollback would discard that edit. ` +
          `Once a person has checked it, restore the snapshot's query and event fields anyway with ${forceHint}; nothing else in the alert is written.`,
      ]);
    }
    if (parts.length) notes.push(`--force: restored although it was edited after publishing (${what}); the value before the rollback is in ${beforePath}.`);
  }

  // 5. The value to write: live, with the snapshot's query and event fields.
  let restore: Record<string, unknown>;
  try {
    restore = restoreValue(value, snapshot);
  } catch (e) {
    return end('skipped', [`not rolled back: ${errText(e)}`]);
  }
  const snapshotAt = pre.record.snapshotAt ?? 'unknown time';
  try {
    await writeJson(join(ctx.runDir, 'payloads', `${id}.json`), { objectId: id, title: item.title, value: restore });
  } catch (e) {
    notes.push(`the payload file could not be written (${errText(e)}).`);
  }
  if (!ctx.apply) {
    return end('would-restore', [`would restore the query and event fields of the snapshot of ${snapshotAt}; everything else stays as it is live.`, ...notes]);
  }

  // 6. The write, locked to the read above, never without its token.
  const updateToken = typeof live.updateToken === 'string' && live.updateToken ? live.updateToken : undefined;
  if (!updateToken) return end('skipped', ['no update token returned by the read; not written.']);
  try {
    await writeJson(beforePath, { objectId: id, title: item.title, readAt: ctx.now().toISOString(), value }, 'wx');
  } catch (e) {
    return end('skipped', [`not rolled back: the copy ${beforePath} of the value before the rollback could not be written (${errText(e)}), and nothing is written without one.`]);
  }
  // Never sent twice: a write that got no answer may have landed, so it is
  // settled by reading. A 5xx counts as no answer (a gateway 502/504 can come
  // back after the write was committed); only a 4xx is a definite refusal.
  const rolledBackAt = ctx.now().toISOString();
  let checked = false;
  try {
    await ctx.settings.putObject(id, { value: restore, updateToken, schemaVersion: typeof live.schemaVersion === 'string' ? live.schemaVersion : undefined });
  } catch (e) {
    if (isAuthFailure(e)) return end('not-attempted', [`not rolled back: the run stopped here, the write was refused: ${errText(e)}`], e);
    if (e instanceof SettingsApiError && e.status < 500) {
      const why = e.status === 409 ? ' (the alert changed between the read and the write)' : '';
      return end('skipped', [`not rolled back: the write was refused${why}: ${errText(e)}`]);
    }
    const noAnswer = e instanceof SettingsApiError ? `the write got a server error (${errText(e)})` : `the write got no answer (${errText(e)})`;
    let after: SettingsObject;
    try {
      after = await ctx.settings.getObject(id);
    } catch (e2) {
      return end(
        'skipped',
        [`${noAnswer} and the re-read after it failed too (${errText(e2)}), so whether it landed is unknown. Re-read the alert before re-running.`],
        isAuthFailure(e2) ? e2 : undefined,
      );
    }
    if (!publishedPartsEqual(after.value ?? {}, restore)) return end('skipped', [`not rolled back: ${noAnswer} and a re-read shows it did not land.`]);
    notes.push(`${noAnswer}, but a re-read shows it landed.`);
    checked = true;
  }

  // 7. Re-read and check the restored parts. A mismatch does not undo the write
  // (it went through); it is recorded and printed for a person.
  let stop: unknown;
  if (!checked) {
    try {
      const after = await ctx.settings.getObject(id);
      const parts = publishedPartsDiff(after.value ?? {}, restore);
      if (parts.length) {
        notes.push(`the re-read after the write does not show the restored ${parts.join(' and ')}: the stored value differs from what was written. Check the alert.`);
      }
    } catch (e) {
      notes.push(`the re-read after the write failed (${errText(e)}), so the stored value was not checked.`);
      if (isAuthFailure(e)) stop = e;
    }
  }
  return end(
    'rolled-back',
    [`rolled back ${rolledBackAt}: the query and event fields of the snapshot of ${snapshotAt} are restored; everything else is as it was live.`, ...notes],
    stop,
  );
}

/** The sheet row for an alert: rolled back → status and decision; refused or skipped → its reason; otherwise none. */
function sheetRow(i: RollbackItem): TrackerRow | undefined {
  const row: TrackerRow = { asset_id: i.objectId, asset_type: 'anomaly-detector', name: i.title };
  if (i.result === 'rolled-back' || i.result === 'recorded') return { ...row, status: 'rolled-back', decision: NEEDS_REVIEW, reasons: reasonsText(i.reasons) };
  if (i.result === 'refused' || i.result === 'skipped') return { ...row, reasons: reasonsText(i.reasons) };
  return undefined;
}

export async function runRollbackDetectors(args: RollbackDetectorsArgs, deps: RollbackDeps = {}): Promise<RollbackRun> {
  // A filter that reads as "no filter" would widen a rollback to every published alert.
  if (args.ids && !args.ids.length) throw new Error(`${COMMAND}: --ids names no alert id.`);
  if (args.batches && !args.batches.length) throw new Error(`${COMMAND}: --batches names no review batch.`);
  if (!args.ids?.length && !args.batches?.length) {
    throw new Error(`${COMMAND}: --ids <a,b> or --batches <list> is required: a rollback never takes every published alert.`);
  }
  if (args.force && !args.ids?.length) {
    throw new Error(`${COMMAND}: --force needs --ids: it restores alerts edited after publishing, discarding that edit, so it names them, never a whole batch.`);
  }
  const apply = args.apply === true;
  assertAllowedEnv(args.baseUrl, args.allowEnv, apply);

  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const upsert = deps.upsert ?? upsertRows;
  const trackerPath = args.trackerPath ?? join(args.outDir, 'migration-tracker.xlsx');
  const mode = apply ? 'apply' : 'prepare';
  const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const runDir = join(args.outDir, 'migration', 'detector-rollback', mode, stamp);

  const { targets } = await loadPublishedTargets({
    command: COMMAND,
    outDir: args.outDir,
    trackerPath,
    statuses: STATUSES,
    batches: args.batches,
    ids: args.ids,
    log,
  });
  const run: RollbackRun = { items: [], rows: [], recorded: true, runDir };
  if (!targets.length) {
    log(`Nothing to roll back: no alert with status promoted or verified on the alerts sheet of ${trackerPath} matches the selection.`);
    return run;
  }

  const ctx: Ctx = {
    apply,
    force: args.force === true,
    promoteDir: promoteDirOf(args.outDir),
    runDir,
    settings: deps.settings ?? new SettingsClient({ baseUrl: args.baseUrl, token: args.token }),
    now,
  };
  await mkdir(runDir, { recursive: true });
  log(`${apply ? 'Rolling back' : 'Preparing a rollback of'} ${targets.length} alert(s), one at a time…`);

  let stop: unknown;
  for (const t of targets) {
    if (stop) {
      run.items.push({ objectId: t.objectId, title: t.title, ...(t.batch ? { batch: t.batch } : {}), result: 'not-attempted', reasons: ['not rolled back: the run stopped before this alert.'] });
      continue;
    }
    const r = await rollbackOne(t, ctx);
    const i = r.item;
    run.items.push(i);
    // The mark a publish run checks: a sheet row saved before this rollback (a
    // stale save showing it Ready again) must not re-publish the alert.
    if (apply && (i.result === 'rolled-back' || i.result === 'recorded')) {
      try {
        await writeRolledBack(ctx.promoteDir, i.objectId, now().toISOString());
      } catch (e) {
        i.reasons.push(
          `the rollback record ${rolledBackPath(ctx.promoteDir, i.objectId)} could not be written (${errText(e)}); ` +
            'until a person writes it, a stale save of the workbook showing this alert Ready could publish it again.',
        );
      }
    }
    if (i.result === 'rolled-back') log(`  ✓ rolled back ${i.objectId} (${i.title})`);
    else if (i.result === 'recorded') log(`  = ${i.objectId} (${i.title}): already rolled back; recorded only`);
    else if (i.result === 'would-restore') log(`  would restore ${i.objectId} (${i.title})`);
    else log(`  ! ${i.objectId} (${i.title}): ${i.reasons[0] ?? i.result}`);
    if (i.result === 'rolled-back' || i.result === 'would-restore' || i.result === 'recorded') for (const note of i.reasons.slice(1)) log(`      ${note}`);
    if (r.stop) {
      stop = r.stop;
      log('  ! the token was refused. Stopping.');
    }
  }
  await writeFile(join(runDir, 'plan.json'), JSON.stringify(run.items, null, 2));

  const n = (r: RollbackItem['result']) => run.items.filter((i) => i.result === r).length;
  const notAttempted = run.items.filter((i) => i.result === 'not-attempted').map((i) => i.objectId);
  const stopText = (): string =>
    `${COMMAND}: the Settings API refused the token (${errText(stop)}). It needs settings:objects:read and settings:objects:write for builtin:davis.anomaly-detectors. ` +
    `Stopped; ${notAttempted.length} alert(s) not rolled back: ${notAttempted.join(', ')}.`;

  if (!apply) {
    log('');
    log(`${n('would-restore')} would be rolled back, ${n('recorded')} already rolled back, ${n('refused')} refused, ${n('skipped')} skipped, of ${run.items.length}.`);
    log(`Plan and payloads: ${runDir}. Nothing was written to the tenant or the workbook. Re-run with --apply --allow-env ${envIdFromBaseUrl(args.baseUrl)} to write.`);
    if (stop) throw new Error(stopText());
    return run;
  }

  // One sheet write for every alert the run decided, the ones before a stop included.
  run.rows = run.items.map(sheetRow).filter((r): r is TrackerRow => r !== undefined);
  if (run.rows.length) {
    try {
      await upsert(trackerPath, run.rows, ALERTS_SHEET);
      log(`Recorded ${run.rows.length} row(s) on the ${ALERTS_SHEET} sheet of ${trackerPath}.`);
    } catch (e) {
      run.recorded = false;
      const msg = (e as Error)?.message ?? String(e);
      const ids = run.rows.filter((r) => r.status === 'rolled-back').map((r) => r.asset_id);
      if (ids.length) {
        log(`\n  ! Rolled back, but could not write the tracker (${msg}).`);
        log(
          `    Close ${trackerPath} and re-run with --apply --ids ${ids.join(',')} --allow-env ${envIdFromBaseUrl(args.baseUrl)} to record them: ` +
            'a re-run finds them already rolled back and records them without writing again.',
        );
      } else {
        log(`\n  ! Could not write the tracker (${msg}). Nothing was rolled back in this run; the reasons are in ${join(runDir, 'plan.json')}.`);
      }
    }
  }

  log('');
  log(
    `${n('rolled-back')} rolled back, ${n('recorded')} already rolled back (recorded only), ${n('refused')} refused, ${n('skipped')} skipped` +
      `${notAttempted.length ? `, ${notAttempted.length} not attempted (the run stopped)` : ''}, of ${run.items.length}.`,
  );
  log(`Plan, payloads and the values before each write: ${runDir}.`);
  if (stop) throw new Error(stopText());
  return run;
}
