/**
 * detector-rewrite — convert a classic-referencing Davis anomaly detector
 * (`builtin:davis.anomaly-detectors`) to the Smartscape-on-Grail form.
 *
 * An anomaly detector is NOT just a DQL string. Three parts need rewriting and
 * only the first is shared with dashboards:
 *
 *   1. `analyzer.input[key==="query"]` — the DQL. Handled by the shared
 *      `rewriteDql`, which already disambiguates `dt.entity.custom_device` to a
 *      concrete `dt.smartscape.<type>` via the metric service.
 *   2. `eventTemplate` — the alert message + the `dt.source_entity` BINDING that
 *      ties a fired event to a monitored entity. Its `{dims:...}` placeholders
 *      reference query OUTPUT COLUMNS, so when the query's `by:{}` dimension
 *      changes (`dt.entity.custom_device` → `dt.smartscape.<type>`) the
 *      placeholders must change in lockstep or the binding/message breaks.
 *   3. `analyzer.input[key==="threshold"]` — a static threshold FIRES on the
 *      metric value. If the metric mapping rescales the value (recipe
 *      `scale != 1`), the threshold must be divided by that scale (the query
 *      emits the raw new-metric value; `classic ≈ scale × new`, so
 *      `new_threshold = classic_threshold / scale`). Aggregation flips and
 *      per-second modes have no safe scalar → we BLOCK them for manual reset.
 *
 * Pure over the detector `value` object + the RecipeIndex; colocated-tested.
 * The Settings-API write surface lives elsewhere.
 */

import {
  rewriteDql,
  type RewriteResult,
  type Transform,
  type Warning,
} from './dql-rewriter.ts';
import { lookupClassicKey, type RecipeIndex } from './recipe-lookup.ts';

/** What we did (or refused to do) to the detector's static threshold. */
export interface ThresholdAction {
  kind: 'unchanged' | 'rescaled' | 'blocked' | 'none';
  reason: string;
  from?: number;
  to?: number;
  scale?: number;
  metric?: string;
}

export interface EventTemplateChange {
  field: string;
  before: string;
  after: string;
}

export interface DetectorRewriteResult {
  /** True when the query, event template, or threshold actually changed. */
  changed: boolean;
  /** The DQL rewrite result, or null when the detector carries no query. */
  query: RewriteResult | null;
  /** Smartscape node type the query resolved custom_device to (e.g. AWS_RDS_DBINSTANCE). */
  nodeType?: string;
  /** The dim placeholder synced into the event template (`dt.smartscape.<type>`). */
  targetDim?: string;
  eventTemplateChanges: EventTemplateChange[];
  thresholdAction: ThresholdAction;
  warnings: Warning[];
  transforms: Transform[];
  /** Deep-cloned detector value with query/eventTemplate/threshold updated. */
  rewrittenValue: Record<string, unknown>;
}

/** Shapes a classic AWS metric key can take in a detector query. */
const CLASSIC_KEY_RE =
  /(?:builtin:cloud\.aws|dt\.cloud\.aws|ext:cloud\.aws)\.[\w.:]+|cloud\.aws\.[a-z0-9_]+\.[a-z][\w]*/;

/** First `dt.smartscape.<type>` dim the rewritten query produced. */
const SMARTSCAPE_DIM_RE = /dt\.smartscape\.([a-z0-9_]+)/;

interface AnalyzerInput {
  key?: string;
  value?: string;
}

function findInput(inputs: AnalyzerInput[], key: string): AnalyzerInput | undefined {
  return inputs.find((i) => i && i.key === key);
}

/** Pull the DQL query string out of a detector value, if present. */
export function detectorQuery(value: Record<string, unknown>): string | undefined {
  const analyzer = value?.analyzer as { input?: AnalyzerInput[] } | undefined;
  const inputs = Array.isArray(analyzer?.input) ? analyzer!.input! : [];
  const q = findInput(inputs, 'query')?.value;
  return typeof q === 'string' ? q : undefined;
}

/**
 * Rewrite `{dims:X}` placeholders whose X is a classic entity dim to the
 * Smartscape dim the query now emits. Only `dt.entity.custom_device` (and its
 * `.name` accessor) is remapped — that's the dim the disambiguation resolves,
 * and the placeholder must match the rewritten `by:{}` column name exactly.
 * Returns the rewritten string plus the substitutions made.
 */
function rewriteEventTemplateString(
  s: string,
  targetDim: string
): { text: string; subs: Array<{ before: string; after: string }> } {
  const subs: Array<{ before: string; after: string }> = [];
  let text = s;

  // `.name` accessor first (longer match) so the bare form doesn't eat it.
  const nameFrom = '{dims:dt.entity.custom_device.name}';
  const nameTo = `{dims:${targetDim}.name}`;
  if (text.includes(nameFrom)) {
    text = text.split(nameFrom).join(nameTo);
    subs.push({ before: nameFrom, after: nameTo });
  }

  // Bare entity dim — used both in message text and as the dt.source_entity
  // binding value.
  const idFrom = '{dims:dt.entity.custom_device}';
  const idTo = `{dims:${targetDim}}`;
  if (text.includes(idFrom)) {
    text = text.split(idFrom).join(idTo);
    subs.push({ before: idFrom, after: idTo });
  }

  return { text, subs };
}

/** The event-template property that ties a fired alert to an entity. */
const CLASSIC_BINDING_KEY = 'dt.source_entity';
const SMARTSCAPE_BINDING_KEY = 'dt.smartscape_source.id';

/**
 * Point the alert's entity binding at the Smartscape node the rewritten query
 * emits. This property IS the binding mechanism — nothing else is needed.
 *
 * Measured on nic55601 across 30 days of CUSTOM_ALERT events, grouped by the
 * value form of the `dt.smartscape_source.id` property:
 *
 *   {dt.smartscape.<type>}      49 detectors   2,089 events   2,086 bound
 *   {dt.smartscape_source.id}   38 detectors      64 events       0 bound
 *   {dims:dt.smartscape.<type>}  0 detectors       — no evidence either way
 *
 * "Bound" means the event carries `smartscape.affected_entity.ids` — the field
 * the BigPanda workflow reads. Presence of this property correlates 1:1 with
 * binding, zero exceptions in 2.9M events, so a query-side
 * `| fieldsAdd dt.smartscape_source.id = ...` is NOT required and none of the
 * 49 working detectors has one. What the query must do is emit the dimension
 * in its `by:{}` clause, which the query rewrite above already ensures.
 *
 * Hence the plain form here rather than the `{dims:...}` form we use for
 * message TEXT: for text it is the documented way to read a dimension, but for
 * the binding it has no working precedent and the failure mode is an alert
 * that fires attached to nothing, which nobody notices.
 *
 * The self-referencing form is a hand-migration that has silently never bound;
 * repair it wherever we find it.
 */
function rewriteEntityBinding(
  props: Array<{ key?: string; value?: unknown }>,
  targetDim: string,
  changes: EventTemplateChange[]
): void {
  const bindingValue = `{${targetDim}}`;
  const existing = props.find((p) => String(p?.key ?? '') === SMARTSCAPE_BINDING_KEY);
  const classic = props.find((p) => String(p?.key ?? '') === CLASSIC_BINDING_KEY);

  // A leftover classic binding is inert once the query reads Smartscape nodes;
  // drop it so the migrated detector carries exactly one unambiguous binding.
  const dropClassic = () => {
    if (!classic) return;
    changes.push({ field: CLASSIC_BINDING_KEY, before: String(classic.value ?? ''), after: '(removed)' });
    props.splice(props.indexOf(classic), 1);
  };

  if (existing) {
    if (String(existing.value ?? '') !== bindingValue) {
      changes.push({ field: SMARTSCAPE_BINDING_KEY, before: String(existing.value ?? ''), after: bindingValue });
      existing.value = bindingValue;
    }
    dropClassic();
    return;
  }

  if (classic) {
    // Rename the key in place — the classic field name no longer resolves.
    changes.push({
      field: `${CLASSIC_BINDING_KEY} → ${SMARTSCAPE_BINDING_KEY}`,
      before: String(classic.value ?? ''),
      after: bindingValue,
    });
    classic.key = SMARTSCAPE_BINDING_KEY;
    classic.value = bindingValue;
    return;
  }

  // No binding at all. Add one: without it the migrated alert attributes to
  // ENVIRONMENT and BigPanda receives no entity metadata to key on.
  changes.push({ field: SMARTSCAPE_BINDING_KEY, before: '(absent)', after: bindingValue });
  props.push({ key: SMARTSCAPE_BINDING_KEY, value: bindingValue });
}

/**
 * Compute the threshold action for a detector, given the primary classic metric
 * key's recipe. Rescales on a clean scalar; blocks on an aggregation flip or a
 * per-second mode (no safe automatic threshold); otherwise unchanged.
 */
function computeThresholdAction(
  rawThreshold: string | undefined,
  classicKey: string | undefined,
  index: RecipeIndex
): ThresholdAction {
  if (rawThreshold === undefined) return { kind: 'none', reason: 'no static threshold on this analyzer' };
  const t = Number(String(rawThreshold).trim());
  if (!Number.isFinite(t)) return { kind: 'none', reason: `threshold "${rawThreshold}" is not numeric` };
  if (t === 0) return { kind: 'unchanged', reason: 'threshold is 0 — scale/offset invariant' };
  if (!classicKey) return { kind: 'unchanged', reason: 'no classic metric key resolved for threshold analysis' };

  // CONSISTENCY INVARIANT: look up with the SAME raw key form the query
  // rewrite (dql-rewriter Pass 1) uses. Real detectors reference metrics in the
  // bare, agg-suffixed shape (`cloud.aws.lambda.invocations_sum`) that resolves
  // via the per-key/DAC tier as mapped-no-recipe — Pass 1 then preserves the
  // user's aggregation and applies no scale, so the new value matches classic
  // for the same agg on the same CloudWatch metric and the threshold stays
  // valid. Only when the query uses a recipe-tier-resolvable key form does Pass
  // 1 engage agg/scale — and only THEN may the threshold need adjusting. Keying
  // off the identical lookup guarantees the threshold action never desyncs from
  // what actually happened to the query.
  const lk = lookupClassicKey(index, classicKey);
  if (lk.kind !== 'recipe') {
    return { kind: 'unchanged', reason: 'metric-key swap only (no rescaling recipe) — threshold preserved', metric: classicKey };
  }

  const r = lk.recipe;
  if (r.classicAggregation !== r.newAggregation) {
    return {
      kind: 'blocked',
      reason: `aggregation flips ${r.classicAggregation}()→${r.newAggregation}() — no scalar converts the threshold; reset it manually`,
      metric: classicKey,
    };
  }
  if (r.newAggregationMode === 'per_second') {
    return {
      kind: 'blocked',
      reason: 'recipe needs per-second normalization (÷ bucket interval) — threshold depends on bucket size; reset it manually',
      metric: classicKey,
    };
  }
  if (r.scale !== null && Math.abs(r.scale - 1) > 0.02) {
    // classic ≈ scale × new; query emits raw new → new_threshold = T / scale.
    const to = t / r.scale;
    return { kind: 'rescaled', reason: `metric rescales ×${r.scale} (classic≈scale×new) → threshold ÷ ${r.scale}`, from: t, to, scale: r.scale, metric: classicKey };
  }
  return { kind: 'unchanged', reason: 'recipe scale ≈ 1 — threshold preserved', metric: classicKey };
}

/**
 * Rewrite one Davis anomaly detector value. Returns a deep-cloned, updated
 * value plus a full report of what changed and what needs human attention.
 */
export function rewriteDetector(
  value: Record<string, unknown>,
  index: RecipeIndex
): DetectorRewriteResult {
  const rewrittenValue = structuredClone(value);
  const warnings: Warning[] = [];
  const transforms: Transform[] = [];
  const eventTemplateChanges: EventTemplateChange[] = [];

  const analyzer = rewrittenValue.analyzer as { input?: AnalyzerInput[] } | undefined;
  const inputs = Array.isArray(analyzer?.input) ? analyzer!.input! : [];
  const queryInput = findInput(inputs, 'query');
  const originalQuery = typeof queryInput?.value === 'string' ? queryInput.value : undefined;

  if (!originalQuery) {
    return {
      changed: false,
      query: null,
      eventTemplateChanges,
      thresholdAction: { kind: 'none', reason: 'detector has no DQL query input' },
      warnings,
      transforms,
      rewrittenValue,
    };
  }

  // 1. Query.
  const query = rewriteDql(originalQuery, index);
  queryInput!.value = query.rewritten;
  warnings.push(...query.warnings);
  transforms.push(...query.transforms);

  // Resolve the Smartscape dim the query now emits (for the event template).
  const dimMatch = SMARTSCAPE_DIM_RE.exec(query.rewritten);
  const targetDim = dimMatch ? dimMatch[0] : undefined;
  const nodeType = dimMatch ? dimMatch[1]!.toUpperCase() : undefined;

  // 2. Event template — sync `{dims:...}` placeholders + the binding.
  const et = rewrittenValue.eventTemplate as { properties?: Array<{ key?: string; value?: unknown }> } | undefined;
  const props = Array.isArray(et?.properties) ? et!.properties! : [];
  const needsSync = props.some(
    (p) => typeof p?.value === 'string' && (p.value as string).includes('{dims:dt.entity.custom_device')
  );
  if (targetDim) {
    // The binding is rewritten whenever the query resolved to a Smartscape dim,
    // not only when a classic `{dims:...}` placeholder is present: a detector
    // can carry `{dt.source_entity}`, or no binding at all, and still need one.
    rewriteEntityBinding(props, targetDim, eventTemplateChanges);
    for (const p of props) {
      if (typeof p?.value !== 'string') continue;
      const { text, subs } = rewriteEventTemplateString(p.value, targetDim);
      if (subs.length) {
        for (const s of subs) eventTemplateChanges.push({ field: String(p.key ?? ''), before: s.before, after: s.after });
        p.value = text;
      }
    }
  } else if (needsSync || (query.rewritten !== query.original && props.some((p) => String(p?.key ?? '') === CLASSIC_BINDING_KEY))) {
    // We converted the query but it didn't resolve to a Smartscape dim, so the
    // binding can't be rewritten safely. Flag it rather than guess — the
    // failure mode is an alert that still fires but attaches to nothing.
    warnings.push({
      kind: 'custom-device-disambiguated',
      text:
        'Event template carries a classic entity binding but the query did not resolve to a ' +
        'dt.smartscape.<type> dimension — the alert binding could not be rewritten automatically. Verify manually.',
    });
  }

  // 3. Threshold.
  const classicKey = (CLASSIC_KEY_RE.exec(originalQuery) ?? [])[0];
  const thresholdInput = findInput(inputs, 'threshold');
  const thresholdAction = computeThresholdAction(thresholdInput?.value, classicKey, index);
  if (thresholdAction.kind === 'rescaled' && thresholdInput) {
    thresholdInput.value = String(thresholdAction.to);
  }
  if (thresholdAction.kind === 'blocked') {
    warnings.push({
      kind: 'recipe-aggregation-mismatch',
      text: `Static threshold NOT auto-converted: ${thresholdAction.reason}. Metric: ${thresholdAction.metric}.`,
    });
  }

  const changed =
    query.rewritten !== query.original ||
    eventTemplateChanges.length > 0 ||
    thresholdAction.kind === 'rescaled';

  return {
    changed,
    query,
    nodeType,
    targetDim,
    eventTemplateChanges,
    thresholdAction,
    warnings,
    transforms,
    rewrittenValue,
  };
}
