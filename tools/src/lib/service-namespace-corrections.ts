/**
 * service-namespace-corrections — fix DAC "recommended" service namespaces that
 * the actual new-connection pipeline never produces.
 *
 * The DAC carries two keys per metric: `dacRecommendedMetricKey` (a Dynatrace
 * config-side name) and `dacAutodiscoveredMetricKey` (what CloudWatch metric
 * auto-discovery actually emits). For 12 services the recommended namespace
 * differs from the autodiscovered one, and our mapping baked in the recommended
 * (wrong) name — e.g. EMR mapped to `cloud.aws.emr_ec2.*`, but the real key is
 * `cloud.aws.elasticmapreduce.*`.
 *
 * Tenant-proven on nic55601 (2026-08): for every one of these 12, the recommended
 * namespace has ZERO collected series while the autodiscovered one is present.
 * So the autodiscovered namespace is the correct new key. Applied at lookup time
 * (recipe-lookup) so both the metric reconciliation and the dashboard rewriter
 * emit the real key.
 *
 * Source of truth: `dt-migration-cloud/references/dac-aws-to-2ndgen-metrics.json`
 * (compare `dacRecommendedMetricKey` vs `dacAutodiscoveredMetricKey` service seg).
 */

/** recommended-namespace → autodiscovered-namespace (the real new-connection form). */
export const SERVICE_NS_CORRECTIONS: Record<string, string> = {
  emr_ec2: 'elasticmapreduce',
  emr_serverless: 'emrserverless',
  opensearch_domain: 'es',
  opensearch_serverless: 'aoss',
  appstreams: 'appstream',
  flink: 'kinesisanalytics',
  kinesisdatastreams: 'kinesis',
  sagemaker_invocation: 'sagemaker',
  sagemaker_endpoint: 'sagemaker_endpoints',
  kafka_connect: 'kafkaconnect',
  privateca: 'acmprivateca',
  vpc_sitetositevpnconnection: 'vpn',
};

const CORRECTION_RE = new RegExp(
  `^((?:builtin:|ext:|dt\\.)?cloud\\.aws\\.)(${Object.keys(SERVICE_NS_CORRECTIONS).join('|')})(\\.)`
);

/**
 * Rewrite the service segment of a new-form AWS metric key from its (wrong)
 * DAC-recommended namespace to the real autodiscovered one. No-op for keys not
 * in the correction set (the overwhelming majority).
 */
export function correctServiceNamespace<T extends string | null | undefined>(key: T): T {
  if (!key) return key;
  return key.replace(CORRECTION_RE, (_m, prefix: string, svc: string, dot: string) => `${prefix}${SERVICE_NS_CORRECTIONS[svc]}${dot}`) as T;
}
