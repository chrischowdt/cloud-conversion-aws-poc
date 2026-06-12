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
 * Default minimum target-series count for an auto-override. A sibling with
 * only 1 live series is the weakest possible evidence — on an incompletely-
 * collected tenant it may be a single test resource rather than the intended
 * grain — so by policy we don't swap to it. Tunable via `minSeries`.
 */
export const DEFAULT_MIN_OVERRIDE_SERIES = 2;

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
  // Not enough evidence to override — thin (or, defensively, self) target.
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
