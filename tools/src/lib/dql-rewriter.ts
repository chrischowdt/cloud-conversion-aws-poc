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
import { findEdgesBetween } from './smartscape-edges.ts';
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
// Capture the entire `agg(metric)` or `agg(metric,` shape. Matches both
// classic metric-key forms a dashboard might reference:
//   - v2 API form:  builtin:cloud.aws.<svc>.<dotted camelCase>
//   - DQL form:     dt.cloud.aws.<svc>.<dotted snake_case>
// The trailing char determines how we replace:
//   - `)` → metric is the only arg; we can wrap the whole call freely
//   - `,` → metric has extra args (e.g. filter); only swap the metric, keep
//           the original agg, and flag if the recipe disagrees
const CLASSIC_KEY_PATTERN =
  /\b(avg|sum|max|min|count|percentile|median)\(\s*`?((?:builtin:cloud\.aws|dt\.cloud\.aws)\.[\w.:]+)`?\s*([,)])/g;

const ENTITY_DIM_PATTERN =
  /`?\bdt\.entity\.([\w:]+)`?/g;

const CLASSIC_ENTITY_SELECTOR_PATTERN = /\bclassicEntitySelector\s*\(/g;
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

  const call = `${recipe.newAggregation}(\`${newDtMetricKey}\`)`;

  // DQL rejects arithmetic inside the timeseries aggregation slot
  // ("The parameter has to be a metric-based timeseries aggregation").
  // We therefore emit the metric swap as a clean call and surface the
  // recipe's per_second / scale math as a warning describing the
  // pipeline step the consumer should append after the timeseries clause.
  const needsPerSecond = recipe.newAggregationMode === 'per_second';
  const needsScale = recipe.scale !== null && Math.abs(recipe.scale - 1) > 0.02;
  if (needsPerSecond || needsScale) {
    const example =
      needsPerSecond && needsScale
        ? `<var>[] / 300 * ${recipe.scale}`
        : needsPerSecond
        ? '<var>[] / 300'
        : `<var>[] * ${recipe.scale}`;
    const parts: string[] = [];
    if (needsPerSecond) parts.push('divide by bucket-interval seconds');
    if (needsScale) parts.push(`multiply by scale ${recipe.scale}`);
    warnings.push({
      kind: 'recipe-aggregation-mismatch',
      text:
        `Recipe needs post-aggregation math: ${parts.join(' AND ')}. DQL doesn't allow arithmetic in ` +
        `the timeseries aggregation slot, so append this as a pipeline step (replace <var> with the ` +
        `variable name from your timeseries clause; 300 = seconds for interval:5m — adjust if your ` +
        `bucket size differs):\n    | fieldsAdd <var> = ${example}`,
      reference: SKILL_REFS.dqlFunctions,
    });
    transforms.push({
      kind: 'recipe-applied',
      before: '(metric-only swap)',
      after: `| fieldsAdd <var> = ${example}`,
      detail: 'recipe math captured as post-processing step — DQL aggregation slot is metric-only',
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

  // Pass 1.6: `fetch dt.entity.X` → `smartscapeNodes <TYPE>`. Must come
  // before the relationship-bracket pass so we know the source type for
  // edge validation.
  const fetchContext: FetchContext = { sourceSmartscapeType: null, didRewriteFetch: false };
  rewritten = rewriteFetchEntity(rewritten, transforms, warnings, fetchContext);

  // Pass 1.7: rewrite classic relationship-bracket projections like
  // `belongs_to[dt.entity.host]` into `references[belongs_to.host]`. Use
  // fetchContext.sourceSmartscapeType (when known) to validate the edge
  // against smartscape-edges.ts and substitute the correct edge if the
  // classic name doesn't match the actual edge for the source-target pair.
  rewritten = rewriteRelationshipBrackets(rewritten, transforms, warnings, fetchContext);

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

  // Pass 2.5: entityName(x) → getNodeName(x); entityAttr(x, "f") → getNodeField(x, "f").
  // Runs AFTER the dt.entity.* dim swap so x is already in smartscape form.
  rewritten = rewriteEntityNameAttr(rewritten, transforms);

  // Pass 2.6: when we rewrote `fetch dt.entity.X` to `smartscapeNodes`,
  // any `entity.name` field reference inside should become bare `name`.
  if (fetchContext.didRewriteFetch) {
    rewritten = rewritten.replace(/\bentity\.name\b/g, () => {
      transforms.push({
        kind: 'entity-dim',
        before: 'entity.name',
        after: 'name',
        detail: 'smartscapeNodes uses bare `name` field instead of `entity.name`',
      });
      return 'name';
    });
  }

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

// ─── Pass 1.6: fetch dt.entity.X → smartscapeNodes <TYPE> ─────────────────

interface FetchContext {
  sourceSmartscapeType: string | null;
  didRewriteFetch: boolean;
}

const FETCH_ENTITY_PATTERN = /\bfetch\s+`?dt\.entity\.([\w:]+)`?/g;

function rewriteFetchEntity(
  input: string,
  transforms: Transform[],
  warnings: Warning[],
  ctx: FetchContext
): string {
  return input.replace(FETCH_ENTITY_PATTERN, (full, entityType: string) => {
    const mapping = classicEntityToSmartscape(entityType);
    if (!mapping || !mapping.smartscapeNodeType) {
      if (mapping?.status === 'not-planned') {
        warnings.push({
          kind: 'unmapped-entity-type',
          text:
            `fetch dt.entity.${entityType} — this entity has no Smartscape replacement ` +
            `(${mapping.notes ?? 'not planned'}). Manual rewrite required.`,
          reference: SKILL_REFS.specialCases,
          match: full,
        });
      } else {
        warnings.push({
          kind: 'unmapped-entity-type',
          text: `fetch dt.entity.${entityType} — no Smartscape mapping; cannot restructure automatically.`,
          reference: SKILL_REFS.typeMappings,
          match: full,
        });
      }
      return full;
    }
    ctx.sourceSmartscapeType = mapping.smartscapeNodeType;
    ctx.didRewriteFetch = true;
    transforms.push({
      kind: 'entity-dim',
      before: full,
      after: `smartscapeNodes ${mapping.smartscapeNodeType}`,
      detail: `Situation-3 restructure: pure entity list query`,
    });
    return `smartscapeNodes ${mapping.smartscapeNodeType}`;
  });
}

// ─── Pass 1.7: <edge>[dt.entity.X] → references[<edge>.<x>] ───────────────

/**
 * Classic relationship-bracket projection names that appear in `fetch
 * dt.entity.*` pipelines. Listed in the dql-function-migration.md "Classic
 * relationship fields" section.
 */
const RELATIONSHIP_BRACKET_KEYWORDS = [
  'belongs_to',
  'runs',
  'runs_on',
  'instance_of',
  'clustered_by',
  'contains',
  'monitors',
  'calls',
  'manages',
  'is_part_of',
  'is_attached_to',
  'balanced_by',
  'balances',
  'accessible_by',
  'uses',
  'sends_to',
  'receives_from',
  'propagates_to',
];

const RELATIONSHIP_BRACKET_PROJECTION_RE = new RegExp(
  `\\b(${RELATIONSHIP_BRACKET_KEYWORDS.join('|')})\\[\\s*\`?dt\\.entity\\.([\\w:]+)\`?\\s*\\]`,
  'g'
);

function rewriteRelationshipBrackets(
  input: string,
  transforms: Transform[],
  warnings: Warning[],
  ctx: FetchContext
): string {
  return input.replace(RELATIONSHIP_BRACKET_PROJECTION_RE, (full, classicEdge: string, targetClassicType: string) => {
    const targetMapping = classicEntityToSmartscape(targetClassicType);
    if (!targetMapping || !targetMapping.smartscapeNodeType) {
      warnings.push({
        kind: 'entity-relationship-traversal',
        text:
          `${classicEdge}[dt.entity.${targetClassicType}] target has no Smartscape mapping. ` +
          `Translate by hand.`,
        reference: SKILL_REFS.relationships,
        match: full,
      });
      return full;
    }
    const targetType = targetMapping.smartscapeNodeType;
    const targetDot = targetType.toLowerCase();

    // Validate against smartscape-edges when source is known. Substitute the
    // correct edge when the classic name doesn't match the actual edge for
    // the (source, target) pair.
    let chosenEdge = classicEdge;
    const validationNotes: string[] = [];
    if (ctx.sourceSmartscapeType) {
      const valid = findEdgesBetween(ctx.sourceSmartscapeType, targetType);
      if (valid.length === 0) {
        validationNotes.push(
          `No edge between (${ctx.sourceSmartscapeType}, ${targetType}) in smartscape-edges.ts; ` +
            `using literal "${classicEdge}" — verify by hand or expand the edge table.`
        );
      } else {
        const direct = valid.find((e) => e.edge === classicEdge);
        if (!direct && valid.length === 1) {
          chosenEdge = valid[0]!.edge;
          validationNotes.push(
            `Classic "${classicEdge}" doesn't match the (${ctx.sourceSmartscapeType}, ${targetType}) ` +
              `edge in smartscape-edges.ts — substituting "${chosenEdge}".`
          );
        } else if (!direct) {
          validationNotes.push(
            `Classic "${classicEdge}" doesn't match smartscape-edges.ts for (${ctx.sourceSmartscapeType}, ${targetType}); ` +
              `candidates: [${valid.map((e) => e.edge).join(', ')}] — pick by hand.`
          );
        }
      }
    } else {
      validationNotes.push(
        `Source type unknown (no preceding fetch dt.entity.*) — using literal "${classicEdge}". Verify edge by hand.`
      );
    }

    const replacement = `references[${chosenEdge}.${targetDot}]`;
    transforms.push({
      kind: 'entity-dim',
      before: full,
      after: replacement,
      detail:
        ctx.sourceSmartscapeType
          ? `relationship projection (source ${ctx.sourceSmartscapeType} → target ${targetType})`
          : `relationship projection (target ${targetType}; source unknown)`,
    });
    for (const note of validationNotes) {
      warnings.push({
        kind: 'entity-relationship-traversal',
        text: note,
        reference: SKILL_REFS.relationships,
      });
    }
    return replacement;
  });
}

// ─── Pass 2.5: entityName / entityAttr → getNodeName / getNodeField ───────

function rewriteEntityNameAttr(input: string, transforms: Transform[]): string {
  // entityAttr(x, "field") → getNodeField(x, "field"). Must run before
  // entityName replacement so we don't accidentally match Attr's "Name" prefix.
  let rewritten = input.replace(
    /\bentityAttr\(\s*([^,)]+?)\s*,\s*("[^"]+")\s*\)/g,
    (full, arg: string, field: string) => {
      transforms.push({
        kind: 'entity-dim',
        before: full,
        after: `getNodeField(${arg}, ${field})`,
        detail: 'entityAttr(x, "f") → getNodeField(x, "f")',
      });
      return `getNodeField(${arg}, ${field})`;
    }
  );

  // entityName(x) — drop optional `type:"..."` argument per skill rule.
  rewritten = rewritten.replace(
    /\bentityName\(\s*([^,)]+?)(?:\s*,\s*type:\s*"[^"]+")?\s*\)/g,
    (full, arg: string) => {
      transforms.push({
        kind: 'entity-dim',
        before: full,
        after: `getNodeName(${arg})`,
        detail: 'entityName(x) → getNodeName(x); type: argument dropped (skill rule)',
      });
      return `getNodeName(${arg})`;
    }
  );

  return rewritten;
}
