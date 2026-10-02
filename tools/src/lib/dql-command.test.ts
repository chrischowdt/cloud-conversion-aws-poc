import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addByDimension, codeMask, hasTopLevelBy, timeseriesCommand, timeseriesCommands, topLevelBy } from './dql-command.ts';

describe('codeMask', () => {
  it('marks string literals and comments as non-code', () => {
    const q = 'a "x|y" b // c|d\ne';
    const m = codeMask(q);
    assert.equal(m[q.indexOf('|')], false); // inside the string
    assert.equal(m[q.lastIndexOf('|')], false); // inside the comment
    assert.equal(m[q.indexOf(' b ') + 1], true);
    assert.equal(m[q.indexOf('e', q.indexOf('\n'))], true); // the comment ended at the newline
  });

  it('honours escaped quotes inside a string', () => {
    const q = 'say "a\\"|b" | c';
    const m = codeMask(q);
    assert.equal(m[q.indexOf('|')], false);
    assert.equal(m[q.lastIndexOf('|')], true);
  });
});

describe('timeseriesCommands', () => {
  it('ends a command at its first top-level pipe', () => {
    const q = 'timeseries a = avg(x), by:{d} | fields a';
    const c = timeseriesCommand(q)!;
    assert.equal(q.slice(c.start, c.end).trim(), 'a = avg(x), by:{d}');
  });

  it('ignores a pipe inside a string and a keyword inside a comment', () => {
    const q = '// timeseries nope\ntimeseries a = avg(x, filter:{m(n, "a|b")}) | fields a';
    const cs = timeseriesCommands(q);
    assert.equal(cs.length, 1);
    assert.match(q.slice(cs[0]!.start, cs[0]!.end), /a\|b/);
  });

  it('finds a timeseries nested in append[...] and ends it at the closing bracket', () => {
    const q = 'timeseries a = avg(x), by:{d}\n| append [ timeseries b = avg(y), by:{e} ]\n| fields a';
    const cs = timeseriesCommands(q);
    assert.equal(cs.length, 2);
    const nested = q.slice(cs[1]!.start, cs[1]!.end);
    assert.match(nested, /b = avg\(y\), by:\{e\}/);
    assert.doesNotMatch(nested, /fields/);
  });
});

describe('topLevelBy / hasTopLevelBy', () => {
  it('finds the by-clause with or without spaces', () => {
    for (const q of ['timeseries a = avg(x), by:{d}', 'timeseries a = avg(x), by: { d, e }']) {
      assert.equal(hasTopLevelBy(q), true);
      assert.ok(topLevelBy(q, timeseriesCommand(q)!));
    }
  });

  it('does not take a `by` inside a filter or a name for the clause', () => {
    assert.equal(hasTopLevelBy('timeseries a = avg(x, filter:{m(n, "by:{z}")})'), false);
    assert.equal(hasTopLevelBy('timeseries standby = avg(x)'), false);
  });
});

describe('addByDimension', () => {
  const add = (q: string, dim: string) => addByDimension(q, timeseriesCommand(q)!, dim);

  it('appends to an existing by-clause', () => {
    assert.equal(add('timeseries a = avg(x), by:{d}', 'aws.arn'), 'timeseries a = avg(x), by:{d, aws.arn}');
  });

  it('keeps the author spacing and does not touch what follows', () => {
    assert.equal(
      add('timeseries a = avg(x), by: { d }\n| filter z', 'aws.arn'),
      'timeseries a = avg(x), by: { d, aws.arn }\n| filter z'
    );
  });

  it('is a no-op when the dimension is already there, even aliased or backticked', () => {
    const q1 = 'timeseries a = avg(x), by:{d, aws.arn}';
    assert.equal(add(q1, 'aws.arn'), q1);
    const q2 = 'timeseries a = avg(x), by:{d, `aws.arn`}';
    assert.equal(add(q2, 'aws.arn'), q2);
  });

  it('fills an empty by-clause', () => {
    assert.equal(add('timeseries a = avg(x), by:{}', 'aws.arn'), 'timeseries a = avg(x), by:{aws.arn}');
  });

  it('refuses (null) when there is no editable by-clause, rather than change the grain', () => {
    assert.equal(add('timeseries a = avg(x)', 'aws.arn'), null);
  });
});
