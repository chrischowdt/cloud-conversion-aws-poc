/**
 * DAC (Dynamic AWS Cloudwatch) metric-mapping lookup.
 *
 * Source: `dt-migration/references/dac-aws-to-2ndgen-metrics.json` — the
 * authoritative classic→new metric mapping the skill recommends as primary
 * before falling back to heuristic rules. Contains ~4,168 entries (1,092 with
 * dacRecommended, 4,168 with dacAutodiscovered, 291 with classic built-in
 * keys, 3,710 with classic non-built-in ext: keys).
 *
 * Each DAC entry looks like:
 *   {
 *     cloudwatchNamespace:    "AWS/Lambda",
 *     cloudwatchMetricName:   "Invocations",
 *     cloudwatchDimensions:   ["FunctionName"],
 *     secondGenMetricKey:     "ext:cloud.aws.lambda.invocationsSum",
 *     dacRecommendedMetricKey: "cloud.aws.lambda.Invocations.By.FunctionName",
 *     dacAutodiscoveredMetricKey: "cloud.aws.lambda.Invocations.By.FunctionName",
 *     builtInMetricKey:       "builtin:cloud.aws.lambda.invocations",
 *     endOfLife:              false
 *   }
 *
 * We build indexes by every classic key shape a dashboard might reference:
 *
 *   1. exact `builtInMetricKey`             — e.g. `builtin:cloud.aws.lambda.invocations`
 *   2. exact `secondGenMetricKey`           — e.g. `ext:cloud.aws.lambda.invocationsSum`
 *   3. `dt.cloud.aws.*` form  (= builtin:cloud.aws.* with the prefix swapped)
 *   4. bare `cloud.aws.<svc>.<snake_case>`  (= secondGenMetricKey with the
 *      `ext:cloud.aws.` prefix dropped and the metric segment converted from
 *      camelCase to snake_case)
 *
 * Lookup returns the **best** new key for that classic ref:
 *   - prefer `dacRecommendedMetricKey` (available in recommended metric
 *     collection — no extra config needed on the new connection),
 *   - else `dacAutodiscoveredMetricKey` (available but needs "recommended +
 *     custom" with this metric added explicitly).
 *
 * When multiple DAC entries share the same classic key (typical for built-in
 * metric keys that have several dimension variants), the entry with a
 * `dacRecommendedMetricKey` wins; ties break on smallest dimension count.
 */

import { readFile } from 'node:fs/promises';

export interface DacEntry {
  cloudwatchNamespace: string;
  cloudwatchMetricName: string;
  cloudwatchDimensions: string[];
  secondGenMetricKey: string;
  dacRecommendedMetricKey: string;
  dacAutodiscoveredMetricKey: string;
  builtInMetricKey: string;
  endOfLife: boolean;
}

export interface DacLookupResult {
  /** Best new-connection key (recommended preferred). */
  newDtMetricKey: string;
  availability: 'recommended' | 'autodiscovered';
  cloudwatchNamespace: string;
  cloudwatchMetricName: string;
  cloudwatchDimensions: string[];
  endOfLife: boolean;
}

export interface DacIndex {
  byClassicKey: Map<string, DacEntry>;
}

const NOT_MATCHED = 'not-matched';

function isMatched(v: string | undefined): v is string {
  return !!v && v !== NOT_MATCHED;
}

/** camelCase → snake_case. e.g. "invocationsSumByResource" → "invocations_sum_by_resource". */
function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Score a DAC entry for "best match" selection when multiple entries share
 * the same classic key. Higher is better.
 *   +1000 if dacRecommendedMetricKey present
 *   -dim count (prefer entries with fewer dimensions, which usually represent
 *    the simplest / most universal form)
 */
function entryScore(e: DacEntry): number {
  const dim = e.cloudwatchDimensions?.length ?? 99;
  return (isMatched(e.dacRecommendedMetricKey) ? 1000 : 0) - dim;
}

function pickBetter(a: DacEntry, b: DacEntry): DacEntry {
  return entryScore(a) >= entryScore(b) ? a : b;
}

/** Add `entry` to `map` under `key`, keeping the higher-scored entry on conflict. */
function addKeyed(map: Map<string, DacEntry>, key: string, entry: DacEntry): void {
  const existing = map.get(key);
  map.set(key, existing ? pickBetter(existing, entry) : entry);
}

export async function loadDacIndex(path: string): Promise<DacIndex> {
  const entries = JSON.parse(await readFile(path, 'utf8')) as DacEntry[];
  const byClassicKey = new Map<string, DacEntry>();

  for (const e of entries) {
    // Skip rows with no new-side key at all — they can't help us anyway.
    if (!isMatched(e.dacRecommendedMetricKey) && !isMatched(e.dacAutodiscoveredMetricKey)) {
      continue;
    }

    // 1. exact builtin:cloud.aws.* (Cassandra-era built-in selector)
    if (isMatched(e.builtInMetricKey)) {
      addKeyed(byClassicKey, e.builtInMetricKey, e);
      // 3. dt.cloud.aws.* — the Grail-era built-in form is the same key with
      //    the prefix swapped (e.g. builtin:cloud.aws.lambda.invocations ↔
      //    dt.cloud.aws.lambda.invocations).
      const dtForm = e.builtInMetricKey.replace(/^builtin:cloud\./, 'dt.cloud.');
      addKeyed(byClassicKey, dtForm, e);
    }

    // 2. exact ext:cloud.aws.* (Cassandra-era non-built-in selector)
    if (isMatched(e.secondGenMetricKey)) {
      addKeyed(byClassicKey, e.secondGenMetricKey, e);
      // 4. bare cloud.aws.<svc>.<snake_case> — the Grail non-built-in form,
      //    derived by dropping the `ext:cloud.aws.` prefix and snake-casing
      //    the metric segment.
      const m = /^ext:(cloud\.aws\.[a-zA-Z0-9_]+)\.([A-Za-z0-9]+)$/.exec(e.secondGenMetricKey);
      if (m) {
        const svc = m[1]!;
        const metric = camelToSnake(m[2]!);
        addKeyed(byClassicKey, `${svc}.${metric}`, e);
      }
    }
  }

  return { byClassicKey };
}

export function lookupInDac(index: DacIndex, classicKey: string): DacLookupResult | null {
  const entry = index.byClassicKey.get(classicKey);
  if (!entry) return null;
  if (isMatched(entry.dacRecommendedMetricKey)) {
    return {
      newDtMetricKey: entry.dacRecommendedMetricKey,
      availability: 'recommended',
      cloudwatchNamespace: entry.cloudwatchNamespace,
      cloudwatchMetricName: entry.cloudwatchMetricName,
      cloudwatchDimensions: entry.cloudwatchDimensions ?? [],
      endOfLife: entry.endOfLife,
    };
  }
  if (isMatched(entry.dacAutodiscoveredMetricKey)) {
    return {
      newDtMetricKey: entry.dacAutodiscoveredMetricKey,
      availability: 'autodiscovered',
      cloudwatchNamespace: entry.cloudwatchNamespace,
      cloudwatchMetricName: entry.cloudwatchMetricName,
      cloudwatchDimensions: entry.cloudwatchDimensions ?? [],
      endOfLife: entry.endOfLife,
    };
  }
  return null;
}
