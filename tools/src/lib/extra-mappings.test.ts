import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadExtraMappings, lookupInExtra, serviceFromNewKey } from './extra-mappings.ts';

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
