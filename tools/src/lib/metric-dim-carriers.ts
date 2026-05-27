/**
 * Which Smartscape node types carry their own `dt.smartscape.<type>` dim
 * on new-connection metric series (`dt.da.source == "aws-metric-poller"`)?
 *
 * Discovered empirically on the tenant (2026-05-12) by scanning
 * `fetch metric.series | filter dt.da.source == "aws-metric-poller"` and
 * checking which `dt.smartscape.aws_*` fields were populated per
 * `dt.smartscape_source.type`.
 *
 * When the rewriter swaps a `dt.entity.X` ref to `dt.smartscape.<x>` AND
 * the new metric's series doesn't actually carry that dimension, the
 * subsequent `by:{dt.smartscape.<x>}` clause collapses all series to a
 * single null-keyed group. We flag this so the user can substitute either
 * `aws.arn` (always present) or the CloudWatch dimension name surfaced by
 * the metric's `.By.<Dim>` suffix.
 */

/**
 * Smartscape types whose own `dt.smartscape.<type>` dim IS carried on the
 * AWS new-connection metric series. Anything not in this set is a "non
 * carrier" — using its smartscape dim in `by:{...}` won't group as expected.
 */
export const SMARTSCAPE_METRIC_CARRIER_TYPES = new Set<string>([
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
]);

/**
 * Smartscape types confirmed to NOT carry their own dim on metric series.
 * Listed explicitly so the warning text can suggest a concrete alternative
 * rather than a generic "unknown — substitute by hand" hint.
 */
export const SMARTSCAPE_METRIC_NON_CARRIERS = new Set<string>([
  'AWS_AUTOSCALING_AUTOSCALINGGROUP',
  'AWS_APIGATEWAY_RESTAPI',
  'AWS_APIGATEWAYV2_API',
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

export function isMetricCarrier(smartscapeNodeType: string): boolean {
  return SMARTSCAPE_METRIC_CARRIER_TYPES.has(smartscapeNodeType);
}

export function isKnownNonCarrier(smartscapeNodeType: string): boolean {
  return SMARTSCAPE_METRIC_NON_CARRIERS.has(smartscapeNodeType);
}
