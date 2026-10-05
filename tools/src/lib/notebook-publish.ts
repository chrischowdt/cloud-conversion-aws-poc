/**
 * Publishing a reviewed NOTEBOOK as a new notebook, instead of cutting it over
 * the original.
 *
 * Dashboards are cut over in place (same id, same URL). Notebooks are not: a
 * notebook stores the results of its past query runs alongside the queries, so
 * overwriting it with migrated content throws those results away. Instead the
 * reviewed copy BECOMES the new notebook — renamed, with the migration's
 * reference comments stripped and a notice at the top explaining what happened.
 * The original gets exactly one change: a pointer tile at the top linking to the
 * new notebook, because otherwise its owner has no way to find it. Every other
 * section of the original, stored results included, is carried over unchanged.
 *
 * Pure: no I/O. The command (migrate-promote) owns the reads and writes.
 */

/** Stable id of the notice section, so republishing replaces it instead of stacking copies. */
export const NOTICE_SECTION_ID = 'cct-migration-notice';

/**
 * Stable id of the POINTER tile added to the top of the ORIGINAL notebook. It is
 * the only change ever made to the original — without it the owner has no way to
 * find the new notebook. Everything else in the original, including the stored
 * results of past runs, must come through byte-identical.
 */
export const POINTER_SECTION_ID = 'cct-migration-pointer';

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
    "**The original notebook's queries and the results of its past runs were left exactly as they were**; " +
      'the only change there is a link to this notebook at the top. ' +
      "Use this notebook going forward: the original's queries depend on the classic integration and may " +
      'stop returning data once it is turned off.',
    '',
    `_Converted ${o.date} by the cloud migration team${o.reviewer ? `; reviewed by ${o.reviewer}` : ''}._`,
  ];
  return lines.join('\n');
}

export interface PointerOptions {
  /** The new notebook's name and link. */
  newName: string;
  newUrl?: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
}

/** Markdown for the pointer tile at the top of the ORIGINAL notebook. */
export function buildOriginalPointer(o: PointerOptions): string {
  const target = o.newUrl ? `[${o.newName}](${o.newUrl})` : `**${o.newName}**`;
  return [
    '### ➡️ An upgraded version of this notebook is available',
    '',
    `Open ${target}. Its queries were converted for Dynatrace's new AWS cloud integration ` +
      '(Smartscape on Grail). The queries below still use the classic AWS integration and may stop returning ' +
      'data once it is turned off.',
    '',
    '**Nothing else in this notebook was changed** — its queries and the results of past runs are exactly as they were.',
    '',
    `_Added ${o.date} by the cloud migration team._`,
  ].join('\n');
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
export function withMigrationNotice<T extends NotebookContent>(
  content: T,
  markdown: string,
  sectionId: string = NOTICE_SECTION_ID
): T {
  const out = structuredClone(content);
  const rest = (out.sections ?? []).filter((s) => s?.['id'] !== sectionId);
  out.sections = [{ id: sectionId, type: 'markdown', markdown }, ...rest];
  return out;
}

/** A copy of `content` without the section of that id — how rollback takes the pointer back out. */
export function withoutSection<T extends NotebookContent>(content: T, sectionId: string): T {
  const out = structuredClone(content);
  out.sections = (out.sections ?? []).filter((s) => s?.['id'] !== sectionId);
  return out;
}

/**
 * True when every section OTHER than `ignoreId` is identical, in the same order.
 * This is the guarantee for the original notebook: adding the pointer may not
 * alter a single query, setting or stored result.
 */
export function sameSectionsExcept(a: NotebookContent, b: NotebookContent, ignoreId: string): boolean {
  const keep = (c: NotebookContent) => JSON.stringify((c.sections ?? []).filter((s) => s?.['id'] !== ignoreId));
  return keep(a) === keep(b);
}

/** How many migration reference-comment blocks remain (should be 0 once stripped). */
export function countReferenceBlocks(content: unknown): number {
  return (JSON.stringify(content).match(/ORIGINAL CLASSIC QUERY \(migration reference/g) ?? []).length;
}
