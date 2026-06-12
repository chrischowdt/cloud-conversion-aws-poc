import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMultiNodeService,
  nodeTypeForCustomDeviceType,
  nodeTypeForMetricService,
  smartscapeDimForNodeType,
  SERVICE_NODE_TYPE_MAP,
} from './aws-service-node-types.ts';

describe('nodeTypeForMetricService', () => {
  it('resolves common services from the metric-key segment', () => {
    assert.equal(nodeTypeForMetricService('lambda'), 'AWS_LAMBDA_FUNCTION');
    assert.equal(nodeTypeForMetricService('dynamodb'), 'AWS_DYNAMODB_TABLE');
    assert.equal(nodeTypeForMetricService('ecs'), 'AWS_ECS_CLUSTER');
    assert.equal(nodeTypeForMetricService('sqs'), 'AWS_SQS_QUEUE');
  });

  it('uses the empirical (not doc-derived) node type where they differ', () => {
    // doc dacResourceType would give OPENSEARCHSERVICE / SERVERLESSCACHE — wrong.
    assert.equal(nodeTypeForMetricService('es'), 'AWS_OPENSEARCH_DOMAIN');
    assert.equal(nodeTypeForMetricService('elasticache'), 'AWS_ELASTICACHE_CACHECLUSTER');
    assert.equal(nodeTypeForMetricService('kafka'), 'AWS_MSK_CLUSTER');
  });

  it('returns undefined for an unknown service', () => {
    assert.equal(nodeTypeForMetricService('quantumledger'), undefined);
  });

  it('defaults multi-node services to the most-populated grain', () => {
    assert.equal(nodeTypeForMetricService('rds'), 'AWS_RDS_DBINSTANCE');
    assert.equal(nodeTypeForMetricService('docdb'), 'AWS_DOCDB_DBCLUSTER');
  });
});

describe('nodeTypeForCustomDeviceType', () => {
  it('resolves cloud:aws:X tokens by stripping the prefix', () => {
    assert.equal(nodeTypeForCustomDeviceType('cloud:aws:lambda'), 'AWS_LAMBDA_FUNCTION');
    assert.equal(nodeTypeForCustomDeviceType('cloud:aws:sqs'), 'AWS_SQS_QUEUE');
  });

  it('strips a :subtype suffix (cloud:aws:ecs:cluster → ecs)', () => {
    assert.equal(nodeTypeForCustomDeviceType('cloud:aws:ecs:cluster'), 'AWS_ECS_CLUSTER');
    assert.equal(nodeTypeForCustomDeviceType('cloud:aws:eks:cluster'), 'AWS_EKS_CLUSTER');
  });

  it('uses the alias table for tokens whose form differs from the metric segment', () => {
    assert.equal(nodeTypeForCustomDeviceType('cloud:aws:mq'), 'AWS_AMAZONMQ_BROKER');
    assert.equal(nodeTypeForCustomDeviceType('cloud:aws:documentdb'), 'AWS_DOCDB_DBCLUSTER');
    assert.equal(nodeTypeForCustomDeviceType('cloud:aws:aurora'), 'AWS_RDS_DBCLUSTER');
    assert.equal(nodeTypeForCustomDeviceType('cloud:aws:nat_gateway'), 'AWS_EC2_NATGATEWAY');
  });

  it('returns undefined for non-resource / unmapped tokens', () => {
    assert.equal(nodeTypeForCustomDeviceType('cloud:aws:region'), undefined);
    assert.equal(nodeTypeForCustomDeviceType('cloud:aws:account'), undefined);
  });
});

describe('smartscapeDimForNodeType', () => {
  it('lowercases the node type under the dt.smartscape. prefix', () => {
    assert.equal(smartscapeDimForNodeType('AWS_LAMBDA_FUNCTION'), 'dt.smartscape.aws_lambda_function');
    assert.equal(smartscapeDimForNodeType('AWS_RDS_DBINSTANCE'), 'dt.smartscape.aws_rds_dbinstance');
  });

  it('matches the dim convention for every node type in the bridge', () => {
    for (const nodeType of Object.values(SERVICE_NODE_TYPE_MAP)) {
      assert.equal(smartscapeDimForNodeType(nodeType), `dt.smartscape.${nodeType.toLowerCase()}`);
    }
  });
});

describe('isMultiNodeService', () => {
  it('flags cluster+instance services, not single-node ones', () => {
    assert.equal(isMultiNodeService('rds'), true);
    assert.equal(isMultiNodeService('docdb'), true);
    assert.equal(isMultiNodeService('neptune'), true);
    assert.equal(isMultiNodeService('lambda'), false);
    assert.equal(isMultiNodeService('dynamodb'), false);
  });
});
