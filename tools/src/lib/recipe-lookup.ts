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
  byClassicId: Map<string, MappingEntry>;
}

export async function loadRecipeIndex(path: string): Promise<RecipeIndex> {
  const file = JSON.parse(await readFile(path, 'utf8')) as MergedMappingFile;
  const byClassicId = new Map<string, MappingEntry>();
  for (const svc of file.serviceMappings ?? []) {
    for (const bm of svc.builtinMetricMappings ?? []) {
      byClassicId.set(bm.classicMetricId, { ...bm, service: svc.service });
    }
  }
  return { byClassicId };
}

export type LookupResult =
  | { kind: 'recipe'; entry: MappingEntry; recipe: DetectedRecipe }
  | { kind: 'composite'; entry: MappingEntry; formula: CompositeFormula }
  | { kind: 'mapped-no-recipe'; entry: MappingEntry }
  | { kind: 'unknown' };

export function lookupClassicKey(index: RecipeIndex, classicMetricId: string): LookupResult {
  const entry = index.byClassicId.get(classicMetricId);
  if (!entry) return { kind: 'unknown' };
  if (entry.compositeFormula) return { kind: 'composite', entry, formula: entry.compositeFormula };
  if (entry.detectedRecipe && entry.newDtMetricKey) {
    return { kind: 'recipe', entry, recipe: entry.detectedRecipe };
  }
  return { kind: 'mapped-no-recipe', entry };
}
