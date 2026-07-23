/**
 * asset-scan — shared core for running the DQL rewriter across any asset type
 * (dashboards, notebooks, Davis anomaly detectors) and folding the results into
 * one coverage report shape.
 *
 * The bucketing mirrors scan-dashboards exactly so reports are comparable:
 *   - clean   : ≥1 transform, 0 AWS warnings          (converted, no caveats)
 *   - soft    : ≥1 non-blocking AWS warning           (working DQL + verify-me)
 *   - blocked : ≥1 blocking AWS warning               (no new equivalent / manual)
 *   - noop    : no transform, no AWS warning          (already new-form / non-AWS)
 * "converted" = clean + soft. The `non-aws-entity` note is informational (the
 * entity migrates with the general tooling, not decommissioned here) and never
 * counts toward clean/soft/blocked/flagged — a query whose only warning is that
 * note, with no transform, is a no-op for this automation.
 */

import { rewriteDql, isBlockingWarning, type RewriteResult } from './dql-rewriter.ts';
import type { RecipeIndex } from './recipe-lookup.ts';

/**
 * AWS markers for the pre-filter. Broader than the dashboard set: notebooks and
 * anomaly-detector DQL reference metrics in the BARE `cloud.aws.<svc>.<snake>`
 * form (e.g. `cloud.aws.kafka.offline_partitions_count`), which also subsumes
 * the `dt.cloud.aws.` / `builtin:cloud.aws.` prefixed forms.
 */
export const AWS_MARKERS = ['cloud.aws.', 'dt.entity.aws_', 'cloud:aws:'] as const;

export function hasAwsMarker(s: string): boolean {
  for (const m of AWS_MARKERS) if (s.includes(m)) return true;
  return false;
}

/**
 * Crude guard: does this string look like a DQL query (vs free text)? Keeps
 * `value`/`input` fields holding prose out of the scan. Matches the guard used
 * by scan-dashboards' collectQueries.
 */
export function looksLikeDql(s: string): boolean {
  return /\b(fetch|timeseries|data record|metric\.series|fields|filter|summarize|describe|getNodeName|makeTimeseries|parse)\b/.test(
    s
  );
}

/** A DQL string pulled out of an asset, with a human-pointable location. */
export interface ExtractedQuery {
  location: string;
  field: string;
  query: string;
}

export type Bucket = 'clean' | 'soft' | 'blocked' | 'noop';

/** Classify one rewrite result into exactly one bucket. */
export function classifyRewrite(r: RewriteResult): {
  bucket: Bucket;
  changed: boolean;
  flagged: boolean;
} {
  const changed = r.transforms.length > 0;
  const awsW = r.warnings.filter((w) => w.kind !== 'non-aws-entity');
  const hasBlocking = awsW.some((w) => isBlockingWarning(w.kind));
  const flagged = awsW.length > 0;
  let bucket: Bucket;
  if (hasBlocking) bucket = 'blocked';
  else if (flagged) bucket = 'soft';
  else if (changed) bucket = 'clean';
  else bucket = 'noop';
  return { bucket, changed, flagged };
}

export interface QueryDetail {
  location: string;
  field: string;
  original: string;
  rewritten: string;
  bucket: Bucket;
  transformKinds: string[];
  warningKinds: string[];
}

export interface PerAssetResult {
  id: string;
  name: string;
  file: string;
  queryCount: number;
  clean: number;
  soft: number;
  blocked: number;
  noop: number;
  details: QueryDetail[];
}

export interface ScanSummary {
  generated: string;
  assetType: string;
  totals: {
    files: number;
    parseErrors: number;
    awsAssets: number;
    nonAwsAssets: number;
    queries: number;
    clean: number;
    soft: number;
    blocked: number;
    noop: number;
    /** Queries the rewriter threw on (isolated, not fatal). */
    rewriteErrors: number;
  };
  /** clean + soft. */
  converted: number;
  transformKindCounts: Record<string, number>;
  warningKindCounts: Record<string, number>;
  warningExamples: Array<{ kind: string; text: string; file: string; location: string }>;
  rewriteErrorExamples: Array<{ file: string; location: string; error: string; querySnippet: string }>;
}

function bump(m: Record<string, number>, k: string): void {
  m[k] = (m[k] ?? 0) + 1;
}

/**
 * Accumulates per-asset scan results into one summary. Create one per scan run,
 * `add()` each AWS asset's extracted queries, then read `summary` / `perAsset`.
 */
export class ScanAccumulator {
  readonly summary: ScanSummary;
  readonly perAsset: PerAssetResult[] = [];
  private readonly seenExampleKinds = new Set<string>();

  constructor(assetType: string) {
    this.summary = {
      generated: new Date().toISOString(),
      assetType,
      totals: {
        files: 0,
        parseErrors: 0,
        awsAssets: 0,
        nonAwsAssets: 0,
        queries: 0,
        clean: 0,
        soft: 0,
        blocked: 0,
        noop: 0,
        rewriteErrors: 0,
      },
      converted: 0,
      transformKindCounts: {},
      warningKindCounts: {},
      warningExamples: [],
      rewriteErrorExamples: [],
    };
  }

  /** Fold one asset's queries into the report. Returns the per-asset result. */
  add(
    meta: { id: string; name: string; file: string },
    queries: ExtractedQuery[],
    index: RecipeIndex
  ): PerAssetResult {
    const t = this.summary.totals;
    t.awsAssets++;
    const per: PerAssetResult = {
      id: meta.id,
      name: meta.name,
      file: meta.file,
      queryCount: queries.length,
      clean: 0,
      soft: 0,
      blocked: 0,
      noop: 0,
      details: [],
    };
    for (const q of queries) {
      t.queries++;
      let r;
      try {
        r = rewriteDql(q.query, index);
      } catch (e) {
        // One pathological query must not abort a batch of thousands. Record it
        // and move on; the query counts as "not converted" (no bucket bump).
        t.rewriteErrors++;
        if (this.summary.rewriteErrorExamples.length < 20) {
          this.summary.rewriteErrorExamples.push({
            file: meta.file,
            location: q.location,
            error: (e as Error)?.message ?? String(e),
            querySnippet: q.query.slice(0, 200),
          });
        }
        continue;
      }
      const { bucket } = classifyRewrite(r);
      per[bucket]++;
      t[bucket]++;
      if (bucket === 'clean' || bucket === 'soft') this.summary.converted++;

      const tKinds = new Set<string>();
      for (const tr of r.transforms) {
        bump(this.summary.transformKindCounts, tr.kind);
        tKinds.add(tr.kind);
      }
      const wKinds = new Set<string>();
      for (const w of r.warnings) {
        bump(this.summary.warningKindCounts, w.kind);
        wKinds.add(w.kind);
        if (!this.seenExampleKinds.has(w.kind)) {
          this.seenExampleKinds.add(w.kind);
          this.summary.warningExamples.push({
            kind: w.kind,
            text: w.text.slice(0, 220),
            file: meta.file,
            location: q.location,
          });
        }
      }
      per.details.push({
        location: q.location,
        field: q.field,
        original: r.original,
        rewritten: r.rewritten,
        bucket,
        transformKinds: [...tKinds],
        warningKinds: [...wKinds],
      });
    }
    this.perAsset.push(per);
    return per;
  }

  markParseError(): void {
    this.summary.totals.parseErrors++;
  }
  markNonAws(): void {
    this.summary.totals.nonAwsAssets++;
  }
  markFile(): void {
    this.summary.totals.files++;
  }
}
