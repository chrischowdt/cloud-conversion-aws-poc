import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveCandidates, nodeTypeFromResourceType, smartscapeDimFor } from './entity-candidates.ts';
import { classicEntityToSmartscape, registerDiscoveredMappings } from './entity-mappings.ts';

describe('nodeTypeFromResourceType', () => {
  it('derives the Smartscape node type from a CloudFormation resource type', () => {
    assert.equal(nodeTypeFromResourceType('AWS::ECS::Cluster'), 'AWS_ECS_CLUSTER');
    assert.equal(nodeTypeFromResourceType('AWS::EC2::Instance'), 'AWS_EC2_INSTANCE');
  });

  it('ignores non-AWS and malformed resource types', () => {
    assert.equal(nodeTypeFromResourceType('Microsoft.Cache/redis'), null);
    assert.equal(nodeTypeFromResourceType('AWS'), null);
    assert.equal(nodeTypeFromResourceType(''), null);
  });

  it('keeps the dim convention the mapping tests enforce', () => {
    assert.equal(smartscapeDimFor('AWS_ECS_CLUSTER'), 'dt.smartscape.aws_ecs_cluster');
  });
});

describe('deriveCandidates', () => {
  const file = [
    { supportingServiceEntityType: 'cloud:aws:ecs', builtInEntityType: 'not-matched', dacResourceType: 'AWS::ECS::Cluster' },
    { supportingServiceEntityType: 'not-matched', builtInEntityType: 'ec2_instance', dacResourceType: 'AWS::EC2::Instance' },
    { supportingServiceEntityType: 'not-matched', builtInEntityType: 'not-matched', dacResourceType: 'not-matched' },
  ];

  it('maps both the custom-device and built-in type onto the same resource', () => {
    const c = deriveCandidates(file);
    const byType = Object.fromEntries(c.map((x) => [x.classicEntityType, x.smartscapeNodeType]));
    assert.equal(byType['cloud:aws:ecs'], 'AWS_ECS_CLUSTER');
    assert.equal(byType['ec2_instance'], 'AWS_EC2_INSTANCE');
  });

  it('skips rows with nothing usable', () => {
    assert.equal(deriveCandidates(file).length, 2);
    assert.deepEqual(deriveCandidates('not an array'), []);
  });
});

describe('registerDiscoveredMappings', () => {
  it('never overwrites a curated entry', () => {
    // The hand-written rows carry knowledge a derived name cannot — classic
    // `cloud:aws:kafka` is MSK, not the `AWS_KAFKA_CLUSTER` a naive derivation
    // produces (that node type does not exist).
    const before = classicEntityToSmartscape('cloud:aws:kafka')!;
    registerDiscoveredMappings([
      { classicEntityType: 'cloud:aws:kafka', smartscapeNodeType: 'AWS_WRONG_GUESS', smartscapeDimension: 'dt.smartscape.aws_wrong_guess' },
    ]);
    assert.equal(classicEntityToSmartscape('cloud:aws:kafka')!.smartscapeNodeType, before.smartscapeNodeType);
  });

  it('fills a genuine gap and reports how many it added', () => {
    const added = registerDiscoveredMappings([
      { classicEntityType: 'cloud:aws:madeup_for_test', smartscapeNodeType: 'AWS_MADEUP_THING', smartscapeDimension: 'dt.smartscape.aws_madeup_thing' },
    ]);
    assert.equal(added, 1);
    assert.equal(classicEntityToSmartscape('cloud:aws:madeup_for_test')!.smartscapeNodeType, 'AWS_MADEUP_THING');
  });

  it('refuses anything that is not an AWS_ node type', () => {
    const added = registerDiscoveredMappings([
      { classicEntityType: 'azure:something', smartscapeNodeType: 'AZURE_VM', smartscapeDimension: 'dt.smartscape.azure_vm' },
    ]);
    assert.equal(added, 0);
  });
});
