/**
 * Count `metric.series` per metric key without hitting Grail's silent cap.
 *
 * WHY: `fetch metric.series` returns at most 100,000 series records, and says
 * nothing when it stops there (no notification, `sampled: false`). Measured on
 * nic55601 2026-10-27: every AWS query came back at exactly 100,000, and so did
 * rds alone; one region of rds was 100,000 and the rest 98,064. The old
 * single-query inventory therefore held only a sample of the keys — 524 keys
 * seen over 3 days were missing from the 10-day run, which is impossible for a
 * complete one. A missing key looks "empty" to the dim-variant override.
 *
 * HOW: the cap applies AFTER the filter, so split by key prefix. Count a
 * prefix; if the total reaches the cap, the keys in that capped sample tell us
 * which next characters exist. Count each `prefix + c`, then the remainder
 * (`prefix` minus those characters), which catches keys the sample missed.
 * Recurse wherever a part is still capped. A single key over the cap is
 * reported at the cap and listed in `capped`.
 */

export const SERIES_CAP = 100_000;

/**
 * One slice of the key space: a key exactly, or keys starting with `prefix`.
 * With `rest`, only keys LONGER than the prefix whose next character is not
 * in `exclude`. `without` drops keys already counted at the cap.
 */
export type SeriesPart = { exact: string } | { prefix: string; rest?: { exclude: string[] }; without?: string[] };

/** One counting query: series per key for the keys in the part. */
export type SeriesCounter = (part: SeriesPart) => Promise<Record<string, number>>;

export interface SeriesInventory {
  metrics: Record<string, number>;
  /** Keys whose own count reached the cap (true count is higher). */
  capped: string[];
  queries: number;
}

const lit = (s: string): string => JSON.stringify(s);

/** The DQL filter selecting a part's keys. */
export function partFilter(part: SeriesPart): string {
  if ('exact' in part) return `metric.key == ${lit(part.exact)}`;
  let f = `startsWith(metric.key, ${lit(part.prefix)})`;
  if (part.rest) {
    const at = part.prefix.length;
    f += ` and stringLength(metric.key) > ${at}`;
    if (part.rest.exclude.length) {
      f += ` and not in(substring(metric.key, from:${at}, to:${at + 1}), array(${part.rest.exclude.map(lit).join(', ')}))`;
    }
  }
  if (part.without?.length) f += ` and not in(metric.key, array(${part.without.map(lit).join(', ')}))`;
  return f;
}

export interface InventoryOptions {
  cap?: number;
  /** Queries in flight at once. Default 4. */
  concurrency?: number;
  /** Called after each query with the running totals. */
  onProgress?: (queries: number, keys: number) => void;
}

export async function inventorySeries(
  count: SeriesCounter,
  rootPrefix: string,
  opts: InventoryOptions = {},
): Promise<SeriesInventory> {
  const cap = opts.cap ?? SERIES_CAP;
  const metrics: Record<string, number> = {};
  const capped: string[] = [];
  let queries = 0;

  // A simple semaphore: the recursion fans out freely, the tenant sees at
  // most `concurrency` queries at a time.
  let free = Math.max(1, opts.concurrency ?? 4);
  const waiting: Array<() => void> = [];
  const run = async (part: SeriesPart): Promise<Record<string, number>> => {
    if (free === 0) await new Promise<void>((r) => waiting.push(r));
    else free--;
    try {
      return await count(part);
    } finally {
      queries++;
      opts.onProgress?.(queries, Object.keys(metrics).length);
      const next = waiting.shift();
      if (next) next();
      else free++;
    }
  };
  const total = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);

  const visit = async (prefix: string, rest?: { exclude: string[] }, without: string[] = []): Promise<void> => {
    const mine = without.filter((k) => k.startsWith(prefix));
    const rows = await run({ prefix, rest, without: mine.length ? mine : undefined });
    if (total(rows) < cap) {
      Object.assign(metrics, rows);
      return;
    }
    const sample = Object.keys(rows);
    if (sample.length === 1) {
      // One key filled the whole capped sample, so it alone is over the cap.
      // Record it and look at the rest without it, instead of walking down
      // its name one character at a time (19 EC2/EBS keys on nic55601).
      const k = sample[0]!;
      metrics[k] = rows[k]!;
      capped.push(k);
      return visit(prefix, rest, [...mine, k]);
    }
    const at = prefix.length;
    const work: Array<Promise<void>> = [];
    if (!rest && !mine.includes(prefix)) {
      // The prefix may itself be a key (the capped sample need not show it):
      // count it alone; everything below is about the longer keys.
      work.push(
        run({ exact: prefix }).then((own) => {
          const n = own[prefix] ?? 0;
          if (n > 0) metrics[prefix] = n;
          if (n >= cap) capped.push(prefix);
        }),
      );
    }
    const fresh = [...new Set(Object.keys(rows).filter((k) => k.length > at).map((k) => k.slice(at, at + 1)))].sort();
    // Keys under `prefix` whose next character the capped sample never showed
    // (with no `rest` yet and an empty `fresh`, that is simply the longer keys).
    work.push(visit(prefix, { exclude: [...(rest?.exclude ?? []), ...fresh] }, mine));
    // A capped `rest` part has only longer keys with fresh characters, so
    // `fresh` is non-empty there and the remainder above always shrinks.
    for (const c of fresh) work.push(visit(prefix + c, undefined, mine));
    await Promise.all(work);
  };

  await visit(rootPrefix);
  return { metrics, capped, queries };
}
