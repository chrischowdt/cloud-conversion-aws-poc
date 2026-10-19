/**
 * mz-name — read a management zone's scope straight from its NAME.
 *
 * Management zones don't exist on the new AWS nodes, so a classic zone filter
 * has to become a tag filter. The zones here are named by a team convention,
 *
 *   <APP> : <application name> : <ENV>        e.g.  CPN : PSS SEATS INVENTORY : DEV
 *
 * and the name says exactly what the zone selects. Measured on nic55601 against
 * the zones' own membership rules (3,163 zones, 3,120 with AWS tag rules):
 *   - 3,142 names follow the convention (3-character app code first);
 *   - the first segment equals the zone's ApplicationCI rule in 3,120 of 3,120;
 *   - the last segment equals its env rule in 3,119 of 3,120 (the exception:
 *     `BIP : NAVIGATOR : STGPCI`, whose rule is env = stg).
 * So decoding the name is as good as reading the rules, needs no
 * `discover-management-zones` run, and gives the filter reviewers write by hand.
 *
 * A PARTIAL name selects every zone it is a phrase of, so `"CPN"` decodes to the
 * app alone — which is exactly what the classic `matchesPhrase(managementZones,
 * "CPN")` covered: every CPN zone, whatever its environment.
 */

export interface DecodedZone {
  /** ApplicationCI value, lowercased (the enriched metric tag is lowercase). */
  app: string;
  /** env value, lowercased; absent when the name or phrase doesn't name one. */
  env?: string;
}

/** Decode `<APP> : <name> : <ENV>` (or a leading part of it). Undefined if it isn't that shape. */
export function decodeZoneName(name: string): DecodedZone | undefined {
  const segs = name.split(':').map((s) => s.trim()).filter(Boolean);
  if (!segs.length || !/^[A-Za-z0-9]{3}$/.test(segs[0]!)) return undefined;
  const app = segs[0]!.toLowerCase();
  // Only a full three-part name names its environment; a two-part phrase stops
  // at the application name.
  return segs.length >= 3 ? { app, env: segs[segs.length - 1]!.toLowerCase() } : { app };
}

/**
 * As a filter on the metric's enriched tag dimensions — the cheap, native form
 * for a timeseries command (both tenants enrich `applicationci` and `env`).
 */
export function zoneMetricFilter(z: DecodedZone): string {
  const parts = [`\`aws.tags.applicationci\` == ${JSON.stringify(z.app)}`];
  if (z.env) parts.push(`\`aws.tags.env\` == ${JSON.stringify(z.env)}`);
  return parts.join(' and ');
}

/**
 * As a filter on the node's own tag record — for contexts without metric
 * dimensions (smartscapeNodes, post-aggregation). Case-folded on the value,
 * since the record keeps the resource's own spelling.
 */
export function zoneNodeFilter(nodeRef: string, z: DecodedZone): string {
  const read = (key: string) => `lower(getNodeField(${nodeRef}, "tags:aws")[${key}])`;
  const parts = [`${read('ApplicationCI')} == ${JSON.stringify(z.app)}`];
  if (z.env) parts.push(`${read('env')} == ${JSON.stringify(z.env)}`);
  return parts.join(' and ');
}

/** Union of several decoded zones, deduplicated. */
export function unionFilter(filters: string[]): string {
  const uniq = [...new Set(filters)];
  return uniq.length === 1 ? uniq[0]! : '(' + uniq.map((f) => `(${f})`).join(' or ') + ')';
}
