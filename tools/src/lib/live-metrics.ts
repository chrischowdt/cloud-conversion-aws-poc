/**
 * Live-metric inventory + dim-variant validation.
 *
 * The DAC mapping resolves a classic key to ONE new key with a specific
 * `.By.<Dim>` suffix, but that exact variant may have no series on the
 * tenant while a sibling variant (same metric, different dimensions) does.
 * `preferPopulatedVariant` consults a tenant's live-metric inventory
 * (`live-metrics.json`, produced by `discover-metrics`) and, ONLY when the
 * mapped key has zero series, swaps in the most-populated sibling.
 *
 * Conservative by design: a populated mapping is never second-guessed — we
 * only repair the empty-variant case. This precisely fixes the verified
 * nic55601 bug (`…DatabaseConnections.By.DBClusterIdentifier` = 0 series →
 * `…By.DBInstanceIdentifier` = 109) without touching mappings that work.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface LiveMetricsIndex {
  /** metric.key → series count (only keys with ≥1 series are present). */
  byKey: Map<string, number>;
  /** base (`cloud.aws.<svc>.<Metric>`, i.e. up to `.By.`) → variant keys. */
  byBase: Map<string, string[]>;
}

interface LiveMetricsFile {
  metrics: Record<string, number>;
}

/** Strip the `.By.<Dim>[.<Dim>…]` suffix, leaving `cloud.aws.<svc>.<Metric>`. */
export function metricBase(key: string): string {
  const idx = key.indexOf('.By.');
  return idx >= 0 ? key.slice(0, idx) : key;
}

export async function loadLiveMetrics(path: string): Promise<LiveMetricsIndex> {
  const file = JSON.parse(await readFile(path, 'utf8')) as LiveMetricsFile;
  const byKey = new Map<string, number>();
  const byBase = new Map<string, string[]>();
  for (const [key, count] of Object.entries(file.metrics ?? {})) {
    if (!count || count <= 0) continue;
    byKey.set(key, count);
    const base = metricBase(key);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base)!.push(key);
  }
  return { byKey, byBase };
}

/**
 * Resolve `<tenantDir>/live-metrics.json` if it exists, else undefined. Lets
 * the dashboard-pipeline commands opt into dim-validation automatically when
 * the tenant has been inventoried (`discover-metrics`), and stay unchanged
 * otherwise. Pass the result straight to `loadRecipeIndex({ liveMetricsPath })`.
 */
export function liveMetricsPathIfPresent(tenantDir: string | undefined): string | undefined {
  if (!tenantDir) return undefined;
  const p = join(tenantDir, 'live-metrics.json');
  return existsSync(p) ? p : undefined;
}

export interface VariantPreference {
  /** The key to use (possibly the same as the input). */
  key: string;
  /** True if we swapped to a different, populated variant. */
  overrode: boolean;
  /** When overrode: the original (empty) key. */
  from?: string;
  /** Series count of the chosen key (0 if not in inventory at all). */
  count: number;
}

/**
 * Minimum series a replacement variant must have before we swap to it. An
 * override is only ever considered when our own key has NO series, so the
 * comparison is "a variant with no data" vs "a variant with some" — and at the
 * default of 1, any populated sibling wins.
 *
 * This was 2, on the reasoning that a single-series sibling might be one test
 * resource rather than the intended grain. In practice that preserved panels
 * guaranteed to be empty, and reviewers corrected them by hand anyway — so the
 * caution cost more than it saved. Raise it (`--min-override-series`) to demand
 * stronger evidence; every override is warned about regardless.
 */
export const DEFAULT_MIN_OVERRIDE_SERIES = 1;

/**
 * Given a DAC/extra-resolved new key, return the key to actually use:
 *   - key has series → keep it (count reported).
 *   - key has NO series but a sibling (same base) has ≥ `minSeries` → swap to
 *     the highest-count sibling; ties break on fewest dimensions (simplest).
 *   - key has no series and no sibling clears the bar → keep it (caller still
 *     warns via mapped-no-recipe; we just couldn't confidently improve it).
 *
 * `minSeries` guards against swapping to a barely-populated variant when the
 * inventory is incomplete (see `DEFAULT_MIN_OVERRIDE_SERIES`).
 */
export function preferPopulatedVariant(
  index: LiveMetricsIndex,
  newKey: string,
  minSeries: number = DEFAULT_MIN_OVERRIDE_SERIES
): VariantPreference {
  const own = index.byKey.get(newKey);
  if (own && own > 0) return { key: newKey, overrode: false, count: own };

  const base = metricBase(newKey);
  const siblings = index.byBase.get(base);
  if (!siblings || siblings.length === 0) {
    return { key: newKey, overrode: false, count: 0 };
  }
  // Pick the most-populated sibling; tiebreak on fewest `.By.` dimensions.
  let best = siblings[0]!;
  for (const s of siblings) {
    const sc = index.byKey.get(s) ?? 0;
    const bc = index.byKey.get(best) ?? 0;
    if (sc > bc || (sc === bc && dimCount(s) < dimCount(best))) best = s;
  }
  const bestCount = index.byKey.get(best) ?? 0;
  // We only get here when OUR key has no series (a populated key returns above),
  // so the real choice is "a variant with no data" vs "a variant with some".
  // `minSeries` is the floor the replacement must clear; at the default of 1,
  // any populated sibling beats a dead key. Raising it demands more evidence.
  //
  // This used to default to 2, which preserved guaranteed-empty panels: reviewers
  // had to fix rds.Deadlocks.By.DBClusterIdentifier.Region.Role (absent from the
  // tenant) down to the 1-series `.By.DBClusterIdentifier` by hand, and the same
  // guard hid that dynamodb.SuccessfulRequestLatency.By.TableName has a
  // `.By.Operation.TableName` sibling carrying 248 series. Every override is
  // warned about and every asset is human-reviewed before publish, so offering
  // the populated variant is strictly more useful than offering nothing.
  if (best === newKey || bestCount < minSeries) {
    return { key: newKey, overrode: false, count: own ?? 0 };
  }
  return { key: best, overrode: true, from: newKey, count: bestCount };
}

function dimCount(key: string): number {
  const idx = key.indexOf('.By.');
  if (idx < 0) return 0;
  return key.slice(idx + 4).split('.').length;
}

/**
 * Statistic words classic bakes onto the end of a metric name
 * (`..._sum`, `..._count`). The polled metric carries the statistic separately.
 */
const TRAILING_STAT = /_(sum|avg|average|max|maximum|min|minimum|count|value)$/;

/** `http_code_target_5xx_count_sum_by_availability_zone` -> `httpcodetarget5xxcount` */
function squashClassicMetricName(metric: string): string[] {
  const out = new Set<string>();
  let m = metric.toLowerCase();
  const by = m.indexOf('_by_');
  if (by > 0) m = m.slice(0, by);
  out.add(m.replace(/_/g, ''));
  let stripped = m;
  // Classic sometimes stacks two (`..._count_sum`), so peel at most twice.
  for (let i = 0; i < 2 && TRAILING_STAT.test(stripped); i++) {
    stripped = stripped.replace(TRAILING_STAT, '');
    out.add(stripped.replace(/_/g, ''));
  }
  return [...out].filter(Boolean);
}

/**
 * Find a live polled metric whose NAME matches a classic snake_case key, within
 * the same service namespace. Returns the live key or undefined.
 *
 * Evidence-based by construction: every candidate comes from the tenant's own
 * inventory, so a match is a metric that is demonstrably producing data. It is
 * still a name match, not a semantic one — callers must surface it for review.
 */
export function matchLiveMetricByName(index: LiveMetricsIndex, classicKey: string): string | undefined {
  const m = /^(?:builtin:|ext:|dt\.)?cloud\.aws\.([a-z0-9_]+)\.(.+)$/.exec(classicKey);
  if (!m) return undefined;
  const service = m[1]!.toLowerCase();
  const wanted = new Set(squashClassicMetricName(m[2]!));
  if (wanted.size === 0) return undefined;

  let best: { key: string; series: number } | undefined;
  for (const [key, series] of index.byKey) {
    const p = /^cloud\.aws\.([a-z0-9_]+)\.([A-Za-z0-9_]+?)(?:\.By\..*)?$/.exec(key);
    if (!p || p[1]!.toLowerCase() !== service) continue;
    if (!wanted.has(p[2]!.toLowerCase().replace(/_/g, ''))) continue;
    // Several dimensional variants can match; prefer the one carrying data.
    if (!best || series > best.series) best = { key, series };
  }
  return best?.key;
}
