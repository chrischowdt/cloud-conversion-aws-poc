import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rewriteDql, type Transform, type Warning } from './dql-rewriter.ts';
import type { RecipeIndex } from './recipe-lookup.ts';
import { rewriteEntityIdPins } from './entity-id-pins.ts';
import type { EntityArnIndex } from './entity-arns.ts';
import { lintAsset } from './output-lint.ts';

const A = 'CUSTOM_DEVICE-CFF4D22E40425D17';
const B = 'CUSTOM_DEVICE-0123456789ABCDEF';
const ARN_A = 'arn:aws:es:us-east-2:351878376352:domain/cwe-logging-stg';
const ARN_B = 'arn:aws:es:us-east-1:560380317052:domain/cwe-logging-dev';

const arns = (m: Record<string, string | null>): EntityArnIndex =>
  new Map(
    Object.entries(m).map(([id, arn]) => [
      id,
      { arn, name: arn ? arn.split('/').pop()! : null, type: 'custom_device', missing: arn ? undefined : ('not-found' as const) },
    ])
  );

function run(q: string, idx: EntityArnIndex | undefined) {
  const transforms: Transform[] = [];
  const warnings: Warning[] = [];
  const out = rewriteEntityIdPins(q, idx, transforms, warnings);
  return { out, transforms, warnings };
}

describe('rewriteEntityIdPins — inside the timeseries filter', () => {
  it('substitutes the pin in place and leaves the by-clause alone', () => {
    const q = `timeseries v = avg(x), by:{dt.entity.custom_device}, filter:{ dt.entity.custom_device == "${A}" }`;
    const r = run(q, arns({ [A]: ARN_A }));
    assert.equal(r.out, `timeseries v = avg(x), by:{dt.entity.custom_device}, filter:{ aws.arn == "${ARN_A}" }`);
    assert.equal(r.transforms.length, 1);
    assert.equal(r.warnings.length, 0);
  });

  it('keeps != as !=', () => {
    const q = `timeseries v = avg(x), filter:{ dt.entity.custom_device != "${A}" }`;
    assert.match(run(q, arns({ [A]: ARN_A })).out, /aws\.arn != "arn:aws:es:us-east-2:/);
  });

  it('converts in() — bare list and array() — to one in(aws.arn, array(...))', () => {
    const want = `in(aws.arn, array("${ARN_A}", "${ARN_B}"))`;
    const idx = arns({ [A]: ARN_A, [B]: ARN_B });
    assert.ok(run(`timeseries v = avg(x), filter:{ in(dt.entity.custom_device, "${A}", "${B}") }`, idx).out.includes(want));
    assert.ok(run(`timeseries v = avg(x), filter:{ in(dt.entity.custom_device, array("${A}", "${B}")) }`, idx).out.includes(want));
  });

  it('converts each side of an or-chain independently', () => {
    const q = `timeseries v = avg(x), filter:{ dt.entity.custom_device == "${A}" or dt.entity.custom_device == "${B}" }`;
    const r = run(q, arns({ [A]: ARN_A, [B]: ARN_B }));
    assert.equal(r.out, `timeseries v = avg(x), filter:{ aws.arn == "${ARN_A}" or aws.arn == "${ARN_B}" }`);
  });
});

describe('rewriteEntityIdPins — post-aggregation filter', () => {
  it('substitutes AND adds aws.arn to the by-clause, since only by-dimensions survive', () => {
    const q = `timeseries v = max(x), by:{dt.entity.custom_device}, interval:1m\n| filter dt.entity.custom_device == "${A}"`;
    const r = run(q, arns({ [A]: ARN_A }));
    assert.equal(
      r.out,
      `timeseries v = max(x), by:{dt.entity.custom_device, aws.arn}, interval:1m\n| filter aws.arn == "${ARN_A}"`
    );
    assert.match(r.transforms[0]!.detail ?? '', /added to the by-clause/);
  });

  it('adds aws.arn once even when several comparisons follow', () => {
    const q = `timeseries v = max(x), by:{dt.entity.custom_device}\n| filter dt.entity.custom_device == "${A}" or dt.entity.custom_device == "${B}"`;
    const out = run(q, arns({ [A]: ARN_A, [B]: ARN_B })).out;
    assert.equal((out.match(/by:\{[^}]*\}/)![0].match(/aws\.arn/g) ?? []).length, 1);
    assert.match(out, /\| filter aws\.arn == .* or aws\.arn == /);
  });

  it('refuses — and warns — when the query has no by-clause to carry aws.arn', () => {
    const q = `timeseries v = max(x)\n| filter dt.entity.custom_device == "${A}"`;
    const r = run(q, arns({ [A]: ARN_A }));
    assert.equal(r.out, q);
    assert.equal(r.warnings[0]!.kind, 'entity-id-unresolved');
    assert.match(r.warnings[0]!.text, /no single by-clause/);
  });

  it('with two timeseries commands, still converts the in-command pin but refuses the post-aggregation one', () => {
    const q =
      `timeseries a = avg(x), by:{dt.entity.custom_device}, filter:{ dt.entity.custom_device == "${A}" }\n` +
      `| append [ timeseries b = avg(y), by:{dt.entity.custom_device} ]\n` +
      `| filter dt.entity.custom_device == "${B}"`;
    const r = run(q, arns({ [A]: ARN_A, [B]: ARN_B }));
    assert.ok(r.out.includes(`filter:{ aws.arn == "${ARN_A}" }`));
    assert.ok(r.out.includes(`dt.entity.custom_device == "${B}"`), 'the ambiguous one is left');
    assert.equal(r.warnings.length, 1);
  });
});

describe('rewriteEntityIdPins — never half-converts, never guesses', () => {
  it('leaves an in() whole when only SOME ids resolve (a partial list would silently narrow the scope)', () => {
    const q = `timeseries v = avg(x), filter:{ in(dt.entity.custom_device, "${A}", "${B}") }`;
    const r = run(q, arns({ [A]: ARN_A, [B]: null }));
    assert.equal(r.out, q);
    assert.equal(r.transforms.length, 0);
    assert.match(r.warnings[0]!.text, new RegExp(B));
  });

  it('warns, and names the reason, when the classic entity is gone', () => {
    const q = `timeseries v = avg(x), filter:{ dt.entity.custom_device == "${A}" }`;
    const r = run(q, arns({ [A]: null }));
    assert.equal(r.out, q);
    assert.equal(r.warnings[0]!.kind, 'entity-id-unresolved');
    assert.match(r.warnings[0]!.text, /not-found/);
  });

  it('tells the user to run discovery when no map is loaded at all', () => {
    const q = `timeseries v = avg(x), filter:{ dt.entity.custom_device == "${A}" }`;
    const r = run(q, undefined);
    assert.equal(r.out, q);
    assert.match(r.warnings[0]!.text, /discover-entity-arns/);
  });

  it('leaves non-AWS entities completely alone — no rewrite and no warning', () => {
    const q = `timeseries v = avg(x), filter:{ dt.entity.host == "HOST-0123456789ABCDEF" }`;
    const r = run(q, arns({}));
    assert.equal(r.out, q);
    assert.equal(r.warnings.length, 0);
  });

  it('leaves a pin whose id type does not match its dimension', () => {
    const q = `timeseries v = avg(x), filter:{ dt.entity.custom_device == "HOST-0123456789ABCDEF" }`;
    assert.equal(run(q, arns({ 'HOST-0123456789ABCDEF': ARN_A })).out, q);
  });

  it('ignores an id inside a comment or a string', () => {
    const q = `timeseries v = avg(x), by:{dt.entity.custom_device}\n// was: dt.entity.custom_device == "${A}"`;
    assert.equal(run(q, arns({ [A]: ARN_A })).out, q);
  });

  it('is idempotent', () => {
    const q = `timeseries v = avg(x), by:{dt.entity.custom_device}, filter:{ dt.entity.custom_device == "${A}" }`;
    const once = run(q, arns({ [A]: ARN_A })).out;
    assert.equal(run(once, arns({ [A]: ARN_A })).out, once);
  });
});

describe('Pass 1.52 through rewriteDql', () => {
  const key = 'cloud.aws.es.free_storage_space_sum_by_client_id_node_id';
  const entry = {
    classicKey: key,
    newKey: 'cloud.aws.es.FreeStorageSpace.By.ClientId.DomainName.NodeId',
    availability: 'recommended' as const,
    source: 'per-key' as const,
  };
  const base: RecipeIndex = { byClassicId: new Map(), byDqlClassicKey: new Map() };
  const mapped: RecipeIndex = {
    ...base,
    extra: { byKey: new Map([[key, entry]]), byLowerKey: new Map([[key, entry]]) },
    entityArns: arns({ [A]: ARN_A, [B]: ARN_B }),
  };

  it('converts a pinned detector end to end: no classic id survives, lint is clean', () => {
    const q = `timeseries { min(${key}) }, by:{dt.entity.custom_device}, filter:{ dt.entity.custom_device == "${A}" }`;
    const r = rewriteDql(q, mapped);
    assert.match(r.rewritten, new RegExp(`aws\\.arn == "${ARN_A}"`));
    assert.doesNotMatch(r.rewritten, /CUSTOM_DEVICE-/);
    assert.match(r.rewritten, /by:\{\s*dt\.smartscape\.aws_opensearch_domain\s*\}/);
    assert.equal(lintAsset({ query: r.rewritten }).some((f) => f.ruleId === 'classic-entity-id-vs-smartscape-dim'), false);
  });

  it('handles the post-aggregation or-chain (the MSK shape): by gains aws.arn, filter reads it', () => {
    const q =
      `timeseries v = min(${key}), by:{dt.entity.custom_device}, interval:1m\n` +
      `| filter dt.entity.custom_device == "${A}" or dt.entity.custom_device == "${B}"`;
    const r = rewriteDql(q, mapped);
    assert.match(r.rewritten, /by:\{\s*dt\.smartscape\.aws_opensearch_domain, aws\.arn\s*\}/);
    assert.match(r.rewritten, /\| filter aws\.arn == .* or aws\.arn == /);
    assert.doesNotMatch(r.rewritten, /CUSTOM_DEVICE-/);
  });

  it('does NOT convert when the metric key is unmapped — classic series carry no aws.arn', () => {
    // The pin stays, so the output lint and the unknown-metric warning keep blocking it.
    const q = `timeseries v = min(cloud.aws.es.some_unmapped_metric), by:{dt.entity.custom_device}, filter:{ dt.entity.custom_device == "${A}" }`;
    const r = rewriteDql(q, { ...mapped, extra: undefined });
    assert.doesNotMatch(r.rewritten, /aws\.arn/);
    assert.ok(r.warnings.some((w) => w.kind === 'unknown-metric'));
    assert.equal(lintAsset({ query: r.rewritten }).some((f) => f.ruleId === 'classic-entity-id-vs-smartscape-dim'), true);
  });

  it('raises a BLOCKING warning for an unresolved pin, so it cannot ride through as "soft"', () => {
    const q = `timeseries { min(${key}) }, by:{dt.entity.custom_device}, filter:{ dt.entity.custom_device == "${A}" }`;
    const r = rewriteDql(q, { ...mapped, entityArns: arns({ [A]: null }) });
    assert.ok(r.warnings.some((w) => w.kind === 'entity-id-unresolved'));
    assert.equal(lintAsset({ query: r.rewritten }).some((f) => f.ruleId === 'classic-entity-id-vs-smartscape-dim'), true);
  });
});
