/**
 * detector-publish — the part of publishing a reviewed alert that needs no
 * tenant: which alerts a run may touch, whether an owner changed an alert since
 * its review card was staged, and what to do when the approved query emits no
 * entity. Also the same questions for verifying and rolling back a publish:
 * which published alerts a run acts on, and what a rollback may write.
 *
 * Pure on purpose. The publish commands do the Settings, notebook and DQL I/O
 * and ask this module what to do with the answers, so every gate that decides
 * whether a live alert is overwritten can be unit-tested without a tenant.
 */

import { SOURCE_ID_DIM, type BindingOutcome } from './detector-binding.ts';
import { findQueryInput, type EventTemplateChange } from './detector-rewrite.ts';
import { PUBLISH_OVERRIDES, isReadyToPublish, parsePublishOverride, type PublishOverride } from './decision-states.ts';
import { DETECTOR_MARKER_RE, parseOriginalBlock, parseReviewQuery } from './detector-notebook.ts';
import { codeMask, timeseriesCommands } from './dql-command.ts';
import { envIdFromBaseUrl } from './paths.ts';
import { SettingsApiError } from '../dynatrace/settings.ts';
import { DqlError } from '../dynatrace/dql.ts';
import { DocumentApiError } from '../dynatrace/document.ts';

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
  /** The row's `status`, trimmed and lower-cased: `rolled-back` on a row re-approved after a rollback. */
  status: string;
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
      const status = (row.status ?? '').trim().toLowerCase();
      if (PUBLISHED_STATUSES.has(status)) continue;
      const reviewer = (row.reviewer ?? '').trim();
      const candidate: PublishCandidate = { objectId: d.objectId, title: d.title, batch: b.batch, notebookId: b.notebookId!, reviewer, status };
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
 * The batch holding each alert's newest card, as `selectForPublish` decides it:
 * the last batch with a review notebook that lists the alert.
 */
function ownerBatches(batches: ManifestBatch[]): Map<string, string> {
  const ownerBatch = new Map<string, string>();
  for (const b of batches.filter((x) => x.notebookId)) {
    for (const d of b.detectors ?? []) ownerBatch.set(d.objectId, b.batch);
  }
  return ownerBatch;
}

/**
 * Why each of `ids` is not a candidate under the rules of `selectForPublish`:
 * the first rule it fails. For ids named with `--ids` that the selection left
 * out, so a typo or a stale id is reported rather than silently dropped.
 */
export function whyNotSelected(
  ids: string[],
  rows: Map<string, Record<string, string>>,
  batches: ManifestBatch[],
  opts: { batches: string[] },
): Array<{ id: string; reason: string }> {
  const ownerBatch = ownerBatches(batches);
  const wanted = new Set(opts.batches);
  return ids.map((id) => {
    const owner = ownerBatch.get(id);
    if (!owner) return { id, reason: 'in no published review batch' };
    if (!wanted.has(owner)) return { id, reason: `its review card is in ${owner}, not in ${opts.batches.join(', ')}` };
    const row = rows.get(id);
    if (!row) return { id, reason: 'not on the alerts sheet' };
    const status = (row.status ?? '').trim();
    if (PUBLISHED_STATUSES.has(status.toLowerCase())) return { id, reason: `already published (status ${status})` };
    if (!isReadyToPublish(row.decision)) {
      const decision = (row.decision ?? '').trim();
      return { id, reason: `decision is ${decision ? `"${decision}"` : 'empty'}, not Ready To Publish` };
    }
    return { id, reason: 'not selected' };
  });
}

/** One published alert a verify or rollback run acts on. */
export interface PublishedTarget {
  objectId: string;
  /** The sheet's name for it, else the manifest's title, else the id. */
  title: string;
  /** The review batch it was published from, per the manifest; absent when no batch lists it. */
  batch?: string;
  /** Its status on the sheet, trimmed and lower-cased. */
  status: string;
}

/**
 * The alerts a verify or rollback run acts on: rows of the alerts sheet whose
 * `status` is one of `statuses`, in sheet order. `batches` keeps those whose
 * review batch is one of them, membership read from the manifest by the rule
 * the publish used (the last published batch that lists the alert); `ids` keeps
 * the named ones. Both given, an alert must pass both. Neither given, every row
 * with the status is taken, an alert that is in no batch included (the tool
 * records one an owner had already applied by hand).
 *
 * `unknownBatches` are requested batches the manifest has no published review
 * notebook for. `notSelected` says why each named id was left out, so a typo or
 * a stale id is reported rather than silently dropped.
 */
export function selectPublished(
  rows: Map<string, Record<string, string>>,
  batches: ManifestBatch[],
  opts: { statuses: readonly string[]; batches?: string[]; ids?: string[] },
): { targets: PublishedTarget[]; unknownBatches: string[]; notSelected: Array<{ id: string; reason: string }> } {
  const ownerBatch = ownerBatches(batches);
  const known = new Set(batches.filter((b) => b.notebookId).map((b) => b.batch));
  const unknownBatches = (opts.batches ?? []).filter((b) => !known.has(b));
  const wantedBatches = opts.batches?.length ? new Set(opts.batches) : undefined;
  const wantedIds = opts.ids?.length ? new Set(opts.ids) : undefined;
  const statuses = new Set(opts.statuses.map((s) => s.toLowerCase()));
  const statusText = opts.statuses.join(' or ');
  const titles = new Map<string, string>();
  for (const b of batches) for (const d of b.detectors ?? []) if (d.title) titles.set(d.objectId, d.title);

  const why = (id: string): string | undefined => {
    const row = rows.get(id);
    if (!row) return 'not on the alerts sheet';
    const status = (row.status ?? '').trim();
    if (!statuses.has(status.toLowerCase())) return `status is ${status ? `"${status}"` : 'empty'}, not ${statusText}`;
    if (wantedBatches) {
      const batch = ownerBatch.get(id);
      if (!batch) return 'in no published review batch';
      if (!wantedBatches.has(batch)) return `its review card is in ${batch}, not in ${[...wantedBatches].join(', ')}`;
    }
    return undefined;
  };

  const targets: PublishedTarget[] = [];
  for (const [id, row] of rows) {
    if (wantedIds && !wantedIds.has(id)) continue;
    if (why(id)) continue;
    const name = (row.name ?? '').trim();
    const target: PublishedTarget = { objectId: id, title: name || titles.get(id) || id, status: (row.status ?? '').trim().toLowerCase() };
    const batch = ownerBatch.get(id);
    if (batch) target.batch = batch;
    targets.push(target);
  }
  const notSelected = [...(wantedIds ?? [])].flatMap((id) => {
    const reason = why(id);
    return reason ? [{ id, reason }] : [];
  });
  return { targets, unknownBatches, notSelected };
}

/**
 * How the live alert's query relates to the review:
 *   none              still the classic query the card was staged from; safe to publish
 *   already-published it already IS the approved query (a re-run after a publish
 *                     whose sheet write failed); record it, do not write again
 *   edited            an owner changed it after review
 *   owner-migrated    differs, and no classic references are left: the owner
 *                     already migrated it
 *   unknown           no copy of the staged query could be found, so no comparison is possible
 */
export type Drift = 'none' | 'edited' | 'owner-migrated' | 'already-published' | 'unknown';

/**
 * Compare the live query with the approved one, the one a previous apply
 * published (when given) and the known copies of the one the card was staged
 * from, ignoring leading and trailing whitespace. Equal to any staged copy is
 * `none`; it drifts only when it equals none of them, and is `unknown` when no
 * copy is known. `already-published` is checked first: after a publish
 * the live query differs from the staged one and must not read as an owner edit.
 * It equals the approved query only when the publish changed nothing else; a
 * publish also adds the entity to the split or appends a node-name column, so
 * after a publish whose sheet write failed it equals `publishedQuery` instead.
 */
export function driftOf(a: {
  liveQuery: string;
  stagedQuery?: string;
  /** More copies of the staged query (see `stagedQueriesOf`); equal to any of them, or to `stagedQuery`, is `none`. */
  stagedQueries?: string[];
  approvedQuery: string;
  /** The query a previous apply recorded as published, when there is one. */
  publishedQuery?: string;
  /** More queries an earlier apply wrote, or may have (its pending record); equal to any is `already-published`. */
  publishedQueries?: string[];
  liveIsMigrated: boolean;
}): Drift {
  const live = a.liveQuery.trim();
  if (live === a.approvedQuery.trim()) return 'already-published';
  const published = [a.publishedQuery, ...(a.publishedQueries ?? [])].map((q) => q?.trim()).filter((q): q is string => !!q);
  if (published.includes(live)) return 'already-published';
  const staged = [a.stagedQuery, ...(a.stagedQueries ?? [])].map((q) => q?.trim()).filter((q): q is string => !!q);
  if (!staged.length) return 'unknown';
  if (staged.includes(live)) return 'none';
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
 *
 * A tile is this alert's only when `parseReviewQuery` reads this alert's id out
 * of it. A tile whose markers name several alerts (a reviewer pasted one card's
 * tile into another's) is an error for every alert it names: read by its first
 * marker it would hand the other alert this alert's query.
 */
export function findApprovedTile(
  sections: Array<{ type?: string; state?: { input?: { value?: string } } }>,
  objectId: string,
): { value: string } | { error: string } {
  const hits: string[] = [];
  let merged = false;
  for (const s of sections ?? []) {
    const value = s?.type === 'dql' ? s.state?.input?.value : undefined;
    if (typeof value !== 'string') continue;
    const ids = new Set([...value.matchAll(ALL_MARKERS_RE)].map((m) => m[1]));
    if (!ids.has(objectId)) continue;
    if (ids.size > 1) merged = true;
    else if (parseReviewQuery(value).objectId === objectId) hits.push(value);
  }
  if (merged) return { error: 'tile carries markers for several alerts' };
  if (hits.length === 0) return { error: 'query tile not found' };
  if (hits.length > 1) return { error: 'two query tiles for this alert' };
  return { value: hits[0]! };
}

/** A place the classic query a card was staged from can be read. */
export type StagedFrom = 'base' | 'archive' | 'tile';

type PayloadSections = Array<{ id?: string; state?: { input?: { value?: string } } }>;

/**
 * Every known copy of the classic query a review card was staged from, in this
 * order: the base payload `<batch>.json` (what the tool last wrote), the
 * archived payload of the same name, and the reference block of the live tile.
 * None of them is right every time: a prepare run once overwrote a base payload;
 * an archived payload can predate the notebook (the prepare run wrote it, the
 * apply run that created the notebook did not); reviewers edit the tile's block.
 * So the drift check takes them all (`driftOf` `stagedQueries`): an alert still
 * equal to any of them was not changed by its owner. A source counts only when
 * it has the card and the card its reference block.
 */
export function stagedQueriesOf(
  objectId: string,
  sources: { base?: PayloadSections; archive?: PayloadSections; tileValue: string },
): Array<{ from: StagedFrom; query: string }> {
  const fromPayload = (sections: PayloadSections | undefined): string | undefined => {
    const value = (sections ?? []).find((s) => s?.id === `dql-${objectId}`)?.state?.input?.value;
    return typeof value === 'string' ? parseOriginalBlock(value) || undefined : undefined;
  };
  const out: Array<{ from: StagedFrom; query: string }> = [];
  const base = fromPayload(sources.base);
  if (base) out.push({ from: 'base', query: base });
  const archive = fromPayload(sources.archive);
  if (archive) out.push({ from: 'archive', query: archive });
  const tile = parseOriginalBlock(sources.tileValue);
  if (tile) out.push({ from: 'tile', query: tile });
  return out;
}

/**
 * The token was refused (HTTP 401 or 403) by one of the APIs a publish calls:
 * Settings, DQL or the Document API. Every later call would fail the same way,
 * and an apply must not keep writing with a token that is half working, so the
 * run stops at the first one instead of reporting each alert.
 */
export function isAuthFailure(e: unknown): boolean {
  return (
    (e instanceof SettingsApiError || e instanceof DqlError || e instanceof DocumentApiError) && (e.status === 401 || e.status === 403)
  );
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

/**
 * The `--limit` flag as the CLI parsed it: a value, `true` when given with no
 * value, or absent. Anything but a positive integer throws, naming what was
 * typed: a limit that silently read as "no limit" would publish more than asked.
 */
export function parseLimit(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) throw new Error('--limit needs a value: a positive integer');
  if (!/^\s*[1-9]\d*\s*$/.test(raw)) throw new Error(`--limit "${raw}" must be a positive integer`);
  return Number(raw.trim());
}

/**
 * The `--ids` flag as the CLI parsed it: a comma-separated list, `true` when
 * given with no value, or absent. A flag with no ids throws: read as "no filter",
 * it would turn `--apply --ids` into a publish of the whole batch.
 */
export function parseIds(raw: string | boolean | undefined): string[] | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) throw new Error('--ids needs a value: a comma-separated list of alert ids');
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) throw new Error(`--ids "${raw}" names no alert id`);
  return ids;
}

/**
 * The `--batches` flag as the CLI parsed it, by the rules of `parseIds`: a flag
 * with no batch throws, since read as "no filter" it would widen the run.
 */
export function parseBatches(raw: string | boolean | undefined): string[] | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) throw new Error('--batches needs a value: a comma-separated list of review batches, e.g. batch-03,batch-04');
  const batches = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!batches.length) throw new Error(`--batches "${raw}" names no review batch`);
  return batches;
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

/** A query column renamed so a placeholder can read it: `| fieldsAdd <alias> = \`<column>\``. */
export interface ColumnAlias {
  alias: string;
  column: string;
}

/**
 * The name a placeholder should use for `column`. A name without whitespace is
 * used as it is. For one with whitespace (`Cluster Name`), it is unproven that
 * Davis fills `{dims:Cluster Name}`, while a column a later `fieldsAdd` adds is
 * measured to fill. So the placeholder reads an emitted column of the same
 * spelling without spaces when there is one, else an alias: the column with
 * each whitespace run replaced by `_`, which the caller must add to the query.
 */
function placeholderColumn(column: string, columns: ReadonlySet<string>): { name: string; alias?: ColumnAlias } {
  if (!/\s/.test(column)) return { name: column };
  const want = squash(column);
  const spaceFree = [...columns].find((c) => !/\s/.test(c) && squash(c) === want);
  if (spaceFree) return { name: spaceFree };
  const alias = column.trim().replace(/\s+/g, '_');
  return { name: alias, alias: { alias, column } };
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
 *   - a placeholder that ends up naming a column with whitespace in it reads an
 *     emitted spelling without whitespace instead, or an alias the caller adds
 *     (`aliases`; see `placeholderColumn`)
 * Every placeholder keeps its form, `dims:` or bare.
 *
 * Two properties are rebuilt rather than mapped: the classic `dt.source_entity`
 * binding is dropped and `dt.smartscape_source.id` is `{<entityColumn>}`, or
 * absent without an entity column. An entity column always binds; `withoutEntity`
 * only decides what happens to the entity placeholders when there is none.
 *
 * `nameColumn` is `<entityColumn>.name` when the result references it. The query
 * may not emit it; the caller adds it (`withNodeNameColumn`) when it does not.
 * `aliases` lists, once each, the `fieldsAdd <alias> = \`<column>\`` the query
 * needs for the placeholders now naming an alias (`withColumnAliases`).
 * `unresolved` lists each unmapped placeholder once, as written. The properties
 * given are not modified.
 */
export function mapEventFields(
  props: EventProp[],
  ctx: { columns: ReadonlySet<string>; entityColumn?: string; withoutEntity: boolean },
): { props: EventProp[]; changes: EventTemplateChange[]; unresolved: string[]; nameColumn?: string; aliases: ColumnAlias[] } {
  const entity = ctx.entityColumn;
  const entityName = entity ? `${entity}.name` : undefined;
  const binding = entity ? `{${entity}}` : undefined;
  const changes: EventTemplateChange[] = [];
  const unresolved: string[] = [];
  const aliases: ColumnAlias[] = [];
  let nameColumn: string | undefined;

  /** The placeholder for an emitted column, through an alias when its name has whitespace. */
  const placeholderFor = (form: string, column: string): string => {
    const p = placeholderColumn(column, ctx.columns);
    if (p.alias && !aliases.some((a) => a.alias === p.alias!.alias)) aliases.push(p.alias);
    return `{${form}${p.name}}`;
  };

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
        out += /\s/.test(name) ? placeholderFor(form, name) : whole;
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
          out += placeholderFor(form, column);
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

  return { props: out, changes, unresolved, nameColumn, aliases };
}

/**
 * The query with a column added that holds the entity's name, for event text that
 * reads `{dims:<entity>.name}`. A trailing comment ends at the newline, so the
 * new command is always on its own line.
 */
export function withNodeNameColumn(query: string, entityColumn: string): string {
  return `${query.trimEnd()}\n| fieldsAdd ${entityColumn}.name = getNodeName(${entityColumn})`;
}

/**
 * The query with the alias columns `mapEventFields` asked for, on one new line:
 * `| fieldsAdd Cluster_Name = \`Cluster Name\``. A copy after the timeseries does
 * not change the series. Unchanged when there are none.
 */
export function withColumnAliases(query: string, aliases: ColumnAlias[]): string {
  if (!aliases.length) return query;
  return `${query.trimEnd()}\n| fieldsAdd ${aliases.map((a) => `${a.alias} = \`${a.column}\``).join(', ')}`;
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

/**
 * Which of the parts a publish writes differ between two detector values, by the
 * comparison of `publishedPartsEqual`: empty when they agree. For saying what an
 * owner changed, or what a write did not store.
 */
export function publishedPartsDiff(a: Record<string, unknown>, b: Record<string, unknown>): Array<'query' | 'event fields'> {
  const pa = publishedParts(a);
  const pb = publishedParts(b);
  const out: Array<'query' | 'event fields'> = [];
  if (sortedJson(pa.query) !== sortedJson(pb.query)) out.push('query');
  if (sortedJson(pa.properties) !== sortedJson(pb.properties)) out.push('event fields');
  return out;
}

/** An array of objects that each have a distinct string `key`, such as `analyzer.input`. */
function keyedEntries(v: unknown[]): Map<string, unknown> | undefined {
  const out = new Map<string, unknown>();
  for (const e of v) {
    const key = e && typeof e === 'object' && !Array.isArray(e) ? (e as { key?: unknown }).key : undefined;
    if (typeof key !== 'string' || out.has(key)) return undefined;
    out.set(key, e);
  }
  return out;
}

function collectDiffs(a: unknown, b: unknown, path: string, out: string[]): void {
  if (sortedJson(a) === sortedJson(b)) return;
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) collectDiffs(a[k], b[k], path ? `${path}.${k}` : k, out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const ka = keyedEntries(a);
    const kb = keyedEntries(b);
    if (ka && kb) {
      for (const k of [...new Set([...ka.keys(), ...kb.keys()])].sort()) collectDiffs(ka.get(k), kb.get(k), `${path}[${k}]`, out);
      return;
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) collectDiffs(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  out.push(path || '(the whole value)');
}

/**
 * Every path at which two detector values differ, OUTSIDE the two parts a
 * publish writes (the query input's value and the event properties, which have
 * their own check). Key order does not count; `analyzer.input` and other arrays
 * of keyed entries are compared by key (`analyzer.input[threshold].value`),
 * other arrays by position. For the re-read after a write: a field the server
 * changed or added on its own is worth a note, not a failure. Neither argument
 * is modified.
 */
export function diffOutsidePublishedParts(sent: Record<string, unknown>, stored: Record<string, unknown>): string[] {
  const strip = (v: Record<string, unknown>): Record<string, unknown> => {
    const c = structuredClone(v ?? {});
    const inputs = (c.analyzer as AnalyzerInputs | undefined)?.input;
    const q = findQueryInput(Array.isArray(inputs) ? inputs : []);
    if (q) delete q.value;
    if (c.eventTemplate && typeof c.eventTemplate === 'object') delete (c.eventTemplate as { properties?: unknown }).properties;
    return c;
  };
  const out: string[] = [];
  collectDiffs(strip(sent), strip(stored), '', out);
  return out;
}

/**
 * Whether a rollback may put an alert's snapshot back. `restore` when the live
 * alert still has the query and event fields that were published (its other
 * fields are not compared: a rollback leaves them as they are); otherwise the
 * alert was edited after publishing and a rollback would discard that edit, so
 * `refuse-edited`, unless `force`.
 */
export function rollbackDecision(live: Record<string, unknown>, published: Record<string, unknown>, force: boolean): 'restore' | 'refuse-edited' {
  return force || publishedPartsEqual(live, published) ? 'restore' : 'refuse-edited';
}

/**
 * The value a rollback writes: a copy of `live` with only the two parts a publish
 * wrote taken back from `snapshot` (the value snapshotted before the publish):
 * the query input's value, under whichever key `live` uses, and the event
 * template's properties (removed when the snapshot had none). Everything else
 * stays as it is live, so a change an owner made since the publish (a threshold,
 * `enabled`, another input) survives the rollback, and a snapshot older than the
 * publish cannot revert a field the publish never touched. Throws when either
 * value has no query input, since restoring the event fields alone would leave a
 * half-rolled-back alert. Neither argument is modified.
 */
export function restoreValue(live: Record<string, unknown>, snapshot: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(live);
  const outInputs = (out.analyzer as AnalyzerInputs | undefined)?.input;
  const target = findQueryInput(Array.isArray(outInputs) ? outInputs : []);
  if (!target) {
    throw new Error('The live alert has no query input (analyzer.input key "query" or "query.expression"), so there is nowhere to put the snapshot query back.');
  }
  const snapInputs = (snapshot?.analyzer as AnalyzerInputs | undefined)?.input;
  const source = findQueryInput(Array.isArray(snapInputs) ? snapInputs : []);
  if (!source || typeof source.value !== 'string') {
    throw new Error('The snapshot has no query input (analyzer.input key "query" or "query.expression"), so there is no query to restore.');
  }
  target.value = source.value;

  const snapTemplate = snapshot.eventTemplate as { properties?: unknown } | undefined;
  if (Array.isArray(snapTemplate?.properties)) {
    const template = (out.eventTemplate ??= {}) as { properties?: unknown };
    template.properties = structuredClone(snapTemplate.properties);
  } else if (out.eventTemplate && typeof out.eventTemplate === 'object') {
    delete (out.eventTemplate as { properties?: unknown }).properties;
  }
  return out;
}

/**
 * Are two detector values the same, every field of them, ignoring object key
 * order? For the apply re-read: a publish writes the whole value it planned, so
 * any change made since planning (a threshold, `enabled`, an event field) would
 * be undone by it, not only a change to the query.
 */
export function detectorValuesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return sortedJson(a) === sortedJson(b);
}
