/**
 * Canonical casing for AWS tag keys, so a rewritten query reads the tag record
 * with the key the resources actually carry.
 *
 * Record key access is case-SENSITIVE. Classic queries matched a lowercased tag
 * STRING (`contains(lower(tags), "applicationci:bbt")`), so they routinely spell
 * the key in lower case. Translating that literally yields `tags[applicationci]`,
 * which matches 62 of the 912,089 nodes that carry the tag — a filter that
 * parses, runs, and returns essentially nothing.
 *
 * Measured 2026-10-01 across 1,484,907 AWS Smartscape nodes on nic55601:
 *
 *   ApplicationCI  912,089   |  applicationci     62  |  Applicationci  6
 *   env            883,673   |  Env            7,766
 *   Environment    174,283   |  environment    25,704
 *   Name           227,907   |  name               50
 *
 * Two things stop this being a capitalisation rule: `env` is canonically LOWER
 * case while the rest are not, and `Environment` is a separate key rather than a
 * casing variant of `env`. Hence a measured table.
 *
 * Team decision (2026-10-01): `ApplicationCI` is the standard. Resources tagged
 * otherwise are treated as not following guidelines and corrected at the source,
 * rather than accommodated with case-folding here — DQL has no key-folding
 * accessor, and the only workaround (matching the record's JSON text) depends on
 * the serialisation format, which is what broke the classic idiom in the first
 * place.
 *
 * Re-probe per tenant before trusting it:
 *   smartscapeNodes "AWS*"
 *   | fieldsAdd t = `tags:aws`
 *   | summarize nodes = count(),
 *               ApplicationCI = countIf(isNotNull(t[ApplicationCI])),
 *               applicationci = countIf(isNotNull(t[applicationci]))
 */

/** Lowercased tag key → the casing the resources actually use. */
export const CANONICAL_TAG_KEYS: Record<string, string> = {
  applicationci: 'ApplicationCI',
  env: 'env',
  environment: 'Environment',
  name: 'Name',
};

/**
 * The casing to read a tag key with. Unknown keys are returned as written — we
 * only correct keys we have measured, so an unrecognised one is never silently
 * re-spelled into something that matches nothing.
 */
export function canonicalTagKey(key: string): string {
  const k = key.trim();
  return CANONICAL_TAG_KEYS[k.toLowerCase()] ?? k;
}
