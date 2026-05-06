/**
 * merge-recipes — fold detected_recipes.json back into the source mapping
 * (`mappings/aws_mapping.json`) so the recipes are durable and downstream
 * tooling (App, query rewriter, dashboard converter) can pick them up.
 *
 * Default behavior is non-destructive: writes to
 *   `mappings/aws_mapping.with_recipes.json`
 * Pass --in-place to overwrite the source file.
 *
 * Also emits `mappings/no_fit_punchlist.json` — the pairs the recipe search
 * couldn't crack, with heuristic hints about likely root cause to guide the
 * manual research session.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { REPO_ROOT } from '../lib/paths.ts';

export interface MergeRecipesArgs {
  recipesPath?: string;
  mappingPath?: string;
  outPath?: string;
  punchlistPath?: string;
  /** Path to mappings/manual_recipes.json with composite formulas. */
  manualRecipesPath?: string;
  inPlace?: boolean;
}

interface DetectedRecipe {
  classicMetricId: string;
  newDtMetricKey: string;
  newAggregation: string;
  newAggregationMode?: 'raw' | 'per_second';
  classicAggregation: string;
  scale: number | null;
  verdict: string;
  pearsonR: number | null;
  residualSmape: number | null;
  /** detect-per-resource fields (optional). */
  perResourceQualifying?: number;
  perResourceTested?: number;
  source?: string;
  winningCluster?: string;
}

interface DetectedRecipesFile {
  generated: string;
  window: { from: string; to: string; interval: string };
  recipes: DetectedRecipe[];
}

interface DetectReportPair {
  classicBuiltin: string;
  classicDqlKey: string;
  newDqlKey: string;
  cloudwatchName: string | null;
  service: string;
  category: string;
  notes: string;
  verdict: string;
  best: {
    classicAgg: string;
    newAgg: string;
    pearsonR: number | null;
    scale: number | null;
    residualSmape: number | null;
  } | null;
}

interface DetectReportFile {
  generated: string;
  window: { from: string; to: string; interval: string };
  results: DetectReportPair[];
}

interface CompositeFormula {
  classicMetricId: string;
  classicDisplayName?: string;
  explanation?: string;
  formula: string;
  components: Array<{
    role: string;
    newDtMetricKey: string;
    newAggregation: string;
    newAggregationMode?: 'raw' | 'per_second';
    cloudwatchName?: string;
  }>;
  outputUnit?: string;
  source?: string;
}

interface ManualRecipesFile {
  compositeFormulas?: CompositeFormula[];
}

interface MappingFile {
  generated?: string;
  serviceMappings: Array<{
    service: string;
    builtinMetricMappings?: Array<{
      classicMetricId: string;
      classicDisplayName?: string;
      cloudwatchName?: string | null;
      newDtMetricKey?: string | null;
      newDimensions?: string[];
      category?: string;
      notes?: string;
      detectedRecipe?: {
        classicAggregation: string;
        newAggregation: string;
        newAggregationMode: 'raw' | 'per_second';
        scale: number | null;
        verdict: string;
        pearsonR: number | null;
        residualSmape: number | null;
        detectedAt: string;
        detectedFromWindow: string;
        source?: string;
        perResourceQualifying?: number;
        perResourceTested?: number;
        winningCluster?: string;
      };
      compositeFormula?: CompositeFormula;
      [k: string]: unknown;
    }>;
  }>;
  [k: string]: unknown;
}

/**
 * Heuristic root-cause hints for pairs the recipe search couldn't crack.
 * Picked from the metric ID and notes — fast to compute, not a substitute
 * for human review but enough to triage 30 pairs into clusters.
 */
function classifyNoFit(pair: DetectReportPair): {
  likelyCause: string;
  suggestedNextStep: string;
} {
  const id = pair.classicBuiltin.toLowerCase();
  const notes = (pair.notes ?? '').toLowerCase();

  if (notes.includes('rebuild') || notes.includes('formula') || /pct|percent|ratio/.test(id)) {
    return {
      likelyCause: 'composite-formula',
      suggestedNextStep:
        'Classic was likely computed from 2+ CW metrics (e.g. consumed/provisioned*100). Needs a formula recipe, not a single-key recipe.',
    };
  }
  if (/lat|latency|resp_?time|duration/.test(id)) {
    return {
      likelyCause: 'percentile-vs-mean',
      suggestedNextStep:
        'Classic latency is often pre-aggregated as p50/p90/p99. Try matching against `:max` or a percentile DQL function on new side.',
    };
  }
  if (/net|throughput|bytes|rate/.test(id)) {
    return {
      likelyCause: 'rate-vs-counter',
      suggestedNextStep:
        'Classic may report a per-second rate; new side reports cumulative bytes. Divide by interval (300s) on new side after summing.',
    };
  }
  if (pair.verdict === 'no-data') {
    return {
      likelyCause: 'no-data',
      suggestedNextStep: 'No data on either side in the window. Either service is idle, or the new key is wrong.',
    };
  }
  if (pair.best && (pair.best.pearsonR ?? 0) > 0.6 && (pair.best.residualSmape ?? 1) < 0.3) {
    return {
      likelyCause: 'borderline-pickable',
      suggestedNextStep:
        `Best combo (c:${pair.best.classicAgg}/n:${pair.best.newAgg}, r=${pair.best.pearsonR?.toFixed(3)}, residual=${pair.best.residualSmape?.toFixed(3)}) is close to threshold — try a different window or per-resource comparison.`,
    };
  }
  return {
    likelyCause: 'unknown-mismatch',
    suggestedNextStep:
      'Per-resource comparison: query both sides with `by: { <entity_dim> }` and compare per resource — aggregate views may be hiding alignment.',
  };
}

export async function runMergeRecipes(args: MergeRecipesArgs = {}): Promise<void> {
  const recipesPath = args.recipesPath ?? join(REPO_ROOT, 'tools', 'out', 'detected_recipes.json');
  const mappingPath = args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.json');
  const reportPath = join(REPO_ROOT, 'tools', 'out', 'detect_report.json');
  const outPath = args.inPlace
    ? mappingPath
    : args.outPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.with_recipes.json');
  const punchlistPath =
    args.punchlistPath ?? join(REPO_ROOT, 'mappings', 'no_fit_punchlist.json');

  const manualRecipesPath =
    args.manualRecipesPath ?? join(REPO_ROOT, 'mappings', 'manual_recipes.json');

  const recipes = JSON.parse(await readFile(recipesPath, 'utf8')) as DetectedRecipesFile;
  // Read from the previously-merged file if it exists (so this run accumulates
  // with prior recipes). Falls back to the source mapping on first run.
  const sourceForMerge = args.inPlace ? mappingPath : outPath;
  let mapping: MappingFile;
  try {
    mapping = JSON.parse(await readFile(sourceForMerge, 'utf8')) as MappingFile;
  } catch {
    mapping = JSON.parse(await readFile(mappingPath, 'utf8')) as MappingFile;
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as DetectReportFile;

  // Load manual composite formulas (file is optional).
  let manual: ManualRecipesFile = {};
  try {
    manual = JSON.parse(await readFile(manualRecipesPath, 'utf8')) as ManualRecipesFile;
  } catch {
    // No manual recipes file — that's fine.
  }
  const formulasByKey = new Map<string, CompositeFormula>();
  for (const f of manual.compositeFormulas ?? []) {
    formulasByKey.set(f.classicMetricId, f);
  }

  // Index recipes by classic key for fast lookup.
  const recipeByKey = new Map<string, DetectedRecipe>();
  for (const r of recipes.recipes) recipeByKey.set(r.classicMetricId, r);
  const window = `${recipes.window.from} → ${recipes.window.to}`;

  // Apply detected recipes + composite formulas to mapping rows.
  let appliedRecipeCount = 0;
  let appliedFormulaCount = 0;
  for (const svc of mapping.serviceMappings ?? []) {
    for (const bm of svc.builtinMetricMappings ?? []) {
      const recipe = recipeByKey.get(bm.classicMetricId);
      if (recipe) {
        bm.detectedRecipe = {
          classicAggregation: recipe.classicAggregation,
          newAggregation: recipe.newAggregation,
          newAggregationMode: recipe.newAggregationMode ?? 'raw',
          scale: recipe.scale,
          verdict: recipe.verdict,
          pearsonR: recipe.pearsonR,
          residualSmape: recipe.residualSmape,
          detectedAt: recipes.generated,
          detectedFromWindow: window,
          source: recipe.source,
          perResourceQualifying: recipe.perResourceQualifying,
          perResourceTested: recipe.perResourceTested,
          winningCluster: recipe.winningCluster,
        };
        appliedRecipeCount++;
      }
      const formula = formulasByKey.get(bm.classicMetricId);
      if (formula) {
        bm.compositeFormula = formula;
        appliedFormulaCount++;
      }
    }
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(mapping, null, 2));

  // Build punchlist from the detect report (everything that didn't get a recipe
  // and doesn't have a manual composite-formula entry).
  const noFitVerdicts = new Set(['no-fit', 'shape-only', 'no-data']);
  const punchlist = report.results
    .filter((r) => noFitVerdicts.has(r.verdict) && !formulasByKey.has(r.classicBuiltin))
    .map((r) => ({
      classicMetricId: r.classicBuiltin,
      classicDqlKey: r.classicDqlKey,
      newDtMetricKey: r.newDqlKey,
      service: r.service,
      cloudwatchName: r.cloudwatchName,
      category: r.category,
      notes: r.notes,
      detectVerdict: r.verdict,
      bestCombo: r.best,
      ...classifyNoFit(r),
    }));

  // Group by likelyCause for quick scanning.
  const byCause = punchlist.reduce<Record<string, typeof punchlist>>((m, p) => {
    (m[p.likelyCause] ??= []).push(p);
    return m;
  }, {});

  await writeFile(
    punchlistPath,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        sourceReport: reportPath,
        totalNoFit: punchlist.length,
        countsByLikelyCause: Object.fromEntries(
          Object.entries(byCause).map(([k, v]) => [k, v.length])
        ),
        punchlist,
      },
      null,
      2
    )
  );

  const totalRows = mapping.serviceMappings?.flatMap((s) => s.builtinMetricMappings ?? []).length ?? 0;
  console.log(
    `Applied ${appliedRecipeCount} detected recipes + ${appliedFormulaCount} composite formulas to ${totalRows} total mapping rows.`
  );
  console.log(`Wrote ${outPath}${args.inPlace ? ' (in place)' : ''}`);
  console.log(`Wrote ${punchlistPath} (${punchlist.length} no-fit entries)`);
  console.log('Punchlist counts by likely cause:');
  for (const [cause, items] of Object.entries(byCause).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${cause.padEnd(28)} ${items.length}`);
  }
}
