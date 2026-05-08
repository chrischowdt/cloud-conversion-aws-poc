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

export type EntityMappingStatus = 'available' | 'planned' | 'unclear' | 'not-planned';
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
  { classicEntityType: 'aws_lambda_function',         smartscapeDimension: 'dt.smartscape.aws.lambda_function',      smartscapeNodeType: 'AWS_LAMBDA_FUNCTION',                       status: 'available', source: 'dt-migration' },
  { classicEntityType: 'cloud:aws:lambda',            smartscapeDimension: 'dt.smartscape.aws.lambda_function',      smartscapeNodeType: 'AWS_LAMBDA_FUNCTION',                       status: 'available', source: 'dt-migration', notes: 'alias of aws_lambda_function' },
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
];

const BY_CLASSIC_TYPE = new Map(
  AWS_ENTITY_MAPPINGS.map((m) => [m.classicEntityType.toLowerCase(), m])
);

/**
 * Look up by `dt.entity.<type>` segment (the part after `dt.entity.`).
 * Case-insensitive — the classic API accepts both forms (e.g., `type("HOST")`
 * and `type("host")`) and we want to be robust to either.
 */
export function classicEntityToSmartscape(classicType: string): EntityMapping | null {
  return BY_CLASSIC_TYPE.get(classicType.toLowerCase()) ?? null;
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
