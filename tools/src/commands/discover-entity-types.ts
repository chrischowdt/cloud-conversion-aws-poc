/**
 * discover-entity-types — derive the AWS-service → Smartscape node-type bridge
 * from a tenant's live new-connection metrics, written to `entity-source-types.json`.
 *
 * WHY (Lever #1): classic dashboards fetch `dt.entity.custom_device` (often
 * filtered `entity.type == "cloud:aws:<service>"`), which has no Smartscape
 * replacement and bails out. But every new-connection metric series carries
 * `dt.smartscape_source.type` = the Smartscape node type that emits it
 * (`cloud.aws.lambda.* → AWS_LAMBDA_FUNCTION`). Joined with the metric key's
 * service segment, that's a ground-truth map from the AWS service a query
 * references to the node type that replaces its custom_device.
 *
 * Why empirical, not the dt-migration entities JSON: `dacResourceType` there
 * carries the WRONG granularity for several services — `ecs` resolves to
 * AWS_ECS_SERVICE (metrics emit AWS_ECS_CLUSTER), `es` to
 * AWS_OPENSEARCHSERVICE_DOMAIN (reality: AWS_OPENSEARCH_DOMAIN),
 * `elasticache` to AWS_ELASTICACHE_SERVERLESSCACHE (reality:
 * …_CACHECLUSTER). The metric source type is what `dt.smartscape.<type>`
 * dimensions actually match, so it's authoritative.
 *
 * HOW: `summarize count() by metric.key, dt.smartscape_source.type`, then group
 * by the metric key's service segment (`cloud.aws.<service>.…`). A service can
 * map to >1 node type (cluster + instance, e.g. rds → DBINSTANCE + DBCLUSTER);
 * the most-populated wins as `nodeType`, the rest are recorded as `alternates`.
 *
 * Output: `<tenant-out>/entity-source-types.json`
 *   { generated, baseUrl, daSource, from, serviceCount,
 *     services: { "<service>": { nodeType, series, alternates: [{type, series}] } } }
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient } from '../dynatrace/dql.ts';
import { OUT_DIR } from '../lib/paths.ts';

export interface DiscoverEntityTypesArgs {
  baseUrl: string;
  token: string;
  outDir?: string;
  /** Relative timeframe start. Default `now()-3d`. */
  from?: string;
  /** New-connection DA source. Default `aws-metric-poller`. */
  daSource?: string;
}

interface ServiceEntry {
  nodeType: string;
  series: number;
  alternates: Array<{ type: string; series: number }>;
}

/** `cloud.aws.<service>.Metric.By.Dim` → `<service>` (third dot segment). */
export function serviceFromMetricKey(key: string): string | null {
  const parts = key.split('.');
  // cloud . aws . <service> . …
  if (parts.length >= 3 && parts[0] === 'cloud' && parts[1] === 'aws') return parts[2] ?? null;
  return null;
}

export async function runDiscoverEntityTypes(args: DiscoverEntityTypesArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });
  const from = args.from ?? 'now()-3d';
  const daSource = args.daSource ?? 'aws-metric-poller';

  const client = new DqlClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} (${info.delayMs.toFixed(0)}ms)`),
  });

  const query =
    `fetch metric.series, from:${from} ` +
    `| filter dt.da.source == "${daSource}" ` +
    `| filter isNotNull(dt.smartscape_source.type) ` +
    `| summarize series = count(), by:{ metric.key, dt.smartscape_source.type }`;

  console.log(`Deriving AWS service → Smartscape node-type bridge on ${args.baseUrl}`);
  console.log(`  source=${daSource}  from=${from}`);
  const result = await client.query({ query, maxResultRecords: 50_000, fetchTimeoutSeconds: 90 });

  // service → (nodeType → series)
  const acc = new Map<string, Map<string, number>>();
  for (const rec of result.records ?? []) {
    const key = rec['metric.key'];
    const nodeType = rec['dt.smartscape_source.type'];
    const series = typeof rec['series'] === 'number' ? rec['series'] : Number(rec['series']) || 0;
    if (typeof key !== 'string' || typeof nodeType !== 'string' || !nodeType) continue;
    const svc = serviceFromMetricKey(key);
    if (!svc) continue;
    if (!acc.has(svc)) acc.set(svc, new Map());
    const m = acc.get(svc)!;
    m.set(nodeType, (m.get(nodeType) ?? 0) + series);
  }

  const services: Record<string, ServiceEntry> = {};
  const multiNode: string[] = [];
  for (const [svc, m] of [...acc.entries()].sort()) {
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const [topType, topSeries] = ranked[0]!;
    services[svc] = {
      nodeType: topType,
      series: topSeries,
      alternates: ranked.slice(1).map(([type, s]) => ({ type, series: s })),
    };
    if (ranked.length > 1) multiNode.push(svc);
  }

  const payload = {
    generated: new Date().toISOString(),
    baseUrl: args.baseUrl,
    daSource,
    from,
    serviceCount: Object.keys(services).length,
    services,
  };
  const outPath = join(outDir, 'entity-source-types.json');
  await writeFile(outPath, JSON.stringify(payload, null, 2));

  console.log(`  ${payload.serviceCount} services mapped to a Smartscape node type`);
  if (multiNode.length) {
    console.log(`  ${multiNode.length} multi-node services (dominant wins, rest → alternates):`);
    for (const svc of multiNode) {
      const e = services[svc]!;
      const alt = e.alternates.map((a) => `${a.type}(${a.series})`).join(', ');
      console.log(`    ${svc.padEnd(20)} ${e.nodeType}(${e.series})  + ${alt}`);
    }
  }
  console.log(`Wrote ${outPath}`);
}
