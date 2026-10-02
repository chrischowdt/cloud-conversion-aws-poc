/**
 * Pass 1.52 — classic entity-id PINS → a filter on the metric's `aws.arn`.
 *
 * A classic query can pin one resource by entity id:
 *
 *   timeseries …, filter: { dt.entity.custom_device == "CUSTOM_DEVICE-CFF4D22E40425D17" }
 *   timeseries …, by:{dt.entity.custom_device} | filter dt.entity.custom_device == "…"
 *   … filter: { in(dt.entity.custom_device, "CUSTOM_DEVICE-A…", "CUSTOM_DEVICE-B…") }
 *
 * Convert the dimension and leave the literal and the result is
 * `dt.smartscape.<type> == "CUSTOM_DEVICE-…"` — different id spaces, never equal,
 * silently empty. See entity-arns.ts for the evidence and why the ARN is the key.
 *
 * Runs while dimensions are still CLASSIC (before the dt.entity → dt.smartscape
 * sweep), and only on a query whose metric key was actually swapped to the new
 * form: classic series carry no `aws.arn`, so on an unmapped metric the filter
 * would match nothing — and the rewriter's `metricUnmapped` flag already blocks
 * that query for the right reason.
 *
 * Two shapes, because after `timeseries … by:{dim}` only the by-dimensions
 * survive as columns:
 *   - inside the command's `filter:{}`  → substitute in place;
 *   - post-aggregation `| filter`       → substitute AND add `aws.arn` to the
 *     by-clause. It is 1:1 with the resource a pin names, so the grain is unchanged.
 *
 * It refuses to half-convert: an `in(…)` whose ids do not ALL resolve is left
 * whole and warned, because converting some would silently narrow the scope.
 */

import type { Transform, Warning } from './dql-rewriter.ts';
import { addByDimension, codeMask, timeseriesCommands, topLevelBy } from './dql-command.ts';
import { entityScope } from './entity-mappings.ts';
import type { EntityArnIndex } from './entity-arns.ts';

const ARN_DIM = 'aws.arn';

const CMP = /(`?dt\.entity\.([a-z0-9_:]+)`?)\s*(==|!=)\s*"([A-Z][A-Z0-9_:]*-[0-9A-F]{16})"/g;
const IN_OPEN = /\bin\(\s*(`?dt\.entity\.([a-z0-9_:]+)`?)\s*,/g;
const ID_LITERAL = /"([A-Z][A-Z0-9_:]*-[0-9A-F]{16})"/g;

interface Hit {
  start: number;
  end: number;
  text: string;
  dimType: string;
  ids: string[];
  /** `==`/`!=` for a comparison, 'in' for an in(…) call. */
  op: '==' | '!=' | 'in';
}

/** Index of the `)` that closes the `(` at `open`, skipping strings and comments. */
function closingParen(q: string, mask: boolean[], open: number): number {
  let depth = 0;
  for (let i = open; i < q.length; i++) {
    if (!mask[i]) continue;
    if (q[i] === '(') depth++;
    else if (q[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function findHits(q: string, mask: boolean[]): Hit[] {
  const hits: Hit[] = [];

  CMP.lastIndex = 0;
  for (let m = CMP.exec(q); m; m = CMP.exec(q)) {
    if (!mask[m.index]) continue;
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
      dimType: m[2]!,
      ids: [m[4]!],
      op: m[3] as '==' | '!=',
    });
  }

  IN_OPEN.lastIndex = 0;
  for (let m = IN_OPEN.exec(q); m; m = IN_OPEN.exec(q)) {
    if (!mask[m.index]) continue;
    const open = m.index + m[0].indexOf('(');
    const close = closingParen(q, mask, open);
    if (close < 0) continue;
    const args = q.slice(m.index + m[0].length, close);
    // Pure id lists only: `"A", "B"` or `array("A", "B")`. A variable or a call
    // in the list means we do not understand the filter, so we leave it alone.
    const leftover = args.replace(ID_LITERAL, '').replace(/array\s*\(/g, '').replace(/[\s,()]/g, '');
    const ids = [...args.matchAll(ID_LITERAL)].map((x) => x[1]!);
    if (leftover !== '' || ids.length === 0) continue;
    hits.push({
      start: m.index,
      end: close + 1,
      text: q.slice(m.index, close + 1),
      dimType: m[2]!,
      ids,
      op: 'in',
    });
  }
  return hits.sort((a, b) => a.start - b.start);
}

export function rewriteEntityIdPins(
  input: string,
  arns: EntityArnIndex | undefined,
  transforms: Transform[],
  warnings: Warning[]
): string {
  const cmds = timeseriesCommands(input);
  if (!cmds.length) return input;
  const mask = codeMask(input);

  // Only AWS-scope entities, and only where the id's own type prefix matches the
  // dimension it is compared with — anything stranger is not a pin we understand.
  const hits = findHits(input, mask).filter(
    (h) => entityScope(h.dimType) === 'aws' && h.ids.every((id) => id.startsWith(`${h.dimType.toUpperCase()}-`))
  );
  if (!hits.length) return input;

  const inCommand = (i: number) => cmds.some((c) => i >= c.start && i < c.end);
  // A post-aggregation filter can only see by-dimensions, so it needs exactly one
  // timeseries command with an editable by-clause to put `aws.arn` into.
  const canExtendBy = cmds.length === 1 && topLevelBy(input, cmds[0]!) !== null;

  const warn = (h: Hit, why: string) =>
    warnings.push({
      kind: 'entity-id-unresolved',
      text:
        `This query pins a resource by classic entity id (${h.ids.join(', ')}). A classic id can never equal a ` +
        `Smartscape dimension, so the filter would match nothing — ${why} Left unconverted; resolve the ` +
        `resource by hand (its ARN is the key: filter the metric on aws.arn).`,
      match: h.text,
    });

  const accepted: Array<{ hit: Hit; replacement: string; arns: string[]; post: boolean }> = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.start < lastEnd) continue; // overlapping match — keep the first
    const entries = h.ids.map((id) => arns?.get(id));
    const missing = h.ids.filter((_, i) => !entries[i]?.arn);
    if (missing.length) {
      const reason = !arns
        ? 'no entity-arns.json is loaded for this tenant (run `cct discover-entity-arns`).'
        : `no ARN is known for ${missing.join(', ')} (${entries[h.ids.indexOf(missing[0]!)]?.missing ?? 'not discovered — run `cct discover-entity-arns`'}).`;
      warn(h, reason);
      continue;
    }
    const post = !inCommand(h.start);
    if (post && !canExtendBy) {
      warn(h, 'it filters after aggregation but the query has no single by-clause to carry aws.arn.');
      continue;
    }
    const arnList = entries.map((e) => e!.arn as string);
    const replacement =
      h.op === 'in'
        ? `in(${ARN_DIM}, array(${arnList.map((a) => JSON.stringify(a)).join(', ')}))`
        : `${ARN_DIM} ${h.op} ${JSON.stringify(arnList[0])}`;
    accepted.push({ hit: h, replacement, arns: arnList, post });
    lastEnd = h.end;
  }
  if (!accepted.length) return input;

  // Right to left, so earlier indices stay valid.
  let out = input;
  for (const a of [...accepted].reverse()) out = out.slice(0, a.hit.start) + a.replacement + out.slice(a.hit.end);

  if (accepted.some((a) => a.post)) {
    const after = timeseriesCommands(out);
    const extended = after.length === 1 ? addByDimension(out, after[0]!, ARN_DIM) : null;
    if (extended !== null) out = extended;
  }

  for (const a of accepted) {
    const names = a.hit.ids.map((id) => arns?.get(id)?.name).filter(Boolean).join(', ');
    transforms.push({
      kind: 'entity-dim',
      before: a.hit.text,
      after: a.replacement,
      detail:
        `classic entity-id pin → ${ARN_DIM} filter${names ? ` (${names})` : ''}` +
        (a.post ? '; aws.arn added to the by-clause so the post-aggregation filter can see it' : ''),
    });
  }
  return out;
}
