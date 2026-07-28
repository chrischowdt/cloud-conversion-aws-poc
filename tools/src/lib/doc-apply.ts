/**
* doc-apply — build the Document-API apply object (name/type/content[/id]) from a downloaded /
 * rewritten document wrapper. Pure (no I/O), so it's fully testable without
 * dtctl installed.
 *
 * dtctl decides create-vs-update by the presence of `id`:
 *   - **create** (publish a review copy): NO `id`, name suffixed "(migrated — review)".
 *   - **update** (in-place cutover): `id` = the ORIGINAL document id, name is the
 *     original (suffix stripped) so users see their normal dashboard title.
 *
 * Dashboards render their title from `content.settings.name`; notebooks from the
 * document `name`. We set the top-level `name` for both and also mirror it into
 * `content.settings.name` for dashboards.
 */

export type AssetType = 'dashboard' | 'notebook';

export interface ApplyObject {
  name: string;
  type: AssetType;
  content: Record<string, unknown>;
  /** Present ⇒ dtctl updates this document in place; absent ⇒ creates a new one. */
  id?: string;
}

export interface DocWrapper {
  metadata?: { id?: string; name?: string; type?: string };
  content: unknown;
}

export const REVIEW_SUFFIX = ' (migrated — review)';

/** Remove a trailing migration marker so we don't stack suffixes / restore the original title. */
export function stripMigrationSuffix(name: string): string {
  return name.replace(/\s*\((?:migrated\s*—\s*review|migrated - review|rewritten)\)\s*$/i, '').trim();
}

function parseContent(content: unknown): Record<string, unknown> {
  const obj = typeof content === 'string' ? JSON.parse(content) : content;
  if (!obj || typeof obj !== 'object') return {};
  return structuredClone(obj) as Record<string, unknown>;
}

/**
 * Build a dtctl apply object. `create` produces a review copy (no id, suffixed
 * name); `update` targets an existing id with the original (unsuffixed) name.
 */
export function buildApply(opts: {
  wrapper: DocWrapper;
  assetType: AssetType;
  mode: 'create' | 'update';
  /** Required for `update` — the id to overwrite in place. */
  targetId?: string;
  /** Suffix for review copies (default `REVIEW_SUFFIX`). */
  reviewSuffix?: string;
}): ApplyObject {
  const { wrapper, assetType, mode } = opts;
  const content = parseContent(wrapper.content);

  const settings = (content['settings'] as Record<string, unknown> | undefined) ?? undefined;
  const rawName =
    wrapper.metadata?.name ??
    (assetType === 'dashboard' ? (settings?.['name'] as string | undefined) : undefined) ??
    'Untitled';
  const base = stripMigrationSuffix(rawName);
  const displayName = mode === 'create' ? `${base}${opts.reviewSuffix ?? REVIEW_SUFFIX}` : base;

  if (assetType === 'dashboard') {
    content['settings'] = { ...(settings ?? {}), name: displayName };
  }

  const apply: ApplyObject = { name: displayName, type: assetType, content };
  if (mode === 'update') {
    if (!opts.targetId) throw new Error('buildApply(update) requires targetId (the original document id).');
    apply.id = opts.targetId;
  }
  return apply;
}
