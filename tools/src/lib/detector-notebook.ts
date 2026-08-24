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
    'Each detector below has **three tiles**:',
    '',
    '1. **Summary** — what the conversion changed (node type, threshold, alert binding) and what to verify.',
    '2. **Query** — the translated DQL, runnable. **Run it, confirm it returns the expected series, ' +
      'and fix the DQL if it does not.**',
    '3. **Conversion status** — set the status and add any notes. This is what the migration ' +
      'script reads to decide what gets published.',
    '',
    'The script reads your edited query and your status back, then applies the query in place to the ' +
      'live detector. Nothing in this notebook alerts, so you can run everything freely.',
    '',
    `> Statuses: ${REVIEW_STATUSES.filter((s) => s !== 'Not Reviewed').map((s) => `**${s}**`).join(' · ')}. ` +
      'Anything left at *Not Reviewed* is skipped.',
    '',
    '> Keep the `// [CCT-DETECTOR …]`, `// [CCT-ORIGINAL] …` and `CCT-REVIEW …` markers — they anchor the read-back.',
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
    // The reviewer's verdict goes AFTER the query — read it, run it, then mark it.
    sections.push({ id: reviewCardId(it.objectId), type: 'markdown', markdown: buildReviewCard(it) });
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

// ─── reviewer verdict card ────────────────────────────────────────────────
//
// One markdown tile per detector where the reviewer records the outcome. It has
// to be BOTH pleasant to edit by hand and reliably machine-readable, because
// `migrate-promote-detectors` only cuts over what a human actually approved.
// So: a fixed `**Status:**` line the reviewer overwrites with one word, and a
// free-text notes block. The objectId is carried in the tile id AND in the text,
// so read-back still works if a tile gets copied or its id changes.

/** Vocabulary for the per-query verdict. `Not Reviewed` is the starting value. */
export const REVIEW_STATUSES = [
  'Not Reviewed',
  'Converted OK',
  'Needs Fix',
  'Blocked',
  'Descope',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * How a per-query verdict rolls up to the shared tracker's `decision` column
 * (see lib/tracker-xlsx.ts DECISION_STATES), so the two vocabularies stay
 * reconcilable when we write detector outcomes back.
 */
export const STATUS_TO_DECISION: Record<ReviewStatus, string> = {
  'Not Reviewed': 'Needs Review',
  'Converted OK': 'Ready To Publish',
  'Needs Fix': 'In Progress',
  Blocked: 'Needs Review',
  Descope: 'Descope',
};

const STATUS_MARK = '**Status:**';
const NOTES_MARK = '**Notes:**';
const REVIEW_TAG = 'CCT-REVIEW objectId=';

export function reviewCardId(objectId: string): string {
  return `review-${objectId}`;
}

/** The editable verdict tile for one detector. */
export function buildReviewCard(item: DetectorReviewItem): string {
  return [
    `#### ✍️ Conversion status — ${item.title}`,
    '',
    `\`${REVIEW_TAG}${item.objectId}\``,
    '',
    `${STATUS_MARK} Not Reviewed`,
    '',
    `> Replace the word above with one of: ${REVIEW_STATUSES.filter((s) => s !== 'Not Reviewed')
      .map((s) => `**${s}**`)
      .join(' · ')}`,
    '',
    NOTES_MARK,
    '',
    '_(optional — replace this line with anything the migration team should know:',
    'what you changed, what still looks wrong, which tiles you spot-checked.)_',
  ].join('\n');
}

export interface ParsedReviewCard {
  objectId?: string;
  status: ReviewStatus | string;
  notes: string;
  /** True when the reviewer left the card at its default, untouched state. */
  untouched: boolean;
}

/**
 * Read a verdict tile back. Tolerant by design: reviewers will bold things,
 * change case, or add trailing punctuation, and none of that should lose their
 * answer. An unrecognized status is returned verbatim rather than coerced, so a
 * typo surfaces as itself instead of silently becoming an approval.
 */
export function parseReviewCard(markdown: string): ParsedReviewCard {
  const idM = new RegExp(REVIEW_TAG + '([^\s`]+)').exec(markdown);
  const lines = markdown.split('\n');

  let status = '';
  const statusIdx = lines.findIndex((l) => l.includes(STATUS_MARK));
  if (statusIdx >= 0) {
    status = lines[statusIdx]!.slice(lines[statusIdx]!.indexOf(STATUS_MARK) + STATUS_MARK.length)
      .replace(/[*_`]/g, '')
      .trim()
      .replace(/[.,;]+$/, '');
  }
  const canonical = REVIEW_STATUSES.find((s) => s.toLowerCase() === status.toLowerCase());

  let notes = '';
  const notesIdx = lines.findIndex((l) => l.includes(NOTES_MARK));
  if (notesIdx >= 0) {
    notes = lines
      .slice(notesIdx + 1)
      // Drop the italic placeholder and the status hint blockquote.
      .filter((l) => !/^\s*>/.test(l) && !/^\s*_\(optional/.test(l) && !/^what you changed/.test(l))
      .join('\n')
      .trim();
    if (/^_\(.*\)_$/s.test(notes)) notes = '';
  }

  const resolved = canonical ?? status;
  return {
    objectId: idM?.[1],
    status: resolved || 'Not Reviewed',
    notes,
    untouched: (!resolved || resolved === 'Not Reviewed') && notes === '',
  };
}

/** Collect every reviewer verdict from a notebook's sections. */
export function collectReviewCards(content: unknown): ParsedReviewCard[] {
  const sections = ((content as { sections?: NotebookSection[] })?.sections ?? []) as NotebookSection[];
  const out: ParsedReviewCard[] = [];
  for (const s of sections) {
    if (s.type !== 'markdown' || !s.markdown.includes(REVIEW_TAG)) continue;
    const parsed = parseReviewCard(s.markdown);
    if (!parsed.objectId && s.id?.startsWith('review-')) parsed.objectId = s.id.slice('review-'.length);
    out.push(parsed);
  }
  return out;
}
