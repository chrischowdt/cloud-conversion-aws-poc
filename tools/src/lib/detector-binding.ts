/**
 * detector-binding — attach a migrated alert to its entity when the classic
 * query never named one.
 *
 * WHY: a classic AWS alert grouped by the resource's own dimensions
 * (`by:{aws.account.id, aws.region, `Cluster Name`}`) converts to a query with
 * no Smartscape dimension. It still fires, but attached to nothing, so BigPanda
 * gets no entity. Reviewers fixed this by hand on batches 09-10 (2026-10).
 *
 * The fix is to group by the series' OWN entity, `dt.smartscape_source.id`:
 *   - Every new-connection series of a resource service carries it (100% of
 *     series for 57 services on nic55601, 2026-10-27; only the account-level
 *     ones — usage, bedrock, da, zscaler — have none).
 *   - It is always the right grain: an RDS cluster metric's series point at the
 *     cluster node, an instance metric's at the instance, so no node type has to
 *     be chosen (the hand-fixed Aurora alert in batch 09 had bound the wrong one).
 *   - It binds. 30 days of CUSTOM_ALERT events on nic55601: detectors grouping
 *     by `dt.smartscape_source.id` with the `{dt.smartscape_source.id}` property
 *     bound 22/22 (AWS) and 473/473 (other) events. The same property with no
 *     such dimension in the query bound 0 of 1.26M — the property must name a
 *     column the query emits.
 *   - It fits next to enriched or spaced dims. A reviewer note said the node dim
 *     "can't be combined" with `Cluster Name`; measured, it can: 4 series either
 *     way, each now carrying its cluster id.
 *
 * Adding a dimension can only SPLIT groups, never merge them. So when the query
 * returns the same number of series with and without it, nothing was split and
 * the alert's grain is unchanged. That check needs the tenant, so this module
 * only builds the candidate (`bindingCandidate`) and applies it
 * (`applySourceBinding`); the stager runs the comparison.
 *
 * When the count DOES change, the classic alert combined several resources into
 * one series. The entity is added anyway, so the alert fires per resource: in
 * all 3 such alerts in batches 01-10 the reviewers chose that, and an entity on
 * every alert is what Dynatrace needs to correlate it (user decision,
 * 2026-10-27). The card then asks for a threshold check. The one exception is a
 * split past Davis's limit of 10,000 monitored series per detector, beyond which
 * it silently stops monitoring new ones.
 */

import { codeMask, timeseriesCommands, topLevelBy, hasTopLevelBy, addByDimension } from './dql-command.ts';
import type { DetectorRewriteResult } from './detector-rewrite.ts';
import type { Warning } from './dql-rewriter.ts';

export const SOURCE_ID_DIM = 'dt.smartscape_source.id';
export const SOURCE_ID_BINDING = `{${SOURCE_ID_DIM}}`;
const BINDING_KEY = 'dt.smartscape_source.id';

/** AWS services whose new-connection series carry no entity (measured: 0% of series). */
const NO_SOURCE_SERVICES = new Set(['usage', 'da', 'bedrock', 'zscaler_cloudconnectors']);

/** Most series one Davis anomaly detector monitors; past it, new ones are silently ignored. */
export const DAVIS_SERIES_CAP = 10_000;

/**
 * Commands that may follow the timeseries without dropping or regrouping its
 * columns. `fieldsRemove` is safe too unless it names the added column, and
 * `fields`/`fieldsKeep` keep only what they list, so the column is added to the
 * list. Anything else (`summarize`, `makeTimeseries`, `join`, `append`, …) could
 * lose the added dimension or change the grain, so those queries are left for a
 * person.
 */
const SAFE_FOLLOWERS = new Set(['filter', 'filterOut', 'fieldsAdd', 'fieldsRename', 'sort', 'limit', 'lookup']);
const KEEP_LISTS = new Set(['fields', 'fieldsKeep']);

export type BindingCandidate = { ok: true; query: string } | { ok: false; reason: string };

interface Follower {
  name: string;
  /** Index of the command's `|`. */
  start: number;
  /** Index of the next top-level `|`, or end of input. */
  end: number;
}

/** The top-level pipeline commands after the first one. */
function followingCommands(q: string): Follower[] {
  const mask = codeMask(q);
  const pipes: number[] = [];
  let depth = 0;
  for (let i = 0; i < q.length; i++) {
    if (!mask[i]) continue;
    const c = q[i]!;
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === '|' && depth === 0) pipes.push(i);
  }
  return pipes.map((start, k) => ({
    name: /^\|\s*([A-Za-z]+)/.exec(q.slice(start))?.[1] ?? '?',
    start,
    end: pipes[k + 1] ?? q.length,
  }));
}

/** Index just after the last CODE character in [from, to): an insertion point that never lands inside a trailing comment. */
function lastCodeEnd(q: string, mask: boolean[], from: number, to: number): number {
  let at = to;
  while (at > from && (!mask[at - 1] || /\s/.test(q[at - 1]!))) at--;
  return at;
}

const NAMES_SOURCE_ID = /(^|[^\w.])dt\.smartscape_source\.id(?![\w.])/;

/** Is the by-clause (if any) already emitting a Smartscape entity column? */
export function bindsAnEntity(q: string): boolean {
  const cmds = timeseriesCommands(q);
  if (cmds.length !== 1) return false;
  const by = topLevelBy(q, cmds[0]!);
  if (!by) return false;
  const body = q.slice(by.open + 1, by.close);
  return /dt\.smartscape\.[a-z0-9_]+|dt\.smartscape_source\.id/.test(body);
}

/**
 * The entity column the query's split EMITS, to name in the alert's
 * `dt.smartscape_source.id` property; the property binds nothing unless it names
 * an emitted column. An alias `dt.smartscape_source.id = dt.smartscape.X` emits
 * `dt.smartscape_source.id`, not `dt.smartscape.X`: 25 Lower alerts had that
 * split with a `{dt.smartscape.X}` property (2026-10-27). Keeps `current` when it
 * already names an emitted column, else prefers a node dim (the form measured
 * binding 2,086 of 2,089 events).
 */
export function emittedEntityColumn(q: string, current?: string): string | undefined {
  const cmds = timeseriesCommands(q);
  if (cmds.length !== 1) return undefined;
  const by = topLevelBy(q, cmds[0]!);
  if (!by) return undefined;
  const mask = codeMask(q);
  const entries: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = by.open + 1; i < by.close; i++) {
    const c = mask[i] ? q[i]! : ' ';
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    if (c === ',' && depth === 0) { entries.push(cur); cur = ''; } else cur += c;
  }
  entries.push(cur);
  const columns = entries.map((e) => {
    const alias = /^\s*`?([\w.]+)`?\s*=(?!=)/.exec(e);
    return alias ? alias[1]! : e.trim().replace(/`/g, '');
  });
  const entity = columns.filter((c) => c === SOURCE_ID_DIM || /^dt\.smartscape\.[a-z0-9_]+$/.test(c));
  if (!entity.length) return undefined;
  const named = current ? /^\{([^}]+)\}$/.exec(current.trim())?.[1] : undefined;
  if (named && entity.includes(named)) return named;
  return entity.find((c) => c !== SOURCE_ID_DIM) ?? SOURCE_ID_DIM;
}

/**
 * The query with `dt.smartscape_source.id` added to its split, or why not.
 * Static checks only; the caller must still verify the series count.
 */
export function bindingCandidate(q: string): BindingCandidate {
  const cmds = timeseriesCommands(q);
  if (cmds.length !== 1) return { ok: false, reason: cmds.length ? 'more than one timeseries command' : 'not a timeseries query' };
  const cmd = cmds[0]!;
  const mask = codeMask(q);
  const head = q.slice(0, cmd.start).split('').filter((_, i) => mask[i]).join('').trim();
  if (head !== 'timeseries') return { ok: false, reason: 'timeseries is not the first command' };
  if (bindsAnEntity(q)) return { ok: false, reason: 'already split by an entity' };

  const body = q.slice(cmd.start, cmd.end);
  const keys = [...body.matchAll(/cloud\.aws\.([a-z0-9_]+)\.[\w.]+/g)];
  if (!keys.length) return { ok: false, reason: 'reads no AWS metric' };
  for (const k of keys) {
    if (NO_SOURCE_SERVICES.has(k[1]!)) return { ok: false, reason: `${k[1]} series carry no entity` };
    if (!k[0].includes('.By.')) return { ok: false, reason: `${k[0]} is not a new-connection key` };
  }
  const followers = followingCommands(q);
  const bad = followers.find(
    (f) => !SAFE_FOLLOWERS.has(f.name) && !KEEP_LISTS.has(f.name) && !(f.name === 'fieldsRemove' && !NAMES_SOURCE_ID.test(q.slice(f.start, f.end))),
  );
  if (bad) return { ok: false, reason: `a later \`${bad.name}\` could drop or regroup the added dimension` };

  // A `fields`/`fieldsKeep` after the split would drop the new column; list it.
  // Edits run back to front and all sit after the timeseries, so `cmd` and the
  // mask stay valid for the by-clause edit below.
  let out = q;
  for (const f of [...followers].reverse()) {
    if (!KEEP_LISTS.has(f.name) || NAMES_SOURCE_ID.test(q.slice(f.start, f.end))) continue;
    const at = lastCodeEnd(q, mask, f.start, f.end);
    out = `${out.slice(0, at)}, ${SOURCE_ID_DIM}${out.slice(at)}`;
  }

  const by = topLevelBy(out, cmd);
  if (by) {
    const next = addByDimension(out, cmd, SOURCE_ID_DIM);
    return next && next !== out ? { ok: true, query: next } : { ok: false, reason: 'by-clause could not be edited' };
  }
  if (hasTopLevelBy(out)) return { ok: false, reason: 'by-clause could not be edited' };
  // No split at all: add one after the command's last code character.
  const at = lastCodeEnd(q, mask, cmd.start, cmd.end);
  return { ok: true, query: `${out.slice(0, at)}, by:{${SOURCE_ID_DIM}}${out.slice(at)}` };
}

export interface BindingOutcome {
  /**
   * `bound`: grain unchanged. `per-entity`: the split now alerts per resource.
   * `unverified`: bound, but no data to check the grain. The rest stay unbound.
   */
  kind: 'already' | 'bound' | 'per-entity' | 'unverified' | 'skipped' | 'too-many' | 'error';
  /** The bound query, for `bound`, `per-entity` and `unverified`. */
  query?: string;
  /** Card text for a bound query. */
  note?: string;
  /** Why the alert stays unbound, or what to check about a binding. */
  warning?: Warning;
}

const unbound = (why: string): Warning => ({
  kind: 'alert-unbound',
  text: `This alert will not attach to an entity (BigPanda receives none): ${why}`,
});

const SET_PROPERTY = 'Set the event property below in the detector settings.';

/**
 * Bind `q` by its series' own entity where the query shape allows it. `count`
 * runs a query and returns how many series it produced (reporting more than
 * `DAVIS_SERIES_CAP` is enough); adding a dimension can only split groups, so
 * equal counts mean the grain is unchanged.
 */
export async function resolveBinding(q: string, count: (q: string) => Promise<number>, window = 'the last 7 days'): Promise<BindingOutcome> {
  if (bindsAnEntity(q)) return { kind: 'already' };
  const c = bindingCandidate(q);
  if (!c.ok) return { kind: 'skipped', warning: unbound(`${c.reason}, so \`${SOURCE_ID_DIM}\` was not added automatically.`) };
  let before: number;
  let after: number;
  try {
    [before, after] = await Promise.all([count(q), count(c.query)]);
  } catch (e) {
    return { kind: 'error', warning: unbound(`the check that adding \`${SOURCE_ID_DIM}\` is safe could not run (${String((e as Error).message).slice(0, 80)}).`) };
  }
  if (after > DAVIS_SERIES_CAP) {
    return {
      kind: 'too-many',
      warning: unbound(`adding \`${SOURCE_ID_DIM}\` would split it into more than ${DAVIS_SERIES_CAP.toLocaleString('en-US')} series over ${window}, the most one Davis detector monitors.`),
    };
  }
  if (before === 0) {
    return {
      kind: 'unverified',
      query: c.query,
      note: `added \`${SOURCE_ID_DIM}\` to the split so the alert attaches to its entity. ${SET_PROPERTY}`,
      warning: {
        kind: 'alert-per-entity',
        text:
          `No data in ${window}, so it is unproven whether adding \`${SOURCE_ID_DIM}\` keeps this alert's grain. ` +
          'Once data flows, compare the series count with and without it: if it grows, the alert now fires per resource and its threshold needs a look.',
      },
    };
  }
  if (after < before) {
    return { kind: 'error', warning: unbound(`the check returned fewer series with \`${SOURCE_ID_DIM}\` (${after}) than without (${before}), which should not happen.`) };
  }
  if (after > before) {
    return {
      kind: 'per-entity',
      query: c.query,
      note: `added \`${SOURCE_ID_DIM}\` to the split, so the alert now evaluates each resource on its own: ${before} series became ${after} over ${window}, each with its own entity. ${SET_PROPERTY}`,
      warning: {
        kind: 'alert-per-entity',
        text:
          `The classic alert combined several resources into each series (${before} series; ${after} per resource). ` +
          'It now alerts per resource, so check that the threshold still fits a single resource.',
      },
    };
  }
  return {
    kind: 'bound',
    query: c.query,
    note: `added \`${SOURCE_ID_DIM}\` to the split: ${before} series with and without it over ${window}, so the grain is unchanged and each series now carries its own entity. ${SET_PROPERTY}`,
  };
}

/**
 * Apply a VERIFIED candidate to a detector rewrite: the new query in the
 * detector value, the binding property, and the report entries.
 */
export function applySourceBinding(r: DetectorRewriteResult, query: string, detail: string): void {
  if (!r.query) return;
  const before = r.query.rewritten;
  r.query = { ...r.query, rewritten: query };
  const analyzer = r.rewrittenValue.analyzer as { input?: Array<{ key?: string; value?: string }> } | undefined;
  for (const i of analyzer?.input ?? []) {
    if ((i.key === 'query' || i.key === 'query.expression') && i.value === before) i.value = query;
  }
  const et = (r.rewrittenValue.eventTemplate ??= { properties: [] }) as { properties?: Array<{ key?: string; value?: unknown }> };
  const props = (et.properties ??= []);
  const existing = props.find((p) => p.key === BINDING_KEY);
  const classic = props.find((p) => p.key === 'dt.source_entity');
  if (existing) {
    if (existing.value !== SOURCE_ID_BINDING) {
      // rewriteDetector may already have pointed the property at a node dim the
      // query only FILTERS on (never emits); report one change, not two.
      const prior = r.eventTemplateChanges.find((x) => x.field === BINDING_KEY || x.field.endsWith(`→ ${BINDING_KEY}`));
      if (prior) prior.after = SOURCE_ID_BINDING;
      else r.eventTemplateChanges.push({ field: BINDING_KEY, before: String(existing.value ?? ''), after: SOURCE_ID_BINDING });
      existing.value = SOURCE_ID_BINDING;
    }
  } else if (classic) {
    r.eventTemplateChanges.push({ field: `dt.source_entity → ${BINDING_KEY}`, before: String(classic.value ?? ''), after: SOURCE_ID_BINDING });
    classic.key = BINDING_KEY;
    classic.value = SOURCE_ID_BINDING;
  } else {
    r.eventTemplateChanges.push({ field: BINDING_KEY, before: '(absent)', after: SOURCE_ID_BINDING });
    props.push({ key: BINDING_KEY, value: SOURCE_ID_BINDING });
  }
  r.transforms.push({ kind: 'entity-dim', before: '(no entity in the split)', after: `by:{…, ${SOURCE_ID_DIM}}`, detail });
  r.targetDim = SOURCE_ID_DIM;
  r.changed = true;
}
