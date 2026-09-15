/**
 * AWS service → Smartscape node-type bridge.
 *
 * Baked from `discover-entity-types` (a tenant's `entity-source-types.json`),
 * which reads each new-connection metric's `dt.smartscape_source.type`. Node
 * types are tenant-independent (AWS_LAMBDA_FUNCTION everywhere), so the bridge
 * lives here and the rewriter stays offline-correct; refresh with
 * `cct discover-entity-types` when AWS adds services.
 *
 * The rewriter uses it to disambiguate a classic `dt.entity.custom_device`
 * (which is "not planned" in Smartscape and would otherwise bail) to the real
 * node type, via the service segment of the query's metric key — generalizing
 * the credential-lookup-chain trick to every custom_device reference.
 *
 * Empirical, not derived from the dt-migration entities JSON: its
 * `dacResourceType` carries the wrong granularity for several services
 * (ecs→SERVICE not CLUSTER, es→OPENSEARCHSERVICE not OPENSEARCH,
 * elasticache→SERVERLESSCACHE not CACHECLUSTER). The metric source type is what
 * `dt.smartscape.<type>` dimensions actually match.
 *
 * Source: nic55601 (2026-06-12), 40 services, 67,424 series.
 */

/** metric-key service segment (`cloud.aws.<service>.…`) → Smartscape node type. */
export const SERVICE_NODE_TYPE_MAP: Record<string, string> = {
  amazonmq: 'AWS_AMAZONMQ_BROKER',
  applicationelb: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER',
  autoscaling: 'AWS_AUTOSCALING_AUTOSCALINGGROUP',
  backup: 'AWS_BACKUP_BACKUPVAULT',
  certificatemanager: 'AWS_ACM_CERTIFICATE',
  cloudfront: 'AWS_CLOUDFRONT_DISTRIBUTION',
  cognito: 'AWS_COGNITO_IDENTITYPOOL',
  containerinsights: 'AWS_EKS_CLUSTER',
  dax: 'AWS_DAX_CLUSTER',
  dms: 'AWS_DMS_REPLICATIONINSTANCE',
  docdb: 'AWS_DOCDB_DBCLUSTER',
  dynamodb: 'AWS_DYNAMODB_TABLE',
  ebs: 'AWS_EC2_VOLUME',
  ec2: 'AWS_EC2_INSTANCE',
  ecr: 'AWS_ECR_REPOSITORY',
  ecs: 'AWS_ECS_CLUSTER',
  ecs_containerinsights: 'AWS_ECS_CLUSTER',
  efs: 'AWS_EFS_FILESYSTEM',
  eks: 'AWS_EKS_CLUSTER',
  elasticache: 'AWS_ELASTICACHE_CACHECLUSTER',
  es: 'AWS_OPENSEARCH_DOMAIN',
  firehose: 'AWS_KINESISFIREHOSE_DELIVERYSTREAM',
  glue: 'AWS_GLUE_JOB',
  kafka: 'AWS_MSK_CLUSTER',
  kafkaconnect: 'AWS_KAFKACONNECT_CONNECTOR',
  kinesis: 'AWS_KINESIS_STREAM',
  lambda: 'AWS_LAMBDA_FUNCTION',
  logs: 'AWS_LOGS_LOGGROUP',
  natgateway: 'AWS_EC2_NATGATEWAY',
  neptune: 'AWS_NEPTUNE_DBCLUSTER',
  networkelb: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER',
  privatelinkendpoints: 'AWS_EC2_VPCENDPOINT',
  privatelinkservices: 'AWS_EC2_VPCENDPOINTSERVICE',
  rds: 'AWS_RDS_DBINSTANCE',
  redshift: 'AWS_REDSHIFT_CLUSTER',
  route53: 'AWS_ROUTE53_HEALTHCHECK',
  s3: 'AWS_S3_BUCKET',
  sns: 'AWS_SNS_TOPIC',
  sqs: 'AWS_SQS_QUEUE',
  states: 'AWS_STEPFUNCTIONS_STATEMACHINE',
  transitgateway: 'AWS_EC2_TRANSITGATEWAY',

  // Added 2026-06-16 from dac-aws-to-2ndgen-entities.json (node types derived
  // from dacResourceType) for dashboard-referenced services the metric probe
  // didn't see. Each node type was tenant-validated via `smartscapeNodes <T>`
  // (all returned nodes on nic55601). Keyed by every metric-key segment shape
  // that appears in the corpus (e.g. both `apigateway` and `api_gateway`).
  amazonmwaa: 'AWS_MWAA_ENVIRONMENT',
  apigateway: 'AWS_APIGATEWAY_RESTAPI',
  api_gateway: 'AWS_APIGATEWAY_RESTAPI',
  appsync: 'AWS_APPSYNC_GRAPHQLAPI',
  athena: 'AWS_ATHENA_WORKGROUP',
  aurora: 'AWS_RDS_DBCLUSTER',
  elasticmapreduce: 'AWS_EMR_CLUSTER',
  emr: 'AWS_EMR_CLUSTER',
  eventbridge: 'AWS_EVENTS_EVENTBUS',
  events: 'AWS_EVENTS_EVENTBUS',
  fsx: 'AWS_FSX_FILESYSTEM',
  kinesisanalytics: 'AWS_KINESISANALYTICSV2_APPLICATION',
  kinesis_data_firehose: 'AWS_KINESISFIREHOSE_DELIVERYSTREAM',
  kinesis_data_streams: 'AWS_KINESIS_STREAM',
  mwaa: 'AWS_MWAA_ENVIRONMENT',
};

/**
 * Services that emit metrics under >1 node type (cluster + instance). The
 * `SERVICE_NODE_TYPE_MAP` default is the most-populated grain on the probe
 * tenant; the rewriter warns when it picks one so the user can confirm.
 */
export const MULTI_NODE_SERVICES: Record<string, string[]> = {
  docdb: ['AWS_DOCDB_DBCLUSTER', 'AWS_DOCDB_DBINSTANCE'],
  neptune: ['AWS_NEPTUNE_DBCLUSTER', 'AWS_NEPTUNE_DBINSTANCE'],
  rds: ['AWS_RDS_DBINSTANCE', 'AWS_RDS_DBCLUSTER'],
  // The DAC entities JSON lists >1 resource type for these; default above is the
  // grain we picked (empirical for ecs/elasticache, first-listed otherwise).
  ecs: ['AWS_ECS_CLUSTER', 'AWS_ECS_SERVICE'],
  route53: ['AWS_ROUTE53_HEALTHCHECK', 'AWS_ROUTE53_HOSTEDZONE'],
  elasticache: ['AWS_ELASTICACHE_CACHECLUSTER', 'AWS_ELASTICACHE_SERVERLESSCACHE'],
  aurora: ['AWS_RDS_DBCLUSTER', 'AWS_RDS_DBINSTANCE'],
};

/**
 * Classic custom_device `entity.type` tokens whose service segment differs from
 * the metric-key form, or that emit no metrics on the probe tenant. Lets the
 * entity.type-filter path resolve when the metric-key path can't.
 */
export const CUSTOM_DEVICE_TYPE_ALIASES: Record<string, string> = {
  'cloud:aws:mq': 'AWS_AMAZONMQ_BROKER',
  'cloud:aws:documentdb': 'AWS_DOCDB_DBCLUSTER',
  'cloud:aws:aurora': 'AWS_RDS_DBCLUSTER',
  'cloud:aws:cloud_front': 'AWS_CLOUDFRONT_DISTRIBUTION',
  'cloud:aws:nat_gateway': 'AWS_EC2_NATGATEWAY',
  'cloud:aws:elasticachecustom': 'AWS_ELASTICACHE_CACHECLUSTER',
};

/** Smartscape dimension for a node type: `dt.smartscape.<lowercase node type>`. */
export function smartscapeDimForNodeType(nodeType: string): string {
  return `dt.smartscape.${nodeType.toLowerCase()}`;
}

/** Resolve a node type from a metric-key service segment (e.g. `lambda`). */
export function nodeTypeForMetricService(service: string): string | undefined {
  return SERVICE_NODE_TYPE_MAP[service];
}

/**
 * Resolve a node type from a classic custom_device `entity.type` token
 * (`cloud:aws:X`). Tries the explicit alias table first, then strips the
 * `cloud:aws:` prefix (and any `:subtype` suffix) and falls back to the
 * metric-service map.
 */
export function nodeTypeForCustomDeviceType(entityType: string): string | undefined {
  const alias = CUSTOM_DEVICE_TYPE_ALIASES[entityType];
  if (alias) return alias;
  const m = /^cloud:aws:([a-z0-9_]+)/.exec(entityType);
  return m ? SERVICE_NODE_TYPE_MAP[m[1]!] : undefined;
}

/** True when `service` maps to more than one node type (cluster + instance). */
export function isMultiNodeService(service: string): boolean {
  return service in MULTI_NODE_SERVICES;
}
