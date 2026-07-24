/**
 * asset-confidence — roll a scanned asset's per-query buckets + (optional)
 * compare-dashboard parity into a single migration confidence level + lane.
 *
 * Two lanes drive the placement pipeline (see migrate-* commands):
 *   - fast   : safe enough to cut over in-place after a light approval — the
 *              rewrite is fully clean AND empirical parity is all-match.
 *   - review : must go through a published review copy + human fix first.
 *   - blocked: has a blocking warning (no auto-conversion) — never auto-published.
 *
 * Pure — no I/O. Works off the per-query `transformKinds`/`warningKinds` that
 * BOTH scan pipelines record in `results.jsonl` (dashboards via scan-dashboards,
 * notebooks via the asset-scan core), so one code path normalizes both.
 */

import { BLOCKING_WARNING_KINDS } from './dql-rewriter.ts';

const BLOCKING = BLOCKING_WARNING_KINDS as ReadonlySet<string>;

export type Bucket = 'clean' | 'soft' | 'blocked' | 'noop';

/** A scanned query detail, as stored in either scanner's results.jsonl. */
export interface QueryDetailLike {
  transformKinds: string[];
  warningKinds: string[];
  /** Present in notebook/asset-scan output; ignored here (we re-derive). */
  bucket?: Bucket;
}

/**
 * Classify one query from its recorded transform/warning kinds — mirrors
 * `asset-scan.classifyRewrite`, but from strings so it works on persisted scan
 * output. `non-aws-entity` is informational and never counts.
 */
export function classifyBucket(transformKinds: string[], warningKinds: string[]): Bucket {
  const awsW = warningKinds.filter((k) => k !== 'non-aws-entity');
  if (awsW.some((k) => BLOCKING.has(k))) return 'blocked';
  if (awsW.length > 0) return 'soft';
  if (transformKinds.length > 0) return 'clean';
  return 'noop';
}

export interface ScanSignal {
  clean: number;
  soft: number;
  blocked: number;
  noop: number;
  queries: number;
}

/** Fold a scanned asset's query details into bucket counts. */
export function rollupBuckets(details: QueryDetailLike[]): ScanSignal {
  const s: ScanSignal = { clean: 0, soft: 0, blocked: 0, noop: 0, queries: details.length };
  for (const d of details) s[classifyBucket(d.transformKinds ?? [], d.warningKinds ?? [])]++;
  return s;
}

/** compare-dashboard parity tallies (`parityCounts` in the JSON artifact). */
export type ParityCounts = Partial<
  Record<'match' | 'mismatch' | 'one-side-empty' | 'both-empty' | 'both-error', number>
>;

export type ParityVerdict = 'all-match' | 'mismatch' | 'inconclusive' | 'none';

/**
 * Reduce parity tallies to a verdict. `all-match` requires ≥1 real match and
 * zero divergence/error/one-side-empty; `mismatch` if any divergence/error;
 * `inconclusive` when the only signal is both-empty (no data in window);
 * `none` when there's no parity data at all (compare wasn't run).
 */
export function parityVerdict(counts: ParityCounts | undefined): ParityVerdict {
  if (!counts) return 'none';
  const g = (k: keyof ParityCounts) => counts[k] ?? 0;
  const total = g('match') + g('mismatch') + g('one-side-empty') + g('both-empty') + g('both-error');
  if (total === 0) return 'none';
  if (g('mismatch') + g('one-side-empty') + g('both-error') > 0) return 'mismatch';
  if (g('match') > 0) return 'all-match';
  return 'inconclusive'; // only both-empty
}

export type Confidence = 'high' | 'medium' | 'low' | 'blocked';
export type Lane = 'fast' | 'review' | 'blocked';

export interface ConfidenceResult {
  level: Confidence;
  lane: Lane;
  reasons: string[];
}

/**
 * Combine the static scan signal with (optional) empirical parity into a
 * confidence + lane. Conservative by design: the fast lane requires BOTH a
 * fully clean rewrite AND parity all-match — anything less routes to review.
 */
export function assetConfidence(scan: ScanSignal, parity?: ParityCounts): ConfidenceResult {
  const reasons: string[] = [];
  const converted = scan.clean + scan.soft;

  // Excluded only when NOTHING auto-converted — a review copy would be identical
  // to the original, so it needs a manual rebuild, not the publish→review loop.
  if (scan.blocked > 0 && converted === 0) {
    reasons.push(`${scan.blocked} blocked, nothing auto-converted — manual rebuild`);
    return { level: 'blocked', lane: 'blocked', reasons };
  }

  const verdict = parityVerdict(parity);
  const allClean = scan.soft === 0 && scan.blocked === 0 && scan.clean > 0;

  // Fast lane: fully clean rewrite AND empirical parity all-match.
  if (allClean && verdict === 'all-match') {
    reasons.push('clean rewrite', 'parity all-match');
    return { level: 'high', lane: 'fast', reasons };
  }

  // Review lane: blocked tiles are what the human fixes in the copy.
  if (scan.blocked > 0)
    reasons.push(`${scan.blocked} blocked tile${scan.blocked === 1 ? ' needs' : 's need'} manual fixing`);
  if (scan.soft > 0) reasons.push(`${scan.soft} verify-me warning${scan.soft === 1 ? '' : 's'}`);
  if (verdict === 'mismatch') reasons.push('parity mismatch');
  else if (verdict === 'none') reasons.push('no parity data — run compare-dashboard');
  else if (verdict === 'inconclusive') reasons.push('parity inconclusive (no data in window)');
  else if (verdict === 'all-match') reasons.push('parity all-match');

  const level: Confidence = verdict === 'mismatch' || scan.blocked > 0 ? 'low' : 'medium';
  return { level, lane: 'review', reasons };
}
