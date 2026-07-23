import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  metricNameFlat,
  serviceOf,
  buildInventoryIndex,
  buildServiceBridge,
  classifyRow,
  isActionable,
  type ClassicKey,
} from './metric-reconcile.ts';
import type { LookupResult } from './recipe-lookup.ts';

const mapped = (newKey: string, notes: string): LookupResult => ({
  kind: 'mapped-no-recipe',
  entry: { service: 's', classicMetricId: 'c', newDtMetricKey: newKey, notes },
});
const unknown: LookupResult = { kind: 'unknown' };
const ck = (metricKey: string, classicSeries = 1): ClassicKey => ({ metricKey, classicSeries });

describe('metricNameFlat', () => {
  it('strips a classic snake _by_ dim suffix and trailing statistic, keeps "count"', () => {
    assert.equal(
      metricNameFlat('cloud.aws.applicationelb.http_code_target_3xx_count_sum_by_availability_zone_target_group'),
      'httpcodetarget3xxcount'
    );
  });
  it('strips a classic camelCase By<Dims> suffix', () => {
    assert.equal(
      metricNameFlat('cloud.aws.apigateway.4xxErrorByAccountIdApiNameMethodRegionResourceStage'),
      '4xxerror'
    );
  });
  it('strips a new-key .By.<Dim> suffix', () => {
    assert.equal(metricNameFlat('cloud.aws.ec2.NetworkPacketsOut.By.InstanceId'), 'networkpacketsout');
  });
  it('strips a trailing stat with no dims', () => {
    assert.equal(metricNameFlat('cloud.aws.lambda.concurrent_executions_max'), 'concurrentexecutions');
  });
});

describe('serviceOf', () => {
  it('returns the 3rd dot-segment, incl. underscore services', () => {
    assert.equal(serviceOf('cloud.aws.applicationelb.Foo.By.Bar'), 'applicationelb');
    assert.equal(serviceOf('cloud.aws.ecs_containerinsights.Foo.By.Bar'), 'ecs_containerinsights');
  });
});

describe('buildServiceBridge', () => {
  it('maps a classic service to its most-common new service', () => {
    const bridge = buildServiceBridge([
      ['aurora', 'rds'],
      ['aurora', 'rds'],
      ['aurora', 'docdb'],
      ['ec', 'elasticache'],
    ]);
    assert.equal(bridge.get('aurora'), 'rds');
    assert.equal(bridge.get('ec'), 'elasticache');
  });
});

describe('classifyRow — mapped keys', () => {
  const inv = buildInventoryIndex({
    'cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier': 100,
    'cloud.aws.rds.FreeableMemory.By.DBClusterIdentifier': 50,
  });
  const bridge = new Map<string, string>();

  it('collected: exact mapped key present in inventory', () => {
    const row = classifyRow(
      ck('cloud.aws.rds.cpu_utilization'),
      mapped('cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier', 'recommended'),
      inv,
      bridge
    );
    assert.equal(row.recommendation, 'collected');
    assert.equal(row.inInventory, 'exact');
    assert.equal(row.newSeries, 100);
  });

  it('collected-other-dim: base present under a different .By.<dim>', () => {
    const row = classifyRow(
      ck('cloud.aws.rds.freeable_memory'),
      mapped('cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier', 'recommended'),
      inv,
      bridge
    );
    assert.equal(row.recommendation, 'collected-other-dim');
    assert.equal(row.inInventory, 'other-dim');
  });

  it('add-to-new: mapped to a known key with no series here', () => {
    const row = classifyRow(
      ck('cloud.aws.ec2.network_packets_out_sum'),
      mapped('cloud.aws.ec2.NetworkPacketsOut.By.InstanceId', 'autodiscovered'),
      inv,
      bridge
    );
    assert.equal(row.recommendation, 'add-to-new');
    assert.equal(row.inInventory, 'no');
  });
});

describe('classifyRow — unmapped keys via the service bridge', () => {
  const inv = buildInventoryIndex({
    'cloud.aws.kafka.BytesOutPerSec.By.Broker_ID.Cluster_Name': 10,
    'cloud.aws.applicationelb.HTTPCode_ELB_4XX_Count.By.LoadBalancer': 7,
  });
  const bridge = new Map<string, string>([['aurora', 'rds']]);

  it('custom-or-metric-streams: service absent from the new inventory', () => {
    const row = classifyRow(ck('cloud.aws.amazonmwaa.import_errors'), unknown, inv, bridge);
    assert.equal(row.recommendation, 'custom-or-metric-streams');
    assert.ok(isActionable(row.recommendation));
  });

  it('unmapped-likely-collected: onboarded service + a same-name metric present', () => {
    const row = classifyRow(
      ck('cloud.aws.kafka.bytesOutPerSecByAccountIdBrokerIDClusterNameRegionTopic'),
      unknown,
      inv,
      bridge
    );
    assert.equal(row.recommendation, 'unmapped-likely-collected');
    assert.equal(row.newService, 'kafka');
  });

  it('unmapped-add-metric: onboarded service but no matching metric name', () => {
    const row = classifyRow(
      ck('cloud.aws.applicationelb.some_metric_that_does_not_exist_sum'),
      unknown,
      inv,
      bridge
    );
    assert.equal(row.recommendation, 'unmapped-add-metric');
  });
});
