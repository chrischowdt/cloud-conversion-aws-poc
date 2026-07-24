import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBucket,
  rollupBuckets,
  parityVerdict,
  assetConfidence,
} from './asset-confidence.ts';

describe('classifyBucket', () => {
  it('blocked when an AWS warning is a blocking kind', () => {
    assert.equal(classifyBucket(['metric-key'], ['unknown-metric']), 'blocked');
  });
  it('soft when a non-blocking AWS warning is present', () => {
    assert.equal(classifyBucket(['metric-key'], ['mapped-no-recipe']), 'soft');
  });
  it('clean when transformed with no AWS warnings', () => {
    assert.equal(classifyBucket(['metric-key', 'entity-dim'], []), 'clean');
  });
  it('noop when nothing happened', () => {
    assert.equal(classifyBucket([], []), 'noop');
  });
  it('ignores the informational non-aws-entity note', () => {
    assert.equal(classifyBucket([], ['non-aws-entity']), 'noop');
    assert.equal(classifyBucket(['x'], ['non-aws-entity']), 'clean');
  });
});

describe('rollupBuckets', () => {
  it('tallies mixed query details', () => {
    const s = rollupBuckets([
      { transformKinds: ['metric-key'], warningKinds: [] }, // clean
      { transformKinds: ['metric-key'], warningKinds: ['mapped-no-recipe'] }, // soft
      { transformKinds: [], warningKinds: ['classic-entity-selector'] }, // blocked
      { transformKinds: [], warningKinds: [] }, // noop
    ]);
    assert.deepEqual(s, { clean: 1, soft: 1, blocked: 1, noop: 1, queries: 4 });
  });
});

describe('parityVerdict', () => {
  it('all-match: matches present, no divergence', () => {
    assert.equal(parityVerdict({ match: 5 }), 'all-match');
  });
  it('mismatch: any divergence/error/one-side-empty', () => {
    assert.equal(parityVerdict({ match: 4, mismatch: 1 }), 'mismatch');
    assert.equal(parityVerdict({ match: 4, 'one-side-empty': 1 }), 'mismatch');
    assert.equal(parityVerdict({ 'both-error': 2 }), 'mismatch');
  });
  it('inconclusive: only both-empty', () => {
    assert.equal(parityVerdict({ 'both-empty': 3 }), 'inconclusive');
  });
  it('none: absent or empty', () => {
    assert.equal(parityVerdict(undefined), 'none');
    assert.equal(parityVerdict({}), 'none');
  });
});

describe('assetConfidence', () => {
  const S = (o: Partial<ReturnType<typeof rollupBuckets>>) => ({
    clean: 0, soft: 0, blocked: 0, noop: 0, queries: 0, ...o,
  });

  it('blocked lane ONLY when nothing auto-converted (manual rebuild)', () => {
    const r = assetConfidence(S({ blocked: 2, noop: 1, queries: 3 }), { match: 3 });
    assert.equal(r.level, 'blocked');
    assert.equal(r.lane, 'blocked');
  });
  it('blocked tiles + some converted → review (human fixes the blocked tiles)', () => {
    const r = assetConfidence(S({ clean: 2, blocked: 1, queries: 3 }), { match: 3 });
    assert.equal(r.lane, 'review');
    assert.equal(r.level, 'low');
    assert.ok(r.reasons.some((x) => /blocked tile/.test(x)));
  });
  it('fast lane: fully clean AND parity all-match', () => {
    const r = assetConfidence(S({ clean: 3, queries: 3 }), { match: 3 });
    assert.equal(r.level, 'high');
    assert.equal(r.lane, 'fast');
  });
  it('clean but NO parity data → review (not fast)', () => {
    const r = assetConfidence(S({ clean: 3, queries: 3 }), undefined);
    assert.equal(r.lane, 'review');
    assert.equal(r.level, 'medium');
    assert.ok(r.reasons.some((x) => /run compare-dashboard/.test(x)));
  });
  it('soft warnings → review/medium', () => {
    const r = assetConfidence(S({ clean: 1, soft: 2, queries: 3 }), { match: 3 });
    assert.equal(r.lane, 'review');
    assert.equal(r.level, 'medium');
  });
  it('parity mismatch → review/low', () => {
    const r = assetConfidence(S({ clean: 3, queries: 3 }), { match: 2, mismatch: 1 });
    assert.equal(r.lane, 'review');
    assert.equal(r.level, 'low');
  });
});
