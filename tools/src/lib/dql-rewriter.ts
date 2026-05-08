/**
 * DQL rewriter — applies metric-key + entity-dim transforms to a classic
 * Dynatrace DQL query.
 *
 * Composition (per INTEGRATION.md):
 *   - This module: metric-key swap + recipe application + entity-dim swap
 *     (this project's mapping × dt-migration skill's type table)
 *   - Things this module does NOT attempt: classicEntitySelector parsing,
 *     entity-relationship traversal (`belongs_to[...]`, `runs[...]`),
 *     classic ID rewriting. Those are flagged for manual migration with
 *     references to the relevant skill section.
 *
 * The implementation is pattern-based, not a full DQL parser. It handles
 * the common shapes that appear in dashboard/alert queries; for syntactic
 * edge cases the output flags a warning rather than producing wrong DQL.
 */

import { parseSelector } from './classic-selector-parser.ts';
import { translateSelector } from './classic-selector-translator.ts';
import { classicEntityToSmartscape, lookupByDimRef } from './entity-mappings.ts';
import {
  type DetectedRecipe,
  type LookupResult,
  type MappingEntry,
  type RecipeIndex,
  lookupClassicKey,
} from './recipe-lookup.ts';

export interface Transform {
  kind: 'metric-key' | 'entity-dim' | 'recipe-applied' | 'composite-formula' | 'classic-selector';
  before: string;
  after: string;
  detail?: string;
}

export interface Warning {
  kind:
    | 'unknown-metric'
    | 'mapped-no-recipe'
    | 'composite-formula-needed'
    | 'classic-entity-selector'
    | 'entity-relationship-traversal'
    | 'unmapped-entity-type'
    | 'entity-name-attr'
    | 'classic-id-literal'
    | 'recipe-aggregation-mismatch'
    | 'verdict-not-exact';
  text: string;
  /** Pointer to the relevant dt-migration reference (if any). */
  reference?: string;
  /** The matched substring. */
  match?: string;
}

export interface RewriteResult {
  original: string;
  rewritten: string;
  transforms: Transform[];
  warnings: Warning[];
}

const SKILL_REFS = {
  massData: 'dt-migration/references/mass-data-filtering-strategy.md',
  dqlFunctions: 'dt-migration/references/dql-function-migration.md',
  typeMappings: 'dt-migration/references/type-mappings.md',
  relationships: 'dt-migration/references/relationship-mappings.md',
  specialCases: 'dt-migration/references/special-cases.md',
};

/**
 * Build the classic-key regex. We match builtin keys both bare and
 * backtick-quoted, and only when they appear inside an aggregation call so
 * we don't false-match documentation strings.
 */
// Capture the entire `agg(metric)` or `agg(metric,` shape. The trailing char
// determines how we replace:
//   - `)` → metric is the only arg; we can wrap the whole call freely
//   - `,` → metric has extra args (e.g. filter); only swap the metric, keep
//           the original agg, and flag if the recipe disagrees
const CLASSIC_KEY_PATTERN =
  /\b(avg|sum|max|min|count|percentile|median)\(\s*`?(builtin:cloud\.aws\.[\w.:]+)`?\s*([,)])/g;

const ENTITY_DIM_PATTERN =
  /`?\bdt\.entity\.([\w:]+)`?/g;

const CLASSIC_ENTITY_SELECTOR_PATTERN = /\bclassicEntitySelector\s*\(/g;
const ENTITY_NAME_ATTR_PATTERN = /\b(entityName|entityAttr)\s*\(/g;
const RELATIONSHIP_BRACKET_PATTERN = /\b(belongs_to|runs|instance_of|clustered_by|contains)\s*\[/g;
const ENTITY_ID_LITERAL_PATTERN = /"(EC2_INSTANCE|HOST|SERVICE|PROCESS_GROUP|PROCESS|CONTAINER|AWS_LAMBDA_FUNCTION|DYNAMO_DB_TABLE|AWS_APPLICATION_LOAD_BALANCER|AWS_NETWORK_LOAD_BALANCER)-[A-F0-9]+"/g;

/**
 * Apply a recipe to an aggregation call. Returns the new aggregation call
 * (with the metric key swapped, possibly the agg fn changed, possibly
 * wrapped in a multiplier/divider).
 */
function applyRecipe(
  userAgg: string,
  newDtMetricKey: string,
  recipe: DetectedRecipe
): { call: string; warnings: Warning[]; transforms: Transform[] } {
  const warnings: Warning[] = [];
  const transforms: Transform[] = [];

  // If the user's aggregation differs from recipe.classicAggregation, warn —
  // we still respect user intent and DON'T silently swap to recipe's classic
  // agg. The recipe assumed the user would use classicAggregation.
  if (userAgg !== recipe.classicAggregation && (userAgg === 'avg' || userAgg === 'sum')) {
    warnings.push({
      kind: 'recipe-aggregation-mismatch',
      text:
        `User wrote ${userAgg}() but recipe is calibrated for classic ${recipe.classicAggregation}(). ` +
        `Output may be inaccurate; verify by running both classic and rewritten queries side by side.`,
      reference: SKILL_REFS.dqlFunctions,
    });
  }

  if (recipe.verdict !== 'exact-fit' && recipe.verdict !== 'good-fit') {
    warnings.push({
      kind: 'verdict-not-exact',
      text:
        `Recipe verdict is "${recipe.verdict}" (r=${recipe.pearsonR ?? '?'}, residualSmape=${recipe.residualSmape ?? '?'}). ` +
        `Treat the rewritten query as best-effort — values may differ moment-to-moment.`,
    });
  }

  let call = `${recipe.newAggregation}(\`${newDtMetricKey}\`)`;

  // per_second mode: divide by interval seconds (assume 5m bucket for now).
  // Downstream consumer can swap the divisor if they bucket differently.
  const PERIOD_SECONDS = 300;
  if (recipe.newAggregationMode === 'per_second') {
    call = `(${call} / ${PERIOD_SECONDS})`;
    transforms.push({
      kind: 'recipe-applied',
      before: '(no divisor)',
      after: `/ ${PERIOD_SECONDS}`,
      detail: 'recipe says per_second mode — added /interval',
    });
  }

  // Skip the scale wrapper when scale is essentially 1 (tolerance ~2%). Wraps
  // for scale=0.97 or 1.05 are meaningful; for 1.0006 the wrap is just noise.
  if (recipe.scale !== null && Math.abs(recipe.scale - 1) > 0.02) {
    call = `(${call} * ${recipe.scale})`;
    transforms.push({
      kind: 'recipe-applied',
      before: '(no scale)',
      after: `* ${recipe.scale}`,
      detail: `recipe scale factor (verdict=${recipe.verdict})`,
    });
  }

  return { call, warnings, transforms };
}

export function rewriteDql(input: string, index: RecipeIndex): RewriteResult {
  const transforms: Transform[] = [];
  const warnings: Warning[] = [];

  // Pass 1: replace metric keys inside aggregation calls + apply recipe.
  let rewritten = input.replace(
    CLASSIC_KEY_PATTERN,
    (full, userAgg: string, classicKey: string, trailing: string) => {
      const lookup: LookupResult = lookupClassicKey(index, classicKey);
      if (lookup.kind === 'unknown') {
        warnings.push({
          kind: 'unknown-metric',
          text: `Classic metric key not in mapping: ${classicKey}. Leaving unchanged.`,
          match: classicKey,
        });
        return full;
      }
      if (lookup.kind === 'composite') {
        const components = lookup.formula.components
          .map((c) => `${c.role}=\`${c.newDtMetricKey}\`(${c.newAggregation})`)
          .join(', ');
        warnings.push({
          kind: 'composite-formula-needed',
          text:
            `Classic metric ${classicKey} has no scalar recipe — it's computed from a formula:\n` +
            `    formula: ${lookup.formula.formula}\n` +
            `    components: ${components}\n` +
            (lookup.formula.verified === false
              ? '    NOTE: formula is UNVERIFIED — empirical test on a real tenant did not match. Hand-validate before using.\n'
              : '') +
            `Manual rewrite required.`,
          reference: 'mappings/manual_recipes.json',
          match: classicKey,
        });
        return full;
      }
      if (lookup.kind === 'mapped-no-recipe') {
        warnings.push({
          kind: 'mapped-no-recipe',
          text:
            `Classic metric ${classicKey} maps to ${lookup.entry.newDtMetricKey ?? '(no new key)'} ` +
            `but no recipe is available — couldn't determine the right aggregation/scale.`,
          match: classicKey,
        });
        return full;
      }
      // Recipe path
      const { entry, recipe } = lookup;
      const newKey = entry.newDtMetricKey!;

      // Trailing `,` means metric has extra args (filter:{...}). Wrapping
      // (per_second / scale) doesn't compose cleanly with that shape — fall
      // back to a metric-only swap and flag if the recipe wanted more.
      if (trailing === ',') {
        if (recipe.newAggregationMode === 'per_second' ||
            (recipe.scale !== null && Math.abs(recipe.scale - 1) > 0.02)) {
          warnings.push({
            kind: 'recipe-aggregation-mismatch',
            text:
              `Metric ${classicKey} has filter args inside the aggregation, but the recipe needs ` +
              `mode=${recipe.newAggregationMode} scale=${recipe.scale}. The output swaps only the ` +
              `metric key — apply the per_second division and/or scale factor manually.`,
          });
        }
        const swapOnly = `${recipe.newAggregation}(\`${newKey}\`,`;
        transforms.push({
          kind: 'metric-key',
          before: `${userAgg}(${classicKey},`,
          after: swapOnly,
          detail: `metric-only swap (filter args present); recipe ${recipe.classicAggregation}/${recipe.newAggregation}`,
        });
        return swapOnly;
      }

      // Normal path — simple aggregation, can wrap freely.
      const r = applyRecipe(userAgg, newKey, recipe);
      transforms.push({
        kind: 'metric-key',
        before: `${userAgg}(${classicKey})`,
        after: r.call,
        detail: `recipe ${recipe.classicAggregation}/${recipe.newAggregation}` +
          (recipe.newAggregationMode === 'per_second' ? '/sec' : '') +
          ` scale=${recipe.scale} verdict=${recipe.verdict}`,
      });
      transforms.push(...r.transforms);
      warnings.push(...r.warnings);
      return r.call;
    }
  );

  // Pass 1.5: rewrite `in(<classic_or_new_dim>, classicEntitySelector("..."))`
  // into a translated filter clause. Run before the dt.entity.* sweep so we
  // can use the original classic dim to determine which smartscape dim
  // applies. Both forms are matched: pre-pass-2 (with `dt.entity.X`) and the
  // already-renamed form (`dt.smartscape.X`).
  rewritten = rewriteClassicSelectorIns(rewritten, transforms, warnings);

  // Pass 2: replace dt.entity.<type> with dt.smartscape.<...>
  rewritten = rewritten.replace(ENTITY_DIM_PATTERN, (full, entityType: string) => {
    const mapping = lookupByDimRef(full);
    if (!mapping) {
      warnings.push({
        kind: 'unmapped-entity-type',
        text:
          `Classic entity type dt.entity.${entityType} has no known Smartscape mapping. ` +
          `Check ${SKILL_REFS.typeMappings} for the full table or report it to dt-migration.`,
        reference: SKILL_REFS.typeMappings,
        match: full,
      });
      return full;
    }
    if (mapping.status === 'not-planned') {
      warnings.push({
        kind: 'unmapped-entity-type',
        text:
          `dt.entity.${entityType} has no Smartscape replacement (${mapping.notes ?? 'not planned'}). ` +
          `See ${SKILL_REFS.specialCases}.`,
        reference: SKILL_REFS.specialCases,
        match: full,
      });
      return full;
    }
    transforms.push({
      kind: 'entity-dim',
      before: `dt.entity.${entityType}`,
      after: mapping.smartscapeDimension,
      detail: `→ Smartscape node ${mapping.smartscapeNodeType} (source: ${mapping.source})`,
    });
    // Use backticks if the original was backticked (preserve quoting style).
    return full.startsWith('`') ? '`' + mapping.smartscapeDimension + '`' : mapping.smartscapeDimension;
  });

  // Pass 3: detect constructs we don't auto-rewrite — flag them.
  const flagPatterns: Array<{
    re: RegExp;
    kind: Warning['kind'];
    text: string;
    reference?: string;
  }> = [
    {
      re: CLASSIC_ENTITY_SELECTOR_PATTERN,
      kind: 'classic-entity-selector',
      text:
        'classicEntitySelector(...) needs manual migration: resolve each predicate, run fieldsSnapshot, ' +
        'then choose Check 1 (direct dim filter), Check 2 (getNodeField), or Check 3 (smartscapeNodes subquery).',
      reference: SKILL_REFS.massData,
    },
    {
      re: ENTITY_NAME_ATTR_PATTERN,
      kind: 'entity-name-attr',
      text:
        'entityName(...) / entityAttr(...) need migration: prefer node `name` field directly, or `getNodeName()` / `getNodeField()` for ID-based access.',
      reference: SKILL_REFS.dqlFunctions,
    },
    {
      re: RELATIONSHIP_BRACKET_PATTERN,
      kind: 'entity-relationship-traversal',
      text:
        'Relationship-bracket access (belongs_to[...], runs[...], etc.) → use `traverse` or `references[...]` on Smartscape edges. ' +
        'Validate the edge exists in the relationship-mappings table.',
      reference: SKILL_REFS.relationships,
    },
    {
      re: ENTITY_ID_LITERAL_PATTERN,
      kind: 'classic-id-literal',
      text:
        'Hardcoded classic entity ID found. Classic IDs do not carry over to Smartscape — wrap with toSmartscapeId() or look up the matching Smartscape ID.',
      reference: SKILL_REFS.dqlFunctions,
    },
  ];

  for (const fp of flagPatterns) {
    fp.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = fp.re.exec(rewritten)) !== null) {
      warnings.push({ kind: fp.kind, text: fp.text, reference: fp.reference, match: m[0] });
    }
  }

  return { original: input, rewritten, transforms, warnings };
}

/**
 * Find each `in(<dim>, classicEntitySelector("..."))` and replace with the
 * translated filter clause. Handles both `dt.entity.<type>` and the
 * already-rewritten `dt.smartscape.<type>` forms.
 *
 * Implemented by manual paren-balancing rather than pure regex, because the
 * selector string can contain nested parens and quoted commas.
 */
function rewriteClassicSelectorIns(
  input: string,
  transforms: Transform[],
  warnings: Warning[]
): string {
  // Find all `in(` openings followed by a classic/smartscape dim ref, then
  // walk the parens to find the matching close.
  const result: string[] = [];
  let i = 0;
  while (i < input.length) {
    const remaining = input.slice(i);
    const m = /^in\(\s*(`?dt\.(?:entity|smartscape)\.[\w:]+`?)\s*,\s*classicEntitySelector\(\s*"((?:\\.|[^"\\])*)"\s*\)\s*\)/.exec(remaining);
    if (!m) {
      result.push(input[i]!);
      i++;
      continue;
    }
    const fullMatch = m[0];
    const dimRef = m[1]!;
    const selectorStr = m[2]!;

    // Determine the smartscape dim to use. If user wrote dt.entity.X, look
    // up the mapping; if they already wrote dt.smartscape.X, use as-is.
    const cleanDim = dimRef.replace(/^`|`$/g, '');
    let smartscapeDim = cleanDim;
    if (cleanDim.startsWith('dt.entity.')) {
      const mapping = classicEntityToSmartscape(cleanDim.slice('dt.entity.'.length));
      if (!mapping || !mapping.smartscapeDimension) {
        warnings.push({
          kind: 'unmapped-entity-type',
          text: `classicEntitySelector wraps an unmapped entity type ${cleanDim}; left unchanged.`,
          match: fullMatch,
        });
        result.push(fullMatch);
        i += fullMatch.length;
        continue;
      }
      smartscapeDim = mapping.smartscapeDimension;
    }

    // Parse + translate.
    const ast = parseSelector(unescapeDqlString(selectorStr));
    const translation = translateSelector(ast, smartscapeDim, { defaultTagContext: 'aws' });

    if (!translation.filter) {
      warnings.push({
        kind: 'classic-entity-selector',
        text:
          `classicEntitySelector("${selectorStr}") produced no auto-translatable predicates.\n` +
          translation.notes.map((n) => `  - ${n}`).join('\n'),
        reference: 'dt-migration/references/mass-data-filtering-strategy.md',
        match: fullMatch,
      });
      result.push(fullMatch);
      i += fullMatch.length;
      continue;
    }

    transforms.push({
      kind: 'classic-selector',
      before: fullMatch,
      after: translation.filter,
      detail: `predicates=${ast.length}; defaulted to Check 2 (getNodeField) — verify with fieldsSnapshot.`,
    });
    for (const note of translation.notes) {
      warnings.push({
        kind: 'classic-entity-selector',
        text: note,
        reference: 'dt-migration/references/mass-data-filtering-strategy.md',
      });
    }
    result.push(translation.filter);
    i += fullMatch.length;
  }
  return result.join('');
}

function unescapeDqlString(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}
