/**
 * Publishing a reviewed NOTEBOOK as a new notebook, instead of cutting it over
 * the original.
 *
 * Dashboards are cut over in place (same id, same URL). Notebooks are not: a
 * notebook stores the results of its past query runs alongside the queries, so
 * overwriting it with migrated content throws those results away. Instead the
 * reviewed copy BECOMES the new notebook — renamed, with the migration's
 * reference comments stripped and a notice at the top explaining what happened —
 * and the original is never touched.
 *
 * Pure: no I/O. The command (migrate-promote) owns the reads and writes.
 */

/** Stable id of the notice section, so republishing replaces it instead of stacking copies. */
export const NOTICE_SECTION_ID = 'cct-migration-notice';

/** Prefix migrate-stage puts on review copies. */
const REVIEW_PREFIX = /^\s*\[MIGRATION REVIEW\]\s*/i;

/** Suffix that tells the new notebook apart from the original, which keeps its name. */
export const PUBLISHED_SUFFIX = ' (new AWS integration)';

export interface NoticeOptions {
  /** The original notebook's name. */
  originalName: string;
  /** Deep link to the original, so readers can still reach its old results. */
  originalUrl?: string;
  /** Who reviewed the conversion, when the tracker records it. */
  reviewer?: string;
  /** ISO date of publication (YYYY-MM-DD). */
  date: string;
}

/** The name the published notebook carries. Idempotent. */
export function publishedNotebookName(originalName: string): string {
  const base = originalName.replace(REVIEW_PREFIX, '').trim() || 'Untitled notebook';
  return base.endsWith(PUBLISHED_SUFFIX.trim()) ? base : `${base}${PUBLISHED_SUFFIX}`;
}

/** Markdown for the notice tile at the top of the new notebook. */
export function buildMigrationNotice(o: NoticeOptions): string {
  const original = o.originalUrl ? `[${o.originalName}](${o.originalUrl})` : `**${o.originalName}**`;
  const lines = [
    '### ✅ Upgraded for the new AWS integration',
    '',
    `This notebook is an upgraded copy of ${original}. Its queries were converted to work with ` +
      "Dynatrace's new AWS cloud integration (Smartscape on Grail), which replaces the classic AWS integration.",
    '',
    '**The original notebook was not modified**, so the results of its past query runs are still there. ' +
      "Use this notebook going forward: the original's queries depend on the classic integration and may " +
      'stop returning data once it is turned off.',
    '',
    `_Converted ${o.date} by the cloud migration team${o.reviewer ? `; reviewed by ${o.reviewer}` : ''}._`,
  ];
  return lines.join('\n');
}

interface NotebookContent {
  sections?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/**
 * Return a copy of `content` with the notice as its FIRST section. An existing
 * notice (same id) is replaced, not duplicated, so a republish is idempotent.
 * Nothing else is touched — every other section, including any stored results,
 * is carried over as-is.
 */
export function withMigrationNotice<T extends NotebookContent>(content: T, markdown: string): T {
  const out = structuredClone(content);
  const rest = (out.sections ?? []).filter((s) => s?.['id'] !== NOTICE_SECTION_ID);
  out.sections = [{ id: NOTICE_SECTION_ID, type: 'markdown', markdown }, ...rest];
  return out;
}

/** How many migration reference-comment blocks remain (should be 0 once stripped). */
export function countReferenceBlocks(content: unknown): number {
  return (JSON.stringify(content).match(/ORIGINAL CLASSIC QUERY \(migration reference/g) ?? []).length;
}
