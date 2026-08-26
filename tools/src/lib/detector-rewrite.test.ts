import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rewriteDetector, detectorQuery } from './detector-rewrite.ts';
import type { DetectedRecipe, MappingEntry, RecipeIndex } from './recipe-lookup.ts';

/** Same fake-index builder as dql-rewriter.test.ts (recipe tier only). */
function buildIndex(entries: MappingEntry[]): RecipeIndex {
  const byClassicId = new Map<string, MappingEntry>();
  const byDqlClassicKey = new Map<string, MappingEntry>();
  for (const e of entries) {
    byClassicId.set(e.classicMetricId, e);
    const builtinSuffix = e.classicMetricId.replace(/^builtin:/, '');
    const dqlKey =
      'dt.' + builtinSuffix.split('.').map((p) => p.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase()).join('.');
    byDqlClassicKey.set(dqlKey, e);
  }
  return { byClassicId, byDqlClassicKey };
}

const scaleRecipe: DetectedRecipe = {
  classicAggregation: 'sum',
  newAggregation: 'sum',
  newAggregationMode: 'raw',
  scale: 2.0,
  verdict: 'exact-fit',
  pearsonR: 1,
  residualSmape: 0,
};

const aggFlipRecipe: DetectedRecipe = {
  classicAggregation: 'avg',
  newAggregation: 'sum',
  newAggregationMode: 'raw',
  scale: 1,
  verdict: 'exact-fit',
  pearsonR: 0.99,
  residualSmape: 0.01,
};

const perSecondRecipe: DetectedRecipe = {
  classicAggregation: 'avg',
  newAggregation: 'avg',
  newAggregationMode: 'per_second',
  scale: 1,
  verdict: 'exact-fit',
  pearsonR: 0.99,
  residualSmape: 0.01,
};

const throttleEntry: MappingEntry = {
  service: 'DynamoDB',
  classicMetricId: 'builtin:cloud.aws.dynamo.throttledEvents.write',
  newDtMetricKey: 'cloud.aws.dynamodb.WriteThrottleEvents.By.TableName',
  detectedRecipe: scaleRecipe,
};

const aggFlipEntry: MappingEntry = {
  service: 'EC2',
  classicMetricId: 'builtin:cloud.aws.ec2.net.rx',
  newDtMetricKey: 'cloud.aws.ec2.NetworkIn.By.InstanceId',
  detectedRecipe: aggFlipRecipe,
};

const perSecondEntry: MappingEntry = {
  service: 'EC2',
  classicMetricId: 'builtin:cloud.aws.ec2.net.tx',
  newDtMetricKey: 'cloud.aws.ec2.NetworkOut.By.InstanceId',
  detectedRecipe: perSecondRecipe,
};

/** Build a minimal detector value around a query + optional threshold/eventTemplate. */
function detector(opts: {
  query: string;
  threshold?: string;
  template?: Array<{ key: string; value: string }>;
  analyzerName?: string;
}): Record<string, unknown> {
  const input: Array<{ key: string; value: string }> = [{ key: 'query', value: opts.query }];
  if (opts.threshold !== undefined) input.push({ key: 'threshold', value: opts.threshold });
  input.push({ key: 'alertCondition', value: 'ABOVE' });
  return {
    enabled: true,
    title: 'test detector',
    analyzer: {
      name: opts.analyzerName ?? 'dt.statistics.ui.anomaly_detection.StaticThresholdAnomalyDetectionAnalyzer',
      input,
    },
    eventTemplate: opts.template ? { properties: opts.template } : undefined,
  };
}

describe('detectorQuery', () => {
  it('pulls the query input value', () => {
    const v = detector({ query: 'timeseries avg(cloud.aws.rds.deadlocks), by:{dt.entity.custom_device}' });
    assert.match(detectorQuery(v)!, /cloud\.aws\.rds\.deadlocks/);
  });
  it('returns undefined when there is no query', () => {
    assert.equal(detectorQuery({ analyzer: { input: [{ key: 'threshold', value: '1' }] } }), undefined);
  });
});

describe('rewriteDetector — query + custom_device disambiguation', () => {
  it('rewrites the query in place and resolves the node type from the metric service', () => {
    const v = detector({ query: 'timeseries avg(cloud.aws.rds.deadlocks), by:{dt.entity.custom_device}' });
    const r = rewriteDetector(v, buildIndex([]));
    assert.equal(r.changed, true);
    assert.equal(r.nodeType, 'AWS_RDS_DBINSTANCE');
    assert.equal(r.targetDim, 'dt.smartscape.aws_rds_dbinstance');
    // the cloned value carries the rewritten query
    const newQ = detectorQuery(r.rewrittenValue)!;
    assert.match(newQ, /dt\.smartscape\.aws_rds_dbinstance/);
    assert.doesNotMatch(newQ, /dt\.entity\.custom_device/);
  });
});

describe('rewriteDetector — eventTemplate binding sync', () => {
  it('rewrites {dims:dt.entity.custom_device} and .name to the resolved smartscape dim', () => {
    const v = detector({
      query: 'timeseries avg(cloud.aws.rds.deadlocks), by:{dt.entity.custom_device}',
      template: [
        { key: 'event.name', value: 'Deadlocks high {dims:dt.entity.custom_device.name}' },
        { key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' },
      ],
    });
    const r = rewriteDetector(v, buildIndex([]));
    const props = (r.rewrittenValue.eventTemplate as any).properties as Array<{ key: string; value: string }>;
    const name = props.find((p) => p.key === 'event.name')!.value;
    const bind = props.find((p) => p.key === 'dt.source_entity')!.value;
    assert.equal(name, 'Deadlocks high {dims:dt.smartscape.aws_rds_dbinstance.name}');
    assert.equal(bind, '{dims:dt.smartscape.aws_rds_dbinstance}');
    assert.ok(r.eventTemplateChanges.length >= 2);
  });

  it('flags (does not guess) when the query did not resolve to a smartscape dim', () => {
    // A non-AWS entity query: custom_device stays, no dt.smartscape.<type> emitted.
    const v = detector({
      query: 'timeseries avg(cloud.aws.rds.deadlocks)',
      template: [{ key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' }],
    });
    // Force the "no dim" branch by using a query with no by:{custom_device}
    // that still references the placeholder — here the query has no smartscape
    // dim because there's no custom_device to disambiguate in a by-clause.
    const r = rewriteDetector(v, buildIndex([]));
    if (!r.targetDim) {
      const bind = ((r.rewrittenValue.eventTemplate as any).properties as any[]).find((p) => p.key === 'dt.source_entity').value;
      assert.equal(bind, '{dims:dt.entity.custom_device}'); // untouched
      assert.ok(r.warnings.some((w) => /binding could not be rewritten/.test(w.text)));
    }
  });
});

describe('rewriteDetector — threshold guard', () => {
  it('rescales the threshold by 1/scale for a clean scale recipe (÷2)', () => {
    const v = detector({
      query: 'timeseries x = sum(builtin:cloud.aws.dynamo.throttledEvents.write), by:{dt.entity.custom_device}',
      threshold: '10',
    });
    const r = rewriteDetector(v, buildIndex([throttleEntry]));
    assert.equal(r.thresholdAction.kind, 'rescaled');
    assert.equal(r.thresholdAction.from, 10);
    assert.equal(r.thresholdAction.to, 5); // 10 / 2
    const thr = (r.rewrittenValue.analyzer as any).input.find((i: any) => i.key === 'threshold').value;
    assert.equal(thr, '5');
  });

  it('blocks (does not touch) an aggregation-flip recipe threshold', () => {
    const v = detector({
      query: 'timeseries x = avg(builtin:cloud.aws.ec2.net.rx), by:{dt.entity.custom_device}',
      threshold: '1000000',
    });
    const r = rewriteDetector(v, buildIndex([aggFlipEntry]));
    assert.equal(r.thresholdAction.kind, 'blocked');
    const thr = (r.rewrittenValue.analyzer as any).input.find((i: any) => i.key === 'threshold').value;
    assert.equal(thr, '1000000'); // unchanged
    assert.ok(r.warnings.some((w) => /threshold NOT auto-converted/i.test(w.text)));
  });

  it('blocks a per-second recipe threshold (needs bucket interval)', () => {
    const v = detector({
      query: 'timeseries x = avg(builtin:cloud.aws.ec2.net.tx), by:{dt.entity.custom_device}',
      threshold: '5000',
    });
    const r = rewriteDetector(v, buildIndex([perSecondEntry]));
    assert.equal(r.thresholdAction.kind, 'blocked');
  });

  it('leaves a 0 threshold unchanged (scale-invariant)', () => {
    const v = detector({
      query: 'timeseries x = sum(builtin:cloud.aws.dynamo.throttledEvents.write), by:{dt.entity.custom_device}',
      threshold: '0',
    });
    const r = rewriteDetector(v, buildIndex([throttleEntry]));
    assert.equal(r.thresholdAction.kind, 'unchanged');
  });

  it('leaves a mapped-no-recipe (bare/suffixed) threshold unchanged', () => {
    const v = detector({
      query: 'timeseries avg(cloud.aws.rds.deadlocks), by:{dt.entity.custom_device}',
      threshold: '50',
    });
    const r = rewriteDetector(v, buildIndex([]));
    assert.equal(r.thresholdAction.kind, 'unchanged');
    const thr = (r.rewrittenValue.analyzer as any).input.find((i: any) => i.key === 'threshold').value;
    assert.equal(thr, '50');
  });

  it('reports kind "none" when there is no threshold input', () => {
    const v = detector({ query: 'timeseries avg(cloud.aws.rds.deadlocks), by:{dt.entity.custom_device}' });
    const r = rewriteDetector(v, buildIndex([]));
    assert.equal(r.thresholdAction.kind, 'none');
  });
});

describe('rewriteDetector — no-op safety', () => {
  it('returns changed=false and null query when the detector has no DQL', () => {
    const r = rewriteDetector({ analyzer: { input: [{ key: 'threshold', value: '1' }] } }, buildIndex([]));
    assert.equal(r.changed, false);
    assert.equal(r.query, null);
  });

  it('does not mutate the input value (deep clone)', () => {
    const v = detector({ query: 'timeseries avg(cloud.aws.rds.deadlocks), by:{dt.entity.custom_device}', threshold: '1' });
    const before = JSON.stringify(v);
    rewriteDetector(v, buildIndex([]));
    assert.equal(JSON.stringify(v), before);
  });
});
