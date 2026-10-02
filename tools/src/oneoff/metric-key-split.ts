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

export interface CommandRange {
  /** Index just after the `timeseries` keyword. */
  start: number;
  /** Index of the first top-level `|`, or the end of the query. */
  end: number;
}

/** Locate the first `timeseries` command: from the keyword to its first top-level pipe. */
export function timeseriesCommand(q: string): CommandRange | null {
  const m = /\btimeseries\b/.exec(q);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < q.length; i++) {
    const c = q[i]!;
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === '|' && depth === 0) return { start, end: i };
  }
  return { start, end: q.length };
}

/** True when the timeseries command already carries a TOP-LEVEL `by:` clause. */
export function hasTopLevelBy(q: string): boolean {
  const range = timeseriesCommand(q);
  if (!range) return false;
  const s = q.slice(range.start, range.end);
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; continue; }
    if (c === ')' || c === '}' || c === ']') { depth--; continue; }
    if (depth === 0 && /^by\s*:/.test(s.slice(i)) && (i === 0 || /[\s,]/.test(s[i - 1]!))) return true;
  }
  return false;
}

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
