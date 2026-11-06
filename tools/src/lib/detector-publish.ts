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

import type { BindingOutcome } from './detector-binding.ts';
import { PUBLISH_OVERRIDES, isReadyToPublish, parsePublishOverride, type PublishOverride } from './decision-states.ts';
import { envIdFromBaseUrl } from './paths.ts';

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
