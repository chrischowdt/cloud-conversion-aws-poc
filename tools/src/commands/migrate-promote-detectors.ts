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
 * tile's marker line), the detector from the Settings API, the classic query the
 * card was staged from from the base payload `<batch>.json` (else the tile's
 * reference block). Then the gates, in order; the first failure decides:
 *   drift (owner edited or migrated the alert since staging, or the staged
 *   version is unknown; already published = recorded only), empty query,
 *   blocking lint, the approved query fails over the last 2 hours, the entity
 *   (an approved query that emits none: the 7-day binding check plus the
 *   reviewer's `publish_override`; one that does: at most 10,000 series over 7
 *   days), event fields that name a column the query does not emit, and the
 *   server's own validation (`validateOnly`, which persists nothing).
 *
 * PREPARE (the default) writes only files under
 * migration/detector-promote/prepare/<stamp>/: plan.json, report.md and the
 * value each ready alert would get (payloads/<objectId>.json). No tenant write,
 * no workbook write: the workbook is a file reviewers keep open.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REPO_ROOT, SKILL_DAC_AWS_METRICS, SKILL_MANUAL_AWS_METRICS, SKILL_PER_KEY_AWS_METRICS, envIdFromBaseUrl } from '../lib/paths.ts';
import { liveMetricsPathIfPresent } from '../lib/live-metrics.ts';
import { mzTagsPathIfPresent } from '../lib/mz-tags.ts';
import { enrichedTagsPathIfPresent } from '../lib/enriched-tags.ts';
import { entityArnsPathIfPresent } from '../lib/entity-arns.ts';
import { entityCandidatesPathIfPresent } from '../lib/entity-candidates.ts';
import { loadRecipeIndex, type RecipeIndex } from '../lib/recipe-lookup.ts';
import { rewriteDql } from '../lib/dql-rewriter.ts';
import { lintQuery } from '../lib/output-lint.ts';
import { detectorQuery, findQueryInput, type EventTemplateChange } from '../lib/detector-rewrite.ts';
import { DAVIS_SERIES_CAP, SOURCE_ID_DIM, emittedEntityColumn, resolveBinding, type BindingOutcome } from '../lib/detector-binding.ts';
import { isEffectivelyEmpty, parseOriginalBlock, parseReviewQuery } from '../lib/detector-notebook.ts';
import {
  assertAllowedEnv,
  buildPublishValue,
  decideEntity,
  driftOf,
  findApprovedTile,
  isAuthFailure,
  mapEventFields,
  selectForPublish,
  staticColumns,
  withNodeNameColumn,
  type Drift,
  type EventProp,
  type ManifestBatch,
  type PublishCandidate,
} from '../lib/detector-publish.ts';
import { PUBLISH_OVERRIDES, type PublishOverride } from '../lib/decision-states.ts';
import { ALERTS_SHEET, readRows } from '../lib/tracker-xlsx.ts';
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
  /** ready: passes every gate. recorded: already live, only the sheet needs it. skipped: see reasons. */
  result: 'ready' | 'skipped' | 'recorded';
  /** Why it was skipped (first entry), or notes about how it goes out. */
  reasons: string[];
  /** The reviewer's override, when the alert's entity decision went through it. */
  override?: PublishOverride;
  /** Series the published query produced over the last 7 days (at most the cap + 1). */
  series?: number;
  /** The entity column the published query emits and the binding property names. */
  entityColumn?: string;
  diff: { query?: { before: string; after: string }; fields: EventTemplateChange[] };
}

/** The payload file of an alert: what an apply would PUT, and the live query it was planned against. */
interface PayloadFile {
  objectId: string;
  title: string;
  batch: string;
  /** The live query when this was planned; an apply skips the alert if it changed since. */
  liveQuery: string;
  schemaVersion?: string;
  value: Record<string, unknown>;
}

/** One planned alert plus what only this run needs: the summary label and the payload. */
interface Outcome {
  item: PublishPlanItem;
  /** Short label the report groups skipped alerts by. */
  gate: string;
  payload?: PayloadFile;
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
      'staged version unknown: the classic query the card was staged from is in neither the base payload nor the tile, ' +
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
function errText(e: unknown): string {
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

interface Ctx {
  args: PromoteDetectorsArgs;
  index: RecipeIndex;
  settings: SettingsClient;
  run: (query: string, windowMs: number) => Promise<DqlResult>;
  sections: (notebookId: string) => Promise<Array<{ id?: string; type?: string; state?: { input?: { value?: string } } }>>;
  stagedFromBase: (batch: string, objectId: string) => Promise<string | undefined>;
  publishedQuery: (objectId: string) => Promise<string | undefined>;
}

/** Read everything one alert needs and run its gates. Throws only on an auth failure. */
async function planOne(c: PublishCandidate, ctx: Ctx): Promise<Outcome> {
  const item: PublishPlanItem = { objectId: c.objectId, title: c.title, batch: c.batch, result: 'skipped', reasons: [], diff: { fields: [] } };
  const notes: string[] = c.note ? [c.note] : [];
  const skip = (gate: string, reason: string, payload?: PayloadFile): Outcome => {
    item.result = 'skipped';
    item.reasons = [reason, ...notes];
    return { item, gate, payload };
  };

  // 1. The approved query, from the live review notebook.
  let sections: Awaited<ReturnType<Ctx['sections']>>;
  try {
    sections = await ctx.sections(c.notebookId);
  } catch (e) {
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

  // 3. The classic query the card was staged from.
  const staged = (await ctx.stagedFromBase(c.batch, c.objectId)) ?? parseOriginalBlock(tile.value);

  // Empty first: an empty approved query must never reach the drift check, where
  // it would read as "already published" against an empty live query.
  if (isEffectivelyEmpty(approved)) {
    return skip('empty query', 'empty query: the approved tile holds nothing but comments and whitespace.');
  }
  item.diff.query = { before: liveQuery, after: approved };

  // Gate 1: drift.
  let liveIsMigrated = false;
  try {
    liveIsMigrated = rewriteDql(liveQuery, ctx.index).rewritten === liveQuery;
  } catch {
    /* unreadable to the rewriter: read as an owner edit, the more cautious reason */
  }
  const drift = driftOf({ liveQuery, stagedQuery: staged, approvedQuery: approved, publishedQuery: await ctx.publishedQuery(c.objectId), liveIsMigrated });
  if (drift === 'already-published') {
    item.result = 'recorded';
    item.reasons = ['already published: the live alert already runs the approved query, so it is recorded, not written again.', ...notes];
    item.diff.query = undefined;
    return { item, gate: 'already published, recorded only' };
  }
  if (drift !== 'none') {
    const text = DRIFT_TEXT[drift];
    const forced = ctx.args.force === true && (ctx.args.ids ?? []).includes(c.objectId);
    if (!forced) return skip(text.gate, text.reason);
    notes.push(`${text.gate.replace(/^drift: /, '')}; published anyway: --force with --ids names it.`);
  }

  // Gate 3: blocking lint.
  const blocking = lintQuery(approved).filter((f) => f.severity === 'blocking');
  if (blocking.length) {
    return skip('blocking lint', `blocking lint: ${blocking.map((f) => `${f.ruleId} (${clip(f.message, 160)})`).join('; ')}`);
  }

  // Gate 4: the approved query runs.
  let run2h: DqlResult;
  try {
    run2h = await ctx.run(approved, TWO_HOURS_MS);
  } catch (e) {
    return skip('the query fails on the tenant', `the approved query fails on the tenant over the last 2 hours: ${errText(e)}`);
  }

  // Gate 5: the entity. One 7-day run per query text, shared by the binding
  // check and the series/columns read below.
  const runs7d = new Map<string, Promise<DqlResult>>();
  const run7d = (q: string): Promise<DqlResult> => {
    let p = runs7d.get(q);
    if (!p) {
      p = ctx.run(q, SEVEN_DAYS_MS);
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

  // The series cap, from one 7-day run of the final query.
  let run7: DqlResult | undefined;
  let run7Error: string | undefined;
  try {
    run7 = await run7d(finalQuery);
  } catch (e) {
    run7Error = errText(e);
  }
  if (run7) {
    item.series = run7.records.length;
    if (run7.records.length > DAVIS_SERIES_CAP) {
      return skip('over the series cap', `produces more than ${CAP_TEXT} series over the last 7 days, the most one Davis detector monitors.`);
    }
  }

  // Gate 6: the columns the final query emits.
  let columns = run7 ? columnsOf(run7) : new Set<string>();
  if (!columns.size && !run7) {
    // The 7-day run failed: a 2-hour run of the same query stands in for it.
    let run2: DqlResult | undefined = finalQuery === approved ? run2h : undefined;
    if (!run2) {
      try {
        run2 = await ctx.run(finalQuery, TWO_HOURS_MS);
      } catch {
        /* no columns from a run; read them from the query text below */
      }
    }
    if (run2 && run2.records.length > DAVIS_SERIES_CAP) {
      return skip('over the series cap', `produces more than ${CAP_TEXT} series over the last 2 hours, the most one Davis detector monitors.`);
    }
    if (run2) columns = columnsOf(run2);
    notes.push(`the 7-day run failed (${run7Error}), so the series count is ${run2 ? `from the last 2 hours only (${run2.records.length})` : 'unchecked'}.`);
  }
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

  // Step 8: a name placeholder needs the name column in the result.
  if (mapped.nameColumn && entityColumn && !columns.has(mapped.nameColumn)) {
    finalQuery = withNodeNameColumn(finalQuery, entityColumn);
  }
  item.diff.query = { before: liveQuery, after: finalQuery };

  if (mapped.unresolved.length) {
    return skip(
      'event field names a column the query does not emit',
      `event fields name columns the approved query does not emit: ${unresolvedText(mapped.unresolved, props)}. ` +
        'Make the query emit the column, in the review notebook.',
    );
  }

  // Gate 9: the value, and the server's own validation of it.
  let newValue: Record<string, unknown>;
  try {
    newValue = buildPublishValue(value, finalQuery, mapped.props);
  } catch (e) {
    return skip('the alert has no query input', errText(e));
  }
  const schemaVersion = typeof live.schemaVersion === 'string' ? live.schemaVersion : undefined;
  const payload: PayloadFile = { objectId: c.objectId, title: item.title, batch: c.batch, liveQuery, schemaVersion, value: newValue };
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
  return { item, gate: 'ready', payload };
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

function renderReport(outcomes: Outcome[], meta: { env: string; batches: string[]; tracker: string; stamp: string; unknownBatches: string[] }): string {
  const items = outcomes.map((o) => o.item);
  const n = (r: PublishPlanItem['result']) => items.filter((i) => i.result === r).length;
  const lines: string[] = [];
  lines.push('# Publishing alerts: prepare', '');
  lines.push(
    `Prepared ${meta.stamp} against \`${meta.env}\` for ${meta.batches.join(', ')}, from the alerts sheet of \`${meta.tracker}\`. ` +
      'Nothing was written to the tenant or the workbook. Server validation ran with `validateOnly`, which persists nothing.',
    '',
  );
  if (meta.unknownBatches.length) {
    lines.push(`Not found in the manifest, or never published as a review notebook: ${meta.unknownBatches.join(', ')}.`, '');
  }
  lines.push('| Result | Alerts |', '|---|---|');
  lines.push(`| Ready to publish (server validation passed) | ${n('ready')} |`);
  lines.push(`| Already published, recorded only | ${n('recorded')} |`);
  lines.push(`| Skipped | ${n('skipped')} |`);
  lines.push(`| **Total** | **${items.length}** |`, '');

  lines.push('## By batch', '', '| Batch | Ready | Recorded | Skipped |', '|---|---|---|---|');
  for (const b of [...new Set(items.map((i) => i.batch))]) {
    const inB = items.filter((i) => i.batch === b);
    const c = (r: PublishPlanItem['result']) => inB.filter((i) => i.result === r).length;
    lines.push(`| ${b} | ${c('ready')} | ${c('recorded')} | ${c('skipped')} |`);
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
      if (i.series !== undefined) facts.push(`${i.series > DAVIS_SERIES_CAP ? `more than ${CAP_TEXT}` : i.series} series over 7 days`);
      if (i.override) facts.push(`publish_override: ${overrideLabel(i.override)}`);
      lines.push(facts.join(' · '), '');
      for (const r of i.reasons) lines.push(`- ${r}`);
      if (i.reasons.length) lines.push('');
      if (i.diff.query) {
        if (i.diff.query.before.trim() === i.diff.query.after.trim()) {
          lines.push('Query unchanged.', '');
        } else {
          lines.push('Query, live:', '', fence(i.diff.query.before), '', `Query, ${i.result === 'ready' ? 'to publish' : 'approved'}:`, '', fence(i.diff.query.after), '');
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

export async function runPromoteDetectors(args: PromoteDetectorsArgs): Promise<void> {
  const batches = (args.batches ?? []).map((b) => b.trim()).filter(Boolean);
  if (!batches.length) {
    throw new Error('migrate-promote-detectors: --batches is required, e.g. --batches batch-03,batch-04. There is no "publish everything Ready" mode.');
  }
  if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit > 0)) {
    throw new Error(`migrate-promote-detectors: --limit must be a positive whole number, got "${args.limit}".`);
  }
  assertAllowedEnv(args.baseUrl, args.allowEnv, args.apply === true);
  if (args.apply) {
    throw new Error('migrate-promote-detectors: --apply is not available yet. Run without it to prepare and read the report.');
  }

  const base = args.outDir;
  const reviewDir = join(base, 'migration', 'detector-review');
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
  const { candidates, unknownBatches } = selectForPublish(rows, manifest.batches ?? [], { batches, ids: args.ids, limit: args.limit });
  if (unknownBatches.length) {
    console.log(`Not found in the manifest, or never published as a review notebook: ${unknownBatches.join(', ')}. Continuing with the rest.`);
  }
  if (!candidates.length) {
    console.log(`Nothing to publish: no Ready To Publish alert on the alerts sheet of ${trackerPath} is in ${batches.join(', ')}${args.ids?.length ? ' with the given --ids' : ''}.`);
    return;
  }
  console.log(`Preparing ${candidates.length} alert(s) from ${batches.join(', ')}…`);

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

  // One read per notebook and per base payload, shared by every alert in it.
  const notebooks = new Map<string, ReturnType<Ctx['sections']>>();
  const basePayloads = new Map<string, Promise<Array<{ id?: string; state?: { input?: { value?: string } } }>>>();
  const ctx: Ctx = {
    args,
    index,
    settings,
    run: (query, windowMs) => {
      const end = new Date();
      return dql.query({
        query,
        defaultTimeframeStart: new Date(end.getTime() - windowMs).toISOString(),
        defaultTimeframeEnd: end.toISOString(),
        // One past the cap is enough to know a split is too big for Davis.
        maxResultRecords: DAVIS_SERIES_CAP + 1,
        fetchTimeoutSeconds: 120,
      });
    },
    sections: (notebookId) => {
      let p = notebooks.get(notebookId);
      if (!p) {
        p = docs.getDocumentFull(notebookId, true).then((d) => {
          const content = (typeof d.content === 'string' ? JSON.parse(d.content) : d.content) as { sections?: unknown };
          return Array.isArray(content?.sections) ? content.sections : [];
        });
        notebooks.set(notebookId, p);
      }
      return p;
    },
    stagedFromBase: async (batch, objectId) => {
      let p = basePayloads.get(batch);
      if (!p) {
        const file = join(reviewDir, `${batch.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`);
        p = readFile(file, 'utf8')
          .then((t) => (JSON.parse(t) as { content?: { sections?: unknown } }).content?.sections)
          .then((s) => (Array.isArray(s) ? s : []))
          .catch(() => []);
        basePayloads.set(batch, p);
      }
      const section = (await p).find((s) => s?.id === `dql-${objectId}`);
      const v = section?.state?.input?.value;
      return typeof v === 'string' ? parseOriginalBlock(v) || undefined : undefined;
    },
    publishedQuery: async (objectId) => {
      const file = join(promoteDir, 'published', `${objectId}.json`);
      if (!existsSync(file)) return undefined;
      try {
        const rec = JSON.parse(await readFile(file, 'utf8')) as { value?: { analyzer?: { input?: Array<{ key?: string; value?: string }> } } };
        const inputs = rec.value?.analyzer?.input;
        return findQueryInput(Array.isArray(inputs) ? inputs : [])?.value;
      } catch {
        return undefined;
      }
    },
  };

  const started = Date.now();
  const outcomes: Array<Outcome | undefined> = new Array(candidates.length);
  let next = 0;
  let done = 0;
  let stop: unknown;
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
    throw new Error(
      `migrate-promote-detectors: the Settings API refused the token (${errText(stop)}). ` +
        'It needs settings:objects:read and settings:objects:write for builtin:davis.anomaly-detectors. Stopped; nothing was written.',
    );
  }

  const finished = outcomes.filter((o): o is Outcome => o !== undefined);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const runDir = join(promoteDir, 'prepare', stamp);
  await mkdir(join(runDir, 'payloads'), { recursive: true });
  await writeFile(join(runDir, 'plan.json'), JSON.stringify(finished.map((o) => o.item), null, 2));
  for (const o of finished) {
    if (o.payload) await writeFile(join(runDir, 'payloads', `${o.item.objectId}.json`), JSON.stringify(o.payload, null, 2));
  }
  const report = renderReport(finished, {
    env: envIdFromBaseUrl(args.baseUrl),
    batches,
    tracker: trackerPath,
    stamp: new Date().toISOString(),
    unknownBatches,
  });
  await writeFile(join(runDir, 'report.md'), report);

  const n = (r: PublishPlanItem['result']) => finished.filter((o) => o.item.result === r).length;
  console.log('');
  console.log(`${n('ready')} ready (server validation passed), ${n('recorded')} already published (recorded only), ${n('skipped')} skipped, of ${finished.length}.`);
  for (const [gate, k] of countBy(finished.filter((o) => o.item.result === 'skipped'), (o) => o.gate)) {
    console.log(`  ${String(k).padStart(4)}  ${gate}`);
  }
  const overridden = finished.filter((o) => o.item.override && o.item.result !== 'skipped').length;
  if (overridden) console.log(`  ${overridden} going out under a publish_override (listed in the report).`);
  console.log('');
  console.log(`Report: ${join(runDir, 'report.md')}`);
  console.log(`Plan and payloads: ${runDir}. Nothing was written to the tenant or the workbook.`);
}
