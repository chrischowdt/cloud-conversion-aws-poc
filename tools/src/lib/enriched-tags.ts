/**
 * enriched-tags — which AWS tags the new connection copies onto METRIC series,
 * and therefore which can be read as a native dimension instead of an entity
 * lookup.
 *
 * WHY THIS EXISTS. Reading a tag off the entity —
 * `getNodeField(<dim>, "tags:aws")[Key]` — matches the key CASE-SENSITIVELY
 * against the resource's real AWS tags. Classic queries write the key in
 * whatever case the author used, so the rewriter faithfully reproduces
 * `[applicationci]` while the resource is tagged `ApplicationCI`, and the read
 * returns null. Silently: the filter simply matches nothing.
 *
 * Verified on nic55601:
 *   tags:aws[ApplicationCI] -> 34,013 of 34,074 lambdas
 *   tags:aws[applicationci] ->      0 of 34,074
 * and across the dashboard corpus, 151 emitted reads (20 dashboards) used a
 * casing the tenant does not have.
 *
 * Case-correcting the key is NOT a safe fix: AWS tag keys are case-sensitive and
 * the same logical tag exists in several casings at once (`env` on 34,026
 * lambdas, `Env` on 182), so there is no single right answer.
 *
 * The connection, however, normalizes enriched tags to lowercase when it copies
 * them onto the metric — `aws.tags.env` covers both spellings and reaches 99.8%
 * of series. So for a METRIC query the native dimension is both simpler and
 * strictly more correct, which is exactly the substitution reviewers were making
 * by hand. Entity queries still need the real-cased key and are left alone.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Lowercased tag keys the connection enriches onto metrics for this tenant. */
export type EnrichedTagIndex = Set<string>;

/** The metric dimension an enriched AWS tag lands on. */
export function enrichedTagDimension(key: string): string {
  return `aws.tags.${key.toLowerCase()}`;
}

/** Load `enriched-tags.json` (from `discover-tags`) into a lookup set. */
export async function loadEnrichedTags(path: string): Promise<EnrichedTagIndex> {
  const j = JSON.parse(await readFile(path, 'utf8')) as {
    enrichedTagKeys?: string[];
    tags?: Array<{ key?: string }>;
  };
  const keys = j.enrichedTagKeys ?? (j.tags ?? []).map((t) => t.key ?? '');
  return new Set(keys.filter(Boolean).map((k) => k.toLowerCase()));
}

/**
 * Resolve `<tenantDir>/enriched-tags.json` if present. Nothing changes unless
 * the tenant has been probed (`discover-tags`) — we will not guess which tags a
 * connection enriches, since substituting a dimension that isn't there would
 * turn a working filter into an empty one.
 */
export function enrichedTagsPathIfPresent(tenantDir: string | undefined): string | undefined {
  if (!tenantDir) return undefined;
  const p = join(tenantDir, 'enriched-tags.json');
  return existsSync(p) ? p : undefined;
}
