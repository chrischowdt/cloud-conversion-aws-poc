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
 *
 * For broader coverage including selector-modifier strip, prefix translation,
 * and dimension-suffix strip, prefer `lookupInExtraWithNormalization` —
 * it wraps this function and applies the full normalization chain ported
 * from `dt-migration/scripts/migration-lookup.ts`.
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

// ── Normalization helpers (ported from dt-migration/scripts/migration-lookup.ts) ──
//
// per-key-mappings.json is a denormalized cache: it carries the *exact* shapes
// the skill team's index produced, which means a single CloudWatch metric can
// appear there under several variants:
//   `builtin:cloud.aws.lambda.invocations`   (Grail builtin form — 193 entries)
//   `ext:cloud.aws.lambda.invocationsSum`    (Cassandra-era ext: — 5,409 entries)
//   `cloud.aws.lambda.<snakeCase>`           (bare Grail — 82 entries)
//   `dt.cloud.aws.lambda.<dotted>`           (rare — 25 entries)
//
// Dashboards in the wild use whichever shape the author picked. Exact-key
// lookup catches some; the normalization chain below converts between
// shapes and re-queries until something hits or we run out of variants.
//
// Stays in sync with the skill's `lookupMetricKey` implementation:
//   1. exact key
//   2. strip trailing `:avg`, `:splitBy(...)`, … selector modifiers
//   3a. `dt.cloud.<provider>.X` → `builtin:cloud.<provider>.X` (Grail prefix swap)
//   3b. `builtin:cloud.<provider>.X` → `builtin:<provider>.X` (Cassandra fallback)
//   4. strip `By[A-Z]…` dimension suffix and retry every variant above

/**
 * Strip a metric-selector modifier chain (`:avg`, `:splitBy(...)`, etc.).
 * Returns the base key (everything up to the first modifier-starting colon).
 * Honors the `builtin:`/`ext:` prefix's own colon — only modifiers AFTER the
 * prefix are stripped.
 */
export function stripSelectorModifiers(key: string): string {
  const lower = key.toLowerCase();
  if (lower.startsWith('builtin:') || lower.startsWith('ext:')) {
    const prefixEnd = key.indexOf(':') + 1;
    const rest = key.slice(prefixEnd);
    const colon = rest.indexOf(':');
    return colon !== -1 ? key.slice(0, prefixEnd + colon) : key;
  }
  // Bare keys: first colon starts modifiers.
  const colon = key.indexOf(':');
  return colon !== -1 ? key.slice(0, colon) : key;
}

/**
 * Normalize a Grail/Cassandra-era builtin key shape. Returns the next-form
 * variant or null when no further normalization applies.
 *
 *   `builtin:cloud.<provider>.X` → `builtin:<provider>.X`   (Cassandra)
 *   `dt.cloud.<provider>.X`      → `builtin:<provider>.X`   (older form)
 */
export function normalizeBuiltinKey(key: string): string | null {
  const lower = key.toLowerCase();
  if (lower.startsWith('builtin:cloud.')) {
    return 'builtin:' + key.slice('builtin:cloud.'.length);
  }
  const m = /^dt\.cloud\.(\w+)\.(.+)$/i.exec(key);
  if (m) return `builtin:${m[1]}.${m[2]}`;
  return null;
}

/**
 * Strip a `By<Capitalized>...` dimension suffix from a classic metric key.
 *   `ext:cloud.aws.lambda.invocationsSumByResource` → `ext:cloud.aws.lambda.invocationsSum`
 * Returns the stripped form, or null when no suffix is present.
 */
export function stripDimensionSuffix(key: string): string | null {
  const m = /By[A-Z][a-zA-Z]*$/.exec(key);
  return m ? key.slice(0, m.index) : null;
}

/**
 * Full normalization chain. Tries the original key first, then walks through
 * the variants above. Returns the first matching `ExtraMappingEntry` (still
 * lowercase-tolerant via the per-key file's normalized index) or null.
 *
 * Matches the behavior of `lookupMetricKey` in
 * `dt-migration/scripts/migration-lookup.ts` so dashboards covered by the
 * skill's own lookup also resolve here.
 */
export function lookupInExtraWithNormalization(
  index: ExtraMappingsIndex,
  classicKey: string
): ExtraMappingEntry | null {
  // Step 1: exact + lowercase (delegate to original).
  const direct = lookupInExtra(index, classicKey);
  if (direct) return direct;

  // Step 2: strip selector modifiers and retry.
  const stripped = stripSelectorModifiers(classicKey);
  const base = stripped !== classicKey ? stripped : classicKey;
  if (stripped !== classicKey) {
    const hit = lookupInExtra(index, stripped);
    if (hit) return hit;
  }

  // Step 3a: dt.cloud.<provider>.* → builtin:cloud.<provider>.*
  const grailMatch = /^dt\.cloud\.(\w+)\.(.+)$/i.exec(base);
  if (grailMatch) {
    const grailForm = `builtin:cloud.${grailMatch[1]}.${grailMatch[2]}`;
    const hit = lookupInExtra(index, grailForm);
    if (hit) return hit;
  }

  // Step 3b: Cassandra builtin fallback (older DAC entries).
  const cassandra = normalizeBuiltinKey(base);
  if (cassandra) {
    const hit = lookupInExtra(index, cassandra);
    if (hit) return hit;
  }

  // Step 4: strip By<Dim> suffix and retry the entire chain (base, grail, Cassandra).
  const dimStripped = stripDimensionSuffix(base);
  if (dimStripped && dimStripped !== base) {
    let hit = lookupInExtra(index, dimStripped);
    if (hit) return hit;
    if (grailMatch) {
      const grailDimStripped = stripDimensionSuffix(
        `builtin:cloud.${grailMatch[1]}.${grailMatch[2]}`
      );
      if (grailDimStripped) {
        hit = lookupInExtra(index, grailDimStripped);
        if (hit) return hit;
      }
    }
    if (cassandra) {
      const cassDimStripped = stripDimensionSuffix(cassandra);
      if (cassDimStripped && cassDimStripped !== cassandra) {
        hit = lookupInExtra(index, cassDimStripped);
        if (hit) return hit;
      }
    }
  }

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
