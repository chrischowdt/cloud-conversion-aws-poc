import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rewriteDql } from './dql-rewriter.ts';
import type {
  CompositeFormula,
  DetectedRecipe,
  MappingEntry,
  RecipeIndex,
} from './recipe-lookup.ts';

function buildIndex(entries: MappingEntry[]): RecipeIndex {
  const byClassicId = new Map<string, MappingEntry>();
  for (const e of entries) byClassicId.set(e.classicMetricId, e);
  return { byClassicId };
}

const cpuRecipe: DetectedRecipe = {
  classicAggregation: 'avg',
  newAggregation: 'avg',
  newAggregationMode: 'raw',
  scale: 1.0006,
  verdict: 'exact-fit',
  pearsonR: 0.992,
  residualSmape: 0.05,
  source: 'detect-per-resource',
};

const netRxRecipe: DetectedRecipe = {
  classicAggregation: 'avg',
  newAggregation: 'sum',
  newAggregationMode: 'per_second',
  scale: 0.97,
  verdict: 'exact-fit',
  pearsonR: 0.999,
  residualSmape: 0.01,
};

const throttleWriteRecipe: DetectedRecipe = {
  classicAggregation: 'sum',
  newAggregation: 'sum',
  newAggregationMode: 'raw',
  scale: 2.0,
  verdict: 'exact-fit',
  pearsonR: 1.0,
  residualSmape: 0,
};

const cpuEntry: MappingEntry = {
  service: 'EC2',
  classicMetricId: 'builtin:cloud.aws.ec2.cpu.usage',
  newDtMetricKey: 'cloud.aws.ec2.CPUUtilization.By.InstanceId',
  detectedRecipe: cpuRecipe,
};

const netRxEntry: MappingEntry = {
  service: 'EC2',
  classicMetricId: 'builtin:cloud.aws.ec2.net.rx',
  newDtMetricKey: 'cloud.aws.ec2.NetworkIn.By.InstanceId',
  detectedRecipe: netRxRecipe,
};

const throttleWriteEntry: MappingEntry = {
  service: 'DynamoDB',
  classicMetricId: 'builtin:cloud.aws.dynamo.throttledEvents.write',
  newDtMetricKey: 'cloud.aws.dynamodb.WriteThrottleEvents.By.TableName',
  detectedRecipe: throttleWriteRecipe,
};

const compositeFormula: CompositeFormula = {
  classicMetricId: 'builtin:cloud.aws.dynamo.capacityUnits.read',
  formula: '(consumed / provisioned) * 100',
  components: [
    {
      role: 'consumed',
      newDtMetricKey: 'cloud.aws.dynamodb.ConsumedReadCapacityUnits.By.TableName',
      newAggregation: 'sum',
    },
    {
      role: 'provisioned',
      newDtMetricKey: 'cloud.aws.dynamodb.ProvisionedReadCapacityUnits.By.TableName',
      newAggregation: 'avg',
    },
  ],
  verified: false,
  verificationNotes: 'unverified — empirical test failed',
};

const capacityEntry: MappingEntry = {
  service: 'DynamoDB',
  classicMetricId: 'builtin:cloud.aws.dynamo.capacityUnits.read',
  compositeFormula,
};

describe('rewriteDql — metric key swap (basic)', () => {
  it('replaces classic metric key, keeps aggregation when recipe matches', () => {
    const idx = buildIndex([cpuEntry]);
    const r = rewriteDql(
      'timeseries cpu = avg(builtin:cloud.aws.ec2.cpu.usage)',
      idx
    );
    assert.match(r.rewritten, /avg\(`cloud\.aws\.ec2\.CPUUtilization\.By\.InstanceId`\)/);
    assert.equal(r.transforms[0]?.kind, 'metric-key');
  });

  it('applies per_second mode by dividing by interval', () => {
    const idx = buildIndex([netRxEntry]);
    const r = rewriteDql('timeseries x = avg(builtin:cloud.aws.ec2.net.rx)', idx);
    assert.match(r.rewritten, /sum\(`cloud\.aws\.ec2\.NetworkIn\.By\.InstanceId`\) \/ 300/);
    // Also wraps in scale (0.97 ≠ 1)
    assert.match(r.rewritten, /\* 0\.97/);
  });

  it('applies non-1 scale wrapper', () => {
    const idx = buildIndex([throttleWriteEntry]);
    const r = rewriteDql('timeseries x = sum(builtin:cloud.aws.dynamo.throttledEvents.write)', idx);
    assert.match(r.rewritten, /\* 2/);
    assert.match(r.rewritten, /sum\(`cloud\.aws\.dynamodb\.WriteThrottleEvents\.By\.TableName`\)/);
  });

  it('skips unmodified scale=1 (no scale wrapper)', () => {
    const idx = buildIndex([cpuEntry]); // cpuRecipe scale=1.0006 → diff < 0.05, no wrap
    const r = rewriteDql('timeseries x = avg(builtin:cloud.aws.ec2.cpu.usage)', idx);
    // Should NOT contain `* 1` wrapper
    assert.doesNotMatch(r.rewritten, /\*\s*1\.\d+/);
  });
});

describe('rewriteDql — entity dimension swap', () => {
  it('replaces dt.entity.ec2_instance with dt.smartscape.aws_ec2_instance', () => {
    const idx = buildIndex([cpuEntry]);
    const r = rewriteDql(
      'timeseries avg(builtin:cloud.aws.ec2.cpu.usage), by:{ dt.entity.ec2_instance }',
      idx
    );
    assert.match(r.rewritten, /by:\{ dt\.smartscape\.aws_ec2_instance \}/);
    const dimTransforms = r.transforms.filter((t) => t.kind === 'entity-dim');
    assert.equal(dimTransforms.length, 1);
    assert.equal(dimTransforms[0]?.after, 'dt.smartscape.aws_ec2_instance');
  });

  it('preserves backtick quoting style for special-char entity types', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(some_metric), by:{ `dt.entity.cloud:aws:applicationelb` }',
      idx
    );
    assert.match(r.rewritten, /`dt\.smartscape\.aws_elasticloadbalancingv2_loadbalancer`/);
  });

  it('warns on unknown entity types and leaves them alone', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(some_metric), by:{ dt.entity.totally_unknown }',
      idx
    );
    assert.match(r.rewritten, /dt\.entity\.totally_unknown/);
    assert.ok(r.warnings.some((w) => w.kind === 'unmapped-entity-type'));
  });

  it('warns on not-planned entity types (host_group)', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(x), by:{ dt.entity.host_group }',
      idx
    );
    assert.match(r.rewritten, /dt\.entity\.host_group/);
    assert.ok(r.warnings.some((w) => w.kind === 'unmapped-entity-type'));
  });
});

describe('rewriteDql — flags constructs needing manual migration', () => {
  it('flags classicEntitySelector', () => {
    const idx = buildIndex([cpuEntry]);
    const r = rewriteDql(
      'timeseries avg(builtin:cloud.aws.ec2.cpu.usage), filter:{ in(dt.entity.ec2_instance, classicEntitySelector("type(ec2_instance),tag(env:prod)")) }',
      idx
    );
    const w = r.warnings.find((w) => w.kind === 'classic-entity-selector');
    assert.ok(w);
    assert.match(w.reference ?? '', /mass-data-filtering/);
  });

  it('flags entityName / entityAttr', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('fields name = entityName(dt.entity.host)', idx);
    assert.ok(r.warnings.some((w) => w.kind === 'entity-name-attr'));
  });

  it('flags relationship-bracket access', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('fieldsAdd host = belongs_to[dt.entity.host]', idx);
    assert.ok(r.warnings.some((w) => w.kind === 'entity-relationship-traversal'));
  });

  it('flags hardcoded classic ID literals', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'filter:{ id == "EC2_INSTANCE-A1A38D1D1C747BC2" }',
      idx
    );
    assert.ok(r.warnings.some((w) => w.kind === 'classic-id-literal'));
  });
});

describe('rewriteDql — composite formulas', () => {
  it('flags composite-formula metrics with the formula spec and unverified note', () => {
    const idx = buildIndex([capacityEntry]);
    const r = rewriteDql(
      'timeseries util = avg(builtin:cloud.aws.dynamo.capacityUnits.read)',
      idx
    );
    // Original metric reference should NOT have been replaced.
    assert.match(r.rewritten, /builtin:cloud\.aws\.dynamo\.capacityUnits\.read/);
    const w = r.warnings.find((w) => w.kind === 'composite-formula-needed');
    assert.ok(w);
    assert.match(w.text, /consumed \/ provisioned/);
    assert.match(w.text, /UNVERIFIED/);
  });
});

describe('rewriteDql — end-to-end', () => {
  it('translates classicEntitySelector inside in(dim, ...) into a Smartscape filter', () => {
    const idx = buildIndex([cpuEntry]);
    const input =
      'timeseries cpu = avg(builtin:cloud.aws.ec2.cpu.usage), ' +
      'filter:{ in(dt.entity.ec2_instance, classicEntitySelector("type(ec2_instance),tag([AWS]env:prod)")) }, ' +
      'by:{ dt.entity.ec2_instance }';
    const r = rewriteDql(input, idx);

    // Metric key swapped.
    assert.match(r.rewritten, /cloud\.aws\.ec2\.CPUUtilization\.By\.InstanceId/);
    // by-dim swapped.
    assert.match(r.rewritten, /by:\{ dt\.smartscape\.aws_ec2_instance \}/);
    // classicEntitySelector replaced by tag filter.
    assert.doesNotMatch(r.rewritten, /classicEntitySelector/);
    assert.match(
      r.rewritten,
      /getNodeField\(dt\.smartscape\.aws_ec2_instance, "tags:aws"\)\[env\] == "prod"/
    );

    // Transform recorded.
    const cs = r.transforms.find((t) => t.kind === 'classic-selector');
    assert.ok(cs);
  });

  it('falls back to flagging when selector contains untranslatable predicates', () => {
    const idx = buildIndex([cpuEntry]);
    const input =
      'timeseries avg(builtin:cloud.aws.ec2.cpu.usage), ' +
      'filter:{ in(dt.entity.ec2_instance, classicEntitySelector("entityId(\\"EC2_INSTANCE-ABC\\")")) }, ' +
      'by:{ dt.entity.ec2_instance }';
    const r = rewriteDql(input, idx);

    // entityId is non-translatable → no clause emitted → original kept and flagged.
    assert.match(r.rewritten, /classicEntitySelector/);
    assert.ok(r.warnings.some((w) => w.kind === 'classic-entity-selector'));
  });

  it('handles classicEntitySelector against an already-rewritten dt.smartscape dim', () => {
    const idx = buildIndex([cpuEntry]);
    const input =
      'filter:{ in(dt.smartscape.aws_ec2_instance, classicEntitySelector("awsRegion(\\"us-east-1\\")")) }';
    const r = rewriteDql(input, idx);
    assert.match(
      r.rewritten,
      /getNodeField\(dt\.smartscape\.aws_ec2_instance, "aws\.region"\) == "us-east-1"/
    );
  });
});
