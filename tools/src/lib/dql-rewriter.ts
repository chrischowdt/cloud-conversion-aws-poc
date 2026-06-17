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

import {
  MULTI_NODE_SERVICES,
  isMultiNodeService,
  nodeTypeForCustomDeviceType,
  nodeTypeForMetricService,
  smartscapeDimForNodeType,
} from './aws-service-node-types.ts';
import { parseSelector } from './classic-selector-parser.ts';
import { translateSelector } from './classic-selector-translator.ts';
import { lookupInDac } from './dac-lookup.ts';
import { ENTITY_FIELD_MAPPINGS_BY_NODE_TYPE } from './entity-field-mappings.ts';
import { classicEntityToSmartscape, lookupByDimRef } from './entity-mappings.ts';
import { lookupEolForClassicKey } from './eol-lookup.ts';
import { isMetricCarrier, isKnownNonCarrier } from './metric-dim-carriers.ts';
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
    | 'verdict-not-exact'
    | 'dim-variant-override'
    | 'custom-device-disambiguated'
    | 'credential-collapsed'
    | 'metric-streams-blocked'
    | 'end-of-life-service';
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
// Capture the entire `agg(metric)` or `agg(metric,` shape. Matches every
// classic AWS metric-key prefix surfaced by the dt-migration skill's
// [classic-detection-patterns.md §1]:
//   - `dt.cloud.aws.*`       — classic built-in (Grail)
//   - `builtin:cloud.aws.*`  — classic built-in (Cassandra-era selector)
//   - `ext:cloud.aws.*`      — classic non-built-in (Cassandra-era selector)
//   - bare `cloud.aws.<service>.<snake_case_metric>` — classic non-built-in
//     (Grail). REQUIRES disambiguation: the new connection emits keys in the
//     shape `cloud.aws.<Service>.<PascalCase>.By.<Dim>`; we reject those
//     inside the replace handler by spotting `.By.<UpperFirst>`.
//
// The trailing char determines how we replace:
//   - `)` → metric is the only arg; we can wrap the whole call freely
//   - `,` → metric has extra args (e.g. filter); only swap the metric, keep
//           the original agg, and flag if the recipe disagrees
//
// Negative lookbehind `(?<!`)` keeps us from matching inside backtick-quoted
// column refs like `\`avg(dt.cloud.aws.rds.cpu.usage)\``. Rewriting metric
// keys inside those produces nested backticks and a parse error. The orphan
// pattern below catches and warns about those separately.
const CLASSIC_KEY_PATTERN =
  /(?<!`)\b(avg|sum|max|min|count|percentile|median)\(\s*`?((?:builtin:cloud\.aws|dt\.cloud\.aws|ext:cloud\.aws)\.[\w.:]+|cloud\.aws\.[a-z0-9_]+\.[a-z][\w]*)`?\s*([,)])/g;

/**
 * True when a metric key matches the new-connection shape
 * `cloud.<provider>.<Service>.<PascalCase>.By.<Dim>`. Used to reject
 * accidental matches when `CLASSIC_KEY_PATTERN`'s bare `cloud.aws.*`
 * branch picks up a new-form key the skill calls "new connection".
 */
function isNewConnectionShape(key: string): boolean {
  return /\.By\.[A-Z][a-zA-Z0-9]*/.test(key);
}

/**
 * AWS Metric Streams key shape: `cloud.aws.<service>.<camelCaseMetric>By<Dim1><Dim2>…`
 * — a camelCase metric (lowercase start, no underscores, no `.By.`) followed by
 * `By` and 2+ concatenated PascalCase dimensions (e.g.
 * `cpuUserByAccountIdBrokerIDClusterNameRegion`). The 2+-dim requirement (`By`
 * then a word then another capital) distinguishes Metric Streams from a classic
 * v2 single-dim suffix like `…ByRole`. Verified on nic55601: all 54 corpus
 * matches are multi-dim Metric Streams (kafka/amazonmq), zero single-dim.
 */
const METRIC_STREAMS_KEY_RE =
  /^(?:dt\.)?cloud\.aws\.[a-z0-9_]+\.[a-z][a-zA-Z0-9]*By[A-Z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/;

// Backtick-quoted column reference that LOOKS like an agg(metric) expression.
// These are downstream references to a column emitted by an earlier
// `timeseries avg(metric)` clause — the column inherits the agg-call string
// as its name. After we swap the metric key in the timeseries call, the
// column name changes and these references go stale; warn the user.
const BACKTICK_COLUMN_REF_PATTERN =
  /`(avg|sum|max|min|count|percentile|median)\(\s*((?:builtin:cloud\.aws|dt\.cloud\.aws|ext:cloud\.aws)\.[\w.:]+|cloud\.aws\.[a-z0-9_]+\.[a-z][\w]*)\s*\)`/g;

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

  // `count(metric)` semantically counts non-null occurrences, not "the
  // recipe's aggregation of metric". Preserve user intent rather than
  // silently swapping to recipe.newAggregation.
  const preserveUserAgg = userAgg === 'count';
  const effectiveNewAgg = preserveUserAgg ? userAgg : recipe.newAggregation;

  // If the user's aggregation differs from recipe.classicAggregation, warn —
  // we still respect user intent and DON'T silently swap to recipe's classic
  // agg. The recipe assumed the user would use classicAggregation.
  if (!preserveUserAgg && userAgg !== recipe.classicAggregation && (userAgg === 'avg' || userAgg === 'sum')) {
    warnings.push({
      kind: 'recipe-aggregation-mismatch',
      text:
        `User wrote ${userAgg}() but recipe is calibrated for classic ${recipe.classicAggregation}(). ` +
        `Output may be inaccurate; verify by running both classic and rewritten queries side by side.`,
      reference: SKILL_REFS.dqlFunctions,
    });
  }

  if (!preserveUserAgg && recipe.verdict !== 'exact-fit' && recipe.verdict !== 'good-fit') {
    warnings.push({
      kind: 'verdict-not-exact',
      text:
        `Recipe verdict is "${recipe.verdict}" (r=${recipe.pearsonR ?? '?'}, residualSmape=${recipe.residualSmape ?? '?'}). ` +
        `Treat the rewritten query as best-effort — values may differ moment-to-moment.`,
    });
  }

  const call = `${effectiveNewAgg}(\`${newDtMetricKey}\`)`;

  // DQL rejects arithmetic inside the timeseries aggregation slot
  // ("The parameter has to be a metric-based timeseries aggregation").
  // We therefore emit the metric swap as a clean call and surface the
  // recipe's per_second / scale math as a warning describing the
  // pipeline step the consumer should append after the timeseries clause.
  const needsPerSecond = !preserveUserAgg && recipe.newAggregationMode === 'per_second';
  const needsScale = !preserveUserAgg && recipe.scale !== null && Math.abs(recipe.scale - 1) > 0.02;
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
  const original = input;

  // Pass 0.5: credential-lookup-chain rewrite. Runs BEFORE the not-planned
  // bailout so the canonical `custom_device → accessible_by[aws_credentials]
  // → lookup aws_credentials for account name` idiom gets converted to the
  // Smartscape `smartscapeNodes <TYPE>` form instead of bailing. The metric's
  // service disambiguates the otherwise-ambiguous custom_device to a concrete
  // Smartscape node type. If the idiom isn't present or the service can't be
  // resolved, this is a no-op and the bailout below still fires.
  input = rewriteCredentialLookupChain(input, transforms, warnings);

  // Pass 0.6: the fieldsAdd-form of the same credential→account resolution
  // (`entityAttr(custom_device,"accessible_by")[aws_credentials]` →
  // `entityName(...)`). Collapsed to the same resource→AWS_ACCOUNT join, since
  // there's no resource→AWS_ACCOUNT edge to traverse.
  input = rewriteCredentialFieldsAdd(input, transforms, warnings);

  // Pre-pass: bail out if the query contains a `lookup [fetch
  // dt.entity.<not-planned-type>]` chain (e.g. `custom_device`,
  // `host_group`, `process_group`). The lookup's output prefixes downstream
  // column references back to classic relationship arrays, and Smartscape's
  // `references[…]` only works on entity records — not on prefixed lookup
  // output. Translating partially produces invalid DQL (the AAP_JET case:
  // `device.references[…]` raised FIELD_DOES_NOT_EXIST). Classic DQL still
  // runs on the new platform, so leaving the query verbatim is correct —
  // the user gets the same behavior they had before, plus a clear warning
  // that the chain needs manual redesign.
  const notPlannedLookup = findNotPlannedLookupSource(input);
  if (notPlannedLookup) {
    warnings.push({
      kind: 'unmapped-entity-type',
      text:
        `Query has a not-planned-type \`lookup [fetch dt.entity.${notPlannedLookup}]\` subquery. ` +
        `The lookup emits classic relationship arrays under its \`prefix:\` and Smartscape's ` +
        `\`references[…]\` only works on entity records, so this chain can't be auto-translated ` +
        `without producing invalid DQL. Leaving the entire query in classic form — manual redesign ` +
        `required (typically: replace the lookup with a direct \`smartscapeNodes <TYPE>\` join, ` +
        `then re-run the rewriter).`,
      reference: SKILL_REFS.specialCases,
    });
    return { original, rewritten: original, transforms, warnings };
  }

  // Pass 1: replace metric keys inside aggregation calls + apply recipe.
  // Records classic→new key swaps so Pass 1.4 can fix self-referential
  // backtick column refs (the auto-generated `agg(key)` column name).
  const metricKeySwaps = new Map<string, string>();
  let rewritten = input.replace(
    CLASSIC_KEY_PATTERN,
    (full, userAgg: string, classicKey: string, trailing: string) => {
      // The bare-`cloud.aws.*` branch of the pattern can also match
      // new-connection keys; disambiguate by rejecting any key whose shape
      // is `cloud.aws.<Service>.<PascalCase>.By.<Dim>`.
      if (isNewConnectionShape(classicKey)) return full;

      // EOL check: if the metric's service has been announced end-of-life,
      // surface that prominently. Two sources, in order:
      //   1. Slug-based lookup against end-of-life-services.json — gives the
      //      precise EOL date + announcement URL.
      //   2. DAC entry's `endOfLife` flag — broader catch (4,168 entries) but
      //      only a boolean. Use it as a fallback when (1) misses.
      // Don't block the rewrite — the user may still want the translation,
      // but they should know they may be migrating away from a retiring
      // service.
      const eol = lookupEolForClassicKey(classicKey);
      if (eol) {
        warnings.push({
          kind: 'end-of-life-service',
          text:
            `Metric ${classicKey} references ${eol.resourceType}, which is end-of-life as of ${eol.endOfLifeDate}. ` +
            `Consider whether migrating this metric is worth the effort. Announcement: ${eol.announcementUrl}`,
          reference: 'dt-migration/references/end-of-life-services.json',
          match: classicKey,
        });
      } else if (index.dac) {
        const dacHit = lookupInDac(index.dac, classicKey);
        if (dacHit?.endOfLife) {
          warnings.push({
            kind: 'end-of-life-service',
            text:
              `Metric ${classicKey} (${dacHit.cloudwatchNamespace} ${dacHit.cloudwatchMetricName}) is marked ` +
              `end-of-life by the DAC mapping. Confirm the EOL date with AWS and consider whether migrating is worth the effort.`,
            reference: 'dt-migration/references/dac-aws-to-2ndgen-metrics.json',
            match: classicKey,
          });
        }
      }

      const lookup: LookupResult = lookupClassicKey(index, classicKey);
      if (lookup.kind === 'unknown') {
        // AWS Metric Streams keys (camelCase metric + concatenated PascalCase
        // dims, e.g. cloud.aws.kafka.cpuUserByAccountIdBrokerIDClusterNameRegion)
        // have no new-connection equivalent — Metric Streams isn't supported by
        // the new connection. Flag them distinctly rather than as a generic
        // unknown-metric (they're unmappable by design, not a coverage gap).
        // Only reached for keys that didn't resolve, so mapped classic keys
        // (incl. camelCase v2 keys) are never misclassified here.
        if (METRIC_STREAMS_KEY_RE.test(classicKey)) {
          warnings.push({
            kind: 'metric-streams-blocked',
            text:
              `AWS Metric Streams metric: ${classicKey}. The new AWS connection does not (yet) ` +
              `support Metric Streams, so this key has no equivalent and the tile cannot be ` +
              `migrated. Flag the account as "migration-blocked (Metric Streams)"; classic ` +
              `polling metrics on the same account still migrate.`,
            reference: SKILL_REFS.specialCases,
            match: classicKey,
          });
          return full;
        }
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
        const newKey = lookup.entry.newDtMetricKey;
        // The live-metric inventory repaired an empty dim variant: surface it
        // as its own warning so the dim swap (and the inventory-incompleteness
        // caveat) isn't buried in the generic mapped-no-recipe note.
        if (lookup.dimOverride) {
          const o = lookup.dimOverride;
          warnings.push({
            kind: 'dim-variant-override',
            text:
              `Dimension-variant override: ${o.from} has no live series on this tenant; ` +
              `using ${o.to} (${o.count} series) instead. The inventory only sees currently-` +
              `collected metrics — if ${o.from} is the intended grain but simply not collected ` +
              `here, revert this swap.`,
            match: classicKey,
          });
        }
        // We know the new key (the DAC or our enriched mapping told us) but
        // have no verified recipe. Swap the metric key, preserve the user's
        // aggregation, and warn so they can spot-check.
        if (!newKey) {
          warnings.push({
            kind: 'mapped-no-recipe',
            text:
              `Classic metric ${classicKey} is mapped but has no new key — leaving unchanged.` +
              (lookup.entry.notes ? ` (${lookup.entry.notes})` : ''),
            match: classicKey,
          });
          return full;
        }
        warnings.push({
          kind: 'mapped-no-recipe',
          text:
            `Classic metric ${classicKey} → ${newKey}. Swapped the metric key only; the ` +
            `aggregation/scale wasn't verified by a detected recipe — spot-check values vs the classic side.` +
            (lookup.entry.notes ? ` (${lookup.entry.notes})` : ''),
          match: classicKey,
        });
        const swapOnly = trailing === ','
          ? `${userAgg}(\`${newKey}\`,`
          : `${userAgg}(\`${newKey}\`)`;
        // Record the auto-generated column-name swap so Pass 1.4 can fix
        // downstream backtick refs (only for the plain `agg(key)` form, not
        // the `agg(key, filter:…)` form which isn't a column name).
        if (trailing === ')') {
          metricKeySwaps.set(`${userAgg}(${classicKey})`, `${userAgg}(${newKey})`);
        }
        transforms.push({
          kind: 'metric-key',
          before: `${userAgg}(${classicKey}${trailing === ',' ? ',' : ')'}`,
          after: swapOnly,
          detail: 'metric-only swap (no verified recipe — agg preserved as user wrote it)',
        });
        return swapOnly;
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
      // Column-name swap for Pass 1.4 (strip inner backticks: DQL names the
      // column after the source expr without them).
      metricKeySwaps.set(`${userAgg}(${classicKey})`, r.call.replace(/`/g, ''));
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

  // Pass 1.4: fix backtick-quoted column references that name an earlier
  // `timeseries agg(metric)` output column. When Pass 1 swaps the metric key,
  // that auto-generated column name changes too (`avg(<classic>)` →
  // `avg(<new>)`), so any downstream `\`avg(<classic>)\`` ref goes stale and
  // raises FIELD_DOES_NOT_EXIST. For every swap Pass 1 recorded, rewrite the
  // matching backtick ref in place. Verified on tenant: the new column name
  // is `agg(<newKey>)` with NO inner backticks even when the timeseries
  // clause wrote `agg(\`<newKey>\`)`.
  for (const [oldCol, newCol] of metricKeySwaps) {
    if (oldCol === newCol) continue;
    const ref = '`' + oldCol + '`';
    if (rewritten.includes(ref)) {
      rewritten = rewritten.split(ref).join('`' + newCol + '`');
      transforms.push({
        kind: 'metric-key',
        before: ref,
        after: '`' + newCol + '`',
        detail: 'backtick column reference realigned to the swapped timeseries output column',
      });
    }
  }
  // Anything still matching the backtick-agg-of-classic-key shape wasn't
  // covered by a recorded swap (e.g. an aliased timeseries column, or a key
  // we left unchanged) — warn so the user can realign it by hand.
  BACKTICK_COLUMN_REF_PATTERN.lastIndex = 0;
  let bm: RegExpExecArray | null;
  while ((bm = BACKTICK_COLUMN_REF_PATTERN.exec(rewritten)) !== null) {
    warnings.push({
      kind: 'recipe-aggregation-mismatch',
      text:
        `Backtick column reference \`${bm[1]}(${bm[2]})\` references a column emitted by an earlier ` +
        `timeseries call. After the metric-key swap that column's name changes, so this reference will ` +
        `return null. Fix: alias the timeseries output (e.g. \`val = avg(...)\`) and rename the reference.`,
      reference: SKILL_REFS.dqlFunctions,
      match: bm[0],
    });
  }

  // Pass 1.5: rewrite `in(<classic_or_new_dim>, classicEntitySelector("..."))`
  // into a translated filter clause. Run before the dt.entity.* sweep so we
  // can use the original classic dim to determine which smartscape dim
  // applies. Both forms are matched: pre-pass-2 (with `dt.entity.X`) and the
  // already-renamed form (`dt.smartscape.X`).
  rewritten = rewriteClassicSelectorIns(rewritten, transforms, warnings);

  // Pass 1.55: disambiguate classic `dt.entity.custom_device` to a real
  // Smartscape node type. Custom_device is "not planned" in Smartscape, but in
  // practice classic AWS dashboards use it as a generic wrapper around services
  // (Lambda, DynamoDB, ECS, …) that DO have node types. The query's metric key
  // (`cloud.aws.<service>.…`) — or an explicit `entity.type == "cloud:aws:X"`
  // filter — names the service, which the empirical bridge
  // (aws-service-node-types.ts) maps to the node type. `fetch` becomes
  // `smartscapeNodes <TYPE>`; bare references become `dt.smartscape.<type>`.
  const fetchContext: FetchContext = { sourceSmartscapeType: null, didRewriteFetch: false };
  rewritten = rewriteCustomDeviceViaService(rewritten, transforms, warnings, fetchContext);

  // Pass 1.6: `fetch dt.entity.X` → `smartscapeNodes <TYPE>`. Must come
  // before the relationship-bracket pass so we know the source type for
  // edge validation.
  rewritten = rewriteFetchEntity(rewritten, transforms, warnings, fetchContext);

  // Pass 1.7: rewrite classic relationship-bracket projections like
  // `belongs_to[dt.entity.host]` into `references[belongs_to.host]`. Use
  // fetchContext.sourceSmartscapeType (when known) to validate the edge
  // against smartscape-edges.ts and substitute the correct edge if the
  // classic name doesn't match the actual edge for the source-target pair.
  rewritten = rewriteRelationshipBrackets(rewritten, transforms, warnings, fetchContext);

  // Pass 2: replace dt.entity.<type> with dt.smartscape.<...>.
  // Skip dim swaps inside `lookup [fetch dt.entity.<not-planned-type>]`
  // subqueries — the entire subquery is classic-only and a partial rewrite
  // (smartscape dim inside a classic-fetch subquery) produces invalid DQL.
  const pass2NonSmartscapeRegions = findNonSmartscapeLookupRegions(rewritten);
  rewritten = rewritten.replace(ENTITY_DIM_PATTERN, (full, entityType: string, offset: number) => {
    if (isInsideRegion(offset, pass2NonSmartscapeRegions)) return full;
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
    if (mapping.status === 'ambiguous') {
      // Multi-target mapping (e.g. cloud_application → 7 k8s workload kinds).
      // Apply the default but warn so the user can substitute the right type.
      warnings.push({
        kind: 'unmapped-entity-type',
        text:
          `dt.entity.${entityType} is ambiguous in Smartscape. ` +
          `Using default ${mapping.smartscapeNodeType}; alternatives: ` +
          `${(mapping.altSmartscapeNodeTypes ?? []).join(', ')}. ` +
          `${mapping.notes ?? ''}`,
        reference: SKILL_REFS.typeMappings,
        match: full,
      });
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

  // Pass 2.55: collapse the classic `splitString(toString(<tags>), "[AWS]Key:")…`
  // value-extraction idiom to a direct record read `<tags>[Key]` (tags:aws).
  rewritten = rewriteTagExtraction(rewritten, transforms);

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

  // Pass 2.65: classic source-entity signal fields → Smartscape source fields.
  // Per dt-migration/references/dql-function-migration.md event-fields table:
  //   dt.source_entity.type → dt.smartscape_source.type
  //   dt.source_entity      → dt.smartscape_source.id   (the bare ID field)
  // Verified on tenant nic55601: both new fields are carried on AWS metric
  // series (`dt.smartscape_source.id` = "AWS_LAMBDA_FUNCTION-…",
  // `dt.smartscape_source.type` = "AWS_LAMBDA_FUNCTION"). Common in classic
  // `by:{dt.entity.X = dt.source_entity, dt.source_entity.type}` grouping
  // idioms — appears in ~2,300 translated queries on this tenant.
  {
    let typeCount = 0;
    rewritten = rewritten.replace(/\bdt\.source_entity\.type\b/g, () => {
      typeCount++;
      return 'dt.smartscape_source.type';
    });
    if (typeCount > 0) {
      transforms.push({
        kind: 'entity-dim',
        before: 'dt.source_entity.type',
        after: 'dt.smartscape_source.type',
        detail: 'classic source-entity type field → Smartscape source type',
      });
    }
    // Bare `dt.source_entity` (the source-entity ID), not followed by a field
    // accessor we already handled. `.type` is gone by now; guard against any
    // other `.<word>` to avoid touching unknown sub-fields.
    let idCount = 0;
    rewritten = rewritten.replace(/\bdt\.source_entity\b(?!\.\w)/g, () => {
      idCount++;
      return 'dt.smartscape_source.id';
    });
    if (idCount > 0) {
      transforms.push({
        kind: 'entity-dim',
        before: 'dt.source_entity',
        after: 'dt.smartscape_source.id',
        detail: 'classic source-entity ID field → Smartscape source id',
      });
    }
  }

  // Pass 2.7: when fetch was restructured to a known Smartscape node type,
  // translate classic-only field identifiers (`awsAccountId`, `rdsEngine`)
  // to their Smartscape equivalents.
  //
  // Rules:
  //   - Skip identifiers preceded by `$` — those are dashboard variable
  //     refs, not field refs. Variables retain their declaration-time name.
  //     A warning surfaces these for the user to consider renaming by hand.
  //   - Wrap dotted Smartscape field names (e.g. `db.system`) in backticks
  //     so DQL parses them as a single identifier rather than a member-of-
  //     member access. Otherwise `lookup.db.system` becomes ambiguous.
  if (fetchContext.didRewriteFetch && fetchContext.sourceSmartscapeType) {
    const table = ENTITY_FIELD_MAPPINGS_BY_NODE_TYPE[fetchContext.sourceSmartscapeType];
    if (table) {
      for (const m of table) {
        const replacement = m.smartscapeField.includes('.')
          ? `\`${m.smartscapeField}\``
          : m.smartscapeField;
        // Negative lookbehind `(?<![$\w.])` skips `$rdsEngine` (variable ref)
        // and `lookup.rdsEngine`-style accesses where the leading char is a
        // dot — those would produce an ambiguous parse after rename.
        const re = new RegExp(`(?<![$\\w.])${m.classicField}\\b`, 'g');
        let changed = false;
        rewritten = rewritten.replace(re, () => {
          changed = true;
          return replacement;
        });
        if (changed) {
          transforms.push({
            kind: 'entity-dim',
            before: m.classicField,
            after: replacement,
            detail: `${fetchContext.sourceSmartscapeType} field rename` +
              (m.notes ? ` (${m.notes})` : ''),
          });
        }
        // Detect surviving `$classicField` refs — the variable name didn't
        // change. Warn the user since the visual link "variable named X
        // filters field X" is now broken.
        const varRe = new RegExp(`\\$${m.classicField}\\b`, 'g');
        if (varRe.test(rewritten)) {
          warnings.push({
            kind: 'unmapped-entity-type',
            text:
              `Dashboard variable \`$${m.classicField}\` still references the classic name; the underlying ` +
              `field has been renamed to \`${m.smartscapeField}\` on ${fetchContext.sourceSmartscapeType}. ` +
              `Consider renaming the variable for clarity.`,
            reference: SKILL_REFS.typeMappings,
          });
        }
        // Also: a `lookup.<classic>` accessor would have been left alone by
        // the negative lookbehind above. Detect and warn — that field
        // probably came from a subquery that ALSO needs the new field name.
        const lookupRe = new RegExp(`lookup\\.${m.classicField}\\b`, 'g');
        if (lookupRe.test(rewritten)) {
          rewritten = rewritten.replace(lookupRe, () => `lookup.${replacement}`);
          transforms.push({
            kind: 'entity-dim',
            before: `lookup.${m.classicField}`,
            after: `lookup.${replacement}`,
            detail: `Renamed lookup accessor for ${fetchContext.sourceSmartscapeType} field`,
          });
        }
      }
    }
  }

  // Pass 2.8: by-clause / non-carrier dim alignment.
  //
  // When a `dt.entity.X` dim gets swapped to `dt.smartscape.X` and used in a
  // `by:{...}` clause, that dim must actually be carried on the new metric
  // series — otherwise the grouping collapses to a single null-keyed row.
  // Most AWS Smartscape types (Lambda, EC2, RDS, etc.) ARE carriers per the
  // tenant probe (2026-05-12); ~14 are NOT (ECS, EFS, NAT Gateway, etc.).
  //
  // For each non-carrier dim used in a by-clause AFTER a metric was
  // rewritten, surface a warning telling the user what to substitute (the
  // CloudWatch dim implied by the metric's `.By.<Dim>` suffix, or `aws.arn`
  // as a universal fallback).
  if (transforms.some((t) => t.kind === 'metric-key')) {
    // Find every `dt.smartscape.<type>` reference inside a by-clause. Cheap
    // proxy: scan for `by:` followed by a `dt.smartscape.X` token.
    const BY_DIM_RE = /\bby\s*:\s*\{[^}]*?\bdt\.smartscape\.([a-z0-9_]+)/g;
    BY_DIM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = BY_DIM_RE.exec(rewritten)) !== null) {
      const dimSlug = m[1]!;
      const nodeType = dimSlug.toUpperCase();
      if (seen.has(nodeType)) continue;
      seen.add(nodeType);
      // Only warn for types we KNOW are not carriers. Unknown types stay
      // silent (a noisy "we don't know" warning has no actionable signal).
      if (isMetricCarrier(nodeType)) continue;
      if (!isKnownNonCarrier(nodeType)) continue;

      // Best-effort: find a CloudWatch dim from a nearby `.By.<Dim>` segment.
      const byDimMatch = /\bcloud\.aws\.[a-z0-9_]+\.[A-Za-z0-9]+\.By\.([A-Za-z0-9.]+)/.exec(
        rewritten
      );
      const suggestion = byDimMatch
        ? `by:{ ${byDimMatch[1]!.split('.').join(', ')} }`
        : 'by:{ aws.arn }';

      warnings.push({
        kind: 'unmapped-entity-type',
        text:
          `by:{ dt.smartscape.${dimSlug} } — the ${nodeType} Smartscape dim isn't carried on ` +
          `the new metric series, so this grouping collapses all rows to a single null-keyed ` +
          `bucket. Substitute: ${suggestion} (derived from the metric's CloudWatch dim suffix), ` +
          `or use 'by:{ aws.arn }' as a universal fallback.`,
        reference: SKILL_REFS.typeMappings,
        match: `dt.smartscape.${dimSlug}`,
      });
    }
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

  return { original, rewritten, transforms, warnings };
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

// The classic custom_device entity.type → Smartscape node-type map now lives in
// `aws-service-node-types.ts` (SERVICE_NODE_TYPE_MAP + CUSTOM_DEVICE_TYPE_ALIASES),
// derived empirically by `discover-entity-types`. Resolve via
// nodeTypeForMetricService / nodeTypeForCustomDeviceType.

// ─── Pass 0.5: credential-lookup-chain → smartscapeNodes ──────────────────
//
// The dominant Pass-0 bailout idiom (97 of 106 DynamoDB bailouts, plus
// Lambda/etc.) is a custom_device metric joined through the classic
// "connection" relationship to recover the account name:
//
//   timeseries <agg>(cloud.aws.<svc>.<metric>), by:{dt.entity.custom_device}
//   | lookup [fetch dt.entity.custom_device
//       | fieldsAdd dt.entity.aws_credentials = accessible_by[dt.entity.aws_credentials][0]],
//       sourceField:dt.entity.custom_device, lookupField:id, prefix:"device."
//   | fieldsAdd dt.entity.aws_credentials = device.accessible_by[dt.entity.aws_credentials][0]
//   | lookup [fetch dt.entity.aws_credentials | fields name = entity.name, id],
//       sourceField:dt.entity.aws_credentials, lookupField:id, prefix:"account."
//   | filter account.name == "<conn>"  | filter like(device.entity.name, "…")  | summarize …
//
// custom_device alone is "not-planned" (hence the bailout), but the metric
// key's service segment disambiguates it to a concrete Smartscape node
// (`cloud.aws.dynamodb.*` → AWS_DYNAMODB_TABLE). With the node type known,
// the two lookups collapse to the readable Smartscape form the user
// hand-verified (keep the lookups, no static account-id map):
//
//   | lookup [smartscapeNodes <TYPE> | fields name, id, aws.account.id],
//       sourceField:dt.smartscape.<type>, lookupField:id, prefix:"device."
//   | lookup [smartscapeNodes AWS_ACCOUNT | fields name, aws.account.id],
//       sourceField:device.aws.account.id, lookupField:aws.account.id, prefix:"account."
//
// CAVEAT (warned): the classic `account.name` filter targets a single
// *credential* (connection); the Smartscape AWS_ACCOUNT node is one-per-
// account. When an account has >1 classic credential, the rewritten filter
// is broader. Verified on tenant nic55601 (account 560380317052 has two
// credentials, DEV-CustomerTechnology + …-EGY).
const CREDENTIAL_LOOKUP_CHAIN_RE = new RegExp(
  '\\|\\s*lookup\\s*\\[\\s*fetch\\s+`?dt\\.entity\\.custom_device`?\\s*' +
    '\\|\\s*fieldsAdd\\s+`?dt\\.entity\\.aws_credentials`?\\s*=\\s*accessible_by\\[`?dt\\.entity\\.aws_credentials`?\\]\\[0\\]\\s*\\]\\s*,\\s*' +
    'sourceField\\s*:\\s*`?dt\\.entity\\.custom_device`?\\s*,\\s*lookupField\\s*:\\s*id\\s*,\\s*prefix\\s*:\\s*"device\\."\\s*' +
    '\\|\\s*fieldsAdd\\s+`?dt\\.entity\\.aws_credentials`?\\s*=\\s*device\\.accessible_by\\[`?dt\\.entity\\.aws_credentials`?\\]\\[0\\]\\s*' +
    '\\|\\s*lookup\\s*\\[\\s*fetch\\s+`?dt\\.entity\\.aws_credentials`?\\s*' +
    '\\|\\s*fields\\s+name\\s*=\\s*entity\\.name\\s*,\\s*id\\s*\\]\\s*,\\s*' +
    'sourceField\\s*:\\s*`?dt\\.entity\\.aws_credentials`?\\s*,\\s*lookupField\\s*:\\s*id\\s*,\\s*prefix\\s*:\\s*"account\\."',
  'g'
);

/** Derive the AWS service segment from the first classic metric key in the query. */
function serviceFromClassicKeyInQuery(input: string): string | null {
  const m = /(?:dt\.)?cloud\.aws\.([a-z0-9_]+)\./.exec(input);
  return m ? m[1]! : null;
}

function rewriteCredentialLookupChain(
  input: string,
  transforms: Transform[],
  warnings: Warning[]
): string {
  CREDENTIAL_LOOKUP_CHAIN_RE.lastIndex = 0;
  if (!CREDENTIAL_LOOKUP_CHAIN_RE.test(input)) return input;

  // Disambiguate custom_device via the metric's service segment.
  const service = serviceFromClassicKeyInQuery(input);
  if (!service) return input;
  const nodeType = nodeTypeForMetricService(service);
  if (!nodeType) {
    // Recognized the idiom but can't resolve the service to a node type —
    // leave it for the bailout, but leave a breadcrumb for table expansion.
    warnings.push({
      kind: 'entity-relationship-traversal',
      text:
        `Recognized a custom_device credential-lookup chain for service "${service}", but no ` +
        `Smartscape node type is mapped for it in SERVICE_NODE_TYPE_MAP (aws-service-node-types.ts). ` +
        `Run \`cct discover-entity-types\` and add it to auto-convert this shape.`,
      reference: SKILL_REFS.specialCases,
    });
    return input;
  }
  const dim = smartscapeDimForNodeType(nodeType);

  // 1. Replace the two-lookup credential block with the Smartscape form.
  CREDENTIAL_LOOKUP_CHAIN_RE.lastIndex = 0;
  let out = input.replace(
    CREDENTIAL_LOOKUP_CHAIN_RE,
    () =>
      `| lookup [smartscapeNodes ${nodeType} | fields name, id, aws.account.id], ` +
      `sourceField:${dim}, lookupField:id, prefix:"device."\n` +
      `| lookup [smartscapeNodes AWS_ACCOUNT | fields name, aws.account.id], ` +
      `sourceField:device.aws.account.id, lookupField:aws.account.id, prefix:"account."`
  );

  // 2. Any remaining `dt.entity.custom_device` references in this query are
  //    this service's table/resource — rewrite them to the resolved dim so
  //    the by-clause, entityName(...), etc. all align. (The block above no
  //    longer contains custom_device, so this only touches head/tail refs.)
  out = out.replace(/`?dt\.entity\.custom_device`?/g, dim);

  // 3. device.entity.name → device.name (the lookup now selects bare `name`).
  out = out.replace(/\bdevice\.entity\.name\b/g, 'device.name');

  transforms.push({
    kind: 'entity-dim',
    before: 'lookup [fetch dt.entity.custom_device … accessible_by[aws_credentials]] → lookup [fetch dt.entity.aws_credentials …]',
    after: `lookup [smartscapeNodes ${nodeType} … aws.account.id] → lookup [smartscapeNodes AWS_ACCOUNT …]`,
    detail: `credential-lookup chain collapsed; custom_device disambiguated to ${nodeType} via metric service "${service}"`,
  });
  warnings.push({
    kind: 'credential-collapsed',
    text:
      `Collapsed a classic credential (connection) lookup to an AWS_ACCOUNT join. A single AWS ` +
      `account can have multiple classic credentials, but Smartscape has one AWS_ACCOUNT node per ` +
      `account — so the rewritten \`account.name == "…"\` filter is BROADER than the classic ` +
      `single-credential filter. Verify intent for multi-credential accounts.`,
    reference: SKILL_REFS.specialCases,
  });
  return out;
}

// Pass 0.6 — the fieldsAdd-form of the same credential→account resolution. The
// canonical 2-line idiom (2,587 panels) reads the account name by traversing
// the classic `accessible_by` relationship to the credential entity:
//   | fieldsAdd dt.entity.aws_credentials = entityAttr(dt.entity.custom_device, "accessible_by")[dt.entity.aws_credentials][0]
//   | fieldsAdd <acct> = lower(entityName(dt.entity.aws_credentials))
// There is NO resource→AWS_ACCOUNT edge in Smartscape (a `getNodeField(x,
// "accessible_by")[…]` traversal silently returns empty). The account is a
// denormalized field — so resolve it the same way Pass 0.5 does: join the
// resource node for its `aws.account.id`, then join AWS_ACCOUNT for the name.
const CREDENTIAL_FIELDSADD_RE =
  /\|\s*fieldsAdd\s+dt\.entity\.aws_credentials\s*=\s*entityAttr\(\s*dt\.entity\.custom_device\s*,\s*"accessible_by"\)\s*\[\s*dt\.entity\.aws_credentials\s*\]\s*\[\s*0\s*\]\s*\r?\n\s*\|\s*fieldsAdd\s+(\w+)\s*=\s*(lower\(\s*)?entityName\(\s*dt\.entity\.aws_credentials\s*\)\s*(\))?/g;

function rewriteCredentialFieldsAdd(
  input: string,
  transforms: Transform[],
  warnings: Warning[]
): string {
  CREDENTIAL_FIELDSADD_RE.lastIndex = 0;
  if (!CREDENTIAL_FIELDSADD_RE.test(input)) return input;
  const service = serviceFromClassicKeyInQuery(input);
  const nodeType = service ? nodeTypeForMetricService(service) : undefined;
  if (!service || !nodeType) return input; // unresolved → leave for generic passes
  const dim = smartscapeDimForNodeType(nodeType);

  CREDENTIAL_FIELDSADD_RE.lastIndex = 0;
  let out = input.replace(
    CREDENTIAL_FIELDSADD_RE,
    (_full, acctVar: string, lowerOpen: string | undefined, lowerClose: string | undefined) =>
      `| lookup [smartscapeNodes ${nodeType} | fields name, id, aws.account.id], ` +
      `sourceField:${dim}, lookupField:id, prefix:"device."\n` +
      `| lookup [smartscapeNodes AWS_ACCOUNT | fields name, aws.account.id], ` +
      `sourceField:device.aws.account.id, lookupField:aws.account.id, prefix:"account."\n` +
      `| fieldsAdd ${acctVar} = ${lowerOpen ?? ''}account.name${lowerClose ?? ''}`
  );
  // Align remaining custom_device refs (by-clause, entityAttr(…,"arn"), etc.).
  out = out.replace(/`?dt\.entity\.custom_device`?/g, dim);

  transforms.push({
    kind: 'entity-dim',
    before: 'fieldsAdd dt.entity.aws_credentials = entityAttr(custom_device,"accessible_by")[…] → entityName(…)',
    after: `lookup [smartscapeNodes ${nodeType} … aws.account.id] → lookup [smartscapeNodes AWS_ACCOUNT …] → account.name`,
    detail: `credential field-read collapsed; custom_device disambiguated to ${nodeType} via metric service "${service}"`,
  });
  warnings.push({
    kind: 'credential-collapsed',
    text:
      `Collapsed a classic credential (connection) field-read to an AWS_ACCOUNT join. A single AWS ` +
      `account can have multiple classic credentials, but Smartscape has one AWS_ACCOUNT node per ` +
      `account — so any \`account.name\`-based filter is BROADER than the classic single-credential ` +
      `one. Verify intent for multi-credential accounts.`,
    reference: SKILL_REFS.specialCases,
  });
  return out;
}

// `fetch dt.entity.custom_device | filter entity.type == "cloud:aws:X"` — the
// adjacent fetch+filter pair. Collapsed to `smartscapeNodes <TYPE>` (the filter
// is redundant once the node type is fixed).
const CUSTOM_DEVICE_FETCH_FILTER_RE =
  /\bfetch\s+`?dt\.entity\.custom_device`?\s*(?:\r?\n)?\s*\|\s*filter\s+`?entity\.type`?\s*==\s*"([^"]+)"/g;
const BARE_FETCH_CUSTOM_DEVICE_RE = /\bfetch\s+`?dt\.entity\.custom_device`?/g;
const CUSTOM_DEVICE_REF_RE = /`?dt\.entity\.custom_device`?/g;
const CUSTOM_DEVICE_ENTITY_TYPE_RE = /\bentity\.type\b\s*==\s*"(cloud:aws:[a-z0-9_:]+)"/;

/**
 * Pass 1.55 — disambiguate `dt.entity.custom_device` to a real Smartscape node
 * type. Custom_device is "not planned" in Smartscape and would otherwise bail,
 * but classic AWS dashboards use it as a generic wrapper around services that
 * DO have node types. The service is named by the query's metric key
 * (`cloud.aws.<service>.…`) or an explicit `entity.type == "cloud:aws:X"`
 * filter; the empirical bridge (aws-service-node-types.ts) maps it to the node
 * type. `fetch` → `smartscapeNodes <TYPE>`; bare references → `dt.smartscape.<type>`.
 *
 * Leaves the query untouched when the service can't be resolved (so the
 * downstream not-planned warning still fires). Warns ONLY when the result needs
 * human review — a multi-node grain default (rds/docdb/neptune) or a remaining
 * classic credential/account traversal — so high-confidence conversions (e.g. a
 * Lambda `by:{dt.entity.custom_device}`) can reach clean.
 */
function rewriteCustomDeviceViaService(
  input: string,
  transforms: Transform[],
  warnings: Warning[],
  ctx: FetchContext
): string {
  if (!/\bdt\.entity\.custom_device\b/.test(input)) return input;

  // Resolve the node type: an explicit entity.type filter wins (most specific),
  // else the service segment of the query's metric key.
  let nodeType: string | undefined;
  let service: string | undefined;
  let how = '';
  const typeFilter = CUSTOM_DEVICE_ENTITY_TYPE_RE.exec(input);
  if (typeFilter) {
    const resolved = nodeTypeForCustomDeviceType(typeFilter[1]!);
    if (resolved) {
      nodeType = resolved;
      how = `entity.type "${typeFilter[1]}"`;
      service = /^cloud:aws:([a-z0-9_]+)/.exec(typeFilter[1]!)?.[1];
    }
  }
  if (!nodeType) {
    const svc = serviceFromClassicKeyInQuery(input);
    const resolved = svc ? nodeTypeForMetricService(svc) : undefined;
    if (svc && resolved) {
      nodeType = resolved;
      service = svc;
      how = `metric service "${svc}"`;
    }
  }
  if (!nodeType) return input; // unresolved → downstream emits the not-planned warning

  const dim = smartscapeDimForNodeType(nodeType);
  CUSTOM_DEVICE_FETCH_FILTER_RE.lastIndex = 0;
  let out = input.replace(CUSTOM_DEVICE_FETCH_FILTER_RE, () => `smartscapeNodes ${nodeType}`);
  out = out.replace(BARE_FETCH_CUSTOM_DEVICE_RE, () => `smartscapeNodes ${nodeType}`);
  out = out.replace(CUSTOM_DEVICE_REF_RE, (m) => (m.startsWith('`') ? '`' + dim + '`' : dim));
  if (out === input) return input;

  ctx.sourceSmartscapeType = nodeType;
  if (/\bsmartscapeNodes\b/.test(out) && !/\bsmartscapeNodes\b/.test(input)) ctx.didRewriteFetch = true;
  transforms.push({
    kind: 'entity-dim',
    before: 'dt.entity.custom_device',
    after: dim,
    detail: `custom_device disambiguated via ${how} → ${nodeType}`,
  });

  const caveats: string[] = [];
  if (service && isMultiNodeService(service)) {
    caveats.push(
      `${service} emits metrics under multiple node types ` +
        `(${MULTI_NODE_SERVICES[service]!.join(', ')}); defaulted to ${nodeType} ` +
        `(most-populated grain) — confirm it's the intended one`
    );
  }
  if (/accessible_by|aws_credentials/.test(out)) {
    caveats.push(
      `the query still traverses the classic credential/account relationship ` +
        `(accessible_by / aws_credentials); the Smartscape account join differs — review separately`
    );
  }
  if (caveats.length > 0) {
    warnings.push({
      kind: 'custom-device-disambiguated',
      text: `Classic dt.entity.custom_device disambiguated to ${nodeType} via ${how}. ` + caveats.join('; ') + '.',
      match: 'dt.entity.custom_device',
    });
  }
  return out;
}

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
    if (mapping.status === 'ambiguous') {
      warnings.push({
        kind: 'unmapped-entity-type',
        text:
          `fetch dt.entity.${entityType} → smartscapeNodes ${mapping.smartscapeNodeType} ` +
          `(ambiguous; alternatives: ${(mapping.altSmartscapeNodeTypes ?? []).join(', ')}). ` +
          `${mapping.notes ?? ''}`,
        reference: SKILL_REFS.typeMappings,
        match: full,
      });
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

/**
 * Returns the classic entity type of the first `lookup [fetch dt.entity.<X>]`
 * subquery whose X is NOT Smartscape-mapped, or `null` if none. Used by the
 * top-level rewriter to detect classic-only lookup chains it can't safely
 * translate (see `rewriteDql` pre-pass for the full rationale).
 */
function findNotPlannedLookupSource(input: string): string | null {
  const re = /\blookup\s*\[\s*fetch\s+`?dt\.entity\.([\w:]+)`?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const entityType = m[1]!;
    const mapping = classicEntityToSmartscape(entityType);
    if (!mapping || mapping.status === 'not-planned' || !mapping.smartscapeNodeType) {
      return entityType;
    }
  }
  return null;
}

/**
 * Find text regions corresponding to `lookup [ fetch dt.entity.<X> ... ]`
 * subqueries whose source X is NOT Smartscape-mapped (e.g. `custom_device`,
 * `host_group`, `process_group` — all `not-planned`). Inside such a region,
 * the surrounding context is still classic, so rewriting a relationship
 * bracket to `references[...]` produces invalid DQL — `references[...]` is a
 * Smartscape-only construct.
 *
 * Returns the half-open `[start, end)` byte spans of those regions so callers
 * can skip rewrites whose match falls inside any of them.
 *
 * NOTE: with the top-level pre-pass in `rewriteDql` now bailing out of any
 * query containing a not-planned-lookup chain, this function's per-pass
 * region check is technically dead code. Keeping it as a defense-in-depth
 * guard in case the pre-pass misses an edge case (e.g. lookup syntax that
 * doesn't match `findNotPlannedLookupSource`'s regex).
 */
function findNonSmartscapeLookupRegions(input: string): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  const re = /\blookup\s*\[\s*fetch\s+`?dt\.entity\.([\w:]+)`?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const entityType = m[1]!;
    const mapping = classicEntityToSmartscape(entityType);
    // Skip if the inner fetch type IS Smartscape-mapped — bracket rewrites
    // inside that subquery are fine (its own context is Smartscape).
    if (mapping && mapping.status !== 'not-planned' && mapping.smartscapeNodeType) {
      continue;
    }
    // Walk square brackets to find the matching `]` for this `lookup [`.
    let depth = 1;
    let i = re.lastIndex;
    while (i < input.length && depth > 0) {
      const c = input[i]!;
      if (c === '[') depth++;
      else if (c === ']') depth--;
      i++;
    }
    regions.push({ start: m.index, end: i });
  }
  return regions;
}

function isInsideRegion(
  pos: number,
  regions: Array<{ start: number; end: number }>
): boolean {
  for (const r of regions) {
    if (pos >= r.start && pos < r.end) return true;
  }
  return false;
}

function rewriteRelationshipBrackets(
  input: string,
  transforms: Transform[],
  warnings: Warning[],
  ctx: FetchContext
): string {
  const nonSmartscapeRegions = findNonSmartscapeLookupRegions(input);
  return input.replace(
    RELATIONSHIP_BRACKET_PROJECTION_RE,
    (full, classicEdge: string, targetClassicType: string, offset: number) => {
      // Bug fix (2026-05-14): if this bracket is INSIDE a `lookup [fetch
      // dt.entity.<not-planned-type> ...]` subquery, the surrounding fetch
      // is still classic, so emitting `references[...]` produces a runtime
      // error (`FIELD_DOES_NOT_EXIST: references`). Leave the bracket alone
      // and emit a targeted warning for the user to translate by hand.
      if (isInsideRegion(offset, nonSmartscapeRegions)) {
        warnings.push({
          kind: 'entity-relationship-traversal',
          text:
            `${full} appears inside a \`lookup [fetch dt.entity.<not-planned-type>]\` subquery. ` +
            `references[…] only works on Smartscape sources, so leaving the bracket alone. ` +
            `NOTE: this whole lookup chain (and any downstream \`<prefix>.<field>\` accesses in the ` +
            `outer pipeline) is a classic-only pattern that cannot be auto-translated — it needs ` +
            `manual redesign, typically by replacing the lookup with a direct \`smartscapeNodes ` +
            `<TYPE>\` join.`,
          reference: SKILL_REFS.relationships,
          match: full,
        });
        return full;
      }

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
  }
  );
}

// ─── Pass 2.5: entityName / entityAttr → getNodeName / getNodeField ───────

function rewriteEntityNameAttr(input: string, transforms: Transform[]): string {
  // entityAttr(x, "field") → getNodeField(x, "field"). Must run before
  // entityName replacement so we don't accidentally match Attr's "Name" prefix.
  let rewritten = input.replace(
    /\bentityAttr\(\s*([^,)]+?)\s*,\s*("[^"]+")\s*\)/g,
    (full, arg: string, field: string) => {
      // Classic "tags" maps to the provider-namespaced "tags:aws" record on the
      // new side (verified on tenant — getNodeField(x,"tags") also returns a
      // record, but "tags:aws" is the AWS-scoped, KB-recommended form, and is
      // what Pass 2.55 reads by key). Other fields pass through unchanged.
      const newField = field === '"tags"' ? '"tags:aws"' : field;
      const detail =
        field === '"tags"'
          ? 'entityAttr(x, "tags") → getNodeField(x, "tags:aws") (AWS tag record)'
          : 'entityAttr(x, "f") → getNodeField(x, "f")';
      transforms.push({ kind: 'entity-dim', before: full, after: `getNodeField(${arg}, ${newField})`, detail });
      return `getNodeField(${arg}, ${newField})`;
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

// ─── Pass 2.55: classic tag value-extraction idiom → direct record read ───
//
// The dominant classic AWS tag-read idiom string-parses the serialized tags to
// pull one tag's value:
//   splitString(splitString(toString(<src>), "[AWS]<Key>:")[1], "\"")[0]
// where <src> holds the tags — either a fieldsAdd var or, after Pass 2.5, an
// inline getNodeField(x,"tags:aws") (a RECORD). The `[AWS]` prefix is optional
// (some dashboards split on a bare "<Key>:"). The string-parse silently yields
// empty against the new record shape, so collapse the whole expression to a
// direct key read: <src>[<Key>]. Case is preserved from the classic key, which
// matches the AWS tag key on the record.
const TAG_EXTRACT_RE =
  /splitString\(\s*splitString\(\s*toString\(\s*((?:[A-Za-z_]\w*)|(?:getNodeField\([^)]*\)))\s*\)\s*,\s*"(?:\[AWS\])?([^:"\]]+):"\s*\)\s*\[\s*1\s*\]\s*,\s*"\\?""\s*\)\s*\[\s*0\s*\]/g;

function rewriteTagExtraction(input: string, transforms: Transform[]): string {
  return input.replace(TAG_EXTRACT_RE, (full, varName: string, key: string) => {
    const repl = `${varName}[${key}]`;
    transforms.push({
      kind: 'entity-dim',
      before: full,
      after: repl,
      detail: `classic tag string-parse → record read ${repl} (tags:aws by key)`,
    });
    return repl;
  });
}
