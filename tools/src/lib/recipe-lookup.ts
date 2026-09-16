/**
 * Recipe lookup over the merged mapping (`mappings/aws_mapping.with_recipes.json`).
 *
 * Provides a small, dependency-free API the rewriter (and other consumers)
 * can use to translate a classic builtin metric key into:
 *   - a new DQL metric key
 *   - the recipe (aggregations, scale, mode) to apply
 *   - a composite formula spec when no scalar recipe fits
 *   - a plain "not found" when the metric is unknown
 */

import { readFile } from 'node:fs/promises';

import { loadDacIndex, lookupInDac, type DacIndex } from './dac-lookup.ts';
import {
  classicSnakeCandidates,
  loadExtraMappings,
  lookupInExtraWithNormalization,
  serviceFromNewKey,
  type ExtraMappingsIndex,
} from './extra-mappings.ts';
import {
  DEFAULT_MIN_OVERRIDE_SERIES,
  loadLiveMetrics,
  matchLiveMetricByName,
  preferPopulatedVariant,
  type LiveMetricsIndex,
} from './live-metrics.ts';
import { builtinToDqlClassic } from './schema-transforms.ts';
import { correctServiceNamespace } from './service-namespace-corrections.ts';
import { buildMzIndex, type MzTagIndex } from './mz-tags.ts';
import { loadEnrichedTags, type EnrichedTagIndex } from './enriched-tags.ts';
import { loadEntityCandidates } from './entity-candidates.ts';
import { buildPullIndex, type PullIndex } from './metric-streams.ts';
import { registerDiscoveredMappings } from './entity-mappings.ts';

export type Aggregation = 'avg' | 'sum' | 'max' | 'min' | 'count';
export type NewAggMode = 'raw' | 'per_second';
export type Verdict = 'exact-fit' | 'good-fit' | 'scale-only' | 'shape-only' | 'no-fit' | 'no-data';

export interface DetectedRecipe {
  classicAggregation: Aggregation;
  newAggregation: Aggregation;
  newAggregationMode: NewAggMode;
  scale: number | null;
  verdict: Verdict;
  pearsonR: number | null;
  residualSmape: number | null;
  source?: string;
  perResourceQualifying?: number;
  perResourceTested?: number;
}

export interface CompositeFormula {
  classicMetricId: string;
  formula: string;
  components: Array<{
    role: string;
    newDtMetricKey: string;
    newAggregation: string;
    newAggregationMode?: NewAggMode;
    cloudwatchName?: string;
  }>;
  verified?: boolean;
  verificationNotes?: string;
  outputUnit?: string;
  source?: string;
}

export interface MappingEntry {
  service: string;
  classicMetricId: string;
  classicDisplayName?: string;
  cloudwatchName?: string | null;
  newDtMetricKey?: string | null;
  newDimensions?: string[];
  category?: string;
  notes?: string;
  detectedRecipe?: DetectedRecipe;
  compositeFormula?: CompositeFormula;
}

interface MergedMappingFile {
  serviceMappings: Array<{
    service: string;
    builtinMetricMappings?: Array<Omit<MappingEntry, 'service'>>;
  }>;
}

export interface RecipeIndex {
  /** Keyed by the v2-API form: `builtin:cloud.aws.X.camelCase`. */
  byClassicId: Map<string, MappingEntry>;
  /**
   * Keyed by the DQL form: `dt.cloud.aws.X.snake_case`. Same entries as
   * byClassicId, just under a different key. Real dashboards reference
   * metrics in the DQL form, so the rewriter needs to look them up by it.
   */
  byDqlClassicKey: Map<string, MappingEntry>;
  /**
   * Supplemental mappings from the dt-migration skill: a ~117-entry
   * hand-curated abbreviation map (`manual-metric-mappings.json`) and a
   * ~5,709-entry pre-resolved per-key map (`per-key-mappings.json`). Loaded
   * as the second-tier fallback after the recipe table — covers abbreviated
   * shapes like `cloud.aws.alb.bytes` and lowercased ext: keys the DAC
   * normalization chain can't reconstruct.
   */
  extra?: ExtraMappingsIndex;
  /**
   * Authoritative DAC mapping (~4,168 entries) from the dt-migration skill,
   * loaded as a third-tier fallback for keys neither our recipe table nor
   * the extra mappings cover. Optional — older callers can omit it and the
   * rewriter still works.
   */
  dac?: DacIndex;
  /**
   * Per-tenant inventory of live new-connection metric keys + series counts
   * (`live-metrics.json`, from `discover-metrics`). When present, the lookup
   * repairs the empty-dim-variant case: if a DAC/extra-resolved key has no
   * series on this tenant but a sibling variant (same metric, different
   * `.By.<Dim>`) does, it prefers the populated sibling.
   *
   * SCOPE: applied ONLY to the unverified mapped-no-recipe tier — verified
   * recipe-tier keys carry agg/scale calibrated for a specific dim and are
   * never second-guessed. CAVEAT: the inventory reflects only metrics
   * currently flowing on this tenant, so an absent key may be valid-but-not-
   * collected, not wrong; every override is surfaced as a warning to verify.
   */
  liveMetrics?: LiveMetricsIndex;
  /**
   * Polled equivalents for AWS Metric Streams keys, built from the same live
   * inventory. Present only when that tenant has been inventoried — a metric
   * that is not flowing is not a safe conversion target.
   */
  streamsPull?: PullIndex;
  /**
   * Minimum target-series count required before a dim-override fires (see
   * `DEFAULT_MIN_OVERRIDE_SERIES`). Guards against swapping to a barely-
   * populated variant when the inventory is incomplete.
   */
  minOverrideSeries?: number;
  /**
   * Management zone → the AWS tag predicates that define it
   * (`discover-management-zones`). Lets the selector translator rewrite
   * `mzName(...)` as a native enriched-tag dimension filter instead of dropping
   * the predicate and blocking the panel.
   */
  mzTags?: MzTagIndex;
  /**
   * Tag keys the connection enriches onto METRIC series (`discover-tags`). Lets
   * the rewriter read a tag as the native `aws.tags.<key>` dimension instead of
   * a case-sensitive entity lookup that silently returns null.
   */
  enrichedTags?: EnrichedTagIndex;
}

export async function loadRecipeIndex(
  path: string,
  options: {
    dacPath?: string;
    manualPath?: string;
    perKeyPath?: string;
    liveMetricsPath?: string;
    minOverrideSeries?: number;
    mzTagsPath?: string;
    enrichedTagsPath?: string;
    /**
     * Verified classic->Smartscape entity mappings from
     * `discover-entity-candidates`. Registered into the entity table rather
     * than stored on the index: the entity passes look the table up directly.
     */
    entityCandidatesPath?: string;
  } = {}
): Promise<RecipeIndex> {
  const file = JSON.parse(await readFile(path, 'utf8')) as MergedMappingFile;
  const byClassicId = new Map<string, MappingEntry>();
  const byDqlClassicKey = new Map<string, MappingEntry>();
  for (const svc of file.serviceMappings ?? []) {
    for (const bm of svc.builtinMetricMappings ?? []) {
      const entry: MappingEntry = { ...bm, service: svc.service };
      // Correct DAC "recommended" service namespaces the new pipeline never emits
      // (e.g. emr_ec2 → elasticmapreduce). Tenant-proven; see the corrections module.
      if (entry.newDtMetricKey) entry.newDtMetricKey = correctServiceNamespace(entry.newDtMetricKey);
      byClassicId.set(bm.classicMetricId, entry);
      const dqlKey = builtinToDqlClassic(bm.classicMetricId);
      if (dqlKey) byDqlClassicKey.set(dqlKey, entry);
    }
  }
  const result: RecipeIndex = { byClassicId, byDqlClassicKey };
  if (options.manualPath || options.perKeyPath) {
    result.extra = await loadExtraMappings({
      manualPath: options.manualPath,
      perKeyPath: options.perKeyPath,
    });
  }
  if (options.dacPath) {
    result.dac = await loadDacIndex(options.dacPath);
  }
  if (options.liveMetricsPath) {
    result.liveMetrics = await loadLiveMetrics(options.liveMetricsPath);
    result.streamsPull = buildPullIndex(
      [...result.liveMetrics.byKey].map(([key, series]) => ({ key, series }))
    );
    result.minOverrideSeries = options.minOverrideSeries ?? DEFAULT_MIN_OVERRIDE_SERIES;
  }
  if (options.mzTagsPath) {
    try {
      result.mzTags = buildMzIndex(JSON.parse(await readFile(options.mzTagsPath, 'utf8')));
    } catch {
      // Absent or malformed → mzName() simply stays untranslated, which is the
      // safe default (the panel keeps blocking rather than changing scope).
    }
  }
  if (options.enrichedTagsPath) {
    try {
      result.enrichedTags = await loadEnrichedTags(options.enrichedTagsPath);
    } catch {
      // Absent/malformed → we keep the entity lookup, which is the status quo.
    }
  }
  if (options.entityCandidatesPath) {
    try {
      registerDiscoveredMappings(await loadEntityCandidates(options.entityCandidatesPath));
    } catch {
      // Absent/malformed → the curated table stands on its own, as before.
    }
  }
  return result;
}

/**
 * Set when the live-metric inventory repaired an empty dim variant: the DAC/
 * extra key (`from`) had no series on this tenant, so the lookup swapped to a
 * populated sibling (`to`, `count` series). Surfaced as a warning so the user
 * can confirm the grain — the inventory only sees currently-collected metrics.
 */
export interface DimOverride {
  from: string;
  to: string;
  count: number;
}

export type LookupResult =
  | { kind: 'recipe'; entry: MappingEntry; recipe: DetectedRecipe }
  | { kind: 'composite'; entry: MappingEntry; formula: CompositeFormula }
  | { kind: 'mapped-no-recipe'; entry: MappingEntry; dimOverride?: DimOverride }
  | { kind: 'unknown' };

/**
 * If the tenant's live-metric inventory is loaded and `synthetic.newDtMetricKey`
 * has no series there, swap to the most-populated sibling variant (same metric,
 * different `.By.<Dim>`). Mutates `synthetic` in place and returns the override
 * record, or null when nothing changed. Conservative: only fires on positive
 * evidence (a populated sibling), never drops or guesses.
 */
function applyDimOverride(index: RecipeIndex, synthetic: MappingEntry): DimOverride | undefined {
  if (!index.liveMetrics || !synthetic.newDtMetricKey) return undefined;
  const pref = preferPopulatedVariant(
    index.liveMetrics,
    synthetic.newDtMetricKey,
    index.minOverrideSeries ?? DEFAULT_MIN_OVERRIDE_SERIES
  );
  if (!pref.overrode) return undefined;
  const override: DimOverride = { from: pref.from!, to: pref.key, count: pref.count };
  synthetic.newDtMetricKey = pref.key;
  synthetic.notes =
    (synthetic.notes ? synthetic.notes + ' ' : '') +
    `DIM-VARIANT OVERRIDE: the mapped key ${override.from} has no live series on this tenant; ` +
    `using the populated sibling ${override.to} (${override.count} series). ` +
    `NOTE: the inventory only sees currently-collected metrics, so ${override.from} may be valid ` +
    `but not collected here — verify the dimension grain matches intent.`;
  return override;
}

/**
 * Look up a classic metric reference by EITHER form:
 *   - v2-API:  builtin:cloud.aws.X.camelCase
 *   - DQL:     dt.cloud.aws.X.snake_case
 *
 * Three-tier lookup chain:
 *   1. Recipe table — our enriched mapping with verified aggregations.
 *   2. Extra mappings — manual abbreviations (`cloud.aws.alb.bytes` etc.) +
 *      the skill's pre-resolved per-key index (catches lowercased ext: keys
 *      and Cassandra-shape keys our DAC normalization chain misses).
 *   3. DAC mapping (4,168 entries) — last resort, broadest coverage.
 *
 * Tiers 2 and 3 return synthetic `mapped-no-recipe` entries (no aggregation/
 * scale recipe, user's original aggregation preserved, warning surfaced).
 */
export function lookupClassicKey(
  index: RecipeIndex,
  classicMetricId: string,
  tryNormalization = true
): LookupResult {
  let entry = index.byClassicId.get(classicMetricId);
  if (!entry) entry = index.byDqlClassicKey.get(classicMetricId);
  if (entry) {
    if (entry.compositeFormula) return { kind: 'composite', entry, formula: entry.compositeFormula };
    if (entry.detectedRecipe && entry.newDtMetricKey) {
      return { kind: 'recipe', entry, recipe: entry.detectedRecipe };
    }
    return { kind: 'mapped-no-recipe', entry };
  }

  // Tier 2 — extra mappings (manual + per-key).
  if (index.extra) {
    const extra = lookupInExtraWithNormalization(index.extra, classicMetricId);
    if (extra) {
      const newKey = correctServiceNamespace(extra.newKey);
      const synthetic: MappingEntry = {
        service: serviceFromNewKey(newKey),
        classicMetricId,
        newDtMetricKey: newKey,
        notes:
          `Resolved via ${extra.source === 'manual' ? 'manual-metric-mappings' : 'per-key-mappings'} ` +
          `(${extra.availability}). ` +
          (extra.availability === 'autodiscovered'
            ? `New connection must be configured with "recommended + custom" and this metric added explicitly.`
            : 'In the recommended set — no extra configuration needed.'),
      };
      const dimOverride = applyDimOverride(index, synthetic);
      return { kind: 'mapped-no-recipe', entry: synthetic, dimOverride };
    }
  }

  // Tier 3 — DAC fallback.
  if (index.dac) {
    const dac = lookupInDac(index.dac, classicMetricId);
    if (dac) {
      const eolNote = dac.endOfLife
        ? ' END-OF-LIFE service per DAC.'
        : '';
      const synthetic: MappingEntry = {
        service: dac.cloudwatchNamespace.replace(/^AWS\//, ''),
        classicMetricId,
        cloudwatchName: dac.cloudwatchMetricName,
        newDtMetricKey: correctServiceNamespace(dac.newDtMetricKey),
        newDimensions: dac.cloudwatchDimensions,
        notes:
          `Resolved via DAC (${dac.availability}).${eolNote} ` +
          (dac.availability === 'autodiscovered'
            ? `New connection must be configured with "recommended + custom" and this metric added explicitly.`
            : 'In the recommended set — no extra configuration needed.'),
      };
      const dimOverride = applyDimOverride(index, synthetic);
      return { kind: 'mapped-no-recipe', entry: synthetic, dimOverride };
    }
  }

  // Tier 4 — snake-shape normalization retry. Classic DQL snake keys
  // (`cloud.aws.<svc>.<metric>_<stat>_by_<dims>`) are stored in the maps under a
  // CloudWatch-derived bare-snake (DAC) or per-key flattened `ext:` shape. Strip
  // the statistic infix + `_by_<dims>` and flatten, then retry the tiers above.
  // `tryNormalization` guards the recursion to one level.
  if (tryNormalization) {
    for (const cand of classicSnakeCandidates(classicMetricId)) {
      const r = lookupClassicKey(index, cand, false);
      if (r.kind === 'mapped-no-recipe') {
        // Synthetic entries are freshly built, so annotating is safe.
        r.entry.notes =
          (r.entry.notes ? r.entry.notes + ' ' : '') +
          `(matched after normalizing "${classicMetricId}" → "${cand}"; verify it's the same metric.)`;
        return r;
      }
      if (r.kind !== 'unknown') return r;
    }
  }
  // Tier 5 - match against what is ACTUALLY FLOWING on this tenant.
  //
  // The mapping tables are the same data the product team ships, and they still
  // miss bread-and-butter keys: `cloud.aws.rds.database_connections` resolves in
  // no tier, while `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier`
  // is live on both tenants. The gap is spelling, not coverage - classic writes
  // snake_case with the statistic and dimensions baked into the name; the polled
  // metric writes PascalCase with the dimensions in a `.By.` segment.
  //
  // Measured: resolves 16 of 66 otherwise-unresolvable keys on nic55601 and 10
  // of 76 on sfz80352, including apigateway.latency,
  // lambda.concurrent_executions_max, applicationelb.http_code_target_5xx_count_sum.
  //
  // DELIBERATELY LAST, and evidence-based: it only proposes a key already
  // producing data on the tenant being migrated, within the same service
  // namespace, so it cannot invent a mapping the way a looser string match
  // could. It is still a NAME match, so the note says so for the reviewer.
  if (index.liveMetrics) {
    const hit = matchLiveMetricByName(index.liveMetrics, classicMetricId);
    if (hit) {
      const synthetic: MappingEntry = {
        service: serviceFromNewKey(hit),
        classicMetricId,
        newDtMetricKey: hit,
        notes:
          `Resolved by matching the metric NAME against this tenant's live inventory ` +
          `(no mapping table had it). The target is confirmed to be flowing here. ` +
          `Verify it is the same measurement before relying on it.`,
      };
      return { kind: 'mapped-no-recipe', entry: synthetic };
    }
  }

  return { kind: 'unknown' };
}
