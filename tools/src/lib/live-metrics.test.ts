import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  metricBase,
  preferPopulatedVariant,
  type LiveMetricsIndex,
} from './live-metrics.ts';

/** Build a LiveMetricsIndex from a plain {key: count} map, the way the loader does. */
function buildLive(metrics: Record<string, number>): LiveMetricsIndex {
  const byKey = new Map<string, number>();
  const byBase = new Map<string, string[]>();
  for (const [key, count] of Object.entries(metrics)) {
    if (count <= 0) continue;
    byKey.set(key, count);
    const base = metricBase(key);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base)!.push(key);
  }
  return { byKey, byBase };
}

describe('metricBase', () => {
  it('strips a single .By.<Dim> suffix', () => {
    assert.equal(
      metricBase('cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier'),
      'cloud.aws.rds.DatabaseConnections'
    );
  });

  it('strips a multi-dimension .By suffix', () => {
    assert.equal(
      metricBase('cloud.aws.apigateway.Count.By.ApiId.Stage'),
      'cloud.aws.apigateway.Count'
    );
  });

  it('returns the key unchanged when there is no .By. segment', () => {
    assert.equal(metricBase('cloud.aws.lambda.Invocations'), 'cloud.aws.lambda.Invocations');
  });
});

describe('preferPopulatedVariant', () => {
  it('keeps a key that has its own live series (no override)', () => {
    const live = buildLive({ 'cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier': 109 });
    const r = preferPopulatedVariant(live, 'cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier');
    assert.equal(r.overrode, false);
    assert.equal(r.key, 'cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier');
    assert.equal(r.count, 109);
  });

  it('repairs the verified nic55601 case: empty cluster dim → populated instance dim', () => {
    // The DAC maps aurora connections to the cluster dim, which has 0 series.
    const live = buildLive({
      'cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier': 109,
      // cluster variant intentionally absent (0 series).
    });
    const r = preferPopulatedVariant(live, 'cloud.aws.rds.DatabaseConnections.By.DBClusterIdentifier');
    assert.equal(r.overrode, true);
    assert.equal(r.from, 'cloud.aws.rds.DatabaseConnections.By.DBClusterIdentifier');
    assert.equal(r.key, 'cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier');
    assert.equal(r.count, 109);
  });

  it('picks the most-populated sibling when several exist', () => {
    const live = buildLive({
      'cloud.aws.x.M.By.A': 5,
      'cloud.aws.x.M.By.B': 200,
      'cloud.aws.x.M.By.C': 30,
    });
    const r = preferPopulatedVariant(live, 'cloud.aws.x.M.By.Z');
    assert.equal(r.overrode, true);
    assert.equal(r.key, 'cloud.aws.x.M.By.B');
    assert.equal(r.count, 200);
  });

  it('breaks count ties by preferring the fewest dimensions', () => {
    const live = buildLive({
      'cloud.aws.x.M.By.A.B': 50,
      'cloud.aws.x.M.By.A': 50,
    });
    const r = preferPopulatedVariant(live, 'cloud.aws.x.M.By.Q');
    assert.equal(r.overrode, true);
    assert.equal(r.key, 'cloud.aws.x.M.By.A'); // single dim wins the tie
  });

  it('does NOT override when the empty key has no populated sibling', () => {
    const live = buildLive({ 'cloud.aws.other.M.By.A': 10 });
    const r = preferPopulatedVariant(live, 'cloud.aws.x.M.By.Z');
    assert.equal(r.overrode, false);
    assert.equal(r.key, 'cloud.aws.x.M.By.Z');
    assert.equal(r.count, 0);
  });

  it('does not cross metric boundaries (different base is not a sibling)', () => {
    // Same service, different metric name → not a sibling.
    const live = buildLive({ 'cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier': 88 });
    const r = preferPopulatedVariant(live, 'cloud.aws.rds.DatabaseConnections.By.DBClusterIdentifier');
    assert.equal(r.overrode, false);
    assert.equal(r.count, 0);
  });

  it('DOES swap to a single-series target at the default threshold (≥1)', () => {
    // Our key has no series at all, so the choice is "nothing" vs "something".
    // Reviewers made exactly this call by hand on rds.Deadlocks — leaving the
    // dead variant in place just meant a guaranteed-empty panel to diagnose.
    const live = buildLive({ 'cloud.aws.states.ExecutionsStarted.By.StateMachineArn': 1 });
    const r = preferPopulatedVariant(live, 'cloud.aws.states.ExecutionsStarted.By.Region.StateMachineArn');
    assert.equal(r.overrode, true);
    assert.equal(r.key, 'cloud.aws.states.ExecutionsStarted.By.StateMachineArn');
  });

  it('still refuses when the caller demands stronger evidence', () => {
    const live = buildLive({ 'cloud.aws.states.ExecutionsStarted.By.StateMachineArn': 1 });
    const r = preferPopulatedVariant(live, 'cloud.aws.states.ExecutionsStarted.By.Region.StateMachineArn', 5);
    assert.equal(r.overrode, false);
  });

  it('DOES swap to a single-series target when minSeries is lowered to 1', () => {
    const live = buildLive({ 'cloud.aws.states.ExecutionsStarted.By.StateMachineArn': 1 });
    const r = preferPopulatedVariant(
      live,
      'cloud.aws.states.ExecutionsStarted.By.Region.StateMachineArn',
      1
    );
    assert.equal(r.overrode, true);
    assert.equal(r.key, 'cloud.aws.states.ExecutionsStarted.By.StateMachineArn');
    assert.equal(r.count, 1);
  });

  it('honors a raised threshold (≥100 keeps a 47-series swap from firing)', () => {
    const live = buildLive({ 'cloud.aws.es.CPUUtilization.By.ClientId.DomainName.NodeId': 47 });
    const r = preferPopulatedVariant(live, 'cloud.aws.es.CPUUtilization.By.ClientId.DomainName', 100);
    assert.equal(r.overrode, false);
  });

  it('never overrides a populated key to a different sibling', () => {
    // Both populated; the requested one wins because it has its own data.
    const live = buildLive({
      'cloud.aws.x.M.By.A': 3,
      'cloud.aws.x.M.By.B': 999,
    });
    const r = preferPopulatedVariant(live, 'cloud.aws.x.M.By.A');
    assert.equal(r.overrode, false);
    assert.equal(r.key, 'cloud.aws.x.M.By.A');
    assert.equal(r.count, 3);
  });
});
