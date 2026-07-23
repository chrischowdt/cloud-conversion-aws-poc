/**
 * metric-reconcile — pure logic for reconciling a tenant's *classic* metric
 * keys against what the *new* integration currently collects, so an operator
 * can decide which metric keys to ADD to the new connection.
 *
 * The premise (once classic + new run side-by-side on every account): for each
 * classic key with data, we (a) map it to its new-integration equivalent via
 * the mapping chain, then (b) check that equivalent against the live new-metric
 * inventory (`discover-metrics`). Three questions fall out:
 *
 *   - Is the new integration ALREADY collecting an equivalent?  → no action.
 *   - Does a known new equivalent exist but isn't collected here? → ADD (the
 *     metric is in the DAC catalog; enable it in "recommended + custom").
 *   - Is there NO standard new equivalent at all?                → the metric
 *     must be scraped as a custom/arbitrary key (the Metric Streams case).
 *
 * For the unmapped tail (keys the chain can't resolve), we still answer the
 * reconciliation question from the live inventory using a data-driven
 * classic→new *service* bridge (built from the pairs that DID map) plus a
 * conservative metric-name match. That match is heuristic and always labelled
 * "verify" — it exists to stop us telling an operator to add a metric the new
 * integration already collects under a name we couldn't key-map.
 *
 * All functions here are pure (no I/O); the `reconcile-metrics` command wires
 * them to the mapping index + tenant JSON and emits the CSV/markdown.
 */

import type { LookupResult } from './recipe-lookup.ts';
import { metricBase } from './live-metrics.ts';

/** One discovered classic key with its tenant series count. */
export interface ClassicKey {
  metricKey: string;
  classicSeries: number;
}

/** The `.By.`-stripped, non-alphanumeric-free lowercase metric NAME of a key. */
export function metricNameFlat(metricKey: string): string {
  const parts = metricKey.split('.');
  // cloud . aws . <service> . <name...>  → everything from segment 3 on.
  let name = parts.slice(3).join('.');
  if (!name) return '';
  // Drop the dimension suffix in any shape: new `.By.Dim`, classic snake
  // `_by_x_y`, or classic camel `ByXY`.
  const byIdx = name.search(/(\.By\.|_by_|By[A-Z])/);
  if (byIdx >= 0) name = name.slice(0, byIdx);
  // Drop a single trailing CloudWatch statistic token (Sum/Average/…). Bare
  // "count" is left alone — it's part of names like RequestCount / 4XXCount.
  name = name.replace(/[._]?(sum|average|avg|maximum|minimum|max|min|samplecount|p\d+)$/i, '');
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** Service segment of a key: the 3rd dot-segment (`cloud.aws.<service>.…`). */
export function serviceOf(metricKey: string): string {
  return metricKey.split('.')[2] ?? '';
}

/**
 * The live new-connection inventory, indexed for reconciliation lookups.
 */
export interface InventoryIndex {
  /** Exact live keys present (with series > 0). */
  keys: Set<string>;
  /** `metricBase` (up to `.By.`) of every live key. */
  bases: Set<string>;
  /** Distinct new-connection service segments present. */
  services: Set<string>;
  /** Live key → series count. */
  series: Map<string, number>;
  /** New service → set of `metricNameFlat` of that service's live keys. */
  svcNames: Map<string, Set<string>>;
}

export function buildInventoryIndex(metrics: Record<string, number>): InventoryIndex {
  const keys = new Set<string>();
  const bases = new Set<string>();
  const services = new Set<string>();
  const series = new Map<string, number>();
  const svcNames = new Map<string, Set<string>>();
  for (const [key, count] of Object.entries(metrics)) {
    if (!(count > 0)) continue;
    keys.add(key);
    bases.add(metricBase(key));
    series.set(key, count);
    const svc = serviceOf(key);
    services.add(svc);
    const nm = metricNameFlat(key);
    if (nm) {
      let set = svcNames.get(svc);
      if (!set) svcNames.set(svc, (set = new Set()));
      set.add(nm);
    }
  }
  return { keys, bases, services, series, svcNames };
}

/**
 * Build the classic→new service bridge from the pairs that mapped cleanly:
 * classic service → the new service its mapped keys most often land in
 * (`aurora`→`rds`, `ec`→`elasticache`, `containerinsights`→`ecs_containerinsights`).
 */
export function buildServiceBridge(pairs: Array<[string, string]>): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const [cs, ns] of pairs) {
    if (!cs || !ns) continue;
    let inner = counts.get(cs);
    if (!inner) counts.set(cs, (inner = new Map()));
    inner.set(ns, (inner.get(ns) ?? 0) + 1);
  }
  const bridge = new Map<string, string>();
  for (const [cs, inner] of counts) {
    const best = [...inner.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) bridge.set(cs, best[0]);
  }
  return bridge;
}

export type Recommendation =
  /** New integration already collects this exact variant. */
  | 'collected'
  /** Metric is flowing, but under a different `.By.<dim>` than the mapped one. */
  | 'collected-other-dim'
  /** Mapped to a known new key that isn't collected here — enable it. */
  | 'add-to-new'
  /** Unmapped, but the service is onboarded and a same-name metric is present. */
  | 'unmapped-likely-collected'
  /** Unmapped, service onboarded, metric not found — add it (recommended+custom). */
  | 'unmapped-add-metric'
  /** Unmapped and the service isn't collected at all — custom/Metric Streams. */
  | 'custom-or-metric-streams';

export interface ReconRow {
  classicKey: string;
  classicSeries: number;
  mappedNewKey: string;
  mappingTier: 'recipe' | 'composite' | 'manual' | 'per-key' | 'dac' | 'mapped' | 'unmapped';
  availability: string;
  newService: string;
  inInventory: 'exact' | 'other-dim' | 'no';
  newSeries: number;
  recommendation: Recommendation;
  evidence: string;
}

/** Derive {newKey, tier, availability} from a LookupResult. */
export function describeMapping(res: LookupResult): {
  newKey: string;
  tier: ReconRow['mappingTier'];
  availability: string;
} {
  switch (res.kind) {
    case 'recipe':
      return { newKey: res.entry.newDtMetricKey ?? '', tier: 'recipe', availability: 'verified' };
    case 'composite':
      return {
        newKey: res.formula.components.map((c) => c.newDtMetricKey).join(' + '),
        tier: 'composite',
        availability: 'verified',
      };
    case 'mapped-no-recipe': {
      const notes = res.entry.notes ?? '';
      const tier: ReconRow['mappingTier'] = /manual-metric-mappings/.test(notes)
        ? 'manual'
        : /per-key-mappings/.test(notes)
          ? 'per-key'
          : /Resolved via DAC/.test(notes)
            ? 'dac'
            : 'mapped';
      const availability = /autodiscovered/.test(notes)
        ? 'autodiscovered'
        : /recommended/.test(notes)
          ? 'recommended'
          : '';
      return { newKey: res.entry.newDtMetricKey ?? '', tier, availability };
    }
    default:
      return { newKey: '', tier: 'unmapped', availability: '' };
  }
}

/**
 * Classify a single classic key. Pure — everything it needs is passed in.
 */
export function classifyRow(
  classic: ClassicKey,
  res: LookupResult,
  inv: InventoryIndex,
  bridge: Map<string, string>
): ReconRow {
  const { newKey, tier, availability } = describeMapping(res);
  const classicSvc = serviceOf(classic.metricKey);

  if (tier !== 'unmapped' && newKey) {
    // A mapped key may be a composite (`a + b`); check the first concrete key
    // for the service segment but evaluate presence over all components.
    const components = newKey.split(' + ');
    const primary = components[0]!;
    const newService = serviceOf(primary);
    const allExact = components.every((k) => inv.keys.has(k));
    const allBase = components.every((k) => inv.bases.has(metricBase(k)));
    const newSeries = components.reduce((s, k) => s + (inv.series.get(k) ?? 0), 0);
    let inInventory: ReconRow['inInventory'];
    let recommendation: Recommendation;
    let evidence: string;
    if (allExact) {
      inInventory = 'exact';
      recommendation = 'collected';
      evidence = 'exact new key present in inventory';
    } else if (allBase) {
      inInventory = 'other-dim';
      recommendation = 'collected-other-dim';
      evidence = 'metric present under a different .By.<dim>';
    } else {
      inInventory = 'no';
      recommendation = 'add-to-new';
      evidence =
        availability === 'autodiscovered'
          ? 'known new key, not collected here — add via recommended+custom'
          : 'known new key, not collected here — enable in the new connection';
    }
    return {
      classicKey: classic.metricKey,
      classicSeries: classic.classicSeries,
      mappedNewKey: newKey,
      mappingTier: tier,
      availability,
      newService,
      inInventory,
      newSeries,
      recommendation,
      evidence,
    };
  }

  // Unmapped — answer from the inventory via the service bridge.
  const bridged = bridge.get(classicSvc);
  const candidateSvc = bridged && inv.services.has(bridged)
    ? bridged
    : inv.services.has(classicSvc)
      ? classicSvc
      : '';
  const nameFlat = metricNameFlat(classic.metricKey);
  let recommendation: Recommendation;
  let evidence: string;
  if (!candidateSvc) {
    recommendation = 'custom-or-metric-streams';
    evidence = `service "${classicSvc}" not collected by the new integration`;
  } else {
    const names = inv.svcNames.get(candidateSvc);
    const match =
      nameFlat.length >= 3 && names
        ? [...names].find((n) => n === nameFlat || n.includes(nameFlat) || nameFlat.includes(n))
        : undefined;
    if (match) {
      recommendation = 'unmapped-likely-collected';
      evidence = `service ${candidateSvc} collects a same-name metric (${match}); verify dim/grain`;
    } else {
      recommendation = 'unmapped-add-metric';
      evidence = `service ${candidateSvc} onboarded but no matching metric name found — add it`;
    }
  }
  return {
    classicKey: classic.metricKey,
    classicSeries: classic.classicSeries,
    mappedNewKey: '',
    mappingTier: 'unmapped',
    availability: '',
    newService: candidateSvc,
    inInventory: 'no',
    newSeries: 0,
    recommendation,
    evidence,
  };
}

/** True when a recommendation means "an operator should add this key". */
export function isActionable(r: Recommendation): boolean {
  return r === 'add-to-new' || r === 'unmapped-add-metric' || r === 'custom-or-metric-streams';
}
