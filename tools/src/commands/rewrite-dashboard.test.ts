import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { commentOriginal, stripOriginalComment, stripOriginalCommentsInPlace } from './rewrite-dashboard.ts';

describe('commentOriginal / stripOriginalComment', () => {
  it('prepends the original as a // reference block that DQL treats as comments', () => {
    const original = 'timeseries avg(dt.cloud.aws.lambda.duration)\n| filter x == 1';
    const rewritten = 'timeseries avg(dt.cloud.aws.lambda.duration.By.FunctionName)';
    const annotated = commentOriginal(original) + rewritten;
    // every original line is commented
    assert.ok(annotated.includes('// timeseries avg(dt.cloud.aws.lambda.duration)'));
    assert.ok(annotated.includes('// | filter x == 1'));
    // the rewritten query is preserved verbatim at the end
    assert.ok(annotated.endsWith(rewritten));
  });

  it('round-trips: strip removes exactly the block, restoring the rewritten query', () => {
    const rewritten = 'timeseries avg(m.By.FunctionName)\n| fields a, b';
    const annotated = commentOriginal('timeseries avg(m)') + rewritten;
    assert.equal(stripOriginalComment(annotated), rewritten);
  });

  it('strip is a no-op on an un-annotated query', () => {
    const q = 'fetch dt.smartscape.aws_lambda_function | limit 1';
    assert.equal(stripOriginalComment(q), q);
  });

  it('commentOriginal is idempotent (no nested blocks)', () => {
    const once = commentOriginal('fetch x');
    const twice = commentOriginal(once + 'fetch smartscape');
    assert.equal((twice.match(/ORIGINAL CLASSIC QUERY/g) ?? []).length, 1);
  });
});

describe('stripOriginalCommentsInPlace', () => {
  it('strips reference blocks from every query field in a nested dashboard', () => {
    const rewritten = 'timeseries avg(m.By.FunctionName)';
    const dash = {
      tiles: {
        a: { query: commentOriginal('timeseries avg(m)') + rewritten },
        b: { nested: { input: commentOriginal('fetch old') + 'fetch new' } },
        c: { query: 'fetch untouched' },
      },
    };
    stripOriginalCommentsInPlace(dash);
    assert.equal(dash.tiles.a.query, rewritten);
    assert.equal(dash.tiles.b.nested.input, 'fetch new');
    assert.equal(dash.tiles.c.query, 'fetch untouched');
  });
});
