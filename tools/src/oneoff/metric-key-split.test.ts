import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addEntitySplit, firstSeriesName, hasTopLevelBy, timeseriesCommand } from './metric-key-split.ts';

const BARE = 'timeseries val = avg(cloud.aws.redshift.percentage_disk_space_used_by_node_id), interval:1m';

describe('addEntitySplit', () => {
  it('appends the entity split to a bare timeseries (the Redshift detector)', () => {
    const r = addEntitySplit(BARE, 'dt.entity.custom_device');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.query, BARE + ', by:{dt.entity.custom_device}');
  });

  it('inserts before the first pipe and preserves the rest of the query', () => {
    const q = 'timeseries val = avg(cloud.aws.x.y), interval:1m\n| filter val > 1\n| fields val';
    const r = addEntitySplit(q, 'dt.entity.custom_device');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(
        r.query,
        'timeseries val = avg(cloud.aws.x.y), interval:1m, by:{dt.entity.custom_device}\n| filter val > 1\n| fields val'
      );
    }
  });

  it('is idempotent — a query that already splits is left alone', () => {
    const q = BARE + ', by:{dt.entity.custom_device}';
    const r = addEntitySplit(q, 'dt.entity.custom_device');
    assert.deepEqual(r, { ok: false, reason: 'already-split' });
  });

  it('does not mistake a `by` inside a filter for a split', () => {
    // `by` appearing inside braces/parens is not a top-level by-clause.
    const q = 'timeseries val = avg(cloud.aws.x.y, filter:{matchesValue(name, "stand-by:x")}), interval:1m';
    assert.equal(hasTopLevelBy(q), false);
    assert.equal(addEntitySplit(q, 'dt.entity.custom_device').ok, true);
  });

  it('does not stop at a pipe inside a string literal', () => {
    const q = 'timeseries val = avg(cloud.aws.x.y, filter:{matchesValue(name, "a|b")}), interval:1m | fields val';
    const r = addEntitySplit(q, 'dt.entity.custom_device');
    assert.equal(r.ok, true);
    if (r.ok) assert.match(r.query, /interval:1m, by:\{dt\.entity\.custom_device\} \| fields val$/);
  });

  it('refuses a // comment inside the command rather than risk swallowing the clause', () => {
    const q = 'timeseries val = avg(cloud.aws.x.y) //, interval:15m\n| fields val';
    assert.deepEqual(addEntitySplit(q, 'dt.entity.custom_device'), { ok: false, reason: 'comment-in-command' });
  });

  it('reports a query with no timeseries command', () => {
    assert.deepEqual(addEntitySplit('fetch logs | limit 1', 'dt.entity.custom_device'), {
      ok: false,
      reason: 'no-timeseries',
    });
  });
});

describe('timeseriesCommand / firstSeriesName', () => {
  it('ends the command at the first top-level pipe', () => {
    const r = timeseriesCommand('timeseries a = avg(x) | fields a')!;
    assert.equal('timeseries a = avg(x) | fields a'.slice(r.start, r.end).trim(), 'a = avg(x)');
  });

  it('names the first series, braced or not', () => {
    assert.equal(firstSeriesName(BARE), 'val');
    assert.equal(firstSeriesName('timeseries {NetworkIn = avg(x), NetworkOut = avg(y)}'), 'NetworkIn');
    assert.equal(firstSeriesName('timeseries avg(x)'), null);
  });
});
