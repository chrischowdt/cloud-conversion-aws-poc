/**
 * AWS classic-to-Smartscape entity mappings.
 *
 * Source of truth: `dt-migration/references/type-mappings.md`. Where the skill
 * file lists a mapping it's authoritative; the rest are entries we discovered
 * on real tenant data (`dt.source_entity.type` on metric series + the
 * matching `dt.smartscape.*` dimension on new metrics).
 *
 * When the dt-migration skill is updated and adds new mappings, propagate
 * them here. The `source` field tracks provenance so we can spot drift.
 */

export type EntityMappingStatus = 'available' | 'planned' | 'unclear' | 'not-planned' | 'ambiguous';
export type EntityMappingSource = 'dt-migration' | 'discovered';

export interface EntityMapping {
  /** Type segment after `dt.entity.` (e.g. "ec2_instance"). */
  classicEntityType: string;
  /** Full smartscape dimension name as it appears on metric series. */
  smartscapeDimension: string;
  /** Smartscape node type, used with `smartscapeNodes`. */
  smartscapeNodeType: string;
  status: EntityMappingStatus;
  source: EntityMappingSource;
  /**
   * When a single classic type maps to multiple Smartscape types (e.g.
   * cloud_application → 7 k8s workload kinds), `smartscapeDimension` and
   * `smartscapeNodeType` hold the default; this lists every candidate so
   * downstream code can warn that the user may need to pick a different one.
   */
  altSmartscapeNodeTypes?: string[];
  /** Free-form note. */
  notes?: string;
}

/**
 * AWS-focused subset. Includes both the dt-migration mappings and entries
 * we observed on the tested tenant.
 */
export const AWS_ENTITY_MAPPINGS: EntityMapping[] = [
  // From dt-migration/references/type-mappings.md
  { classicEntityType: 'application',                 smartscapeDimension: 'dt.smartscape.frontend',                 smartscapeNodeType: 'FRONTEND',                                  status: 'available', source: 'dt-migration' },
  { classicEntityType: 'auto_scaling_group',          smartscapeDimension: 'dt.smartscape.aws_autoscaling_autoscalinggroup', smartscapeNodeType: 'AWS_AUTOSCALING_AUTOSCALINGGROUP',  status: 'available', source: 'dt-migration' },
  { classicEntityType: 'aws_availability_zone',       smartscapeDimension: 'dt.smartscape.aws_availability_zone',    smartscapeNodeType: 'AWS_AVAILABILITY_ZONE',                     status: 'available', source: 'dt-migration' },
  { classicEntityType: 'aws_credentials',             smartscapeDimension: 'dt.smartscape.aws_account',              smartscapeNodeType: 'AWS_ACCOUNT',                               status: 'available', source: 'dt-migration' },
  { classicEntityType: 'aws_lambda_function',         smartscapeDimension: 'dt.smartscape.aws_lambda_function',      smartscapeNodeType: 'AWS_LAMBDA_FUNCTION',                       status: 'available', source: 'dt-migration', notes: 'Verified on tenant 2026-05-12: actual dim uses underscore, not dot (dt-migration/references/type-mappings.md had the dotted form as a typo).' },
  { classicEntityType: 'cloud:aws:lambda',            smartscapeDimension: 'dt.smartscape.aws_lambda_function',      smartscapeNodeType: 'AWS_LAMBDA_FUNCTION',                       status: 'available', source: 'dt-migration', notes: 'alias of aws_lambda_function' },
  // Kubernetes / cloud-application family — all from dt-migration type-mappings.md
  { classicEntityType: 'cloud_application',           smartscapeDimension: 'dt.smartscape.k8s_deployment',           smartscapeNodeType: 'K8S_DEPLOYMENT',                            status: 'ambiguous', source: 'dt-migration',
    altSmartscapeNodeTypes: ['K8S_DAEMONSET', 'K8S_STATEFULSET', 'K8S_REPLICASET', 'K8S_REPLICATIONCONTROLLER', 'K8S_JOB', 'K8S_DEPLOYMENTCONFIG'],
    notes: 'cloud_application maps to one of K8S_DEPLOYMENT/DAEMONSET/STATEFULSET/REPLICASET/REPLICATIONCONTROLLER/JOB/DEPLOYMENTCONFIG. Defaulting to K8S_DEPLOYMENT — verify against the workload kind.' },
  { classicEntityType: 'cloud_application_instance',  smartscapeDimension: 'dt.smartscape.k8s_pod',                  smartscapeNodeType: 'K8S_POD',                                   status: 'available', source: 'dt-migration' },
  { classicEntityType: 'cloud_application_namespace', smartscapeDimension: 'dt.smartscape.k8s_namespace',            smartscapeNodeType: 'K8S_NAMESPACE',                             status: 'available', source: 'dt-migration' },
  { classicEntityType: 'container_group_instance',    smartscapeDimension: 'dt.smartscape.container',                smartscapeNodeType: 'CONTAINER',                                 status: 'available', source: 'dt-migration' },
  { classicEntityType: 'custom_application',          smartscapeDimension: 'dt.smartscape.frontend',                 smartscapeNodeType: 'FRONTEND',                                  status: 'available', source: 'dt-migration' },
  { classicEntityType: 'kubernetes_cluster',          smartscapeDimension: 'dt.smartscape.k8s_cluster',              smartscapeNodeType: 'K8S_CLUSTER',                               status: 'available', source: 'dt-migration' },
  { classicEntityType: 'kubernetes_node',             smartscapeDimension: 'dt.smartscape.k8s_node',                 smartscapeNodeType: 'K8S_NODE',                                  status: 'available', source: 'dt-migration' },
  { classicEntityType: 'kubernetes_service',          smartscapeDimension: 'dt.smartscape.k8s_service',              smartscapeNodeType: 'K8S_SERVICE',                               status: 'available', source: 'dt-migration' },
  // Azure (commonly co-appear with AWS in multi-cloud dashboards)
  { classicEntityType: 'azure_region',                smartscapeDimension: 'dt.smartscape.azure_microsoft_resources_locations',         smartscapeNodeType: 'AZURE_MICROSOFT_RESOURCES_LOCATIONS',         status: 'available', source: 'dt-migration' },
  { classicEntityType: 'azure_subscription',          smartscapeDimension: 'dt.smartscape.azure_microsoft_resources_subscriptions',     smartscapeNodeType: 'AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS',     status: 'available', source: 'dt-migration' },
  { classicEntityType: 'azure_vm',                    smartscapeDimension: 'dt.smartscape.azure_microsoft_compute_virtualmachines',     smartscapeNodeType: 'AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES',     status: 'available', source: 'dt-migration' },
  { classicEntityType: 'azure_vm_scale_set',          smartscapeDimension: 'dt.smartscape.azure_microsoft_compute_virtualmachinescalesets', smartscapeNodeType: 'AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINESCALESETS', status: 'available', source: 'dt-migration' },
  // Synthetic + checks (planned)
  { classicEntityType: 'http_check',                  smartscapeDimension: 'dt.smartscape.http_check',               smartscapeNodeType: 'HTTP_CHECK',                                status: 'planned',   source: 'dt-migration' },
  { classicEntityType: 'http_check_step',             smartscapeDimension: 'dt.smartscape.http_check_step',          smartscapeNodeType: 'HTTP_CHECK_STEP',                           status: 'planned',   source: 'dt-migration' },
  { classicEntityType: 'os:service',                  smartscapeDimension: 'dt.smartscape.os_service',               smartscapeNodeType: 'OS_SERVICE',                                status: 'planned',   source: 'dt-migration' },
  { classicEntityType: 'service_instance',            smartscapeDimension: 'dt.smartscape.service_deployment',       smartscapeNodeType: 'SERVICE_DEPLOYMENT',                        status: 'planned',   source: 'dt-migration' },
  { classicEntityType: 'synthetic_location',          smartscapeDimension: 'dt.smartscape.synthetic_location',       smartscapeNodeType: 'SYNTHETIC_LOCATION',                        status: 'planned',   source: 'dt-migration' },
  { classicEntityType: 'synthetic_test',              smartscapeDimension: 'dt.smartscape.synthetic_test',           smartscapeNodeType: 'SYNTHETIC_TEST',                            status: 'planned',   source: 'dt-migration' },
  { classicEntityType: 'synthetic_test_step',         smartscapeDimension: 'dt.smartscape.synthetic_test_step',      smartscapeNodeType: 'SYNTHETIC_TEST_STEP',                       status: 'planned',   source: 'dt-migration' },
  { classicEntityType: 'disk',                        smartscapeDimension: 'dt.smartscape.disk',                     smartscapeNodeType: 'DISK',                                      status: 'available', source: 'dt-migration' },
  { classicEntityType: 'ebs_volume',                  smartscapeDimension: 'dt.smartscape.aws_ec2_volume',           smartscapeNodeType: 'AWS_EC2_VOLUME',                            status: 'available', source: 'dt-migration' },
  { classicEntityType: 'ec2_instance',                smartscapeDimension: 'dt.smartscape.aws_ec2_instance',         smartscapeNodeType: 'AWS_EC2_INSTANCE',                          status: 'available', source: 'dt-migration' },
  { classicEntityType: 'host',                        smartscapeDimension: 'dt.smartscape.host',                     smartscapeNodeType: 'HOST',                                      status: 'available', source: 'dt-migration' },
  { classicEntityType: 'network_interface',           smartscapeDimension: 'dt.smartscape.network_interface',        smartscapeNodeType: 'NETWORK_INTERFACE',                         status: 'available', source: 'dt-migration' },
  { classicEntityType: 'process_group_instance',      smartscapeDimension: 'dt.smartscape.process',                  smartscapeNodeType: 'PROCESS',                                   status: 'available', source: 'dt-migration' },
  { classicEntityType: 'relational_database_service', smartscapeDimension: 'dt.smartscape.aws_rds_dbinstance',       smartscapeNodeType: 'AWS_RDS_DBINSTANCE',                        status: 'available', source: 'dt-migration' },
  { classicEntityType: 'service',                     smartscapeDimension: 'dt.smartscape.service',                  smartscapeNodeType: 'SERVICE',                                   status: 'available', source: 'dt-migration' },

  // Special / no-Smartscape-replacement (skill marks these explicitly)
  { classicEntityType: 'host_group',                  smartscapeDimension: '',                                       smartscapeNodeType: '',                                          status: 'not-planned', source: 'dt-migration', notes: 'No standalone entity. Use dt.host_group.id on HOST.' },
  { classicEntityType: 'process_group',               smartscapeDimension: '',                                       smartscapeNodeType: '',                                          status: 'not-planned', source: 'dt-migration', notes: 'No standalone entity. Use dt.process_group.id on PROCESS.' },
  { classicEntityType: 'container_group',             smartscapeDimension: '',                                       smartscapeNodeType: '',                                          status: 'not-planned', source: 'dt-migration', notes: 'No standalone entity.' },
  { classicEntityType: 'custom_device',               smartscapeDimension: '',                                       smartscapeNodeType: '',                                          status: 'not-planned', source: 'dt-migration' },
  { classicEntityType: 'custom_device_group',         smartscapeDimension: '',                                       smartscapeNodeType: '',                                          status: 'not-planned', source: 'dt-migration' },
  { classicEntityType: 'environment',                 smartscapeDimension: '',                                       smartscapeNodeType: '',                                          status: 'not-planned', source: 'dt-migration' },

  // Discovered from tenant (not in skill file as of 2026-05-06; should be added upstream)
  { classicEntityType: 'dynamo_db_table',                 smartscapeDimension: 'dt.smartscape.aws_dynamodb_table',                       smartscapeNodeType: 'AWS_DYNAMODB_TABLE',                          status: 'available', source: 'discovered' },
  { classicEntityType: 'aws_application_load_balancer',   smartscapeDimension: 'dt.smartscape.aws_elasticloadbalancingv2_loadbalancer', smartscapeNodeType: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER',     status: 'available', source: 'discovered' },
  { classicEntityType: 'aws_network_load_balancer',       smartscapeDimension: 'dt.smartscape.aws_elasticloadbalancingv2_loadbalancer', smartscapeNodeType: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER',     status: 'available', source: 'discovered', notes: 'Both ALB and NLB map to the v2 load balancer node type.' },
  { classicEntityType: 'cloud:aws:applicationelb',        smartscapeDimension: 'dt.smartscape.aws_elasticloadbalancingv2_loadbalancer', smartscapeNodeType: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER',     status: 'available', source: 'discovered', notes: 'alias of aws_application_load_balancer' },

  // From dt-migration/references/entity-type-mapping.md §1 (May 2026 refresh).
  // Classic ELB has no new-connection equivalent.
  { classicEntityType: 'elastic_load_balancer',           smartscapeDimension: '',                                                       smartscapeNodeType: '',                                            status: 'not-planned', source: 'dt-migration', notes: 'Classic ELB is not in the new connection. Re-architect onto AWS_ELASTICLOADBALANCINGV2_LOADBALANCER (ALB/NLB) before migrating.' },
  // Custom-device cloud:aws:* sub-types — same Smartscape targets as
  // CUSTOM_DEVICE_AWS_TYPE_MAP in dql-rewriter.ts. Listed here so the generic
  // dim-swap and relationship-bracket passes recognize bare references like
  // `dt.entity.cloud:aws:s3` outside of a fetch+filter shape.
  { classicEntityType: 'cloud:aws:s3',                    smartscapeDimension: 'dt.smartscape.aws_s3_bucket',                            smartscapeNodeType: 'AWS_S3_BUCKET',                               status: 'available', source: 'dt-migration' },
  { classicEntityType: 'cloud:aws:aurora',                smartscapeDimension: 'dt.smartscape.aws_rds_dbcluster',                        smartscapeNodeType: 'AWS_RDS_DBCLUSTER',                           status: 'available', source: 'dt-migration' },
  { classicEntityType: 'cloud:aws:elasticachecustom',     smartscapeDimension: 'dt.smartscape.aws_elasticache_cachecluster',             smartscapeNodeType: 'AWS_ELASTICACHE_CACHECLUSTER',                status: 'available', source: 'dt-migration' },
  { classicEntityType: 'cloud:aws:sqs',                   smartscapeDimension: 'dt.smartscape.aws_sqs_queue',                            smartscapeNodeType: 'AWS_SQS_QUEUE',                               status: 'available', source: 'dt-migration' },
  { classicEntityType: 'cloud:aws:sns',                   smartscapeDimension: 'dt.smartscape.aws_sns_topic',                            smartscapeNodeType: 'AWS_SNS_TOPIC',                               status: 'available', source: 'dt-migration' },
  { classicEntityType: 'cloud:aws:cloud_front',           smartscapeDimension: 'dt.smartscape.aws_cloudfront_distribution',              smartscapeNodeType: 'AWS_CLOUDFRONT_DISTRIBUTION',                 status: 'available', source: 'dt-migration' },
  { classicEntityType: 'cloud:aws:nat_gateway',           smartscapeDimension: 'dt.smartscape.aws_ec2_natgateway',                       smartscapeNodeType: 'AWS_EC2_NATGATEWAY',                          status: 'available', source: 'dt-migration' },
  // Found blocking real dashboards on the lower tenant: these three are AWS
  // entity types that were simply absent from the table, so every query using
  // them reported `unmapped-entity-type` and the whole asset stayed in the
  // blocked lane. Node types probed on the tenant, not assumed:
  // AWS_ECS_CLUSTER 2360 nodes, AWS_EMR_CLUSTER 233, AWS_MSK_CLUSTER 132.
  // `AWS_KAFKA_CLUSTER` does not exist — classic `cloud:aws:kafka` is MSK.
  // EMR nodes carry an empty `name`; the mapping is still correct, but a
  // converted query that displays the name will look blank.
  // Both the bare and the `:cluster`-suffixed classic types hold ECS CLUSTERS
  // (1499 vs 1534 entities on the tenant, all named `…-cluster`, both stored
  // as CUSTOM_DEVICE). Mapping only the suffixed one left real notebooks
  // blocked on `dt.entity.cloud:aws:ecs`.
  // Classic types that appear in real dashboards under spellings the product
  // entity file does not carry, so discover-entity-candidates could not reach
  // them (it has `cloud:aws:kinesis:data_analytics`, the dashboards write
  // `cloud:aws:kinesisanalytics`). Node types probed on nic55601:
  // KINESISANALYTICSV2 161, MWAA 69, KAFKACONNECT 234, S3 27523, ACCOUNT 991,
  // REGION 17 — all returning named nodes.
  // NOT added: cloud:aws:documentdb. AWS_DOCDB_DBCLUSTER returned 0 nodes on
  // BOTH tenants, so there is no evidence for the mapping and guessing one
  // would point queries at an empty node type.
  { classicEntityType: 'cloud:aws:kinesisanalytics',     smartscapeDimension: 'dt.smartscape.aws_kinesisanalyticsv2_application', smartscapeNodeType: 'AWS_KINESISANALYTICSV2_APPLICATION', status: 'available', source: 'discovered' },
  { classicEntityType: 'cloud:aws:mwaa',                  smartscapeDimension: 'dt.smartscape.aws_mwaa_environment',              smartscapeNodeType: 'AWS_MWAA_ENVIRONMENT',              status: 'available', source: 'discovered' },
  { classicEntityType: 'cloud:aws:mwaaenvironment',       smartscapeDimension: 'dt.smartscape.aws_mwaa_environment',              smartscapeNodeType: 'AWS_MWAA_ENVIRONMENT',              status: 'available', source: 'discovered', notes: 'alias of cloud:aws:mwaa' },
  { classicEntityType: 'cloud:aws:kafkaconnect',          smartscapeDimension: 'dt.smartscape.aws_kafkaconnect_connector',        smartscapeNodeType: 'AWS_KAFKACONNECT_CONNECTOR',        status: 'available', source: 'discovered' },
  { classicEntityType: 's3bucket',                        smartscapeDimension: 'dt.smartscape.aws_s3_bucket',                     smartscapeNodeType: 'AWS_S3_BUCKET',                     status: 'available', source: 'discovered', notes: 'bare spelling of cloud:aws:s3' },
  { classicEntityType: 'cloud:aws:account',               smartscapeDimension: 'dt.smartscape.aws_account',                       smartscapeNodeType: 'AWS_ACCOUNT',                       status: 'available', source: 'discovered' },
  { classicEntityType: 'cloud:aws:region',                smartscapeDimension: 'dt.smartscape.aws_region',                        smartscapeNodeType: 'AWS_REGION',                        status: 'available', source: 'discovered' },
  { classicEntityType: 'cloud:aws:ecs',                   smartscapeDimension: 'dt.smartscape.aws_ecs_cluster',                          smartscapeNodeType: 'AWS_ECS_CLUSTER',                             status: 'available', source: 'discovered' },
  { classicEntityType: 'cloud:aws:ecs:cluster',           smartscapeDimension: 'dt.smartscape.aws_ecs_cluster',                          smartscapeNodeType: 'AWS_ECS_CLUSTER',                             status: 'available', source: 'discovered' },
  { classicEntityType: 'cloud:aws:emr',                   smartscapeDimension: 'dt.smartscape.aws_emr_cluster',                          smartscapeNodeType: 'AWS_EMR_CLUSTER',                             status: 'available', source: 'discovered', notes: 'nodes have an empty name on the tenant' },
  { classicEntityType: 'cloud:aws:kafka',                 smartscapeDimension: 'dt.smartscape.aws_msk_cluster',                          smartscapeNodeType: 'AWS_MSK_CLUSTER',                             status: 'available', source: 'discovered', notes: 'classic kafka == MSK' },
  { classicEntityType: 'cloud:aws:eks:cluster',           smartscapeDimension: 'dt.smartscape.aws_eks_cluster',                          smartscapeNodeType: 'AWS_EKS_CLUSTER',                             status: 'available', source: 'dt-migration' },
  { classicEntityType: 'cloud:aws:dynamodb',              smartscapeDimension: 'dt.smartscape.aws_dynamodb_table',                       smartscapeNodeType: 'AWS_DYNAMODB_TABLE',                          status: 'available', source: 'dt-migration', notes: 'alias of dynamo_db_table' },
  { classicEntityType: 'cloud:aws:redshift',              smartscapeDimension: 'dt.smartscape.aws_redshift_cluster',                     smartscapeNodeType: 'AWS_REDSHIFT_CLUSTER',                        status: 'available', source: 'dt-migration' },
];

const BY_CLASSIC_TYPE = new Map(
  AWS_ENTITY_MAPPINGS.map((m) => [m.classicEntityType.toLowerCase(), m])
);

/**
 * Add mappings discovered from the product team's entity file and VERIFIED
 * against a tenant (see `entity-candidates.ts` / `discover-entity-candidates`).
 *
 * Curated entries always win: this only fills gaps. A hand-written row carries
 * knowledge the derived name cannot — `cloud:aws:kafka` is MSK, EMR nodes have
 * an empty `name` — so a derived entry must never overwrite one.
 *
 * Returns how many were actually added, so callers can report honestly rather
 * than implying the whole file was adopted.
 */
export function registerDiscoveredMappings(
  discovered: Array<{ classicEntityType: string; smartscapeNodeType: string; smartscapeDimension: string }>
): number {
  let added = 0;
  for (const d of discovered) {
    const key = d.classicEntityType.toLowerCase();
    if (BY_CLASSIC_TYPE.has(key)) continue;
    if (!d.smartscapeNodeType || !d.smartscapeNodeType.startsWith('AWS_')) continue;
    BY_CLASSIC_TYPE.set(key, {
      classicEntityType: key,
      smartscapeDimension: d.smartscapeDimension || `dt.smartscape.${d.smartscapeNodeType.toLowerCase()}`,
      smartscapeNodeType: d.smartscapeNodeType,
      status: 'available',
      source: 'discovered',
      notes: 'derived from the skill entity file, node type verified on the tenant',
    });
    added++;
  }
  return added;
}

/**
 * Look up by `dt.entity.<type>` segment (the part after `dt.entity.`).
 * Case-insensitive — the classic API accepts both forms (e.g., `type("HOST")`
 * and `type("host")`) and we want to be robust to either.
 */
export function classicEntityToSmartscape(classicType: string): EntityMapping | null {
  return BY_CLASSIC_TYPE.get(classicType.toLowerCase()) ?? null;
}

/**
 * Classic types with no Smartscape node (`not-planned`, empty node type) that
 * are NOT AWS — they belong to the general/APM/K8s migration, not the AWS
 * cloud integration. (Split out because other empty-node-type entries like
 * `elastic_load_balancer` and `custom_device` ARE AWS.)
 */
const NON_AWS_NOT_PLANNED = new Set<string>([
  'process_group',
  'host_group',
  'container_group',
  'custom_device_group',
  'environment',
]);

export type EntityScope = 'aws' | 'non-aws' | 'unknown';

/**
 * Whether a classic entity type is in scope for the **AWS** cloud-integration
 * migration. This automation only rewrites AWS resources; every non-AWS entity
 * (APM `service`/`host`/`process_group[_instance]`, RUM `application`,
 * Kubernetes `cloud_application*`/`kubernetes_*`, `azure_*`, `disk`,
 * `network_interface`, …) is left UNTOUCHED — it migrates with the general
 * classic→Grail tooling. Converting those here is out of scope and, for heavy
 * process/APM tiles, produces DQL that fails at runtime (e.g. a
 * `dt.smartscape.process` join hitting `ENRICHMENT_FUNCTION_TABLE_SIZE`).
 *
 * Discriminator: AWS entities map to an `AWS_*` Smartscape node type. Empty
 * node types (not-planned) split via `NON_AWS_NOT_PLANNED`.
 *
 * `classicType` may be a bare type (`process_group_instance`) or a full ref
 * (`dt.entity.process_group_instance`, backticked or not).
 */
/**
 * Types that cannot be AWS, recognised WITHOUT a table entry.
 *
 * A type we've never catalogued used to fall through as `unknown`, which the
 * rewriter treats as a BLOCKING `unmapped-entity-type`. For a vendor or
 * other-cloud entity that is the wrong answer twice over: it can never be
 * migrated by this AWS automation, and blocking on it labels the whole asset
 * "manual rebuild" when its AWS content may convert perfectly well. Measured on
 * the two tenants: 753 and 865 such references, holding 1 and 12 assets
 * respectively in the blocked lane with nothing else wrong.
 *
 * Deliberately a prefix/vendor list, not a guess at AWS-ness: matching here only
 * downgrades a blocker to a note, and anything unrecognised still blocks.
 */
const CANNOT_BE_AWS =
  /^(ibmmq:|tibco:|f5:|solace|custom:solace|geoloc_site|mobile_application|application_method|multiprotocol_monitor|synthetic|http_check|vmware_|gcp_|cloud:gcp:|azure_|cloud:azure:|sql:|elasticsearch|kubernetes|cloud_application|openshift|citrix|sap|oracle|mssql|mysql|db2|nagios|zos|cics|ims|relic|appd|hypervisor|virtualmachine|datapower:|kafka:|service_method|network:|aruba:|host_id|container$|queue$|queue_instance$|process$|process_instance$)/;

export function entityScope(classicType: string): EntityScope {
  const t = classicType.replace(/^`/, '').replace(/`$/, '').replace(/^dt\.entity\./, '').toLowerCase();
  const m = classicEntityToSmartscape(t);
  if (!m) return CANNOT_BE_AWS.test(t) ? 'non-aws' : 'unknown';
  if (m.smartscapeNodeType.startsWith('AWS_')) return 'aws';
  if (m.smartscapeNodeType !== '') return 'non-aws';
  return NON_AWS_NOT_PLANNED.has(t) ? 'non-aws' : 'aws';
}

/**
 * Given a `dt.entity.X` reference (full string), return the mapping. Handles
 * both bare `dt.entity.ec2_instance` and backticked forms like
 * `` `dt.entity.cloud:aws:applicationelb` `` (DQL needs backticks for keys
 * with special characters).
 */
export function lookupByDimRef(dimRef: string): EntityMapping | null {
  const stripped = dimRef.replace(/^`|`$/g, '');
  if (!stripped.startsWith('dt.entity.')) return null;
  return classicEntityToSmartscape(stripped.slice('dt.entity.'.length));
}

/**
 * Reverse lookup: given a smartscape dimension reference (e.g.
 * `dt.smartscape.aws_ec2_instance`), find the corresponding mapping. Used
 * when we need the smartscape node TYPE (e.g. AWS_EC2_INSTANCE) for use
 * with `smartscapeNodes` / `traverse`.
 */
export function lookupBySmartscapeDim(smartscapeDimRef: string): EntityMapping | null {
  const stripped = smartscapeDimRef.replace(/^`|`$/g, '');
  for (const m of AWS_ENTITY_MAPPINGS) {
    if (m.smartscapeDimension === stripped) return m;
  }
  return null;
}
