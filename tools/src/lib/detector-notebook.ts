/**
 * detector-notebook — build a REVIEW NOTEBOOK for a batch of rewritten Davis
 * anomaly detectors, and read the reviewer's fixed queries back out.
 *
 * Why a notebook (not a staged copy): an anomaly detector is a live, armed
 * object — publishing a second one double-alerts. A notebook is inert: it
 * executes DQL as a read and never emits an event. So reviewers validate/fix
 * the translated query live, with zero alerting risk, and the script reads the
 * corrected query back and applies it IN PLACE to the existing detector (a
 * Settings PUT — never a new object).
 *
 * Layout (query-only review, per the migration-team decision): one MARKDOWN
 * tile + one DQL tile per detector, batched N-per-notebook. The markdown tile
 * summarizes the automated changes (node type, threshold action, binding
 * rewrite, warnings) for a sanity-check; the DQL tile carries the runnable
 * rewritten query wrapped with a read-back marker and the original classic
 * query as reference comments.
 *
 * Pure + colocated-tested. No fetch/fs — the command layer owns I/O.
 */

import type { Warning } from './dql-rewriter.ts';
import { isBlockingWarning } from './dql-rewriter.ts';
import type { EventTemplateChange, ThresholdAction } from './detector-rewrite.ts';

export type ReviewBucket = 'clean' | 'soft' | 'blocked';

export interface DetectorReviewItem {
  objectId: string;
  title: string;
  original: string;
  rewritten: string;
  nodeType?: string;
  targetDim?: string;
  thresholdAction: ThresholdAction;
  eventTemplateChanges: EventTemplateChange[];
  warnings: Warning[];
  bucket: ReviewBucket;
}

/** Minimal notebook `content` shape the Document Service accepts (`type: notebook`). */
export interface NotebookContent {
  version: string;
  defaultTimeframe: { from: string; to: string };
  defaultSegments: unknown[];
  sections: NotebookSection[];
}
export type NotebookSection = MarkdownSection | DqlSection;
export interface MarkdownSection {
  id: string;
  type: 'markdown';
  markdown: string;
}
export interface DqlSection {
  id: string;
  type: 'dql';
  filterSegments: unknown[];
  drilldownPath: unknown[];
  previousFilterSegments: unknown[];
  height: number;
  state: {
    input: { timeframe: { from: string; to: string }; value: string };
    visualization: string;
    visualizationSettings: Record<string, unknown>;
    querySettings: Record<string, unknown>;
  };
}

// 24h, not the notebook UI's usual 2h. Many AWS metrics are sparse (throttles,
// deadlocks, timeouts fire rarely) and several poll at 5-15m, so a 2h window
// showed "no data" for queries that were actually correct — which is exactly the
// signal a reviewer must not be misled about. Verified: a converted DynamoDB
// throttle query returned nothing at 2h and real series at 24h.
const DEFAULT_TIMEFRAME = { from: 'now()-24h', to: 'now()' };
const DEFAULT_QUERY_SETTINGS = {
  maxResultRecords: 1000,
  defaultScanLimitGbytes: 500,
  maxResultMegaBytes: 1,
  defaultSamplingRatio: 10,
  enableSampling: false,
};
const DEFAULT_VIZ_SETTINGS = {
  thresholds: [] as unknown[],
  chartSettings: { gapPolicy: 'gap' },
  table: {},
  autoSelectVisualization: true,
};

// ─── read-back markers ────────────────────────────────────────────────────
// The DQL tile value is wrapped so the objectId travels WITH the text and the
// reviewer's editable region is delimited. All marker lines are `//` comments,
// so the query still runs cleanly in the notebook with the scaffold present.

const DETECTOR_MARKER_PREFIX = '// [CCT-DETECTOR objectId=';
const ORIGINAL_MARKER = '// [CCT-ORIGINAL] classic query below — reference only, ignored when run';
export const DETECTOR_MARKER_RE = /^\/\/ \[CCT-DETECTOR objectId=([^\]\s]+)\]/m;

/** Wrap a rewritten query with the read-back marker + the original as comments. */
export function buildReviewQuery(objectId: string, rewritten: string, original: string): string {
  const origCommented = original
    .split('\n')
    .map((l) => `// ${l}`)
    .join('\n');
  return (
    `${DETECTOR_MARKER_PREFIX}${objectId}]\n` +
    `${rewritten.trim()}\n\n` +
    `${ORIGINAL_MARKER}\n${origCommented}\n`
  );
}

/**
 * Read the reviewer's (possibly edited) query back out of a DQL tile value.
 * Returns the objectId parsed from the marker and the clean query — everything
 * between the marker line and the ORIGINAL block, with the scaffold stripped.
 */
export function parseReviewQuery(value: string): { objectId?: string; query: string } {
  const m = DETECTOR_MARKER_RE.exec(value);
  const objectId = m?.[1];
  let q = value;
  const origIdx = q.indexOf('// [CCT-ORIGINAL]');
  if (origIdx >= 0) q = q.slice(0, origIdx);
  q = q.replace(DETECTOR_MARKER_RE, '').trim();
  return { objectId, query: q };
}

// ─── markdown tile ──────────────────────────────────────────────────────────

const BUCKET_BADGE: Record<ReviewBucket, string> = {
  clean: '🟢 clean',
  soft: '🟡 review',
  blocked: '🔴 blocked',
};

function thresholdLine(a: ThresholdAction): string {
  switch (a.kind) {
    case 'rescaled':
      return `**Threshold:** auto-rescaled ${a.from} → ${a.to} (${a.reason}).`;
    case 'blocked':
      return `**Threshold:** ⚠️ NOT converted — ${a.reason}. **Reset it manually.**`;
    case 'unchanged':
      return `**Threshold:** unchanged (${a.reason}).`;
    case 'none':
      return `**Threshold:** none on this analyzer.`;
  }
}

/** The per-detector markdown tile: what changed + what to check. */
export function buildDetectorMarkdown(item: DetectorReviewItem): string {
  const lines: string[] = [];
  lines.push(`### ${BUCKET_BADGE[item.bucket]} — ${item.title}`);
  lines.push('');
  lines.push(`\`detector ${item.objectId}\``);
  lines.push('');
  if (item.nodeType) lines.push(`**Resolved node:** \`${item.nodeType}\` (\`${item.targetDim}\`)`);
  lines.push(thresholdLine(item.thresholdAction));
  if (item.eventTemplateChanges.length) {
    lines.push(
      `**Alert binding rewritten:** ${item.eventTemplateChanges.length} placeholder(s) → the Smartscape dim ` +
        `(incl. \`dt.source_entity\`). Verify the fired-event entity looks right.`
    );
  }
  const blocking = item.warnings.filter((w) => isBlockingWarning(w.kind));
  const soft = item.warnings.filter((w) => !isBlockingWarning(w.kind));
  if (blocking.length) {
    lines.push('');
    lines.push('**Blocking — needs manual work:**');
    for (const w of dedupe(blocking.map((w) => w.text))) lines.push(`- 🔴 ${firstLine(w)}`);
  }
  if (soft.length) {
    lines.push('');
    lines.push('**Verify:**');
    for (const w of dedupe(soft.map((w) => w.text)).slice(0, 8)) lines.push(`- 🟡 ${firstLine(w)}`);
  }
  lines.push('');
  lines.push('**Run the query below**, fix if needed, then save. Leave the `// [CCT-…]` lines intact.');
  return lines.join('\n');
}

function firstLine(s: string): string {
  return s.split('\n')[0]!.trim();
}
function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

// ─── notebook assembly ──────────────────────────────────────────────────────

function dqlSection(objectId: string, value: string): DqlSection {
  return {
    id: `dql-${objectId}`,
    type: 'dql',
    filterSegments: [],
    drilldownPath: [],
    previousFilterSegments: [],
    height: 320,
    state: {
      input: { timeframe: { ...DEFAULT_TIMEFRAME }, value },
      visualization: 'table',
      visualizationSettings: structuredClone(DEFAULT_VIZ_SETTINGS),
      querySettings: { ...DEFAULT_QUERY_SETTINGS },
    },
  };
}

function batchHeader(label: string, items: DetectorReviewItem[]): MarkdownSection {
  const counts = items.reduce(
    (a, it) => ((a[it.bucket] = (a[it.bucket] ?? 0) + 1), a),
    {} as Record<ReviewBucket, number>
  );
  const md = [
    `# AWS alert migration review — ${label}`,
    '',
    `${items.length} anomaly detector(s): ` +
      `${counts.clean ?? 0} 🟢 clean · ${counts.soft ?? 0} 🟡 review · ${counts.blocked ?? 0} 🔴 blocked.`,
    '',
    'For each detector below: the markdown tile summarizes the automated changes; ' +
      'the DQL tile has the **translated query** (runnable). **Run it, confirm it returns the expected series, ' +
      'fix the DQL if needed, and save.** The migration script reads your edited query back and applies it ' +
      'in place to the live detector — nothing here alerts.',
    '',
    '> Keep the `// [CCT-DETECTOR …]` and `// [CCT-ORIGINAL] …` marker lines — they anchor the read-back.',
  ].join('\n');
  return { id: `hdr-${slug(label)}`, type: 'markdown', markdown: md };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Build one review notebook `content` for a batch of detectors. */
export function buildDetectorNotebook(label: string, items: DetectorReviewItem[]): NotebookContent {
  const sections: NotebookSection[] = [batchHeader(label, items)];
  for (const it of items) {
    sections.push({ id: `md-${it.objectId}`, type: 'markdown', markdown: buildDetectorMarkdown(it) });
    sections.push(dqlSection(it.objectId, buildReviewQuery(it.objectId, it.rewritten, it.original)));
  }
  return {
    version: '7',
    defaultTimeframe: { ...DEFAULT_TIMEFRAME },
    defaultSegments: [],
    sections,
  };
}

/** Split an array into fixed-size chunks (batches of N). */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
