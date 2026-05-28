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
  loadExtraMappings,
  lookupInExtra,
  serviceFromNewKey,
  type ExtraMappingsIndex,
} from './extra-mappings.ts';
import { builtinToDqlClassic } from './schema-transforms.ts';

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
}

export async function loadRecipeIndex(
  path: string,
  options: { dacPath?: string; manualPath?: string; perKeyPath?: string } = {}
): Promise<RecipeIndex> {
  const file = JSON.parse(await readFile(path, 'utf8')) as MergedMappingFile;
  const byClassicId = new Map<string, MappingEntry>();
  const byDqlClassicKey = new Map<string, MappingEntry>();
  for (const svc of file.serviceMappings ?? []) {
    for (const bm of svc.builtinMetricMappings ?? []) {
      const entry: MappingEntry = { ...bm, service: svc.service };
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
  return result;
}

export type LookupResult =
  | { kind: 'recipe'; entry: MappingEntry; recipe: DetectedRecipe }
  | { kind: 'composite'; entry: MappingEntry; formula: CompositeFormula }
  | { kind: 'mapped-no-recipe'; entry: MappingEntry }
  | { kind: 'unknown' };

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
export function lookupClassicKey(index: RecipeIndex, classicMetricId: string): LookupResult {
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
    const extra = lookupInExtra(index.extra, classicMetricId);
    if (extra) {
      const synthetic: MappingEntry = {
        service: serviceFromNewKey(extra.newKey),
        classicMetricId,
        newDtMetricKey: extra.newKey,
        notes:
          `Resolved via ${extra.source === 'manual' ? 'manual-metric-mappings' : 'per-key-mappings'} ` +
          `(${extra.availability}). ` +
          (extra.availability === 'autodiscovered'
            ? `New connection must be configured with "recommended + custom" and this metric added explicitly.`
            : 'In the recommended set — no extra configuration needed.'),
      };
      return { kind: 'mapped-no-recipe', entry: synthetic };
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
        newDtMetricKey: dac.newDtMetricKey,
        newDimensions: dac.cloudwatchDimensions,
        notes:
          `Resolved via DAC (${dac.availability}).${eolNote} ` +
          (dac.availability === 'autodiscovered'
            ? `New connection must be configured with "recommended + custom" and this metric added explicitly.`
            : 'In the recommended set — no extra configuration needed.'),
      };
      return { kind: 'mapped-no-recipe', entry: synthetic };
    }
  }
  return { kind: 'unknown' };
}
