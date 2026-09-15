import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseStreamsKey, parsePullKey, buildPullIndex, findPullEquivalent, dimRef } from './metric-streams.ts';

describe('parseStreamsKey', () => {
  it('splits a Metric Streams key into service and metric', () => {
    const p = parseStreamsKey('cloud.aws.kafka.maxOffsetLagByAccountIdClusterNameConsumerGroupRegionTopic');
    assert.deepEqual(p, { service: 'kafka', metric: 'maxOffsetLag' });
  });

  it('ignores polled and classic keys', () => {
    assert.equal(parseStreamsKey('cloud.aws.kafka.MaxOffsetLag.By.Cluster_Name'), null);
    assert.equal(parseStreamsKey('cloud.aws.ec2.cpu_utilization'), null);
  });
});

describe('parsePullKey', () => {
  it('turns underscored key dimensions into the spelling the SERIES uses', () => {
    // Verified on sfz80352: the key says `.By.Broker_ID.Cluster_Name`, the
    // series carries "Broker ID" and "Cluster Name". Grouping by the key's
    // spelling returns an empty tile without erroring.
    const p = parsePullKey('cloud.aws.kafka.BytesOutPerSec.By.Broker_ID.Cluster_Name');
    assert.deepEqual(p!.dims, ['Broker ID', 'Cluster Name']);
  });

  it('leaves a dimension without underscores alone', () => {
    assert.deepEqual(parsePullKey('cloud.aws.apigateway.4XXError.By.ApiName')!.dims, ['ApiName']);
  });
});

describe('findPullEquivalent', () => {
  const index = buildPullIndex([
    { key: 'cloud.aws.kafka.MaxOffsetLag.By.Cluster_Name.Consumer_Group.Topic', series: 31 },
    { key: 'cloud.aws.kafka.MaxOffsetLag.By.Cluster_Name', series: 4 },
    { key: 'cloud.aws.apigateway.4XXError.By.ApiName', series: 3 },
  ]);

  it('matches a push key to its polled twin across casing', () => {
    const c = findPullEquivalent('cloud.aws.kafka.maxOffsetLagByAccountIdClusterNameConsumerGroupRegionTopic', index)!;
    assert.equal(c.newKey, 'cloud.aws.kafka.MaxOffsetLag.By.Cluster_Name.Consumer_Group.Topic');
  });

  it('prefers the grain that actually carries data', () => {
    const c = findPullEquivalent('cloud.aws.kafka.maxOffsetLagByAccountIdClusterNameRegion', index)!;
    assert.equal(c.series, 31, 'should pick the 31-series variant, not the 4-series one');
  });

  it('maps the PUSH dimension spelling onto the polled one', () => {
    const c = findPullEquivalent('cloud.aws.kafka.maxOffsetLagByAccountIdClusterNameConsumerGroupRegionTopic', index)!;
    assert.equal(c.dimRenames.get('cluster_name'), 'Cluster Name');
    assert.equal(c.dimRenames.get('consumer_group'), 'Consumer Group');
    assert.equal(c.dimRenames.get('topic'), 'Topic');
  });

  it('returns null when the tenant has no such polled metric', () => {
    // Absence means "no evidence", never "does not exist" — we must not point a
    // dashboard at a metric that is not flowing.
    assert.equal(findPullEquivalent('cloud.aws.amazonmq.queueSizeByAccountIdBrokerQueueRegion', index), null);
  });
});

describe('dimRef', () => {
  it('backticks only the names that need it', () => {
    assert.equal(dimRef('Cluster Name'), '`Cluster Name`');
    assert.equal(dimRef('Topic'), 'Topic');
  });
});
