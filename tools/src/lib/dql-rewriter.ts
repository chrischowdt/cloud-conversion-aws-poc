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
import type { MzTagIndex } from './mz-tags.ts';
import { enrichedTagDimension } from './enriched-tags.ts';
import { translateSelector, translateSelectorClassic } from './classic-selector-translator.ts';
import { lookupInDac, cloudwatchStatisticForNewKey, isAdditiveSumMetric } from './dac-lookup.ts';
import { ENTITY_FIELD_MAPPINGS_BY_NODE_TYPE } from './entity-field-mappings.ts';
import { classicEntityToSmartscape, lookupByDimRef, entityScope } from './entity-mappings.ts';
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
  kind: 'metric-key' | 'entity-dim' | 'recipe-applied' | 'composite-formula' | 'classic-selector' | 'aggregation-corrected';
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
    | 'classic-selector-note'
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
    | 'dim-not-carried'
    | 'aggregation-mismatch'
    | 'non-aws-entity'
    | 'end-of-life-service';
  text: string;
  /** Pointer to the relevant dt-migration reference (if any). */
  reference?: string;
  /** The matched substring. */
  match?: string;
}

/**
 * Warning kinds that mean "couldn't produce correct DQL" — the panel has no
 * new-connection equivalent or needs manual work. Every OTHER warning kind is
 * an advisory/verify-me caveat on output that DOES run (the conversion
 * happened: metric swapped, entity disambiguated, account joined, recipe
 * applied). scan-dashboards uses this to report `converted (clean + soft)` vs
 * `blocked` instead of conflating both under "not clean".
 */
export const BLOCKING_WARNING_KINDS: ReadonlySet<Warning['kind']> = new Set([
  'unmapped-entity-type',
  'unknown-metric',
  'metric-streams-blocked',
  'composite-formula-needed',
  'classic-entity-selector',
  'entity-relationship-traversal',
  'classic-id-literal',
]);

/** True when a warning means the query can't be auto-converted (vs a verify-me caveat). */
export function isBlockingWarning(kind: Warning['kind']): boolean {
  return BLOCKING_WARNING_KINDS.has(kind);
}

/**
 * Record that a non-AWS entity (APM/infra/K8s/Azure) was left UNTOUCHED. Emitted
 * once per distinct type. Non-blocking: leaving it classic is the correct
 * outcome for an AWS-only migration, not a failure — these entities migrate
 * with the general classic→Grail tooling and are not decommissioned by the
 * cloud-integration migration.
 */
function noteNonAwsEntity(warnings: Warning[], entityType: string): void {
  const match = `dt.entity.${entityType}`;
  if (warnings.some((w) => w.kind === 'non-aws-entity' && w.match === match)) return;
  warnings.push({
    kind: 'non-aws-entity',
    text:
      `${match} is a non-AWS entity (APM / infrastructure / Kubernetes / Azure) — left unchanged. ` +
      `It's out of scope for the AWS cloud-integration migration and isn't decommissioned by it; ` +
      `migrate it with the general classic→Grail tooling.`,
    match,
  });
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
  // `count` counts non-null occurrences, not "the recipe's aggregation of
  // metric". `percentile`/`median` take their OWN positional parameters, so
  // swapping the function while keeping those args yields invalid DQL
  // (`avg(metric, 95)`). Preserve user intent for all three.
  const preserveUserAgg = userAgg === 'count' || userAgg === 'percentile' || userAgg === 'median';
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

  // Pass 0.7: the credential→account-id LOOKUP-JOIN idiom — the resource is on
  // the main stream and a `lookup [fetch dt.entity.aws_credentials … awsAccountId]`
  // pulls the account id onto each row. Smartscape carries `aws.account.id` on
  // the resource node directly, so the whole extract+lookup scaffold collapses
  // to that field (custom_device → smartscapeNodes is handled by Pass 1.55).
  input = rewriteCredentialAccountLookup(input, transforms, warnings);

  // Pass 0.8: the metric-LESS custom_device list idiom (dashboard variables /
  // region pickers). With no metric key there's no service to disambiguate
  // custom_device to one node type, so query ALL AWS nodes via smartscapeNodes
  // "AWS*" and read tags/region as native fields.
  input = rewriteCustomDeviceTopologyList(input, transforms, warnings);

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
    (full: string, userAgg: string, classicKey: string, trailing: string, offset: number) => {
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
        // Counter aggregation: the DAC records each new metric's CloudWatch
        // statistic. A `Sum` metric (additive counter) aggregated with
        // avg()/max() under-reports — often by 100s× — because the classic
        // metric was a rolled-up interval count while the new key is a raw Sum
        // series. For metrics that are unambiguously additive counters
        // (requests, invocations, errors, bytes, ops, consumed capacity) we
        // auto-correct the aggregation to sum(). For the gauge-like exceptions
        // the DAC also labels `Sum` (concurrency, provisioned capacity, host
        // counts, status checks) avg() is correct — leave those and just warn.
        // Only the plain `agg(key)` form is auto-flipped; the
        // `agg(key, filter:…)` form is left as-is and warned.
        let effAgg = userAgg;
        if (index.dac && userAgg !== 'sum' && userAgg !== 'count') {
          const stat = cloudwatchStatisticForNewKey(index.dac, newKey);
          if (stat === 'Sum') {
            if (trailing === ')' && isAdditiveSumMetric(newKey)) {
              effAgg = 'sum';
            } else {
              warnings.push({
                kind: 'aggregation-mismatch',
                text:
                  `${newKey} is a CloudWatch Sum-statistic metric, but this tile aggregates with ` +
                  `${userAgg}(). For an additive counter ${userAgg}() under-reports — use sum(). If it's ` +
                  `a level/gauge (concurrent executions, provisioned capacity, host count), ${userAgg}() ` +
                  `is correct — leave as is. Verify against the classic side.`,
                match: classicKey,
              });
            }
          }
        }
        const aggCorrected = effAgg !== userAgg;
        const swapOnly = trailing === ','
          ? `${userAgg}(\`${newKey}\`,`
          : `${effAgg}(\`${newKey}\`)`;
        // Record the auto-generated column-name swap so Pass 1.4 can fix
        // downstream backtick refs (only for the plain `agg(key)` form, not
        // the `agg(key, filter:…)` form which isn't a column name). The KEY is
        // the ORIGINAL `userAgg(classicKey)` column name; the VALUE carries the
        // (possibly flipped) effective aggregation so refs realign correctly.
        if (trailing === ')') {
          metricKeySwaps.set(`${userAgg}(${classicKey})`, `${effAgg}(${newKey})`);
        }
        transforms.push({
          kind: aggCorrected ? 'aggregation-corrected' : 'metric-key',
          before: `${userAgg}(${classicKey}${trailing === ',' ? ',' : ')'}`,
          after: swapOnly,
          detail: aggCorrected
            ? `aggregation auto-corrected ${userAgg}()→sum() — ${newKey} is a CloudWatch Sum-statistic additive counter`
            : 'metric-only swap (no verified recipe — agg preserved as user wrote it)',
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
        // Only swap the aggregation FUNCTION when the trailing args are a named
        // `filter:{…}` block (which composes with any aggregation). Positional
        // args belong to the user's own function — `percentile(m, 95)` becoming
        // `avg(m, 95)` is invalid DQL. Reviewers hit exactly this on EZE/EA EKS
        // ("converting percentile() to avg() but keeping the percentile
        // parameters, breaking the query").
        const restArgs = input.slice(offset + full.length);
        const argsAreNamedFilter = /^\s*filter\s*:/.test(restArgs);
        const aggForArgs = argsAreNamedFilter ? recipe.newAggregation : userAgg;
        if (!argsAreNamedFilter && recipe.newAggregation !== userAgg) {
          warnings.push({
            kind: 'recipe-aggregation-mismatch',
            text:
              `Recipe maps ${userAgg}() → ${recipe.newAggregation}() for ${classicKey}, but this call passes ` +
              `positional arguments that belong to ${userAgg}() — the aggregation was PRESERVED to keep the ` +
              `query valid. Verify the values against the classic side.`,
            match: classicKey,
          });
        }
        const swapOnly = `${aggForArgs}(\`${newKey}\`,`;
        transforms.push({
          kind: 'metric-key',
          before: `${userAgg}(${classicKey},`,
          after: swapOnly,
          detail: `metric-only swap (${argsAreNamedFilter ? 'filter args' : 'positional args — agg preserved'}); recipe ${recipe.classicAggregation}/${recipe.newAggregation}`,
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
  // The mzName() → enriched-tag rewrite produces a filter on `aws.tags.*`, which
  // are dimensions of the NEW connection's metrics. If Pass 1 could not map this
  // query's metric key, the query still reads a CLASSIC metric — and a classic
  // metric carries no `aws.tags.*` dimension, so the filter would match nothing
  // and silently collapse the alert's scope to zero. (Verified: the classic
  // kafka key returns data unfiltered and nothing with the tag filter applied.)
  // Withhold the zone index in that case so mzName() stays untranslated and the
  // panel keeps blocking, which is the honest outcome.
  const metricUnmapped = warnings.some((w) => w.kind === 'unknown-metric' || w.kind === 'metric-streams-blocked');
  rewritten = rewriteClassicSelectorIns(
    rewritten,
    transforms,
    warnings,
    metricUnmapped ? undefined : index.mzTags
  );

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
    // Only rewrite AWS entities. Non-AWS (APM/infra/K8s/Azure) are left classic.
    if (entityScope(entityType) === 'non-aws') {
      noteNonAwsEntity(warnings, entityType);
      return full;
    }
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

  // Pass 2.56: region-derivation (customProperties[REGION*]) → aws.region field.
  rewritten = rewriteAwsRegionField(rewritten, transforms);

  // Pass 2.58: ARN-split (splitString(arn, ":")[3|4]) → aws.region / aws.account.id.
  rewritten = rewriteArnRegion(rewritten, transforms);

  // Pass 2.59: generic field renames (arn → aws.arn, awsVpcName → aws.vpc.id).
  // AFTER the ARN-split pass, which still needs the "arn" field.
  rewritten = rewriteAwsFieldRenames(rewritten, transforms);

  // Pass 2.56b: dt.smartscape.X.tags field-access → getNodeField(X,"tags:aws").
  // BEFORE the tag-filter pass so it can rewrite filters around the result.
  rewritten = rewriteDimTags(rewritten, transforms);

  // Pass 2.57: classic AWS tag FILTER idiom (in(tags,"[AWS]Key:val")) → tags[Key] == val.
  rewritten = rewriteAwsTagFilters(rewritten, transforms);

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

  // Pass 2.6b: <dt.smartscape.X>.entity.name → getNodeName(X) (any context, not
  // just restructured fetches — dominant in by-grouped timeseries tiles).
  rewritten = rewriteDimEntityName(rewritten, transforms);

  // Pass 2.72: dangling dt.smartscape.aws_account column → account.name (from
  // the credential collapse). Runs after the dim swap that created the dangler.
  rewritten = rewriteLeftoverAccountColumn(rewritten, transforms);

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
        // Negative lookbehind `(?<![$\w."])` skips `$rdsEngine` (variable ref),
        // `lookup.rdsEngine`-style accesses where the leading char is a dot —
        // those would produce an ambiguous parse after rename — and QUOTED
        // names. A quoted occurrence is a `getNodeField(x, "field")` argument,
        // where the backtick wrapping below would land INSIDE the string and
        // produce `"` + "`aws.resource.id`" + `"`; renameNodeFieldArgs handles
        // that form properly.
        const re = new RegExp(`(?<![$\\w."])${m.classicField}\\b(?!")`, 'g');
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
        // Not blocking: the DQL runs and the metric data flows — only the
        // grouping degrades (collapses to one null bucket). The fix is a
        // mechanical by-clause dim swap, so this is a verify-me caveat, not a
        // "can't convert". (Most former non-carriers now carry their dim — see
        // metric-dim-carriers.ts re-probe — so this fires rarely.)
        kind: 'dim-not-carried',
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

  // A classicEntitySelector we DELIBERATELY left classic because its subject is
  // a non-AWS entity is out of scope, not a blocker — Pass 1.5 already recorded
  // a non-blocking `non-aws-entity` note for it. Flagging it here too would mark
  // an AWS dashboard blocked for a tile the AWS migration never owned.
  const outOfScopeSelector = (text: string, idx: number): boolean => {
    const before = text.slice(Math.max(0, idx - 120), idx);
    const m = new RegExp('\\bin\\(\\s*`?dt\\.entity\\.([\\w:]+)`?\\s*,\\s*$').exec(before);
    return !!m && entityScope(m[1]!) !== 'aws';
  };

  for (const fp of flagPatterns) {
    fp.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = fp.re.exec(rewritten)) !== null) {
      if (fp.kind === 'classic-entity-selector' && outOfScopeSelector(rewritten, m.index)) continue;
      warnings.push({ kind: fp.kind, text: fp.text, reference: fp.reference, match: m[0] });
    }
  }

  // Late cleanup: cast smartscape ID dims used in `in(...)` filters to string,
  // name any bare getNodeName/getNodeField fieldsAdd operand (a classic bare
  // dim-field ref that auto-named its column), then drop duplicate columns/dims a
  // collapse may have produced in a fields/by:{} clause.
  rewritten = dropCustomDeviceGroup(rewritten, transforms);
  rewritten = renameNodeFieldArgs(rewritten, transforms);
  rewritten = useEnrichedTagDims(rewritten, index, transforms, warnings);
  warnObjectOnlyAttributes(rewritten, warnings);
  rewritten = pruneByDimsNotOnKey(rewritten, transforms, warnings);
  warnDeadMetricVariant(rewritten, index, warnings);
  rewritten = rewriteSmartscapeIdFilter(rewritten, transforms);
  rewritten = nameBareEntityOperands(rewritten, transforms);
  rewritten = dedupeFieldsClauses(rewritten, transforms);
  rewritten = dedupeByClauses(rewritten, transforms);

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
  warnings: Warning[],
  mzTags?: MzTagIndex
): string {
  // custom_device isn't in the entity-type table (it's "not planned"), but the
  // query's metric service disambiguates it to a real node type — the same
  // bridge Pass 1.55 uses for `by:{}`/`fetch`. Resolve it up front so the
  // dominant anomaly-detector shape
  // `in(dt.entity.custom_device, classicEntitySelector("type(custom_device),tag(...)"))`
  // translates instead of bailing on the unmapped custom_device dim.
  const cdService = serviceFromClassicKeyInQuery(input);
  const cdNodeType = cdService ? nodeTypeForMetricService(cdService) : undefined;
  const customDeviceDim = cdNodeType ? smartscapeDimForNodeType(cdNodeType) : undefined;

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

    // DIM-INDEPENDENT SHORT-CIRCUIT. Some predicates translate to filters on the
    // METRIC's own dimensions rather than on the entity — notably `mzName(...)`,
    // which becomes an enriched-tag filter (`aws.tags.<key>`). When a selector
    // reduces ENTIRELY to those, the outer `in(<dim>, …)` wrapper is irrelevant:
    // the filter selects the right series no matter which entity dim it was
    // hung off. That matters because the grouping dims these selectors use
    // (`custom_device_group`) have no Smartscape node at all, so the dim-based
    // path below would bail and block an otherwise perfectly convertible query.
    const dimFreeAst = safeParseSelector(selectorStr);
    if (dimFreeAst) {
      const t = translateSelector(dimFreeAst, cleanDim, { defaultTagContext: 'aws', mzTags });
      if (t.filter && t.complete && !t.filter.includes('getNodeField(')) {
        transforms.push({
          kind: 'classic-selector',
          before: fullMatch,
          after: t.filter,
          detail: 'selector reduced to native metric-dimension filters — outer entity dim not needed',
        });
        for (const note of t.notes) {
          warnings.push({ kind: 'classic-selector-note', text: note, reference: SKILL_REFS.massData });
        }
        result.push(t.filter);
        i += fullMatch.length;
        continue;
      }
    }

    if (cleanDim.startsWith('dt.entity.')) {
      const entityType = cleanDim.slice('dt.entity.'.length);
      // AWS-only scope. `dt.entity.service` / `host` / k8s / Azure are APM or
      // general-migration entities: converting their classicEntitySelector
      // filter produces a Smartscape query the tile never asked for and breaks
      // it. Reviewers repeatedly reverted these ("many non-AWS tiles converted
      // that needed to be reverted" — CUX Metrics, EA EKS, EDJ-Partner
      // Management). Leave them classic with a non-blocking note, exactly as
      // Pass 2's dim sweep already does.
      // Non-AWS entity (APM service, host, …). We still remove the
      // classicEntitySelector — nothing should depend on the classic selector
      // engine — but we translate against the CLASSIC dimension rather than a
      // Smartscape one. The SERVICE node carries no tags at all, so the
      // Smartscape route that works for AWS silently matches nothing here.
      // See translateSelectorClassic for the tenant-verified equivalences.
      if (entityScope(entityType) === 'non-aws') {
        const ast = safeParseSelector(selectorStr);
        const t = ast ? translateSelectorClassic(ast, cleanDim) : null;
        if (t && t.filter && t.complete) {
          transforms.push({
            kind: 'classic-selector',
            before: fullMatch,
            after: t.filter,
            detail: `non-AWS entity — translated against the classic dimension (${cleanDim}), no classicEntitySelector`,
          });
          for (const note of t.notes) {
            warnings.push({ kind: 'classic-selector-note', text: note, reference: SKILL_REFS.massData });
          }
          result.push(t.filter);
          i += fullMatch.length;
          continue;
        }
        // Couldn't translate every predicate — leaving a HALF-converted filter
        // would change what the tile matches, so keep it intact and say why.
        noteNonAwsEntity(warnings, entityType);
        for (const note of t?.notes ?? []) {
          warnings.push({ kind: 'classic-entity-selector', text: note, reference: SKILL_REFS.massData });
        }
        result.push(fullMatch);
        i += fullMatch.length;
        continue;
      }
      const mapping = classicEntityToSmartscape(entityType);
      let resolvedDim = mapping?.smartscapeDimension;
      // custom_device has no entity-table mapping; fall back to the metric-
      // service disambiguation resolved above.
      if (!resolvedDim && entityType === 'custom_device' && customDeviceDim) {
        resolvedDim = customDeviceDim;
        if (cdService && isMultiNodeService(cdService)) {
          warnings.push({
            kind: 'custom-device-disambiguated',
            text:
              `classicEntitySelector on custom_device resolved to ${cdNodeType} via service "${cdService}", ` +
              `but that service emits metrics under >1 node type (${MULTI_NODE_SERVICES[cdService]!.join(', ')}). ` +
              `Verify the filter targets the intended grain.`,
          });
        }
      }
      if (!resolvedDim) {
        warnings.push({
          kind: 'unmapped-entity-type',
          text: `classicEntitySelector wraps an unmapped entity type ${cleanDim}; left unchanged.`,
          match: fullMatch,
        });
        result.push(fullMatch);
        i += fullMatch.length;
        continue;
      }
      smartscapeDim = resolvedDim;
    }

    // Parse + translate.
    const ast = parseSelector(unescapeDqlString(selectorStr));
    const translation = translateSelector(ast, smartscapeDim, { defaultTagContext: 'aws', mzTags });

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
    // A COMPLETE translation (every predicate produced a clause) means the
    // filter is correct and its notes are advisory (e.g. assumed tag context) —
    // emit them non-blocking. An INCOMPLETE one dropped a predicate, so the
    // filter is wrong; keep those notes blocking so the asset is flagged.
    const noteKind: Warning['kind'] = translation.complete ? 'classic-selector-note' : 'classic-entity-selector';
    for (const note of translation.notes) {
      warnings.push({
        kind: noteKind,
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

/**
 * Add `aws.account.name` to each resource by-clause (one grouping custom_device),
 * so the native account-name dimension is available without a lookup. Returns
 * ok=false when there's no such by-clause to inject into (caller falls back).
 * The native dim equals the AWS_ACCOUNT node name (tenant-verified on nic55601).
 */
function injectAccountNameDim(input: string): { text: string; ok: boolean } {
  let ok = false;
  const text = input.replace(/\bby\s*:\s*\{([^}]*)\}/g, (full, body: string) => {
    if (!/custom_device/.test(body)) return full; // only the resource's grouping
    ok = true;
    if (/\baws\.account\.name\b/.test(body)) return full; // already present
    return `by:{${body.trim()}, aws.account.name}`;
  });
  return { text, ok };
}

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

  // Preferred: the native `aws.account.name` dimension (== AWS_ACCOUNT node name,
  // tenant-verified) — split the resource's by-clause on it, no lookups. Falls
  // back to the AWS_ACCOUNT join if the by-clause can't take the dim.
  const inj = injectAccountNameDim(input);
  CREDENTIAL_FIELDSADD_RE.lastIndex = 0;
  let out: string;
  if (inj.ok) {
    out = inj.text.replace(
      CREDENTIAL_FIELDSADD_RE,
      (_full, acctVar: string, lowerOpen: string | undefined, lowerClose: string | undefined) =>
        `| fieldsAdd ${acctVar} = ${lowerOpen ?? ''}aws.account.name${lowerClose ?? ''}`
    );
    transforms.push({
      kind: 'entity-dim',
      before: 'fieldsAdd dt.entity.aws_credentials = entityAttr(custom_device,"accessible_by")[…] → entityName(…)',
      after: `by:{…, aws.account.name} → ${'lower(aws.account.name)'} (native account dimension, no lookups)`,
      detail: `credential field-read collapsed to the native aws.account.name dim; custom_device → ${nodeType} via service "${service}"`,
    });
  } else {
    out = input.replace(
      CREDENTIAL_FIELDSADD_RE,
      (_full, acctVar: string, lowerOpen: string | undefined, lowerClose: string | undefined) =>
        `| lookup [smartscapeNodes ${nodeType} | fields name, id, aws.account.id], ` +
        `sourceField:${dim}, lookupField:id, prefix:"device."\n` +
        `| lookup [smartscapeNodes AWS_ACCOUNT | fields name, aws.account.id], ` +
        `sourceField:device.aws.account.id, lookupField:aws.account.id, prefix:"account."\n` +
        `| fieldsAdd ${acctVar} = ${lowerOpen ?? ''}account.name${lowerClose ?? ''}`
    );
    transforms.push({
      kind: 'entity-dim',
      before: 'fieldsAdd dt.entity.aws_credentials = entityAttr(custom_device,"accessible_by")[…] → entityName(…)',
      after: `lookup [smartscapeNodes ${nodeType} … aws.account.id] → lookup [smartscapeNodes AWS_ACCOUNT …] → account.name`,
      detail: `credential field-read collapsed; custom_device disambiguated to ${nodeType} via metric service "${service}"`,
    });
  }
  // Align remaining custom_device refs (by-clause, entityAttr(…,"arn"), etc.).
  out = out.replace(/`?dt\.entity\.custom_device`?/g, dim);
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

// Pass 0.7 — the credential→account-id LOOKUP-JOIN idiom (distinct from Pass
// 0.5's nested-lookup chain and 0.6's entityName field-read). The dominant
// blocked shape on the corpus: the resource is on the main stream and a single
// lookup into dt.entity.aws_credentials pulls `awsAccountId` per row:
//   | fieldsAdd <cred>=accessible_by[dt.entity.aws_credentials][0], …
//   | lookup [fetch dt.entity.aws_credentials | fieldsadd …, awsAccountId],
//       sourceField:<cred>, lookupField:id, prefix:"P."
//   | fieldsRename <x> = P.awsAccountId
// In Smartscape the account is a denormalized `aws.account.id` field on the
// resource node, so the whole extract+lookup scaffold collapses to that field.
// Conservative by construction: applies the removal, then REVERTS unless the
// result is a clean full collapse (no credential remnant, no dangling prefixed
// field) — so variant shapes fall through to the generic warning rather than
// emit a half-rewritten (broken) query.
const CRED_ACCOUNT_LOOKUP_RE =
  /\|\s*lookup\s*\[\s*fetch\s+`?dt\.entity\.aws_credentials`?\b[^\]]*\]\s*,\s*sourceField\s*:\s*`?(\w+)`?\s*,\s*lookupField\s*:\s*id\b\s*(?:,\s*prefix\s*:\s*"([^"]*)")?/;
const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `<cred> = (arrayFirst()? accessible_by[dt.entity.aws_credentials][0])`
const CRED_VAL =
  '(?:arrayFirst\\(\\s*)?accessible_by\\[\\s*`?dt\\.entity\\.aws_credentials`?\\s*\\](?:\\s*\\[\\s*0\\s*\\])?\\s*\\)?';

function dropCredAssignment(s: string, credField: string): string {
  const f = reEsc(credField);
  const variants = [
    new RegExp(`\\s*,\\s*${f}\\s*=\\s*${CRED_VAL}`), // ", cred = …"
    new RegExp(`${f}\\s*=\\s*${CRED_VAL}\\s*,\\s*`), // "cred = …, "
    new RegExp(`\\|\\s*fieldsAdd\\s+${f}\\s*=\\s*${CRED_VAL}\\s*(?=\\||$)`), // sole fieldsAdd
  ];
  for (const r of variants) if (r.test(s)) return s.replace(r, '');
  return s;
}

function rewriteCredentialAccountLookup(
  input: string,
  transforms: Transform[],
  warnings: Warning[]
): string {
  const m = CRED_ACCOUNT_LOOKUP_RE.exec(input);
  if (!m) return input;
  const credField = m[1]!;
  const prefix = m[2] ?? '';
  const lookupBlock = m[0];

  // Must be the accessible_by-sourced credential id we understand.
  if (!new RegExp(`\\b${reEsc(credField)}\\s*=\\s*${CRED_VAL}`).test(input)) return input;

  let out = input.replace(lookupBlock, '');
  out = dropCredAssignment(out, credField);
  if (prefix) out = out.split(`${prefix}awsAccountId`).join('aws.account.id');

  // Commit only on a clean, complete collapse — otherwise no-op (a variant we
  // didn't fully handle stays for the generic warning, never half-rewritten).
  const remnant =
    /accessible_by\[\s*`?dt\.entity\.aws_credentials/.test(out) ||
    /\bdt\.entity\.aws_credentials\b/.test(out) ||
    (prefix !== '' && new RegExp(`${reEsc(prefix)}\\w`).test(out)) ||
    new RegExp(`(?<![.\\w])${reEsc(credField)}\\b`).test(out);
  if (remnant) return input;

  transforms.push({
    kind: 'entity-dim',
    before: 'fieldsAdd <cred>=accessible_by[aws_credentials][0] | lookup [fetch dt.entity.aws_credentials … awsAccountId]',
    after: 'aws.account.id (denormalized on the resource node)',
    detail: 'credential→account-id lookup collapsed; Smartscape carries aws.account.id directly on the resource',
  });
  warnings.push({
    kind: 'credential-collapsed',
    text:
      `Collapsed a classic credential→account-id lookup (\`lookup [fetch dt.entity.aws_credentials … ` +
      `awsAccountId]\`) to the resource node's denormalized \`aws.account.id\`. A single AWS account can ` +
      `have multiple classic credentials but one Smartscape AWS_ACCOUNT — verify intent for ` +
      `multi-credential accounts, and that the account id still lands on the grouped/renamed column.`,
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
// Pass 0.8 — metric-less custom_device list/topology idiom (dashboard variables).
// `fetch dt.entity.custom_device | <[AWS] tag / customProperties filters> |
// summarize <v> = collectArray(id)` (or `| fields region`). No metric key → no
// service to disambiguate custom_device, so the fetch pass leaves it classic and
// the variable silently returns nothing. Reviewer-confirmed rebuild: query ALL
// AWS nodes via `smartscapeNodes "AWS*"` and read tags/region as native fields.
// ~23 dashboards on the corpus use this shape for their $custom_device_ids /
// $region variables. Scoped to metric-less, [AWS]-tagged custom_device lists.
function rewriteCustomDeviceTopologyList(
  input: string,
  transforms: Transform[],
  warnings: Warning[]
): string {
  if (!/\bfetch\s+`?dt\.entity\.custom_device`?/.test(input)) return input;
  if (/(?:dt\.|builtin:|ext:)?cloud\.aws\.[a-z0-9_]+\./.test(input)) return input; // metric query → other passes
  if (!/\[AWS\]|customProperties/.test(input)) return input; // not clearly an AWS resource list

  let out = input.replace(/\bfetch\s+`?dt\.entity\.custom_device`?/g, 'smartscapeNodes "AWS*"');
  // tag string-match filters → tags:aws record-key filter:
  //   (matchesValue|in)(tags, concat("[AWS]<Key>:", <expr>)) → in(`tags:aws`[<Key>], array(<expr>))
  out = out.replace(
    /\b(?:matchesValue|in)\(\s*tags\s*,\s*concat\(\s*"\[AWS\]([^:"]+):"\s*,\s*([^()]+?)\)\s*\)/g,
    (_full, key: string, expr: string) => `in(\`tags:aws\`[${key.trim()}], array(${expr.trim()}))`
  );
  // customProperties[REGION*] (bare) → the native aws.region field.
  out = out.replace(/\bcustomProperties\s*\[\s*[A-Za-z_]*REGION[A-Za-z_]*\s*\]/g, 'aws.region');
  // resource-name accessors → the native `name` field.
  out = out.replace(/\bentityName\(\s*`?dt\.entity\.custom_device`?\s*\)/g, 'name');
  out = out.replace(/`?dt\.entity\.custom_device`?\.name\b/g, 'name');

  if (out === input) return input;
  transforms.push({
    kind: 'entity-dim',
    before: 'fetch dt.entity.custom_device (metric-less list)',
    after: 'smartscapeNodes "AWS*" + tags:aws / aws.region',
    detail: 'custom_device topology-list idiom → smartscapeNodes "AWS*" (no metric to disambiguate a single node type)',
  });
  if (/dt\.entity\.custom_device/.test(out)) {
    warnings.push({
      kind: 'entity-relationship-traversal',
      text: 'Converted a custom_device topology-list to smartscapeNodes "AWS*"; verify any remaining dt.entity.custom_device references by hand.',
      reference: SKILL_REFS.specialCases,
    });
  }
  return out;
}

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
    // Only restructure AWS entities. Non-AWS `fetch dt.entity.X` stays classic.
    if (entityScope(entityType) === 'non-aws') {
      noteNonAwsEntity(warnings, entityType);
      return full;
    }
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

    // Relationships to a non-AWS target (K8s cloud_application, kubernetes_*,
    // process_group, host, …) are left classic — those belong to the general
    // migration, not this AWS automation.
    if (entityScope(targetClassicType) === 'non-aws') {
      noteNonAwsEntity(warnings, targetClassicType);
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

/**
 * True when the operand still names a classic `dt.entity.<type>` that is NOT an
 * in-scope AWS entity. By the time the entityName/entityAttr pass runs, Pass 2
 * has already rewritten every in-scope AWS entity to `dt.smartscape.<type>` —
 * so anything still written `dt.entity.…` is either an explicitly non-AWS
 * entity (APM/K8s/Azure) or an extension/custom type with no Smartscape node at
 * all (`ibmmq:local_queue`, `custom:solace_node`, `storage:dell_powermax`,
 * `sql:postgres_host`). Converting those to getNodeName/getNodeField produces a
 * query against a node type that does not exist. Reviewers reverted exactly
 * these ("conversion broke many non-aws queries" — EDJ-Partner Management).
 */
function argRefsNonAwsEntity(arg: string): boolean {
  const m = new RegExp('dt\\.entity\\.([\\w:]+)').exec(arg);
  return !!m && entityScope(m[1]!) !== 'aws';
}

function rewriteEntityNameAttr(input: string, transforms: Transform[]): string {
  // entityAttr(x, "field") → getNodeField(x, "field"). Must run before
  // entityName replacement so we don't accidentally match Attr's "Name" prefix.
  let rewritten = input.replace(
    /\bentityAttr\(\s*([^,)]+?)\s*,\s*("[^"]+")\s*\)/g,
    (full, arg: string, field: string) => {
      // Leave entityAttr on a non-AWS entity classic (matches the untouched entity).
      if (argRefsNonAwsEntity(arg)) return full;
      // The node NAME is not a readable field on Smartscape — it's a function.
      // entityAttr(x, "entity.name" | "name") → getNodeName(x). (Reviewers hit
      // `getNodeField(x,"entity.name")` failing; the name comes from getNodeName.)
      if (field === '"entity.name"' || field === '"name"') {
        const repl = `getNodeName(${arg})`;
        transforms.push({ kind: 'entity-dim', before: full, after: repl, detail: `entityAttr(x, ${field}) → getNodeName(x)` });
        return repl;
      }
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
    /\bentityName\(\s*([^,)]+?)(?:\s*,\s*type:\s*"([^"]+)")?\s*\)/g,
    (full, arg: string, typeRef: string | undefined) => {
      // Leave classic when the entity is non-AWS (named via `type:` or the arg).
      if ((typeRef && entityScope(typeRef) === 'non-aws') || argRefsNonAwsEntity(arg)) return full;
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
  /splitString\(\s*splitString\(\s*toString\(\s*((?:[A-Za-z_]\w*)|(?:getNodeField\([^)]*\)))\s*\)\s*,\s*"(\[AWS\])?([^:"\]]+):"\s*\)\s*\[\s*1\s*\]\s*,\s*"\\?""\s*\)\s*\[\s*0\s*\]/g;

function rewriteTagExtraction(input: string, transforms: Transform[]): string {
  // AWS-ONLY. The classic split idiom is how you read a tag off ANY classic
  // entity (service, host, span…), where `tags` is a string array — there the
  // idiom is correct and must stay. Only the AWS side became a `tags:aws`
  // RECORD that supports `tags[key]`. Rewriting a span/service tag read broke
  // tiles for reviewers ("no need to modify the tags query for spans, it broke
  // the data" — EHL Offer Engine; "tiles grabbed tags but then kept regular
  // filters against tags" — FBS Monitoring Overview).
  //
  // A source is AWS when it IS a smartscape node field read, or when it is a
  // variable assigned from one. Earlier passes have already converted AWS
  // entity reads to getNodeField(dt.smartscape.…); non-AWS ones still read
  // entityAttr(dt.entity.…), so this test cleanly separates them.
  const awsVars = new Set<string>();
  const assignRe = new RegExp('\\b([A-Za-z_]\\w*)\\s*=\\s*[^=]*?getNodeField\\(\\s*`?dt\\.smartscape\\.', 'g');
  for (let m = assignRe.exec(input); m; m = assignRe.exec(input)) awsVars.add(m[1]!);

  return input.replace(TAG_EXTRACT_RE, (full, varName: string, awsPrefix: string | undefined, key: string) => {
    const isDirectNodeRead = varName.startsWith('getNodeField');
    // The literal [AWS] prefix is itself an unambiguous AWS tag marker;
    // classic span/service tag reads carry no prefix (plain "applicationci:").
    if (!isDirectNodeRead && !awsVars.has(varName) && !awsPrefix) return full;
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

// ─── Pass 2.56: region-derivation idiom → the aws.region field ────────────
//
// Every AWS Smartscape node carries `aws.region`. Classic dashboards derived the
// region indirectly — most commonly from the custom-device custom properties:
//   entityAttr(x, "customProperties")[REGION_NAME]   (Pass 2.5 → getNodeField(x,"customProperties")[REGION_NAME])
// which returns null on the new side. Collapse any such customProperties region
// read to a direct `getNodeField(x, "aws.region")`. (Verified in reviewer fixes
// on DWR/FBS/EIF: "we can simply use aws.region … on new AWS metrics".)
const CUSTOM_PROP_REGION_RE =
  /getNodeField\(\s*([^,()]+?)\s*,\s*"customProperties"\s*\)\s*\[\s*([A-Za-z_]*REGION[A-Za-z_]*)\s*\]/gi;
// A lookup-prefixed customProperties region read: `device.customProperties[REGION_NAME]`.
// The `device.` prefix comes from a `lookup […], sourceField:<node>, …, prefix:"device."`,
// so the node's region is getNodeField(<node>, "aws.region"). customProperties isn't
// selected by the lookup (so it reads null) — repoint to the node's aws.region.
const LOOKUP_PREFIX_RE =
  /lookup\s*\[[^\]]*\]\s*,\s*sourceField\s*:\s*([^\s,]+)\s*,[^|]*?prefix\s*:\s*"([^".]+)\."/g;
const PREFIX_PROP_REGION_RE =
  /\b([A-Za-z_]\w*)\.customProperties\s*\[\s*([A-Za-z_]*REGION[A-Za-z_]*)\s*\]/gi;

function rewriteAwsRegionField(input: string, transforms: Transform[]): string {
  let out = input.replace(CUSTOM_PROP_REGION_RE, (full, arg: string) => {
    const repl = `getNodeField(${arg}, "aws.region")`;
    transforms.push({ kind: 'entity-dim', before: full, after: repl, detail: 'region from customProperties → aws.region field (carried on every AWS node)' });
    return repl;
  });

  // Map lookup prefixes → their source node, then repoint <prefix>.customProperties[REGION].
  const prefixNode = new Map<string, string>();
  for (let m = LOOKUP_PREFIX_RE.exec(out); m; m = LOOKUP_PREFIX_RE.exec(out)) prefixNode.set(m[2]!, m[1]!);
  if (prefixNode.size > 0) {
    out = out.replace(PREFIX_PROP_REGION_RE, (full, prefix: string) => {
      const node = prefixNode.get(prefix);
      if (!node || !/^dt\.smartscape\./.test(node)) return full; // only when the prefix maps to a smartscape node
      const repl = `getNodeField(${node}, "aws.region")`;
      transforms.push({ kind: 'entity-dim', before: full, after: repl, detail: `region from ${prefix}.customProperties (lookup prefix) → node aws.region` });
      return repl;
    });
  }
  return out;
}

// ─── Pass 2.58: ARN-split idioms → the denormalized aws.* fields ──────────
//
// An ARN is `arn:aws:<svc>:<region>:<account>:<resource>`, so `splitString(arn,
// ":")[3]` is definitionally the region and `[4]` the account id. Classic
// dashboards derive both that way from `<v> = entityAttr(x,"arn")` (Pass 2.5 →
// getNodeField(x,"arn")). On the new side `arn` reads null (the field is
// `aws.arn`), so the split yields nothing — replace `splitString(<arn>,":")[3|4]`
// with the denormalized `getNodeField(<node>, "aws.region" | "aws.account.id")`
// (both carried on every AWS node — tenant-probed). Handles the inline
// getNodeField(node,"arn") form and a named var traced within the query.
const ARN_SPLIT_FIELD: Record<string, string> = { '3': 'aws.region', '4': 'aws.account.id' };
const ARN_VAR_ASSIGN_RE = /\b(\w+)\s*=\s*getNodeField\(\s*([^,()]+?)\s*,\s*"arn"\s*\)/g;
const ARN_SPLIT_INLINE_RE =
  /splitString\(\s*getNodeField\(\s*([^,()]+?)\s*,\s*"arn"\s*\)\s*,\s*":"\s*\)\s*\[\s*([34])\s*\]/g;
const ARN_SPLIT_VAR_RE = /splitString\(\s*(\w+)\s*,\s*":"\s*\)\s*\[\s*([34])\s*\]/g;

function rewriteArnRegion(input: string, transforms: Transform[]): string {
  // Map each arn-holding var to the node it was read from.
  const arnVarNode = new Map<string, string>();
  for (let m = ARN_VAR_ASSIGN_RE.exec(input); m; m = ARN_VAR_ASSIGN_RE.exec(input)) {
    arnVarNode.set(m[1]!, m[2]!);
  }

  const note = (full: string, node: string, idx: string): string => {
    const field = ARN_SPLIT_FIELD[idx]!;
    const repl = `getNodeField(${node}, "${field}")`;
    transforms.push({
      kind: 'entity-dim',
      before: full,
      after: repl,
      detail: `parsed from ARN ([${idx}]) → ${field} field (denormalized on every AWS node)`,
    });
    return repl;
  };

  // Inline: splitString(getNodeField(node,"arn"), ":")[3|4]
  let out = input.replace(ARN_SPLIT_INLINE_RE, (full, node: string, idx: string) => note(full, node, idx));
  // Via a traced arn var: splitString(<arnVar>, ":")[3|4]. Record which vars we
  // free (their ARN-parse use is gone) — only those are removal candidates.
  const freed = new Set<string>();
  out = out.replace(ARN_SPLIT_VAR_RE, (full, varName: string, idx: string) => {
    const node = arnVarNode.get(varName);
    if (!node) return full;
    freed.add(varName);
    return note(full, node, idx);
  });

  // Clean up an arn var we just freed: if replacing its region parse left it
  // unreferenced AND its assignment is a STANDALONE `| fieldsAdd <var> =
  // getNodeField(...,"arn")` stage, drop the stage (arn reads null on the new
  // side → a dead column). Only vars freed above are eligible, so an arn field
  // that was already dead in the classic (and the reviewer kept) is preserved.
  // Multi-assign stages are left alone (too fiddly to split).
  for (const v of freed) {
    // Only the STANDALONE `| fieldsAdd v = getNodeField(...,"arn")` stage (followed
    // by another stage or end — not a comma, which would be a multi-assign).
    const standalone = new RegExp(
      `\\s*\\|\\s*fieldsAdd\\s+${escapeRegExp(v)}\\s*=\\s*getNodeField\\([^()]*,\\s*"arn"\\)(?=\\s*\\||\\s*$)`
    );
    const without = out.replace(standalone, '');
    if (without === out) continue; // no standalone assignment (e.g. multi-assign) → keep
    // Dead only if v isn't referenced anywhere in the remainder.
    if (new RegExp(`\\b${escapeRegExp(v)}\\b`).test(without)) continue;
    out = without;
    transforms.push({
      kind: 'entity-dim',
      before: `| fieldsAdd ${v} = getNodeField(x, "arn")`,
      after: '(removed)',
      detail: 'removed now-unused arn field (its only consumer was the region parse, now aws.region)',
    });
  }
  return out;
}

// ─── Pass 2.59: generic AWS field renames (getNodeField field arg) ────────
//
// Fields renamed/namespaced on the new AWS node schema (tenant-probed on
// nic55601): bare `arn` reads null — the ARN is on `aws.arn`; the classic VPC
// name field is now `aws.vpc.id`. Runs AFTER the ARN-split pass so region/account
// derivations still find the `"arn"` field first.
const GETNODEFIELD_RENAME: Record<string, string> = {
  arn: 'aws.arn',
  awsVpcName: 'aws.vpc.id',
};
function rewriteAwsFieldRenames(input: string, transforms: Transform[]): string {
  return input.replace(
    /getNodeField\(\s*([^,()]+?)\s*,\s*"([^"]+)"\s*\)/g,
    (full, arg: string, field: string) => {
      const nf = GETNODEFIELD_RENAME[field];
      if (!nf) return full;
      const repl = `getNodeField(${arg}, "${nf}")`;
      transforms.push({ kind: 'entity-dim', before: full, after: repl, detail: `field "${field}" → "${nf}" (new AWS node schema)` });
      return repl;
    }
  );
}

// ─── Pass 2.6b: <dt.smartscape.X>.entity.name → getNodeName(X) ─────────────
//
// After the dim swap a classic `<dim>.entity.name` field path survives as
// `dt.smartscape.X.entity.name`, which is not a field — the node name comes from
// getNodeName(). Reviewer-confirmed; dominant across the corpus (388 tiles). The
// negative lookahead skips an assignment LHS (`… .entity.name = …`), keeping
// comparisons (`==`) and reads.
const DIM_ENTITY_NAME_RE = /\b(dt\.smartscape\.[a-z0-9_]+)\.entity\.name\b(?!\s*=(?!=))/g;
function rewriteDimEntityName(input: string, transforms: Transform[]): string {
  return input.replace(DIM_ENTITY_NAME_RE, (full, dim: string) => {
    const repl = `getNodeName(${dim})`;
    transforms.push({ kind: 'entity-dim', before: full, after: repl, detail: 'dt.smartscape.X.entity.name → getNodeName(X)' });
    return repl;
  });
}

// ─── Pass 2.56b: <dt.smartscape.X>.tags field-access → tags:aws record ────
//
// A classic `<dim>.tags` field access survives the dim swap as
// `dt.smartscape.X.tags`, but the AWS tag record is `tags:aws` (read via
// getNodeField). Convert to `getNodeField(dt.smartscape.X, "tags:aws")` — which
// then lets the tag-FILTER pass (2.57) rewrite any `in(…"[AWS]Key:"…)` around it.
const DIM_TAGS_RE = /\b(dt\.smartscape\.[a-z0-9_]+)\.tags\b(?!:)/g;
function rewriteDimTags(input: string, transforms: Transform[]): string {
  return input.replace(DIM_TAGS_RE, (full, dim: string) => {
    const repl = `getNodeField(${dim}, "tags:aws")`;
    transforms.push({ kind: 'entity-dim', before: full, after: repl, detail: 'dt.smartscape.X.tags → getNodeField(X, "tags:aws")' });
    return repl;
  });
}

// ─── Pass 2.72: dangling dt.smartscape.aws_account column → account.name ──
//
// The classic `dt.entity.aws_credentials` used as a COLUMN (in a fields list, or
// getNodeName(...)) dim-swaps to `dt.smartscape.aws_account`, which is not a real
// column — there's no account dim on the series. When the credential collapse
// (Pass 0.5–0.7) ran it produced the account NAME under a prefixed lookup field
// (`account.name` via `prefix:"account."`), so point the dangling reference at
// that. Reviewer-confirmed (they hand-replaced it with the local account field);
// ~950 tiles on the corpus. No-op if we can't resolve the account-name column,
// or if `dt.smartscape.aws_account` is itself assigned (a self-defined column).
const ACCOUNT_LOOKUP_NAME_RE =
  /lookup\s*\[\s*smartscapeNodes\s+AWS_ACCOUNT\b[^\]]*\bname\b[^\]]*\][^|]*?prefix\s*:\s*"([^"]+)"/;
function rewriteLeftoverAccountColumn(input: string, transforms: Transform[]): string {
  if (!/\bdt\.smartscape\.aws_account\b/.test(input)) return input;
  // Skip if it's assigned somewhere (`dt.smartscape.aws_account = …`) — then it's
  // a (self-defined) column and its refs are valid; don't touch.
  if (/\bdt\.smartscape\.aws_account\s*=(?!=)/.test(input)) return input;
  // Resolve which column holds the account name: the native `aws.account.name`
  // dim (Pass 0.6 native path) wins; else the AWS_ACCOUNT lookup's prefixed
  // `<p>.name`; else a bare `account.name` — but NOT `aws.account.name` as a
  // substring (the `(?<!aws\.)` guard), which would emit a nonexistent field.
  const m = ACCOUNT_LOOKUP_NAME_RE.exec(input);
  const acctCol = /\baws\.account\.name\b/.test(input)
    ? 'aws.account.name'
    : m
      ? `${m[1]}name`
      : /(?<!aws\.)\baccount\.name\b/.test(input)
        ? 'account.name'
        : null;
  if (!acctCol) return input; // account-name column not resolvable → leave as-is
  let out = input;
  // getNodeName(dt.smartscape.aws_account) → the name column directly.
  out = out.replace(/getNodeName\(\s*dt\.smartscape\.aws_account\s*\)/g, () => {
    transforms.push({ kind: 'entity-dim', before: 'getNodeName(dt.smartscape.aws_account)', after: acctCol, detail: 'dangling credential/account ref → account-name lookup field' });
    return acctCol;
  });
  // Bare column reference (not an assignment LHS) → the account-name column.
  out = out.replace(/\bdt\.smartscape\.aws_account\b(?!\s*=(?!=))/g, () => {
    transforms.push({ kind: 'entity-dim', before: 'dt.smartscape.aws_account', after: acctCol, detail: 'dangling credential column → account-name lookup field (no account dim on the series)' });
    return acctCol;
  });
  return out;
}

// ─── Pass 2.57: classic AWS tag FILTER idiom → tag-record key compare ──────
//
// Classic filters test the serialized tag string for a "[AWS]<Key>:<value>"
// substring, e.g.  in(entityAttr(x,"tags"), "[AWS]ApplicationCI:fbs")  or
// in(concat("[AWS]env:", $Env), tags). After Pass 2.5 the tags source is the
// AWS tag RECORD (getNodeField(x,"tags:aws") or a var holding it), so the
// substring test is invalid ("field tags doesn't support …"). Rewrite to a
// direct record-key compare: <tags>[<Key>] == <value>. Scoped to AWS tag
// sources only (getNodeField(…,"tags:aws") or a var assigned from it) so span /
// non-AWS `tags` usage is never touched (reviewer caught an over-reach on spans).
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteAwsTagFilters(input: string, transforms: Transform[]): string {
  // Vars assigned an AWS tag record become additional safe tag sources.
  const tagVars = new Set<string>();
  const assignRe = /\b([A-Za-z_]\w*)\s*=\s*getNodeField\([^()]*,\s*"tags:aws"\)/g;
  for (let m = assignRe.exec(input); m; m = assignRe.exec(input)) tagVars.add(m[1]!);

  const gnf = 'getNodeField\\([^()]*,\\s*"tags:aws"\\)';
  const varAlt = [...tagVars].map(escapeRegExp).join('|');
  const tags = varAlt ? `(?:${gnf}|${varAlt})` : gnf;
  const K = '([^:"\\]]+)'; // tag key (no [AWS] prefix, no colon)

  let out = input;
  const eq = (full: string, te: string, key: string, value: string): string => {
    const repl = `${te.trim()}[${key.trim()}] == ${value.trim()}`;
    transforms.push({
      kind: 'entity-dim',
      before: full,
      after: repl,
      detail: `AWS tag filter → tag-record key compare (${key.trim()}); verify placement if inside a timeseries filter:{} block`,
    });
    return repl;
  };

  // in(<tags>, "[AWS]Key:literal")  /  reversed
  out = out.replace(new RegExp(`\\bin\\(\\s*(${tags})\\s*,\\s*"\\[AWS\\]${K}:([^"]*)"\\s*\\)`, 'g'),
    (full, te, key, val) => eq(full, te, key, `"${val}"`));
  out = out.replace(new RegExp(`\\bin\\(\\s*"\\[AWS\\]${K}:([^"]*)"\\s*,\\s*(${tags})\\s*\\)`, 'g'),
    (full, key, val, te) => eq(full, te, key, `"${val}"`));
  // in(<tags>, concat("[AWS]Key:", <expr>))  /  reversed
  out = out.replace(new RegExp(`\\bin\\(\\s*(${tags})\\s*,\\s*concat\\(\\s*"\\[AWS\\]${K}:"\\s*,\\s*([^()]+?)\\)\\s*\\)`, 'g'),
    (full, te, key, expr) => eq(full, te, key, expr));
  out = out.replace(new RegExp(`\\bin\\(\\s*concat\\(\\s*"\\[AWS\\]${K}:"\\s*,\\s*([^()]+?)\\)\\s*,\\s*(${tags})\\s*\\)`, 'g'),
    (full, key, expr, te) => eq(full, te, key, expr));
  return out;
}

// ─── Late cleanup: drop duplicate columns in a fields / fieldsKeep clause ──
//
// When two distinct classic entities (e.g. custom_device AND a concrete type)
// collapse to the SAME Smartscape node type, a `fields …, A, …, A` list ends up
// with the identical column twice → the renderer errors. Dedupe exact-duplicate
// bare column tokens within each fields/fieldsKeep clause, keeping first order.
function dedupeFieldsClauses(input: string, transforms: Transform[]): string {
  return input.replace(/(\|\s*fields(?:Keep)?\s+)([^|]+)/g, (full, head: string, body: string) => {
    const parts = splitTopLevel(body).map((p) => p.trim());
    const seen = new Set<string>();
    const kept: string[] = [];
    let dropped = 0;
    for (const p of parts) {
      // Only dedupe simple column refs (no assignment / call), keep everything else.
      const isSimple = p.length > 0 && !/[=(]/.test(p);
      const dupKey = p;
      if (isSimple && seen.has(dupKey)) {
        dropped++;
        continue;
      }
      if (isSimple) seen.add(dupKey);
      kept.push(p);
    }
    if (dropped === 0) return full;
    transforms.push({
      kind: 'entity-dim',
      before: `fields …${dropped} duplicate column(s)`,
      after: 'deduped',
      detail: 'removed duplicate column(s) from a fields clause (two classic entities collapsed to one node type)',
    });
    return `${head}${kept.join(', ')}`;
  });
}

/**
 * Split on top-level commas only — commas nested inside ()/[]/{} OR inside a
 * string/backtick literal belong to a call or literal, not the column list.
 * A naive split shears function arguments apart: a repeated argument (two
 * tiles' `if(cond, "same")`) then looks like a duplicate column and gets
 * dropped, truncating the call. Reviewers hit exactly this — an if() losing
 * its "result if true" portion (EZE EKS Overview).
 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// A classic bare field ref used as a `fieldsAdd` operand — `dt.entity.X.tags`,
// `dt.entity.X.entity.name` — auto-names its column. Our entity passes rewrite it
// to a function call (getNodeField/getNodeName), which as a bare fieldsAdd operand
// is invalid (FIELD_DOES_NOT_EXIST / needs a name). Reconstruct the classic
// auto-name so the column (and any viz ref to it) still resolves.
function autoNameFor(operand: string): string | null {
  let m = /^getNodeName\(\s*(.+?)\s*\)$/.exec(operand);
  if (m) return `${m[1]}.name`;
  m = /^getNodeField\(\s*(.+?)\s*,\s*"([^"]+)"\s*\)$/.exec(operand);
  if (m) return `${m[1]}.${m[2]!.split(':')[0]}`; // "tags:aws" → tags
  return null;
}
function nameBareEntityOperands(input: string, transforms: Transform[]): string {
  return input.replace(/(\|\s*fieldsAdd\s+)([^|]+)/g, (full, head: string, body: string) => {
    const parts = splitTopLevel(body);
    const seen = new Set<string>();
    let changed = false;
    const out = parts.map((p) => {
      const t = p.trim();
      if (/^[^=]+=(?!=)/.test(t)) return p; // already `name = …`
      const nm = autoNameFor(t);
      if (!nm) return p;
      changed = true;
      let name = nm;
      let i = 2;
      while (seen.has(name)) name = `${nm}_${i++}`;
      seen.add(name);
      return ` \`${name}\` = ${t}`;
    });
    if (!changed) return full;
    transforms.push({ kind: 'entity-dim', before: 'fieldsAdd <bare entity fn>', after: 'named', detail: 'named a bare getNodeName/getNodeField fieldsAdd operand (classic auto-named the column)' });
    return `${head}${out.join(',')}`;
  });
}

// Filtering a smartscape ID dim against string values needs an explicit cast:
// `in(dt.smartscape.X, <values>)` → `in(toString(dt.smartscape.X), <values>)`.
// The dim is an ID type, so comparing it to string literals / a variable list
// silently returns nothing without toString. (Reviewer-confirmed on SQS +
// custom_device_ids variables.) Skips the classicEntitySelector value form
// (flagged for manual migration) and never touches `by:{…}` grouping.
const SMARTSCAPE_IN_FILTER_RE = /\bin\(\s*(dt\.smartscape\.[a-z0-9_]+)\s*,/g;
function rewriteSmartscapeIdFilter(input: string, transforms: Transform[]): string {
  return input.replace(SMARTSCAPE_IN_FILTER_RE, (full, dim: string, offset: number) => {
    const rest = input.slice(offset + full.length).trimStart();
    if (rest.startsWith('classicEntitySelector')) return full; // manual-migration path
    transforms.push({
      kind: 'entity-dim',
      before: full,
      after: `in(toString(${dim}),`,
      detail: 'filter on a smartscape ID dim → toString() cast (compares against string values)',
    });
    return `in(toString(${dim}),`;
  });
}

// Same collapse can duplicate a grouping dim inside a `by:{…}` clause (timeseries
// or summarize), which DQL rejects (FIELD_SPECIFIED_TWICE). Dedupe exact-duplicate
// simple dims per by-clause. Skips assignment/expr items (`X = …`, calls).
function dedupeByClauses(input: string, transforms: Transform[]): string {
  return input.replace(/\bby\s*:\s*\{([^}]*)\}/g, (full, body: string) => {
    const parts = splitTopLevel(body).map((p) => p.trim()).filter((p) => p.length > 0);
    const seen = new Set<string>();
    const kept: string[] = [];
    let dropped = 0;
    for (const p of parts) {
      const isSimple = !/[=(]/.test(p);
      if (isSimple && seen.has(p)) {
        dropped++;
        continue;
      }
      if (isSimple) seen.add(p);
      kept.push(p);
    }
    if (dropped === 0) return full;
    transforms.push({
      kind: 'entity-dim',
      before: 'by:{ …duplicate dim }',
      after: 'deduped',
      detail: 'removed duplicate grouping dim from a by-clause (two classic entities collapsed to one node type)',
    });
    return `by:{${kept.join(', ')}}`;
  });
}

/**
 * parseSelector, but never throws. Malformed selectors exist in real dashboards
 * and a parse failure must degrade to "leave it classic", not abort the rewrite.
 */
function safeParseSelector(selectorStr: string): ReturnType<typeof parseSelector> | null {
  try {
    return parseSelector(unescapeDqlString(selectorStr));
  } catch {
    return null;
  }
}

// ─── Late cleanup: drop the classic custom-device GROUP from AWS queries ──
//
// `dt.entity.custom_device_group` is purely an organizational container for the
// OLD AWS custom devices — a folder, not a resource. It has no Smartscape
// counterpart and no meaning in the new model, where scoping comes from the
// resource's own tags/dimensions (and, for these queries, from the management
// zone we already rewrote into an `aws.tags.*` filter). Left in place it is a
// permanently-null column that also adds a meaningless extra alert grain, since
// each series in a detector's by-clause is its own alert.
//
// Scoped to AWS metric queries so non-AWS panels that legitimately group by a
// custom-device group are untouched.
const CDG = 'dt\.entity\.custom_device_group';
const CDG_RE = new RegExp('`?' + CDG + '`?');

function dropCustomDeviceGroup(input: string, transforms: Transform[]): string {
  if (!/cloud\.aws\./.test(input) || !CDG_RE.test(input)) return input;
  let out = input;
  let removed = 0;

  // 1. Remove it as a grouping dim: by:{ …, dt.entity.custom_device_group, … }
  out = out.replace(/\bby\s*:\s*\{([^}]*)\}/g, (full, body: string) => {
    const kept = splitTopLevel(body).filter((p) => !CDG_RE.test(p.trim()) || /[=(]/.test(p));
    if (kept.length === splitTopLevel(body).length) return full;
    removed++;
    // An empty by-clause is invalid; drop the whole clause in that case.
    return kept.length ? `by:{${kept.map((p) => p.trim()).join(', ')}}` : '';
  });

  // 2. Drop a `| fieldsAdd …` whose ENTIRE body is about the group (the common
  //    `fieldsAdd entityName(dt.entity.custom_device_group)` label column).
  //    A clause that merely mentions it alongside other work is left alone.
  out = out.replace(/\|\s*fieldsAdd\s+([^|]+)/g, (full, body: string) => {
    const parts = splitTopLevel(body);
    const kept = parts.filter((p) => !CDG_RE.test(p));
    if (kept.length === parts.length) return full;
    removed++;
    return kept.length ? `| fieldsAdd ${kept.map((p) => p.trim()).join(', ')}` : '';
  });

  if (removed > 0) {
    transforms.push({
      kind: 'entity-dim',
      before: 'dt.entity.custom_device_group',
      after: '(dropped)',
      detail:
        'classic custom-device GROUP is an organizational container for old AWS entities — no Smartscape ' +
        'counterpart and no meaning in the new model; kept it out of the grouping/labels so it does not ' +
        'emit a null column or an extra alert grain',
    });
  }
  return out;
}

// ─── Late cleanup: drop by-clause dims the NEW metric key doesn't carry ───
//
// A new-connection key spells out its own dimensions: `cloud.aws.rds.Deadlocks
// .By.DBClusterIdentifier` has exactly one. Classic keys often carried more
// (`…_by_region_dbcluster_identifier_role`), and the classic by-clause named all
// of them. Keeping a dim the key does NOT carry gives a permanently-null column
// AND — because each series in a detector's by-clause is its own alert — the
// wrong alert grain. Reviewers hit exactly this on CPN QA RDS Aurora Deadlocks,
// pruning `by:{Region, DBClusterIdentifier, Role}` down to the dims that exist.
//
// Only bare dimension tokens are pruned. `dt.smartscape.*` (the entity dim),
// `aws.*` (region/account/tags, present on every AWS series), and anything with
// an assignment or call are always kept — they are not metric dimensions.
const NEW_KEY_RE = /`?(cloud\.aws\.[a-z0-9_]+\.[A-Za-z0-9]+\.By\.[A-Za-z0-9._]+)`?/;

function pruneByDimsNotOnKey(input: string, transforms: Transform[], warnings: Warning[]): string {
  const keyM = NEW_KEY_RE.exec(input);
  if (!keyM) return input;
  const dims = new Set(
    keyM[1]!.slice(keyM[1]!.indexOf('.By.') + 4).split('.').map((d) => d.toLowerCase())
  );
  if (dims.size === 0) return input;

  const dropped: string[] = [];
  const out = input.replace(/\bby\s*:\s*\{([^}]*)\}/g, (full, body: string) => {
    const parts = splitTopLevel(body).map((p) => p.trim()).filter(Boolean);
    const kept = parts.filter((p) => {
      const bare = p.replace(/`/g, '');
      // keep anything that isn't a plain dimension token
      if (/[=()]/.test(p)) return true;
      if (/^dt\./.test(bare) || /^aws\./.test(bare)) return true;
      if (dims.has(bare.toLowerCase())) return true;
      dropped.push(bare);
      return false;
    });
    if (kept.length === parts.length || kept.length === 0) return full;
    return `by:{${kept.join(', ')}}`;
  });

  if (dropped.length) {
    transforms.push({
      kind: 'entity-dim',
      before: `by:{… ${dropped.join(', ')} …}`,
      after: 'dropped',
      detail: `${keyM[1]} does not carry ${dropped.join(', ')} — kept only the dimensions the new key has`,
    });
    warnings.push({
      kind: 'dim-not-carried',
      text:
        `Removed ${dropped.join(', ')} from the by-clause: the new key ${keyM[1]} does not carry ` +
        `${dropped.length > 1 ? 'those dimensions' : 'that dimension'}, so grouping by ${dropped.length > 1 ? 'them' : 'it'} ` +
        `would produce a null column and change the alert grain. Confirm the remaining grouping is the grain you want.`,
      match: keyM[1],
    });
  }
  return out;
}

/**
 * Flag a final metric key that has NO series on this tenant while a sibling
 * variant does. The lookup's automatic dim-override deliberately skips the
 * verified recipe tier — those keys carry an aggregation/scale calibrated for a
 * specific dimension, so silently repointing them could quietly change the
 * numbers an alert fires on. Staying silent isn't right either: reviewers were
 * left diagnosing empty panels from scratch (reported on AAP:JET —
 * "No data in tenant for cloud.aws.dynamodb.SuccessfulRequestLatency.By.TableName",
 * whose `.By.Operation.TableName` sibling carries 248 series). So we name the
 * populated sibling and let a human make the call.
 */
function warnDeadMetricVariant(input: string, index: RecipeIndex, warnings: Warning[]): void {
  const live = index.liveMetrics;
  if (!live) return;
  const m = NEW_KEY_RE.exec(input);
  if (!m) return;
  const key = m[1]!;
  if ((live.byKey.get(key) ?? 0) > 0) return;
  const stem = key.split('.By.')[0]!;
  const sibs = (live.byBase.get(stem) ?? [])
    .filter((s) => s !== key && (live.byKey.get(s) ?? 0) > 0)
    .sort((a, b) => (live.byKey.get(b) ?? 0) - (live.byKey.get(a) ?? 0));
  if (!sibs.length) return;
  const best = sibs[0]!;
  warnings.push({
    kind: 'dim-variant-override',
    text:
      `${key} has no series on this tenant, but ${best} does (${live.byKey.get(best)} series). ` +
      `This key came from a verified recipe whose aggregation/scale is calibrated for its dimension, so it was ` +
      `NOT repointed automatically — switching to the populated variant may change the values the alert fires on. ` +
      `Confirm which grain you want.`,
    match: key,
  });
}

// ─── Enriched tag reads → the native metric dimension ─────────────────────
//
// `getNodeField(<dim>, "tags:aws")[Key]` matches Key against the resource's real
// AWS tags CASE-SENSITIVELY. Classic queries write whatever case the author
// used, so we faithfully emit `[applicationci]` while the resource is tagged
// `ApplicationCI` — and the read returns null. Silently: the filter matches
// nothing, the column shows blank. Measured on this corpus: 151 such reads
// across 20 dashboards.
//
// Case-correcting the key is not safe — AWS tag keys are case-sensitive and the
// same logical tag exists in several casings at once (`env` on 34,026 lambdas,
// `Env` on 182). The connection sidesteps it by lowercasing tags when it
// enriches them onto the METRIC, so `aws.tags.env` covers every spelling and
// reaches 99.8% of series.
//
// Scope, deliberately narrow:
//   - only in a `timeseries` query — the dimension exists on metric series, not
//     on entity records, so a smartscapeNodes/fetch query must keep the lookup
//   - only for keys the tenant actually enriches (`discover-tags`); substituting
//     a dimension that isn't there would turn a working filter into an empty one
// Assignments keep their own column name (`| fieldsAdd appci = …`), so nothing
// downstream gets renamed.
const TAG_RECORD_READ =
  /getNodeField\(\s*`?dt\.smartscape\.[a-z0-9_]+`?\s*,\s*"tags:aws"\s*\)\s*\[\s*([A-Za-z_][\w-]*)\s*\]/g;

function useEnrichedTagDims(
  input: string,
  index: RecipeIndex,
  transforms: Transform[],
  warnings: Warning[]
): string {
  const enriched = index.enrichedTags;
  if (!enriched || enriched.size === 0) return input;
  if (!/\btimeseries\b/.test(input)) return input;      // metric queries only
  if (/\bsmartscapeNodes\b|\bfetch\s+dt\./.test(input)) return input; // entity query — keep the lookup
  // …and specifically an AWS metric. The connection enriches these tags onto AWS
  // series only: on an APM metric `aws.tags.applicationci` is simply null
  // (tenant-verified against dt.service.request.response_time), so substituting
  // it there would turn a working tag filter into one that matches nothing.
  // A service can legitimately carry `tags:aws` on its ENTITY while its metrics
  // carry no AWS dimensions at all, which is exactly the case that bites.
  if (!/\bcloud\.aws\./.test(input)) return input;

  const swapped = new Set<string>();
  const out = input.replace(TAG_RECORD_READ, (full, key: string) => {
    if (!enriched.has(key.toLowerCase())) return full;
    const dim = `\`${enrichedTagDimension(key)}\``;
    swapped.add(`${key} → ${enrichedTagDimension(key)}`);
    return dim;
  });

  if (swapped.size) {
    transforms.push({
      kind: 'entity-dim',
      before: 'getNodeField(x, "tags:aws")[Key]',
      after: [...swapped].map((s) => s.split(' → ')[1]).join(', '),
      detail:
        'read the enriched tag as a native metric dimension instead of a case-sensitive entity lookup ' +
        '(the entity record keys are real-cased, so a differently-cased read returns null)',
    });
    warnings.push({
      kind: 'classic-selector-note',
      text:
        `Tag read${swapped.size > 1 ? 's' : ''} ${[...swapped].join(', ')} now use the enriched metric ` +
        `dimension rather than a tags:aws entity lookup. The connection lowercases enriched tags, so this ` +
        `matches whatever casing the resource used — but it only covers resources whose series carry the ` +
        `tag. Spot-check the row count against the classic tile.`,
    });
  }
  return out;
}

// ─── Classic attributes that survive only inside the aws.object blob ──────
//
// A handful of classic AWS entity attributes have no field on the Smartscape
// node at all. Their data lives in `aws.object`, a raw JSON blob of the AWS
// describe-call — and that blob is SPARSE (absent on many nodes, tenant-probed),
// so we will not auto-generate the lookup+parse: it would produce a query that
// silently drops every resource whose blob is missing.
//
// Emitting a null read and saying nothing is worse though — reviewers hit
// exactly this on CBS - EC2 Dashboard and hand-wrote
//   | lookup [smartScapeNodes "AWS_EC2_INSTANCE"
//             | parse aws.object, "JSON:json"
//             | fields id, instance_type = json[configuration][instanceType]], …
// so we name the path and let them decide whether the coverage is acceptable.
const OBJECT_ONLY_ATTRS: Record<string, string> = {
  awsInstanceType: 'aws.object -> configuration.instanceType',
  awsRuntime: 'aws.object -> configuration.runtime',
  awsSecurityGroup: 'aws.security_group.id (node field) or aws.object',
  awsNameTag: '`tags:aws`[Name]',
};

function warnObjectOnlyAttributes(input: string, warnings: Warning[]): void {
  for (const [attr, where] of Object.entries(OBJECT_ONLY_ATTRS)) {
    if (!new RegExp(`\\b${attr}\\b`).test(input)) continue;
    warnings.push({
      kind: 'dim-not-carried',
      text:
        `\`${attr}\` has no field on the Smartscape node — it reads null. The value lives in ${where}. ` +
        `Note that \`aws.object\` is populated on only some nodes, so a lookup+parse over it will silently ` +
        `drop resources whose blob is missing; check the row count against the classic tile before relying on it.`,
      match: attr,
    });
  }
}

// ─── Classic field names inside getNodeField(dim, "…") ────────────────────
//
// The bare-identifier rename pass only runs when a `fetch` was rewritten to
// `smartscapeNodes`, so a `timeseries` query keeps reading the CLASSIC field
// name — `getNodeField(dt.smartscape.aws_ec2_instance, "awsInstanceId")` reads
// null on the new node. It also wraps dotted replacements in backticks, which is
// right for a bare identifier but produces `"` + "`aws.resource.id`" + `"` when
// the name sits inside a quoted argument.
//
// This handles that form directly: the node type comes from the dimension
// itself, so it works in every query shape, and the field name is substituted
// as a plain quoted string.
const NODE_FIELD_ARG = /getNodeField\(\s*(`?dt\.smartscape\.([a-z0-9_]+)`?)\s*,\s*"([^"]+)"\s*\)/g;

function renameNodeFieldArgs(input: string, transforms: Transform[]): string {
  return input.replace(NODE_FIELD_ARG, (full, dim: string, nodeLower: string, field: string) => {
    const table = ENTITY_FIELD_MAPPINGS_BY_NODE_TYPE[nodeLower.toUpperCase()];
    const hit = table?.find((m) => m.classicField === field);
    if (!hit) return full;
    const repl = `getNodeField(${dim}, "${hit.smartscapeField}")`;
    transforms.push({
      kind: 'entity-dim',
      before: `getNodeField(…, "${field}")`,
      after: `getNodeField(…, "${hit.smartscapeField}")`,
      detail: `${nodeLower.toUpperCase()} field rename${hit.notes ? ` (${hit.notes})` : ''}`,
    });
    return repl;
  });
}
