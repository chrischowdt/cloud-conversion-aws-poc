/**
 * detector-publish — the part of publishing a reviewed alert that needs no
 * tenant: which alerts a run may touch, whether an owner changed an alert since
 * its review card was staged, and what to do when the approved query emits no
 * entity.
 *
 * Pure on purpose. The publish commands do the Settings, notebook and DQL I/O
 * and ask this module what to do with the answers, so every gate that decides
 * whether a live alert is overwritten can be unit-tested without a tenant.
 */

import { SOURCE_ID_DIM, type BindingOutcome } from './detector-binding.ts';
import { findQueryInput, type EventTemplateChange } from './detector-rewrite.ts';
import { PUBLISH_OVERRIDES, isReadyToPublish, parsePublishOverride, type PublishOverride } from './decision-states.ts';
import { DETECTOR_MARKER_RE } from './detector-notebook.ts';
import { codeMask, timeseriesCommands } from './dql-command.ts';
import { envIdFromBaseUrl } from './paths.ts';
import { SettingsApiError } from '../dynatrace/settings.ts';

/** One review batch as the stage-detectors manifest records it. */
export interface ManifestBatch {
  batch: string;
  /** Set once the batch's review notebook exists. A prepare run or a failed create leaves it unset. */
  notebookId?: string;
  detectors: Array<{ objectId: string; title: string }>;
}

export interface PublishCandidate {
  objectId: string;
  /** The title the manifest recorded when the alert was staged. */
  title: string;
  batch: string;
  /** The batch's review notebook: where the approved query is read from. */
  notebookId: string;
  /** Who approved it (trimmed). Empty when nobody is named. */
  reviewer: string;
  /** The reviewer's `publish_override`, only when it is valid and a reviewer is named. */
  override?: PublishOverride;
  /** Why a `publish_override` on the row was ignored. */
  note?: string;
}

/** Statuses on the alerts sheet that mean the tool already published the alert. */
const PUBLISHED_STATUSES = new Set(['promoted', 'verified']);

const OVERRIDE_CHOICES = PUBLISH_OVERRIDES.map((v) => `"${v}"`).join(' or ');

/**
 * The alerts a run may publish: `decision` Ready To Publish, not already
 * published, in one of the named batches. Batch membership comes from the
 * manifest, never from the sheet's `review_batch` column, so publishing does not
 * depend on that column having been backfilled.
 *
 * Only a batch with a `notebookId` counts: without a notebook there is nowhere
 * to read the approved query from, so a requested batch that has none is
 * reported in `unknownBatches` like a misspelt one. An alert listed in several
 * batches belongs to the last published one (the same rule the tracker's
 * `review_batch` backfill uses), so it is selected once, against the notebook
 * that holds its newest card. Candidates come out in manifest order.
 */
export function selectForPublish(
  rows: Map<string, Record<string, string>>,
  batches: ManifestBatch[],
  opts: { batches: string[]; ids?: string[]; limit?: number },
): { candidates: PublishCandidate[]; unknownBatches: string[] } {
  const published = batches.filter((b) => b.notebookId);
  const known = new Set(published.map((b) => b.batch));
  const unknownBatches = opts.batches.filter((b) => !known.has(b));
  const wanted = new Set(opts.batches);
  const onlyIds = opts.ids ? new Set(opts.ids) : undefined;

  const ownerIndex = new Map<string, number>();
  published.forEach((b, i) => {
    for (const d of b.detectors ?? []) ownerIndex.set(d.objectId, i);
  });

  const candidates: PublishCandidate[] = [];
  const seen = new Set<string>();
  published.forEach((b, i) => {
    if (!wanted.has(b.batch)) return;
    for (const d of b.detectors ?? []) {
      if (ownerIndex.get(d.objectId) !== i) continue;
      if (onlyIds && !onlyIds.has(d.objectId)) continue;
      if (seen.has(d.objectId)) continue; // listed twice in one batch
      seen.add(d.objectId);
      const row = rows.get(d.objectId);
      // A decision of Published is not Ready To Publish, so it is already out here.
      if (!row || !isReadyToPublish(row.decision)) continue;
      if (PUBLISHED_STATUSES.has((row.status ?? '').trim().toLowerCase())) continue;
      const reviewer = (row.reviewer ?? '').trim();
      const candidate: PublishCandidate = { objectId: d.objectId, title: d.title, batch: b.batch, notebookId: b.notebookId!, reviewer };
      const override = parsePublishOverride(row.publish_override);
      if (override === 'invalid') {
        candidate.note = `publish_override ignored: "${(row.publish_override ?? '').trim()}" is not ${OVERRIDE_CHOICES}.`;
      } else if (override && !reviewer) {
        candidate.note = 'publish_override ignored: it needs a reviewer on the row, so every override has a name on it.';
      } else if (override) {
        candidate.override = override;
      }
      candidates.push(candidate);
    }
  });

  return { candidates: opts.limit === undefined ? candidates : candidates.slice(0, opts.limit), unknownBatches };
}

/**
 * How the live alert's query relates to the review:
 *   none              still the classic query the card was staged from; safe to publish
 *   already-published it already IS the approved query (a re-run after a publish
 *                     whose sheet write failed); record it, do not write again
 *   edited            an owner changed it after review
 *   owner-migrated    differs, and no classic references are left: the owner
 *                     already migrated it
 *   unknown           the staged query could not be found, so no comparison is possible
 */
export type Drift = 'none' | 'edited' | 'owner-migrated' | 'already-published' | 'unknown';

/**
 * Compare the live query with the approved one, the one a previous apply
 * published (when given) and the one the card was staged from, ignoring leading
 * and trailing whitespace. `already-published` is checked first: after a publish
 * the live query differs from the staged one and must not read as an owner edit.
 * It equals the approved query only when the publish changed nothing else; a
 * publish also adds the entity to the split or appends a node-name column, so
 * after a publish whose sheet write failed it equals `publishedQuery` instead.
 */
export function driftOf(a: {
  liveQuery: string;
  stagedQuery?: string;
  approvedQuery: string;
  /** The query a previous apply recorded as published, when there is one. */
  publishedQuery?: string;
  liveIsMigrated: boolean;
}): Drift {
  const live = a.liveQuery.trim();
  if (live === a.approvedQuery.trim()) return 'already-published';
  const published = a.publishedQuery?.trim();
  if (published && live === published) return 'already-published';
  const staged = a.stagedQuery?.trim();
  if (!staged) return 'unknown';
  if (live === staged) return 'none';
  return a.liveIsMigrated ? 'owner-migrated' : 'edited';
}

/**
 * What to do about the entity of an approved query that emits none:
 *   use-bound  publish this query (the approved one with the entity added)
 *   unbound    publish the approved query as it is, with no binding property
 *   skip       leave the alert out of this run, for this reason
 */
export type EntityDecision = { action: 'use-bound'; query: string } | { action: 'unbound' } | { action: 'skip'; reason: string };

/**
 * Turn a `resolveBinding` outcome and the reviewer's override into a decision.
 * `without-entity` overrides everything: the reviewer says the alert is not
 * about one resource. `per-resource` only accepts an alert that would fire once
 * per resource; it cannot add an entity the check could not add (series cap,
 * query shape, failed check). Without an override, an alert whose grain changes
 * or that cannot be bound goes back for review rather than out half-bound.
 *
 * An outcome that should carry a query but does not, and `already` (the caller
 * only asks about queries that emit no entity, so it contradicts the caller's
 * own check), skip rather than guess.
 */
export function decideEntity(outcome: BindingOutcome, override?: PublishOverride): EntityDecision {
  if (override === 'without-entity') return { action: 'unbound' };
  const detail = outcome.warning?.text ? ` ${outcome.warning.text}` : '';
  switch (outcome.kind) {
    case 'bound':
    case 'unverified':
      return outcome.query ? { action: 'use-bound', query: outcome.query } : noQuery(outcome.kind);
    case 'per-entity':
      if (!outcome.query) return noQuery(outcome.kind);
      if (override === 'per-resource') return { action: 'use-bound', query: outcome.query };
      return {
        action: 'skip',
        reason:
          `emits no entity, and adding one would split this alert into one per resource, so it goes back for review.${detail} ` +
          `Set publish_override to ${OVERRIDE_CHOICES} to publish anyway.`,
      };
    case 'already':
      return {
        action: 'skip',
        reason: 'the binding check found an entity the query already binds, but the query emits no entity column the publish can use, so it goes back for review.',
      };
    case 'too-many':
    case 'skipped':
    case 'error':
      return {
        action: 'skip',
        reason:
          (override === 'per-resource'
            ? `publish_override "${PUBLISH_OVERRIDES[0]}" cannot apply: no entity can be added, so it goes back for review.`
            : 'emits no entity, and none can be added, so it goes back for review.') +
          `${detail} Set publish_override to "${PUBLISH_OVERRIDES[1]}" to publish it with no entity.`,
      };
  }
}

function noQuery(kind: BindingOutcome['kind']): EntityDecision {
  return { action: 'skip', reason: `the binding check reported "${kind}" without a query, so it goes back for review.` };
}

/** Every marker line in a tile, wherever it sits. */
const ALL_MARKERS_RE = new RegExp(DETECTOR_MARKER_RE.source, 'gm');

/**
 * The review notebook's query tile for one alert, found by its marker line
 * (`// [CCT-DETECTOR objectId=…]`), never by position: reviewers add, move and
 * duplicate tiles. Only DQL tiles count, so a marker quoted in a markdown card
 * is not a query. Two tiles carrying the same alert's marker (a reviewer
 * duplicated it) is an error rather than a guess, since either could be the
 * approved one. The whole tile value comes back; the caller reads the approved
 * query (`parseReviewQuery`) and the staged classic query (`parseOriginalBlock`)
 * out of it.
 */
export function findApprovedTile(
  sections: Array<{ type?: string; state?: { input?: { value?: string } } }>,
  objectId: string,
): { value: string } | { error: string } {
  const hits: string[] = [];
  for (const s of sections ?? []) {
    const value = s?.type === 'dql' ? s.state?.input?.value : undefined;
    if (typeof value !== 'string') continue;
    if ([...value.matchAll(ALL_MARKERS_RE)].some((m) => m[1] === objectId)) hits.push(value);
  }
  if (hits.length === 0) return { error: 'query tile not found' };
  if (hits.length > 1) return { error: 'two query tiles for this alert' };
  return { value: hits[0]! };
}

/**
 * The token cannot read or write settings: every later call would fail the same
 * way, so the run stops at the first one instead of reporting each alert.
 */
export function isAuthFailure(e: unknown): boolean {
  return e instanceof SettingsApiError && (e.status === 401 || e.status === 403);
}

/**
 * Refuse an `--apply` run unless `--allow-env` names the environment the token
 * is connected to, so a token pointed at the wrong tenant cannot write there by
 * accident. Not applying needs no allowance: a prepare run writes nothing to a
 * tenant.
 */
export function assertAllowedEnv(baseUrl: string, allowEnv: string | undefined, apply: boolean): void {
  if (!apply) return;
  const connected = envIdFromBaseUrl(baseUrl);
  const allowed = (allowEnv ?? '').trim();
  if (!allowed) {
    throw new Error(`--allow-env <env-id> is required with --apply. The token is connected to "${connected}"; pass --allow-env ${connected} to write there.`);
  }
  if (allowed !== connected) {
    throw new Error(`Connected to "${connected}" but --allow-env says "${allowed}". Refusing.`);
  }
}

// ---------------------------------------------------------------------------
// Event template fields

/** One `eventTemplate.properties` entry. */
export type EventProp = { key?: string; value?: unknown };

/**
 * Placeholders Davis fills itself, whatever the query emits. A bare `{name}` that
 * is one of these is left alone.
 */
export const BUILTIN_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'threshold',
  'severity',
  'alert_condition',
  'violating_samples',
  'dealerting_samples',
  'sliding_window',
  'metricname',
  'metric_value',
  'baseline',
  'dims',
]);

const PLACEHOLDER_RE = /\{(dims:)?([^{}]+)\}/g;
/** A classic entity id placeholder name, and the same with its `.name` accessor. */
const CLASSIC_ENTITY_ID_RE = /^(dt\.entity\.[\w:]+|dt\.source_entity)$/;
const CLASSIC_ENTITY_NAME_RE = /^(dt\.entity\.[\w:]+|dt\.source_entity)\.name$/;
const CLASSIC_BINDING_KEY = 'dt.source_entity';

/** Spelling-insensitive form of a column name: case, spaces, underscores and backticks dropped. */
function squash(name: string): string {
  return name.toLowerCase().replace(/[\s_`]/g, '');
}

/**
 * The column a placeholder name stands for. An exact name wins. Otherwise the
 * columns that match ignoring case, spaces, underscores and backticks, and of
 * those the one without spaces: a rewritten metric key spells a dimension
 * `Broker_ID` while the series also carries `Broker ID`, and Davis reads the
 * underscore name reliably.
 */
function matchColumn(name: string, columns: ReadonlySet<string>): string | undefined {
  if (columns.has(name)) return name;
  const want = squash(name);
  if (!want) return undefined;
  const hits = [...columns].filter((c) => squash(c) === want);
  return hits.find((c) => !/\s/.test(c)) ?? hits[0];
}

/**
 * Point an alert's event template at the columns the approved query emits.
 *
 * Davis fills `{dims:X}` and bare `{X}` from any column of the query result, but
 * a placeholder that names a column the query does not emit goes out as literal
 * text in the alert. So every placeholder is resolved against `ctx.columns`:
 *   - built-ins (bare only) and names that are already a column stay as they are
 *   - a classic entity id or name (`dt.entity.*`, `dt.source_entity`, with `.name`)
 *     becomes the query's entity column (`ctx.entityColumn`) or its `.name`
 *     column. When there is no entity column and `ctx.withoutEntity` is set (the
 *     reviewer chose to publish with no entity) the placeholder is removed and the
 *     whitespace around it closed; otherwise it is reported unresolved
 *   - anything else matches a column ignoring case, spaces, underscores and
 *     backticks (see `matchColumn`), else it is reported unresolved
 * Every placeholder keeps its form, `dims:` or bare.
 *
 * Two properties are rebuilt rather than mapped: the classic `dt.source_entity`
 * binding is dropped and `dt.smartscape_source.id` is `{<entityColumn>}`, or
 * absent without an entity column. An entity column always binds; `withoutEntity`
 * only decides what happens to the entity placeholders when there is none.
 *
 * `nameColumn` is `<entityColumn>.name` when the result references it. The query
 * may not emit it; the caller adds it (`withNodeNameColumn`) when it does not.
 * `unresolved` lists each unmapped placeholder once, as written. The properties
 * given are not modified.
 */
export function mapEventFields(
  props: EventProp[],
  ctx: { columns: ReadonlySet<string>; entityColumn?: string; withoutEntity: boolean },
): { props: EventProp[]; changes: EventTemplateChange[]; unresolved: string[]; nameColumn?: string } {
  const entity = ctx.entityColumn;
  const entityName = entity ? `${entity}.name` : undefined;
  const binding = entity ? `{${entity}}` : undefined;
  const changes: EventTemplateChange[] = [];
  const unresolved: string[] = [];
  let nameColumn: string | undefined;

  const mapText = (text: string): string => {
    let out = '';
    let last = 0;
    let removed = false;
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      const whole = m[0];
      const form = m[1] ?? '';
      const name = m[2]!;
      out += text.slice(last, m.index!);
      last = m.index! + whole.length;

      if (!form && BUILTIN_PLACEHOLDERS.has(name)) {
        out += whole;
      } else if (ctx.columns.has(name)) {
        out += whole;
      } else if (entityName && name === entityName) {
        // Already the name column of the entity; the query still has to emit it.
        out += whole;
        nameColumn = entityName;
      } else if (CLASSIC_ENTITY_NAME_RE.test(name) || CLASSIC_ENTITY_ID_RE.test(name)) {
        const isName = CLASSIC_ENTITY_NAME_RE.test(name);
        if (entity) {
          out += `{${form}${isName ? entityName : entity}}`;
          if (isName) nameColumn = entityName;
        } else if (ctx.withoutEntity) {
          const next = text[last];
          if (next === undefined || /\s/.test(next)) out = out.replace(/[ \t]+$/, '');
          removed = true;
        } else {
          out += whole;
          if (!unresolved.includes(whole)) unresolved.push(whole);
        }
      } else {
        const column = matchColumn(name, ctx.columns);
        if (column) {
          out += `{${form}${column}}`;
        } else {
          out += whole;
          if (!unresolved.includes(whole)) unresolved.push(whole);
        }
      }
    }
    out += text.slice(last);
    return removed ? out.trim() : out;
  };

  const hasSmartscapeBinding = props.some((p) => p?.key === SOURCE_ID_DIM);
  const out: EventProp[] = [];
  let placed = false;
  for (const p of props) {
    if (p?.key === CLASSIC_BINDING_KEY) {
      const before = String(p.value ?? '');
      // The classic binding is replaced where it stood, unless a Smartscape one exists to keep.
      if (binding && !hasSmartscapeBinding && !placed) {
        out.push({ key: SOURCE_ID_DIM, value: binding });
        placed = true;
        changes.push({ field: `${CLASSIC_BINDING_KEY} → ${SOURCE_ID_DIM}`, before, after: binding });
      } else {
        changes.push({ field: CLASSIC_BINDING_KEY, before, after: '(removed)' });
      }
      continue;
    }
    if (p?.key === SOURCE_ID_DIM) {
      const before = String(p.value ?? '');
      if (!binding || placed) {
        changes.push({ field: SOURCE_ID_DIM, before, after: '(removed)' });
        continue;
      }
      placed = true;
      if (p.value !== binding) changes.push({ field: SOURCE_ID_DIM, before, after: binding });
      out.push({ ...p, value: binding });
      continue;
    }
    if (typeof p?.value === 'string') {
      const mapped = mapText(p.value);
      if (mapped !== p.value) changes.push({ field: String(p.key ?? ''), before: p.value, after: mapped });
      out.push({ ...p, value: mapped });
    } else {
      out.push({ ...p });
    }
  }
  if (binding && !placed) {
    out.push({ key: SOURCE_ID_DIM, value: binding });
    changes.push({ field: SOURCE_ID_DIM, before: '(absent)', after: binding });
  }

  return { props: out, changes, unresolved, nameColumn };
}

/**
 * The query with a column added that holds the entity's name, for event text that
 * reads `{dims:<entity>.name}`. A trailing comment ends at the newline, so the
 * new command is always on its own line.
 */
export function withNodeNameColumn(query: string, entityColumn: string): string {
  return `${query.trimEnd()}\n| fieldsAdd ${entityColumn}.name = getNodeName(${entityColumn})`;
}

// ---------------------------------------------------------------------------
// Columns without a run

/** `name =` (not `==`) at the start of an entry; the name may be backtick-quoted. */
const ASSIGNED_NAME_RE = /^\s*(?:`([^`]+)`|([\w.]+))\s*=(?!=)/;
const COMMAND_NAME_RE = /^\|\s*([A-Za-z]+)/;

/** Split on commas that sit outside every bracket. Expects code with strings and comments blanked. */
function topLevelEntries(code: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of code) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function assignedName(entry: string): string | undefined {
  const m = ASSIGNED_NAME_RE.exec(entry);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** The names a list of entries emits: the left side of `x = …`, or a bare name when `bare` is set. */
function entryNames(entries: string[], bare: boolean): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    const assigned = assignedName(entry);
    if (assigned) names.push(assigned);
    else if (bare) {
      const name = entry.replace(/`/g, '').trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/**
 * Every pipeline command at any bracket depth: its name and what follows the
 * name, up to the next `|` at that depth or the bracket that ends it.
 */
function pipelineCommands(code: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const starts: Array<number | undefined> = [];
  let depth = 0;
  const finish = (d: number, end: number): void => {
    const start = starts[d];
    if (start === undefined) return;
    starts[d] = undefined;
    const head = COMMAND_NAME_RE.exec(code.slice(start, end));
    if (head) out.push({ name: head[1]!, body: code.slice(start + head[0].length, end) });
  };
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if ('([{'.includes(c)) {
      depth++;
    } else if (')]}'.includes(c)) {
      finish(depth, i);
      depth = Math.max(0, depth - 1);
    } else if (c === '|') {
      finish(depth, i);
      starts[depth] = i;
    }
  }
  for (let d = 0; d < starts.length; d++) finish(d, code.length);
  return out;
}

/**
 * The columns a query is expected to emit, read from its text: each timeseries'
 * aggregation names, `timeframe`, `interval` and the names of its top-level
 * `by:{}` (an alias takes its left-hand name), plus every `fieldsAdd x =` and
 * `fields x = …` / bare `fields a, b` name. For when no run returned rows to read
 * the real columns from. It is partial on purpose (a `summarize`, `parse` or
 * `fieldsRename` adds columns it does not see); a missing column makes a
 * placeholder read as unresolved, which sends the alert back for review rather
 * than out with literal text.
 */
export function staticColumns(query: string): Set<string> {
  const mask = codeMask(query);
  // Split by UTF-16 unit, not code point: the mask is indexed by unit.
  const code = query.split('').map((c, i) => (mask[i] ? c : ' ')).join('');
  const columns = new Set<string>();

  const series = timeseriesCommands(query);
  if (series.length) {
    columns.add('timeframe');
    columns.add('interval');
  }
  for (const cmd of series) {
    for (const raw of topLevelEntries(code.slice(cmd.start, cmd.end))) {
      const entry = raw.trim();
      const by = /^by\s*:\s*\{([\s\S]*)\}$/.exec(entry);
      if (by) {
        for (const name of entryNames(topLevelEntries(by[1]!), true)) columns.add(name);
      } else if (entry.startsWith('{') && entry.endsWith('}')) {
        for (const name of entryNames(topLevelEntries(entry.slice(1, -1)), false)) columns.add(name);
      } else {
        const name = assignedName(entry);
        if (name) columns.add(name);
      }
    }
  }

  for (const { name, body } of pipelineCommands(code)) {
    if (name !== 'fieldsAdd' && name !== 'fields') continue;
    for (const column of entryNames(topLevelEntries(body), name === 'fields')) columns.add(column);
  }
  return columns;
}

// ---------------------------------------------------------------------------
// The value a publish writes, and comparing it

type AnalyzerInputs = { input?: Array<{ key?: string; value?: string }> };

/**
 * The detector value to write: a copy of `live` with the approved query in the
 * input that holds the query (whichever of `query` / `query.expression` the
 * detector uses) and `props` as the event template's properties. Nothing else
 * changes; the threshold, every other input, `enabled`, the title and the actor
 * stay exactly as they are live. Throws when the detector has no query input,
 * since publishing then would silently write nothing. Neither argument is modified.
 */
export function buildPublishValue(live: Record<string, unknown>, query: string, props: EventProp[]): Record<string, unknown> {
  const out = structuredClone(live);
  const analyzer = out.analyzer as AnalyzerInputs | undefined;
  const target = findQueryInput(Array.isArray(analyzer?.input) ? analyzer.input : []);
  if (!target) {
    throw new Error('The detector has no query input (analyzer.input key "query" or "query.expression"), so there is nowhere to put the approved query.');
  }
  target.value = query;
  const template = (out.eventTemplate ??= {}) as { properties?: EventProp[] };
  template.properties = structuredClone(props);
  return out;
}

/** Key order must not matter: the Settings API may hand a value back with its keys in any order. */
function sortedJson(v: unknown): string {
  return JSON.stringify(v, (_key, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : val,
  );
}

/** The two parts of a detector value a publish writes. Absent event properties read as none. */
function publishedParts(v: Record<string, unknown>): { query: string | null; properties: unknown[] } {
  const inputs = (v?.analyzer as AnalyzerInputs | undefined)?.input;
  const properties = (v?.eventTemplate as { properties?: unknown } | undefined)?.properties;
  return {
    query: findQueryInput(Array.isArray(inputs) ? inputs : [])?.value ?? null,
    properties: Array.isArray(properties) ? properties : [],
  };
}

/**
 * Do two detector values agree on the parts a publish writes: the query input and
 * the event properties? Compared as key-sorted JSON, so object key order and any
 * other field (defaults the API adds, the threshold, `enabled`) are ignored.
 * Property ORDER still counts: it is the order the template was written in.
 */
export function publishedPartsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return sortedJson(publishedParts(a)) === sortedJson(publishedParts(b));
}
