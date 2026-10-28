import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inventorySeries, partFilter, type SeriesPart } from './series-inventory.ts';

/**
 * A fake Grail: the true series count per key, and a cap applied after the
 * filter that silently truncates, the way `fetch metric.series` does. The
 * sample walks keys in REVERSE order, so a capped part hides its first keys.
 */
function fakeGrail(truth: Record<string, number>, cap: number) {
  const matches = (key: string, part: SeriesPart): boolean => {
    if ('exact' in part) return key === part.exact;
    if (!key.startsWith(part.prefix)) return false;
    if (part.without?.includes(key)) return false;
    if (!part.rest) return true;
    const next = key.slice(part.prefix.length, part.prefix.length + 1);
    return key.length > part.prefix.length && !part.rest.exclude.includes(next);
  };
  return async (part: SeriesPart): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    let left = cap;
    for (const key of Object.keys(truth).sort().reverse()) {
      if (left === 0) break;
      if (!matches(key, part)) continue;
      const n = Math.min(truth[key]!, left);
      out[key] = n;
      left -= n;
    }
    return out;
  };
}

describe('inventorySeries', () => {
  it('returns the single query when it is under the cap', async () => {
    const truth = { 'cloud.aws.a.X': 3, 'cloud.aws.b.Y': 4 };
    const inv = await inventorySeries(fakeGrail(truth, 100), 'cloud.aws.', { cap: 100 });
    assert.deepEqual(inv.metrics, truth);
    assert.equal(inv.queries, 1);
  });

  it('finds every key and its full count when the whole query is capped', async () => {
    const truth: Record<string, number> = {
      'cloud.aws.ec2.CPUUtilization.By.InstanceId': 9,
      'cloud.aws.ec2.NetworkIn.By.InstanceId': 8,
      'cloud.aws.es.CPUUtilization.By.DomainName': 2,
      'cloud.aws.lambda.Errors.By.FunctionName': 7,
      'cloud.aws.lambda.Errors.By.FunctionName.Resource': 1,
      'cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier': 6,
      'cloud.aws.rds.CPUUtilization.By.DBClusterIdentifier': 5,
      'cloud.aws.rds.AuroraReplicaLag.By.DBInstanceIdentifier': 4,
      'cloud.aws.s3.BucketSizeBytes.By.BucketName.StorageType': 3,
    };
    const inv = await inventorySeries(fakeGrail(truth, 10), 'cloud.aws.', { cap: 10 });
    assert.deepEqual(inv.metrics, truth);
    assert.deepEqual(inv.capped, []);
  });

  it('counts a key that is a prefix of other keys', async () => {
    // `…Errors` is itself a key AND the prefix of `…Errors.By.X`.
    const truth = { 'cloud.aws.x.Errors': 6, 'cloud.aws.x.Errors.By.X': 6, 'cloud.aws.x.Errors.By.Y': 1 };
    const inv = await inventorySeries(fakeGrail(truth, 10), 'cloud.aws.', { cap: 10 });
    assert.deepEqual(inv.metrics, truth);
  });

  it('reports a single key over the cap at the cap, and lists it', async () => {
    const truth = { 'cloud.aws.ec2.CPUUtilization.By.InstanceId': 50, 'cloud.aws.ec2.NetworkIn.By.InstanceId': 2 };
    const inv = await inventorySeries(fakeGrail(truth, 10), 'cloud.aws.', { cap: 10 });
    assert.equal(inv.metrics['cloud.aws.ec2.CPUUtilization.By.InstanceId'], 10);
    assert.equal(inv.metrics['cloud.aws.ec2.NetworkIn.By.InstanceId'], 2);
    assert.deepEqual(inv.capped, ['cloud.aws.ec2.CPUUtilization.By.InstanceId']);
  });

  it('sets aside several over-cap keys without walking their names', async () => {
    // Like nic55601's EC2/EBS keys: each alone fills the cap, next to small ones.
    const truth: Record<string, number> = {
      'cloud.aws.ec2.NetworkIn.By.InstanceId': 40,
      'cloud.aws.ec2.NetworkOut.By.InstanceId': 40,
      'cloud.aws.ec2.NetworkPacketsIn.By.InstanceId': 3,
      'cloud.aws.ebs.VolumeReadOps.By.VolumeId': 40,
      'cloud.aws.ebs.BurstBalance.By.VolumeId': 2,
    };
    const grail = fakeGrail(truth, 10);
    const prefixes: string[] = [];
    const inv = await inventorySeries(async (p) => {
      if ('prefix' in p) prefixes.push(p.prefix);
      return grail(p);
    }, 'cloud.aws.', { cap: 10 });
    assert.deepEqual(Object.keys(inv.metrics).sort(), Object.keys(truth).sort());
    assert.equal(inv.metrics['cloud.aws.ec2.NetworkPacketsIn.By.InstanceId'], 3);
    assert.equal(inv.metrics['cloud.aws.ebs.BurstBalance.By.VolumeId'], 2);
    assert.deepEqual(inv.capped.sort(), ['cloud.aws.ebs.VolumeReadOps.By.VolumeId', 'cloud.aws.ec2.NetworkIn.By.InstanceId', 'cloud.aws.ec2.NetworkOut.By.InstanceId']);
    // Once a key fills a sample alone, nothing walks further down its name.
    for (const k of inv.capped) {
      const inside = prefixes.filter((p) => k.startsWith(p) && p.length > k.indexOf('.By.'));
      assert.deepEqual(inside, [], `walked into ${k}`);
    }
  });
});

describe('partFilter', () => {
  it('builds prefix, exact and remainder filters', () => {
    assert.equal(partFilter({ exact: 'cloud.aws.a' }), 'metric.key == "cloud.aws.a"');
    assert.equal(partFilter({ prefix: 'cloud.aws.' }), 'startsWith(metric.key, "cloud.aws.")');
    assert.equal(partFilter({ prefix: 'cloud.aws.', rest: { exclude: [] } }), 'startsWith(metric.key, "cloud.aws.") and stringLength(metric.key) > 10');
    assert.equal(
      partFilter({ prefix: 'cloud.aws.', rest: { exclude: ['e', 'r'] } }),
      'startsWith(metric.key, "cloud.aws.") and stringLength(metric.key) > 10 and not in(substring(metric.key, from:10, to:11), array("e", "r"))',
    );
  });
});
