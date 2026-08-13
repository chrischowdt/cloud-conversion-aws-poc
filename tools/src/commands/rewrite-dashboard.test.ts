import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { commentOriginal, stripOriginalComment, stripOriginalCommentsInPlace, rewriteInPlace } from './rewrite-dashboard.ts';
import type { RecipeIndex } from '../lib/recipe-lookup.ts';

/** Minimal index mapping one bare classic key to a new key (mapped-no-recipe). */
function miniIndex(): RecipeIndex {
  const byDqlClassicKey = new Map<string, any>([
    ['cloud.aws.lambda.duration', { classicMetricId: 'builtin:cloud.aws.lambda.duration', service: 'lambda', newDtMetricKey: 'cloud.aws.lambda.Duration.By.FunctionName' }],
  ]);
  return { byClassicId: new Map(), byDqlClassicKey } as unknown as RecipeIndex;
}

describe('rewriteInPlace — shadow/visualization metric-key mapping', () => {
  it('updates the classic key across ALL shadow fields (stateful-regex regression)', () => {
    // Two+ shadow fields must BOTH convert — the module-level BARE_METRIC_KEY_RE
    // (`g` flag) previously left lastIndex advanced, dropping every field after
    // the first.
    const dash = {
      tiles: [{
        queryConfig: { subQueries: [{ metric: { key: 'cloud.aws.lambda.duration' } }] },
        visualizationSettings: {
          chartSettings: { categoricalBarChartSettings: { categoryAxisLabel: 'cloud.aws.lambda.duration', categoryAxis: ['cloud.aws.lambda.duration'] }, leftYAxisSettings: { label: 'cloud.aws.lambda.duration' } },
          honeycomb: { displayedFields: ['cloud.aws.lambda.duration'] },
        },
      }],
    };
    rewriteInPlace(dash, miniIndex(), [], '');
    const t = dash.tiles[0] as any;
    const NEW = 'cloud.aws.lambda.Duration.By.FunctionName';
    assert.equal(t.queryConfig.subQueries[0].metric.key, NEW);
    assert.equal(t.visualizationSettings.chartSettings.categoricalBarChartSettings.categoryAxisLabel, NEW);
    assert.equal(t.visualizationSettings.chartSettings.categoricalBarChartSettings.categoryAxis[0], NEW);
    assert.equal(t.visualizationSettings.chartSettings.leftYAxisSettings.label, NEW);
    assert.equal(t.visualizationSettings.honeycomb.displayedFields[0], NEW);
  });
});



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
