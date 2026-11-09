/**
 * migrate-verify-detectors — confirm each published alert still holds what
 * migrate-promote-detectors wrote: re-read it and compare its query input and
 * event fields with its record, `migration/detector-promote/published/<id>.json`.
 * Other fields (threshold, enabled, the user it runs as) are not compared: a
 * publish never writes them, so an owner may change them freely.
 *
 * Selection: rows of the alerts sheet with status `promoted`, narrowed by
 * --batches (membership from the review manifest) and/or --ids.
 *
 * It checks the configuration only. It never waits for, or counts, alert events:
 * many alerts never reach their condition in any reasonable time.
 *
 * Tenant: reads only. Workbook: written without --apply, as the dashboard
 * migrate-verify does, in one write at the end:
 *   equal            status `verified`, `verified_at` (and an earlier verify flag
 *                    in `reasons` cleared)
 *   different        a flag in `reasons`; the status is left as it is
 *   no record        "no published record" in `reasons`; the status is left as it
 *                    is (the tool recorded the alert without writing it)
 * Any HTTP 401/403 stops further reads; what was checked still reaches the sheet.
 */

import { join } from 'node:path';

import { isAuthFailure, publishedPartsDiff, type PublishedTarget } from '../lib/detector-publish.ts';
import { loadPublishedTargets, promoteDirOf, readPromoteRecord } from '../lib/detector-promote-records.ts';
import { ALERTS_SHEET, upsertRows, type TrackerRow } from '../lib/tracker-xlsx.ts';
import { SettingsApiError, SettingsClient, type SettingsObject } from '../dynatrace/settings.ts';
import { errText } from './migrate-promote-detectors.ts';

export interface VerifyDetectorsArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  /** The alerts workbook. Defaults to <outDir>/migration-tracker.xlsx. */
  trackerPath?: string;
  /** Review batches (`batch-NN`) to verify; default every promoted alert. */
  batches?: string[];
  ids?: string[];
}

export interface VerifyDeps {
  /** The one Settings call a verify makes. */
  settings?: Pick<SettingsClient, 'getObject'>;
  /** Defaults to `upsertRows`. */
  upsert?: (path: string, rows: TrackerRow[], sheet: string) => Promise<unknown>;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface VerifyRun {
  verified: string[];
  /** Differs, has no published record, or could not be checked: see each row's `reasons`. */
  flagged: string[];
  /** Selected but not read because the run stopped. */
  notChecked: string[];
  rows: TrackerRow[];
  /** False when the sheet write failed. */
  recorded: boolean;
}

/** Every reason a verify writes starts with this, so a later verify that passes can clear it. */
export const VERIFY_FLAG_PREFIX = 'verify: ';

const STATUSES = ['promoted'] as const;

function partsText(parts: string[]): string {
  return parts.join(' and ');
}

/** Check one alert. Returns its row, and the 401/403 that must stop the run, if one came. */
async function verifyOne(
  t: PublishedTarget,
  ctx: { promoteDir: string; settings: Pick<SettingsClient, 'getObject'>; now: () => Date; currentReasons: string },
): Promise<{ row?: TrackerRow; verified?: boolean; stop?: unknown }> {
  const row: TrackerRow = { asset_id: t.objectId, asset_type: 'anomaly-detector', name: t.title };
  const flag = (reason: string) => ({ row: { ...row, reasons: `${VERIFY_FLAG_PREFIX}${reason}` }, verified: false });

  const rec = await readPromoteRecord(ctx.promoteDir, 'published', t.objectId);
  if (rec.kind === 'missing') {
    return flag(
      `no published record (${rec.path}): the tool recorded this alert without writing it, so there is nothing to compare it with. Status left as it is.`,
    );
  }
  if (rec.kind === 'bad') return flag(`the published record ${rec.path} could not be read (${rec.problem}). Status left as it is.`);

  let live: SettingsObject;
  try {
    live = await ctx.settings.getObject(t.objectId);
  } catch (e) {
    if (isAuthFailure(e)) return { stop: e };
    if (e instanceof SettingsApiError && e.status === 404) return flag('the alert no longer exists (HTTP 404).');
    return flag(`the alert could not be read: ${errText(e)}. Status left as it is.`);
  }
  const value = live.value ?? {};
  if (typeof value.title === 'string' && value.title.trim()) row.name = value.title;

  const parts = publishedPartsDiff(value, rec.record.value);
  if (parts.length) {
    const when = rec.record.publishedAt ? ` (published ${rec.record.publishedAt})` : '';
    return flag(
      `the live alert does not have the published ${partsText(parts)}${when}: someone edited it since, or the write did not stick. ` +
        `Checked ${ctx.now().toISOString()}; status left as it is.`,
    );
  }
  const verifiedRow: TrackerRow = { ...row, status: 'verified', verified_at: ctx.now().toISOString() };
  // A flag an earlier verify left would contradict the status now.
  if (ctx.currentReasons.startsWith(VERIFY_FLAG_PREFIX)) verifiedRow.reasons = '';
  return { row: verifiedRow, verified: true };
}

export async function runVerifyDetectors(args: VerifyDetectorsArgs, deps: VerifyDeps = {}): Promise<VerifyRun> {
  // A filter that reads as "no filter" would widen the run to every promoted alert.
  if (args.ids && !args.ids.length) throw new Error('migrate-verify-detectors: --ids names no alert id.');
  if (args.batches && !args.batches.length) throw new Error('migrate-verify-detectors: --batches names no review batch.');

  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const upsert = deps.upsert ?? upsertRows;
  const trackerPath = args.trackerPath ?? join(args.outDir, 'migration-tracker.xlsx');
  const promoteDir = promoteDirOf(args.outDir);

  const { targets, rows: sheet } = await loadPublishedTargets({
    command: 'migrate-verify-detectors',
    outDir: args.outDir,
    trackerPath,
    statuses: STATUSES,
    batches: args.batches,
    ids: args.ids,
    log,
  });
  const run: VerifyRun = { verified: [], flagged: [], notChecked: [], rows: [], recorded: true };
  if (!targets.length) {
    log(`Nothing to verify: no alert with status promoted on the alerts sheet of ${trackerPath}${args.batches || args.ids ? ' matches the selection' : ''}.`);
    return run;
  }

  const settings = deps.settings ?? new SettingsClient({ baseUrl: args.baseUrl, token: args.token });
  log(`Verifying ${targets.length} published alert(s)…`);
  let stop: unknown;
  for (const t of targets) {
    if (stop) {
      run.notChecked.push(t.objectId);
      continue;
    }
    // The reasons the row has now, to tell an earlier verify flag from a publish note.
    const r = await verifyOne(t, { promoteDir, settings, now, currentReasons: sheet.get(t.objectId)?.reasons ?? '' });
    if (r.stop) {
      stop = r.stop;
      run.notChecked.push(t.objectId);
      log(`  ! ${t.objectId} (${t.title}): the read was refused: ${errText(r.stop)}. Stopping.`);
      continue;
    }
    run.rows.push(r.row!);
    if (r.verified) {
      run.verified.push(t.objectId);
      log(`  ✓ ${t.objectId} (${r.row!.name}) verified`);
    } else {
      run.flagged.push(t.objectId);
      log(`  ! ${t.objectId} (${r.row!.name}): ${r.row!.reasons!.slice(VERIFY_FLAG_PREFIX.length)}`);
    }
  }

  if (run.rows.length) {
    try {
      await upsert(trackerPath, run.rows, ALERTS_SHEET);
      log(`Recorded ${run.rows.length} row(s) on the ${ALERTS_SHEET} sheet of ${trackerPath}.`);
    } catch (e) {
      run.recorded = false;
      log(`\n  ! Nothing changed on the tenant, but could not write the tracker (${(e as Error)?.message ?? String(e)}).`);
      if (run.verified.length) log(`    Verified: ${run.verified.join(',')}`);
      if (run.flagged.length) log(`    Flagged: ${run.flagged.join(',')}`);
      log(`    Close ${trackerPath} and re-run migrate-verify-detectors to record them.`);
    }
  }

  log('');
  log(
    `Verified ${run.verified.length} of ${targets.length}; ${run.flagged.length} flagged (see reasons on the sheet)` +
      `${run.notChecked.length ? `; ${run.notChecked.length} not checked (the run stopped)` : ''}.`,
  );
  if (stop) {
    throw new Error(
      `migrate-verify-detectors: the Settings API refused the token (${errText(stop)}). It needs settings:objects:read for builtin:davis.anomaly-detectors. ` +
        `Stopped; ${run.notChecked.length} alert(s) not checked: ${run.notChecked.join(', ')}.`,
    );
  }
  return run;
}
