/**
 * Which Smartscape node types carry their own `dt.smartscape.<type>` dim
 * on new-connection metric series (`dt.da.source == "aws-metric-poller"`)?
 *
 * When the rewriter swaps a `dt.entity.X` ref to `dt.smartscape.<x>` AND
 * the new metric's series doesn't actually carry that dimension, the
 * subsequent `by:{dt.smartscape.<x>}` clause collapses all series to a
 * single null-keyed group. We flag this so the user can substitute either
 * `aws.arn` (always present) or the CloudWatch dimension name surfaced by
 * the metric's `.By.<Dim>` suffix.
 *
 * RE-VERIFIED 2026-06-17 (nic55601). The original 2026-05-12 probe is
 * superseded: the new connection's enrichment matured, and 13 of the 14
 * types that were "non-carriers" in May now DO carry their smartscape dim.
 * Re-probe method, per type: pick a live metric anchored at
 * `cloud.aws.<service>`, then
 *   `fetch metric.series | filter metric.key == "<key>"
 *      | summarize carried = countIf(isNotNull(`dt.smartscape.<type>`)),
 *                  distinct = countDistinctExact(`dt.smartscape.<type>`)`
 * A type is a carrier iff the dim is populated on every series AND has >1
 * distinct value (i.e. `by:{dt.smartscape.<type>}` produces real buckets,
 * not one null bucket). Examples that flipped May→June: ECS (287 distinct
 * cluster buckets over 1833 series), API Gateway (27/27), EFS (416/416),
 * NAT Gateway, VPC endpoints, EKS, EventBridge, autoscaling, ECR, AppSync,
 * Firehose, Route53. Only AWS_APIGATEWAYV2_API has NO new data on this
 * tenant, so it can't be re-verified and stays a (now-unreliable) non-carrier
 * — conservative: emit a non-blocking caveat rather than silently group wrong.
 *
 * Because the table drifts as the connection evolves, re-run the probe per
 * tenant before trusting it; see `carrier-reprobe` notes in STATUS.md.
 */

/**
 * Smartscape types whose own `dt.smartscape.<type>` dim IS carried on the
 * AWS new-connection metric series. Anything not in this set is a "non
 * carrier" — using its smartscape dim in `by:{...}` won't group as expected.
 */
export const SMARTSCAPE_METRIC_CARRIER_TYPES = new Set<string>([
  // Carriers since the original 2026-05-12 probe:
  'AWS_ACCOUNT',
  'AWS_AVAILABILITY_ZONE',
  'AWS_DYNAMODB_TABLE',
  'AWS_EC2_INSTANCE',
  'AWS_EC2_VOLUME',
  'AWS_ELASTICACHE_CACHECLUSTER',
  'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER',
  'AWS_KINESIS_STREAM',
  'AWS_LAMBDA_FUNCTION',
  'AWS_LOGS_LOGGROUP',
  'AWS_RDS_DBCLUSTER',
  'AWS_RDS_DBINSTANCE',
  'AWS_S3_BUCKET',
  'AWS_SNS_TOPIC',
  'AWS_SQS_QUEUE',
  // Re-verified carriers 2026-06-17 (were non-carriers in the May probe):
  'AWS_AUTOSCALING_AUTOSCALINGGROUP',
  'AWS_APIGATEWAY_RESTAPI',
  'AWS_APPSYNC_GRAPHQLAPI',
  'AWS_ECR_REPOSITORY',
  'AWS_ECS_CLUSTER',
  'AWS_EFS_FILESYSTEM',
  'AWS_EC2_NATGATEWAY',
  'AWS_EC2_VPCENDPOINT',
  'AWS_EC2_VPCENDPOINTSERVICE',
  'AWS_EKS_CLUSTER',
  'AWS_EVENTS_EVENTBUS',
  'AWS_KINESISFIREHOSE_DELIVERYSTREAM',
  'AWS_ROUTE53_HEALTHCHECK',
]);

/**
 * Smartscape types we can't confirm carry their own dim on metric series.
 * Listed explicitly so the warning text can suggest a concrete alternative
 * rather than a generic "unknown — substitute by hand" hint. As of the
 * 2026-06-17 re-probe this is down to the one type with no new data on the
 * verification tenant (see header). It may well be a carrier too — we keep
 * the (non-blocking) caveat only because we lack positive evidence.
 */
export const SMARTSCAPE_METRIC_NON_CARRIERS = new Set<string>([
  'AWS_APIGATEWAYV2_API',
]);

export function isMetricCarrier(smartscapeNodeType: string): boolean {
  return SMARTSCAPE_METRIC_CARRIER_TYPES.has(smartscapeNodeType);
}

export function isKnownNonCarrier(smartscapeNodeType: string): boolean {
  return SMARTSCAPE_METRIC_NON_CARRIERS.has(smartscapeNodeType);
}
