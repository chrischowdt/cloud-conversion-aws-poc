/**
 * migrate-promote-detectors — publish reviewer-approved Davis anomaly detectors
 * IN PLACE: same settings object, same id, the approved query in its query input
 * and its event fields pointed at the columns that query emits. Nothing else in
 * the detector changes (threshold, enabled, title, the user it runs as).
 *
 * Selection: rows of the alerts sheet whose `decision` is Ready To Publish, in
 * the review batches named by --batches (membership from the stage-detectors
 * manifest), not already published. `--ids` narrows, `--limit` caps.
 *
 * Every read is live: the approved query from the batch's review notebook (by the
 * tile's marker line), the detector from the Settings API, and every known copy
 * of the classic query the card was staged from: the base payload `<batch>.json`,
 * the archived payload of that name and the tile's reference block. Then the
 * gates, in order; the first failure decides: empty query, drift (the live query
 * equals none of those copies: the owner edited or migrated the alert since
 * staging; or no copy is known), blocking
 * lint, the approved query fails over the last 2 hours, the entity (an approved
 * query that emits none: the 7-day binding check plus the reviewer's
 * `publish_override`), at most 10,000 series over the last 2 hours, event fields
 * that name a column the query does not emit, the query to publish (with the
 * columns added for its event fields) fails over 2 hours, and the server's own
 * validation (`validateOnly`, which persists nothing). An alert whose live value
 * already has the query and event fields a publish would write is recorded, not
 * written; one that already runs the approved query but lacks the event fields
 * is an event-field-only update.
 *
 * PREPARE (the default) writes only files under
 * migration/detector-promote/prepare/<stamp>/: plan.json, report.md and the
 * value each ready alert would get (payloads/<objectId>.json). No tenant write,
 * no workbook write: the workbook is a file reviewers keep open.
 *
 * APPLY (--apply, with --allow-env naming the connected environment) plans the
 * same way, from fresh reads in the same run, never from files an earlier
 * prepare left. Then, for each alert the plan marks ready, one at a time:
 * re-read it and leave it alone if anything in it changed since planning;
 * snapshot it to migration/detector-promote/pre/<objectId>.json (an existing
 * snapshot is kept while its query and event fields still equal live, a retry;
 * otherwise it is moved aside and a fresh one taken); write
 * published/<objectId>.pending.json; write the planned value with the update
 * token of that re-read, and none without one (never retried: a write that got
 * no answer or a 5xx is settled by reading); re-read and check the stored query
 * and event fields; rename the pending record to published/<objectId>.json, with
 * what the re-read found as `storedValue`; move a rollback's
 * rolled-back/<objectId>.json aside. Any HTTP 401/403 stops further writes. One
 * write to the alerts sheet at the end: published and recorded alerts become
 * promoted / Published, skipped ones get their reason. A failed sheet write never
 * undoes a publish; the command names the ids to record.
 *
 * An alert an applied rollback left a `rolled-back/` record for is skipped while
 * its sheet row's status is not `rolled-back`: such a row was saved before the
 * rollback (a stale save of the workbook), so its Ready decision is not news.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { REPO_ROOT, SKILL_DAC_AWS_METRICS, SKILL_MANUAL_AWS_METRICS, SKILL_PER_KEY_AWS_METRICS, envIdFromBaseUrl } from '../lib/paths.ts';
import { liveMetricsPathIfPresent } from '../lib/live-metrics.ts';
import { mzTagsPathIfPresent } from '../lib/mz-tags.ts';
import { enrichedTagsPathIfPresent } from '../lib/enriched-tags.ts';
import { entityArnsPathIfPresent } from '../lib/entity-arns.ts';
import { entityCandidatesPathIfPresent } from '../lib/entity-candidates.ts';
import { loadRecipeIndex, type RecipeIndex } from '../lib/recipe-lookup.ts';
import { rewriteDql } from '../lib/dql-rewriter.ts';
import { lintQuery } from '../lib/output-lint.ts';
import { detectorQuery, type EventTemplateChange } from '../lib/detector-rewrite.ts';
import { DAVIS_SERIES_CAP, SOURCE_ID_DIM, emittedEntityColumn, resolveBinding, type BindingOutcome } from '../lib/detector-binding.ts';
import { isEffectivelyEmpty, parseReviewQuery } from '../lib/detector-notebook.ts';
import {
  assertAllowedEnv,
  buildPublishValue,
  decideEntity,
  detectorValuesEqual,
  driftOf,
  findApprovedTile,
  isAuthFailure,
  mapEventFields,
  publishedPartsEqual,
  selectForPublish,
  stagedQueriesOf,
  staticColumns,
  whyNotSelected,
  withColumnAliases,
  withNodeNameColumn,
  type Drift,
  type StagedFrom,
  type EventProp,
  type ManifestBatch,
  type PublishCandidate,
} from '../lib/detector-publish.ts';
import {
  moveAside,
  publishedValueOf,
  readPromoteRecord,
  readRolledBack,
  recordPath,
  rolledBackPath,
  writeRecord,
  type PromoteRecord,
} from '../lib/detector-promote-records.ts';
import { PUBLISHED, PUBLISH_OVERRIDES, type PublishOverride } from '../lib/decision-states.ts';
import { ALERTS_SHEET, readRows, upsertRows, type TrackerRow } from '../lib/tracker-xlsx.ts';
import { DqlClient, DqlError, type DqlResult } from '../dynatrace/dql.ts';
import { DocumentApiError, DocumentClient } from '../dynatrace/document.ts';
import { SettingsApiError, SettingsClient, type SettingsObject } from '../dynatrace/settings.ts';

export interface PromoteDetectorsArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  /** The alerts workbook. Defaults to <outDir>/migration-tracker.xlsx. */
  trackerPath?: string;
  /** Review batches to publish from (`batch-NN`). Required. */
  batches: string[];
  ids?: string[];
  limit?: number;
  apply?: boolean;
  /** With --ids: publish a named alert even though its owner changed it after review. */
  force?: boolean;
  /** With --apply: the environment id the token must be connected to. */
  allowEnv?: string;
}

/** What a run decided for one alert. plan.json is a list of these. */
export interface PublishPlanItem {
  objectId: string;
  title: string;
  batch: string;
  /**
   * ready: passes every gate and differs from live (after an apply: not written,
   * because the run stopped). recorded: the live alert already has exactly what a
   * publish would write, so only the sheet needs it. published: an apply wrote it.
   * skipped: see reasons.
   */
  result: 'ready' | 'skipped' | 'recorded' | 'published';
  /** Why it was skipped (first entry), or notes about how it goes out. */
  reasons: string[];
  /** The reviewer's override, when the alert's entity decision went through it. */
  override?: PublishOverride;
  /** Series the query to publish produced over the last 2 hours, the scale Davis evaluates at (at most the cap + 1). */
  series?: number;
  /** The entity column the published query emits and the binding property names. */
  entityColumn?: string;
  /** The copies of the staged classic query (see `stagedQueriesOf`) the live query still equals: why it is not drift. Empty when it equals none. */
  stagedFrom?: StagedFrom[];
  diff: { query?: { before: string; after: string }; fields: EventTemplateChange[] };
}

/** The payload file of an alert: what an apply would PUT, and the live query it was planned against. */
export interface PayloadFile {
  objectId: string;
  title: string;
  batch: string;
  /** The live query when this was planned; an apply skips the alert if it changed since. */
  liveQuery: string;
  /** The review tile's query the value was built from; kept in the published record. */
  approvedQuery?: string;
  schemaVersion?: string;
  value: Record<string, unknown>;
}

/** One planned alert plus what only this run needs: the summary label and the payload. */
export interface Outcome {
  item: PublishPlanItem;
  /** Short label the report groups skipped alerts by. */
  gate: string;
  payload?: PayloadFile;
  /** The whole live value the payload was built from; an apply writes nothing if the alert differs from it. */
  liveValue?: Record<string, unknown>;
  /** When an apply wrote it. */
  publishedAt?: string;
}

const SEVEN_DAYS_MS = 7 * 864e5;
const TWO_HOURS_MS = 2 * 36e5;
const CONCURRENCY = 4;
const CAP_TEXT = DAVIS_SERIES_CAP.toLocaleString('en-US');

const DRIFT_TEXT: Record<Exclude<Drift, 'none' | 'already-published'>, { gate: string; reason: string }> = {
  edited: {
    gate: 'drift: owner changed the alert after review',
    reason:
      'owner changed the alert after review: its live query is no longer the classic one the card was staged from. ' +
      'Once a reviewer confirms the approved query covers the change, publish it with --force --ids <id>.',
  },
  'owner-migrated': {
    gate: 'drift: owner already migrated it',
    reason: 'owner already migrated it: its live query changed after review and has no classic references left.',
  },
  unknown: {
    gate: 'drift: staged version unknown',
    reason:
      'staged version unknown: the classic query the card was staged from is in none of the base payload, the archived payload and the tile, ' +
      'so an owner edit since staging cannot be ruled out.',
  },
};

/** The report's label for an alert the entity decision sent back, by the binding check's outcome. */
const NO_ENTITY_GATE: Partial<Record<BindingOutcome['kind'], string>> = {
  'per-entity': 'no entity: would fire per resource, back for review',
  'too-many': `over the series cap once the entity is added`,
  skipped: 'no entity: the query shape cannot take one',
  error: 'no entity: the binding check failed',
  already: 'no entity: the binding check found one the publish cannot use',
};

/** The note a bound query carries, by the binding check's outcome. */
function bindingNote(kind: BindingOutcome['kind'], override?: PublishOverride): string {
  const added = `added \`${SOURCE_ID_DIM}\` to the split`;
  if (kind === 'per-entity') return `${added}; it now fires once per resource (publish_override "${overrideLabel('per-resource')}").`;
  if (kind === 'unverified') return `${added}; no data in the last 7 days to prove the alert's grain is unchanged.`;
  if (kind === 'bound') return `${added}; the series count is unchanged, so the alert's grain is too.`;
  return `${added} (${kind}${override ? `, publish_override "${overrideLabel(override)}"` : ''}).`;
}

function overrideLabel(o: PublishOverride): string {
  return o === 'per-resource' ? PUBLISH_OVERRIDES[0] : PUBLISH_OVERRIDES[1];
}

function clip(s: string, n = 300): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/** The message a person needs from an API error: the server's own words, not the URL. */
export function errText(e: unknown): string {
  const fromBody = (body: string): string | undefined => {
    try {
      const j = JSON.parse(body) as {
        error?: { message?: string; details?: { errorMessage?: string }; constraintViolations?: Array<{ path?: string; message?: string }> };
      };
      const err = j.error;
      if (!err) return undefined;
      const violations = (err.constraintViolations ?? []).map((v) => `${v.path ? `${v.path}: ` : ''}${v.message ?? ''}`);
      return [err.details?.errorMessage ?? err.message, ...violations].filter(Boolean).join('; ') || undefined;
    } catch {
      return undefined;
    }
  };
  if (e instanceof DqlError) {
    const headline = e.notifications?.find((n) => n.severity === 'ERROR')?.message;
    return clip(headline ?? fromBody(e.body) ?? e.message);
  }
  if (e instanceof SettingsApiError || e instanceof DocumentApiError) {
    return `HTTP ${e.status}: ${clip(fromBody(e.body) ?? e.body)}`;
  }
  return clip((e as Error)?.message ?? String(e));
}

/** Every column a run reports: record keys and the result type metadata. */
function columnsOf(r: DqlResult): Set<string> {
  const out = new Set<string>();
  for (const rec of r.records ?? []) for (const k of Object.keys(rec ?? {})) out.add(k);
  for (const t of r.types ?? []) for (const k of Object.keys(t?.mappings ?? {})) out.add(k);
  return out;
}

/** `{dims:x}` (in event.name, event.description) for each unresolved placeholder. */
function unresolvedText(unresolved: string[], props: EventProp[]): string {
  return unresolved
    .map((p) => {
      const keys = props.filter((x) => typeof x?.value === 'string' && x.value.includes(p)).map((x) => String(x.key ?? '?'));
      return keys.length ? `${p} (in ${keys.join(', ')})` : p;
    })
    .join(', ');
}

type Sections = Array<{ id?: string; type?: string; state?: { input?: { value?: string } } }>;

/** A payload file's sections, or why a file that exists could not be read. Absent file: neither. */
interface PayloadRead {
  sections?: Sections;
  problem?: string;
}

/** An earlier apply's records of one alert, each only when it could be read. */
export interface EarlierRecords {
  /** `published/<id>.json`: what an earlier publish wrote, and what the server stored. */
  published?: PromoteRecord;
  /** `published/<id>.pending.json`: a write that may have landed (no answer and no re-read, or a crash). */
  pending?: PromoteRecord;
  /** Why a record file that exists could not be read. */
  problems: string[];
}

/** What planning one alert reads, injectable so every gate can be tested without a tenant. */
export interface PlanCtx {
  /** `--force` and `--ids`: a drifted alert is published only when both name it. */
  args: Pick<PromoteDetectorsArgs, 'force' | 'ids'>;
  /** For telling an owner-migrated alert from an owner edit. */
  index: RecipeIndex;
  /** Reads the live alert; `putObject` is only ever called with `validateOnly`. */
  settings: Pick<SettingsClient, 'getObject' | 'putObject'>;
  run: (query: string, windowMs: number) => Promise<DqlResult>;
  sections: (notebookId: string) => Promise<Sections>;
  /** A batch's base payload (`detector-review/`) or archived one (`detector-review-archive/`). */
  payload: (kind: 'base' | 'archive', batch: string) => Promise<PayloadRead>;
  records: (objectId: string) => Promise<EarlierRecords>;
  /** The record an applied rollback left (`rolled-back/<id>.json`), when there is one. */
  rolledBack: (objectId: string) => Promise<{ rolledBackAt?: string } | undefined>;
}

const STAGED_FROM_TEXT: Record<StagedFrom, string> = {
  base: 'the base payload',
  archive: 'the archived payload',
  tile: 'the notebook tile',
};

/** Read everything one alert needs and run its gates. Throws only on an auth failure. */
export async function planOne(c: PublishCandidate, ctx: PlanCtx): Promise<Outcome> {
  const item: PublishPlanItem = { objectId: c.objectId, title: c.title, batch: c.batch, result: 'skipped', reasons: [], diff: { fields: [] } };
  const notes: string[] = c.note ? [c.note] : [];
  const skip = (gate: string, reason: string, payload?: PayloadFile): Outcome => {
    item.result = 'skipped';
    item.reasons = [reason, ...notes];
    return { item, gate, payload };
  };

  // 1. The approved query, from the live review notebook.
  let sections: Sections;
  try {
    sections = await ctx.sections(c.notebookId);
  } catch (e) {
    if (isAuthFailure(e)) throw e;
    return skip('review notebook could not be read', `the review notebook ${c.notebookId} could not be read: ${errText(e)}`);
  }
  const tile = findApprovedTile(sections, c.objectId);
  if ('error' in tile) return skip(tile.error, `${tile.error} in review notebook ${c.notebookId}.`);
  const approved = parseReviewQuery(tile.value).query;

  // 2. The live alert.
  let live: SettingsObject;
  try {
    live = await ctx.settings.getObject(c.objectId);
  } catch (e) {
    if (isAuthFailure(e)) throw e;
    if (e instanceof SettingsApiError && e.status === 404) return skip('the alert no longer exists', 'the alert no longer exists (HTTP 404).');
    return skip('the alert could not be read', `the alert could not be read: ${errText(e)}`);
  }
  const value = live.value ?? {};
  if (typeof value.title === 'string' && value.title.trim()) item.title = value.title;
  const liveQuery = detectorQuery(value);
  if (liveQuery === undefined) return skip('the alert has no query input', 'the live alert has no query input, so there is nowhere to put the approved query.');
  const records = await ctx.records(c.objectId);
  notes.push(...records.problems);

  // A rollback newer than the sheet row: a stale save of the workbook (made
  // before the rollback) shows the row as Ready again. A re-approval after the
  // rollback keeps the tool's status `rolled-back`.
  const rolledBack = await ctx.rolledBack(c.objectId);
  if (rolledBack && c.status !== 'rolled-back') {
    return skip(
      'rolled back since the sheet row was saved',
      `rolled back on ${rolledBack.rolledBackAt ?? 'an unknown date'}; the sheet row looks older than that — re-approve it after the rollback ` +
        `(its status is ${c.status ? `"${c.status}"` : 'empty'}, not rolled-back).`,
    );
  }

  // 3. Every known copy of the classic query the card was staged from: base
  // payload, archived payload, live tile.
  const [base, archive] = await Promise.all([ctx.payload('base', c.batch), ctx.payload('archive', c.batch)]);
  for (const [kind, read] of [['base payload', base], ['archived payload', archive]] as const) {
    if (read.problem) notes.push(`the ${kind} of ${c.batch} could not be read (${read.problem}).`);
  }
  const staged = stagedQueriesOf(c.objectId, { base: base.sections, archive: archive.sections, tileValue: tile.value });
  item.stagedFrom = staged.filter((s) => s.query.trim() === liveQuery.trim()).map((s) => s.from);

  // Empty first: an empty approved query must never reach the drift check, where
  // it would read as "already published" against an empty live query.
  if (isEffectivelyEmpty(approved)) {
    return skip('empty query', 'empty query: the approved tile holds nothing but comments and whitespace.');
  }
  item.diff.query = { before: liveQuery, after: approved };

  // Gate 1: drift. "already-published" goes on through the gates: whether
  // anything is left to write is decided by comparing the payload with live.
  let liveIsMigrated = false;
  try {
    liveIsMigrated = rewriteDql(liveQuery, ctx.index).rewritten === liveQuery;
  } catch {
    /* unreadable to the rewriter: read as an owner edit, the more cautious reason */
  }
  const drift = driftOf({
    liveQuery,
    stagedQueries: staged.map((s) => s.query),
    approvedQuery: approved,
    // What the server stored when the record has it, else what was sent; and a write that may have landed.
    publishedQueries: [
      records.published ? detectorQuery(publishedValueOf(records.published)) : undefined,
      records.pending ? detectorQuery(records.pending.value) : undefined,
    ].filter((q): q is string => typeof q === 'string'),
    liveIsMigrated,
  });
  if (drift !== 'none' && drift !== 'already-published') {
    const text = DRIFT_TEXT[drift];
    const where = staged.length ? `(compared with ${staged.map((s) => STAGED_FROM_TEXT[s.from]).join(', ')}; it matches none)` : '';
    const forced = ctx.args.force === true && (ctx.args.ids ?? []).includes(c.objectId);
    if (!forced) return skip(text.gate, `${text.reason}${where ? ` ${where}` : ''}`);
    notes.push(`${text.gate.replace(/^drift: /, '')}${where ? ` ${where}` : ''}; published anyway: --force with --ids names it.`);
  }

  // Every query text that ran without error in this plan; a final query that is
  // none of them runs once more before it can go out.
  const ranOk = new Set<string>();
  const run = async (q: string, windowMs: number): Promise<DqlResult> => {
    const r = await ctx.run(q, windowMs);
    ranOk.add(q);
    return r;
  };

  // Gate 3: blocking lint.
  const blocking = lintQuery(approved).filter((f) => f.severity === 'blocking');
  if (blocking.length) {
    return skip('blocking lint', `blocking lint: ${blocking.map((f) => `${f.ruleId} (${clip(f.message, 160)})`).join('; ')}`);
  }

  // Gate 4: the approved query runs.
  let run2h: DqlResult;
  try {
    run2h = await run(approved, TWO_HOURS_MS);
  } catch (e) {
    if (isAuthFailure(e)) throw e;
    return skip('the query fails on the tenant', `the approved query fails on the tenant over the last 2 hours: ${errText(e)}`);
  }

  // Gate 5: the entity. One 7-day run per query text, shared by the binding
  // check and the column read below.
  const runs7d = new Map<string, Promise<DqlResult>>();
  const run7d = (q: string): Promise<DqlResult> => {
    let p = runs7d.get(q);
    if (!p) {
      p = run(q, SEVEN_DAYS_MS);
      runs7d.set(q, p);
    }
    return p;
  };
  let finalQuery = approved;
  let entityColumn = emittedEntityColumn(approved);
  if (!entityColumn) {
    const outcome = await resolveBinding(approved, async (q) => (await run7d(q)).records.length, 'the last 7 days');
    const decision = decideEntity(outcome, c.override);
    if (c.override) item.override = c.override;
    if (decision.action === 'skip') return skip(NO_ENTITY_GATE[outcome.kind] ?? `no entity (${outcome.kind})`, decision.reason);
    if (decision.action === 'use-bound') {
      finalQuery = decision.query;
      entityColumn = emittedEntityColumn(finalQuery);
      if (!entityColumn) {
        return skip('no entity: binding not readable', 'the binding check added an entity the publish cannot find in the query, so it goes back for review.');
      }
      notes.push(bindingNote(outcome.kind, c.override));
    } else {
      notes.push(`published without an entity (publish_override "${overrideLabel('without-entity')}").`);
    }
  } else if (c.override) {
    notes.push(`publish_override "${overrideLabel(c.override)}" not needed: the query already emits \`${entityColumn}\`.`);
  }

  // The series cap, at the scale Davis evaluates: the last 2 hours of the query
  // to publish (the gate-4 run when no entity was added).
  let final2h: DqlResult;
  if (finalQuery === approved) {
    final2h = run2h;
  } else {
    try {
      final2h = await run(finalQuery, TWO_HOURS_MS);
    } catch (e) {
      if (isAuthFailure(e)) throw e;
      return skip('the query fails on the tenant', `the query to publish fails on the tenant over the last 2 hours: ${errText(e)}`);
    }
  }
  item.series = final2h.records.length;
  if (final2h.records.length > DAVIS_SERIES_CAP) {
    return skip('over the series cap', `produces more than ${CAP_TEXT} series over the last 2 hours, the most one Davis detector monitors.`);
  }

  // Gate 6: the columns the query emits: its 7-day run, else its 2-hour run,
  // else its text.
  let columns: Set<string>;
  try {
    columns = columnsOf(await run7d(finalQuery));
  } catch (e) {
    if (isAuthFailure(e)) throw e;
    columns = columnsOf(final2h);
    notes.push(`the 7-day run failed (${errText(e)}), so the columns come from the 2-hour run.`);
  }
  if (!columns.size) columns = columnsOf(final2h);
  if (!columns.size) {
    columns = staticColumns(finalQuery);
    notes.push('no data to read the columns from; event fields were checked against the columns the query text names.');
  }

  // Gate 7: every event field reads a column the query emits.
  const liveProps = (value.eventTemplate as { properties?: unknown } | undefined)?.properties;
  const props: EventProp[] = Array.isArray(liveProps) ? liveProps : [];
  const mapped = mapEventFields(props, {
    columns,
    entityColumn,
    withoutEntity: c.override === 'without-entity',
  });
  item.entityColumn = entityColumn;
  item.diff.fields = mapped.changes;

  // Step 8: the columns the event fields read that the query does not emit yet:
  // the entity's name, then aliases for column names with whitespace in them.
  if (mapped.nameColumn && entityColumn && !columns.has(mapped.nameColumn)) {
    finalQuery = withNodeNameColumn(finalQuery, entityColumn);
  }
  const aliases = mapped.aliases.filter((a) => !columns.has(a.alias));
  if (aliases.length) {
    finalQuery = withColumnAliases(finalQuery, aliases);
    notes.push(`event fields read ${aliases.map((a) => `\`${a.column}\` as ${a.alias}`).join(', ')}: a column name with whitespace is not known to fill a placeholder.`);
  }
  item.diff.query = { before: liveQuery, after: finalQuery };

  if (mapped.unresolved.length) {
    return skip(
      'event field names a column the query does not emit',
      `event fields name columns the approved query does not emit: ${unresolvedText(mapped.unresolved, props)}. ` +
        'Make the query emit the column, in the review notebook.',
    );
  }

  // The added columns never ran: run the query that would go out once.
  if (!ranOk.has(finalQuery)) {
    try {
      await run(finalQuery, TWO_HOURS_MS);
    } catch (e) {
      if (isAuthFailure(e)) throw e;
      return skip('the query fails on the tenant', `the query to publish fails on the tenant over the last 2 hours: ${errText(e)}`);
    }
  }

  // Gate 9: the value; nothing to write when live already has it; else the
  // server's own validation of it.
  let newValue: Record<string, unknown>;
  try {
    newValue = buildPublishValue(value, finalQuery, mapped.props);
  } catch (e) {
    return skip('the alert has no query input', errText(e));
  }
  const schemaVersion = typeof live.schemaVersion === 'string' ? live.schemaVersion : undefined;
  const payload: PayloadFile = { objectId: c.objectId, title: item.title, batch: c.batch, liveQuery, approvedQuery: approved, schemaVersion, value: newValue };

  if (publishedPartsEqual(value, newValue)) {
    item.result = 'recorded';
    item.reasons = ['already published: the live alert already has the query and event fields a publish would write, so it is recorded, not written again.', ...notes];
    return { item, gate: 'already published, recorded only' };
  }
  if (drift === 'already-published') {
    const queryChanges = liveQuery.trim() !== finalQuery.trim();
    notes.unshift(
      queryChanges
        ? 'the live alert already runs the approved query; this publish adds only what the entity binding and event fields need, and updates the event fields.'
        : 'event-field-only update: the live alert already runs the approved query; this publish changes its event fields only.',
    );
  }

  try {
    await ctx.settings.putObject(
      c.objectId,
      { value: newValue, updateToken: typeof live.updateToken === 'string' ? live.updateToken : undefined, schemaVersion },
      { validateOnly: true },
    );
  } catch (e) {
    if (isAuthFailure(e)) throw e;
    return skip('server validation failed', `server validation failed: ${errText(e)}`, payload);
  }

  item.result = 'ready';
  item.reasons = notes;
  return { item, gate: 'ready', payload, liveValue: value };
}

// ---------------------------------------------------------------------------
// Report

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const fence = (q: string): string => `\`\`\`\`dql\n${q.trim()}\n\`\`\`\``;

function countBy<T>(xs: T[], key: (x: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

interface ReportMeta {
  mode: 'prepare' | 'apply';
  env: string;
  batches: string[];
  tracker: string;
  stamp: string;
  unknownBatches: string[];
  /** Apply only: why the run stopped before writing every ready alert. */
  stopped?: string;
}

function renderReport(outcomes: Outcome[], meta: ReportMeta): string {
  const items = outcomes.map((o) => o.item);
  const n = (r: PublishPlanItem['result']) => items.filter((i) => i.result === r).length;
  const apply = meta.mode === 'apply';
  const lines: string[] = [];
  lines.push(`# Publishing alerts: ${meta.mode}`, '');
  if (apply) {
    lines.push(
      `Applied ${meta.stamp} against \`${meta.env}\` for ${meta.batches.join(', ')}, from the alerts sheet of \`${meta.tracker}\`. ` +
        'Each ready alert was written one at a time: re-read (and left alone if it had changed since planning), snapshotted to `pre/`, ' +
        'written with the update token of that re-read, re-read again to check, and recorded in `published/`. ' +
        'The alerts sheet gets one row per alert.',
      '',
    );
    if (meta.stopped) lines.push(`**Stopped:** ${meta.stopped}`, '');
  } else {
    lines.push(
      `Prepared ${meta.stamp} against \`${meta.env}\` for ${meta.batches.join(', ')}, from the alerts sheet of \`${meta.tracker}\`. ` +
        'Nothing was written to the tenant or the workbook. Server validation ran with `validateOnly`, which persists nothing.',
      '',
    );
  }
  if (meta.unknownBatches.length) {
    lines.push(`Not found in the manifest, or never published as a review notebook: ${meta.unknownBatches.join(', ')}.`, '');
  }
  // The results this mode can leave: [result, summary label, batch column]. An
  // apply leaves `ready` only when it stopped.
  type Column = [PublishPlanItem['result'], string, string];
  const stoppedColumn: Column[] = n('ready') ? [['ready', 'Not written: the run stopped', 'Not written']] : [];
  const columns: Column[] = apply
    ? [
        ['published', 'Published', 'Published'],
        ['recorded', 'Already published, recorded only', 'Recorded'],
        ['skipped', 'Skipped', 'Skipped'],
        ...stoppedColumn,
      ]
    : [
        ['ready', 'Ready to publish (server validation passed)', 'Ready'],
        ['recorded', 'Already published, recorded only', 'Recorded'],
        ['skipped', 'Skipped', 'Skipped'],
      ];
  lines.push('| Result | Alerts |', '|---|---|');
  for (const [r, label] of columns) lines.push(`| ${label} | ${n(r)} |`);
  lines.push(`| **Total** | **${items.length}** |`, '');

  lines.push('## By batch', '', `| Batch | ${columns.map((c) => c[2]).join(' | ')} |`, `|---|${columns.map(() => '---|').join('')}`);
  for (const b of [...new Set(items.map((i) => i.batch))]) {
    const inB = items.filter((i) => i.batch === b);
    lines.push(`| ${b} | ${columns.map(([r]) => inB.filter((i) => i.result === r).length).join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Skipped, by reason', '');
  const skipped = outcomes.filter((o) => o.item.result === 'skipped');
  if (skipped.length) {
    lines.push('| Reason | Alerts |', '|---|---|');
    for (const [gate, k] of countBy(skipped, (o) => o.gate)) lines.push(`| ${cell(gate)} | ${k} |`);
  } else {
    lines.push('None.');
  }
  lines.push('');

  lines.push('## Going out under a publish_override', '');
  const overridden = items.filter((i) => i.override && i.result !== 'skipped');
  if (overridden.length) {
    for (const i of overridden) lines.push(`- ${i.title} (\`${i.objectId}\`, ${i.batch}): ${overrideLabel(i.override!)}`);
  } else {
    lines.push('None.');
  }
  lines.push('');

  lines.push('## Each alert', '');
  for (const b of [...new Set(items.map((i) => i.batch))]) {
    lines.push(`### ${b}`, '');
    for (const o of outcomes.filter((x) => x.item.batch === b)) {
      const i = o.item;
      lines.push(`#### ${i.result.toUpperCase()}: ${i.title}`, '');
      const facts = [`\`${i.objectId}\``];
      if (i.result === 'skipped') facts.push(`skipped: ${o.gate}`);
      if (i.entityColumn) facts.push(`entity column \`${i.entityColumn}\``);
      if (i.series !== undefined) facts.push(`${i.series > DAVIS_SERIES_CAP ? `more than ${CAP_TEXT}` : i.series} series over 2 hours`);
      if (i.stagedFrom?.length) facts.push(`unchanged since staging per ${i.stagedFrom.map((s) => STAGED_FROM_TEXT[s]).join(', ')}`);
      if (i.override) facts.push(`publish_override: ${overrideLabel(i.override)}`);
      lines.push(facts.join(' · '), '');
      for (const r of i.reasons) lines.push(`- ${r}`);
      if (i.reasons.length) lines.push('');
      if (i.diff.query) {
        if (i.diff.query.before.trim() === i.diff.query.after.trim()) {
          lines.push('Query unchanged.', '');
        } else {
          const label = i.result === 'published' ? 'published' : i.result === 'ready' ? 'to publish' : 'approved';
          lines.push(`Query, ${i.result === 'published' ? 'before' : 'live'}:`, '', fence(i.diff.query.before), '', `Query, ${label}:`, '', fence(i.diff.query.after), '');
        }
      }
      if (i.diff.fields.length) {
        lines.push('| Event field | Before | After |', '|---|---|---|');
        for (const f of i.diff.fields) lines.push(`| ${cell(f.field)} | ${cell(f.before)} | ${cell(f.after)} |`);
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Apply

export interface ApplyDeps {
  /** The two Settings calls a write makes. */
  settings: Pick<SettingsClient, 'getObject' | 'putObject'>;
  /** `<tenant>/migration/detector-promote`: `pre/` snapshots and `published/` records go under it. */
  promoteDir: string;
  /** The workbook whose alerts sheet gets one row per alert. */
  trackerPath: string;
  /** Defaults to `upsertRows`. */
  upsert?: (path: string, rows: TrackerRow[], sheet: string) => Promise<unknown>;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface ApplyRun {
  /** The alerts this run wrote, in order. */
  published: string[];
  /** Ready alerts left unwritten because the run stopped. */
  notAttempted: string[];
  /** The HTTP 401/403 that stopped the run. */
  stop?: unknown;
  /** The rows given to the alerts sheet. */
  rows: TrackerRow[];
  /** False when the sheet write failed; the publishes stand. */
  recorded: boolean;
}

type ResolvedDeps = Required<ApplyDeps>;

const RECORDED_REASON = 'already published, recorded';
/** A cell holds at most 32,767 characters; a reason past this is a server message nobody reads whole. */
const REASONS_MAX = 2000;

/** The reasons as one cell: sentences joined by a space, clipped. */
export function reasonsText(reasons: string[]): string {
  const text = reasons.map((r) => r.trim()).filter(Boolean).join(' ');
  return text.length > REASONS_MAX ? `${text.slice(0, REASONS_MAX)}…` : text;
}

/**
 * Write one ready alert and update its outcome: `published`, or `skipped` with
 * the reason first. Returns the HTTP 401/403 that must stop the run, if one came;
 * the alert it came on stays `ready` (not written: nothing to record about the
 * alert itself), unless its write had already gone through.
 */
async function applyOne(o: Outcome, deps: ResolvedDeps): Promise<unknown> {
  const { item, payload } = o;
  const id = item.objectId;
  const log = deps.log;
  const skip = (gate: string, reason: string): undefined => {
    item.result = 'skipped';
    item.reasons = [reason, ...item.reasons];
    o.gate = gate;
    log(`  ! ${id} (${item.title}): ${reason}`);
    return undefined;
  };
  const stopHere = (e: unknown, what: string): unknown => {
    item.reasons = [...item.reasons, `not written: the run stopped here, ${what}: ${errText(e)}`];
    log(`  ! ${id} (${item.title}): ${what}: ${errText(e)}. Stopping.`);
    return e;
  };
  if (!payload || !o.liveValue) return skip('apply: nothing planned to write', 'not written: the plan holds no value to write for it.');

  // 1. Re-read. A change of any kind since planning is left alone: the planned
  // value is the live value of then, so writing it would undo the change.
  let live: SettingsObject;
  try {
    live = await deps.settings.getObject(id);
  } catch (e) {
    if (isAuthFailure(e)) return stopHere(e, 'the re-read before the write was refused');
    if (e instanceof SettingsApiError && e.status === 404) return skip('the alert no longer exists', 'not written: the alert no longer exists (HTTP 404).');
    return skip('apply: the re-read failed', `not written: the re-read before the write failed: ${errText(e)}`);
  }
  const value = live.value ?? {};
  if (detectorQuery(value) !== payload.liveQuery) {
    return skip(
      'drift: changed since planned',
      'not written: its live query changed after this run planned it, so someone is editing the alert now. Re-run to plan it again.',
    );
  }
  if (!detectorValuesEqual(value, o.liveValue)) {
    return skip(
      'drift: changed since planned',
      'not written: the alert changed after this run planned it (not its query: e.g. its threshold, enabled state or event fields), ' +
        'and writing the planned value would undo that. Re-run to plan it again.',
    );
  }
  // The write is locked to this read: without its token it would be an unlocked
  // write that could overwrite a change made since.
  const updateToken = typeof live.updateToken === 'string' && live.updateToken ? live.updateToken : undefined;
  if (!updateToken) return skip('apply: no update token', 'no update token returned by the re-read; not written.');

  // 2. Snapshot; nothing is written without one.
  const snap = await takeSnapshot(deps.promoteDir, id, item.title, value, deps.now());
  if ('error' in snap) return skip('apply: snapshot failed', `not written: ${snap.error}, and nothing is written without one.`);
  const notes: string[] = snap.note ? [snap.note] : [];

  // 3. The pending record, just before the write: a crash after the write reads
  // as already published on the next run, not as an owner edit. It becomes the
  // published record once the write is checked, and goes when it did not land.
  const pendingPath = recordPath(deps.promoteDir, 'pending', id);
  const approvedQuery = payload.approvedQuery;
  try {
    await writeRecord(pendingPath, { objectId: id, pendingAt: deps.now().toISOString(), approvedQuery, value: payload.value });
  } catch (e) {
    return skip(
      'apply: pending record failed',
      `not written: the pending record ${pendingPath} could not be written (${errText(e)}); without it a crash after the write would read as an owner edit.`,
    );
  }
  const dropPending = async (): Promise<void> => {
    await rm(pendingPath, { force: true }).catch(() => undefined);
  };

  // 4. The write, locked to the value just read. Never sent twice: a write that
  // got no answer may have landed, so it is settled by reading. A 5xx counts as
  // no answer: a gateway 502/504 can come back after the write was committed.
  // Only a 4xx is a definite refusal.
  let stored: Record<string, unknown> | undefined;
  let checked = false;
  try {
    await deps.settings.putObject(id, {
      value: payload.value,
      updateToken,
      schemaVersion: typeof live.schemaVersion === 'string' ? live.schemaVersion : payload.schemaVersion,
    });
  } catch (e) {
    if (isAuthFailure(e)) {
      await dropPending();
      return stopHere(e, 'the write was refused');
    }
    if (e instanceof SettingsApiError && e.status < 500) {
      await dropPending();
      const why = e.status === 409 ? ' (the alert changed between the re-read and the write)' : '';
      return skip('apply: the write was refused', `not written: the write was refused${why}: ${errText(e)}`);
    }
    const noAnswer = e instanceof SettingsApiError ? `the write got a server error (${errText(e)})` : `the write got no answer (${errText(e)})`;
    let after: SettingsObject;
    try {
      after = await deps.settings.getObject(id);
    } catch (e2) {
      skip(
        'apply: the write may have landed',
        `${noAnswer} and the re-read after it failed too (${errText(e2)}), so whether it landed is unknown. ` +
          `Re-read the alert before re-running; ${pendingPath} stays, so a re-run reads a write that landed as already published.`,
      );
      return isAuthFailure(e2) ? e2 : undefined;
    }
    if (!publishedPartsEqual(after.value ?? {}, payload.value)) {
      await dropPending();
      return skip('apply: the write failed', `not written: ${noAnswer} and a re-read shows it did not land.`);
    }
    notes.push(`${noAnswer}, but a re-read shows it landed.`);
    stored = after.value ?? {};
    checked = true;
  }

  // 5. Re-read and check the parts the publish wrote. A mismatch does not undo
  // the write (it went through); it is recorded and printed for a person.
  let stop: unknown;
  if (!checked) {
    try {
      const after = await deps.settings.getObject(id);
      stored = after.value ?? {};
      if (!publishedPartsEqual(stored, payload.value)) {
        const part = detectorQuery(stored) !== detectorQuery(payload.value) ? 'query' : 'event fields';
        notes.push(`the re-read after the write does not show the published ${part}: the stored value differs from what was written. Check the alert.`);
      }
    } catch (e) {
      notes.push(`the re-read after the write failed (${errText(e)}), so the stored value was not checked.`);
      if (isAuthFailure(e)) stop = e;
    }
  }

  // 6. The record verify, rollback and the next run's drift check read: the
  // pending record, now with what the re-read found, under its final name.
  const publishedAt = deps.now().toISOString();
  const publishedPath = recordPath(deps.promoteDir, 'published', id);
  try {
    await writeRecord(pendingPath, { objectId: id, publishedAt, approvedQuery, value: payload.value, ...(stored ? { storedValue: stored } : {}) });
    await rename(pendingPath, publishedPath);
  } catch (e) {
    notes.push(
      `its record ${publishedPath} could not be written (${errText(e)}); verify and rollback need it, so copy this run's payloads/${id}.json there ` +
        `(${pendingPath} holds what was sent).`,
    );
  }

  // 7. A rollback's record would make the next run read the sheet row as older
  // than the rollback; this publish is newer, so it is moved aside.
  const rolledBack = rolledBackPath(deps.promoteDir, id);
  if (existsSync(rolledBack)) {
    try {
      await moveAside(rolledBack, deps.now());
    } catch (e) {
      notes.push(`the rollback record ${rolledBack} could not be moved aside (${errText(e)}); move it by hand, or a later run reads this alert as rolled back.`);
    }
  }

  item.result = 'published';
  item.reasons = [...item.reasons, ...notes];
  o.gate = 'published';
  o.publishedAt = publishedAt;
  log(`  ✓ published ${id} (${item.title})`);
  for (const note of notes) log(`      ${note}`);
  if (stop) log(`  ! the re-read after writing ${id} was refused. Stopping.`);
  return stop;
}

/**
 * Snapshot the live value to `pre/<id>.json` before it is written. An existing
 * snapshot is kept when the live alert's query and event fields still equal its
 * own: a retry of an earlier attempt that did not write (a refused or failed
 * write), and the two parts a rollback restores are the same either way.
 * Otherwise it is out of date (the alert was published, rolled back and changed
 * since), so it is moved aside to `pre/<id>.<stamp>.json` and a fresh one taken:
 * a rollback restoring the old one would discard the change. Returns a note when
 * it moved one, or why no snapshot could be taken.
 */
async function takeSnapshot(promoteDir: string, id: string, title: string, live: Record<string, unknown>, now: Date): Promise<{ note?: string } | { error: string }> {
  const prePath = recordPath(promoteDir, 'pre', id);
  const existing = await readPromoteRecord(promoteDir, 'pre', id);
  if (existing.kind === 'ok' && publishedPartsEqual(live, existing.record.value)) return {};
  let note: string | undefined;
  if (existing.kind !== 'missing') {
    let movedTo: string;
    try {
      movedTo = await moveAside(prePath, now);
    } catch (e) {
      return { error: `the earlier snapshot ${prePath} could not be moved aside (${errText(e)})` };
    }
    const where = join('pre', basename(movedTo));
    note =
      existing.kind === 'ok'
        ? `the earlier snapshot (${existing.record.snapshotAt ?? 'unknown time'}) no longer matched the alert's query and event fields, so it was moved to ${where} and a fresh one taken.`
        : `the earlier snapshot could not be read (${existing.problem}), so it was moved to ${where} and a fresh one taken.`;
  }
  try {
    await writeRecord(prePath, { objectId: id, title, snapshotAt: now.toISOString(), value: live }, 'wx');
  } catch (e) {
    return { error: `the snapshot ${prePath} could not be written (${errText(e)})` };
  }
  return { note };
}

/** When an earlier apply published an alert, from its record; undefined when there is none. */
async function earlierPublishAt(promoteDir: string, objectId: string): Promise<string | undefined> {
  try {
    const rec = JSON.parse(await readFile(join(promoteDir, 'published', `${objectId}.json`), 'utf8')) as { publishedAt?: unknown };
    return typeof rec.publishedAt === 'string' ? rec.publishedAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One row per alert the run decided: published and recorded become promoted /
 * Published, skipped ones get their reason and nothing else. A ready alert the
 * run stopped before writing gets no row.
 */
async function sheetRows(outcomes: Outcome[], deps: ResolvedDeps): Promise<TrackerRow[]> {
  const rows: TrackerRow[] = [];
  for (const o of outcomes) {
    const i = o.item;
    const row: TrackerRow = { asset_id: i.objectId, asset_type: 'anomaly-detector', name: i.title };
    if (i.result === 'published' || i.result === 'recorded') {
      rows.push({
        ...row,
        status: 'promoted',
        decision: PUBLISHED,
        promoted_at: (i.result === 'published' ? o.publishedAt : await earlierPublishAt(deps.promoteDir, i.objectId)) ?? deps.now().toISOString(),
        review_batch: i.batch,
        reasons: i.result === 'recorded' ? RECORDED_REASON : reasonsText(i.reasons),
      });
    } else if (i.result === 'skipped') {
      rows.push({ ...row, reasons: reasonsText(i.reasons) });
    }
  }
  return rows;
}

/** One write to the alerts sheet. A failure never undoes a publish: it names the ids to record. */
async function recordOnSheet(rows: TrackerRow[], deps: ResolvedDeps): Promise<boolean> {
  if (!rows.length) return true;
  try {
    await deps.upsert(deps.trackerPath, rows, ALERTS_SHEET);
    deps.log(`Recorded ${rows.length} row(s) on the ${ALERTS_SHEET} sheet of ${deps.trackerPath}.`);
    return true;
  } catch (e) {
    const msg = clip((e as Error)?.message ?? String(e), 100);
    const ids = rows.filter((r) => r.status === 'promoted').map((r) => r.asset_id);
    if (ids.length) {
      deps.log(`\n  ! Published, but could not write the tracker (${msg}).`);
      deps.log(
        `    Close ${deps.trackerPath} and re-run with --apply --ids ${ids.join(',')} to record them: ` +
          'a re-run finds them already published and records them without writing again.',
      );
    } else {
      deps.log(`\n  ! Could not write the tracker (${msg}). Nothing was published in this run; the skip reasons are in the report.`);
    }
    return false;
  }
}

/**
 * The apply: write every `ready` outcome, one at a time, in order; stop at the
 * first HTTP 401/403; then one write to the alerts sheet for every alert the run
 * decided, the ones published before a stop included. Only outcomes planned in
 * this run reach here, so nothing is written from a payload file on disk.
 */
export async function applyAndRecord(outcomes: Outcome[], deps: ApplyDeps): Promise<ApplyRun> {
  const d: ResolvedDeps = {
    ...deps,
    upsert: deps.upsert ?? upsertRows,
    log: deps.log ?? ((line: string) => console.log(line)),
    now: deps.now ?? (() => new Date()),
  };
  const published: string[] = [];
  const notAttempted: string[] = [];
  let stop: unknown;
  for (const o of outcomes) {
    if (o.item.result !== 'ready') continue;
    if (stop) {
      o.item.reasons = [...o.item.reasons, 'not written: the run stopped before this alert.'];
      notAttempted.push(o.item.objectId);
      continue;
    }
    const refused = await applyOne(o, d);
    // applyOne moved the result on; read it afresh rather than through the narrowing above.
    const after: PublishPlanItem['result'] = o.item.result as PublishPlanItem['result'];
    if (after === 'published') published.push(o.item.objectId);
    else if (after === 'ready') notAttempted.push(o.item.objectId);
    if (refused) stop = refused;
  }
  const rows = await sheetRows(outcomes, d);
  const recorded = await recordOnSheet(rows, d);
  return { published, notAttempted, stop, rows, recorded };
}

/** Why the token was refused, and what it needs, by the API that refused it. */
function authStopText(e: unknown): string {
  if (e instanceof DqlError) {
    return `the DQL query API refused the token (${errText(e)}). It needs the storage read scopes the alerts' queries use.`;
  }
  if (e instanceof DocumentApiError) {
    return `the Document API refused the token (${errText(e)}). It needs document:documents:read, with admin access for review notebooks it does not own.`;
  }
  return `the Settings API refused the token (${errText(e)}). It needs settings:objects:read and settings:objects:write for builtin:davis.anomaly-detectors.`;
}

// ---------------------------------------------------------------------------

export async function runPromoteDetectors(args: PromoteDetectorsArgs): Promise<void> {
  const batches = (args.batches ?? []).map((b) => b.trim()).filter(Boolean);
  if (!batches.length) {
    throw new Error('migrate-promote-detectors: --batches is required, e.g. --batches batch-03,batch-04. There is no "publish everything Ready" mode.');
  }
  if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit > 0)) {
    throw new Error(`migrate-promote-detectors: --limit "${args.limit}" must be a positive integer`);
  }
  // A filter that reads as "no filter" would widen an apply to the whole batch.
  if (args.ids && !args.ids.length) {
    throw new Error('migrate-promote-detectors: --ids names no alert id. Leave it out to take every Ready alert of the batches.');
  }
  if (args.force && !args.ids?.length) {
    throw new Error('migrate-promote-detectors: --force needs --ids: it publishes named alerts their owner changed after review, never a whole batch.');
  }
  assertAllowedEnv(args.baseUrl, args.allowEnv, args.apply === true);
  const mode: ReportMeta['mode'] = args.apply ? 'apply' : 'prepare';

  const base = args.outDir;
  const reviewDir = join(base, 'migration', 'detector-review');
  const archiveDir = join(base, 'migration', 'detector-review-archive');
  const promoteDir = join(base, 'migration', 'detector-promote');
  const trackerPath = args.trackerPath ?? join(base, 'migration-tracker.xlsx');

  let manifest: { batches?: ManifestBatch[] };
  try {
    manifest = JSON.parse(await readFile(join(reviewDir, 'manifest.json'), 'utf8'));
  } catch (e) {
    throw new Error(`migrate-promote-detectors: cannot read the review manifest in ${reviewDir} (${(e as Error).message}). Run stage-detectors --apply first.`);
  }
  if (!existsSync(trackerPath)) {
    throw new Error(`migrate-promote-detectors: no workbook at ${trackerPath}. Pass --tracker <path> or set DT_TRACKER_PATH.`);
  }
  const rows = await readRows(trackerPath, ALERTS_SHEET);
  const selected = selectForPublish(rows, manifest.batches ?? [], { batches, ids: args.ids });
  const unknownBatches = selected.unknownBatches;
  if (unknownBatches.length) {
    console.log(`Not found in the manifest, or never published as a review notebook: ${unknownBatches.join(', ')}. Continuing with the rest.`);
  }
  if (args.ids?.length) {
    const picked = new Set(selected.candidates.map((c) => c.objectId));
    const left = whyNotSelected(args.ids.filter((id) => !picked.has(id)), rows, manifest.batches ?? [], { batches });
    if (left.length) {
      console.log(`${left.length} of the --ids not selected:`);
      for (const l of left) console.log(`  ${l.id}: ${l.reason}`);
    }
  }
  const candidates = args.limit === undefined ? selected.candidates : selected.candidates.slice(0, args.limit);
  if (!candidates.length) {
    console.log(`Nothing to publish: no Ready To Publish alert on the alerts sheet of ${trackerPath} is in ${batches.join(', ')}${args.ids?.length ? ' with the given --ids' : ''}.`);
    return;
  }
  console.log(`${args.apply ? 'Planning' : 'Preparing'} ${candidates.length} alert(s) from ${batches.join(', ')}…`);

  const mappingPath = join(REPO_ROOT, 'mappings', 'aws_mapping.with_recipes.json');
  const index = await loadRecipeIndex(mappingPath, {
    dacPath: SKILL_DAC_AWS_METRICS,
    manualPath: SKILL_MANUAL_AWS_METRICS,
    perKeyPath: SKILL_PER_KEY_AWS_METRICS,
    liveMetricsPath: liveMetricsPathIfPresent(base),
    mzTagsPath: mzTagsPathIfPresent(base),
    enrichedTagsPath: enrichedTagsPathIfPresent(base),
    entityArnsPath: entityArnsPathIfPresent(base),
    entityCandidatesPath: entityCandidatesPathIfPresent(base),
  });

  const settings = new SettingsClient({ baseUrl: args.baseUrl, token: args.token });
  const docs = new DocumentClient({ baseUrl: args.baseUrl, token: args.token });
  const dql = new DqlClient({ baseUrl: args.baseUrl, token: args.token });

  // The first HTTP 401/403 from any API. The workers stop taking alerts once it
  // is set. Recorded here as well as thrown, because some callers (the binding
  // check) turn a failed query into an outcome instead of passing it on.
  let stop: unknown;
  const noteAuth = <T>(p: Promise<T>): Promise<T> =>
    p.catch((e: unknown) => {
      if (isAuthFailure(e)) stop ??= e;
      throw e;
    });

  // One read per notebook and per payload file, shared by every alert in it.
  const notebooks = new Map<string, ReturnType<PlanCtx['sections']>>();
  const payloads = new Map<string, Promise<PayloadRead>>();
  const ctx: PlanCtx = {
    args,
    index,
    settings,
    run: (query, windowMs) => {
      const end = new Date();
      return noteAuth(
        dql.query({
          query,
          defaultTimeframeStart: new Date(end.getTime() - windowMs).toISOString(),
          defaultTimeframeEnd: end.toISOString(),
          // One past the cap is enough to know a split is too big for Davis.
          maxResultRecords: DAVIS_SERIES_CAP + 1,
          fetchTimeoutSeconds: 120,
        }),
      );
    },
    sections: (notebookId) => {
      let p = notebooks.get(notebookId);
      if (!p) {
        p = noteAuth(docs.getDocumentFull(notebookId, true)).then((d) => {
          const content = (typeof d.content === 'string' ? JSON.parse(d.content) : d.content) as { sections?: unknown };
          return Array.isArray(content?.sections) ? content.sections : [];
        });
        notebooks.set(notebookId, p);
      }
      return p;
    },
    payload: (kind, batch) => {
      const dir = kind === 'base' ? reviewDir : archiveDir;
      const file = join(dir, `${batch.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`);
      let p = payloads.get(file);
      if (!p) {
        p = (async (): Promise<PayloadRead> => {
          if (!existsSync(file)) return {};
          try {
            const sections = (JSON.parse(await readFile(file, 'utf8')) as { content?: { sections?: unknown } }).content?.sections;
            if (!Array.isArray(sections)) return { problem: `${file} has no content.sections` };
            return { sections };
          } catch (e) {
            return { problem: `${file}: ${clip((e as Error).message, 120)}` };
          }
        })();
        payloads.set(file, p);
      }
      return p;
    },
    records: async (objectId) => {
      const out: EarlierRecords = { problems: [] };
      for (const kind of ['published', 'pending'] as const) {
        const r = await readPromoteRecord(promoteDir, kind, objectId);
        if (r.kind === 'ok') out[kind] = r.record;
        else if (r.kind === 'bad') out.problems.push(`the record ${r.path} could not be read (${r.problem}), so it was left out.`);
      }
      return out;
    },
    rolledBack: (objectId) => readRolledBack(promoteDir, objectId),
  };

  const started = Date.now();
  const outcomes: Array<Outcome | undefined> = new Array(candidates.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (!stop && next < candidates.length) {
      const k = next++;
      const c = candidates[k]!;
      try {
        outcomes[k] = await planOne(c, ctx);
      } catch (e) {
        if (isAuthFailure(e)) {
          stop ??= e;
          return;
        }
        const item: PublishPlanItem = { objectId: c.objectId, title: c.title, batch: c.batch, result: 'skipped', reasons: [`unexpected error: ${errText(e)}`], diff: { fields: [] } };
        outcomes[k] = { item, gate: 'unexpected error' };
      }
      done++;
      if (done % 25 === 0 || done === candidates.length) {
        console.log(`  … ${done}/${candidates.length} (${Math.round((Date.now() - started) / 1000)}s)`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (stop) {
    throw new Error(`migrate-promote-detectors: ${authStopText(stop)} Stopped; nothing was written.`);
  }

  const finished = outcomes.filter((o): o is Outcome => o !== undefined);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const runDir = join(promoteDir, mode, stamp);
  await mkdir(join(runDir, 'payloads'), { recursive: true });
  const writePlan = async (stopped?: string): Promise<void> => {
    await writeFile(join(runDir, 'plan.json'), JSON.stringify(finished.map((o) => o.item), null, 2));
    const meta = { mode, env: envIdFromBaseUrl(args.baseUrl), batches, tracker: trackerPath, stamp: new Date().toISOString(), unknownBatches, stopped };
    await writeFile(join(runDir, 'report.md'), renderReport(finished, meta));
  };
  for (const o of finished) {
    if (o.payload) await writeFile(join(runDir, 'payloads', `${o.item.objectId}.json`), JSON.stringify(o.payload, null, 2));
  }

  const n = (r: PublishPlanItem['result']) => finished.filter((o) => o.item.result === r).length;
  const printSkips = (): void => {
    for (const [gate, k] of countBy(finished.filter((o) => o.item.result === 'skipped'), (o) => o.gate)) {
      console.log(`  ${String(k).padStart(4)}  ${gate}`);
    }
    const overridden = finished.filter((o) => o.item.override && o.item.result !== 'skipped').length;
    if (overridden) console.log(`  ${overridden} going out under a publish_override (listed in the report).`);
  };

  if (!args.apply) {
    await writePlan();
    console.log('');
    console.log(`${n('ready')} ready (server validation passed), ${n('recorded')} already published (recorded only), ${n('skipped')} skipped, of ${finished.length}.`);
    printSkips();
    console.log('');
    console.log(`Report: ${join(runDir, 'report.md')}`);
    console.log(`Plan and payloads: ${runDir}. Nothing was written to the tenant or the workbook.`);
    return;
  }

  // The payloads are on disk before the first write; the plan and report are
  // written once the run's results are known.
  console.log('');
  console.log(`${n('ready')} ready, ${n('recorded')} already published (recorded only), ${n('skipped')} skipped. Writing the ready ones, one at a time…`);
  const run = await applyAndRecord(finished, { settings, promoteDir, trackerPath });
  const stopped = run.stop
    ? `${authStopText(run.stop)} ${run.notAttempted.length} ready alert(s) not written: ${run.notAttempted.join(', ')}.`
    : undefined;
  await writePlan(stopped);

  console.log('');
  console.log(
    `${n('published')} published, ${n('recorded')} already published (recorded only), ${n('skipped')} skipped` +
      `${run.notAttempted.length ? `, ${run.notAttempted.length} not written (the run stopped)` : ''}, of ${finished.length}.`,
  );
  printSkips();
  console.log('');
  console.log(`Report: ${join(runDir, 'report.md')}`);
  console.log(`Snapshots: ${join(promoteDir, 'pre')}. Published values: ${join(promoteDir, 'published')}.`);
  if (run.stop) {
    throw new Error(
      `migrate-promote-detectors: stopped. ${stopped} ` +
        `${run.published.length} alert(s) published before it ${run.recorded ? 'are recorded on the sheet' : 'are not on the sheet yet (see above)'}.`,
    );
  }
}
