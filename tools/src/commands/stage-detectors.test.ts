import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nextStepHint } from './stage-detectors.ts';

describe('stage-detectors: the closing hint', () => {
  it('points at a prepare run of migrate-promote-detectors for a batch it staged, not at a pull command', () => {
    const hint = nextStepHint(['batch-21', 'batch-22']);
    assert.ok(hint.includes('`cct migrate-promote-detectors --batches batch-21`'), hint);
    assert.ok(hint.includes('batch-21, batch-22'), hint);
    assert.equal(hint.includes('--apply'), false, 'a prepare run first');
    assert.equal(hint.includes('migrate-pull-detectors'), false, 'there is no such command');
  });

  it('names a placeholder when no batch was created', () => {
    assert.ok(nextStepHint([]).includes('--batches <batch>'));
  });
});
