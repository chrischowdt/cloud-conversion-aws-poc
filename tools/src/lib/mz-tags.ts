import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * mz-tags — reduce a classic management zone to the AWS tag predicates that
 * define its AWS slice, so `mzName("…")` inside a classicEntitySelector can be
 * rewritten as a native metric-dimension filter.
 *
 * WHY THIS WORKS HERE. Management zones have no Smartscape equivalent, so the
 * rewriter used to drop the predicate and block the panel. But a zone is just a
 * saved set of membership rules, and on this tenant the AWS-facing rules are
 * generated from a template: every one of them selects AWS resources by their
 * `ApplicationCI` / `env` tags. The new integration already enriches those tags
 * onto the metric itself (`aws.tags.applicationci`, `aws.tags.env` — verified
 * via `discover-tags`), so the zone collapses to a plain dimension filter that
 * needs no entity lookup at all:
 *
 *   mzName("CPN : PSS SEATS INVENTORY : QA")
 *     -> `aws.tags.applicationci` == "cpn" and `aws.tags.env` == "qa"
 *
 * Verified against the live tenant: the classic selector and the rewritten
 * dimension filter return the same resources (cpn-SeatInventory-qa/-stg).
 *
 * DELIBERATELY CONSERVATIVE. We only translate a zone whose AWS rules reduce to
 * a consistent, non-empty tag set. A zone we can't reduce is left untranslated
 * (the caller keeps blocking it) rather than approximated — an alert that
 * silently changes scope is worse than one that visibly fails to convert. We
 * also ignore the zone's non-AWS rules (services, K8s, synthetic): the queries
 * we rewrite are AWS metric queries, so only the AWS slice can ever match.
 */

/** A single tag equality that helps define a zone's AWS membership. */
export interface MzTagPredicate {
  /** Tag key as written on the AWS resource (e.g. `ApplicationCI`). */
  key: string;
  value: string;
}

/** mzName -> the AWS tag predicates that define it. */
export type MzTagIndex = Map<string, MzTagPredicate[]>;

/** The metric dimension an enriched AWS tag lands on: `aws.tags.<lowercased key>`. */
export function tagDimension(key: string): string {
  return `aws.tags.${key.toLowerCase()}`;
}

const AWS_SELECTOR_TAG = /tag\(\s*"\[AWS\]([^:"]+):([^"]*)"\s*\)/g;

/**
 * Pull the AWS tag predicates out of one management-zone settings value.
 *
 * Handles the two rule shapes that carry AWS tags:
 *   - `SELECTOR` — an entitySelector string with `tag("[AWS]Key:value")`
 *   - `ME`       — an attributeRule whose conditions carry `tag: "key:value"`
 *                  on an `AWS_*` entity type
 * `DIMENSION` rules are metric-dimension rules for OTHER data sources
 * (fluentd etc.) and are ignored.
 *
 * Keys are compared case-insensitively (the same zone writes both
 * `ApplicationCI` and `applicationci`); the first-seen casing is kept.
 */
export function extractAwsTagPredicates(mzValue: unknown): MzTagPredicate[] {
  const v = mzValue as { rules?: unknown[] } | null;
  const rules = Array.isArray(v?.rules) ? v!.rules! : [];
  // lowercased key -> (lowercased value -> predicate), so we can detect conflicts.
  const byKey = new Map<string, Map<string, MzTagPredicate>>();
  const add = (key: string, value: string) => {
    const k = key.trim();
    const val = value.trim();
    if (!k || !val) return;
    const lk = k.toLowerCase();
    let bucket = byKey.get(lk);
    if (!bucket) byKey.set(lk, (bucket = new Map()));
    const lv = val.toLowerCase();
    if (!bucket.has(lv)) bucket.set(lv, { key: k, value: val });
  };

  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    const rule = r as Record<string, any>;
    if (rule.enabled === false) continue;

    if (typeof rule.entitySelector === 'string') {
      AWS_SELECTOR_TAG.lastIndex = 0;
      for (const m of rule.entitySelector.matchAll(AWS_SELECTOR_TAG)) add(m[1]!, m[2]!);
      continue;
    }
    const ar = rule.attributeRule as Record<string, any> | undefined;
    if (ar && typeof ar.entityType === 'string' && ar.entityType.startsWith('AWS_')) {
      for (const c of Array.isArray(ar.conditions) ? ar.conditions : []) {
        // `tag` is written "key:value"; anything else is a non-tag attribute.
        if (typeof c?.tag !== 'string') continue;
        const raw = c.tag.replace(/^\[AWS\]/, '');
        const i = raw.indexOf(':');
        if (i > 0) add(raw.slice(0, i), raw.slice(i + 1));
      }
    }
  }

  // A key that resolves to more than one value can't be reduced to a single
  // equality (the zone unions them), so the reduction isn't safe — bail.
  const out: MzTagPredicate[] = [];
  for (const bucket of byKey.values()) {
    if (bucket.size !== 1) return [];
    out.push([...bucket.values()][0]!);
  }
  return out;
}

/** Render predicates as a DQL filter over the native enriched-tag dimensions. */
export function mzFilterExpression(preds: MzTagPredicate[]): string {
  return preds
    .map((p) => `\`${tagDimension(p.key)}\` == ${JSON.stringify(p.value)}`)
    .join(' and ');
}

interface MzFile {
  zones?: Array<{ name?: string; tags?: MzTagPredicate[] }>;
}

/** Build the lookup index from a `management-zones.json` produced by discover. */
export function buildMzIndex(file: unknown): MzTagIndex {
  const idx: MzTagIndex = new Map();
  const zones = (file as MzFile)?.zones ?? [];
  for (const z of zones) {
    if (!z?.name || !Array.isArray(z.tags) || z.tags.length === 0) continue;
    idx.set(z.name, z.tags);
  }
  return idx;
}

/**
 * Resolve `<tenantDir>/management-zones.json` if it exists, else undefined.
 * Lets every pipeline command opt into mzName() translation automatically once
 * the tenant has been discovered, and behave exactly as before otherwise.
 * Pass the result to `loadRecipeIndex({ mzTagsPath })`.
 */
export function mzTagsPathIfPresent(tenantDir: string | undefined): string | undefined {
  if (!tenantDir) return undefined;
  const p = join(tenantDir, 'management-zones.json');
  return existsSync(p) ? p : undefined;
}
