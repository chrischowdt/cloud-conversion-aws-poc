import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classicSnakeCandidates, loadExtraMappings, lookupInExtra, serviceFromNewKey } from './extra-mappings.ts';

async function writeFixture(name: string, contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'extra-mappings-'));
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(contents));
  return path;
}

describe('loadExtraMappings + lookupInExtra', () => {
  it('loads manual array and resolves exact classic_key match', async () => {
    const manualPath = await writeFixture('manual.json', [
      {
        classic_key: 'cloud.aws.alb.bytes',
        new_key: 'cloud.aws.applicationelb.ProcessedBytes.By.LoadBalancer',
        availability: 'autodiscovered',
      },
    ]);
    const idx = await loadExtraMappings({ manualPath });
    const hit = lookupInExtra(idx, 'cloud.aws.alb.bytes');
    assert.equal(hit?.newKey, 'cloud.aws.applicationelb.ProcessedBytes.By.LoadBalancer');
    assert.equal(hit?.source, 'manual');
    assert.equal(hit?.availability, 'autodiscovered');
  });

  it('loads per-key object map and resolves bestDacKey via the same API', async () => {
    const perKeyPath = await writeFixture('per-key.json', {
      'ext:cloud.aws.lambda.invocationssum': {
        bestDacKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
        availability: 'recommended',
      },
    });
    const idx = await loadExtraMappings({ perKeyPath });
    const hit = lookupInExtra(idx, 'ext:cloud.aws.lambda.invocationssum');
    assert.equal(hit?.newKey, 'cloud.aws.lambda.Invocations.By.FunctionName');
    assert.equal(hit?.source, 'per-key');
  });

  it('lowercases the input on miss to catch per-key entries that preserved CamelCase from v2 API', async () => {
    const perKeyPath = await writeFixture('per-key.json', {
      'ext:cloud.aws.lambda.invocationssum': {
        bestDacKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
        availability: 'recommended',
      },
    });
    const idx = await loadExtraMappings({ perKeyPath });
    // Dashboard reference still has CamelCase from the v2 API era.
    const hit = lookupInExtra(idx, 'ext:cloud.aws.lambda.InvocationsSum');
    assert.equal(hit?.newKey, 'cloud.aws.lambda.Invocations.By.FunctionName');
  });

  it('manual entries win when both files have the same key', async () => {
    const manualPath = await writeFixture('manual.json', [
      {
        classic_key: 'cloud.aws.alb.bytes',
        new_key: 'cloud.aws.applicationelb.ProcessedBytes.By.LoadBalancer.MANUAL',
        availability: 'recommended',
      },
    ]);
    const perKeyPath = await writeFixture('per-key.json', {
      'cloud.aws.alb.bytes': {
        bestDacKey: 'cloud.aws.applicationelb.ProcessedBytes.By.LoadBalancer.PERKEY',
        availability: 'autodiscovered',
      },
    });
    const idx = await loadExtraMappings({ manualPath, perKeyPath });
    const hit = lookupInExtra(idx, 'cloud.aws.alb.bytes');
    assert.equal(hit?.source, 'manual');
    assert.match(hit?.newKey ?? '', /MANUAL$/);
  });

  it('returns null for unknown keys', async () => {
    const manualPath = await writeFixture('manual.json', []);
    const idx = await loadExtraMappings({ manualPath });
    assert.equal(lookupInExtra(idx, 'cloud.aws.nope.never'), null);
  });

  it('handles dt.cloud.aws.* mirrors from manual file (used by Grail DQL dashboards)', async () => {
    const manualPath = await writeFixture('manual.json', [
      {
        classic_key: 'cloud.aws.alb.bytes',
        new_key: 'cloud.aws.applicationelb.ProcessedBytes.By.LoadBalancer',
        availability: 'autodiscovered',
      },
      {
        classic_key: 'dt.cloud.aws.alb.bytes',
        new_key: 'cloud.aws.applicationelb.ProcessedBytes.By.LoadBalancer',
        availability: 'autodiscovered',
      },
    ]);
    const idx = await loadExtraMappings({ manualPath });
    assert.ok(lookupInExtra(idx, 'cloud.aws.alb.bytes'));
    assert.ok(lookupInExtra(idx, 'dt.cloud.aws.alb.bytes'));
  });
});

describe('normalization helpers', () => {
  it('strips :avg/:splitBy modifiers from prefixed keys but keeps the prefix colon', async () => {
    const { stripSelectorModifiers } = await import('./extra-mappings.ts');
    assert.equal(
      stripSelectorModifiers('builtin:cloud.aws.lambda.invocations:avg'),
      'builtin:cloud.aws.lambda.invocations'
    );
    assert.equal(
      stripSelectorModifiers('ext:cloud.aws.lambda.invocationsSum:splitBy("FunctionName"):avg'),
      'ext:cloud.aws.lambda.invocationsSum'
    );
    assert.equal(stripSelectorModifiers('dt.cloud.aws.lambda.invocations'), 'dt.cloud.aws.lambda.invocations');
  });

  it('normalizeBuiltinKey converts dt.cloud→builtin: and builtin:cloud→builtin:', async () => {
    const { normalizeBuiltinKey } = await import('./extra-mappings.ts');
    assert.equal(normalizeBuiltinKey('dt.cloud.aws.lambda.invocations'), 'builtin:aws.lambda.invocations');
    assert.equal(
      normalizeBuiltinKey('builtin:cloud.aws.lambda.invocations'),
      'builtin:aws.lambda.invocations'
    );
    assert.equal(normalizeBuiltinKey('cloud.aws.lambda.invocations'), null);
  });

  it('stripDimensionSuffix strips trailing By<Capitalized>', async () => {
    const { stripDimensionSuffix } = await import('./extra-mappings.ts');
    assert.equal(
      stripDimensionSuffix('ext:cloud.aws.lambda.invocationsSumByResource'),
      'ext:cloud.aws.lambda.invocationsSum'
    );
    assert.equal(
      stripDimensionSuffix('ext:cloud.aws.lambda.invocationsSum'),
      null
    );
  });
});

describe('lookupInExtraWithNormalization', () => {
  it('matches a dt.cloud.aws.* key against a per-key builtin:cloud.aws.* entry via step 3a', async () => {
    const { lookupInExtraWithNormalization } = await import('./extra-mappings.ts');
    const perKeyPath = await writeFixture('per-key.json', {
      'builtin:cloud.aws.lambda.invocations': {
        bestDacKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
        availability: 'recommended',
      },
    });
    const idx = await loadExtraMappings({ perKeyPath });
    // Direct match — control.
    assert.ok(lookupInExtraWithNormalization(idx, 'builtin:cloud.aws.lambda.invocations'));
    // The interesting case: dt.cloud.* form, which exact lookup misses.
    const hit = lookupInExtraWithNormalization(idx, 'dt.cloud.aws.lambda.invocations');
    assert.ok(hit, 'expected dt.cloud.* form to resolve via prefix swap');
    assert.equal(hit!.newKey, 'cloud.aws.lambda.Invocations.By.FunctionName');
  });

  it('strips a dimension suffix to find a shorter per-key entry (step 4)', async () => {
    const { lookupInExtraWithNormalization } = await import('./extra-mappings.ts');
    const perKeyPath = await writeFixture('per-key.json', {
      'ext:cloud.aws.lambda.invocationsSum': {
        bestDacKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
        availability: 'recommended',
      },
    });
    const idx = await loadExtraMappings({ perKeyPath });
    const hit = lookupInExtraWithNormalization(idx, 'ext:cloud.aws.lambda.invocationsSumByResource');
    assert.ok(hit, 'expected dimension-strip to bridge to the shorter key');
    assert.equal(hit!.availability, 'recommended');
  });

  it('falls through to Cassandra builtin:<provider>.* when needed (step 3b)', async () => {
    const { lookupInExtraWithNormalization } = await import('./extra-mappings.ts');
    const perKeyPath = await writeFixture('per-key.json', {
      'builtin:aws.lambda.invocations': {
        bestDacKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
        availability: 'autodiscovered',
      },
    });
    const idx = await loadExtraMappings({ perKeyPath });
    // dt.cloud.* → step 3a tries builtin:cloud.* (miss) → step 3b tries builtin:* (hit).
    const hit = lookupInExtraWithNormalization(idx, 'dt.cloud.aws.lambda.invocations');
    assert.ok(hit, 'expected Cassandra fallback to resolve dt.cloud key');
    assert.equal(hit!.availability, 'autodiscovered');
  });

  it('returns null when nothing matches across the chain', async () => {
    const { lookupInExtraWithNormalization } = await import('./extra-mappings.ts');
    const perKeyPath = await writeFixture('per-key.json', {});
    const idx = await loadExtraMappings({ perKeyPath });
    assert.equal(
      lookupInExtraWithNormalization(idx, 'cloud.aws.totally-fictitious.metric'),
      null
    );
  });
});

describe('serviceFromNewKey', () => {
  it('extracts the AWS service segment from a new-form key', () => {
    assert.equal(serviceFromNewKey('cloud.aws.lambda.Invocations.By.FunctionName'), 'lambda');
    assert.equal(
      serviceFromNewKey('cloud.aws.applicationelb.ProcessedBytes.By.LoadBalancer'),
      'applicationelb'
    );
  });

  it('falls back to "aws" when the shape is unrecognized', () => {
    assert.equal(serviceFromNewKey('some.weird.key'), 'aws');
  });
});

describe('classicSnakeCandidates', () => {
  it('strips the statistic infix + _by_ dims and flattens for the per-key map', () => {
    const c = classicSnakeCandidates('cloud.aws.containerinsights.pending_task_count_sum_by_service_name');
    // DAC bare-snake (CloudWatch-derived) base
    assert.ok(c.includes('cloud.aws.containerinsights.pending_task_count'));
    // per-key flattened form
    assert.ok(c.includes('ext:cloud.aws.containerinsights.pendingtaskcountbyservicename'));
  });

  it('removes the service-segment underscore for the per-key form (api_gateway → apigateway)', () => {
    const c = classicSnakeCandidates('cloud.aws.api_gateway.count_sum_by_stage_resource_method');
    assert.ok(c.some((x) => x.startsWith('ext:cloud.aws.apigateway.')));
  });

  it('returns nothing for new-form keys and AWS Metric Streams keys', () => {
    // new-connection shape — already migrated, nothing to normalize
    assert.deepEqual(classicSnakeCandidates('cloud.aws.lambda.Invocations.By.FunctionName'), []);
    // Metric Streams (camel metric + By + 2+ concatenated dims) has no equivalent;
    // normalizing would fabricate a bogus match.
    assert.deepEqual(classicSnakeCandidates('cloud.aws.kafka.maxOffsetLagByAccountIdClusterNameRegion'), []);
    // all-lowercase single segment carries no camelCase signal
    assert.deepEqual(classicSnakeCandidates('cloud.aws.sqs.invocations'), []);
  });

  it('normalizes a camelCase metric segment to its snake form (EMR reviewer finding)', () => {
    // Reviewers hit `cloud.aws.emr.mrActiveNodesSum` as unknown-metric; the maps
    // only carry the snake shape.
    const c = classicSnakeCandidates('cloud.aws.emr.mrActiveNodesSum');
    assert.ok(c.includes('cloud.aws.emr.mr_active_nodes_sum'));
    assert.ok(c.includes('cloud.aws.emr.mr_active_nodes'));
  });
});
