/**
 * Pure scanning helpers for the `timeseries` command inside a DQL string.
 *
 * DQL is not parsed here — these walk the text just far enough to answer two
 * structural questions the rewriter keeps needing: "where does this timeseries
 * command end?" and "does it already have a top-level by-clause?". Both must
 * ignore brackets, pipes and keywords that sit inside string literals or
 * comments, which a plain regex cannot do:
 *
 *   timeseries v = avg(x, filter:{matchesValue(n, "a|b")}) | filter ...
 *
 * No I/O, no dependencies — usable from the Dynatrace App as-is.
 */

export interface CommandRange {
  /** Index just after the `timeseries` keyword. */
  start: number;
  /** Index of the first top-level `|`, of an unmatched closer, or end of input. */
  end: number;
}

export interface ByClause {
  /** Index of the `{` that opens the by-clause. */
  open: number;
  /** Index of the matching `}`. */
  close: number;
}

/**
 * For every index: is this character CODE (true) or inside a string literal or a
 * comment (false)? Handles double- and single-quoted strings, backslash escapes,
 * `//` line comments and slash-star block comments.
 */
export function codeMask(q: string): boolean[] {
  const mask = new Array<boolean>(q.length).fill(true);
  let quote: string | null = null;
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    if (quote) {
      mask[i] = false;
      if (c === '\\') { if (i + 1 < q.length) mask[i + 1] = false; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; mask[i] = false; continue; }
    if (c === '/' && q[i + 1] === '/') {
      while (i < q.length && q[i] !== '\n') { mask[i] = false; i++; }
      continue;
    }
    if (c === '/' && q[i + 1] === '*') {
      const stop = q.indexOf('*/', i + 2);
      const last = stop < 0 ? q.length - 1 : stop + 1;
      for (let j = i; j <= last; j++) mask[j] = false;
      i = last;
    }
  }
  return mask;
}

/** Every `timeseries` command in the query, including ones nested in `append [ … ]`. */
export function timeseriesCommands(q: string): CommandRange[] {
  const mask = codeMask(q);
  const out: CommandRange[] = [];
  const re = /\btimeseries\b/g;
  for (let m = re.exec(q); m; m = re.exec(q)) {
    if (!mask[m.index]) continue;
    const start = m.index + m[0].length;
    let depth = 0;
    let end = q.length;
    for (let i = start; i < q.length; i++) {
      if (!mask[i]) continue;
      const c = q[i]!;
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        depth--;
        if (depth < 0) { end = i; break; }
      } else if (c === '|' && depth === 0) { end = i; break; }
    }
    out.push({ start, end });
  }
  return out;
}

/** The first `timeseries` command, or null. */
export function timeseriesCommand(q: string): CommandRange | null {
  return timeseriesCommands(q)[0] ?? null;
}

/**
 * The TOP-LEVEL by-clause of a command: `by:{…}` at brace depth zero, not one
 * buried in a filter or a function call.
 */
export function topLevelBy(q: string, cmd: CommandRange): ByClause | null {
  const mask = codeMask(q);
  let depth = 0;
  for (let i = cmd.start; i < cmd.end; i++) {
    if (!mask[i]) continue;
    const c = q[i]!;
    if (c === '(' || c === '{' || c === '[') { depth++; continue; }
    if (c === ')' || c === '}' || c === ']') { depth--; continue; }
    if (depth !== 0) continue;
    if (c !== 'b' || q[i + 1] !== 'y') continue;
    if (i > cmd.start && !/[\s,]/.test(q[i - 1]!)) continue;
    let j = i + 2;
    while (j < cmd.end && /\s/.test(q[j]!)) j++;
    if (q[j] !== ':') continue;
    j++;
    while (j < cmd.end && /\s/.test(q[j]!)) j++;
    if (q[j] !== '{') return null; // a by without braces: present, but not editable here
    let d = 0;
    for (let k = j; k < cmd.end; k++) {
      if (!mask[k]) continue;
      if (q[k] === '{') d++;
      else if (q[k] === '}' && --d === 0) return { open: j, close: k };
    }
    return null;
  }
  return null;
}

/** True when the FIRST timeseries command already carries a top-level `by:`. */
export function hasTopLevelBy(q: string): boolean {
  const cmd = timeseriesCommand(q);
  if (!cmd) return false;
  if (topLevelBy(q, cmd)) return true;
  // A `by:` with no braces still counts as split — never append a second one.
  const mask = codeMask(q);
  let depth = 0;
  for (let i = cmd.start; i < cmd.end; i++) {
    if (!mask[i]) continue;
    const c = q[i]!;
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (depth === 0 && c === 'b' && q[i + 1] === 'y' && /^by\s*:/.test(q.slice(i, cmd.end)) && (i === cmd.start || /[\s,]/.test(q[i - 1]!))) return true;
  }
  return false;
}

/**
 * Add `dim` to a command's by-clause. Returns the new query, the same query when
 * the dimension is already there, or null when the command has no editable
 * by-clause (the caller decides what that means — adding one would change the
 * query's grain).
 */
export function addByDimension(q: string, cmd: CommandRange, dim: string): string | null {
  const by = topLevelBy(q, cmd);
  if (!by) return null;
  const body = q.slice(by.open + 1, by.close);
  const present = body
    .split(',')
    .map((p) => p.trim().replace(/`/g, ''))
    .some((p) => p === dim || p.endsWith(`= ${dim}`) || p.endsWith(`=${dim}`));
  if (present) return q;
  if (body.trim() === '') return `${q.slice(0, by.open + 1)}${dim}${q.slice(by.close)}`;
  // Insert before the author's trailing space so `by: { d }` stays `by: { d, x }`.
  const before = q.slice(0, by.close);
  const trailing = /[ \t]*$/.exec(before)![0];
  return `${before.slice(0, before.length - trailing.length)}, ${dim}${trailing}${q.slice(by.close)}`;
}
