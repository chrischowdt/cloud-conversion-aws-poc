import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDacIndex, lookupInDac, type DacEntry } from './dac-lookup.ts';

async function buildTestIndex(entries: DacEntry[]) {
  const dir = await mkdtemp(join(tmpdir(), 'dac-lookup-'));
  const path = join(dir, 'dac.json');
  await writeFile(path, JSON.stringify(entries));
  return loadDacIndex(path);
}

const lambdaInvocations: DacEntry = {
  cloudwatchNamespace: 'AWS/Lambda',
  cloudwatchMetricName: 'Invocations',
  cloudwatchDimensions: ['FunctionName'],
  secondGenMetricKey: 'ext:cloud.aws.lambda.invocationsSum',
  dacRecommendedMetricKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
  dacAutodiscoveredMetricKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
  builtInMetricKey: 'builtin:cloud.aws.lambda.invocations',
  endOfLife: false,
};

const lambdaInvocationsByResource: DacEntry = {
  cloudwatchNamespace: 'AWS/Lambda',
  cloudwatchMetricName: 'Invocations',
  cloudwatchDimensions: ['FunctionName', 'Resource'],
  secondGenMetricKey: 'ext:cloud.aws.lambda.invocationsSumByResource',
  dacRecommendedMetricKey: 'not-matched',
  dacAutodiscoveredMetricKey: 'cloud.aws.lambda.Invocations.By.FunctionName.Resource',
  builtInMetricKey: 'builtin:cloud.aws.lambda.invocations',
  endOfLife: false,
};

const opsworksStacks: DacEntry = {
  cloudwatchNamespace: 'AWS/OpsWorks',
  cloudwatchMetricName: 'cpu_idle',
  cloudwatchDimensions: ['StackId'],
  secondGenMetricKey: 'ext:cloud.aws.opsworks.cpuIdleSum',
  dacRecommendedMetricKey: 'not-matched',
  dacAutodiscoveredMetricKey: 'cloud.aws.opsworks.CpuIdle.By.StackId',
  builtInMetricKey: 'not-matched',
  endOfLife: true,
};

describe('dac-lookup — index shape coverage', () => {
  it('looks up by exact builtin:cloud.aws.* key', async () => {
    const idx = await buildTestIndex([lambdaInvocations]);
    const r = lookupInDac(idx, 'builtin:cloud.aws.lambda.invocations');
    assert.ok(r);
    assert.equal(r!.newDtMetricKey, 'cloud.aws.lambda.Invocations.By.FunctionName');
    assert.equal(r!.availability, 'recommended');
  });

  it('looks up by exact ext:cloud.aws.* key', async () => {
    const idx = await buildTestIndex([lambdaInvocations]);
    const r = lookupInDac(idx, 'ext:cloud.aws.lambda.invocationsSum');
    assert.ok(r);
    assert.equal(r!.newDtMetricKey, 'cloud.aws.lambda.Invocations.By.FunctionName');
  });

  it('looks up the dt.cloud.aws.* form derived from builtin:cloud.aws.*', async () => {
    const idx = await buildTestIndex([lambdaInvocations]);
    const r = lookupInDac(idx, 'dt.cloud.aws.lambda.invocations');
    assert.ok(r);
    assert.equal(r!.newDtMetricKey, 'cloud.aws.lambda.Invocations.By.FunctionName');
  });

  it('looks up bare cloud.aws.<svc>.<snake_case> from ext: + camelCase→snake', async () => {
    const idx = await buildTestIndex([lambdaInvocations]);
    const r = lookupInDac(idx, 'cloud.aws.lambda.invocations_sum');
    assert.ok(r);
    assert.equal(r!.newDtMetricKey, 'cloud.aws.lambda.Invocations.By.FunctionName');
  });

  it('picks the recommended-key entry when multiple share the same builtin key', async () => {
    // lambdaInvocationsByResource also has builtInMetricKey: builtin:cloud.aws.lambda.invocations
    // but no dacRecommendedMetricKey. lambdaInvocations should win.
    const idx = await buildTestIndex([lambdaInvocationsByResource, lambdaInvocations]);
    const r = lookupInDac(idx, 'builtin:cloud.aws.lambda.invocations');
    assert.ok(r);
    assert.equal(r!.availability, 'recommended');
    assert.equal(r!.cloudwatchDimensions.length, 1, 'should prefer the single-dim entry');
  });

  it('returns null for keys not in the index', async () => {
    const idx = await buildTestIndex([lambdaInvocations]);
    assert.equal(lookupInDac(idx, 'cloud.aws.totally.unmapped'), null);
  });

  it('surfaces endOfLife flag from the DAC entry', async () => {
    const idx = await buildTestIndex([opsworksStacks]);
    const r = lookupInDac(idx, 'ext:cloud.aws.opsworks.cpuIdleSum');
    assert.ok(r);
    assert.equal(r!.endOfLife, true);
  });

  it('falls back to autodiscovered when no recommended is set', async () => {
    const idx = await buildTestIndex([lambdaInvocationsByResource]);
    const r = lookupInDac(idx, 'ext:cloud.aws.lambda.invocationsSumByResource');
    assert.ok(r);
    assert.equal(r!.availability, 'autodiscovered');
  });
});
