import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { builtinToDqlClassic, secondGenToTenantKey, toSnakeCase } from './schema-transforms.ts';

describe('toSnakeCase', () => {
  it('handles standard camelCase', () => {
    assert.equal(toSnakeCase('channelCountAverage'), 'channel_count_average');
    assert.equal(toSnakeCase('CPUUtilization'), 'c_p_u_utilization'); // acronyms split
    assert.equal(toSnakeCase('ackRate'), 'ack_rate');
  });

  it('preserves already-lowercase strings', () => {
    assert.equal(toSnakeCase('lowercase'), 'lowercase');
  });
});

describe('secondGenToTenantKey', () => {
  it('strips ext: and snake-cases the metric name', () => {
    assert.equal(
      secondGenToTenantKey('ext:cloud.aws.amazonmq.channelCountAverage'),
      'cloud.aws.amazonmq.channel_count_average'
    );
    assert.equal(
      secondGenToTenantKey('ext:cloud.aws.applicationelb.activeConnectionCountSum'),
      'cloud.aws.applicationelb.active_connection_count_sum'
    );
  });

  it('handles missing ext: prefix', () => {
    assert.equal(
      secondGenToTenantKey('cloud.aws.amazonmq.confirmRate'),
      'cloud.aws.amazonmq.confirm_rate'
    );
  });

  it('returns null for not-matched / empty', () => {
    assert.equal(secondGenToTenantKey('not-matched'), null);
    assert.equal(secondGenToTenantKey(''), null);
    assert.equal(secondGenToTenantKey(null), null);
    assert.equal(secondGenToTenantKey(undefined), null);
  });
});

describe('builtinToDqlClassic', () => {
  it('swaps builtin: → dt. and snake-cases each segment', () => {
    assert.equal(
      builtinToDqlClassic('builtin:cloud.aws.alb.connections.active'),
      'dt.cloud.aws.alb.connections.active'
    );
    assert.equal(
      builtinToDqlClassic('builtin:cloud.aws.dynamo.capacityUnits.consumed.read'),
      'dt.cloud.aws.dynamo.capacity_units.consumed.read'
    );
    assert.equal(
      builtinToDqlClassic('builtin:cloud.aws.ec2.cpu.usage'),
      'dt.cloud.aws.ec2.cpu.usage'
    );
  });

  it('returns null for non-builtin keys', () => {
    assert.equal(builtinToDqlClassic('cloud.aws.alb.bytes'), null);
    assert.equal(builtinToDqlClassic(null), null);
    assert.equal(builtinToDqlClassic(''), null);
  });
});
