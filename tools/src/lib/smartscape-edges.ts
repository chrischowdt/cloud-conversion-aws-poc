/**
 * Subset of Smartscape edges from
 * `dt-migration/references/relationship-mappings.md`, focused on AWS and
 * the topology types that AWS migrations typically traverse.
 *
 * Used by the relationship translator to validate that a (source, target)
 * pair really has the edge we'd emit. Without this validation, naively
 * mapping classic relationship names → smartscape edge names produces
 * wrong DQL for cases like `belongsTo(AWS_AVAILABILITY_ZONE)` from EC2,
 * which actually uses `runs_on` in Smartscape, not `belongs_to`.
 */

export interface SmartscapeEdge {
  source: string;
  edge: string;
  target: string;
}

export const SMARTSCAPE_EDGES: SmartscapeEdge[] = [
  // AWS Auto Scaling
  { source: 'AWS_AUTOSCALING_AUTOSCALINGGROUP', edge: 'contains', target: 'AWS_EC2_INSTANCE' },
  { source: 'AWS_AUTOSCALING_AUTOSCALINGGROUP', edge: 'is_attached_to', target: 'AWS_ELASTICLOADBALANCINGV2_TARGETGROUP' },
  { source: 'AWS_AUTOSCALING_AUTOSCALINGGROUP', edge: 'is_attached_to', target: 'AWS_ELASTICLOADBALANCING_LOADBALANCER' },
  { source: 'AWS_AUTOSCALING_AUTOSCALINGGROUP', edge: 'runs_on', target: 'AWS_AVAILABILITY_ZONE' },
  { source: 'AWS_AUTOSCALING_AUTOSCALINGGROUP', edge: 'uses', target: 'AWS_EC2_LAUNCHTEMPLATE' },

  // AWS region/AZ
  { source: 'AWS_AVAILABILITY_ZONE', edge: 'is_part_of', target: 'AWS_REGION' },

  // EC2 instance
  { source: 'AWS_EC2_INSTANCE', edge: 'is_attached_to', target: 'AWS_EC2_SUBNET' },
  { source: 'AWS_EC2_INSTANCE', edge: 'is_attached_to', target: 'AWS_EC2_VPC' },
  { source: 'AWS_EC2_INSTANCE', edge: 'runs_on', target: 'AWS_AVAILABILITY_ZONE' },
  { source: 'AWS_EC2_INSTANCE', edge: 'uses', target: 'AWS_EC2_SECURITYGROUP' },
  { source: 'AWS_EC2_INSTANCE', edge: 'uses', target: 'AWS_IAM_INSTANCEPROFILE' },

  // EC2 EIP / NIC / Subnet / Volume
  { source: 'AWS_EC2_EIP', edge: 'is_attached_to', target: 'AWS_EC2_INSTANCE' },
  { source: 'AWS_EC2_EIP', edge: 'is_attached_to', target: 'AWS_EC2_NETWORKINTERFACE' },
  { source: 'AWS_EC2_NETWORKINTERFACE', edge: 'is_attached_to', target: 'AWS_EC2_INSTANCE' },
  { source: 'AWS_EC2_NETWORKINTERFACE', edge: 'is_attached_to', target: 'AWS_EC2_SUBNET' },
  { source: 'AWS_EC2_NETWORKINTERFACE', edge: 'is_attached_to', target: 'AWS_EC2_VPC' },
  { source: 'AWS_EC2_NETWORKINTERFACE', edge: 'runs_on', target: 'AWS_AVAILABILITY_ZONE' },
  { source: 'AWS_EC2_NETWORKINTERFACE', edge: 'uses', target: 'AWS_EC2_SECURITYGROUP' },
  { source: 'AWS_EC2_SUBNET', edge: 'is_attached_to', target: 'AWS_EC2_VPC' },
  { source: 'AWS_EC2_SUBNET', edge: 'runs_on', target: 'AWS_AVAILABILITY_ZONE' },
  { source: 'AWS_EC2_VOLUME', edge: 'is_attached_to', target: 'AWS_EC2_INSTANCE' },
  { source: 'AWS_EC2_VOLUME', edge: 'runs_on', target: 'AWS_AVAILABILITY_ZONE' },

  // ECS / EKS
  { source: 'AWS_ECS_SERVICE', edge: 'belongs_to', target: 'AWS_ECS_CLUSTER' },
  { source: 'AWS_ECS_SERVICE', edge: 'balanced_by', target: 'AWS_ELASTICLOADBALANCINGV2_TARGETGROUP' },
  { source: 'AWS_ECS_SERVICE', edge: 'is_attached_to', target: 'AWS_EC2_SUBNET' },
  { source: 'AWS_ECS_SERVICE', edge: 'uses', target: 'AWS_EC2_SECURITYGROUP' },
  { source: 'AWS_ECS_TASK', edge: 'belongs_to', target: 'AWS_ECS_CLUSTER' },
  { source: 'AWS_ECS_TASK', edge: 'is_part_of', target: 'AWS_ECS_SERVICE' },
  { source: 'AWS_ECS_TASK', edge: 'runs_on', target: 'AWS_AVAILABILITY_ZONE' },
  { source: 'AWS_EKS_NODEGROUP', edge: 'belongs_to', target: 'AWS_EKS_CLUSTER' },

  // ELB / ALB / NLB
  { source: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER', edge: 'is_attached_to', target: 'AWS_EC2_SUBNET' },
  { source: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER', edge: 'is_attached_to', target: 'AWS_EC2_VPC' },
  { source: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER', edge: 'runs_on', target: 'AWS_AVAILABILITY_ZONE' },
  { source: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER', edge: 'uses', target: 'AWS_EC2_SECURITYGROUP' },
  { source: 'AWS_ELASTICLOADBALANCINGV2_TARGETGROUP', edge: 'balanced_by', target: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER' },
  { source: 'AWS_ELASTICLOADBALANCINGV2_TARGETGROUP', edge: 'balances', target: 'AWS_EC2_INSTANCE' },
  { source: 'AWS_ELASTICLOADBALANCING_LOADBALANCER', edge: 'balances', target: 'AWS_EC2_INSTANCE' },
  { source: 'AWS_ELASTICLOADBALANCING_LOADBALANCER', edge: 'is_attached_to', target: 'AWS_EC2_SUBNET' },
  { source: 'AWS_ELASTICLOADBALANCING_LOADBALANCER', edge: 'is_attached_to', target: 'AWS_EC2_VPC' },
  { source: 'AWS_ELASTICLOADBALANCING_LOADBALANCER', edge: 'runs_on', target: 'AWS_AVAILABILITY_ZONE' },

  // Lambda
  { source: 'AWS_LAMBDA_FUNCTION', edge: 'is_attached_to', target: 'AWS_EC2_SUBNET' },
  { source: 'AWS_LAMBDA_FUNCTION', edge: 'is_attached_to', target: 'AWS_EC2_VPC' },

  // RDS
  { source: 'AWS_RDS_DBINSTANCE', edge: 'is_attached_to', target: 'AWS_EC2_SUBNET' },
  { source: 'AWS_RDS_DBINSTANCE', edge: 'is_attached_to', target: 'AWS_EC2_VPC' },
  { source: 'AWS_RDS_DBINSTANCE', edge: 'is_part_of', target: 'AWS_RDS_DBCLUSTER' },
  { source: 'AWS_RDS_DBINSTANCE', edge: 'runs_on', target: 'AWS_AVAILABILITY_ZONE' },

  // Generic compute
  { source: 'HOST', edge: 'runs_on', target: 'AWS_EC2_INSTANCE' },
  { source: 'CONTAINER', edge: 'runs_on', target: 'HOST' },
  { source: 'PROCESS', edge: 'runs_on', target: 'HOST' },
  { source: 'SERVICE', edge: 'runs_on', target: 'HOST' },
  { source: 'SERVICE', edge: 'runs_on', target: 'CONTAINER' },
  { source: 'SERVICE', edge: 'runs_on', target: 'PROCESS' },
];

/**
 * Find every edge connecting `source` to `target` (no direction assumption).
 * Returns both forward (source→target) and reverse (target→source) matches.
 */
export function findEdgesBetween(source: string, target: string): Array<SmartscapeEdge & { forward: boolean }> {
  const out: Array<SmartscapeEdge & { forward: boolean }> = [];
  for (const e of SMARTSCAPE_EDGES) {
    if (e.source === source && e.target === target) out.push({ ...e, forward: true });
    else if (e.source === target && e.target === source) out.push({ ...e, forward: false });
  }
  return out;
}
