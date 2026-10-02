/**
 * One-off repair: restore the dimensional split that an automated port dropped.
 *
 * A classic METRIC_KEY metric event is evaluated per entity — Dynatrace splits
 * automatically. The anomaly detectors ported from them were written as a bare
 * `timeseries val = avg(<key>)`, which collapses the whole fleet into ONE series;
 * a per-resource threshold on a fleet average is an alert that cannot fire.
 * Measured on nic55601 (Amazon Redshift percentage disk space used): the live
 * detector saw a fleet peak of 35.9% against a threshold of 95 while one cluster
 * sat at 99.0%.
 *
 * This is NOT part of the translator. It repairs the SOURCE detectors, in their
 * classic form, so the normal pipeline then translates a correct query. Pure
 * string work only — no I/O — so it can be tested without a tenant.
 */

import { hasTopLevelBy, timeseriesCommand } from '../lib/dql-command.ts';

// Re-exported so callers (and the tests) keep one import site.
export { hasTopLevelBy, timeseriesCommand };

export type SplitResult =
  | { ok: true; query: string }
  | { ok: false; reason: 'no-timeseries' | 'already-split' | 'comment-in-command' };

/**
 * Append `, by:{<dim>}` to the timeseries command. Refuses rather than guesses:
 *  - `already-split`: idempotent, a re-run changes nothing.
 *  - `comment-in-command`: a `//` inside the command could swallow the appended
 *    clause, so a human decides.
 */
export function addEntitySplit(q: string, dim: string): SplitResult {
  const range = timeseriesCommand(q);
  if (!range) return { ok: false, reason: 'no-timeseries' };
  if (hasTopLevelBy(q)) return { ok: false, reason: 'already-split' };
  const command = q.slice(0, range.end);
  if (command.slice(range.start).includes('//')) return { ok: false, reason: 'comment-in-command' };
  const head = command.replace(/\s+$/, '');
  const trailingWhitespace = command.slice(head.length);
  return { ok: true, query: `${head}, by:{${dim}}${trailingWhitespace}${q.slice(range.end)}` };
}

/** The name of the first series the command assigns, e.g. `val` in `timeseries val = avg(x)`. */
export function firstSeriesName(q: string): string | null {
  const m = /\btimeseries\s+(?:\{\s*)?([A-Za-z_]\w*)\s*=/.exec(q);
  return m ? m[1]! : null;
}
