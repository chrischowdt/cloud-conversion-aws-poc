/**
 * Transformations between the various AWS metric-key schemas we've observed.
 *
 * Schemas in play (verified empirically on a real tenant 2026-05-01):
 *
 *   A. Classic builtin (DAC ref)        builtin:aws.alb.active.connection.count
 *   B. Classic builtin (Python scrape)  builtin:cloud.aws.alb.connections.active
 *   C. Extension / secondGen            ext:cloud.aws.applicationelb.activeConnectionCountSum
 *   D. DAC recommended/autodiscovered   cloud.aws.applicationelb.ActiveConnectionCount.By.LoadBalancer
 *   E. Tenant new-gen (snake_case)      cloud.aws.applicationelb.active_connection_count_sum
 *                                       cloud.aws.applicationelb.active_connection_count_sum_by_load_balancer
 *
 * Schema E is what real tenants actually surface for new-gen metrics. It is
 * derived from C (secondGen) by:
 *   1. Strip the `ext:` prefix.
 *   2. Convert camelCase → snake_case in the metric-name segment.
 *
 * Some tenant E keys also have `_by_<dim>` appended which doesn't appear in
 * the corresponding C key — those rows have multiple dimension breakdowns
 * that DAC catalogues under one "average" entry.
 */

/** camelCase → snake_case for a single identifier. */
export function toSnakeCase(s: string): string {
  return s.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase();
}

/**
 * Transform a classic v2-API builtin key into its DQL form.
 *
 *   builtin:cloud.aws.alb.connections.active
 *     → dt.cloud.aws.alb.connections.active
 *   builtin:cloud.aws.dynamo.capacityUnits.consumed.read
 *     → dt.cloud.aws.dynamo.capacity_units.consumed.read
 *
 * Every dot-segment after the prefix is snake-cased.
 */
export function builtinToDqlClassic(builtinKey: string | null | undefined): string | null {
  if (!builtinKey) return null;
  if (!builtinKey.startsWith('builtin:')) return null;
  const suffix = builtinKey.slice('builtin:'.length);
  return 'dt.' + suffix.split('.').map(toSnakeCase).join('.');
}

/**
 * Transform a DAC `secondGenMetricKey` (schema C) into the tenant snake_case
 * form (schema E base, without any `_by_<dim>` suffix). Returns null when the
 * input is "not-matched" or empty.
 */
export function secondGenToTenantKey(secondGenKey: string | null | undefined): string | null {
  if (!secondGenKey || secondGenKey === 'not-matched') return null;
  let key = secondGenKey;
  if (key.startsWith('ext:')) key = key.slice(4);
  const lastDot = key.lastIndexOf('.');
  if (lastDot < 0) return key;
  const namespace = key.slice(0, lastDot);
  const metric = key.slice(lastDot + 1);
  return `${namespace}.${toSnakeCase(metric)}`;
}
