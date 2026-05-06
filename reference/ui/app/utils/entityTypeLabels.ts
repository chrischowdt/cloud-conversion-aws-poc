// ─── Entity type display labels ───────────────────────────────────────────────
//
// Maps DQL entity type identifiers to human-friendly plural nouns.
// Covers built-in classic types (uppercase, underscore-separated) and custom
// device sub-types (lowercase, colon-separated).

const ENTITY_TYPE_LABELS: Record<string, string> = {
  // AWS built-in
  ec2_instance: 'EC2 Instances',
  EC2_INSTANCE: 'EC2 Instances',
  ebs_volume: 'EBS Volumes',
  EBS_VOLUME: 'EBS Volumes',
  aws_lambda_function: 'Lambda Functions',
  AWS_LAMBDA_FUNCTION: 'Lambda Functions',
  auto_scaling_group: 'Auto Scaling Groups',
  AUTO_SCALING_GROUP: 'Auto Scaling Groups',
  aws_application_load_balancer: 'Application Load Balancers',
  AWS_APPLICATION_LOAD_BALANCER: 'Application Load Balancers',
  aws_network_load_balancer: 'Network Load Balancers',
  AWS_NETWORK_LOAD_BALANCER: 'Network Load Balancers',
  elastic_load_balancer: 'Classic Load Balancers',
  ELASTIC_LOAD_BALANCER: 'Classic Load Balancers',
  relational_database_service: 'RDS Instances',
  RELATIONAL_DATABASE_SERVICE: 'RDS Instances',
  dynamo_db_table: 'DynamoDB Tables',
  DYNAMO_DB_TABLE: 'DynamoDB Tables',

  // AWS custom device sub-types
  'cloud:aws:s3': 'S3 Buckets',
  'cloud:aws:sqs': 'SQS Queues',
  'cloud:aws:sns': 'SNS Topics',
  'cloud:aws:kinesis': 'Kinesis Streams',
  'cloud:aws:cloudfront': 'CloudFront Distributions',
  'cloud:aws:elasticache': 'ElastiCache Clusters',
  'cloud:aws:redshift': 'Redshift Clusters',
  'cloud:aws:eks': 'EKS Clusters',
  'cloud:aws:ecs': 'ECS Services',
  'cloud:aws:ecs_cluster': 'ECS Clusters',

  // Azure built-in
  azure_vm: 'Virtual Machines',
  AZURE_VM: 'Virtual Machines',
  azure_vm_scale_set: 'VM Scale Sets',
  AZURE_VM_SCALE_SET: 'VM Scale Sets',
  azure_load_balancer: 'Load Balancers',
  AZURE_LOAD_BALANCER: 'Load Balancers',
  azure_event_hub_namespace: 'Event Hub Namespaces',
  AZURE_EVENT_HUB_NAMESPACE: 'Event Hub Namespaces',
  azure_event_hub: 'Event Hubs',
  AZURE_EVENT_HUB: 'Event Hubs',
  azure_redis_cache: 'Redis Caches',
  AZURE_REDIS_CACHE: 'Redis Caches',
  azure_function_app: 'Function Apps',
  AZURE_FUNCTION_APP: 'Function Apps',
  azure_storage_account: 'Storage Accounts',
  AZURE_STORAGE_ACCOUNT: 'Storage Accounts',
  azure_cosmos_db: 'Cosmos DB Accounts',
  AZURE_COSMOS_DB: 'Cosmos DB Accounts',
  azure_web_app: 'Web Apps',
  AZURE_WEB_APP: 'Web Apps',
  azure_sql_server: 'SQL Servers',
  AZURE_SQL_SERVER: 'SQL Servers',
  azure_sql_database: 'SQL Databases',
  AZURE_SQL_DATABASE: 'SQL Databases',

  // Azure custom device sub-types
  'cloud:azure:aks': 'AKS Clusters',
  'cloud:azure:container_registry': 'Container Registries',
  'cloud:azure:service_bus': 'Service Bus Namespaces',
  'cloud:azure:app_service_plan': 'App Service Plans',

  // GCP custom device sub-types
  'cloud:gcp:gce_instance': 'GCE Instances',
  'cloud:gcp:gke_cluster': 'GKE Clusters',
  'cloud:gcp:cloud_sql': 'Cloud SQL Instances',
  'cloud:gcp:pubsub_topic': 'Pub/Sub Topics',
  'cloud:gcp:pubsub_subscription': 'Pub/Sub Subscriptions',
  'cloud:gcp:cloud_run_revision': 'Cloud Run Services',
  'cloud:gcp:cloud_storage': 'Cloud Storage Buckets',
  'cloud:gcp:bigquery': 'BigQuery Datasets',
  'cloud:gcp:cloud_function': 'Cloud Functions',
  'cloud:gcp:redis_instance': 'Memorystore Instances',
};

/**
 * Returns a human-friendly plural label for a DQL entity type identifier.
 *
 * For known types, returns the mapped label. For unknown types, strips known
 * provider prefixes, replaces underscores and colons with spaces, and
 * title-cases the result.
 */
export function entityTypeLabel(entityType: string): string {
  if (ENTITY_TYPE_LABELS[entityType]) {
    return ENTITY_TYPE_LABELS[entityType];
  }

  // Fallback: strip provider prefix, normalize separators, title-case
  let normalized = entityType;
  normalized = normalized.replace(/^cloud:(aws|azure|gcp):/, '');
  normalized = normalized.replace(/[_:]/g, ' ');
  return normalized
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
