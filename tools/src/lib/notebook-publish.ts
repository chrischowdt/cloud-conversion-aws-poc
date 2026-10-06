/**
 * Publishing a reviewed NOTEBOOK as a new notebook, instead of cutting it over
 * the original.
 *
 * Dashboards are cut over in place (same id, same URL). Notebooks are not: a
 * notebook stores the results of its past query runs alongside the queries, so
 * overwriting it with migrated content throws those results away. Instead the
 * reviewed copy BECOMES the new notebook — under the original's own title, with
 * the migration's reference comments stripped and a notice at the top explaining
 * what happened. The title is deliberately NOT changed: later upgrades (other
 * query types, other clouds) would otherwise stack suffixes. The two notebooks
 * are told apart by their tiles and by LABELS, which are also how tooling finds
 * them again.
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

/**
 * Labels. Document labels exist on the live API (not yet in SDK 1.30), can be
 * filtered server-side with `labels contains '<label>'`, survive content
 * updates, and a write REPLACES the whole set — so always merge.
 *   UPGRADED_LABEL   — on the new notebook
 *   SUPERSEDED_LABEL — on the original, so scans skip it rather than queue it
 *                      for conversion a second time
 */
export const UPGRADED_LABEL = 'aws-new-integration';
export const SUPERSEDED_LABEL = 'aws-classic-superseded';

/** Existing labels plus ours, deduplicated, order kept. */
export function mergeLabels(existing: readonly string[] | undefined, add: readonly string[]): string[] {
  return [...new Set([...(existing ?? []), ...add])];
}

/** Existing labels minus ours — how rollback takes them back off without touching the owner's own. */
export function removeLabels(existing: readonly string[] | undefined, remove: readonly string[]): string[] {
  const drop = new Set(remove);
  return (existing ?? []).filter((l) => !drop.has(l));
}

/** True when a notebook's content carries the pointer tile, i.e. it is a superseded original. */
export function isSupersededOriginal(content: unknown): boolean {
  const sections = (content as { sections?: Array<{ id?: unknown }> } | null)?.sections ?? [];
  return sections.some((s) => s?.id === POINTER_SECTION_ID);
}

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

/** The name the published notebook carries: the original's own title, without the review prefix. */
export function publishedNotebookName(originalName: string): string {
  return originalName.replace(REVIEW_PREFIX, '').trim() || 'Untitled notebook';
}

/** Markdown for the notice tile at the top of the new notebook. */
export function buildMigrationNotice(o: NoticeOptions): string {
  // Both notebooks share a title, so link by role, never by name.
  const original = o.originalUrl ? `[the original notebook](${o.originalUrl})` : 'the original notebook';
  const lines = [
    '### ✅ Upgraded for the new AWS integration',
    '',
    `This is the upgraded version of ${original}. Its queries were converted to work with ` +
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
  // Both notebooks share a title, so link by role, never by name.
  const target = o.newUrl ? `[Open the upgraded version](${o.newUrl})` : 'Open the upgraded version (same title, in your notebooks)';
  return [
    '### ➡️ An upgraded version of this notebook is available',
    '',
    `${target}. Its queries were converted for Dynatrace's new AWS cloud integration ` +
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

/**
 * What the owner AUTHORED in a section — its kind, title, query, markdown and
 * chart type — and not what running it produced. A notebook's version moves
 * every time a query runs and its results are stored, so version alone can't
 * tell "the owner kept working on it" from "the owner looked at it".
 *
 * `visualizationSettings` (column widths, colours, axis labels) is left out on
 * purpose: dragging a table column rewrites it (measured: 1576 → 1615 was the
 * only change in one notebook), and that is not work worth holding a publish for.
 */
function authoredSection(s: Record<string, unknown>): string {
  const st = (s['state'] ?? {}) as Record<string, unknown>;
  const input = (st['input'] ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    type: s['type'] ?? null,
    title: s['title'] ?? null,
    markdown: s['markdown'] ?? null,
    query: input['value'] ?? null,
    visualization: st['visualization'] ?? null,
  });
}

/**
 * The owner's edits between the notebook we staged from (`base`) and the
 * original as it is now (`live`), ignoring stored results and our own tiles.
 * Empty when there are none. A non-empty answer means the review copy is built
 * on an out-of-date notebook: publishing it would hand the owner a new notebook
 * that is missing their latest work (found after the first bulk publish — six
 * of 42 owners had added or changed sections since the download).
 */
export function authoredChangesSince(base: NotebookContent, live: NotebookContent): string[] {
  const ours = new Set([POINTER_SECTION_ID, NOTICE_SECTION_ID]);
  const sections = (c: NotebookContent) => (c.sections ?? []).filter((s) => !ours.has(String(s?.['id'])));
  const before = sections(base), now = sections(live);
  const was = new Map(before.map((s) => [String(s['id']), authoredSection(s)]));
  const added = now.filter((s) => !was.has(String(s['id']))).length;
  const removed = before.filter((s) => !now.some((x) => x['id'] === s['id'])).length;
  const edited = now.filter((s) => was.has(String(s['id'])) && was.get(String(s['id'])) !== authoredSection(s)).length;
  const order = (c: Array<Record<string, unknown>>) => c.map((s) => s['id']).filter((id) => was.has(String(id)) && now.some((x) => x['id'] === id));
  const reordered = JSON.stringify(order(before)) !== JSON.stringify(order(now));
  return [
    added && `${added} section(s) added`,
    removed && `${removed} removed`,
    edited && `${edited} edited`,
    reordered && 'sections reordered',
  ].filter((x): x is string => !!x);
}

/** How many migration reference-comment blocks remain (should be 0 once stripped). */
export function countReferenceBlocks(content: unknown): number {
  return (JSON.stringify(content).match(/ORIGINAL CLASSIC QUERY \(migration reference/g) ?? []).length;
}
