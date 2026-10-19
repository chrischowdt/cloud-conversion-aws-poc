import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeZoneName, unionFilter, zoneMetricFilter, zoneNodeFilter } from './mz-name.ts';

describe('decodeZoneName', () => {
  it('reads app and env from <APP> : <name> : <ENV>', () => {
    assert.deepEqual(decodeZoneName('CPN : PSS SEATS INVENTORY : DEV'), { app: 'cpn', env: 'dev' });
    assert.deepEqual(decodeZoneName('CPN:PSS:STGDR'), { app: 'cpn', env: 'stgdr' });
  });

  it('a partial name is the app alone — it covers every environment', () => {
    assert.deepEqual(decodeZoneName('CPN'), { app: 'cpn' });
    assert.deepEqual(decodeZoneName('CPN : PSS SEATS INVENTORY'), { app: 'cpn' });
  });

  it('does not decode names outside the convention', () => {
    assert.equal(decodeZoneName('Technology : F5'), undefined);
    assert.equal(decodeZoneName('CSMC : ALL'), undefined);
    assert.equal(decodeZoneName(''), undefined);
  });
});

describe('zone filters', () => {
  it('targets the enriched metric dimensions for a timeseries', () => {
    assert.equal(zoneMetricFilter({ app: 'cpn', env: 'qa' }), '`aws.tags.applicationci` == "cpn" and `aws.tags.env` == "qa"');
    assert.equal(zoneMetricFilter({ app: 'cpn' }), '`aws.tags.applicationci` == "cpn"');
  });

  it("targets the node's own tag record elsewhere, case-folded", () => {
    assert.equal(
      zoneNodeFilter('dt.smartscape.aws_ec2_instance', { app: 'cpn', env: 'qa' }),
      'lower(getNodeField(dt.smartscape.aws_ec2_instance, "tags:aws")[ApplicationCI]) == "cpn" and lower(getNodeField(dt.smartscape.aws_ec2_instance, "tags:aws")[env]) == "qa"'
    );
  });

  it('unions several zones and drops duplicates', () => {
    assert.equal(unionFilter(['a', 'a']), 'a');
    assert.equal(unionFilter(['a', 'b']), '((a) or (b))');
  });
});
