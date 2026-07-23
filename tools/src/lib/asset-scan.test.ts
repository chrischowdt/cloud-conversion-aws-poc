import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hasAwsMarker, looksLikeDql, classifyRewrite } from './asset-scan.ts';
import type { RewriteResult } from './dql-rewriter.ts';

/** Minimal RewriteResult stub — classifyRewrite only reads transforms/warnings. */
function rr(transforms: string[], warnings: string[]): RewriteResult {
  return {
    original: '',
    rewritten: '',
    transforms: transforms.map((kind) => ({ kind })),
    warnings: warnings.map((kind) => ({ kind, text: kind })),
  } as unknown as RewriteResult;
}

describe('hasAwsMarker', () => {
  it('matches the bare cloud.aws. metric form used by notebooks/detectors', () => {
    assert.ok(hasAwsMarker('timeseries avg(cloud.aws.kafka.offline_partitions_count)'));
    assert.ok(hasAwsMarker('fetch dt.entity.aws_lambda_function'));
    assert.ok(hasAwsMarker('type(cloud:aws:ec2)'));
  });
  it('does not match non-AWS DQL', () => {
    assert.equal(hasAwsMarker('fetch logs | filter dt.entity.host == "x"'), false);
  });
});

describe('looksLikeDql', () => {
  it('accepts real DQL, rejects prose', () => {
    assert.ok(looksLikeDql('timeseries avg(cloud.aws.ec2.cpu_utilization)'));
    assert.ok(looksLikeDql('fetch logs | filter x'));
    assert.equal(looksLikeDql('This is just a description of the alert.'), false);
  });
});

describe('classifyRewrite', () => {
  it('clean: transforms, no AWS warnings', () => {
    const c = classifyRewrite(rr(['metric-key-swap'], []));
    assert.equal(c.bucket, 'clean');
    assert.equal(c.changed, true);
    assert.equal(c.flagged, false);
  });
  it('soft: a non-blocking AWS warning', () => {
    const c = classifyRewrite(rr(['metric-key-swap'], ['dim-not-carried']));
    assert.equal(c.bucket, 'soft');
    assert.equal(c.flagged, true);
  });
  it('blocked: a blocking warning wins over transforms', () => {
    const c = classifyRewrite(rr(['metric-key-swap'], ['classic-entity-selector']));
    assert.equal(c.bucket, 'blocked');
  });
  it('noop: no transforms, no AWS warnings', () => {
    const c = classifyRewrite(rr([], []));
    assert.equal(c.bucket, 'noop');
  });
  it('non-aws-entity note alone is a no-op (not soft/blocked)', () => {
    const c = classifyRewrite(rr([], ['non-aws-entity']));
    assert.equal(c.bucket, 'noop');
    assert.equal(c.flagged, false);
  });
});
