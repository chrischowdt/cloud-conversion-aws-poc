/**
 * Supplemental classic-key → new-key lookups loaded from the dt-migration
 * skill, sitting between our recipe table and the DAC fallback in
 * `recipe-lookup.ts`.
 *
 * Two source files, both shipped under `dt-migration/references/`:
 *
 *   1. `manual-metric-mappings.json` — ~117 hand-curated abbreviations that
 *      will NEVER round-trip through DAC normalization (e.g.
 *      `cloud.aws.alb.bytes`, `cloud.aws.aurora.*_by_role`,
 *      `cloud.aws.eccustom.*`, `cloud.aws.rds.free`). These are Dynatrace
 *      shorthands, not algorithmic CloudWatch derivations.
 *
 *   2. `per-key-mappings.json` — ~5,709 pre-resolved entries from the skill's
 *      own normalization chain (selector-strip, dt.cloud→builtin:cloud,
 *      dimension-suffix strip, service-segment scan). Catches keys whose
 *      shape we'd otherwise miss — most usefully a Cassandra-style
 *      `builtin:aws.X` fallback and lowercased-snake `ext:` keys.
 *
 * Manual mappings take precedence over per-key when both have an entry.
 */

import { readFile } from 'node:fs/promises';

export type ExtraAvailability = 'recommended' | 'autodiscovered';

export interface ExtraMappingEntry {
  classicKey: string;
  newKey: string;
  availability: ExtraAvailability;
  /** Which file the entry came from — surfaced in rewriter warnings. */
  source: 'manual' | 'per-key';
}

export interface ExtraMappingsIndex {
  /** Exact-key lookup. Covers the manual shapes verbatim. */
  byKey: Map<string, ExtraMappingEntry>;
  /**
   * Lowercased lookup. The per-key file is keyed by fully-lowercased shapes
   * (`ext:cloud.aws.sagemakerendpointinstances.cpuutilizationaveragebyvariantname`),
   * and dashboards in the wild use mixed case. Looking up under
   * `key.toLowerCase()` here lets us hit per-key entries even when the
   * dashboard's classic key still has CamelCase from the v2 API era.
   */
  byLowerKey: Map<string, ExtraMappingEntry>;
}

interface ManualEntry {
  classic_key: string;
  new_key: string;
  availability: ExtraAvailability;
}

interface PerKeyEntry {
  bestDacKey: string;
  availability: ExtraAvailability;
}

export async function loadExtraMappings(opts: {
  manualPath?: string;
  perKeyPath?: string;
}): Promise<ExtraMappingsIndex> {
  const byKey = new Map<string, ExtraMappingEntry>();
  const byLowerKey = new Map<string, ExtraMappingEntry>();

  // Per-key first, so manual can overwrite when both apply (manual wins).
  if (opts.perKeyPath) {
    const raw = JSON.parse(await readFile(opts.perKeyPath, 'utf8')) as Record<string, PerKeyEntry>;
    for (const [classicKey, v] of Object.entries(raw)) {
      if (!v?.bestDacKey) continue;
      const entry: ExtraMappingEntry = {
        classicKey,
        newKey: v.bestDacKey,
        availability: v.availability,
        source: 'per-key',
      };
      byKey.set(classicKey, entry);
      byLowerKey.set(classicKey.toLowerCase(), entry);
    }
  }

  if (opts.manualPath) {
    const raw = JSON.parse(await readFile(opts.manualPath, 'utf8')) as ManualEntry[];
    for (const m of raw) {
      if (!m.classic_key || !m.new_key) continue;
      const entry: ExtraMappingEntry = {
        classicKey: m.classic_key,
        newKey: m.new_key,
        availability: m.availability,
        source: 'manual',
      };
      byKey.set(m.classic_key, entry);
      byLowerKey.set(m.classic_key.toLowerCase(), entry);
    }
  }

  return { byKey, byLowerKey };
}

/**
 * Look up a classic metric key. Tries exact match first, then lowercased
 * (to pick up per-key entries when the dashboard preserved CamelCase from
 * the v2 API). Returns `null` when neither file has the key.
 */
export function lookupInExtra(
  index: ExtraMappingsIndex,
  classicKey: string
): ExtraMappingEntry | null {
  const exact = index.byKey.get(classicKey);
  if (exact) return exact;
  const lower = index.byLowerKey.get(classicKey.toLowerCase());
  if (lower) return lower;
  return null;
}

/**
 * Derive a human-readable service name from a new-form key
 * (`cloud.aws.<service>.<MetricName>.By.<Dims>` → `<service>`). Used to
 * populate the synthetic `MappingEntry.service` field when surfacing extra
 * lookups through `lookupClassicKey`.
 */
export function serviceFromNewKey(newKey: string): string {
  const m = /^cloud\.aws\.([a-z0-9_]+)\./.exec(newKey);
  return m ? m[1]! : 'aws';
}
