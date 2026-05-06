/**
 * Parsers for DQL `timeseries` results.
 *
 * The shape Grail returns for `timeseries name = avg(metric_key), interval: 5m, from: ..., to: ...`
 * is one record per dimension combination, like:
 *
 *   {
 *     "timeframe": { "start": "2026-04-30T00:00:00Z", "end": "2026-05-01T00:00:00Z" },
 *     "interval": "PT5M",          // ISO 8601 duration; sometimes "300000000000" ns
 *     "name": [1.2, 3.4, null, ...],
 *     "<dim_a>": "value",          // dimension columns when grouped by:
 *     "<dim_b>": "value"
 *   }
 *
 * This parser reconstructs explicit `{ts, value}` arrays from those.
 */

import type { TimeSeriesPoint } from './stats.ts';

export interface ParsedSeries {
  /** Human-readable label, including dimensions when present. */
  label: string;
  /** Original record's dimension fields (everything that wasn't an array). */
  dimensions: Record<string, unknown>;
  points: TimeSeriesPoint[];
}

const NS_PER_MS = 1_000_000n;

function parseInterval(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    // Heuristic: very large → nanoseconds; otherwise milliseconds.
    return value >= 1_000_000 ? Math.round(value / 1_000_000) : value;
  }
  if (typeof value === 'bigint') {
    return Number(value / NS_PER_MS);
  }
  if (typeof value === 'string') {
    // ISO 8601 duration: PT5M, PT30S, PT1H, PT1H30M, etc.
    const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(value);
    if (m) {
      const h = parseFloat(m[1] ?? '0');
      const min = parseFloat(m[2] ?? '0');
      const s = parseFloat(m[3] ?? '0');
      return Math.round((h * 3600 + min * 60 + s) * 1000);
    }
    // Numeric string (assume nanoseconds if huge, else ms).
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n >= 1_000_000 ? Math.round(n / 1_000_000) : n;
    }
  }
  return null;
}

function parseEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value / NS_PER_MS);
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
    const n = Number(value);
    if (Number.isFinite(n)) return n >= 1_000_000_000_000_000 ? Math.round(n / 1_000_000) : n;
  }
  return null;
}

/**
 * Pull all named series out of a single DQL `timeseries` record.
 *
 * Strategy:
 *   - Find the `timeframe.start` (epoch ms) and `interval` (ms).
 *   - Any field whose value is an array of numbers (or numbers/null) is a
 *     series. Reconstruct `{ts, value}` from `start + i*interval`.
 *   - Anything else is a dimension/metadata field.
 */
export function parseTimeseriesRecord(
  record: Record<string, unknown>,
  preferredSeriesName?: string
): ParsedSeries[] {
  const tf = record['timeframe'] as Record<string, unknown> | undefined;
  const start = parseEpochMs(tf?.['start']);
  const interval = parseInterval(record['interval']);

  // Find array fields (the actual series).
  const seriesFields: Array<[string, Array<number | null>]> = [];
  const dims: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === 'timeframe' || k === 'interval') continue;
    if (Array.isArray(v) && v.every((x) => x === null || typeof x === 'number')) {
      seriesFields.push([k, v as Array<number | null>]);
    } else {
      dims[k] = v;
    }
  }

  if (seriesFields.length === 0 || start === null || interval === null) {
    return [];
  }

  const fields = preferredSeriesName
    ? seriesFields.filter(([k]) => k === preferredSeriesName)
    : seriesFields;

  return (fields.length > 0 ? fields : seriesFields).map(([name, values]) => {
    const points: TimeSeriesPoint[] = values.map((value, i) => ({
      ts: start + i * interval,
      value,
    }));
    const dimLabel = Object.keys(dims).length === 0
      ? ''
      : ' [' + Object.entries(dims).map(([k, v]) => `${k}=${String(v)}`).join(', ') + ']';
    return { label: name + dimLabel, dimensions: dims, points };
  });
}

/** Sum across all returned series at each timestamp; useful when classic aggregates per-entity but you want the tenant total. */
export function combineSeries(serieses: ParsedSeries[]): TimeSeriesPoint[] {
  if (serieses.length === 0) return [];
  if (serieses.length === 1) return serieses[0]!.points;
  const byTs = new Map<number, { sum: number; count: number }>();
  for (const s of serieses) {
    for (const p of s.points) {
      if (p.value === null || Number.isNaN(p.value)) continue;
      const acc = byTs.get(p.ts) ?? { sum: 0, count: 0 };
      acc.sum += p.value;
      acc.count++;
      byTs.set(p.ts, acc);
    }
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, { sum, count }]) => ({ ts, value: count === 0 ? null : sum / count }));
}
