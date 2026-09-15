/**
 * metric-streams — convert AWS Metric Streams (push) metrics to the new
 * connection's polled equivalent.
 *
 * WHY THIS EXISTS. Both the product skill and our own rewriter treated Metric
 * Streams as unmigratable: "the new AWS connection does not support Metric
 * Streams, so this key has no equivalent." That conflates two different things.
 * The new connection has no PUSH ingest — but it polls many of the same
 * CloudWatch metrics, and teams typically adopted Metric Streams to reach
 * metrics the CLASSIC poller lacked, not ones the new poller lacks. Measured
 * against the live inventory: 47 of 63 blocked keys on nic55601 and 27 of 45 on
 * sfz80352 already have a polled equivalent flowing.
 *
 * Verified end to end on sfz80352, same cluster/consumer-group/topic:
 *   push  cloud.aws.kafka.maxOffsetLagByAccountIdClusterNameConsumerGroupRegionTopic  0.0734
 *   pull  cloud.aws.kafka.MaxOffsetLag.By.Cluster_Name.Consumer_Group.Topic           0.0765
 *
 * THE TRAP. A key swap alone is not enough. The two sides name their dimensions
 * differently — push carries lowercase snake_case (`cluster_name`, `broker_id`,
 * `consumer_group`), the polled metric uses the cased form embedded in its own
 * key (`Cluster_Name`, `Broker_ID`, `Consumer_Group`). Swapping only the key
 * leaves `by:{cluster_name}` pointing at a dimension that does not exist, and
 * the tile renders empty without erroring — the same silent failure as the
 * `tags` record. So the rename travels with the swap, and a grouping dimension
 * the polled metric does NOT carry blocks instead of being quietly dropped.
 *
 * Tenant-scoped by design: the equivalent must be present in that tenant's
 * `live-metrics.json`. A metric that is not flowing is not a safe target.
 */

/** A Metric Streams key: `cloud.aws.<service>.<camelMetric>By<Dim1><Dim2>…` */
export interface ParsedStreamsKey {
  service: string;
  /** Metric name with the `By…` dimension suffix removed, as written (camelCase). */
  metric: string;
}

const STREAMS_KEY = /^(?:dt\.)?cloud\.aws\.([a-z0-9_]+)\.([a-z][A-Za-z0-9]*?)By[A-Z][A-Za-z0-9]*$/;

export function parseStreamsKey(key: string): ParsedStreamsKey | null {
  const m = STREAMS_KEY.exec(key);
  if (!m) return null;
  return { service: m[1]!, metric: m[2]! };
}

/** A polled metric available on the tenant. */
export interface PullMetric {
  key: string;
  /** Dimension names exactly as the new key spells them (after `.By.`). */
  dims: string[];
  series: number;
}

/** Split `cloud.aws.kafka.MaxOffsetLag.By.Cluster_Name.Topic` into name + dims. */
export function parsePullKey(key: string): { service: string; metric: string; dims: string[] } | null {
  const m = /^cloud\.aws\.([a-z0-9_]+)\.([A-Za-z0-9_]+?)(?:\.By\.(.+))?$/.exec(key);
  if (!m) return null;
  return {
    service: m[1]!,
    metric: m[2]!,
    // The key spells a dimension with underscores; the SERIES carries it with
    // spaces. Verified on sfz80352: key `.By.Broker_ID.Cluster_Name` produces
    // dimensions "Broker ID" and "Cluster Name". A name without an underscore
    // (`ApiName`) is unchanged. Getting this wrong groups by a field that does
    // not exist and renders an empty tile without erroring.
    dims: m[3] ? m[3].split('.').filter(Boolean).map((d) => d.replace(/_/g, ' ')) : [],
  };
}

export type PullIndex = Map<string, PullMetric>;

/**
 * Index the tenant's live metrics by `<service>|<lowercased metric>` so a
 * Metric Streams key can find its polled twin regardless of casing.
 *
 * When a metric exists at several dimensional grains, prefer the one with the
 * most series — that is the grain actually carrying data.
 */
export function buildPullIndex(liveMetrics: Array<{ key: string; series?: number }>): PullIndex {
  const idx: PullIndex = new Map();
  for (const m of liveMetrics) {
    const p = parsePullKey(m.key);
    if (!p) continue;
    const id = `${p.service.toLowerCase()}|${p.metric.toLowerCase()}`;
    const series = m.series ?? 0;
    const existing = idx.get(id);
    if (existing && existing.series >= series) continue;
    idx.set(id, { key: m.key, dims: p.dims, series });
  }
  return idx;
}

export interface StreamsConversion {
  newKey: string;
  /** lowercased push dimension -> exact polled dimension name. */
  dimRenames: Map<string, string>;
  series: number;
}

/**
 * Find the polled equivalent of a Metric Streams key on this tenant, or null.
 * Null means "no evidence", never "does not exist" — an equivalent that is not
 * flowing is not something we should silently point a dashboard at.
 */
export function findPullEquivalent(streamsKey: string, index: PullIndex): StreamsConversion | null {
  const parsed = parseStreamsKey(streamsKey);
  if (!parsed) return null;
  const hit = index.get(`${parsed.service.toLowerCase()}|${parsed.metric.toLowerCase()}`);
  if (!hit) return null;
  // Key the rename by the PUSH spelling: push carries `cluster_name`, the polled
  // series carries `Cluster Name`, so normalise spaces back to underscores.
  const dimRenames = new Map<string, string>();
  for (const d of hit.dims) dimRenames.set(d.toLowerCase().replace(/ /g, '_'), d);
  return { newKey: hit.key, dimRenames, series: hit.series };
}

/** Dimensions that exist on BOTH sides under the same name — never renamed. */
export const NATIVE_DIMS = new Set(['aws.account.id', 'aws.region', 'dt.source']);

/** Render a polled dimension for DQL — names with spaces need backticks. */
export function dimRef(dim: string): string {
  return /\s/.test(dim) ? `\`${dim}\`` : dim;
}
